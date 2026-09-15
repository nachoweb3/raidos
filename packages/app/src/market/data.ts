
type Provider = "dexscreener" | "geckoterminal" | "coingecko";
export interface MarketSnapshot<T> {
  data: T;
  source: Provider;
  status: "LIVE" | "DEGRADED";
  asOf: number;
  cacheAgeMs: number;
}
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
const HOSTS: Record<Provider, string> = {
  dexscreener: "https://api.dexscreener.com",
  geckoterminal: "https://api.geckoterminal.com/api/v2",
  coingecko: "https://api.coingecko.com/api/v3",
};
const NETWORKS: Record<string, string> = {
  solana: "solana", ethereum: "eth", base: "base", bsc: "bsc",
  arbitrum: "arbitrum", polygon: "polygon_pos", monad: "monad",
};
const reverseNetwork = (network: string) => Object.keys(NETWORKS).find((chain) => NETWORKS[chain] === network) ?? network;
const addressKey = (chain: string, address: string) => /^0x/i.test(address) ? address.toLowerCase() : address;
const validChain = (chain: string) => {
  if (!/^[a-z0-9_-]{1,40}$/.test(chain)) throw new Error("invalid chain");
  return chain;
};
const validAddress = (address: string) => {
  if (!/^[A-Za-z0-9:_-]{20,160}$/.test(address)) throw new Error("invalid token or pool address");
  return address;
};

/** Fixed-host data adapters, bounded shared cache, request coalescing and per-provider quotas. */
export class MarketDataService {
  private readonly fetcher: Fetcher;
  private readonly now: () => number;
  private readonly limits: Record<Provider, number>;
  private readonly calls = new Map<Provider, number[]>();
  private readonly cache = new Map<string, { value: any; asOf: number; expires: number }>();
  private readonly inflight = new Map<string, Promise<MarketSnapshot<any>>>();

  constructor(options: { fetcher?: Fetcher; now?: () => number; limits?: Partial<Record<Provider, number>> } = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.limits = { dexscreener: 240, geckoterminal: 10, coingecko: 8, ...options.limits };
  }

  private async json(provider: Provider, path: string, ttl = 30000): Promise<MarketSnapshot<any>> {
    const key = provider + path;
    const cached = this.cache.get(key);
    const now = this.now();
    const snapshot = (entry: { value: any; asOf: number }, status: "LIVE" | "DEGRADED"): MarketSnapshot<any> =>
      ({ data: entry.value, source: provider, status, asOf: entry.asOf, cacheAgeMs: this.now() - entry.asOf });
    if (cached && cached.expires > now) return snapshot(cached, "LIVE");
    const running = this.inflight.get(key);
    if (running) return running;
    const promise = (async () => {
      try {
        const recent = (this.calls.get(provider) ?? []).filter((at) => now - at < 60000);
        if (recent.length >= this.limits[provider]) throw new Error("provider quota reached");
        recent.push(now);
        this.calls.set(provider, recent);
        const response = await this.fetcher(HOSTS[provider] + path, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) throw new Error("upstream HTTP " + response.status);
        const value = await response.json();
        if (value == null || typeof value !== "object" || ("error" in value && value.error) || ("errors" in value && value.errors)) throw new Error("invalid upstream response");
        const entry = { value, asOf: this.now(), expires: this.now() + ttl };
        if (this.cache.size >= 500 && !this.cache.has(key)) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, entry);
        return snapshot(entry, "LIVE");
      } catch {
        if (cached && this.now() - cached.asOf <= 300000) return snapshot(cached, "DEGRADED");
        throw new Error(provider + " market data unavailable");
      }
    })();
    this.inflight.set(key, promise);
    try { return await promise; } finally { this.inflight.delete(key); }
  }

  private geckoPairs(body: any, chainHint?: string): any[] {
    if (!Array.isArray(body.data)) throw new Error("GeckoTerminal pools unavailable");
    const included = new Map<string, any>((body.included ?? []).map((item: any) => [item.id, item.attributes]));
    return body.data.flatMap((pool: any) => {
      const attributes = pool.attributes;
      const rel = pool.relationships;
      const base = included.get(rel?.base_token?.data?.id);
      const quote = included.get(rel?.quote_token?.data?.id);
      if (!attributes?.address || !base?.address) return [];
      const tokenId = String(rel?.base_token?.data?.id ?? "");
      const network = tokenId.slice(0, -(base.address.length + 1));
      const chain = chainHint ?? reverseNetwork(network);
      return [{
        chainId: chain, pairAddress: attributes.address,
        dexId: rel?.dex?.data?.id ?? null,
        url: "https://www.geckoterminal.com/" + encodeURIComponent(network) + "/pools/" + encodeURIComponent(attributes.address),
        baseToken: { address: base.address, symbol: base.symbol, name: base.name, decimals: base.decimals },
        quoteToken: quote ? { address: quote.address, symbol: quote.symbol, name: quote.name, decimals: quote.decimals } : null,
        priceUsd: attributes.base_token_price_usd ?? null,
        marketCap: attributes.market_cap_usd ?? null, fdv: attributes.fdv_usd ?? null,
        liquidity: { usd: attributes.reserve_in_usd ?? null },
        volume: attributes.volume_usd ?? {}, priceChange: attributes.price_change_percentage ?? {},
        txns: attributes.transactions ?? {},
        pairCreatedAt: attributes.pool_created_at ? Date.parse(attributes.pool_created_at) : null,
        info: { imageUrl: base.image_url ?? null }, source: "geckoterminal",
      }];
    });
  }

  async search(query: string, chain?: string): Promise<MarketSnapshot<any[]>> {
    if (typeof query !== "string" || query.trim().length < 2 || query.length > 128) throw new Error("invalid search query");
    query = query.trim();
    if (chain && chain !== "all") validChain(chain);
    const filter = (pairs: any[]) => pairs.filter((pair) => pair?.baseToken?.address && (!chain || chain === "all" || pair.chainId === chain));
    try {
      const result = await this.json("dexscreener", "/latest/dex/search?q=" + encodeURIComponent(query));
      if (!Array.isArray(result.data.pairs)) throw new Error("invalid pair search");
      return { ...result, data: filter(result.data.pairs) };
    } catch {
      const network = chain && chain !== "all" ? "&network=" + encodeURIComponent(NETWORKS[chain] ?? chain) : "";
      const result = await this.json("geckoterminal", "/search/pools?query=" + encodeURIComponent(query) + network + "&include=base_token,quote_token,dex");
      return { ...result, data: filter(this.geckoPairs(result.data)) };
    }
  }

  async tokens(chain: string, addresses: string[]): Promise<MarketSnapshot<any[]>> {
    validChain(chain);
    if (!Array.isArray(addresses) || addresses.length < 1 || addresses.length > 30) throw new Error("token batch must contain 1-30 addresses");
    addresses.forEach(validAddress);
    const wanted = new Set(addresses.map((address) => addressKey(chain, address)));
    try {
      const result = await this.json("dexscreener", "/tokens/v1/" + chain + "/" + addresses.map(encodeURIComponent).join(","));
      if (!Array.isArray(result.data)) throw new Error("invalid token response");
      const pairs = result.data.filter((p: any) => p?.chainId === chain && wanted.has(addressKey(chain, p.baseToken?.address ?? "")));
      if (pairs.length) return { ...result, data: pairs };
    } catch { /* Retry with independent real pool data, never synthetic prices. */ }
    const results = await Promise.allSettled(addresses.map(async (address) => {
      const result = await this.json("geckoterminal", "/networks/" + (NETWORKS[chain] ?? chain) +
        "/tokens/" + encodeURIComponent(address) + "/pools?include=base_token,quote_token,dex", 60000);
      return { ...result, data: this.geckoPairs(result.data, chain).filter((p) => wanted.has(addressKey(chain, p.baseToken.address))) };
    }));
    const available = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    if (!available.length) throw new Error("Token market data unavailable");
    return {
      source: "geckoterminal",
      status: available.length !== results.length || available.some((r) => r.status === "DEGRADED") ? "DEGRADED" : "LIVE",
      asOf: Math.min(...available.map((r) => r.asOf)), cacheAgeMs: Math.max(...available.map((r) => r.cacheAgeMs)),
      data: available.flatMap((r) => r.data),
    };
  }

  async pools(chain = "all", kind = "trending", page = 1): Promise<MarketSnapshot<any[]>> {
    validChain(chain);
    if (!["new", "trending"].includes(kind) || !Number.isInteger(page) || page < 1 || page > 10) throw new Error("invalid pool query");
    const network = chain === "all" ? "" : "/" + (NETWORKS[chain] ?? chain);
    const result = await this.json("geckoterminal", "/networks" + network + "/" + kind + "_pools?include=base_token,quote_token,dex&page=" + page, 60000);
    return { ...result, data: this.geckoPairs(result.data, chain === "all" ? undefined : chain) };
  }

  async candles(chain: string, pool: string, token: string, aggregate = 5): Promise<MarketSnapshot<any[]>> {
    validChain(chain); validAddress(pool); validAddress(token);
    if (![1, 5, 15].includes(aggregate)) throw new Error("invalid candle interval");
    const result = await this.json("geckoterminal", "/networks/" + (NETWORKS[chain] ?? chain) + "/pools/" + encodeURIComponent(pool) +
      "/ohlcv/minute?aggregate=" + aggregate + "&limit=100&currency=usd&token=" + encodeURIComponent(token), 60000);
    const rows = result.data?.data?.attributes?.ohlcv_list;
    if (!Array.isArray(rows)) throw new Error("OHLCV data unavailable");
    const candles = new Map<number, any>();
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 6 || !row.slice(0, 6).every((v: unknown) => typeof v === "number" && Number.isFinite(v))) continue;
      const [time, open, high, low, close, volume] = row;
      if (!Number.isInteger(time) || time <= 0 || low < 0 || high < Math.max(open, close) || low > Math.min(open, close) || volume < 0) continue;
      candles.set(time, { time, open, high, low, close, volume });
    }
    return { ...result, data: [...candles.values()].sort((a, b) => a.time - b.time) };
  }

  async referenceMarkets(ids: string): Promise<MarketSnapshot<any[]>> {
    const coins = ids.split(",");
    if (coins.length < 1 || coins.length > 30 || coins.some((c) => !/^[a-z0-9-]{1,80}$/.test(c))) throw new Error("invalid reference ids");
    const result = await this.json("coingecko", "/coins/markets?vs_currency=usd&ids=" +
      encodeURIComponent([...new Set(coins)].sort().join(",")) + "&sparkline=false&price_change_percentage=24h&order=market_cap_desc", 300000);
    if (!Array.isArray(result.data)) throw new Error("Reference markets unavailable");
    return result;
  }

  async referenceCandles(coin: string): Promise<MarketSnapshot<any[]>> {
    if (!/^[a-z0-9-]{1,80}$/.test(coin)) throw new Error("invalid reference coin");
    const result = await this.json("coingecko", "/coins/" + coin + "/ohlc?vs_currency=usd&days=1", 300000);
    if (!Array.isArray(result.data)) throw new Error("Reference OHLC unavailable");
    return { ...result, data: result.data.filter((r: any) => Array.isArray(r) && r.length >= 5 && r.every(Number.isFinite))
      .map(([time, open, high, low, close]: number[]) => ({ time: Math.floor(time! / 1000), open, high, low, close }))
      .sort((a: any, b: any) => a.time - b.time) };
  }
}
