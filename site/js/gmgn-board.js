/**
 * 🐺 GMGN BOARD — FOMO-style trenches columns fed by GMGN OpenAPI (read-only).
 *
 * Columns map 1:1 to GMGN's own categories:
 *   Nuevas Creaciones   → new_creation
 *   Completando         → near_completion
 *   Completado          → completed
 *
 * Every row carries the pro analytics GMGN is known for: smart money count,
 * KOLs, snipers, bundler %, insider %, rug ratio 0-1, honeypot, launchpad.
 * HONEST DEGRADATION: when the backend has no GMGN_API_KEY (reason
 * GMGN_API_KEY_NOT_CONFIGURED) or the provider is down, the board falls back
 * to the persistent catalog (CatalogBoard) and never invents analytics.
 * Trading is NOT executed through GMGN — rows open our self-custody terminal.
 */

import { ApiClient } from "./api.js";
import { TokenMeta } from "./tokens.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[c]);

const COLUMNS = [
  { id: "new_creation", title: "Nuevas Creaciones", hint: "GMGN · tiempo real" },
  { id: "near_completion", title: "Completando", hint: "GMGN · cerca de graduarse" },
  { id: "completed", title: "Completado", hint: "GMGN · graduados a DEX" },
];

/** Micro formatters (GMGN sends plain numbers). */
const fmtUsd = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "—";
  if (v >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return "$" + (v / 1e3).toFixed(1) + "K";
  return "$" + v.toFixed(2);
};
const fmtPrice = (p) => {
  const v = Number(p);
  if (!Number.isFinite(v) || v <= 0) return "—";
  return "$" + (v < 0.02 ? v.toFixed(8) : v.toPrecision(4));
};
const ageLabel = (tsSec) => {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - Number(tsSec || 0));
  if (!Number.isFinite(s) || s <= 0) return "";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

export const GmgnBoard = {
  engine: null,
  sections: { new_creation: [], near_completion: [], completed: [] },
  asOf: null,
  status: "LOADING", // LOADING | LIVE | UNAVAILABLE | DISABLED
  error: "",
  note: "",
  _timer: null,

  init(engine) {
    this.engine = engine;
  },

  /** Normalize one GMGN token into the row shape renderRow() understands. */
  toRow(t) {
    return {
      id: "gmgn_" + t.chain + "_" + t.address,
      symbol: String(t.symbol || "???").toUpperCase(),
      name: t.name || t.symbol,
      chain: t.chain === "sol" ? "solana" : t.chain,
      imageUrl: t.logo,
      status: "market",
      priceUsd: t.priceUsd ?? 0,
      mcapUsd: t.marketCapUsd ?? 0,
      raisedUsd: 0,
      buyers: t.buys24h,
      progress: 0,
      socials: {
        ...(t.twitter ? { twitter: t.twitter } : {}),
        ...(t.telegram ? { telegram: t.telegram } : {}),
        ...(t.website ? { website: t.website } : {}),
      },
      tokenAddress: t.address,
      createdAt: t.createdAt,
      dex: null,
      isMarket: true,
      gmgn: t, // analytics payloads for the GMGN badges
    };
  },

  async load(chain, force = false) {
    const seq = (this._seq = (this._seq || 0) + 1);
    if (!force && this.status !== "LOADING" && this.asOf && Date.now() - this.asOf < 30_000) return;
    this.status = this.status === "DISABLED" ? "DISABLED" : "LOADING";
    try {
      const q = new URLSearchParams({ chain });
      const data = await ApiClient.request("/api/market/gmgn/trenches?" + q);
      if (seq !== this._seq) return;
      this.sections = {
        new_creation: (data?.sections?.new_creation?.tokens ?? []).map((t) => this.toRow(t)),
        near_completion: (data?.sections?.near_completion?.tokens ?? []).map((t) => this.toRow(t)),
        completed: (data?.sections?.completed?.tokens ?? []).map((t) => this.toRow(t)),
      };
      this.asOf = Date.now();
      this.status = "LIVE";
      this.error = "";
      this.note = String(data?.note ?? "");
    } catch (err) {
      if (seq !== this._seq) return;
      const msg = String(err?.message || err);
      // api.js surfaces data.error (the message); the 503 body also carries
      // reason: GMGN_API_KEY_NOT_CONFIGURED — match both spellings.
      if (/GMGN_API_KEY not configured|GMGN_API_KEY_NOT_CONFIGURED/i.test(msg)) {
        this.status = "DISABLED";
        this.error = "GMGN no configurado en el servidor — mostrando catálogo propio.";
      } else {
        this.status = "UNAVAILABLE";
        this.error = "GMGN no disponible ahora mismo — mostrando catálogo propio.";
      }
      this.render(); // paint the honest banner even if the catalog owns the board
      throw err; // caller decides the fallback
    }
  },

  /** Poll refresh every 45s while visible (GMGN TTL server-side is 60s). */
  startPolling(chainGetter) {
    clearInterval(this._timer);
    this._timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (this.status === "UNAVAILABLE" || this.status === "DISABLED") return;
      this.load(chainGetter(), true)
        .then(() => this.engine?.render())
        .catch(() => {});
    }, 45_000);
  },

  stopPolling() {
    clearInterval(this._timer);
    this._timer = null;
  },

  get active() {
    return this.status === "LIVE" || this.status === "LOADING";
  },

  /** Banner injected by CatalogBoard when it owns the DOM but GMGN is
   *  down/disabled — keeps the honest status visible without owning layout. */
  renderFallbackBanner(target) {
    const old = target.querySelector(":scope > .gmgn-banner");
    if (old) old.remove();
    const div = document.createElement("div");
    div.className = "gmgn-banner" + (this.status === "LIVE" ? "" : " gmgn-off");
    div.textContent = this.status === "DISABLED" || this.status === "UNAVAILABLE"
      ? this.error || "GMGN no disponible — mostrando catálogo propio."
      : "Cargando GMGN…";
    target.prepend(div);
  },

  /** All mapped rows across the three sections (flat). */
  rows() {
    return [
      ...(this.sections.new_creation ?? []),
      ...(this.sections.near_completion ?? []),
      ...(this.sections.completed ?? []),
    ];
  },

  /** Lookup by (symbol, id) so TrenchesEngine.selectById/quickBuy resolve
   *  GMGN rows too — they never enter allTokens() (tokens+market only). */
  rowFor(symbol, id) {
    return this.rows().find((x) => x.symbol === symbol && String(x.id) === String(id));
  },

  /** Render the three GMGN columns into the board target. When GMGN is
   *  down/disabled it paints ONLY the honest banner and hands the columns
   *  back to the catalog board (which may have skipped its render while we
   *  were LOADING). */
  render() {
    const el = document.getElementById("trenchesColumns");
    if (!el) return;
    const banner =
      this.status === "LIVE"
        ? `<div class="gmgn-banner"><span class="gmgn-dot"></span> GMGN en vivo · ${new Date(this.asOf).toLocaleTimeString()} — analítica de wallets según GMGN · ejecución siempre self-custody</div>`
        : this.status === "DISABLED" || this.status === "UNAVAILABLE"
          ? `<div class="gmgn-banner gmgn-off">${esc(this.error)}</div>`
          : `<div class="gmgn-banner">Cargando GMGN…</div>`;
    if (!this.active) {
      el.innerHTML = banner;
      this.engine?.renderCatalog?.();
      return;
    }
    el.innerHTML =
      banner +
      COLUMNS.map((c) => {
        const rows = this.sections[c.id] ?? [];
        const rowsHtml = rows.length
          ? rows.map((t) => this.engine.renderRow(t)).join("")
          : `<div style="padding:22px 14px; text-align:center; color:var(--text-tertiary); font-size:11.5px">Sin tokens en esta categoría ahora mismo.</div>`;
        return `
        <div class="trenches-col gmgn-col">
          <div class="gmgn-col-head">
            <div class="gmgn-col-title">${c.title} <span>${rows.length}</span></div>
            <span class="gmgn-col-hint">${c.hint}</span>
          </div>
          <div class="trenches-col-scroll">${rowsHtml}</div>
        </div>`;
      }).join("");
  },

  /* ── GMGN analytics badges (renderRow integration) ─────────────────── */

  /** Compact badge strip appended by TrenchesEngine.renderRow for gmgn rows. */
  badges(t) {
    const g = t.gmgn;
    if (!g) return "";
    const chip = (label, value, cls = "", title = "") =>
      value == null ? "" : `<span class="tr-chip gmgn-badge ${cls}" title="${esc(title)}">${label} ${esc(String(value))}</span>`;
    return [
      chip("🧠", g.smartMoneyCount, "sm", "Smart Money (wallets con historial verificado según GMGN)"),
      chip("🎤", g.kolCount, "kol", "KOLs detentores según GMGN"),
      chip("🎯", g.sniperCount, "snipe", "Snipers (compraron en el bloque de apertura)"),
      chip("🤖", g.bundlerRate != null ? g.bundlerRate.toFixed(1) + "%" : null, "bundle", "Volumen de bundler bots (GMGN)"),
      chip("🐀", g.insiderRate != null ? g.insiderRate.toFixed(1) + "%" : null, "insider", "Ratio insider/rat trader (GMGN)"),
      g.rugRatio != null
        ? `<span class="tr-chip gmgn-badge rug ${g.rugRatio >= 0.5 ? "rug-high" : g.rugRatio >= 0.2 ? "rug-mid" : "rug-low"}" title="Rug ratio 0-1 según GMGN">RUG ${g.rugRatio.toFixed(2)}</span>`
        : "",
      g.honeypot === true ? `<span class="tr-chip gmgn-badge rug rug-high" title="Honeypot detectado por GMGN">HONEYPOT</span>` : "",
      g.launchpadPlatform ? `<span class="tr-chip gmgn-badge lp" title="Launchpad">${esc(g.launchpadPlatform)}</span>` : "",
    ].join("");
  },

  /** Extra meta line (holders + age already shown; add swaps + MC history). */
  metaExtras(t) {
    const g = t.gmgn;
    if (!g) return "";
    const parts = [];
    if (g.holderCount != null) parts.push(`<span title="Holders">👥 ${Number(g.holderCount).toLocaleString("en-US")}</span>`);
    if (g.swaps24h != null) parts.push(`<span title="Swaps 24h">🔁 ${Number(g.swaps24h).toLocaleString("en-US")}</span>`);
    return parts.join("");
  },
};

window.GmgnBoard = GmgnBoard;
