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

import { ApiClient } from "./api.js";

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

function pairToRow(p, chainHint) {
  const liq = Number(p?.liquidity?.usd ?? 0);
  const mcap = Number(p?.marketCap ?? 0);
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
    _updatedAt: p.marketAsOf ?? Date.now(),
    source: p.source ?? "dexscreener",
    status: p.marketStatus ?? "LIVE",
    pairAddress: p.pairAddress ?? null,
  };
}

export const DexFeed = {
  cacheKey: "trenches_market_cache_v3",
  cacheTtlMs: 300000,
  cache: {},
  cacheUpdatedAt: 0,

  _key(chain, address) {
    return chain + ":" + (/^0x/i.test(address) ? address.toLowerCase() : address);
  },
  _loadStored() {
    try {
      const stored = JSON.parse(localStorage.getItem(this.cacheKey) || "{}");
      this.cache = stored.entries || {};
      this.cacheUpdatedAt = stored._updatedAt || 0;
    } catch {}
  },
  _persist() {
    try { localStorage.setItem(this.cacheKey, JSON.stringify({ _updatedAt: Date.now(), entries: this.cache })); } catch {}
  },
  isFresh() { return Date.now() - this.cacheUpdatedAt < 30000; },
  get(key, chain) {
    if (!this.cacheUpdatedAt) this._loadStored();
    if (!key) return null;
    const matches = Object.values(this.cache).filter((row) => {
      if (!row || Date.now() - row._updatedAt > this.cacheTtlMs || (chain && row.chain !== chain)) return false;
      const addressMatch = /^0x/i.test(String(key))
        ? String(row.address).toLowerCase() === String(key).toLowerCase()
        : row.address === key;
      return addressMatch || row.symbol === String(key).toUpperCase();
    });
    return matches.length === 1 ? matches[0] : null;
  },
  _put(row) {
    if (!row?.address || !row.chain) return;
    this.cache[this._key(row.chain, row.address)] = row;
    this.cacheUpdatedAt = Date.now();
    const keys = Object.keys(this.cache);
    if (keys.length > 1000) delete this.cache[keys[0]];
  },
  _rows(pairs) {
    const best = new Map();
    for (const pair of pairs || []) {
      if (!pair?.baseToken?.address || !pair.chainId) continue;
      const row = pairToRow(pair);
      const key = this._key(row.chain, row.address);
      if (!best.has(key) || row.liqUsd > best.get(key).liqUsd) best.set(key, row);
    }
    const rows = [...best.values()];
    for (const row of rows) this._put(row);
    this._persist();
    return rows;
  },
  async search(query, chain) {
    const response = await ApiClient.request("/api/market/search?q=" + encodeURIComponent(query) +
      (chain ? "&chain=" + encodeURIComponent(chain) : ""));
    return this._rows(response.pairs);
  },
  async ensureTokens(refs, { force = false } = {}) {
    const addresses = (refs || []).filter((ref) => ref.address);
    await this.ensureAddresses(addresses, { force });
    for (const ref of refs || []) {
      if (ref.address || !ref.symbol || (!force && this.get(ref.symbol, ref.chain))) continue;
      try { await this.search(ref.symbol, ref.chain); } catch {}
    }
    return this.cache;
  },
  async ensureAddresses(refs, { force = false } = {}) {
    const grouped = new Map();
    for (const ref of refs || []) {
      if (!ref.address || !ref.chain || (!force && this.get(ref.address, ref.chain))) continue;
      const batch = grouped.get(ref.chain) || new Set();
      batch.add(ref.address);
      grouped.set(ref.chain, batch);
    }
    for (const [chain, set] of grouped) {
      const addresses = [...set];
      for (let i = 0; i < addresses.length; i += 30) {
        try {
          const response = await ApiClient.request("/api/market/tokens/" + encodeURIComponent(chain) + "/" +
            addresses.slice(i, i + 30).map(encodeURIComponent).join(","));
          this._rows(response.pairs);
        } catch {}
      }
    }
    return this.cache;
  },
  async refresh(refs) { return this.ensureTokens(refs, { force: true }); },
  socialsFor(key, chain) { return this.get(key, chain)?.socials || {}; },
  async getTrending({ chains = [], limit = 60, page = 1, kind = "trending" } = {}) {
    const response = await ApiClient.request("/api/market/pools?kind=" + encodeURIComponent(kind) + "&page=" + page);
    return this._rows(response.pairs).filter((row) => !chains.length || chains.includes(row.chain)).slice(0, limit);
  },

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

  get(address, chain) {
    if (!address) return null;
    const hit = this.cache[chain + ":" + (/^0x/i.test(address) ? address.toLowerCase() : address)];
    if (hit && Date.now() - hit._at < this.ttlMs) return hit.v;
    return null;
  },

  /** Fetch security info for one address. Returns cached instantly when warm. */
  async fetch(address, chain) {
    const addr = String(address ?? "").trim();
    if (!addr) return null;
    const key = chain + ":" + (/^0x/i.test(addr) ? addr.toLowerCase() : addr);
    const cached = this.cache[key];
    if (cached && Date.now() - cached._at < this.ttlMs) return cached.v;
    if (this._inflight.has(key)) return this._inflight.get(key);

    const chainId = String(chain ?? "solana").toLowerCase();
    const p = (chainId === "solana" ? this._rugcheck(addr) : this._goplus(addr, chainId))
      .then((v) => { this.cache[key] = { v, _at: Date.now() }; return v; })
      .catch(() => { this.cache[key] = { v: null, _at: Date.now() }; return null; })
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
      if (k) out[k] = this.get(r.address, r.chain);
    }
    return out;
  },

  /**
   * RugCheck: /api/v2/tokens/{mint}/risk — score is 0..100+ (lower better);
   * they also expose a discrete level. We normalize to good/warn/bad.
   */
  async _rugcheck(mint) {
    const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${encodeURIComponent(mint)}/report/summary`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    if (!j || typeof j !== "object") return null;
    if (!Number.isFinite(j.score_normalised) || !Array.isArray(j.risks)) return null;
    const score = j.score_normalised;
    const lvl = String(j.level ?? "").toLowerCase();
    const level = lvl === "danger" || j.risks.some((r) => r.level === "danger") || score >= 75 ? "bad"
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
    if (!d || !["0", "1"].includes(d.is_honeypot) || d.buy_tax == null || d.sell_tax == null) return null;
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
