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
import { DexFeed } from "./dexfeed.js";

const COLUMNS = [
  { id: "new", title: "New", icon: "🌱", hint: "Últimos lanzamientos" },
  { id: "soon", title: "Soon", icon: "🚀", hint: "Cerca de graduar" },
  { id: "migrated", title: "Migrated", icon: "🎓", hint: "Graduados a DEX" },
];

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
  tokens: [],            // normalized launch rows
  selected: null,        // currently selected token ref
  search: "",
  loading: false,
  loadedOnce: false,
  _es: null,             // EventSource
  _pollTimer: null,
  _seq: 0,

  async init() {
    if (this.loadedOnce) return;
    await this.load();
    this.connectStream();
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
    window.TradingEngine?.setAsset(t.symbol, t.chain, t.priceUsd || 0);
    this.render();
  },

  /** ⚡ quick buy: 0.1 USDC on the bonding curve with the wallet password flow. */
  async quickBuy(symbol, event) {
    event?.stopPropagation();
    const t = this.tokens.find((x) => x.symbol === symbol);
    if (!t) return;
    if (!ApiClient.isAuthenticated?.()) {
      window.App?.openWalletModal?.();
      return;
    }
    try {
      const usdcMicro = "100000"; // 0.1 USDC
      if (t.status === "graduated") {
        // Routed as a market swap against the DEX pair.
        window.App?.openTradeForToken?.(t.symbol, t.chain, t.priceUsd);
        return;
      }
      const res = await ApiClient.buyLaunchTokens(t.id, usdcMicro);
      const got = res?.result?.tokenAmount;
      alert(`⚡ Comprado $${t.symbol}: ${Number(got ?? 0).toLocaleString("en-US", { maximumFractionDigits: 0 })} tokens por 0.1 USDC`);
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
    if (columnId === "migrated") return t.status === "graduated";
    if (columnId === "new") return t.status !== "graduated";
    if (columnId === "soon") return t.status !== "graduated" && t.progress >= 40;
    return true;
  },

  sortFor(columnId, list) {
    if (columnId === "new") return list.sort((a, b) => b.createdAt - a.createdAt);
    if (columnId === "soon") return list.sort((a, b) => b.progress - a.progress || b.raisedUsd - a.raisedUsd);
    return list.sort((a, b) => b.mcapUsd - a.mcapUsd);
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
    const total = this.tokens.length;
    const countEl = document.getElementById("trenchesCount");
    if (countEl) countEl.textContent = `${total} tokens`;

    el.innerHTML = COLUMNS.map((c) => {
      const rows = this.sortFor(c.id, this.tokens.filter((t) => this.visibleIn(c.id, t))).slice(0, 30);
      const rowsHtml = rows.length
        ? rows.map((t) => this.renderRow(t)).join("")
        : `<div style="padding:22px 14px; text-align:center; color:var(--text-tertiary); font-size:11.5px">
             ${c.id === "soon" ? "Ningún token cerca de graduar todavía." : c.id === "migrated" ? "Sin graduados aún — la primera curva que llene aparecerá aquí." : "Sin lanzamientos todavía. Crea el primero en Markets → Launchpad."}
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
    return `
      <div class="trench-row ${isSel ? "selected" : ""}" onclick="window.TrenchesEngine.selectById('${safeAttr(t.symbol)}', ${Number(t.id)})">
        ${TokenMeta.logoHtml(t.symbol, { size: 34, round: false, imageUrl: t.imageUrl })}
        <div style="flex:1; min-width:0">
          <div style="display:flex; align-items:center; gap:6px; min-width:0">
            <strong style="font-size:12px; color:#fff; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${esc(t.symbol)}</strong>
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
            <button class="trench-buy-btn" onclick="window.TrenchesEngine.quickBuy('${safeAttr(t.symbol)}', event)" title="Compra rápida 0.1 USDC">⚡ 0.1</button>
            <button class="trench-thesis-btn" onclick="window.TrenchesEngine.postThesis('${safeAttr(t.symbol)}', ${Number(t.id)}, event)" title="Publicar tesis sobre este token">📊 Tesis</button>
          </div>
        </div>
      </div>`;
  },

  selectById(symbol, id) {
    const t = this.tokens.find((x) => x.symbol === symbol && Number(x.id) === Number(id));
    if (t) this.select(t);
  },

  /** Open the thesis composer pre-filled with this token's live context. */
  postThesis(symbol, launchId, event) {
    event?.stopPropagation();
    const t = this.tokens.find((x) => x.symbol === symbol && Number(x.id) === Number(launchId));
    if (!t) return;
    window.App?.openNewPostModal({
      token: t.symbol,
      chain: t.chain,
      price: t.priceUsd,
      launchId: t.status !== "graduated" ? t.id : undefined,
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
