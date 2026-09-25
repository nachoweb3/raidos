/**
 * UNIVERSAL PAIRS — floor liquidity (NFT collections).
 *
 * Reads REAL Magic Eden listings (keyless endpoint verified live:
 * `v2/collections/:symbol/listings`), including per-token rarity ranks
 * (howrare / moonrank / meInstant). This is OBSERVED floor liquidity —
 * execution of an NFT purchase is NOT enabled in this phase (buying the floor
 * requires signing Magic Eden's on-chain program, gated by their API key), so
 * the routing layer uses this data to:
 *   1. Prove the floor leg exists (cheapest real listing).
 *   2. Enforce the rarity guard: tokens rarer than `maxRank` are excluded so
 *      a "floor" that is actually a rare piece never masquerades as cheap exit.
 *
 * NO invented data: a listing is reported exactly as the marketplace returned
 * it; missing rarity or missing listings surface as nulls, never zeros.
 */
import type { PairAsset } from "./pair-engine.js";

export interface FloorListing {
  /** Token mint of the listed NFT. */
  mint: string;
  /** Price in SOL (display units, e.g. 9.5247). */
  priceSol: number;
  /** Price in lamports as returned by the marketplace. */
  priceLamports: string;
  /** Token name, e.g. "Mad Lads #4591". */
  name: string | null;
  /** Best-known rarity rank among the providers the listing carries. */
  rarityRank: number | null;
  /** Which rarity source provided the rank. */
  raritySource: "meInstant" | "moonrank" | "howrare" | null;
  /** Collection symbol (Magic Eden slug). */
  collection: string;
  /** Direct marketplace page for the token (honest provenance for the user). */
  listingUrl: string;
}

export interface FloorSnapshot {
  collection: string;
  /** Cheapest listing that passed the rarity guard, or null when none did. */
  floor: FloorListing | null;
  /** Total number of live listings observed in this pass. */
  listingsObserved: number;
  /** Listings excluded because their rarity rank exceeded maxRank. */
  excludedByRarity: number;
  /** How the snapshot was produced. */
  source: "magiceden";
  observedAt: number;
}

export interface FloorProviderDeps {
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  /** Listings page size (marketplace max 20). Default 20. */
  pageSize?: number;
  /** Hard page cap per fetch (guards against pathological scans). Default 5. */
  maxPages?: number;
}

/**
 * Rarity guard default: listings ranked inside the top-250 rarest are excluded
 * from floor attribution (a cheap rare piece is a bargain, not the collection's
 * liquid exit). Lower rank = rarer.
 */
export const DEFAULT_MAX_RANK = 250;

const ME_HOST = "https://api-mainnet.magiceden.dev";
const TTL_MS = 120_000; // floors move fast; listings endpoint is keyless but rate-limited
const MAX_CALLS_PER_MIN = 25;

interface RawListing {
  tokenMint?: unknown;
  price?: unknown;
  priceInfo?: { solPrice?: { rawAmount?: unknown } | null } | null;
  token?: { name?: unknown; collection?: unknown; mintAddress?: unknown } | null;
  rarity?: Record<string, { rank?: unknown } | undefined> | null;
  extra?: { img?: unknown } | null;
}

const toNum = (x: unknown): number | null => {
  const n = Number(x);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

export class FloorLiquidityService {
  private readonly fetcher: (url: string, init?: RequestInit) => Promise<Response>;
  private readonly now: () => number;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly cache = new Map<string, { value: FloorSnapshot; expires: number }>();
  private readonly calls: number[] = [];

  constructor(deps: FloorProviderDeps = {}) {
    this.fetcher = deps.fetcher ?? ((url, init) => fetch(url, init));
    this.now = deps.now ?? Date.now;
    this.pageSize = deps.pageSize ?? 20;
    this.maxPages = deps.maxPages ?? 5;
  }

  private async fetchJson(url: string, timeoutMs = 8000): Promise<unknown> {
    const res = await this.fetcher(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error("magiceden listings HTTP " + res.status);
    return res.json();
  }

  /** Paginates real listings (cheapest first) until the guard passes or pages run out. */
  async floorFor(collection: string, maxRank: number = DEFAULT_MAX_RANK): Promise<FloorSnapshot> {
    const key = `${collection}:${maxRank}`;
    const cached = this.cache.get(key);
    if (cached && cached.expires > this.now()) return cached.value;

    const now = this.now();
    const recent = this.calls.filter((at) => now - at < 60_000);
    if (recent.length >= MAX_CALLS_PER_MIN) throw new Error("magiceden listings quota reached");
    recent.push(now);
    this.calls.length = 0;
    this.calls.push(...recent);

    let observed = 0;
    let excludedByRarity = 0;
    let floor: FloorListing | null = null;
    for (let offset = 0; offset < this.maxPages * this.pageSize && floor == null; offset += this.pageSize) {
      const rows = (await this.fetchJson(
        `${ME_HOST}/v2/collections/${encodeURIComponent(collection)}/listings?limit=${this.pageSize}&offset=${offset}`,
      )) as RawListing[];
      if (!Array.isArray(rows) || rows.length === 0) break;
      for (const row of rows) {
        observed++;
        const mint = typeof row?.tokenMint === "string" ? row.tokenMint : null;
        const rawLamports = toNum(row?.priceInfo?.solPrice?.rawAmount);
        const priceSol = toNum(row?.price);
        if (!mint || rawLamports == null || priceSol == null) continue;
        const rank = this.rarityOf(row);
        if (rank != null && rank <= maxRank) {
          // Inside the top-`maxRank` rarest: honest to observe, wrong to present
          // as the floor the pair trades against.
          excludedByRarity++;
          continue;
        }
        floor = {
          mint,
          priceSol,
          priceLamports: String(Math.round(rawLamports)),
          name: typeof row?.token?.name === "string" ? row.token.name : null,
          rarityRank: rank,
          raritySource: rank != null ? this.raritySourceOf(row) : null,
          collection,
          listingUrl: `https://magiceden.io/item-details/${mint}`,
        };
        break; // listings arrive cheapest-first: first passing row IS the floor
      }
    }

    const snapshot: FloorSnapshot = {
      collection,
      floor,
      listingsObserved: observed,
      excludedByRarity,
      source: "magiceden",
      observedAt: Math.floor(this.now() / 1000),
    };
    this.cache.set(key, { value: snapshot, expires: this.now() + TTL_MS });
    return snapshot;
  }

  /** Best available rank: ME instant → moonrank → howrare (all returned by the same listing). */
  private rarityOf(row: RawListing): number | null {
    return (
      toNum(row?.rarity?.meInstant?.rank) ??
      toNum(row?.rarity?.moonrank?.rank) ??
      toNum(row?.rarity?.howrare?.rank)
    );
  }

  private raritySourceOf(row: RawListing): FloorListing["raritySource"] {
    if (toNum(row?.rarity?.meInstant?.rank) != null) return "meInstant";
    if (toNum(row?.rarity?.moonrank?.rank) != null) return "moonrank";
    if (toNum(row?.rarity?.howrare?.rank) != null) return "howrare";
    return null;
  }
}
