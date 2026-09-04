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

// ── GeckoTerminal (keyless, 200+ networks, 30 req/min) ─────────────────────

interface GeckoPool {
  id: string;
  type: string;
  attributes: {
    base_token_price_usd?: string;
    address?: string;
    name?: string;
    volume_usd?: { h24?: string; h6?: string; h1?: string };
    transactions?: { h24?: { buys?: number; sells?: number }; h1?: { buys?: number; sells?: number } };
    reserve_in_usd?: string;
    price_change_percentage?: { h24?: string; h1?: string };
  };
  relationships?: {
    base_token?: { data?: { id?: string } };
  };
}

interface GeckoIncluded {
  id: string;
  type: string;
  attributes: { address?: string; name?: string; symbol?: string };
}

interface GeckoResponse {
  data?: GeckoPool[];
  included?: GeckoIncluded[];
}

/**
 * GeckoTerminal public API — keyless like DexScreener, but multi-network:
 * the network id (e.g. "solana", "eth", "base") is required by the endpoint
 * and set via constructor / GECKO_NETWORK env var.
 */
export class GeckoTerminalProvider implements MarketDataProvider {
  readonly name = "geckoterminal";
  constructor(
    private network = "solana",
    private baseUrl = "https://api.geckoterminal.com/api/v2"
  ) {}

  async getTokenStats(address: string): Promise<TokenStats> {
    const url = `${this.baseUrl}/networks/${encodeURIComponent(this.network)}/tokens/${encodeURIComponent(address)}/pools?include=base_token`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`geckoterminal http ${res.status}`);
    const json = (await res.json()) as GeckoResponse;
    const pools = json.data ?? [];
    if (pools.length === 0) throw new Error("geckoterminal: no pools found");
    // Pick the deepest pool as the canonical one.
    const best = pools.reduce((a, b) => (Number(b.attributes.reserve_in_usd ?? 0) > Number(a.attributes.reserve_in_usd ?? 0) ? b : a));
    const included = json.included ?? [];
    const baseRelId = best.relationships?.base_token?.data?.id;
    const baseInfo = included.find((t) => t.type === "token" && t.id === baseRelId) ??
      included.find((t) => t.type === "token");
    // Fallback: derive symbol from the pool name ("SAUR / SOL").
    const poolName = best.attributes.name ?? "";
    const fallbackSymbol = poolName.split("/")[0]?.trim() ?? "???";
    const txns24 = best.attributes.transactions?.h24;
    return {
      symbol: baseInfo?.attributes.symbol ?? fallbackSymbol,
      name: baseInfo?.attributes.name ?? poolName,
      priceUsd: Number(best.attributes.base_token_price_usd ?? 0),
      volume24hUsd: Number(best.attributes.volume_usd?.h24 ?? 0),
      liquidityUsd: Number(best.attributes.reserve_in_usd ?? 0),
      buys24h: txns24?.buys ?? null,
      sells24h: txns24?.sells ?? null,
      txns24h: txns24 ? (txns24.buys ?? 0) + (txns24.sells ?? 0) : null,
      holders: null, // not exposed by the public pools endpoint
      change24hPct: best.attributes.price_change_percentage?.h24 !== undefined ? Number(best.attributes.price_change_percentage.h24) : null,
      change1hPct: best.attributes.price_change_percentage?.h1 !== undefined ? Number(best.attributes.price_change_percentage.h1) : null,
      pairAddress: best.attributes.address ?? null,
      dexId: best.id.split("_")[0] ?? null,
      source: this.name,
      ts: Math.floor(Date.now() / 1000),
    };
  }
}

// ── Birdeye (API key required, richest data incl. holders) ─────────────────

interface BirdeyeOverview {
  success?: boolean;
  data?: {
    address?: string;
    symbol?: string;
    name?: string;
    price?: number;
    v24hUSD?: number;
    liquidity?: number;
    holder?: number;
    buy24h?: number;
    sell24h?: number;
    trade24h?: number;
    priceChange24hPercent?: number;
    priceChange1hPercent?: number;
  };
}

/**
 * Birdeye Data Services — requires BIRDEYE_API_KEY (free tier exists).
 * Chain is selected via x-chain header (constructor / BIRDEYE_CHAIN env var).
 * Throws a clear error at fetch time when the key is missing so /volume
 * surfaces actionable guidance instead of a silent failure.
 */
export class BirdeyeProvider implements MarketDataProvider {
  readonly name = "birdeye";
  constructor(
    private apiKey = process.env.BIRDEYE_API_KEY ?? "",
    private chain = "solana",
    private baseUrl = "https://public-api.birdeye.so"
  ) {}

  async getTokenStats(address: string): Promise<TokenStats> {
    if (!this.apiKey) throw new Error("birdeye: BIRDEYE_API_KEY not set — get one at birdeye.so, or use dexscreener/geckoterminal");
    const url = `${this.baseUrl}/defi/token_overview?address=${encodeURIComponent(address)}`;
    const res = await fetch(url, {
      headers: { "X-API-KEY": this.apiKey, "x-chain": this.chain },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`birdeye http ${res.status}`);
    const json = (await res.json()) as BirdeyeOverview;
    const d = json.data;
    if (!d) throw new Error("birdeye: empty response");
    return {
      symbol: d.symbol ?? "???",
      name: d.name ?? d.symbol ?? "???",
      priceUsd: d.price ?? 0,
      volume24hUsd: d.v24hUSD ?? 0,
      liquidityUsd: d.liquidity ?? 0,
      buys24h: d.buy24h ?? null,
      sells24h: d.sell24h ?? null,
      txns24h: d.trade24h ?? (d.buy24h !== undefined && d.sell24h !== undefined ? d.buy24h + d.sell24h : null),
      holders: d.holder ?? null,
      change24hPct: d.priceChange24hPercent ?? null,
      change1hPct: d.priceChange1hPercent ?? null,
      pairAddress: null,
      dexId: null,
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
  if (name === "geckoterminal") return new GeckoTerminalProvider(process.env.GECKO_NETWORK);
  if (name === "birdeye") return new BirdeyeProvider(process.env.BIRDEYE_API_KEY, process.env.BIRDEYE_CHAIN);
  if (name === "mock") return new MockMarketProvider();
  return undefined;
}

/** All provider names, for usage strings in the bot UI. */
export const PROVIDER_NAMES = ["dexscreener", "geckoterminal", "birdeye", "mock"] as const;
