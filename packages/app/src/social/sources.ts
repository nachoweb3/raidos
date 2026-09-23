/**
 * 📡 SOCIAL SOURCES — the two signal channels feeding copy trading:
 *
 *   1. WALLET HARVEST   — real on-chain trades of tracked wallets, collected
 *      from the pool trades endpoints we already index (self-observed data).
 *   2. CT/TWITTER CALLS — public tweets from a curated account list, polled
 *      via twitterapi.io (~$0.15/1k reads). A tweet becomes a CALL SIGNAL
 *      only when its text contains a resolvable on-chain address (EVM 0x… or
 *      base58 Solana) that our catalog knows — never a guess from cashtags.
 *
 * Honesty contract: signals are EVIDENCE, never auto-execution. The user
 * always reviews and signs (signal + 1-tap model). Nothing here places trades.
 */

import { MarketCatalog, assetAddress } from "../market/catalog.js";
import { MarketDataService } from "../market/data.js";

const TWITTERAPI_IO_HOST = "https://api.twitterapi.io";
const UA = "trenches-social/1.0 (+https://inusaur.online)";

export interface HarvestedTrade {
  id: string;
  chain: string;
  pool: string;
  token: string;
  tokenSymbol: string;
  wallet: string;
  side: "buy" | "sell";
  priceUsd: number;
  volumeUsd: number;
  amount: string;
  time: number;
  txHash: string;
}

/** Default curated CT list — replaceable via SOCIAL_CT_ACCOUNTS (comma-sep @handles). */
export const DEFAULT_CT_ACCOUNTS = [
  "n0commas", "ohzarke", "blurr_y0kai", "frankdegods", "meow", "theunipcs",
];

export function ctAccountsFromEnv(): string[] {
  const raw = process.env.SOCIAL_CT_ACCOUNTS ?? "";
  const list = raw.split(",").map((s) => s.trim().replace(/^@/, "")).filter(Boolean);
  return list.length ? list : DEFAULT_CT_ACCOUNTS;
}

/**
 * Harvest trades for a set of (chain, pool, token) triples the indexer already
 * tracks. Uses MarketDataService.trades() — same normalization, quota and
 * caching as the rest of the platform. Dedupes by trade id at the DB layer.
 */
export async function harvestPoolTrades(
  market: MarketDataService,
  triples: { chain: string; pool: string; token: string; tokenSymbol?: string }[],
): Promise<HarvestedTrade[]> {
  const out: HarvestedTrade[] = [];
  for (const { chain, pool, token, tokenSymbol } of triples) {
    try {
      const snap = await market.trades(chain, pool, token);
      for (const t of snap.data) {
        out.push({
          id: `${chain}:${t.id}`,
          chain, pool, token,
          tokenSymbol: tokenSymbol ?? "",
          wallet: t.wallet,
          side: t.side,
          priceUsd: t.priceUsd,
          volumeUsd: t.volumeUsd,
          amount: t.amount,
          time: t.time,
          txHash: t.txHash,
        });
      }
    } catch {
      // Per-pool failure (429, expired pool) must not abort the batch.
      continue;
    }
  }
  return out;
}

/** Pick the most liquid observed pool per asset from the catalog. */
export function topPoolForAsset(catalog: MarketCatalog, chain: string, address: string):
  { pool: string; token: string; tokenSymbol: string } | null {
  const asset = catalog.findAsset(chain, address);
  if (!asset) return null;
  const pool = catalog.bestPool(asset.id);
  if (!pool?.address) return null;
  return { pool: pool.address, token: address, tokenSymbol: asset.symbol };
}

/**
 * CT tweet polling via twitterapi.io. Returns raw tweets for the account list
 * (latest page each). Requires TWITTERAPI_IO_KEY; without it returns [] —
 * the feature degrades honestly instead of faking data.
 */
export async function fetchCtTweets(handles: string[], limitPerHandle = 20): Promise<
  { handle: string; id: string; text: string; createdAt: number; url: string }[]
> {
  const key = process.env.TWITTERAPI_IO_KEY ?? "";
  if (!key) return [];
  const out: { handle: string; id: string; text: string; createdAt: number; url: string }[] = [];
  for (const handle of handles) {
    try {
      const res = await fetch(`${TWITTERAPI_IO_HOST}/tweet/advanced_search?query=${encodeURIComponent(`from:${handle}`)}&queryType=Latest`, {
        headers: { "x-api-key": key, accept: "application/json", "user-agent": UA },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) continue;
      const body = await res.json() as { tweets?: { id?: string; text?: string; createdAt?: string; url?: string; author?: { userName?: string } }[] };
      for (const t of body.tweets ?? []) {
        if (!t.id || typeof t.text !== "string") continue;
        const ts = t.createdAt ? Math.floor(Date.parse(t.createdAt) / 1000) : 0;
        out.push({ handle: t.author?.userName ?? handle, id: t.id, text: t.text.slice(0, 1000), createdAt: ts, url: t.url ?? `https://x.com/${handle}/status/${t.id}` });
      }
      if (out.length >= limitPerHandle * handles.length) break;
    } catch { continue; }
  }
  return out;
}

const EVM_ADDR = /0x[a-fA-F0-9]{40}/g;
const SOL_ADDR = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

/**
 * Extract CALL SIGNALS from tweet text: an address that resolves to a catalog
 * asset. No address → no signal (cashtags alone are too noisy to act on).
 */
export function extractCallSignals(
  tweets: { handle: string; id: string; text: string; createdAt: number; url: string }[],
  catalog: MarketCatalog,
): { handle: string; tweetId: string; tweetUrl: string; postedAt: number; chain: string; token: string; tokenSymbol: string; excerpt: string }[] {
  const signals: ReturnType<typeof extractCallSignals> = [];
  const seen = new Set<string>();
  for (const tw of tweets) {
    const candidates = new Set<string>();
    for (const m of tw.text.match(EVM_ADDR) ?? []) candidates.add(m.toLowerCase());
    for (const m of tw.text.match(SOL_ADDR) ?? []) candidates.add(m);
    for (const addr of candidates) {
      for (const chain of ["solana", "ethereum", "base", "bsc", "arc"]) {
        let normalized: string;
        try { normalized = assetAddress(chain, addr); } catch { continue; }
        const asset = catalog.findAsset(chain, normalized);
        if (!asset) continue;
        const key = `${tw.id}:${chain}:${normalized}`;
        if (seen.has(key)) continue;
        seen.add(key);
        signals.push({
          handle: tw.handle, tweetId: tw.id, tweetUrl: tw.url, postedAt: tw.createdAt,
          chain, token: normalized, tokenSymbol: asset.symbol,
          excerpt: tw.text.slice(0, 200),
        });
        break; // one chain per address is enough
      }
    }
  }
  return signals;
}
