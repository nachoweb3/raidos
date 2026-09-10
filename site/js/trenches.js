/**
 * ⚡ TRENCHES ENGINE — Photon-style multi-column memecoin terminal.
 *
 * Three live scan columns over the real launchpad feed:
 *   • NEW       — newest launches still on the bonding curve
 *   • SOON      — pre-graduation tokens ranked by raised progress
 *   • MIGRATED  — tokens that graduated to a DEX (status = "graduated")
 *
 * Every row carries REAL data only: launchpad stats (mcap, raised, buyers,
 * progress, socials) enriched with DexScreener pair data when the token is
 * listed (price, 24h change, liquidity, txns). Clicking a row selects it and
 * loads it into the execution terminal (TradingEngine); ⚡ buys 0.1 USDC
 * instantly through the bonding-curve / swap path.
 *
 * SSE-first: follows the /api/feed/stream for new launches and swaps so the
 * board updates itself; polling is the fallback.
 */

import { ApiClient, API_BASE } from "./api.js";
import { TokenMeta } from "./tokens.js";
import { DexFeed, SecurityFeed } from "./dexfeed.js";

const COLUMNS = [
  { id: "new", title: "New Pairs", icon: "🔥", hint: "Mercado real — DexScreener" },
  { id: "soon", title: "Soon", icon: "🚀", hint: "Curva de graduación" },
  { id: "migrated", title: "Trending", icon: "📈", hint: "Top volumen 24h" },
];

/** Chain aliases for the market columns (DexScreener chainIds). */
const MARKET_CHAINS = ["solana", "bsc"];
const MARKET_LIMIT = 24;

/** Micro-USDC → display string, honest "—" for zero/invalid. */
const fmtMicro = (raw, digits = 2) => {
  const n = Number(raw ?? 0) / 1e6;
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1_000_000) return "$" + (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return "$" + (n / 1_000).toFixed(1) + "K";
  return "$" + n.toFixed(digits);
};

/** USD amount → compact display, honest "—" for zero/invalid. */
const fmtUsd = (n) => {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1_000_000) return "$" + (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return "$" + (n / 1_000).toFixed(1) + "K";
  return "$" + n.toFixed(2);
};

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);

const safeAttr = (s) => String(s ?? "").replace(/[^a-zA-Z0-9_@.\\-]/g, "");

export const TrenchesEngine = {
  tokens: [],            // normalized launch rows (our launchpad)
  market: [],            // real market tokens (DexScreener trending)
  selected: null,        // currently selected token ref
  search: "",
  loading: false,
  loadedOnce: false,
  _es: null,             // EventSource
  _pollTimer: null,
  _seq: 0,
  _marketAt: 0,

  async init() {
    if (this.loadedOnce) return;
    this.load();
    this.loadMarket();
    this.connectStream();
    // Market refresh every 2 minutes (boosts feed changes constantly).
    setInterval(() => { if (document.visibilityState === "visible") this.loadMarket(true); }, 120_000);
    // ⏱ LIVE TICKING: re-render deltas every 5s from cached pair data and
    // re-pull pairs every 60s — rows breathe without hammering the API.
    setInterval(() => {
      if (document.visibilityState === "visible" && this.loadedOnce) {
        this._tick();
      }
    }, 5_000);
    setInterval(() => {
      if (document.visibilityState === "visible") this.refreshPairs();
    }, 60_000);
  },

  /**
   * Lightweight tick: refresh only prices/changes from the DexFeed cache and
   * patch the DOM in place (no full re-render → selection and scroll survive).
   */
  _tick() {
    let changed = false;
    for (const t of this.allTokens()) {
      const row = t.tokenAddress ? DexFeed.get(t.tokenAddress) : DexFeed.get(t.symbol);
      if (!row) continue;
      if (row.priceUsd > 0 && row.priceUsd !== t.priceUsd) {
        t.priceUsd = row.priceUsd;
        changed = true;
      }
      if (t.dex && row._updatedAt !== t.dex._updatedAt) t.dex = row;
      if (row.mcap > 0) t.mcapUsd = row.mcap;
    }
    if (changed) this.render();
  },

  /** Force-refresh DexScreener pair data for every address on the board. */
  async refreshPairs() {
    const refs = [
      ...this.tokens.filter((t) => t.tokenAddress).map((t) => ({ address: t.tokenAddress, chain: t.chain })),
      ...this.market.filter((t) => t.tokenAddress).map((t) => ({ address: t.tokenAddress, chain: t.chain })),
    ];
    if (!refs.length) return;
    await DexFeed.ensureAddresses(refs, { force: true }).catch(() => {});
    this._tick();
  },

  /**
   * REAL MARKET TOKENS — always populated from DexScreener trending,
   * regardless of our launchpad. This is what makes the board feel alive on
   * a fresh install: Solana + BSC pairs with real price, mcap, volume, liq.
   */
  async loadMarket(force = false) {
    const seq = this._seq;
    try {
      const rows = await DexFeed.getTrending({ chains: MARKET_CHAINS, limit: MARKET_LIMIT });
      if (seq !== this._seq && force) return;
      this.market = rows.map((r) => this.normalizeMarket(r));
      this._marketAt = Date.now();
      if (this.loadedOnce) {
        this.render();
        this.loadSecurity();
      }
    } catch {}
  },

  /** Apply freshly resolved pair rows onto launch tokens and re-render. */
  _applyDexRows(list) {
    for (const t of list) {
      if (!t.tokenAddress) continue;
      const row = DexFeed.get(t.tokenAddress);
      if (!row) continue;
      t.dex = row;
      if (row.priceUsd > 0) t.priceUsd = row.priceUsd;
      if (row.mcap > 0) t.mcapUsd = row.mcap;
      if (row.socials) t.socials = { ...t.socials, ...row.socials };
      if (row.logo) t.imageUrl = t.imageUrl || row.logo;
    }
    this.render();
  },

  /** 🛡️ Security checks (RugCheck/GoPlus) for every known address. */
  async loadSecurity() {
    const seen = new Map();
    for (const t of this.allTokens()) {
      if (!t.tokenAddress || seen.has(t.tokenAddress)) continue;
      seen.set(t.tokenAddress, { address: t.tokenAddress, chain: t.chain });
    }
    if (!seen.size) return;
    const results = await SecurityFeed.fetchMany([...seen.values()]).catch(() => ({}));
    let any = false;
    for (const t of this.allTokens()) {
      const sec = results[String(t.tokenAddress ?? "").toLowerCase()];
      if (sec && sec !== t.security) { t.security = sec; any = true; }
    }
    if (any) this.render();
  },

  /** Badge html for a token's security verdict (empty when unknown). */
  securityBadge(t) {
    const s = t.security;
    if (!s) return "";
    const color = s.level === "good" ? "var(--delta-green)" : s.level === "warn" ? "#fde047" : "var(--delta-red)";
    const title = esc(s.title ?? s.label ?? "");
    return `<span title="🛡️ ${title}" style="font-size:8.5px; font-weight:800; letter-spacing:0.4px; color:${color}; border:1px solid ${color}; border-radius:4px; padding:0 4px; line-height:13px; opacity:0.9">🛡️ ${s.level === "good" ? "OK" : s.level === "warn" ? "MED" : "HIGH"}</span>`;
  },

  normalizeMarket(r) {
    return {
      id: "mkt_" + (r.address || r.symbol),
      symbol: r.symbol || "???",
      name: r.name || r.symbol,
      chain: r.chain || "solana",
      imageUrl: r.logo,
      status: "market",
      priceUsd: r.priceUsd,
      mcapUsd: r.mcap || r.fdv || 0,
      raisedUsd: 0,
      buyers: r.buys24h || 0,
      progress: 0,
      socials: r.socials ?? {},
      tokenAddress: r.address,
      createdAt: r.createdAtMs ? Math.floor(r.createdAtMs / 1000) : 0,
      dex: r,
      isMarket: true,
    };
  },

  /** Fetch launches (all statuses) and normalize into one board. */
  async load(force = false) {
    if (this.loading) return;
    this.loading = true;
    if (!this.loadedOnce) this.renderSkeleton();
    const seq = ++this._seq;
    try {
      const data = await ApiClient.getLaunches({ limit: 100 });
      if (seq !== this._seq) return;
      const launches = data?.launches ?? [];
      this.tokens = launches.map((l) => this.normalize(l));
      this.loadedOnce = true;
      this.render();
      this.enrichDex(); // async — upgrades rows with pair data when it lands
      // Hydrate launchpad pairs in one batch per chain (real liq/txns fast).
      DexFeed.ensureAddresses(
        this.tokens.filter((t) => t.tokenAddress).map((t) => ({ address: t.tokenAddress, chain: t.chain })),
      ).then(() => {
        this._applyDexRows(this.tokens);
        this.loadSecurity();
      }).catch(() => {});
    } catch (err) {
      if (seq === this._seq) this.renderError(String(err?.message || err));
    } finally {
      this.loading = false;
    }
  },

  normalize(l) {
    return {
      id: l.id,
      symbol: String(l.symbol ?? "").toUpperCase(),
      name: l.name ?? l.symbol,
      chain: l.chain ?? "solana",
      imageUrl: l.imageUrl || null,
      status: l.status ?? "created",
      priceUsd: Number(l.currentPriceUsdc ?? 0) / 1e6,
      mcapUsd: Number(l.marketCapUsdc ?? 0) / 1e6,
      raisedUsd: Number(l.raisedUsdc ?? 0) / 1e6,
      buyers: Number(l.buyersCount ?? 0),
      progress: Math.min(100, Number(l.progressPct ?? 0)),
      socials: {
        ...(l.twitterUrl ? { twitter: l.twitterUrl } : {}),
        ...(l.telegramUrl ? { telegram: l.telegramUrl } : {}),
        ...(l.websiteUrl ? { website: l.websiteUrl } : {}),
      },
      tokenAddress: l.tokenAddress ?? null,
      createdAt: Number(l.createdAt ?? 0),
      dex: null,
    };
  },

  /** DexScreener enrichment for graduated tokens with a real address. */
  async enrichDex() {
    const refs = this.tokens
      .filter((t) => t.tokenAddress)
      .map((t) => ({ symbol: t.symbol, address: t.tokenAddress, chain: t.chain }));
    if (!refs.length) return;
    try {
      await DexFeed.ensureTokens(refs);
      for (const t of this.tokens) {
        const row = DexFeed.get(t.tokenAddress);
        if (!row) continue;
        t.dex = row;
        if (row.priceUsd > 0) t.priceUsd = row.priceUsd;
        if (row.mcap > 0) t.mcapUsd = row.mcap;
        if (row.socials) t.socials = { ...t.socials, ...row.socials };
        if (row.logo) t.imageUrl = t.imageUrl || row.logo;
      }
      this.render();
    } catch {}
  },

  /* ── Live stream (SSE with polling fallback) ────────────────────────── */

  connectStream() {
    try {
      // SSE endpoint is public; api.js only prefixes relative paths.
      const url = API_BASE + "/api/feed/stream";
      if (url && typeof EventSource !== "undefined") {
        this._es = new EventSource(url);
        this._es.onmessage = (ev) => {
          try {
            const evt = JSON.parse(ev.data);
            if (evt?.type === "launch" || evt?.type === "swap") this._nudge();
          } catch {}
        };
        this._es.onerror = () => {
          // EventSource retries on its own; keep polling as safety net.
          this._startPolling();
        };
        return;
      }
    } catch {}
    this._startPolling();
  },

  _startPolling() {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(() => {
      if (document.visibilityState === "visible") this._nudge();
    }, 20_000);
  },

  /** Refresh at most once per 10s from stream bursts. */
  async _nudge() {
    const now = Date.now();
    if (this._lastNudge && now - this._lastNudge < 10_000) return;
    this._lastNudge = now;
    this.load();
  },

  /* ── Selection → execution terminal ─────────────────────────────────── */

  select(t) {
    this.selected = t;
    window.TradingEngine?.setAsset(t.symbol, t.chain, t.priceUsd || 0, {
      tokenAddress: t.tokenAddress ?? undefined,
      launchId: t.isMarket ? undefined : t.id,
    });
    this.render();
  },

  /** ⚡ quick buy: 0.1 USDC — bonding curve for launches, DEX swap for market. */
  async quickBuy(symbol, id, event) {
    event?.stopPropagation();
    const t = this.allTokens().find((x) => x.symbol === symbol && String(x.id) === String(id));
    if (!t) return;
    if (!ApiClient.isAuthenticated?.()) {
      window.App?.openWalletModal?.();
      return;
    }
    try {
      const usdcMicro = "100000"; // 0.1 USDC
      if (t.isMarket || t.status === "graduated") {
        // Real DEX swap routed by address via the execution terminal.
        await window.TradingEngine?.quickMarketBuy?.(t);
        return;
      }
      const res = await ApiClient.buyLaunchTokens(t.id, usdcMicro);
      const got = res?.result?.tokenAmount;
      alert(`⚡ Comprado ${t.symbol}: ${Number(got ?? 0).toLocaleString("en-US", { maximumFractionDigits: 0 })} tokens por 0.1 USDC`);
      this.load();
    } catch (err) {
      alert("❌ " + String(err?.message || err));
    }
  },

  /* ── Rendering ──────────────────────────────────────────────────────── */

  target() {
    return document.getElementById("trenchesColumns");
  },

  visibleIn(columnId, t) {
    if (this.search && !(`${t.name} ${t.symbol}`.toLowerCase().includes(this.search))) return false;
    if (columnId === "soon") return t.status !== "graduated" && t.status !== "market" && t.progress >= 40;
    if (columnId === "migrated") {
      // TRENDING: market tokens ranked by volume; launchpad graduates join by mcap.
      return t.isMarket || t.status === "graduated";
    }
    if (columnId === "new") {
      // NEW PAIRS: real market pairs < 48h first, then our own launches.
      return true;
    }
    return true;
  },

  sortFor(columnId, list) {
    if (columnId === "soon") return list.sort((a, b) => b.progress - a.progress || b.raisedUsd - a.raisedUsd);
    if (columnId === "new") {
      // freshest real pairs first; our launches interleaved by age
      return list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    }
    // Trending: market tokens already ranked; sort all by volume when known.
    return list.sort((a, b) => (b.dex?.vol24h ?? 0) - (a.dex?.vol24h ?? 0) || b.mcapUsd - a.mcapUsd);
  },

  renderSkeleton() {
    const el = this.target();
    if (!el) return;
    el.innerHTML = COLUMNS.map(
      (c) => `
      <div class="trenches-col">
        <div style="padding:10px 12px; font-size:12px; font-weight:800; border-bottom:1px solid var(--border-subtle)">${c.icon} ${c.title}</div>
        <div class="trenches-col-scroll" style="padding:14px; color:var(--text-tertiary); font-size:12px">
          <div class="soft-pulse" style="display:flex; align-items:center; gap:8px">⚡ Cargando trenches…</div>
        </div>
      </div>`
    ).join("");
  },

  renderError(msg) {
    const el = this.target();
    if (!el) return;
    el.innerHTML = `
      <div class="trenches-col" style="grid-column:1 / -1">
        <div style="padding:26px; text-align:center; color:var(--text-tertiary); font-size:12.5px">
          No se pudo cargar el board: ${esc(msg)}
          <div style="margin-top:10px"><button class="btn btn-secondary btn-sm" onclick="window.TrenchesEngine.load(true)">Reintentar</button></div>
        </div>
      </div>`;
  },

  render() {
    const el = this.target();
    if (!el) return;
    const total = this.tokens.length + this.market.length;
    const countEl = document.getElementById("trenchesCount");
    if (countEl) countEl.textContent = `${total} tokens`;

    el.innerHTML = COLUMNS.map((c) => {
      let pool;
      if (c.id === "new") {
        // Real market pairs < 48h first, then our launchpad launches, then the rest.
        const freshMarket = this.market.filter((t) => t.createdAt && Date.now() / 1000 - t.createdAt < 48 * 3600);
        const restMarket = this.market.filter((t) => !t.createdAt || Date.now() / 1000 - t.createdAt >= 48 * 3600);
        pool = [...freshMarket, ...this.tokens, ...restMarket];
      } else if (c.id === "migrated") {
        pool = [...this.market, ...this.tokens.filter((t) => t.status === "graduated")];
      } else {
        pool = this.tokens.filter((t) => this.visibleIn(c.id, t));
      }
      const rows = this.sortFor(c.id, pool).slice(0, 30);
      const rowsHtml = rows.length
        ? rows.map((t) => this.renderRow(t)).join("")
        : `<div style="padding:22px 14px; text-align:center; color:var(--text-tertiary); font-size:11.5px">
             ${c.id === "soon" ? "Ningún token cerca de graduar todavía." : "Conectando con DexScreener…"}
           </div>`;
      return `
      <div class="trenches-col">
        <div style="display:flex; align-items:center; justify-content:space-between; padding:10px 12px; border-bottom:1px solid var(--border-subtle)">
          <div style="font-size:12.5px; font-weight:800">${c.icon} ${c.title} <span style="font-weight:400; color:var(--text-tertiary); font-size:10.5px">· ${c.hint}</span></div>
          <span class="brand-badge" style="font-size:9px">${rows.length}</span>
        </div>
        <div class="trenches-col-scroll">${rowsHtml}</div>
      </div>`;
    }).join("");
  },

  renderRow(t) {
    const isSel = this.selected?.symbol === t.symbol && this.selected?.id === t.id;
    const chg = t.dex?.change24h ?? null;
    const chgCls = chg == null ? "" : chg >= 0 ? "up" : "down";
    const price = t.priceUsd > 0 ? (t.priceUsd < 0.01 ? "$" + t.priceUsd.toFixed(6) : "$" + t.priceUsd.toPrecision(4)) : "—";
    const socialIcons = [
      t.socials?.twitter ? `<a href="${esc(t.socials.twitter)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" title="X" style="color:var(--text-tertiary); text-decoration:none; font-size:10.5px">𝕏</a>` : "",
      t.socials?.telegram ? `<a href="${esc(t.socials.telegram)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" title="Telegram" style="color:var(--text-tertiary); text-decoration:none; font-size:10.5px">✈</a>` : "",
      t.socials?.website ? `<a href="${esc(t.socials.website)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" title="Web" style="color:var(--text-tertiary); text-decoration:none; font-size:10px">🌐</a>` : "",
    ].join("");
    const age = t.createdAt ? this.ageLabel(t.createdAt) : "";
    const idAttr = t.isMarket ? safeAttr(t.id) : String(Number(t.id));
    const symAttr = safeAttr(t.symbol);
    const addrAttr = safeAttr(t.tokenAddress ?? "");
    return `
      <div class="trench-row ${isSel ? "selected" : ""}" onclick="window.TrenchesEngine.selectById('${symAttr}', '${idAttr}')">
        ${TokenMeta.logoHtml(t.symbol, { size: 34, round: false, imageUrl: t.imageUrl })}
        <div style="flex:1; min-width:0">
          <div style="display:flex; align-items:center; gap:6px; min-width:0">
            <strong style="font-size:12px; color:#fff; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${esc(t.symbol)}</strong>
            ${this.securityBadge(t)}
            <span style="font-size:10px; color:var(--text-tertiary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${esc(String(t.name).slice(0, 18))}</span>
            ${socialIcons}
          </div>
          <div class="trench-stats">
            <span>👥 ${t.buyers}</span>
            <span>💰 ${fmtUsd(t.mcapUsd)}</span>
            ${t.progress > 0 ? `<span>${t.progress}%</span>` : ""}
            ${age ? `<span>${age}</span>` : ""}
            ${t.dex ? `<span>💧 ${fmtMicro(t.dex.liqUsd)}</span><span>🔁 ${t.dex.txns24h || 0}</span>` : ""}
          </div>
          ${t.progress > 0 ? `
          <div style="margin-top:5px; height:3px; border-radius:2px; background:rgba(255,255,255,0.06); overflow:hidden">
            <div style="height:100%; width:${t.progress}%; background:linear-gradient(90deg, var(--delta-green), #fde047)"></div>
          </div>` : ""}
        </div>
        <div style="display:flex; flex-direction:column; align-items:flex-end; gap:4px">
          <div class="trench-metric">
            <div style="color:#fff">${price}</div>
            ${chg != null ? `<div class="${chgCls}">${chg >= 0 ? "+" : ""}${chg.toFixed(1)}%</div>` : `<div style="color:var(--text-tertiary)">${esc(t.chain.slice(0, 3).toUpperCase())}</div>`}
          </div>
          <div style="display:flex; flex-direction:column; gap:4px; align-items:flex-end">
            <button class="trench-buy-btn" onclick="window.TrenchesEngine.quickBuy('${symAttr}', '${idAttr}', event)" title="Compra rápida 0.1 USDC">⚡ 0.1</button>
            <button class="trench-thesis-btn" onclick="window.TrenchesEngine.postThesis('${symAttr}', '${idAttr}', event)" title="Publicar tesis sobre este token">📊 Tesis</button>
          </div>
        </div>
      </div>`;
  },

  selectById(symbol, id) {
    const t = this.allTokens().find((x) => x.symbol === symbol && String(x.id) === String(id));
    if (t) this.select(t);
  },

  /** Launchpad + market rows in one lookup pool. */
  allTokens() {
    return [...this.tokens, ...this.market];
  },

  /** Open the thesis composer pre-filled with this token's live context. */
  postThesis(symbol, id, event) {
    event?.stopPropagation();
    const t = this.allTokens().find((x) => x.symbol === symbol && String(x.id) === String(id));
    if (!t) return;
    window.App?.openNewPostModal({
      token: t.tokenAddress || t.symbol,
      symbol: t.symbol,
      chain: t.chain,
      price: t.priceUsd,
      launchId: !t.isMarket && t.status !== "graduated" ? t.id : undefined,
      imageUrl: t.imageUrl,
    });
  },

  ageLabel(createdAt) {
    const s = Math.max(0, Math.floor(Date.now() / 1000) - createdAt);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
  },

  setSearch(q) {
    this.search = q.toLowerCase().trim();
    this.render();
  },
};
