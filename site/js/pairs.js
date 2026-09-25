/**
 * 🧩 UNIVERSAL PAIRS — the relative value layer.
 *
 * PAIR ANYTHING: any tracked asset (NFT collections, tokens, tokenized stocks)
 * can be the numéraire of any other. The backend derives each market as DIRECT
 * (observed floor vs SOL via Magic Eden) or SYNTHETIC (ratio of two real USD
 * reference prices) and labels it honestly. Synthetic markets are
 * analytics-only; they never pretend to be executable.
 *
 * Data rules: every number comes from /api/pairs*; missing history shows
 * "histórico acumulándose" instead of an invented line; relative stats need
 * two aligned snapshots per leg.
 */

import { ApiClient } from "./api.js";

const esc = (v) => String(v ?? "").replace(/[&<>\"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]);
const fmtPct = (n) => (n == null ? "—" : (n >= 0 ? "+" : "") + n.toFixed(2) + "%");
const pctColor = (n) => (n == null ? "var(--text-tertiary)" : n >= 0 ? "var(--delta-green)" : "var(--delta-red)");
const fmtNum = (n, d = 2) => (n == null ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: d }));
const fmtUsd = (n) => (n == null ? "—" : "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 }));
const shortPair = (id) => {
  const [b, q] = String(id || "").split("/");
  const sym = (x) => window.PairsEngine?.assetDir?.find((a) => a.id === x)?.symbol || x;
  return `${sym(b)} / ${sym(q)}`;
};

export const PairsEngine = {
  container: null,
  assetDir: [],
  view: "list", // list | pair | matrix
  listKind: "trending",
  pairs: [],
  currentPair: null,
  detail: null,
  chart: null,
  chartSeriesKey: null,
  _seeded: false,

  init(containerElement) {
    this.container = containerElement;
    this.load();
  },

  /* ── Data ─────────────────────────────────────────────────────────── */

  async ensureAssets() {
    if (this.assetDir.length) return;
    try {
      const data = await ApiClient.request("/api/pairs/assets");
      this.assetDir = data.assets ?? [];
    } catch { this.assetDir = []; }
  },

  async load() {
    await this.ensureAssets();
    if (this.view === "matrix") return this.renderMatrix();
    if (this.view === "pair" && this.currentPair) return this.openPair(this.currentPair, { force: true });
    return this.loadList();
  },

  async loadList() {
    this.renderListShell();
    try {
      const data = await ApiClient.request(`/api/pairs?kind=${encodeURIComponent(this.listKind)}&limit=24`);
      this.pairs = data.pairs ?? [];
    } catch (e) {
      console.warn("[Pairs] list failed:", e);
      this.pairs = [];
    }
    this.renderList();
  },

  async openPair(pairId, opts = {}) {
    this.view = "pair";
    this.currentPair = pairId;
    if (!opts.force) this.renderPairShell(pairId);
    try {
      this.detail = await ApiClient.request(`/api/pairs/${encodeURIComponent(pairId)}/detail`);
    } catch (e) {
      console.warn("[Pairs] detail failed:", e);
      this.detail = null;
    }
    this.renderPair();
    try { history.replaceState(null, "", `#pairs=${encodeURIComponent(pairId)}`); } catch {}
  },

  setListKind(kind) { this.listKind = kind; this.view = "list"; this.loadList(); },

  /* ── Render: discovery list ───────────────────────────────────────── */

  renderListShell() {
    if (!this.container) return;
    const kinds = [
      ["trending", "🔥 Todas"], ["nft-token", "🎨 NFT/SOL (directo)"],
      ["synthetic", "🧪 Sintéticos"], ["relative-movers", "⚡ Movimientos relativos"],
      ["relative-breakout", "🚀 Breakouts"],
    ];
    this.container.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px; margin-bottom:14px">
        <div>
          <h2 style="font-size:20px; font-weight:800; margin:0">🧩 Universal Pairs</h2>
          <div style="font-size:12px; color:var(--text-secondary); margin-top:2px">Cualquier asset puede ser el numeraire de otro. Comparar, medir y rotar.</div>
        </div>
        <button class="btn btn-secondary btn-sm" onclick="window.PairsEngine.setView('matrix')">📊 Matriz relativa</button>
      </div>
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:16px">
        ${kinds.map(([k, label]) => `
          <button class="btn ${this.listKind === k ? "btn-primary" : "btn-secondary"} btn-sm"
            onclick="window.PairsEngine.setListKind('${k}')">${label}</button>`).join("")}
      </div>
      <div id="pairsListBody"><div class="glass-panel" style="padding:24px; text-align:center; font-size:12.5px; color:var(--text-tertiary)">Cargando pares…</div></div>`;
  },

  renderList() {
    const body = document.getElementById("pairsListBody");
    if (!body) return;
    if (!this.pairs.length) {
      const kindLabel = { trending: "pares", "nft-token": "pares NFT/SOL directos", synthetic: "pares sintéticos", "relative-movers": "movimientos relativos", "relative-breakout": "breakouts relativos" }[this.listKind] || "pares";
      body.innerHTML = `
        <div class="glass-panel" style="padding:40px 24px; text-align:center">
          <div style="font-size:32px; margin-bottom:10px">🧩</div>
          <h3 style="font-size:15px; font-weight:800; margin-bottom:6px">Sin ${kindLabel} disponibles todavía</h3>
          <p style="font-size:12.5px; color:var(--text-secondary); max-width:460px; margin:0 auto 8px">
            El motor acumula snapshots de precios reales (floors de Magic Eden + precios de referencia) cada 5 minutos.
            Con dos o más puntos por asset aparecen ratios y rendimiento relativo — nunca se inventan.
          </p>
          ${this.listKind === "relative-breakout" ? `<p style="font-size:11.5px; color:var(--text-tertiary)">Umbral de breakout: relativo ≥ +5pp y ratio ≥ +3% en la ventana.</p>` : ""}
        </div>`;
      return;
    }
    body.innerHTML = `<div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(260px, 1fr)); gap:12px">
      ${this.pairs.map((p) => this.pairCard(p)).join("")}
    </div>`;
  },

  pairCard(p) {
    const modeBadge = p.pairMode === "direct"
      ? `<span style="font-size:9.5px; font-weight:800; letter-spacing:0.5px; padding:2px 7px; border-radius:999px; background:rgba(74,222,128,0.12); color:var(--delta-green)">DIRECTO</span>`
      : `<span style="font-size:9.5px; font-weight:800; letter-spacing:0.5px; padding:2px 7px; border-radius:999px; background:rgba(250,204,21,0.10); color:#fde047">SINTÉTICO</span>`;
    // Direct pairs always show the observed floor even before the synthetic
    // ratio has two aligned snapshots — the floor IS the direct market price.
    const headline = p.ratio != null
      ? fmtNum(p.ratio, p.ratio < 1 ? 6 : 3)
      : (p.pairMode === "direct" && p.directPrice != null ? fmtNum(p.directPrice, 3) + " SOL" : "—");
    const headlineLabel = p.ratio != null ? "ratio" : (p.pairMode === "direct" ? "floor observado" : "ratio");
    return `
      <div class="glass-panel-interactive" style="padding:16px; cursor:pointer" onclick="window.PairsEngine.openPair('${esc(p.id)}')">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:8px">
          <div class="mono" style="font-weight:800; font-size:14.5px; color:#fff">${esc(shortPair(p.id))}</div>
          ${modeBadge}
        </div>
        <div class="mono" style="font-size:20px; font-weight:800; margin-top:8px; color:#fff">${headline}</div>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:6px; font-size:11.5px">
          <span style="color:var(--text-tertiary)">${headlineLabel}</span>
          <span class="mono" style="color:${pctColor(p.ratioChange24hPct)}; font-weight:700">${p.ratio != null ? fmtPct(p.ratioChange24hPct) : "histórico acumulándose"}</span>
        </div>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:4px; font-size:11.5px">
          <span style="color:var(--text-tertiary)">relativo 24h</span>
          <span class="mono" style="color:${pctColor(p.relativePerf24hPct)}; font-weight:700">${p.relativePerf24hPct == null ? "acumulando…" : fmtPct(p.relativePerf24hPct)}</span>
        </div>
        ${p.relativeBreakout ? `<div style="margin-top:8px; font-size:10.5px; font-weight:800; color:var(--delta-green)">🚀 BREAKOUT RELATIVO</div>` : ""}
        <div style="margin-top:8px; font-size:10.5px; color:var(--text-tertiary)">
          ${esc(p.baseAsset.name)} vs ${esc(p.quoteAsset.name)} · oráculo ${esc(p.oracle)}
        </div>
      </div>`;
  },

  /* ── Render: pair terminal ────────────────────────────────────────── */

  renderPairShell(pairId) {
    if (!this.container) return;
    this.container.innerHTML = `
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:14px; flex-wrap:wrap">
        <button class="btn btn-ghost btn-sm" onclick="window.PairsEngine.backToList()">← Pares</button>
        <h2 class="mono" style="font-size:19px; font-weight:800; margin:0">${esc(shortPair(pairId))}</h2>
        <span id="pairModeBadge"></span>
      </div>
      <div id="pairBody"><div class="glass-panel" style="padding:24px; text-align:center; font-size:12.5px; color:var(--text-tertiary)">Cargando mercado…</div></div>`;
  },

  renderPair() {
    const body = document.getElementById("pairBody");
    if (!body) return;
    const d = this.detail;
    if (!d) {
      body.innerHTML = `<div class="glass-panel" style="padding:32px; text-align:center">
        <div style="font-size:28px; margin-bottom:8px">📡</div>
        <div style="font-size:13px; font-weight:700; margin-bottom:4px">Mercado no disponible</div>
        <div style="font-size:12px; color:var(--text-secondary)">El par existe, pero sus datos no están disponibles ahora mismo. Reintenta en unos segundos.</div>
        <button class="btn btn-secondary btn-sm" style="margin-top:12px" onclick="window.PairsEngine.openPair(window.PairsEngine.currentPair,{force:true})">Reintentar</button>
      </div>`;
      return;
    }
    const badge = document.getElementById("pairModeBadge");
    if (badge) {
      badge.innerHTML = d.pairMode === "direct"
        ? `<span style="font-size:10px; font-weight:800; padding:3px 10px; border-radius:999px; background:rgba(74,222,128,0.12); color:var(--delta-green)">DIRECTO · floor observado</span>`
        : `<span style="font-size:10px; font-weight:800; padding:3px 10px; border-radius:999px; background:rgba(250,204,21,0.10); color:#fde047">SINTÉTICO · solo analítica</span>`;
    }
    const ratioStr = d.ratio != null ? fmtNum(d.ratio, d.ratio < 1 ? 6 : 3)
      : (d.pairMode === "direct" && d.directPrice != null ? fmtNum(d.directPrice, 3) + " SOL" : "—");
    const ratioSub = d.ratio != null
      ? (d.pairMode === "direct" ? "floor " + esc(d.legs.base.asset.symbol) + " en " + esc(d.legs.quote.asset.symbol) : "sintético (USD/USD)")
      : (d.pairMode === "direct" ? "floor observado — histórico acumulándose" : "sintético — histórico acumulándose");
    const usdStr = d.basePriceUsd != null ? fmtUsd(d.basePriceUsd)
      : (d.pairMode === "direct" && d.directPrice != null && d.quotePriceUsd != null ? "≈ " + fmtUsd(d.directPrice * d.quotePriceUsd) : "USD n/d");

    body.innerHTML = `
      <!-- Header stats -->
      <div class="glass-panel" style="padding:20px; margin-bottom:14px">
        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(130px, 1fr)); gap:12px">
          ${this.stat("PAIR", ratioStr, "#fff", ratioSub)}
          ${this.stat("USD", usdStr, "#fff", "valor estimado del base")}
          ${this.stat("RATIO 24H", fmtPct(d.ratioChange24hPct), pctColor(d.ratioChange24hPct), "cambio del ratio")}
          ${this.stat("RELATIVO 24H", d.relativePerf24hPct == null ? "acumulando…" : fmtPct(d.relativePerf24hPct), pctColor(d.relativePerf24hPct), "base − quote (pp)")}
          ${this.stat("SNAPSHOTS", String(d.seriesPoints ?? 0), "#fff", "puntos alineados")}
        </div>
        ${d.relativeBreakout ? `<div style="margin-top:12px; font-size:12px; font-weight:800; color:var(--delta-green)">🚀 BREAKOUT RELATIVO — base superando a quote (relativo ≥ +5pp y ratio ≥ +3%)</div>` : ""}
      </div>

      <!-- Chart -->
      <div class="glass-panel" style="padding:18px; margin-bottom:14px">
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px">
          ${d.relative ? `<button class="btn btn-primary btn-sm" onclick="window.PairsEngine.showChart('relative')">RELATIVO</button>` : ""}
          ${d.ratioSeries ? `<button class="btn btn-secondary btn-sm" onclick="window.PairsEngine.showChart('ratio')">PAIR</button>` : ""}
        </div>
        ${d.relative || d.ratioSeries
          ? `<div id="pairChart" style="height:340px"></div>
             <div style="font-size:10.5px; color:var(--text-tertiary); margin-top:8px">
               ${d.relative ? `RELATIVO: ambas patas re-escaladas a 100 al inicio de la ventana · ` : ""}ventana: snapshots acumulados (5 min). Histórico crece con el tiempo — sin datos inventados.
             </div>`
          : `<div style="padding:36px; text-align:center">
               <div style="font-size:26px; margin-bottom:8px">⏳</div>
               <div style="font-size:13px; font-weight:700">Histórico acumulándose</div>
               <div style="font-size:12px; color:var(--text-secondary); margin-top:4px">Este par necesita al menos dos snapshots alineados por pata. El motor toma uno cada 5 minutos — vuelve pronto.</div>
             </div>`}
      </div>

      <!-- Pair DNA -->
      <div class="glass-panel" style="padding:20px; margin-bottom:14px">
        <h3 style="font-size:14px; font-weight:800; margin:0 0 12px">🧬 Pair DNA</h3>
        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:10px; font-size:12px">
          ${this.dnaRow("TIPO", `${esc(this.kindLabel(d.dna.base.kind))} / ${esc(this.kindLabel(d.dna.quote.kind))}`)}
          ${this.dnaRow("MODO", d.pairMode === "direct" ? "LIQUIDEZ (floor directo)" : "SINTÉTICO (analítica)")}
          ${this.dnaRow("BACKING", "NONE — sin vault verificado")}
          ${this.dnaRow("ORÁCULO", esc(d.dna.oracle))}
          ${this.dnaRow("LIQUIDEZ", esc(d.dna.liquidityModel))}
          ${this.dnaRow("ROUTING", "no routable todavía")}
        </div>
        <div style="margin-top:10px; font-size:11px; color:${d.pairMode === "direct" ? "var(--text-secondary)" : "#fde047"}">
          ${d.pairMode === "direct"
            ? "Precio directo observado: floor de la colección en Magic Eden (SOL). Ejecución no habilitada en esta fase."
            : "SYNTHETIC: ratio derivado de dos precios USD reales. Analítica y charting solamente — NO implica liquidez ni ejecutabilidad."}
        </div>
      </div>

      <!-- Legs -->
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); gap:14px; margin-bottom:14px">
        ${this.legCard("BASE", d.legs.base, d.nft)}
        ${this.legCard("QUOTE", d.legs.quote, null)}
      </div>

      <!-- Intelligence -->
      ${this.intelligenceHtml(d.intelligence, d.legs.base.asset.symbol)}

      <!-- Liquidity Teleport (routing) -->
      <div class="glass-panel" style="padding:18px; margin-bottom:14px">
        <h3 style="font-size:14px; font-weight:800; margin:0 0 4px">🌀 Liquidity Teleport</h3>
        <div style="font-size:11px; color:var(--text-tertiary); margin-bottom:10px">
          Busca la mejor ruta EJECUTABLE entre los dos assets (legs reales vía agregadores). Las cotizaciones son informativas y caducan; la ejecución real siempre vive en el flujo self-custody del terminal.
        </div>
        <div id="teleportBody">
          <button class="btn btn-secondary btn-sm" onclick="window.PairsEngine.checkRoute()">🔗 Chequear ruta ejecutable</button>
        </div>
      </div>

      <div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:20px">
        <button class="btn btn-secondary btn-sm" onclick="window.PairsEngine.openPair(window.PairsEngine.currentPair,{force:true})">↻ Actualizar</button>
        <button class="btn btn-ghost btn-sm" onclick="window.PairsEngine.setView('matrix')">📊 Ver matriz relativa</button>
      </div>`;

    // Chart after DOM insertion
    if (d.relative) this.drawChart("relative");
    else if (d.ratioSeries) this.drawChart("ratio");
  },

  stat(label, value, color, sub) {
    return `<div style="padding:12px; background:rgba(255,255,255,0.02); border:1px solid var(--border-subtle); border-radius:var(--radius-md)">
      <div style="font-size:10px; color:var(--text-tertiary); letter-spacing:1px">${label}</div>
      <div class="mono" style="font-size:19px; font-weight:800; color:${color}; margin-top:3px">${value}</div>
      ${sub ? `<div style="font-size:9.5px; color:var(--text-tertiary); margin-top:2px">${sub}</div>` : ""}
    </div>`;
  },

  dnaRow(k, v) {
    return `<div style="padding:10px; background:rgba(255,255,255,0.02); border:1px solid var(--border-subtle); border-radius:var(--radius-md)">
      <div style="font-size:9.5px; letter-spacing:1px; color:var(--text-tertiary)">${k}</div>
      <div style="font-size:12px; font-weight:700; margin-top:2px">${v}</div>
    </div>`;
  },

  legCard(side, leg, nft) {
    const a = leg.asset;
    const rows = [];
    rows.push(`<div style="display:flex; justify-content:space-between; font-size:12px; padding:7px 0; border-bottom:1px solid var(--border-subtle)">
      <span style="color:var(--text-tertiary)">Asset</span><span style="font-weight:700">${esc(a.name)} (${esc(a.symbol)})</span></div>`);
    rows.push(`<div style="display:flex; justify-content:space-between; font-size:12px; padding:7px 0; border-bottom:1px solid var(--border-subtle)">
      <span style="color:var(--text-tertiary)">Tipo</span><span>${esc(this.kindLabel(a.kind))} · ${esc(a.chain ?? "—")}</span></div>`);
    rows.push(`<div style="display:flex; justify-content:space-between; font-size:12px; padding:7px 0; border-bottom:1px solid var(--border-subtle)">
      <span style="color:var(--text-tertiary)">Precio USD</span><span class="mono">${leg.priceUsd != null ? fmtUsd(leg.priceUsd) : "—"}</span></div>`);
    if (leg.priceSol != null) rows.push(`<div style="display:flex; justify-content:space-between; font-size:12px; padding:7px 0; border-bottom:1px solid var(--border-subtle)">
      <span style="color:var(--text-tertiary)">Floor SOL</span><span class="mono">${fmtNum(leg.priceSol, 3)} SOL</span></div>`);
    if (leg.change24hPct != null) rows.push(`<div style="display:flex; justify-content:space-between; font-size:12px; padding:7px 0; border-bottom:1px solid var(--border-subtle)">
      <span style="color:var(--text-tertiary)">24H</span><span class="mono" style="color:${pctColor(leg.change24hPct)}">${fmtPct(leg.change24hPct)}</span></div>`);
    if (nft) {
      if (nft.listedCount != null) rows.push(`<div style="display:flex; justify-content:space-between; font-size:12px; padding:7px 0; border-bottom:1px solid var(--border-subtle)">
        <span style="color:var(--text-tertiary)">Listados</span><span class="mono">${fmtNum(nft.listedCount, 0)}</span></div>`);
      if (nft.volume7dSol != null) rows.push(`<div style="display:flex; justify-content:space-between; font-size:12px; padding:7px 0; border-bottom:1px solid var(--border-subtle)">
        <span style="color:var(--text-tertiary)">Volumen 7D</span><span class="mono">${fmtNum(nft.volume7dSol, 0)} SOL</span></div>`);
      if (nft.avgPrice24hrSol != null) rows.push(`<div style="display:flex; justify-content:space-between; font-size:12px; padding:7px 0; border-bottom:1px solid var(--border-subtle)">
        <span style="color:var(--text-tertiary)">Precio medio 24H</span><span class="mono">${fmtNum(nft.avgPrice24hrSol, 3)} SOL</span></div>`);
    }
    rows.push(`<div style="display:flex; justify-content:space-between; font-size:11px; padding:7px 0">
      <span style="color:var(--text-tertiary)">Fuente</span><span class="mono">${esc(leg.source)}</span></div>`);
    return `<div class="glass-panel" style="padding:18px">
      <div style="font-size:10px; letter-spacing:1px; color:var(--text-tertiary); margin-bottom:6px">${side}</div>
      ${rows.join("")}
    </div>`;
  },

  intelligenceHtml(intel, baseSymbol) {
    if (!intel || (!intel.outperforming.length && !intel.underperforming.length)) {
      return `<div class="glass-panel" style="padding:18px; margin-bottom:14px">
        <h3 style="font-size:14px; font-weight:800; margin:0 0 8px">🧠 Pair Intelligence</h3>
        <div style="font-size:12px; color:var(--text-secondary)">
          Inteligencia disponible para assets con precio USD de referencia (tokens y stocks tokenizados).
          Los floors NFT se miden en SOL; su comparación relativa vive en el chart RELATIVO del par.
        </div>
      </div>`;
    }
    const chip = (x, up) => `<span style="display:inline-flex; align-items:center; gap:6px; padding:5px 12px; border-radius:999px; font-size:11.5px; font-weight:700;
      background:${up ? "rgba(74,222,128,0.10)" : "rgba(248,113,113,0.10)"}; color:${up ? "var(--delta-green)" : "var(--delta-red)"}">
      ${esc(x.symbol)} <span class="mono">${up ? "+" : ""}${x.diffPp.toFixed(1)}pp</span></span>`;
    return `<div class="glass-panel" style="padding:18px; margin-bottom:14px">
      <h3 style="font-size:14px; font-weight:800; margin:0 0 4px">🧠 Pair Intelligence — ${esc(baseSymbol)} vs benchmarks (24H)</h3>
      <div style="font-size:11px; color:var(--text-tertiary); margin-bottom:10px">Diferencia de rendimiento en puntos porcentuales. Benchmark sin dato = omitido, nunca cero.</div>
      <div style="display:flex; flex-wrap:wrap; gap:8px; margin-bottom:8px">
        <span style="font-size:11px; font-weight:800; color:var(--delta-green); align-self:center">GANA A →</span>
        ${intel.outperforming.map((x) => chip(x, true)).join("") || `<span style="font-size:11.5px; color:var(--text-tertiary)">ninguno en la ventana</span>`}
      </div>
      <div style="display:flex; flex-wrap:wrap; gap:8px">
        <span style="font-size:11px; font-weight:800; color:var(--delta-red); align-self:center">PIERDE CON →</span>
        ${intel.underperforming.map((x) => chip(x, false)).join("") || `<span style="font-size:11.5px; color:var(--text-tertiary)">ninguno en la ventana</span>`}
      </div>
    </div>`;
  },

  kindLabel(kind) {
    return { token: "TOKEN", nft_collection: "NFT COLLECTION", fractional_nft: "FRACTIONAL NFT", index: "INDEX", vault: "VAULT", tokenized_asset: "TOKENIZED ASSET" }[kind] || String(kind).toUpperCase();
  },

  /* ── Liquidity Teleport ───────────────────────────────────────────── */

  async checkRoute() {
    const body = document.getElementById("teleportBody");
    if (!body || !this.currentPair) return;
    body.innerHTML = `<div style="font-size:12px; color:var(--text-tertiary)" class="loading-pulse">🌀 Buscando ruta ejecutable…</div>`;
    try {
      const r = await ApiClient.request(`/api/pairs/route?q=${encodeURIComponent(this.currentPair)}&amountIn=1000000000`);
      if (r.status === "ROUTABLE") {
        const legs = r.legs.map((l, i) => `
          <div style="display:flex; align-items:center; gap:8px; padding:8px 0; ${i < r.legs.length - 1 ? "border-bottom:1px solid var(--border-subtle)" : ""}">
            <span style="font-size:11px; font-weight:800; color:var(--text-tertiary)">${i + 1}.</span>
            <span class="mono" style="font-size:11.5px; font-weight:700">${esc(shortPair(l.from + "/" + l.to))}</span>
            <span style="flex:1"></span>
            <span class="mono" style="font-size:11px; color:var(--text-tertiary)">${esc(l.venue ?? "")} · impacto ${l.priceImpactPct != null ? l.priceImpactPct.toFixed(3) + "%" : "n/d"}</span>
          </div>`).join("");
        body.innerHTML = `
          <div style="font-size:11.5px; font-weight:800; color:var(--delta-green); margin-bottom:8px">✅ ROUTABLE — ${r.hops} leg${r.hops === 1 ? "" : "s"} ejecutable${r.hops === 1 ? "" : "s"}</div>
          ${legs}
          <div style="font-size:10.5px; color:var(--text-tertiary); margin-top:8px">
            Impacto total ${r.totalImpactPct != null ? r.totalImpactPct.toFixed(3) + "%" : "n/d"} · salida final ${r.minOutAmount ?? "—"} (unidades base del destino) · cotización solo informativa, sin sesión ni firma.
          </div>`;
      } else {
        body.innerHTML = `
          <div style="font-size:11.5px; font-weight:800; color:#fde047; margin-bottom:6px">⛔ NO ROUTE</div>
          <div style="font-size:12px; color:var(--text-secondary)">${esc(r.reason || "sin ruta ejecutable")}</div>
          <div style="font-size:10.5px; color:var(--text-tertiary); margin-top:6px">El par sigue siendo útil como mercado analítico sintético — pero no se puede ejecutar todavía.</div>`;
      }
    } catch (e) {
      body.innerHTML = `<div style="font-size:12px; color:var(--delta-red)">Routing no disponible: ${esc(e?.message || "error")}</div>
        <button class="btn btn-secondary btn-sm" style="margin-top:8px" onclick="window.PairsEngine.checkRoute()">Reintentar</button>`;
    }
  },

  /* ── Chart (Lightweight Charts, same stack as the terminal) ───────── */

  showChart(key) {
    this.drawChart(key);
    const wrap = document.getElementById("pairChart");
    if (wrap) wrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
  },

  drawChart(key) {
    const el = document.getElementById("pairChart");
    const d = this.detail;
    if (!el || !d || !window.LightweightCharts) return;
    if (this.chart && this.chartSeriesKey === key) return;
    if (this.chart) { this.chart.remove(); this.chart = null; this.chartSeriesKey = null; }
    const chart = LightweightCharts.createChart(el, {
      height: 340,
      layout: { background: { type: "solid", color: "transparent" }, textColor: "rgba(255,255,255,0.55)", fontSize: 10 },
      grid: { vertLines: { color: "rgba(255,255,255,0.04)" }, horzLines: { color: "rgba(255,255,255,0.04)" } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
    });
    this.chart = chart;
    this.chartSeriesKey = key;
    if (key === "relative" && d.relative) {
      const mk = (data, color) => chart.addLineSeries({ color, lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
      mk(d.relative.map((p) => ({ time: p.time, value: p.base })), "#4ade80").setData(d.relative.map((p) => ({ time: p.time, value: p.base })));
      mk(d.relative.map((p) => ({ time: p.time, value: p.quote })), "rgba(255,255,255,0.45)").setData(d.relative.map((p) => ({ time: p.time, value: p.quote })));
      mk(d.relative.map((p) => ({ time: p.time, value: p.relative })), "#fde047").setData(d.relative.map((p) => ({ time: p.time, value: p.relative })));
      chart.timeScale().fitContent();
    } else if (key === "ratio" && d.ratioSeries) {
      const clean = d.ratioSeries.filter((p) => p.ratio != null).map((p) => ({ time: p.time, value: p.ratio }));
      const s = chart.addLineSeries({ color: "#60a5fa", lineWidth: 2, priceLineVisible: false });
      s.setData(clean);
      chart.timeScale().fitContent();
    }
  },

  /* ── Matrix (relative strength scanner) ───────────────────────────── */

  async renderMatrix() {
    if (!this.container) return;
    this.container.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; margin-bottom:14px">
        <div>
          <h2 style="font-size:20px; font-weight:800; margin:0">📊 Matriz relativa</h2>
          <div style="font-size:12px; color:var(--text-secondary); margin-top:2px">Fila vs columna — rendimiento relativo 24H en puntos porcentuales. Requiere dos snapshots por asset.</div>
        </div>
        <button class="btn btn-secondary btn-sm" onclick="window.PairsEngine.backToList()">← Pares</button>
      </div>
      <div id="matrixBody" class="glass-panel" style="padding:16px; font-size:12px; color:var(--text-tertiary)">Calculando…</div>`;
    // One detail per token against SOL (except SOL itself, which pairs against
    // ETH) yields every token's own 24H USD change — batched CoinGecko underneath.
    try {
      const tokens = this.assetDir.filter((a) => a.kind === "token");
      const changes = await Promise.all(tokens.map(async (t) => {
        if (t.id === "wrapped-sol") {
          try {
            const d = await ApiClient.request(`/api/pairs/${encodeURIComponent("wrapped-sol/ethereum")}/detail`);
            return [t.id, d.legs?.base?.change24hPct ?? null];
          } catch { return [t.id, null]; }
        }
        try {
          const d = await ApiClient.request(`/api/pairs/${encodeURIComponent(t.id + "/wrapped-sol")}/detail`);
          return [t.id, d.legs?.base?.change24hPct ?? null];
        } catch { return [t.id, null]; }
      }));
      const map = new Map(changes);
      const cols = tokens;
      const rowsHtml = tokens.map((r) => {
        const cells = cols.map((c) => {
          if (c.id === r.id) return `<td style="padding:8px; text-align:center; color:var(--text-tertiary)">—</td>`;
          const rc = map.get(r.id), cc = map.get(c.id);
          if (rc == null || cc == null) return `<td style="padding:8px; text-align:center; color:var(--text-tertiary)">n/d</td>`;
          const diff = Math.round((rc - cc) * 10) / 10;
          const intensity = Math.min(Math.abs(diff) / 10, 1);
          const bg = diff >= 0 ? `rgba(74,222,128,${0.08 + intensity * 0.30})` : `rgba(248,113,113,${0.08 + intensity * 0.30})`;
          return `<td style="padding:8px; text-align:center; background:${bg}; border-radius:6px" class="mono" style="padding:8px; text-align:center">${diff >= 0 ? "+" : ""}${diff.toFixed(1)}</td>`;
        }).join("");
        return `<tr><td style="padding:8px; font-weight:800; white-space:nowrap">${esc(r.symbol)}</td>${cells}</tr>`;
      }).join("");
      const head = `<tr><td></td>${cols.map((c) => `<td style="padding:8px; font-weight:800; text-align:center">${esc(c.symbol)}</td>`).join("")}</tr>`;
      document.getElementById("matrixBody").innerHTML =
        `<div style="overflow-x:auto"><table style="border-collapse:separate; border-spacing:2px; width:100%">${head}${rowsHtml}</table></div>
         <div style="font-size:10.5px; color:var(--text-tertiary); margin-top:10px">Verde: la fila supera a la columna. Rojo: la fila pierde. n/d: snapshot insuficiente (el motor acumula cada 5 min).</div>`;
    } catch {
      const b = document.getElementById("matrixBody");
      if (b) b.textContent = "Matriz no disponible ahora mismo.";
    }
  },

  /* ── Navigation ───────────────────────────────────────────────────── */

  setView(v) { this.view = v; this.load(); },
  backToList() {
    this.view = "list";
    this.currentPair = null;
    this.destroyChart();
    try { history.replaceState(null, "", "#pairs"); } catch {}
    this.loadList();
  },
  destroyChart() {
    if (this.chart) { try { this.chart.remove(); } catch {} this.chart = null; this.chartSeriesKey = null; }
  },
};

window.PairsEngine = PairsEngine;
