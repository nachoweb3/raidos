/**
 * 🧠 SOCIAL ENGINE — orchestrates the signal + 1-tap copy pipeline:
 *
 *   harvest → observed_trades → wallet ratings → copy fan-out
 *   ct tweets → ct_calls (address-resolved only) → ct signals
 *
 * Honesty contract:
 *   - Signals are EVIDENCE for humans, never auto-execution.
 *   - Ratings come only from self-observed trades (computeWalletRating).
 *   - Fan-out respects each subscription's per-trade cap and sell mirroring.
 *   - Every step is idempotent at the DB layer.
 */

import type { AppDb } from "../database/app-db.js";
import { MarketCatalog } from "../market/catalog.js";
import { MarketDataService } from "../market/data.js";
import { computeWalletRating, type WalletRating, type WalletTrade } from "./rating.js";
import { harvestPoolTrades, topPoolForAsset, fetchCtTweets, extractCallSignals, ctAccountsFromEnv } from "./sources.js";

const MAX_WALLETS_PER_PASS = 12;
const MAX_POOLS_PER_PASS = 12;

export interface SocialPassResult {
  harvested: number;
  walletsRated: number;
  signalsFanned: number;
  ctCallsNew: number;
  ctSignalsFanned: number;
  ctPricesRefreshed?: number;
}

export class SocialEngine {
  constructor(
    private readonly db: AppDb,
    private readonly catalog: MarketCatalog,
    private readonly market: MarketDataService,
  ) {}

  /** One bounded pass of the whole pipeline. Errors never abort the loop. */
  async runPass(now = Math.floor(Date.now() / 1000)): Promise<SocialPassResult> {
    const result: SocialPassResult = { harvested: 0, walletsRated: 0, signalsFanned: 0, ctCallsNew: 0, ctSignalsFanned: 0 };
    try { await this.harvestPass(result); } catch (err) {
      console.warn("[social] harvest pass failed:", err instanceof Error ? err.message : err);
    }
    try { await this.ctPass(result); } catch (err) {
      console.warn("[social] ct pass failed:", err instanceof Error ? err.message : err);
    }
    try { result.walletsRated = this.refreshRatings(); } catch (err) {
      console.warn("[social] rating pass failed:", err instanceof Error ? err.message : err);
    }
    try { result.ctPricesRefreshed = this.refreshCtCallPrices(); } catch (err) {
      console.warn("[social] ct price pass failed:", err instanceof Error ? err.message : err);
    }
    void now;
    return result;
  }

  /** Recompute ratings for the most active tracked wallets (bounded). */
  private refreshRatings(limit = 24): number {
    const wallets = this.db.activeTrackedWallets(45 * 86400, limit);
    let rated = 0;
    for (const w of wallets) {
      const rating = this.rateWallet(w.chain, w.wallet);
      if (rating?.score !== null && rating !== undefined && rating !== null) rated += 1;
    }
    return rated;
  }

  /** Harvest trades of actively tracked pools + wallets users subscribe to. */
  private async harvestPass(result: SocialPassResult): Promise<void> {
    // 1) Top tracked assets from the catalog → their best pools.
    const assets = this.catalog.trackedAssets(MAX_POOLS_PER_PASS);
    // 2) Plus the pools of wallets users actively subscribe to.
    const subs = this.db.subscribedWallets(MAX_WALLETS_PER_PASS);
    const triples: { chain: string; pool: string; token: string; tokenSymbol?: string }[] = [];
    const seenPool = new Set<string>();
    for (const a of assets) {
      const key = `${a.chain}:${a.pool}`;
      if (!seenPool.has(key)) { seenPool.add(key); triples.push({ chain: a.chain, pool: a.pool, token: a.address, tokenSymbol: a.symbol }); }
    }
    for (const s of subs) {
      // For subscribed wallets, harvest their most recent observed token's pool.
      const last = this.db.lastObservedTokenFor(s.chain, s.wallet);
      if (last) {
        const top = topPoolForAsset(this.catalog, s.chain, last.token);
        if (top) {
          const key = `${s.chain}:${top.pool}`;
          if (!seenPool.has(key)) { seenPool.add(key); triples.push({ chain: s.chain, pool: top.pool, token: top.token, tokenSymbol: top.tokenSymbol }); }
        }
      }
    }
    if (!triples.length) return;

    const trades = await harvestPoolTrades(this.market, triples);
    const inserted = this.db.insertObservedTrades(trades.map((t) => ({
      id: t.id, chain: t.chain, pool: t.pool, token: t.token, token_symbol: t.tokenSymbol,
      wallet: t.wallet, side: t.side, price_usd: t.priceUsd, volume_usd: t.volumeUsd,
      amount: t.amount, ts: t.time, tx_hash: t.txHash,
    })));
    result.harvested = inserted;

    // Fan out to copy subscribers (the whole point of the harvest).
    result.signalsFanned = this.fanOutWalletSignals(trades);
  }

  /** Deliver observed trades of subscribed wallets as 1-tap signals. */
  private fanOutWalletSignals(trades: HarvestedTradeLike[]): number {
    let fanned = 0;
    const recent = trades.filter((t) => Date.now() / 1000 - t.time < 3600); // fresh only
    for (const t of recent) {
      const subs = this.db.copySubscribersFor(t.chain, t.wallet);
      if (!subs.length) continue;
      const rows = subs
        .filter((s: any) => t.side === "buy" || !!s.mirror_sells)
        .filter((s: any) => BigInt(s.max_per_trade_usdc) > 0)
        .map((s: any) => ({
          subscription_id: s.id, user_id: s.user_id, source: "wallet",
          chain: t.chain, wallet: t.wallet, handle: "",
          token: t.token, token_symbol: t.tokenSymbol,
          side: t.side, ref_price_usd: t.priceUsd,
          max_per_trade_usdc: s.max_per_trade_usdc, ts: t.time,
        }));
      fanned += this.db.insertCopySignals(rows);
    }
    return fanned;
  }

  /** Poll CT accounts, resolve tweet addresses against the catalog, store calls. */
  private async ctPass(result: SocialPassResult): Promise<void> {
    const accounts = ctAccountsFromEnv();
    if (!accounts.length) return;
    const tweets = await fetchCtTweets(accounts, 20);
    if (!tweets.length) return;
    const signals = extractCallSignals(tweets, this.catalog);
    for (const s of signals) {
      const price = this.currentPrice(s.chain, s.token);
      const isNew = this.db.upsertCtCall({
        handle: s.handle, tweet_id: s.tweetId, tweet_url: s.tweetUrl, posted_at: s.postedAt,
        chain: s.chain, token: s.token, token_symbol: s.tokenSymbol,
        excerpt: s.excerpt, price_at_call: price,
      });
      if (isNew) {
        result.ctCallsNew += 1;
        result.ctSignalsFanned += this.fanOutCtSignal(s, price);
      }
    }
  }

  private fanOutCtSignal(call: { chain: string; token: string; tokenSymbol: string; handle: string; postedAt: number }, price: number | null): number {
    if (price === null) return 0;
    // CT calls fan out to everyone subscribed to the CT channel (wallet row = handle marker).
    const subs = this.db.ctSubscribersFor(call.handle);
    const rows = subs.map((s) => ({
      subscription_id: s.id, user_id: s.user_id, source: "ct",
      chain: call.chain, wallet: "", handle: call.handle,
      token: call.token, token_symbol: call.tokenSymbol,
      side: "buy", ref_price_usd: price,
      max_per_trade_usdc: s.max_per_trade_usdc, ts: call.postedAt,
    }));
    return this.db.insertCopySignals(rows);
  }

  /** Refresh CT call performance against the best catalog pool price. */
  refreshCtCallPrices(limit = 30): number {
    const calls = this.db.staleCtCalls(900, limit);
    let updated = 0;
    for (const call of calls) {
      const price = this.currentPrice(call.chain, call.token);
      if (price !== null) { this.db.updateCtCallPrice(call.tweet_id, call.chain, call.token, price); updated += 1; }
    }
    return updated;
  }

  /** Best observed USD price for a token from the catalog (never invented). */
  private currentPrice(chain: string, token: string): number | null {
    return this.db.poolPriceFor(chain, token);
  }

  /** Rating for a tracked wallet from self-observed trades only. */
  rateWallet(chain: string, wallet: string): WalletRating | null {
    const rows = this.db.getObservedTrades(chain, wallet, 1000);
    if (!rows.length) return null;
    const trades: WalletTrade[] = rows.map((r: any) => ({
      chain: r.chain, wallet: r.wallet, token: r.token, tokenSymbol: r.token_symbol,
      side: r.side === "sell" ? "sell" : "buy",
      priceUsd: Number(r.price_usd), volumeUsd: Number(r.volume_usd),
      amount: String(r.amount), time: Number(r.ts),
    }));
    return computeWalletRating(trades);
  }

  /** Public leaderboard: wallets by observed volume + rating where enough data. */
  leaderboard(limit = 30) {
    const wallets = this.db.trackedWallets(45 * 86400, limit);
    return wallets.map((w: any) => {
      const rating = this.rateWallet(w.chain, w.wallet);
      return {
        chain: w.chain, wallet: w.wallet,
        trades: w.trades, volumeUsd: Math.round(Number(w.volume_usd)),
        lastSeen: w.last_ts,
        score: rating?.score ?? null,
        copyable: rating?.copyable ?? false,
        verdict: rating?.verdict ?? "EVIDENCIA INSUFICIENTE",
      };
    }).sort((a: any, b: any) => (b.score ?? -1) - (a.score ?? -1));
  }
}

type HarvestedTradeLike = {
  chain: string; wallet: string; token: string; tokenSymbol: string;
  side: "buy" | "sell"; priceUsd: number; time: number;
};
