/**
 * 📡 DEX FEED — real pair-level market data from DexScreener's public API.
 * No API key required. For every token we resolve (best-effort, highest
 * liquidity pair): price, market cap / FDV, 24h volume, liquidity, 24h txns
 * (buys/sells), 1h/6h/24h price change, social links, logo and the pair URL.
 *
 * Honest-data rules (same as PriceFeed): when DexScreener has no pair for a
 * token, the row stays null and the UI renders "—" — nothing is invented.
 * Cache: localStorage, 5 minutes TTL, keyed `raidos_dex_cache_v1`.
 */

const DEX_SEARCH_URL = "https://api.dexscreener.com/latest/dex/search?q=";

/** Map our chain slugs to DexScreener chainIds (missing → pair accepted anyway). */
const CHAIN_ALIASES = {
  solana: ["solana"],
  ethereum: ["ethereum"],
  base: ["base"],
  bsc: ["bsc"],
  arbitrum: ["arbitrum"],
  polygon: ["polygon"],
  monad: ["monad"],
  arc: [],
};

function normalizeSocials(info) {
  const out = {};
  try {
    for (const w of info?.websites ?? []) {
      if (typeof w?.url === "string" && w.url.startsWith("http")) out.website = w.url;
    }
    for (const s of info?.socials ?? []) {
      const type = String(s?.type ?? "").toLowerCase();
      const url = typeof s?.url === "string" ? s.url : "";
      if (!url.startsWith("http")) continue;
      if (type === "twitter" || type === "x") out.twitter = url;
      else if (type === "telegram") out.telegram = url;
      else if (!out.website && type === "website") out.website = url;
    }
  } catch {}
  return out;
}

/** Pick the pair we trust most: matching chain first, then deepest liquidity. */
function pickPair(pairs, chainHint) {
  if (!Array.isArray(pairs) || pairs.length === 0) return null;
  const ok = pairs.filter((p) => p && typeof p === "object" && p.baseToken);
  if (!ok.length) return null;
  const aliases = chainHint ? CHAIN_ALIASES[chainHint] ?? [] : [];
  const sameChain = aliases.length ? ok.filter((p) => aliases.includes(p.chainId)) : [];
  const pool = sameChain.length ? sameChain : ok;
  return pool.reduce((best, p) => {
    const liq = Number(p?.liquidity?.usd ?? 0);
    const bestLiq = Number(best?.liquidity?.usd ?? 0);
    return liq > bestLiq ? p : best;
  }, pool[0]);
}

function pairToRow(p, chainHint) {
  const liq = Number(p?.liquidity?.usd ?? 0);
  const mcap = Number(p?.marketCap ?? p?.fdv ?? 0);
  return {
    symbol: String(p.baseToken?.symbol ?? "").toUpperCase(),
    name: p.baseToken?.name ?? null,
    address: p.baseToken?.address ?? null,
    chain: p.chainId ?? chainHint ?? null,
    dex: p.dexId ?? null,
    pairUrl: typeof p.url === "string" ? p.url : null,
    priceUsd: Number(p.priceUsd ?? 0),
    mcap,
    fdv: Number(p.fdv ?? 0),
    vol24h: Number(p.volume?.h24 ?? 0),
    vol6h: Number(p.volume?.h6 ?? 0),
    vol1h: Number(p.volume?.h1 ?? 0),
    liqUsd: liq,
    buys24h: Number(p.txns?.h24?.buys ?? 0),
    sells24h: Number(p.txns?.h24?.sells ?? 0),
    txns24h: Number(p.txns?.h24?.buys ?? 0) + Number(p.txns?.h24?.sells ?? 0),
    txns1h: Number(p.txns?.h1?.buys ?? 0) + Number(p.txns?.h1?.sells ?? 0),
    change1h: Number(p.priceChange?.h1 ?? 0),
    change6h: Number(p.priceChange?.h6 ?? 0),
    change24h: Number(p.priceChange?.h24 ?? 0),
    socials: normalizeSocials(p.info),
    logo: typeof p.info?.imageUrl === "string" && p.info.imageUrl.startsWith("http") ? p.info.imageUrl : null,
    _updatedAt: Date.now(),
  };
}

export const DexFeed = {
  cacheKey: "raidos_dex_cache_v1",
  cacheTtlMs: 5 * 60 * 1000,
  /** key: SYMBOL (upper) or token address (lower) → row | null (null = checked, none found) */
  cache: {},
  cacheUpdatedAt: 0,
  _inflight: null,

  _loadStored() {
    try {
      const stored = localStorage.getItem(this.cacheKey);
      if (!stored) return;
      const parsed = JSON.parse(stored);
      if (parsed && parsed.entries && typeof parsed.entries === "object") {
        const fresh = Date.now() - parsed._updatedAt < this.cacheTtlMs;
        this.cache = parsed.entries;
        this.cacheUpdatedAt = fresh ? parsed._updatedAt : 0;
      }
    } catch {}
  },

  _persist() {
    try {
      localStorage.setItem(this.cacheKey, JSON.stringify({ _updatedAt: this.cacheUpdatedAt, entries: this.cache }));
    } catch {}
  },

  isFresh() {
    return Date.now() - this.cacheUpdatedAt < this.cacheTtlMs;
  },

  get(key) {
    if (!this.cacheUpdatedAt) this._loadStored();
    if (!key) return null;
    return this.cache[String(key).toUpperCase()] ?? this.cache[String(key).toLowerCase()] ?? null;
  },

  /** Merge a resolved row into the cache under both symbol and address keys. */
  _put(row) {
    if (!row) return;
    if (row.symbol) this.cache[row.symbol.toUpperCase()] = row;
    if (row.address) this.cache[String(row.address).toLowerCase()] = row;
  },

  /**
   * Ensure DexScreener data for a batch of refs: [{ symbol, address?, chain? }].
   * Skips keys already cached (even "checked but empty" results). Sequential
   * with a small gap to stay well inside public rate limits.
   */
  async ensureTokens(refs, { force = false } = {}) {
    if (!this.cacheUpdatedAt) this._loadStored();
    const pending = [];
    const seen = new Set();
    for (const ref of refs ?? []) {
      const sym = String(ref?.symbol ?? "").trim().toUpperCase();
      const addr = String(ref?.address ?? "").trim();
      const key = addr ? addr.toLowerCase() : sym;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      if (!force && key in this.cache && this.isFresh()) continue;
      pending.push({ symbol: sym, address: addr, chain: ref?.chain, key });
    }
    if (!pending.length) return this.cache;

    for (const item of pending) {
      const q = item.address || item.symbol;
      if (!q) continue;
      try {
        const res = await fetch(DEX_SEARCH_URL + encodeURIComponent(q), {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) {
          const json = await res.json();
          const pair = pickPair(json?.pairs, item.chain);
          const row = pair ? pairToRow(pair, item.chain) : null;
          this.cache[item.key] = row; // null marks "checked, not listed"
          if (row) this._put(row);
        } else {
          this.cache[item.key] = null;
        }
      } catch {
        // network error: leave unknown (retry next refresh), don't poison cache
        if (!(item.key in this.cache)) this.cache[item.key] = null;
      }
      await new Promise((r) => setTimeout(r, 80));
    }
    this.cacheUpdatedAt = Date.now();
    this._persist();
    return this.cache;
  },

  async refresh(refs) {
    this.cache = {};
    this.cacheUpdatedAt = 0;
    return this.ensureTokens(refs, { force: true });
  },

  /** Socials for a token (symbol or address), or {} when unknown. */
  socialsFor(key) {
    return this.get(key)?.socials ?? {};
  },

  /**
   * Hot narratives: rank sectors by momentum = Σ(volume_h6 × |Δh6|) per sector,
   * normalized to a 0-100 heat score. Tokens carry `sector`; rows without
   * DexScreener data contribute nothing (honest scoring).
   */
  narrativeHeat(tokens) {
    const bySector = new Map();
    for (const t of tokens ?? []) {
      const sector = t.sector;
      if (!sector) continue;
      const row = this.get(t.tokenAddress || t.symbol);
      if (!row) continue;
      const heat = row.vol6h * Math.min(Math.abs(row.change6h), 100);
      const acc = bySector.get(sector) ?? { volume: 0, heat: 0, tokens: 0 };
      acc.volume += row.vol6h;
      acc.heat += heat;
      acc.tokens += 1;
      bySector.set(sector, acc);
    }
    const entries = [...bySector.entries()].map(([sector, v]) => ({ sector, ...v }));
    const max = Math.max(1, ...entries.map((e) => e.heat));
    for (const e of entries) e.score = Math.round((e.heat / max) * 100);
    return entries.sort((a, b) => b.score - a.score);
  },
};
