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
import { DexFeed, SecurityFeed } from "./dexfeed.js?v=20260928-6";
import { CatalogBoard } from "./catalog-board.js?v=20260928-6";

const COLUMNS = [
  { id: "new", title: "Nuevas Creaciones", icon: "+", hint: "Pools de menos de 48 h" },
  { id: "soon", title: "Mayor liquidez", icon: "~", hint: "Mayor liquidez indexada" },
  { id: "migrated", title: "Mayor volumen", icon: "/", hint: "Volumen de 24 h" },
];

/** Chain aliases for the market columns (DexScreener chainIds). */
const MARKET_CHAINS = [];
const MARKET_LIMIT = 60;

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
  activeChain: "all",
  loading: false,
  loadedOnce: false,
  _es: null,             // EventSource
  _pollTimer: null,
  _seq: 0,
  _marketAt: 0,

  async init() {
    if (this._initialized) return;
    this._initialized = true;
    this._board = new CatalogBoard(this);
    this.load();
    this.loadMarket();
    this.loadTraders();
    this.connectStream();
    // Bundle + creator analytics for visible rows (server returns 503 without
    // HELIUS_RPC_URL; the chips stay honest N/D and we back off).
    this.loadOnchainRisk().catch(() => {});
    // Market refresh every 2 minutes (boosts feed changes constantly).
    setInterval(() => { if (document.visibilityState === "visible") this.loadMarket(true); }, 120_000);
    // Security badges re-fetch every ~5 min so 🛡️ labels track RugCheck/GoPlus.
    setInterval(() => { if (document.visibilityState === "visible") this.scheduleRiskLoad(); }, 30_000);
    // Bundle/creator analytics for rows that appeared after init (bounded: 3
    // tokens per pass, 5-min server cache; a 503 backs off inside the loader).
    setInterval(() => { if (document.visibilityState === "visible") this.loadOnchainRisk().catch(() => {}); }, 300_000);
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
      const row = t.tokenAddress ? DexFeed.get(t.tokenAddress, t.chain) : DexFeed.get(t.symbol);
      if (!row) continue;
      if (row.priceUsd > 0 && row.priceUsd !== t.priceUsd) {
        t.priceUsd = row.priceUsd;
        changed = true;
      }
      if (t.dex && row._updatedAt !== t.dex._updatedAt) t.dex = row;
      if (row.mcap > 0) t.mcapUsd = row.mcap;
    }
    // GMGN-style row ticking: patch price/mcap in place so catalog columns
    // breathe every 5s without a full re-render (selection and scroll survive).
    if (this._board) {
      const root = this.target();
      if (root) {
        for (const el of root.querySelectorAll(".trench-row[data-token-id]")) {
          const t = this.allTokens().find((x) => String(x.id) === el.getAttribute("data-token-id"));
          if (!t) continue;
          const logo = el.querySelector(".tr-logo");
          if (logo) {
            const trend = this.logoTrend(t);
            for (const cls of ["trend-up", "trend-down", "trend-flat"]) logo.classList.toggle(cls, cls === trend);
            logo.title = this.logoTrendTitle(t);
          }
          if (t.priceUsd > 0) {
            const priceEl = el.querySelector(".tr-price");
            const txt = "$" + (t.priceUsd < 0.02 ? t.priceUsd.toFixed(6) : t.priceUsd.toPrecision(4));
            if (priceEl && priceEl.textContent !== txt) priceEl.textContent = txt;
          }
          if (t.mcapUsd > 0) {
            const mcEl = el.querySelector(".tr-mc b");
            if (mcEl) {
              const txt = fmtUsd(t.mcapUsd);
              if (mcEl.textContent !== txt) mcEl.textContent = txt;
            }
          }
        }
      }
    }
    // Side panel refreshes with live numbers too (cheap re-render, hidden-aware).
    this.updateSidePanel();
    if (changed) this.render();
  },

  /** 🏆 Top traders strip: real PnL ranking from the platform leaderboard. */
  async loadTraders() {
    const el = document.getElementById("trenchesTradersStrip");
    if (!el) return;
    try {
      const data = await ApiClient.getLeaderboard("all", 8);
      const rows = (data?.leaders ?? []).filter((l) => l && (l.display_name || l.x_handle));
      if (!rows.length) {
        el.innerHTML = `<span style="font-size:10.5px; color:var(--text-tertiary)">🏆 Aún no hay traders rankeados — opera para entrar en el ranking.</span>`;
        return;
      }
      el.innerHTML = rows.map((l, i) => {
        const name = String(l.display_name || l.x_handle || "trader").slice(0, 14);
        const pnl = Number(l.total_pnl_usdc ?? 0) / 1e6;
        const wr = Number(l.win_rate ?? 0);
        const pnlCls = pnl >= 0 ? "var(--delta-green)" : "var(--delta-red)";
        return `
        <div title="${esc(name)} · WR ${wr.toFixed(0)}% · ${l.total_trades ?? 0} trades" style="display:flex; align-items:center; gap:6px; background:rgba(255,255,255,0.03); border:1px solid var(--border-subtle); border-radius:999px; padding:3px 10px 3px 4px; white-space:nowrap">
          <span style="font-size:9px; color:var(--text-tertiary); font-weight:800">#${i + 1}</span>
          ${window.TokenMeta ? TokenMeta.avatarHtml(name, { size: 18 }) : ""}
          <span style="font-size:10.5px; font-weight:700; color:#fff">${esc(name)}</span>
          <span style="font-size:10px; font-family:var(--font-mono); color:${pnlCls}">${pnl >= 0 ? "+" : ""}$${Math.abs(pnl) >= 1000 ? (pnl / 1000).toFixed(1) + "K" : pnl.toFixed(0)}</span>
          <span style="font-size:9px; color:var(--text-tertiary)">WR ${wr.toFixed(0)}%</span>
        </div>`;
      }).join("");
    } catch {
      el.innerHTML = "";
    }
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
  async loadMarket(force = false, page = 1) {
    if (this._board) return this._board.refresh();
    const chain = this.activeChain;
    const sequence = this._marketSequence = (this._marketSequence || 0) + 1;
    const chains = chain === "all" ? [] : [chain];
    this.marketStatus = "LOADING";
    const result = await Promise.allSettled([
      DexFeed.getTrending({ chains, limit: MARKET_LIMIT, page, kind: "new" }),
      DexFeed.getTrending({ chains, limit: MARKET_LIMIT, page, kind: "trending" }),
    ]);
    if (sequence !== this._marketSequence || chain !== this.activeChain) return;
    const rows = result.flatMap((entry) => entry.status === "fulfilled" ? entry.value : []);
    if (!rows.length && result.every((entry) => entry.status === "rejected")) {
      this.market = this.market.filter((t) => Date.now() - (t.dex?._updatedAt || 0) <= 300000);
      this.marketStatus = this.market.length ? "DEGRADED" : "UNAVAILABLE";
      this.marketError = "Proveedores de mercado no disponibles. Reintenta en un minuto.";
      if (this.loadedOnce) this.render();
      return;
    }
    this.marketStatus = result.some((r) => r.status === "rejected") || rows.some((r) => r.status === "DEGRADED") ? "DEGRADED" : "LIVE";
    this.marketError = this.marketStatus === "DEGRADED" ? "Cobertura parcial o datos en caché" : "";
    const merged = new Map((page > 1 ? this.market : []).map((row) => [row.id, row]));
    for (const row of rows) {
      const token = this.normalizeMarket(row);
      merged.set(token.id, token);
    }
    this.market = [...merged.values()];
    this._marketPage = page;
    this._marketAt = rows.length ? Math.min(...rows.map((r) => r._updatedAt)) : Date.now();
    if (this.loadedOnce) { this.render(); this.loadSecurity(); this.loadOnchainRisk().catch(() => {}); }
  },

  async loadMoreMarket() {
    if (this._board) return Promise.all(this._board.columns.map((c) => this._board.load(c, true)));
    const page = (this._marketPage || 1) + 1;
    if (page > 10 || this._loadingMore) return;
    this._loadingMore = true;
    try { await this.loadMarket(false, page); } finally { this._loadingMore = false; }
  },

  /** Apply freshly resolved pair rows onto launch tokens and re-render. */
  _applyDexRows(list) {
    for (const t of list) {
      if (!t.tokenAddress) continue;
      const row = DexFeed.get(t.tokenAddress, t.chain);
      if (!row) continue;
      t.dex = row;
      if (row.priceUsd > 0) t.priceUsd = row.priceUsd;
      if (row.mcap > 0) t.mcapUsd = row.mcap;
      if (row.socials) t.socials = { ...t.socials, ...row.socials };
      if (row.logo) t.imageUrl = t.imageUrl || row.logo;
    }
    this.render();
  },

  /** Only enrich rows currently inside their column viewport. */
  visibleRiskTokens() {
    const visible = new Set();
    for (const el of document.querySelectorAll(".trench-row[data-token-id]")) {
      const box = el.getBoundingClientRect();
      const viewport = el.closest("[data-rows]")?.getBoundingClientRect();
      if (box.width > 0 && box.bottom > Math.max(0, viewport?.top ?? 0) &&
          box.top < Math.min(window.innerHeight, viewport?.bottom ?? window.innerHeight)) visible.add(el.dataset.tokenId);
    }
    const seen = new Set();
    return this.allTokens().filter(t => {
      const key = t.chain + ":" + t.tokenAddress;
      if (!t.tokenAddress || !visible.has(String(t.id)) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  },

  scheduleRiskLoad() {
    clearTimeout(this._riskLoadTimer);
    this._riskLoadTimer = setTimeout(() => {
      if (document.visibilityState !== "visible") return;
      this.loadArtwork().catch(() => {});
      this.loadSecurity().catch(() => {});
      this.loadOnchainRisk().catch(() => {});
    }, 200);
  },

  async loadSecurity() {
    if (this._securityLoading) return;
    this._securityRetryAt ||= new Map();
    const targets = this.visibleRiskTokens().filter(t => {
      const address = /^0x/i.test(t.tokenAddress) ? t.tokenAddress.toLowerCase() : t.tokenAddress;
      const hit = SecurityFeed.cache[t.chain + ":" + address];
      return (this._securityRetryAt.get(t.chain + ":" + address) || 0) <= Date.now() &&
        (!hit || Date.now() - hit._at >= SecurityFeed.ttlMs);
    }).slice(0, 4);
    if (!targets.length) return;
    this._securityLoading = true;
    try {
      await Promise.allSettled(targets.map(async t => {
        const address = /^0x/i.test(t.tokenAddress) ? t.tokenAddress.toLowerCase() : t.tokenAddress;
        const key = t.chain + ":" + address;
        if (this._securityRetryAt.size >= 200 && !this._securityRetryAt.has(key)) this._securityRetryAt.delete(this._securityRetryAt.keys().next().value);
        // Provider timestamps can be old even when the request just finished.
        this._securityRetryAt.set(key, Date.now() + 60_000);
        await SecurityFeed.fetch(t.tokenAddress, t.chain);
        this._secVersion = (this._secVersion || 0) + 1;
        this.render();
      }));
    } finally {
      this._securityLoading = false;
      this.scheduleRiskLoad();
    }
  },

  /** Bounded sequential RPC work; one failed mint does not block every row. */
  async loadOnchainRisk() {
    if (this._riskLoading) return;
    this._riskCache ||= new Map();
    this._riskRetryAt ||= new Map();
    const targets = this.visibleRiskTokens().filter(t => {
      const key = t.chain + ":" + t.tokenAddress;
      return t.chain === "solana" && (this._riskCache.get(key)?.expires || 0) <= Date.now() &&
        (this._riskRetryAt.get(key) || 0) <= Date.now();
    }).slice(0, 3);
    if (!targets.length) return;
    this._riskLoading = true;
    try {
      for (const t of targets) {
        const key = t.chain + ":" + t.tokenAddress;
        try {
          const r = await ApiClient.request("/api/market/onchain-risk?chain=solana&address=" + encodeURIComponent(t.tokenAddress));
          if (!r?.bundle || !r?.creator) throw new Error("Risk data unavailable");
          if (this._riskCache.size >= 200 && !this._riskCache.has(key)) this._riskCache.delete(this._riskCache.keys().next().value);
          this._riskCache.set(key, { value: r, expires: Date.now() + 300_000 });
          this._riskRetryAt.delete(key);
          this._riskVersion = (this._riskVersion || 0) + 1;
          this.render();
        } catch {
          if (this._riskRetryAt.size >= 200 && !this._riskRetryAt.has(key)) this._riskRetryAt.delete(this._riskRetryAt.keys().next().value);
          this._riskRetryAt.set(key, Date.now() + 30_000);
        }
      }
    } finally {
      this._riskLoading = false;
      this.scheduleRiskLoad();
    }
  },

  async loadArtwork() {
    if (this._artLoading) return;
    this._artCache ||= new Map();
    const targets = this.visibleRiskTokens().filter(t => {
      const key = t.chain + ":" + t.tokenAddress;
      return !this.riskImage(t) && (!this._artCache.has(key) || this._artCache.get(key).expires <= Date.now());
    }).slice(0, 2);
    if (!targets.length) return;
    this._artLoading = true;
    try {
      for (const t of targets) {
        const key = t.chain + ":" + t.tokenAddress;
        try {
          const art = await ApiClient.request("/api/market/token-art?chain=" + encodeURIComponent(t.chain) + "&address=" + encodeURIComponent(t.tokenAddress));
          if (this._artCache.size >= 300) this._artCache.delete(this._artCache.keys().next().value);
          this._artCache.set(key, { urls: art.imageUrls || [], expires: Date.now() + 3600000 });
          this._secVersion = (this._secVersion || 0) + 1;
          this.render();
        } catch {
          this._artCache.set(key, { urls: [], expires: Date.now() + 60000 });
        }
      }
    } finally { this._artLoading = false; this.scheduleRiskLoad(); }
  },

  riskImages(t) {
    const cached = this._riskCache?.get(t.chain + ":" + t.tokenAddress);
    return [t.imageUrl, (SecurityFeed.get(t.tokenAddress, t.chain) || t.security)?.imageUrl,
      ...(this._artCache?.get(t.chain + ":" + t.tokenAddress)?.urls || []),
      cached && cached.expires > Date.now() ? cached.value.imageUrl : null]
      .filter(Boolean).map(url => TokenMeta.imageUrl ? TokenMeta.imageUrl(url) : url)
      .filter(url => url && !TokenMeta.failedUrls?.has(url));
  },

  logoTrend(t) {
    const change = t.dex?.change5m;
    return typeof change === "number" && Number.isFinite(change) && change !== 0
      ? change > 0 ? "trend-up" : "trend-down" : "trend-flat";
  },

  logoTrendTitle(t) {
    const trend = this.logoTrend(t);
    return trend === "trend-flat" ? "Sin tendencia de precio confirmada en 5 min"
      : (trend === "trend-up" ? "Alcista" : "Bajista") + " en 5 min: " + (t.dex.change5m > 0 ? "+" : "") + t.dex.change5m.toFixed(2) + "%";
  },

  riskImage(t) {
    return this.riskImages(t)[0] || null;
  },

  riskStrip(t) {
    const m = (SecurityFeed.get(t.tokenAddress, t.chain) || t.security)?.metrics || {};
    const cached = this._riskCache?.get(t.chain + ":" + t.tokenAddress);
    const risk = cached && cached.expires > Date.now() ? cached.value : null;
    void this._riskVersion; // re-renders re-evaluate after loadOnchainRisk() bumps it
    const chip = (name, value, title, tone = "") => '<span class="risk-chip '+tone+'" title="'+esc(title)+'">'+name+' <b>'+esc(value == null ? "N/D" : value)+'</b></span>';
    const bundles = chip("Bundles", null, "Sin evidencia confirmada de agrupacion; un tip Jito no demuestra un bundle.");
    const tips = risk ? chip("Tips Jito", risk.bundle.tippedTransactions == null ? null : risk.bundle.tippedTransactions + "/" + risk.bundle.sampleSize + " tx", risk.bundle.note + (risk.bundle.complete === false ? " Muestra incompleta." : "")) : "";
    const deployer = risk?.creator?.creator;
    const creator = deployer || m.creatorAddress;
    const dev = chip(deployer ? "Despliegue" : "Creador", creator ? creator.slice(0, 4) + "..." + creator.slice(-4) : null,
      deployer ? risk.creator.note + " Lanzamientos observados: " + (risk.creator.tokensLaunched ?? "N/D") + " en " + risk.creator.sampleSize + " tx."
      : creator ? "Creador reportado por el proveedor de seguridad: " + creator : "Creador aun no verificado");
    return '<div class="risk-strip" aria-label="Riesgo del token">' +
      bundles + tips + dev +
      chip("Top 10", m.top10Pct == null ? null : Number(m.top10Pct).toFixed(1) + "%", "Porcentaje de las diez mayores cuentas reportadas. Puede incluir pools y custodios.", m.top10Pct >= 40 ? "risk-high" : m.top10Pct >= 20 ? "risk-warn" : "") +
      chip("Holders", m.holders, "Holders reportados por el proveedor de seguridad") +
      chip("Rugs dev", m.creatorRugs == null ? null : m.creatorRugs + "/" + m.creatorTokensObserved, "Rugs detectados entre los tokens reportados del creador. Muestra, no historial completo.", m.creatorRugs > 0 ? "risk-high" : "") +
      chip("Insiders", m.insiderDetections, "Detecciones de insiders en el grafo de RugCheck; no es porcentaje de supply") +
      chip("Mint", m.mintActive == null ? null : m.mintActive ? "Activo" : "Revocado", "Autoridad de emision", m.mintActive ? "risk-warn" : "") +
      chip("Freeze", m.freezeActive == null ? null : m.freezeActive ? "Activo" : "Revocado", "Autoridad de congelacion", m.freezeActive ? "risk-warn" : "") + '</div>';
  },

  /** Badge html for a token's security verdict (empty when unknown). */
  securityBadge(t) {
    const s = SecurityFeed.get(t.tokenAddress, t.chain) || t.security;
    void this._secVersion; // re-renders re-evaluate after loadSecurity() bumps it
    if (!s) return '<span title="Sin evaluación disponible" style="font-size:9px;color:var(--text-tertiary)">N/D</span>';
    const color = s.level === "good" ? "var(--delta-green)" : s.level === "warn" ? "#fde047" : "var(--delta-red)";
    const title = esc(s.title ?? s.label ?? "");
    return `<span title="🛡️ ${title}" style="font-size:8.5px; font-weight:800; letter-spacing:0.4px; color:${color}; border:1px solid ${color}; border-radius:4px; padding:0 4px; line-height:13px; opacity:0.9">🛡️ ${s.level === "good" ? "LOW" : s.level === "warn" ? "MED" : "HIGH"}</span>`;
  },

  normalizeMarket(r) {
    return {
      id: "mkt_" + r.chain + "_" + (r.address || r.symbol),
      symbol: r.symbol || "???",
      name: r.name || r.symbol,
      chain: r.chain || "solana",
      imageUrl: r.logo,
      status: "market",
      priceUsd: r.priceUsd,
      mcapUsd: r.mcap || 0,
      raisedUsd: 0,
      buyers: r.buys24h,
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
      // Real graduation only: the on-chain factory flips this flag when the
      // mint exists on-chain. Never inferred from liquidity or volume.
      graduatedOnChain: l.graduatedOnChain === true,
      mintAddress: l.mintAddress ?? null,
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
        const row = DexFeed.get(t.tokenAddress, t.chain);
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
    // GMGN-parity: on wide viewports selection fills the persistent side
    // panel; the execution terminal only opens on explicit action (⚡ buttons
    // / panel CTA). Narrow viewports keep the direct terminal behavior.
    this.renderSidePanel();
    const wide = window.matchMedia ? window.matchMedia("(min-width: 1100px)").matches : false;
    if (!wide) window.App?.openTradeForToken?.(t.symbol, t.chain, t.priceUsd || 0, t.tokenAddress);
  },

  /** Entry point used by app.js/trading.js deep links: opens the terminal and
   *  mirrors the selection into the side panel, highlighting the row. */
  openTradeForToken(symbol, chain, price, tokenAddress) {
    const t = this.allTokens().find((x) => x.symbol === symbol &&
      (!tokenAddress || x.tokenAddress === tokenAddress) && (!chain || x.chain === chain)) ||
      this.allTokens().find((x) => x.symbol === symbol && x.chain === chain);
    if (t) {
      this.selected = t;
      this.renderSidePanel();
    }
    window.App?.__openTradeForToken?.(symbol, chain, price, tokenAddress);
  },

  /** Terminal-side mirror: app.js calls mirrorSelection(t) after opening the
   *  terminal from any surface (rails, search, ticker) → panel + row focus. */
  selectFromMirror(t) {
    if (!t) return;
    const row = this.poolRowFor(t);
    if (row) {
      this.selected = row;
      this.renderSidePanel();
    }
  },
  /** Row currently rendered for the selected token (for highlight focus). */
  poolRowFor(t) {
    if (!t) return null;
    return this.allTokens().find((x) => String(x.id) === String(t.id) && x.chain === t.chain) || null;
  },

  /** Persistent side panel (desktop ≥1100px): live detail of the selection
   *  without leaving the board. Hidden on narrower viewports. */
  renderSidePanel() {
    const el = document.getElementById("trenchesSidePanel");
    if (!el) return;
    const t = this.poolRowFor(this.selected);
    if (!t) {
      el.innerHTML = `<div style="padding:18px 14px; color:var(--text-tertiary); font-size:12px; line-height:1.6">
        <div style="font-weight:800; font-size:12.5px; color:var(--text-secondary); margin-bottom:6px">Panel de ejecución</div>
        Selecciona un token del board para ver su detalle vivo aquí. El terminal solo se abre cuando tú lo pides.
      </div>`;
      return;
    }
    const dex = t.dex ?? null;
    // Merge real launchpad state (curve progress / on-chain graduation flag)
    // when the selection entered through the token's market pool.
    const launch = (this.tokens || []).find((x) => (t.tokenAddress && x.tokenAddress && x.tokenAddress === t.tokenAddress) || String(x.id) === String(t.id));
    const gradFlag = t.graduatedOnChain === true || launch?.graduatedOnChain === true;
    const progress = Math.max(Number(t.progress || 0), Number(launch?.progress || 0));
    const raised = Math.max(Number(t.raisedUsd || 0), Number(launch?.raisedUsd || 0));
    const chg = (v, period) => {
      if (v == null || !Number.isFinite(Number(v))) return `<span class="tr-chip" title="Sin datos">—</span>`;
      const n = Number(v);
      return `<span class="tr-chip ${n > 0 ? "up" : n < 0 ? "down" : ""}">${period} ${n > 0 ? "+" : ""}${n.toFixed(2)}%</span>`;
    };
    const price = t.priceUsd > 0 ? (t.priceUsd < 0.02 ? "$" + t.priceUsd.toFixed(6) : "$" + t.priceUsd.toPrecision(4)) : "—";
    const liq = dex?.liqUsd > 0 ? fmtUsd(dex.liqUsd) : "—";
    const vol = dex?.vol24h > 0 ? fmtUsd(dex.vol24h) : "—";
    const grad = gradFlag
      ? `<span title="El mint existe on-chain (factory verificada)" style="color:var(--delta-green); font-weight:700">🎓 Graduado on-chain</span>`
      : progress > 0
        ? `<span title="Progreso real de la curva de bonding">Curva: ${Math.min(100, progress)}% · recaudado ${fmtUsd(raised)}</span>`
        : "";
    const addrHtml = t.tokenAddress
      ? `<div style="margin-top:8px; font-family:var(--font-mono); font-size:10px; color:var(--text-tertiary); word-break:break-all">${esc(t.tokenAddress)}
           <a class="tr-copy" title="Copiar contrato" onclick="event.stopPropagation(); navigator.clipboard?.writeText('${esc(t.tokenAddress)}').catch(() => {})">⧉</a>
           ${t.mintAddress || (t.tokenAddress && t.graduatedOnChain) ? `<a href="https://solscan.io/token/${esc(t.mintAddress || t.tokenAddress)}" target="_blank" rel="noopener noreferrer" title="Ver en Solscan" class="tr-social">↗</a>` : ""}
         </div>`
      : "";
    const idAttr = esc(JSON.stringify(String(t.id)));
    const symAttr = esc(JSON.stringify(t.symbol));
    el.innerHTML = `
      <div style="padding:12px 14px; border-bottom:1px solid var(--border-subtle); display:flex; align-items:center; gap:10px">
        <div class="tr-logo ${this.logoTrend(t)}">${TokenMeta?.logoHtml ? TokenMeta.logoHtml(t.symbol, { size: 38, round: false, imageUrl: this.riskImage(t), imageUrls: this.riskImages(t) }) : ""}</div>
        <div style="min-width:0">
          <div style="font-weight:800; font-size:14px; display:flex; align-items:center; gap:6px">${esc(t.symbol)} ${this.securityBadge(t)}</div>
          <div style="font-size:11px; color:var(--text-tertiary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis">${esc(t.name)}</div>
          <div style="font-size:13px; font-weight:700; margin-top:2px">${esc(price)} <span style="font-size:10px; color:var(--text-tertiary); font-weight:400">MC ${fmtUsd(t.mcapUsd)} · L ${esc(liq)} · V ${esc(vol)}</span></div>
        </div>
      </div>
      <div style="padding:10px 14px; display:flex; flex-wrap:wrap; gap:6px; border-bottom:1px solid var(--border-subtle)">
        ${chg(dex?.change5m, "5m")}${chg(dex?.change1h, "1h")}${chg(dex?.change6h, "6h")}${chg(dex?.change24h, "24h")}
      </div>
      ${progress > 0 && !gradFlag ? `<div style="padding:10px 14px 0"><div class="tr-progress" aria-hidden="true"><div style="width:${Math.min(100, progress)}%"></div></div>
        <div style="font-size:10.5px; color:var(--text-tertiary); margin-top:4px">${grad}</div></div>` : grad ? `<div style="padding:10px 14px 0; font-size:10.5px; color:var(--text-tertiary)">${grad}</div>` : ""}
      <div style="padding:10px 14px">${this.riskStrip(t)}</div>
      ${addrHtml}
      <div style="padding:12px 14px; display:flex; gap:8px">
        <button class="trench-buy-btn" style="flex:1" onclick="window.TrenchesEngine.quickBuy(${symAttr}, ${idAttr}, event)">⚡ Comprar 0.1</button>
        ${t.isMarket && t.tokenAddress ? `<button class="trench-thesis-btn" style="flex:1" onclick="window.TrenchesEngine.quickSell(${symAttr}, ${idAttr}, event)">⚡ Vender saldo</button>` : `<button class="trench-thesis-btn" style="flex:1" onclick="window.TrenchesEngine.openTradeForToken(${symAttr}, '${esc(t.chain)}', ${t.priceUsd || 0}, ${t.tokenAddress ? "'" + esc(t.tokenAddress) + "'" : "null"})">Abrir terminal</button>`}
      </div>`;
  },

  /** Cheap in-place refresh of the side panel numbers (called from _tick). */
  updateSidePanel() {
    if (!this.selected) return;
    const el = document.getElementById("trenchesSidePanel");
    if (!el || el.offsetParent === null) return; // hidden → nothing to patch
    this.renderSidePanel();
  },

  /** ⚡ quick sell: abre el terminal en SELL con el saldo real del token. */
  async quickSell(symbol, id, event) {
    event?.stopPropagation();
    const t = this.allTokens().find((x) => x.symbol === symbol && String(x.id) === String(id));
    if (!t) return;
    await window.TradingEngine?.quickMarketSell?.(t);
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
    if (this.activeChain !== "all" && t.chain !== this.activeChain) return false;
    if (this.search && !(`${t.name} ${t.symbol}`.toLowerCase().includes(this.search))) return false;
    if (columnId === "soon") return t.isMarket;
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
    if (columnId === "soon") return list.sort((a, b) => (b.dex?.liqUsd ?? 0) - (a.dex?.liqUsd ?? 0));
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
    if (this._board) return this._board.render();
    const el = this.target();
    if (!el) return;
    const badge = document.getElementById("trenchesLiveBadge");
    if (badge) {
      badge.textContent = this.marketStatus || "LOADING";
      badge.style.color = this.marketStatus === "LIVE" ? "var(--delta-green)" : "var(--text-secondary)";
    }
    const total = this.market.length;
    const countEl = document.getElementById("trenchesCount");
    if (countEl) countEl.textContent = `${total} tokens`;

    el.innerHTML = COLUMNS.map((c) => {
      const pool = this.market.filter((t) => this.visibleIn(c.id, t) &&
        (c.id !== "new" || (t.createdAt && Date.now() / 1000 - t.createdAt < 48 * 3600)));
      const rows = this.sortFor(c.id, pool);
      const rowsHtml = rows.length
        ? rows.map((t) => this.renderRow(t)).join("")
        : `<div style="padding:22px 14px; text-align:center; color:var(--text-tertiary); font-size:11.5px">
             ${esc(this.marketError || "Sin pools disponibles para este filtro.")}
           </div>`;
      return `
      <div class="trenches-col">
        <div style="display:flex; align-items:center; justify-content:space-between; padding:10px 12px; border-bottom:1px solid var(--border-subtle)">
          <div style="font-size:12.5px; font-weight:800">${c.icon} ${c.title} <span style="font-weight:400; color:var(--text-tertiary); font-size:10.5px">· ${c.hint}</span></div>
          <span class="brand-badge" style="font-size:9px">${rows.length}</span>
        </div>
        <div class="trenches-col-scroll">${rowsHtml}</div>
      </div>`;
    }).join("") + `<div style="grid-column:1 / -1;display:flex;gap:12px;align-items:center;padding:8px 12px;color:var(--text-tertiary);font-size:12px">
      <span>GeckoTerminal / DEX Screener · ${this.market.length} tokens indexados · ${this._marketAt ? new Date(this._marketAt).toLocaleTimeString() : "Cargando"}
      ${this.marketError ? " · " + esc(this.marketError) : ""}</span>
      <button class="btn btn-secondary btn-sm" onclick="window.TrenchesEngine.loadMoreMarket()" ${(this._marketPage || 1) >= 10 ? "disabled" : ""}>Cargar más pools</button>
      <span>Busca cualquier contrato arriba.</span>
    </div>`;
    this.renderSidePanel();
  },

  /** Force the catalog board render, bypassing the GMGN priority — used by
   *  GmgnBoard when it hands the board back after going down/disabled. */
  renderCatalog() {
    if (this._board) return this._board.render();
    return this.render();
  },

  renderRow(t) {
    const isSel = this.selected?.symbol === t.symbol && this.selected?.id === t.id;
    const dex = t.dex ?? null;
    const chg24h = dex?.change24h ?? null;
    const chg1h = dex?.change1h ?? null;
    const chg6h = dex?.change6h ?? null;
    const chg5m = dex?.change5m ?? null;
    const pctChip = (v, period) => {
      if (v == null || !Number.isFinite(Number(v))) return `<span class="tr-chip" title="Sin datos">—</span>`;
      const n = Number(v);
      const cls = n > 0 ? "up" : n < 0 ? "down" : "";
      return `<span class="tr-chip ${cls}" title="Variación ${period}">${period} ${n > 0 ? "+" : ""}${n.toFixed(2)}%</span>`;
    };
    const price = t.priceUsd > 0
      ? (t.priceUsd < 0.02 ? "$" + t.priceUsd.toFixed(6) : "$" + t.priceUsd.toPrecision(4))
      : "—";
    const socialIcons = [
      t.socials?.twitter ? `<a href="${esc(t.socials.twitter)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" title="X / Twitter" class="tr-social">𝕏</a>` : "",
      t.socials?.telegram ? `<a href="${esc(t.socials.telegram)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" title="Telegram" class="tr-social">✈</a>` : "",
      t.socials?.website ? `<a href="${esc(t.socials.website)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" title="Web" class="tr-social">🌐</a>` : "",
    ].join("");
    // Pair age: DexScreener pairCreatedAt for market rows, launch timestamp otherwise.
    const ageSrcMs = Number(t.dex?.createdAtMs || 0) || (t.createdAt ? t.createdAt * 1000 : 0);
    const age = ageSrcMs ? this.ageLabel(Math.floor(ageSrcMs / 1000)) : "";
    const buys = dex?.buys24h != null ? Number(dex.buys24h) : null;
    const sells = dex?.sells24h != null ? Number(dex.sells24h) : null;
    const pressure = buys != null && sells != null && buys + sells > 0 ? Math.round((buys / (buys + sells)) * 100) : null;
    const txns = dex?.txns24h != null ? Number(dex.txns24h) : null;
    const liq = dex?.liqUsd > 0 ? fmtUsd(dex.liqUsd) : "—";
    const vol = dex?.vol24h > 0 ? fmtUsd(dex.vol24h) : "—";
    const addr = String(t.tokenAddress || "");
    const idAttr = esc(JSON.stringify(String(t.id)));
    const symAttr = esc(JSON.stringify(t.symbol));
    // Curve progress bar sits on the left edge like a gauge (launchpad rows only).
    const progress = t.progress > 0
      ? `<div class="tr-progress" aria-hidden="true"><div style="width:${Math.min(100, t.progress)}%"></div></div>`
      : "";
    return `
      <div class="trench-row gman-row ${isSel ? "selected" : ""}" data-token-id="${esc(String(t.id))}" onclick="window.TrenchesEngine.selectById(${symAttr}, ${idAttr})">
        ${progress}
        <div class="tr-logo ${this.logoTrend(t)}" title="${esc(this.logoTrendTitle(t))}">${TokenMeta.logoHtml(t.symbol, { size: 38, round: false, imageUrl: this.riskImage(t), imageUrls: this.riskImages(t) })}</div>
        <div class="tr-body">
          <div class="tr-titleline">
            <strong class="tr-sym" title="${esc(t.name)}">${esc(t.symbol)}</strong>
            ${this.securityBadge(t)}
            ${t.graduatedOnChain ? `<span title="Graduado on-chain: mint real verificado por la factory" style="font-size:9px">🎓</span>` : ""}
            <span class="tr-name">${esc(String(t.name).slice(0, 16))}</span>
            <a class="tr-copy" title="Copiar contrato" onclick="event.stopPropagation(); navigator.clipboard?.writeText('${esc(addr)}').catch(() => {})">⧉</a>
            ${socialIcons}
          </div>
          <div class="tr-meta">
            ${age ? `<span>${esc(age)}</span>` : ""}
            ${buys > 0 ? `<span title="Compradores 24h">👦 ${buys.toLocaleString("en-US")}</span>` : ""}
            ${sells != null ? `<span title="Ventas 24h">▼ ${sells.toLocaleString("en-US")}</span>` : ""}
            ${pressure != null ? `<span title="Compras sobre el total 24h" style="color:${pressure >= 55 ? "var(--delta-green)" : pressure <= 45 ? "var(--delta-red)" : "inherit"}">↑${pressure}%</span>` : ""}
            ${txns != null ? `<span title="Transacciones 24h">⊘ ${txns.toLocaleString("en-US")}</span>` : ""}

            ${t.dex?.pairUrl ? `<a class="tr-social" href="${esc(t.dex.pairUrl)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" title="Ver par en DexScreener">↗</a>` : ""}
          </div>
          ${this.riskStrip(t)}
          <div class="tr-chips">
            ${pctChip(chg5m, "5m")}
            ${pctChip(chg1h, "1h")}
            ${pctChip(chg6h, "6h")}
            ${pctChip(chg24h, "24h")}
            <span class="tr-chip tr-liq" title="Liquidez">💧 ${esc(liq)}</span>
          </div>
          ${t.priceUsd > 0 ? `<div class="tr-price">${esc(price)}</div>` : ""}
          ${t.progress > 0 ? `<div class="tr-raise">Recaudado ${fmtUsd(t.raisedUsd)} · ${Math.min(100, t.progress)}%</div>` : ""}

        </div>
        <div class="tr-right">
          <div class="tr-mc">MC <b>${fmtUsd(t.mcapUsd)}</b></div>
          <div class="tr-mc-sub">V <span>${esc(vol)}</span> · F <span>${esc(liq)}</span></div>
          <div class="tr-actions">
            <button class="trench-buy-btn" onclick="event.stopPropagation(); window.TrenchesEngine.quickBuy(${symAttr}, ${idAttr}, event)" title="Compra rápida 0.1 USDC">⚡ Comprar</button>
            ${t.isMarket && t.tokenAddress ? `<button class="trench-thesis-btn" onclick="event.stopPropagation(); window.TrenchesEngine.quickSell(${symAttr}, ${idAttr}, event)" title="Abrir el terminal en SELL con tu saldo real">⚡ Vender</button>` : `<button class="trench-thesis-btn" onclick="event.stopPropagation(); window.TrenchesEngine.selectById(${symAttr}, ${idAttr})" title="Abrir terminal">Ver</button>`}
          </div>
        </div>
      </div>`;
  },

  selectById(symbol, id) {
    // GMGN rows live outside allTokens(); the board resolves them first.
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
      imageUrl: this.riskImage(t),
    });
  },

  ageLabel(createdAt) {
    const s = Math.max(0, Math.floor(Date.now() / 1000) - createdAt);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
  },

  setChain(chain) {
    this.activeChain = chain;
    this._board?.persist();
    this.market = [];
    this.marketStatus = "LOADING";
    this._marketPage = 1;
    // GMGN-style chain chips: sync the active state.
    document.querySelectorAll(".chain-chip").forEach((chip) => {
      chip.classList.toggle("active", chip.getAttribute("data-chain") === chain);
    });
    this.render();
    return this.loadMarket(true);
  },

  setSearch(q) {
    this.search = q.trim();
    const searchSequence = this._searchSequence = (this._searchSequence || 0) + 1;
    clearTimeout(this._addrTimer);
    this._board?.persist();
    clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => this._board ? this._board.refresh() : this.render(), 300);
    // A pasted contract resolves even when the pool is not indexed yet:
    // live DexScreener lookup → if the catalog doesn't have it, open the
    // terminal for that address directly (GMGN-style search jump).
    const addr = this.search;
    if (/^(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(addr)) {
      clearTimeout(this._addrTimer);
      this._addrTimer = setTimeout(async () => {
        try {
          const rows = await DexFeed.search(addr, "");
          if (searchSequence !== this._searchSequence) return;
          const key = (value) => String(value).startsWith("0x") ? String(value).toLowerCase() : String(value);
          const norm = key(addr);
          const row = rows.find((r) => key(r.address) === norm);
          if (!row) return;
          this._board?.refresh();
          const indexed = this.market.some((t) => key(t.tokenAddress) === norm);
          if (!indexed) this.select(this.normalizeMarket(row));
        } catch { /* search stays catalog-only on failure */ }
      }, 450);
    }
  },
};
