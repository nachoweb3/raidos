/**
 * 📊 MARKET DATA PROVIDERS — RaidOS Volume Intelligence
 * Chain/provider-agnostic interface. V1 ships a DexScreener provider
 * (keyless) plus a deterministic mock for tests and offline runs.
 *
 * Design rules from the RaidOS spec:
 * - Never hard-code a single provider; everything goes through MarketDataProvider.
 * - Never fabricate data: the mock provider is clearly labeled as mock.
 */

export interface TokenStats {
  symbol: string;
  name: string;
  priceUsd: number;
  volume24hUsd: number;
  liquidityUsd: number;
  buys24h: number | null;
  sells24h: number | null;
  txns24h: number | null;
  holders: number | null;
  change24hPct: number | null;
  change1hPct: number | null;
  pairAddress: string | null;
  dexId: string | null;
  source: string;
  ts: number;
}

export interface MarketDataProvider {
  readonly name: string;
  /** Fetch current stats for a token/pair address. Throws on failure. */
  getTokenStats(address: string): Promise<TokenStats>;
}

// ── DexScreener (keyless, rate-limit friendly) ─────────────────────────────

interface DexPair {
  chainId: string;
  dexId: string;
  pairAddress?: string;
  baseToken: { address: string; name: string; symbol: string };
  priceUsd?: string;
  volume?: { h24?: number; h6?: number; h1?: number };
  liquidity?: { usd?: number };
  txns?: { h24?: { buys: number; sells: number } };
  priceChange?: { h24?: number; h1?: number };
}

export class DexScreenerProvider implements MarketDataProvider {
  readonly name = "dexscreener";
  constructor(private baseUrl = "https://api.dexscreener.com") {}

  async getTokenStats(address: string): Promise<TokenStats> {
    const res = await fetch(`${this.baseUrl}/latest/dex/tokens/${encodeURIComponent(address)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`dexscreener http ${res.status}`);
    const json = (await res.json()) as { pairs?: DexPair[] };
    const pairs = json.pairs ?? [];
    if (pairs.length === 0) throw new Error("dexscreener: no pairs found");
    // Pick the most liquid pair as the canonical one.
    const best = pairs.reduce((a, b) => ((b.liquidity?.usd ?? 0) > (a.liquidity?.usd ?? 0) ? b : a));
    return {
      symbol: best.baseToken.symbol,
      name: best.baseToken.name,
      priceUsd: Number(best.priceUsd ?? 0),
      volume24hUsd: best.volume?.h24 ?? 0,
      liquidityUsd: best.liquidity?.usd ?? 0,
      buys24h: best.txns?.h24?.buys ?? null,
      sells24h: best.txns?.h24?.sells ?? null,
      txns24h: best.txns?.h24 ? best.txns.h24.buys + best.txns.h24.sells : null,
      holders: null, // not exposed by dexscreener token endpoint
      change24hPct: best.priceChange?.h24 ?? null,
      change1hPct: best.priceChange?.h1 ?? null,
      pairAddress: best.pairAddress ?? null,
      dexId: best.dexId,
      source: this.name,
      ts: Math.floor(Date.now() / 1000),
    };
  }
}

// ── Deterministic mock (tests / offline) ───────────────────────────────────

export class MockMarketProvider implements MarketDataProvider {
  readonly name = "mock";
  constructor(private base: Partial<TokenStats> = {}) {}

  async getTokenStats(_address: string): Promise<TokenStats> {
    return {
      symbol: this.base.symbol ?? "SAUR",
      name: this.base.name ?? "Saur Token",
      priceUsd: this.base.priceUsd ?? 0.000042,
      volume24hUsd: this.base.volume24hUsd ?? 182_000,
      liquidityUsd: this.base.liquidityUsd ?? 74_000,
      buys24h: this.base.buys24h ?? 1284,
      sells24h: this.base.sells24h ?? 917,
      txns24h: this.base.txns24h ?? 2201,
      holders: this.base.holders ?? 4892,
      change24hPct: this.base.change24hPct ?? 37,
      change1hPct: this.base.change1hPct ?? 4.2,
      pairAddress: this.base.pairAddress ?? "mockpair",
      dexId: "mockdex",
      source: "mock",
      ts: Math.floor(Date.now() / 1000),
    };
  }
}

export function providerByName(name: string): MarketDataProvider | undefined {
  if (name === "dexscreener") return new DexScreenerProvider();
  if (name === "mock") return new MockMarketProvider();
  return undefined;
}
