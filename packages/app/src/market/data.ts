
import { DISABLED_CHAIN_IDS } from "../chains/config.js";
type Provider = "dexscreener" | "geckoterminal" | "coingecko" | "rugcheck" | "goplus";
export interface MarketSnapshot<T> {
  data: T;
  source: Provider | "mixed";
  missing?: string[];
  status: "LIVE" | "DEGRADED";
  asOf: number;
  cacheAgeMs: number;
}
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
const HOSTS: Record<Provider, string> = {
  dexscreener: "https://api.dexscreener.com",
  geckoterminal: "https://api.geckoterminal.com/api/v2",
  coingecko: "https://api.coingecko.com/api/v3",
  rugcheck: "https://api.rugcheck.xyz",
  goplus: "https://api.gopluslabs.io",
};
const NETWORKS: Record<string, string> = {
  solana: "solana", ethereum: "eth", base: "base", bsc: "bsc", arc: "arc",
};
const reverseNetwork = (network: string) => Object.keys(NETWORKS).find((chain) => NETWORKS[chain] === network) ?? network;
const addressKey = (chain: string, address: string) => /^0x/i.test(address) ? address.toLowerCase() : address;
const validChain = (chain: string) => {
  if (DISABLED_CHAIN_IDS.includes(chain)) throw new Error("invalid chain: network disabled");
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
  private readonly coingeckoKey = process.env.COINGECKO_API_KEY || "";
  private readonly cooldown = new Map<Provider, number>();
  private readonly calls = new Map<Provider, number[]>();
  private readonly cache = new Map<string, { value: any; asOf: number; expires: number }>();
  private readonly inflight = new Map<string, Promise<MarketSnapshot<any>>>();

  constructor(options: { fetcher?: Fetcher; now?: () => number; limits?: Partial<Record<Provider, number>> } = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.limits = { dexscreener: 240, geckoterminal: 10, coingecko: 8, rugcheck: 40, goplus: 20, ...options.limits };
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
        if (now < (this.cooldown.get(provider) ?? 0)) throw new Error("provider cooling down");
        const recent = (this.calls.get(provider) ?? []).filter((at) => now - at < 60000);
        if (recent.length >= this.limits[provider]) throw new Error("provider quota reached");
        recent.push(now);
        this.calls.set(provider, recent);
        const headers: Record<string, string> = { Accept: "application/json" };
        // The onchain API rejects datacenter IPs without a key (401) even on the demo plan.
        if (provider === "coingecko" && this.coingeckoKey) headers["x-cg-demo-api-key"] = this.coingeckoKey;
        const response = await this.fetcher(HOSTS[provider] + path, {
          headers,
          signal: AbortSignal.timeout(8000),
        });
        if (response.status === 429 || response.status === 503) {
          const retry = response.headers.get("Retry-After");
          const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : 0;
          const until = seconds ? now + seconds * 1000 : retry ? Date.parse(retry) : NaN;
          this.cooldown.set(provider, Math.max(now + 60000, Number.isFinite(until) ? until : 0));
        }
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

  private async onchain(path: string, ttl = 30000): Promise<MarketSnapshot<any>> {
    let stale: MarketSnapshot<any> | undefined;
    try {
      const primary = await this.json("geckoterminal", path, ttl);
      if (primary.status === "LIVE") return primary;
      stale = primary;
    } catch { /* Try the official onchain API with its own cache and quota. */ }
    try { return await this.json("coingecko", "/onchain" + path, ttl); }
    catch { if (stale) return stale; throw new Error("Onchain market data unavailable"); }
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
      if (DISABLED_CHAIN_IDS.includes(chain)) return [];
      return [{
        chainId: chain, pairAddress: attributes.address,
        dexId: rel?.dex?.data?.id ?? null,
        url: "https://www.geckoterminal.com/" + encodeURIComponent(network) + "/pools/" + encodeURIComponent(attributes.address),
        baseToken: { address: base.address, symbol: base.symbol, name: base.name, decimals: base.decimals },
        quoteToken: quote ? { address: quote.address, symbol: quote.symbol, name: quote.name, decimals: quote.decimals } : null,
        priceUsd: attributes.base_token_price_usd ?? null,
        quotePriceUsd: attributes.quote_token_price_usd ?? null,
        quoteImageUrl: quote?.image_url ?? null,
        marketCap: attributes.market_cap_usd ?? null, fdv: attributes.fdv_usd ?? null,
        liquidity: { usd: attributes.reserve_in_usd ?? null },
        volume: attributes.volume_usd ?? {}, priceChange: attributes.price_change_percentage ?? {},
        txns: attributes.transactions ?? {},
        pairCreatedAt: attributes.pool_created_at ? Date.parse(attributes.pool_created_at) : null,
        info: { imageUrl: base.image_url ?? null },
      }];
    });
  }

  /** Present a pool in terms of the requested asset, including its quote side. */
  private matchingAssets(pairs: any[], wanted: Set<string>, chain?: string): any[] {
    return pairs.flatMap((pair: any) => {
      if (!pair?.chainId || DISABLED_CHAIN_IDS.includes(pair.chainId) || (chain && chain !== "all" && pair.chainId !== chain)) return [];
      const out: any[] = [];
      if (wanted.has(addressKey(pair.chainId, pair.baseToken?.address ?? ""))) out.push(pair);
      if (wanted.has(addressKey(pair.chainId, pair.quoteToken?.address ?? ""))) {
        const quotePrice = Number(pair.quotePriceUsd) > 0 ? Number(pair.quotePriceUsd)
          : Number(pair.priceNative) > 0 && Number(pair.priceUsd) > 0 ? Number(pair.priceUsd) / Number(pair.priceNative) : null;
        out.push({ ...pair, baseToken: pair.quoteToken, quoteToken: pair.baseToken,
          priceUsd: quotePrice, quotePriceUsd: pair.priceUsd, priceNative: undefined,
          marketCap: null, fdv: null, priceChange: {}, txns: {},
          info: { imageUrl: pair.quoteImageUrl ?? null }, requestedSide: "quote" });
      }
      return out;
    });
  }

  async search(query: string, chain?: string): Promise<MarketSnapshot<any[]>> {
    if (typeof query !== "string" || query.trim().length < 2 || query.length > 128) throw new Error("invalid search query");
    query = query.trim();
    if (chain && chain !== "all") validChain(chain);
    const exactAddress = /^(0x[0-9a-fA-F]{40,64}|[1-9A-HJ-NP-Za-km-z]{32,64}|[EU]Q[A-Za-z0-9_-]{40,64})$/.test(query);
    const filter = (pairs: any[]) => exactAddress
      ? this.matchingAssets(pairs, new Set([addressKey(chain ?? "", query)]), chain)
      : pairs.filter((pair) => pair?.baseToken?.address && !DISABLED_CHAIN_IDS.includes(pair.chainId) && (!chain || chain === "all" || pair.chainId === chain));
    try {
      const result = await this.json("dexscreener", "/latest/dex/search?q=" + encodeURIComponent(query));
      if (!Array.isArray(result.data.pairs)) throw new Error("invalid pair search");
      const pairs = filter(result.data.pairs);
      if (pairs.length) return { ...result, data: pairs };
    } catch { /* Independent indexed-pool fallback. */ }
    {
      const network = chain && chain !== "all" ? "&network=" + encodeURIComponent(NETWORKS[chain] ?? chain) : "";
      const result = await this.onchain("/search/pools?query=" + encodeURIComponent(query) + network + "&include=base_token,quote_token,dex");
      return { ...result, data: filter(this.geckoPairs(result.data)) };
    }
  }

  async tokens(chain: string, addresses: string[]): Promise<MarketSnapshot<any[]>> {
    validChain(chain);
    if (!Array.isArray(addresses) || addresses.length < 1 || addresses.length > 30) throw new Error("token batch must contain 1-30 addresses");
    addresses.forEach(validAddress);
    addresses = [...new Set(addresses.map((a) => addressKey(chain, a)))];
    const wanted = new Set(addresses);
    const available: MarketSnapshot<any[]>[] = [];
    const decorate = (result: MarketSnapshot<any[]>) => ({
      ...result, data: result.data.map((pair) => ({ ...pair, source: result.source, marketAsOf: result.asOf, marketStatus: result.status })),
    });
    try {
      const result = await this.json("dexscreener", "/tokens/v1/" + chain + "/" + addresses.map(encodeURIComponent).join(","));
      if (!Array.isArray(result.data)) throw new Error("invalid token response");
      available.push(decorate({ ...result, data: this.matchingAssets(result.data, wanted, chain) }));
    } catch { /* Fill gaps from another real index, including partial batches. */ }
    const found = new Set(available.flatMap((r) => r.data.map((p) => addressKey(chain, p.baseToken.address))));
    const missing = addresses.filter((address) => !found.has(address));
    const backups = await Promise.allSettled(missing.map(async (address) => {
      const result = await this.onchain("/networks/" + (NETWORKS[chain] ?? chain) +
        "/tokens/" + encodeURIComponent(address) + "/pools?include=base_token,quote_token,dex", 60000);
      return decorate({ ...result, data: this.matchingAssets(this.geckoPairs(result.data, chain), new Set([address]), chain) });
    }));
    for (const result of backups) if (result.status === "fulfilled") available.push(result.value);
    if (!available.length) throw new Error("Token market data unavailable");
    const data = available.flatMap((r) => r.data);
    const indexed = new Set(data.map((p) => addressKey(chain, p.baseToken.address)));
    const unresolved = addresses.filter((address) => !indexed.has(address));
    const sources = new Set(available.filter((r) => r.data.length).map((r) => r.source));
    return {
      source: sources.size > 1 ? "mixed" : [...sources][0] ?? available[0]!.source,
      status: backups.some((r) => r.status === "rejected") || available.some((r) => r.status === "DEGRADED") ? "DEGRADED" : "LIVE",
      asOf: Math.min(...available.map((r) => r.asOf)), cacheAgeMs: Math.max(...available.map((r) => r.cacheAgeMs)),
      data, missing: unresolved,
    };
  }

  async pools(chain = "all", kind = "trending", page = 1): Promise<MarketSnapshot<any[]>> {
    validChain(chain);
    if (!["new", "trending"].includes(kind) || !Number.isInteger(page) || page < 1 || page > 10) throw new Error("invalid pool query");
    const network = chain === "all" ? "" : "/" + (NETWORKS[chain] ?? chain);
    const result = await this.onchain("/networks" + network + "/" + kind + "_pools?include=base_token,quote_token,dex&page=" + page, 60000);
    return { ...result, data: this.geckoPairs(result.data, chain === "all" ? undefined : chain) };
  }

  async trades(chain: string, pool: string, token: string): Promise<MarketSnapshot<any[]>> {
    validChain(chain); validAddress(pool); validAddress(token);
    const result = await this.onchain("/networks/" + (NETWORKS[chain] ?? chain) +
      "/pools/" + encodeURIComponent(pool) + "/trades", 30000);
    if (!Array.isArray(result.data?.data)) throw new Error("GeckoTerminal trades unavailable");
    const seen = new Set<string>();
    const data = result.data.data.slice(0, 300).flatMap((row: any) => {
      const a = row?.attributes;
      if (!a || typeof row.id !== "string" || seen.has(row.id)) return [];
      const isToken = (value: unknown) => typeof value === "string" && addressKey(chain, value) === addressKey(chain, token);
      const buy = isToken(a.to_token_address), sell = isToken(a.from_token_address);
      if (buy === sell) return [];
      const time = Math.floor(Date.parse(a.block_timestamp) / 1000);
      const priceUsd = Number(buy ? a.price_to_in_usd : a.price_from_in_usd);
      const volumeUsd = Number(a.volume_in_usd);
      const amount = buy ? a.to_token_amount : a.from_token_amount;
      if (!Number.isFinite(time) || time <= 0 || !Number.isFinite(priceUsd) || priceUsd <= 0 ||
          a.volume_in_usd == null || !Number.isFinite(volumeUsd) || volumeUsd < 0 ||
          typeof amount !== "string" || !/^\d+(\.\d+)?$/.test(amount) ||
          typeof a.tx_hash !== "string" || !/^[A-Za-z0-9]{32,160}$/.test(a.tx_hash) ||
          typeof a.tx_from_address !== "string" || !/^[A-Za-z0-9]{20,100}$/.test(a.tx_from_address)) return [];
      seen.add(row.id);
      return [{ id: row.id, chain, pool, token, time, side: buy ? "buy" : "sell", priceUsd,
        volumeUsd, amount, wallet: a.tx_from_address, txHash: a.tx_hash }];
    }).sort((a: any, b: any) => b.time - a.time);
    return { ...result, data };
  }

  async candles(chain: string, pool: string, token: string, aggregate = 5): Promise<MarketSnapshot<any[]>> {
    validChain(chain); validAddress(pool); validAddress(token);
    if (![1, 5, 15].includes(aggregate)) throw new Error("invalid candle interval");
    const result = await this.onchain("/networks/" + (NETWORKS[chain] ?? chain) + "/pools/" + encodeURIComponent(pool) +
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

  async security(chain: string, token: string): Promise<{
    report: { level: "good" | "warn" | "bad"; score: number | null; provider: string; label: string; title: string; detail: string } | null;
    source: string; status: "LIVE" | "DEGRADED" | "UNAVAILABLE"; asOf: number | null; cacheAgeMs: number | null;
  }> {
    validChain(chain); validAddress(token);
    const ids: Record<string, number> = { ethereum: 1, base: 8453, bsc: 56, arbitrum: 42161, polygon: 137 };
    const provider = chain === "solana" ? "rugcheck" : ids[chain] ? "goplus" : null;
    const missing = { report: null, source: provider ?? "unsupported", status: "UNAVAILABLE" as const, asOf: null, cacheAgeMs: null };
    if (!provider) return missing;
    try {
      let result: MarketSnapshot<any>;
      let level: "good" | "warn" | "bad", score: number | null = null;
      let signals: string[] = [];
      if (provider === "rugcheck") {
        result = await this.json(provider, "/v1/tokens/" + encodeURIComponent(token) + "/report/summary", 300000);
        const body = result.data;
        if (!Number.isFinite(body.score_normalised) || !Array.isArray(body.risks)) return missing;
        score = body.score_normalised;
        const danger = body.risks.some((r: any) => r.level === "danger");
        const warning = body.risks.some((r: any) => r.level === "warn");
        level = danger || score! >= 75 ? "bad" : warning || score! >= 35 ? "warn" : "good";
        signals = body.risks.map((r: any) => String(r.name ?? "")).filter(Boolean).slice(0, 5);
      } else {
        result = await this.json(provider, "/api/v1/token_security/" + ids[chain] + "?contract_addresses=" + encodeURIComponent(token), 300000);
        const body = result.data?.result?.[token.toLowerCase()];
        if (!body || !["0", "1"].includes(body.is_honeypot) || body.buy_tax == null || body.sell_tax == null ||
            !["0", "1"].includes(body.is_mintable) || !["0", "1"].includes(body.is_open_source)) return missing;
        const buyTax = Number(body.buy_tax) * 100, sellTax = Number(body.sell_tax) * 100;
        if (![buyTax, sellTax].every((v) => Number.isFinite(v) && v >= 0)) return missing;
        if (body.is_honeypot === "1") signals.push("Honeypot");
        if (body.is_mintable === "1") signals.push("Mint authority");
        if (body.is_open_source === "0") signals.push("Unverified source");
        if (buyTax > 0) signals.push("Buy tax " + buyTax.toFixed(1) + "%");
        if (sellTax > 0) signals.push("Sell tax " + sellTax.toFixed(1) + "%");
        level = body.is_honeypot === "1" || buyTax >= 20 || sellTax >= 20 ? "bad"
          : body.is_mintable === "1" || body.is_open_source === "0" || buyTax >= 5 || sellTax >= 5 ? "warn" : "good";
      }
      return { source: provider, status: result.status, asOf: result.asOf, cacheAgeMs: result.cacheAgeMs,
        report: { level, score, provider, label: level === "bad" ? "HIGH" : level === "warn" ? "MED" : "LOW",
          title: signals.join(" · ") || "No listed risk signals; not a security guarantee",
          detail: signals.length + " signals" } };
    } catch { return missing; }
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
