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
const DEX_BOOSTS_URL = "https://api.dexscreener.com/token-boosts/top/v1";
const DEX_BATCH_URL = "https://api.dexscreener.com/tokens/v1/";

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

/** GoPlus chain ids for token-security lookups (EVM only). */
const GOPUS_CHAIN_IDS = { ethereum: 1, bsc: 56, base: 8453, polygon: 137, arbitrum: 42161 };

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
    createdAtMs: Number(p.pairCreatedAt ?? 0),
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
   * REAL MARKET TOKENS — what's hot on DEXs right now, independent of our
   * launchpad. Source: DexScreener's public token-boosts top feed (organic
   * promotion spend = attention), then batch-resolve full pair data per chain
   * via /tokens/v1 (30 addresses per call, 1 request per chain).
   * Returns rows shaped exactly like pairToRow, ranked by 24h volume.
   */
  async getTrending({ chains = ["solana"], limit = 24 } = {}) {
    try {
      const res = await fetch(DEX_BOOSTS_URL, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) return [];
      const boosts = await res.json();
      if (!Array.isArray(boosts)) return [];

      // Group boosted addresses by chain (only chains we can trade).
      const byChain = new Map();
      for (const b of boosts) {
        const chainId = String(b?.chainId ?? "").toLowerCase();
        const addr = String(b?.tokenAddress ?? "");
        if (!chains.includes(chainId) || !addr) continue;
        const acc = byChain.get(chainId) ?? [];
        if (acc.length < 30) acc.push(addr); // batch endpoint cap
        byChain.set(chainId, acc);
      }

      const rows = [];
      for (const [chainId, addrs] of byChain) {
        try {
          const r = await fetch(DEX_BATCH_URL + chainId + "/" + addrs.join(","), {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(10000),
          });
          if (!r.ok) continue;
          const pairs = await r.json();
          if (!Array.isArray(pairs)) continue;

          // Keep the deepest pair per base address, then rank by 24h volume.
          const best = new Map();
          for (const p of pairs) {
            const base = String(p?.baseToken?.address ?? "").toLowerCase();
            if (!base) continue;
            const cur = best.get(base);
            if (!cur || Number(p?.liquidity?.usd ?? 0) > Number(cur?.liquidity?.usd ?? 0)) best.set(base, p);
          }
          for (const p of best.values()) rows.push(pairToRow(p, chainId));
        } catch {}
      }

      rows.sort((a, b) => (b.vol24h + b.liqUsd * 0.1) - (a.vol24h + a.liqUsd * 0.1));
      for (const row of rows) this._put(row);
      return rows.slice(0, limit);
    } catch {
      return []; // network down — board still shows launchpad + cache
    }
  },

  /**
   * Batch-resolve pair data for explicit addresses (per chain, 30/call).
   * Complements ensureTokens (sequential search) when we already know where
   * to look — e.g. hydrating a whole column at once.
   */
  async ensureAddresses(refs, { force = false } = {}) {
    if (!this.cacheUpdatedAt) this._loadStored();
    const byChain = new Map();
    for (const ref of refs ?? []) {
      const addr = String(ref?.address ?? "").trim();
      const chain = String(ref?.chain ?? "solana").toLowerCase();
      const aliases = CHAIN_ALIASES[chain] ?? [chain];
      if (!addr || !aliases.length) continue;
      if (!force && addr.toLowerCase() in this.cache && this.isFresh()) continue;
      const acc = byChain.get(aliases[0]) ?? [];
      if (acc.length < 30) acc.push(addr); // batch endpoint cap
      byChain.set(aliases[0], acc);
    }
    for (const [chainId, addrs] of byChain) {
      try {
        const r = await fetch(DEX_BATCH_URL + chainId + "/" + addrs.join(","), {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) continue;
        const pairs = await r.json();
        if (!Array.isArray(pairs)) continue;
        for (const p of pairs) {
          const row = pairToRow(p, chainId);
          if (row?.address) this.cache[row.address.toLowerCase()] = row;
          this._put(row);
        }
      } catch {}
    }
    if (byChain.size) {
      this.cacheUpdatedAt = Date.now();
      this._persist();
    }
    return this.cache;
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

/**
 * 🛡️ SECURITY FEED — token risk checks from public, keyless providers.
 *   • Solana → RugCheck.xyz API (rugged/low risk signals, mint authority,
 *     liquidity locked, top-10 holder concentration).
 *   • EVM (Ethereum/BSC/Base/Polygon/Arbitrum) → GoPlus token security API
 *     (honeypot, buy/sell tax, owner/mint privileges, LP holders).
 * Honest rules: unknown chain/address → null (renders as no badge, never as
 * "safe"). Results cached in-memory for the session (30 min).
 */
export const SecurityFeed = {
  cache: {},           // address(lower) → { level, label, title, detail } | null
  ttlMs: 30 * 60 * 1000,
  _inflight: new Map(),

  get(address) {
    if (!address) return null;
    const hit = this.cache[String(address).toLowerCase()];
    if (hit && Date.now() - hit._at < this.ttlMs) return hit.v;
    return null;
  },

  /** Fetch security info for one address. Returns cached instantly when warm. */
  async fetch(address, chain) {
    const addr = String(address ?? "").trim();
    if (!addr) return null;
    const key = addr.toLowerCase();
    const cached = this.cache[key];
    if (cached && Date.now() - cached._at < this.ttlMs) return cached.v;
    if (this._inflight.has(key)) return this._inflight.get(key);

    const chainId = String(chain ?? "solana").toLowerCase();
    const p = (chainId === "solana" ? this._rugcheck(addr) : this._goplus(addr, chainId))
      .then((v) => { this.cache[key] = { v, _at: Date.now() }; return v; })
      .catch(() => null)
      .finally(() => this._inflight.delete(key));
    this._inflight.set(key, p);
    return p;
  },

  /** Batch: resolve many and return a map address → result. */
  async fetchMany(refs) {
    await Promise.allSettled((refs ?? []).map((r) => this.fetch(r.address, r.chain)));
    const out = {};
    for (const r of refs ?? []) {
      const k = String(r.address ?? "").toLowerCase();
      if (k) out[k] = this.cache[k]?.v ?? null;
    }
    return out;
  },

  /**
   * RugCheck: /api/v2/tokens/{mint}/risk — score is 0..100+ (lower better);
   * they also expose a discrete level. We normalize to good/warn/bad.
   */
  async _rugcheck(mint) {
    const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${encodeURIComponent(mint)}/risk`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    if (!j || typeof j !== "object") return null;
    const score = Number(j.score_normalised ?? j.score ?? 0);
    const lvl = String(j.level ?? "").toLowerCase();
    const level = lvl === "danger" || score >= 75 ? "bad"
      : lvl === "warn" || score >= 35 ? "warn"
      : "good";
    const dangers = (j.risks ?? []).filter((r) => String(r.level ?? "").toLowerCase() === "danger").slice(0, 2).map((r) => r.name);
    return {
      level,
      score,
      provider: "rugcheck",
      label: level === "good" ? "RISK LOW" : level === "warn" ? "RISK MED" : "RISK HIGH",
      title: dangers.length ? dangers.join(" · ") : `RugCheck score ${score}`,
      detail: (j.risks ?? []).length + " señales",
    };
  },

  /** GoPlus: public token security endpoint, no key for low QPS. */
  async _goplus(address, chain) {
    const cid = GOPUS_CHAIN_IDS[chain];
    if (!cid) return null;
    const res = await fetch(`https://api.gopluslabs.io/api/v1/token_security/${cid}?contract_addresses=${encodeURIComponent(address)}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const d = j?.result?.[String(address).toLowerCase()];
    if (!d) return null;
    const honeypot = String(d.is_honeypot ?? "0") === "1";
    const canMint = String(d.is_mintable ?? "0") === "1";
    const ownerPriv = String(d.owner_address ?? "") !== "" && String(d.owner_address ?? "") !== "0x0000000000000000000000000000000000000000";
    const buyTax = Number(d.buy_tax ?? 0) * 100;
    const sellTax = Number(d.sell_tax ?? 0) * 100;
    const level = honeypot || buyTax >= 20 || sellTax >= 20 ? "bad"
      : canMint || buyTax >= 5 || sellTax >= 5 ? "warn"
      : "good";
    const flags = [
      honeypot ? "HONEYPOT" : null,
      canMint ? "MINTABLE" : null,
      buyTax >= 5 ? `BUY ${buyTax.toFixed(0)}%` : null,
      sellTax >= 5 ? `SELL ${sellTax.toFixed(0)}%` : null,
      ownerPriv ? "OWNER PRIV" : null,
    ].filter(Boolean);
    return {
      level,
      score: honeypot ? 100 : Math.min(99, buyTax + sellTax + (canMint ? 25 : 0)),
      provider: "goplus",
      label: level === "good" ? "RISK LOW" : level === "warn" ? "RISK MED" : "RISK HIGH",
      title: flags.length ? flags.join(" · ") : "GoPlus: sin señales",
      detail: flags.length + " flags",
    };
  },
};
