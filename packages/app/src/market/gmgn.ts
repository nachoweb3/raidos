/**
 * 🐺 GMGN SERVICE — read-only bridge to GMGN OpenAPI (demo/public key compatible).
 *
 * Powers the FOMO-style board: POST /v1/trenches gives the exact GMGN
 * categories (new_creation / near_completion / completed) with the pro
 * analytics the UI renders as badges: smart money count, KOLs, snipers,
 * bundlers, insider rate, rug ratio 0-1, honeypot, launchpad platform.
 *
 * Honest-degradation rules of this repo:
 *   - No GMGN_API_KEY configured → service disabled, every call throws a
 *     named GmgnUnavailableError (API answers 503, UI shows honest empty).
 *   - Provider failure / rate limit → cached value within TTL, else 503.
 *   - NEVER invents a field; unknown → null and the UI hides it.
 *
 * READ-ONLY BY DESIGN: swap/order endpoints are NOT wrapped. Trading stays
 * self-custody in our own engines — documented refusal, not an omission.
 */

const GMGN_HOST = "https://openapi.gmgn.ai";

/** Chains our board exposes, mapped to GMGN chain slugs. */
const CHAIN_SLUGS: Record<string, string> = {
  solana: "sol",
  bsc: "bsc",
  base: "base",
  ethereum: "eth",
  robinhood: "robinhood",
  arc: "arc",
};

export const GMGN_CHAINS = Object.keys(CHAIN_SLUGS);

export class GmgnUnavailableError extends Error {}

export interface GmgnTrenchToken {
  address: string;
  chain: string;
  symbol: string;
  name: string;
  logo: string | null;
  priceUsd: number | null;
  change5m: number | null;
  change1h: number | null;
  change6h: number | null;
  change24h: number | null;
  volume24h: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  holderCount: number | null;
  swaps24h: number | null;
  buys24h: number | null;
  sells24h: number | null;
  smartMoneyCount: number | null;
  kolCount: number | null;
  sniperCount: number | null;
  bundlerRate: number | null;
  insiderRate: number | null;
  freshWalletRate: number | null;
  rugRatio: number | null;
  honeypot: boolean | null;
  devHoldRate: number | null;
  top10Rate: number | null;
  launchpad: string | null;
  launchpadPlatform: string | null;
  onCurve: boolean | null;
  createdAt: number | null;
  twitter: string | null;
  telegram: string | null;
  website: string | null;
}

export interface GmgnTrenchSection {
  status: "LIVE" | "UNAVAILABLE";
  error?: string;
  tokens: GmgnTrenchToken[];
}

export interface GmgnTrenchesResult {
  chain: string;
  asOf: number;
  sections: {
    new_creation: GmgnTrenchSection;
    near_completion: GmgnTrenchSection;
    completed: GmgnTrenchSection;
  };
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const pct = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : n * 100;
};
const bool3 = (v: unknown): boolean | null => (v === 0 ? false : v === 1 ? true : null);

/** Map one GMGN trenches row (v2 schema) into our honest shape. */
export function mapTrenchRow(raw: any, chainSlug: string): GmgnTrenchToken {
  const social = (s: unknown): string | null => {
    const t = String(s ?? "").trim();
    return /^https?:\/\//.test(t) ? t : t ? "https://x.com/" + t.replace(/^@/, "") : null;
  };
  return {
    address: String(raw.address ?? ""),
    chain: chainSlug,
    symbol: String(raw.symbol ?? "").slice(0, 24) || "???",
    name: String(raw.name ?? raw.symbol ?? "").slice(0, 48),
    logo: typeof raw.logo === "string" && raw.logo.startsWith("http") ? raw.logo : null,
    priceUsd: num(raw.price),
    change5m: num(raw.price_change_percent5m),
    change1h: num(raw.price_change_percent1h),
    change6h: num(raw.price_change_percent6h),
    change24h: num(raw.price_change_percent),
    volume24h: num(raw.volume),
    liquidityUsd: num(raw.liquidity),
    marketCapUsd: num(raw.usd_market_cap ?? raw.market_cap),
    holderCount: num(raw.holder_count),
    swaps24h: num(raw.swaps_24h ?? raw.swaps),
    buys24h: num(raw.buys_24h ?? raw.buys),
    sells24h: num(raw.sells_24h ?? raw.sells),
    smartMoneyCount: num(raw.smart_degen_count),
    kolCount: num(raw.renowned_count),
    sniperCount: num(raw.sniper_count),
    bundlerRate: pct(raw.bundler_trader_amount_rate ?? raw.bundler_rate),
    insiderRate: pct(raw.rat_trader_amount_rate ?? raw.entrapment_ratio),
    freshWalletRate: pct(raw.fresh_wallet_rate),
    rugRatio: num(raw.rug_ratio),
    honeypot: bool3(raw.is_honeypot),
    devHoldRate: pct(raw.dev_team_hold_rate ?? raw.creator_balance_rate),
    top10Rate: pct(raw.top_10_holder_rate),
    launchpad: typeof raw.launchpad === "string" ? raw.launchpad.slice(0, 24) : null,
    launchpadPlatform: typeof raw.launchpad_platform === "string" ? raw.launchpad_platform.slice(0, 32) : null,
    onCurve: bool3(raw.is_on_curve ?? raw.pool_type),
    createdAt: num(raw.created_timestamp ?? raw.open_timestamp),
    twitter: social(raw.twitter_username),
    telegram: social(raw.telegram),
    website: social(raw.website),
  };
}

const SECTION_KEYS = ["new_creation", "near_completion", "completed"] as const;

/** Body schema copied from gmgn-cli buildTrenchesBody (v2, on+offchain). */
function trenchesBody(chainSlug: string, limit: number, platform?: string) {
  const section: Record<string, unknown> = {
    filters: ["offchain", "onchain"],
    launchpad_platform_v2: true,
    limit,
  };
  if (platform && /^[a-z0-9_-]{1,32}$/.test(platform)) section.launchpad_platform = [platform];
  const body: Record<string, unknown> = { version: "v2" };
  for (const key of SECTION_KEYS) body[key] = { ...section };
  return body;
}

export class GmgnService {
  private readonly fetcher: Fetcher;
  private readonly now: () => number;
  private readonly apiKey: string;
  private readonly ttlMs: number;
  private readonly limit: number;
  private readonly cache = new Map<string, { value: unknown; asOf: number; expires: number }>();
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(options: { fetcher?: Fetcher; now?: () => number; ttlMs?: number; limit?: number; apiKey?: string } = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.apiKey = options.apiKey ?? (process.env.GMGN_API_KEY || "");
    this.ttlMs = options.ttlMs ?? 60_000;
    this.limit = Math.min(80, Math.max(1, options.limit ?? 30));
  }

  get enabled(): boolean {
    return Boolean(this.apiKey);
  }

  private requireEnabled(): void {
    if (!this.enabled) throw new GmgnUnavailableError("GMGN_API_KEY not configured");
  }

  /** Exist-auth request: X-APIKEY + timestamp + client_id (no signing). */
  private async request<T>(method: "GET" | "POST", path: string, query: Record<string, string>, body: unknown): Promise<T> {
    this.requireEnabled();
    const params = new URLSearchParams({ ...query, timestamp: String(Math.floor(this.now() / 1000)), client_id: crypto.randomUUID() });
    const url = `${GMGN_HOST}${path}?${params.toString()}`;
    let res: Response;
    try {
      res = await this.fetcher(url, {
        method,
        headers: { "X-APIKEY": this.apiKey, "Content-Type": "application/json", "User-Agent": "trenches-api/1.0" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new GmgnUnavailableError(`GMGN fetch failed: ${err instanceof Error ? err.cause ?? err.message : err}`);
    }
    let json: any;
    try {
      json = await res.json();
    } catch {
      throw new GmgnUnavailableError(`GMGN non-JSON response (HTTP ${res.status})`);
    }
    if (!res.ok || json?.code !== 0) {
      throw new GmgnUnavailableError(`GMGN error HTTP ${res.status} code ${json?.code ?? "?"}: ${json?.message ?? json?.error ?? "unknown"}`);
    }
    return json.data as T;
  }

  private async cached<T>(key: string, run: () => Promise<T>): Promise<{ data: T; asOf: number; degraded: boolean }> {
    const hit = this.cache.get(key);
    const now = this.now();
    if (hit && hit.expires > now) return { data: hit.value as T, asOf: hit.asOf, degraded: false };
    const running = this.inflight.get(key) as Promise<{ data: T; asOf: number; degraded: boolean }> | undefined;
    if (running) return running;
    const promise = (async () => {
      try {
        const data = await run();
        this.cache.set(key, { value: data, asOf: this.now(), expires: this.now() + this.ttlMs });
        return { data, asOf: this.now(), degraded: false };
      } catch (err) {
        if (hit) return { data: hit.value as T, asOf: hit.asOf, degraded: true };
        throw err;
      }
    })();
    this.inflight.set(key, promise as Promise<unknown>);
    try {
      return await promise;
    } finally {
      this.inflight.delete(key);
    }
  }

  /** POST /v1/trenches — the three GMGN board categories for one chain. */
  async trenches(chain: string, platform?: string): Promise<GmgnTrenchesResult> {
    const slug = CHAIN_SLUGS[chain];
    if (!slug) throw new GmgnUnavailableError(`invalid chain: ${chain}`);
    const { data, asOf, degraded } = await this.cached(`trenches:${slug}:${platform ?? "all"}`, async () => {
      const raw = await this.request<any>("POST", "/v1/trenches", { chain: slug }, trenchesBody(slug, this.limit, platform));
      const sections: GmgnTrenchesResult["sections"] = {
        new_creation: { status: "LIVE", tokens: [] },
        near_completion: { status: "LIVE", tokens: [] },
        completed: { status: "LIVE", tokens: [] },
      };
      for (const key of SECTION_KEYS) {
        const rows = Array.isArray(raw?.[key]) ? raw[key] : [];
        sections[key] = { status: "LIVE", tokens: rows.map((r: any) => mapTrenchRow(r, slug)).filter((t: GmgnTrenchToken) => t.address) };
      }
      return sections;
    });
    const sections = data;
    return {
      chain: slug,
      asOf,
      sections: degraded
        ? {
            new_creation: sections.new_creation.tokens.length ? { ...sections.new_creation, status: "LIVE" } : { status: "UNAVAILABLE", error: "GMGN no disponible; reintenta", tokens: [] },
            near_completion: sections.near_completion.tokens.length ? { ...sections.near_completion, status: "LIVE" } : { status: "UNAVAILABLE", error: "GMGN no disponible; reintenta", tokens: [] },
            completed: sections.completed.tokens.length ? { ...sections.completed, status: "LIVE" } : { status: "UNAVAILABLE", error: "GMGN no disponible; reintenta", tokens: [] },
          }
        : sections,
    };
  }

  /** GET /v1/token/security — rug score 0-1 + honeypot for one address. */
  async tokenSecurity(chain: string, address: string): Promise<Record<string, unknown>> {
    const slug = CHAIN_SLUGS[chain];
    if (!slug) throw new GmgnUnavailableError(`invalid chain: ${chain}`);
    if (!/^[A-Za-z0-9:_-]{20,160}$/.test(address)) throw new GmgnUnavailableError("invalid address");
    const { data } = await this.cached(`sec:${slug}:${address}`, async () => {
      const raw = await this.request<any>("GET", "/v1/token/security", { chain: slug, address }, undefined);
      return {
        chain: slug,
        address,
        rugRatio: num(raw?.rug_ratio),
        honeypot: bool3(raw?.is_honeypot),
        openSource: bool3(raw?.is_open_source),
        renounced: bool3(raw?.is_renounced),
        buyTax: num(raw?.buy_tax),
        sellTax: num(raw?.sell_tax),
        source: "gmgn",
      };
    });
    return data;
  }
}
