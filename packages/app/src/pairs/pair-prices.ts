/**
 * UNIVERSAL PAIRS — price provider.
 *
 * Sources (both keyless, both real):
 *  - Magic Eden `v2/collections/:symbol/stats` → floorPrice (lamports), listedCount,
 *    avgPrice24hr, volume7d. Floor is in SOL → the DIRECT NFT/SOL leg.
 *  - CoinGecko `coins/markets` → USD price + 24h change for tokens, wrapped SOL,
 *    tokenized stocks (nvidia-xstock…) and tokenized NFT collections (pudgy-penguins…).
 *
 * Relative history: cumulative snapshots in SQLite. The refresh loop writes one
 * row per asset with its USD (tokens) or SOL (collections) price; the pair API
 * derives the relative series from these snapshots. Until enough history
 * accumulates the pair shows CURRENT data and history stays honestly
 * "unavailable" — nothing is invented.
 */
import type { AssetSeries, PairAsset } from "./pair-engine.js";

export interface NftStats {
  symbol: string;
  floorSol: number | null;
  listedCount: number | null;
  avgPrice24hrSol: number | null;
  volume7dSol: number | null;
}

export interface TokenPrice {
  priceUsd: number | null;
  change24hPct: number | null;
}

export interface PairProviderDeps {
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
}

const ME_HOST = "https://api-mainnet.magiceden.dev";
const CG_HOST = "https://api.coingecko.com/api/v3";
const ME_TTL_MS = 600_000;
const CG_TTL_MS = 120_000;

export interface QuoteToken extends PairAsset {
  coingeckoId: string;
}

/** Curated launch universe — every entry verified to exist on its provider. */
export const NFT_COLLECTIONS: PairAsset[] = [
  { kind: "nft_collection", id: "mad_lads", chain: "solana", symbol: "MAD", name: "Mad Lads" },
  { kind: "nft_collection", id: "okay_bears", chain: "solana", symbol: "OKAY", name: "Okay Bears" },
  { kind: "nft_collection", id: "claynosaurz", chain: "solana", symbol: "CLAY", name: "Claynosaurz" },
  { kind: "nft_collection", id: "famous_fox_federation", chain: "solana", symbol: "FOXY", name: "Famous Fox Federation" },
  { kind: "nft_collection", id: "degenerate_ape_academy", chain: "solana", symbol: "DAA", name: "Degen Ape Academy" },
];

export const QUOTE_TOKENS: QuoteToken[] = [
  // CoinGecko retired the "wrapped-sol" coin id (coins/wrapped-sol → 404);
  // the live SOL/USD market lives under "solana". Pair ids keep the stable
  // slug "wrapped-sol" so existing identifiers don't break.
  { kind: "token", id: "wrapped-sol", coingeckoId: "solana", chain: "solana", symbol: "SOL", name: "Solana" },
  { kind: "token", id: "ethereum", coingeckoId: "ethereum", chain: "ethereum", symbol: "ETH", name: "Ethereum" },
  { kind: "token", id: "bitcoin", coingeckoId: "bitcoin", chain: "bitcoin", symbol: "BTC", name: "Bitcoin" },
  { kind: "token", id: "usd-coin", coingeckoId: "usd-coin", chain: "solana", symbol: "USDC", name: "USD Coin" },
  { kind: "token", id: "nvidia-xstock", coingeckoId: "nvidia-xstock", chain: "solana", symbol: "NVDAX", name: "NVIDIA xStock" },
  { kind: "token", id: "ethereum-name-service", coingeckoId: "ethereum-name-service", chain: "ethereum", symbol: "ENS", name: "Ethereum Name Service" },
  { kind: "token", id: "pudgy-penguins", coingeckoId: "pudgy-penguins", chain: "solana", symbol: "PENGU", name: "Pudgy Penguins token" },
  { kind: "token", id: "shapeshift-fox-token", coingeckoId: "shapeshift-fox-token", chain: "ethereum", symbol: "FOX", name: "ShapeShift FOX" },
];

const toNum = (x: unknown): number | null => {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};

interface SnapshotStore {
  upsertPairSnapshot(assetId: string, ts: number, priceUsd: number | null, priceSol: number | null): void;
  getPairSnapshots(assetId: string, sinceTs: number): { time: number; priceUsd: number | null; priceSol: number | null }[];
}

export class PairPriceService {
  private readonly fetcher: (url: string, init?: RequestInit) => Promise<Response>;
  private readonly now: () => number;
  private readonly store: SnapshotStore;
  private readonly cache = new Map<string, { value: unknown; expires: number }>();
  private readonly meCalls: number[] = [];
  private readonly cgCalls: number[] = [];

  constructor(store: SnapshotStore, deps: PairProviderDeps = {}) {
    this.store = store;
    this.fetcher = deps.fetcher ?? ((url, init) => fetch(url, init));
    this.now = deps.now ?? Date.now;
  }

  private async fetchJson(url: string, timeoutMs = 8000): Promise<unknown> {
    const res = await this.fetcher(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error("upstream HTTP " + res.status);
    return res.json();
  }

  /** One ME call per collection, 10-min TTL, bounded ~25 calls/min (protects the shared keyless quota). */
  async nftStats(symbol: string): Promise<NftStats> {
    const key = "me:" + symbol;
    const cached = this.cache.get(key);
    if (cached && cached.expires > this.now()) return cached.value as NftStats;
    const now = this.now();
    const recent = this.meCalls.filter((at) => now - at < 60_000);
    if (recent.length >= 25) throw new Error("magiceden quota reached");
    recent.push(now);
    this.meCalls.length = 0;
    this.meCalls.push(...recent);
    const raw = (await this.fetchJson(`${ME_HOST}/v2/collections/${encodeURIComponent(symbol)}/stats`)) as Record<string, unknown>;
    const floorLamports = toNum(raw?.floorPrice);
    const stats: NftStats = {
      symbol,
      floorSol: floorLamports != null ? floorLamports / 1e9 : null,
      listedCount: toNum(raw?.listedCount),
      avgPrice24hrSol: toNum(raw?.avgPrice24hr) != null ? toNum(raw!.avgPrice24hr)! / 1e9 : null,
      volume7dSol: toNum(raw?.volume7d) != null ? toNum(raw!.volume7d)! / 1e9 : null,
    };
    this.cache.set(key, { value: stats, expires: this.now() + ME_TTL_MS });
    return stats;
  }

  /** CoinGecko USD prices for a batch of coin ids (2-min TTL, single batched call). */
  async tokenPrices(coingeckoIds: string[]): Promise<Map<string, TokenPrice>> {
    const uniq = [...new Set(coingeckoIds)].sort();
    const key = "cg:" + uniq.join(",");
    const cached = this.cache.get(key);
    if (cached && cached.expires > this.now()) return cached.value as Map<string, TokenPrice>;
    const now = this.now();
    const recent = this.cgCalls.filter((at) => now - at < 60_000);
    if (recent.length >= 25) throw new Error("coingecko quota reached");
    recent.push(now);
    this.cgCalls.length = 0;
    this.cgCalls.push(...recent);
    const url = `${CG_HOST}/coins/markets?vs_currency=usd&ids=${encodeURIComponent(uniq.join(","))}&sparkline=false&price_change_percentage=24h`;
    const rows = await this.fetchJson(url);
    if (!Array.isArray(rows)) throw new Error("invalid coingecko response");
    const out = new Map<string, TokenPrice>();
    for (const row of rows as Record<string, unknown>[]) {
      if (!row || typeof row !== "object" || typeof row.id !== "string") continue;
      out.set(row.id, { priceUsd: toNum(row.current_price), change24hPct: toNum(row.price_change_percentage_24h) });
    }
    this.cache.set(key, { value: out, expires: this.now() + CG_TTL_MS });
    return out;
  }

  /** Refresh all tracked assets and persist one snapshot row per asset. */
  async refreshAll(): Promise<{ snapshots: number; errors: string[] }> {
    let snapshots = 0;
    const errors: string[] = [];
    const ts = Math.floor(this.now() / 1000);
    let cg: Map<string, TokenPrice> = new Map();
    try { cg = await this.tokenPrices(QUOTE_TOKENS.map((t) => t.coingeckoId)); }
    catch (e) { errors.push("coingecko: " + String((e as Error).message)); }

    for (const t of QUOTE_TOKENS) {
      const priceUsd = cg.get(t.coingeckoId)?.priceUsd ?? null;
      if (priceUsd != null) {
        this.store.upsertPairSnapshot(t.id, ts, priceUsd, null);
        snapshots++;
      }
    }

    for (const c of NFT_COLLECTIONS) {
      try {
        const stats = await this.nftStats(c.id);
        if (stats.floorSol != null) {
          this.store.upsertPairSnapshot(c.id, ts, null, stats.floorSol);
          snapshots++;
        } else {
          errors.push(c.id + ": floor unavailable");
        }
      } catch (e) {
        errors.push(c.id + ": " + String((e as Error).message));
      }
    }
    return { snapshots, errors };
  }

  /** Series for the asset: USD for tokens, SOL for collections (the DIRECT leg). */
  seriesFor(asset: PairAsset, sinceTs: number): AssetSeries {
    const rows = this.store.getPairSnapshots(asset.id, sinceTs);
    if (asset.kind === "nft_collection") {
      return rows.map((r) => ({ time: r.time, priceUsd: r.priceSol }));
    }
    return rows.map((r) => ({ time: r.time, priceUsd: r.priceUsd }));
  }

  /** Latest persisted snapshot for the asset (raw dual-denomination row). */
  latestFor(asset: PairAsset): { time: number; priceUsd: number | null; priceSol: number | null } | null {
    const rows = this.store.getPairSnapshots(asset.id, 0);
    const last = rows[rows.length - 1];
    return last ?? null;
  }
}
