/**
 * 🎯 MARKETS ENGINE — Prediction markets (Polymarket) + Token Launchpad
 * Prediction: real events from /api/prediction/events with category filter,
 * outcome prices, and real CLOB order placement via /api/prediction/order.
 * Launchpad: bonding-curve token launches with create/buy/sell.
 * All data real or honestly empty — no invented content.
 */

import { ApiClient } from "./api.js";

const fmtUsd = (n) =>
  "$" + Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 2 });

const fmtCompact = (n) => {
  const v = Number(n || 0);
  if (v >= 1e9) return "$" + (v / 1e9).toFixed(1) + "B";
  if (v >= 1e6) return "$" + (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return "$" + (v / 1e3).toFixed(1) + "K";
  return "$" + v.toFixed(0);
};

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);

/** Keep only chars safe for inline JS handler strings. */
const safeAttr = (s) =>
  String(s ?? "").replace(/[^a-zA-Z0-9_@.\-,:]/g, "");

const CATEGORY_ICONS = {
  crypto: "₿", politics: "🏛", sports: "🏆", "pop-culture": "🎬",
  science: "🔬", markets: "📈", geopolitics: "🌍", ai: "🤖", world: "🌐",
};

export const MarketsEngine = {
  container: null,
  subTab: "prediction", // 'prediction' | 'launchpad'
  category: "",
  sort: "trending",
  events: [],
  launches: [],
  launchSort: "latest",

  init(containerElement) {
    this.container = containerElement;
  },

  /* ══════════ PREDICTION MARKETS ══════════ */

  async loadPrediction() {
    this.renderPredictionLoading();
    try {
      const data = await ApiClient.getPredictionEvents({
        category: this.category || undefined,
        sort: this.sort,
        limit: 30,
      });
      this.events = data.events || [];
      this.renderPrediction();
    } catch (err) {
      this.renderError(String(err?.message || err), () => this.loadPrediction());
    }
  },

  setCategory(cat) {
    this.category = cat;
    this.loadPrediction();
  },

  setSort(sort) {
    this.sort = sort;
    this.loadPrediction();
  },

  openEvent(slug) {
    const ev = this.events.find((e) => e.slug === slug);
    if (!ev) return;
    const modal = document.getElementById("marketEventModal");
    document.getElementById("marketEventTitle").textContent = ev.title || ev.slug;
    const m = (ev.markets || [])[0] || {};
    const outcomes = m.outcomes || [];
    const prices = m.outcomePrices || [];
    let buttonsHtml = "";
    for (let i = 0; i < outcomes.length && i < 2; i++) {
      const price = Number(prices[i] || 0);
      buttonsHtml += `
        <div style="flex:1; background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:var(--radius-md); padding:16px">
          <div style="font-size:12px; color:var(--text-secondary); margin-bottom:6px">${escapeHtml(outcomes[i])}</div>
          <div style="font-size:22px; font-weight:700; color:var(--accent-green)">${Math.round(price * 100)}¢</div>
          <div style="font-size:10.5px; color:var(--text-tertiary); margin:4px 0 12px">Gana ${escapeHtml(outcomes[i])} → $1</div>
          <button class="btn btn-primary btn-sm" style="width:100%" onclick="window.MarketsEngine.promptOrder('${safeAttr(m.clobTokenIds?.[i] || "")}','${safeAttr(outcomes[i])}',${price},'${safeAttr(ev.slug)}')">Comprar</button>
        </div>`;
    }
    document.getElementById("marketEventBody").innerHTML = `
      ${ev.image ? `<img src="${escapeHtml(ev.image)}" alt="" style="width:100%; max-height:150px; object-fit:cover; border-radius:var(--radius-md); margin-bottom:14px" onerror="this.style.display='none'">` : ""}
      <div style="display:flex; gap:14px; margin-bottom:14px; font-size:11.5px; color:var(--text-secondary)">
        <span>📊 Vol ${fmtCompact(ev.volumeUsd)}</span>
        <span>💧 Liq ${fmtCompact(ev.liquidityUsd)}</span>
        <span>📅 ${ev.endDate ? new Date(ev.endDate).toLocaleDateString("es", { month: "short", year: "numeric" }) : "—"}</span>
      </div>
      <p style="font-size:12.5px; color:var(--text-secondary); line-height:1.6; margin-bottom:16px">${escapeHtml((ev.description || "").slice(0, 400))}${(ev.description || "").length > 400 ? "…" : ""}</p>
      <div style="display:flex; gap:10px">${buttonsHtml}</div>
      ${m.orderBookEnabled === false ? `<p style="font-size:10.5px; color:var(--text-tertiary); margin-top:10px">⚠️ Este mercado no acepta órdenes ahora mismo</p>` : ""}`;
    modal.classList.add("open");
  },

  closeEvent() {
    document.getElementById("marketEventModal").classList.remove("open");
  },

  async promptOrder(tokenId, outcome, price, slug) {
    if (!tokenId) {
      alert("Este mercado no tiene tokenId para órdenes CLOB");
      return;
    }
    if (!ApiClient.isAuthenticated()) {
      alert("Conecta tu wallet primero");
      return;
    }
    const pw = prompt(`Compra ${outcome} a ${Math.round(price * 100)}¢\n\nCantidad en USDC (ej: 5):`);
    if (!pw) return;
    const size = parseFloat(pw);
    if (!Number.isFinite(size) || size <= 0) {
      alert("Cantidad inválida");
      return;
    }
    const walletPw = prompt("Contraseña de tu wallet Polygon para firmar la orden:");
    if (!walletPw) return;
    try {
      const res = await ApiClient.placePredictionOrder({
        tokenId, side: "BUY", price: price.toFixed(3), size: String(size), password: walletPw,
      });
      alert(`✅ Orden colocada en Polymarket\n\n${res.result?.status || "OK"}`);
      this.closeEvent();
    } catch (err) {
      alert("❌ " + String(err?.message || err));
    }
  },

  /* ══════════ LAUNCHPAD ══════════ */

  async loadLaunches() {
    this.renderLaunchpadLoading();
    try {
      const data = await ApiClient.getLaunches({ sort: this.launchSort, limit: 30 });
      this.launches = data.launches || [];
      this.renderLaunchpad();
    } catch (err) {
      this.renderError(String(err?.message || err), () => this.loadLaunches());
    }
  },

  setLaunchSort(sort) {
    this.launchSort = sort;
    this.loadLaunches();
  },

  async promptCreateLaunch() {
    if (!ApiClient.isAuthenticated()) {
      alert("Conecta tu wallet primero");
      return;
    }
    const name = prompt("Nombre del token (ej: Trenches Coin):");
    if (!name) return;
    const symbol = prompt("Símbolo (ej: TRN):");
    if (!symbol) return;
    const chain = prompt("Cadena (solana, base, ethereum, bsc, arbitrum, polygon, monad, arc, robinhood):", "solana");
    if (!chain) return;
    const description = prompt("Descripción (opcional):") || "";
    try {
      await ApiClient.createLaunch({ chain: chain.trim().toLowerCase(), name, symbol, description });
      alert("🚀 Lanzamiento creado");
      this.loadLaunches();
    } catch (err) {
      alert("❌ " + String(err?.message || err));
    }
  },

  async promptBuy(launchId, symbol) {
    if (!ApiClient.isAuthenticated()) {
      alert("Conecta tu wallet primero");
      return;
    }
    const usdc = prompt(`Comprar ${symbol} — monto en USDC (ej: 10):`);
    if (!usdc) return;
    try {
      const res = await ApiClient.buyLaunchTokens(launchId, usdc);
      alert(`✅ Comprado ${symbol}: ${res.result?.tokenAmount || "?"} tokens`);
      this.loadLaunches();
    } catch (err) {
      alert("❌ " + String(err?.message || err));
    }
  },

  async promptSell(launchId, symbol) {
    if (!ApiClient.isAuthenticated()) {
      alert("Conecta tu wallet primero");
      return;
    }
    const amt = prompt(`Vender ${symbol} — cantidad de tokens:`);
    if (!amt) return;
    try {
      const res = await ApiClient.sellLaunchTokens(launchId, amt);
      alert(`✅ Vendido: +${res.result?.usdcAmount || "?"} USDC`);
      this.loadLaunches();
    } catch (err) {
      alert("❌ " + String(err?.message || err));
    }
  },

  /* ══════════ RENDERING ══════════ */

  render() {
    if (!this.container) return;
    this.renderShell();
    if (this.subTab === "prediction") this.loadPrediction();
    else this.loadLaunches();
  },

  setSubTab(tab, btn) {
    this.subTab = tab;
    document.querySelectorAll("#view-markets .markets-subtab").forEach((b) =>
      b.classList.toggle("active", b === btn || b.getAttribute("data-subtab") === tab)
    );
    this.renderShell();
    if (tab === "prediction") this.loadPrediction();
    else this.loadLaunches();
  },

  /** Jump to the launchpad from anywhere (e.g. Discover search results). */
  viewLaunchpad() {
    this.subTab = "launchpad";
    if (window.App?.switchView) window.App.switchView("markets");
    this.render();
  },

  renderShell() {
    const subtabs = `
      <div class="pill-tabs-bar" style="margin-bottom:16px">
        <button class="pill-tab markets-subtab ${this.subTab === "prediction" ? "active" : ""}" onclick="window.MarketsEngine.setSubTab('prediction', this)">🎯 Predicción</button>
        <button class="pill-tab markets-subtab ${this.subTab === "launchpad" ? "active" : ""}" onclick="window.MarketsEngine.setSubTab('launchpad', this)">🚀 Launchpad</button>
      </div>`;
    if (this.subTab === "prediction") {
      this.container.innerHTML = `
        ${subtabs}
        <div class="pill-tabs-bar" style="margin-bottom:10px">
          <button class="pill-tab ${!this.category ? "active" : ""}" onclick="window.MarketsEngine.setCategory('')">Todas</button>
          ${Object.keys(CATEGORY_ICONS).map((c) =>
            `<button class="pill-tab ${this.category === c ? "active" : ""}" onclick="window.MarketsEngine.setCategory('${c}')">${CATEGORY_ICONS[c]} ${c}</button>`
          ).join("")}
        </div>
        <div style="display:flex; gap:8px; margin-bottom:16px">
          <button class="pill-tab ${this.sort === "trending" ? "active" : ""}" onclick="window.MarketsEngine.setSort('trending')">🔥 Trending</button>
          <button class="pill-tab ${this.sort === "new" ? "active" : ""}" onclick="window.MarketsEngine.setSort('new')">🆕 Nuevos</button>
        </div>
        <div id="marketsList"></div>`;
    } else {
      this.container.innerHTML = `
        ${subtabs}
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px">
          <div style="display:flex; gap:8px">
            <button class="pill-tab ${this.launchSort === "latest" ? "active" : ""}" onclick="window.MarketsEngine.setLaunchSort('latest')">Recientes</button>
            <button class="pill-tab ${this.launchSort === "raised" ? "active" : ""}" onclick="window.MarketsEngine.setLaunchSort('raised')">💰 Más recaudado</button>
          </div>
          <button class="btn btn-primary btn-sm" onclick="window.MarketsEngine.promptCreateLaunch()">+ Crear token</button>
        </div>
        <div id="marketsList"></div>`;
    }
  },

  renderPredictionLoading() {
    const el = document.getElementById("marketsList");
    if (el) el.innerHTML = `<p style="color:var(--text-tertiary); font-size:12.5px; padding:20px 0">Cargando mercados de predicción…</p>`;
  },

  renderLaunchpadLoading() {
    const el = document.getElementById("marketsList");
    if (el) el.innerHTML = `<p style="color:var(--text-tertiary); font-size:12.5px; padding:20px 0">Cargando lanzamientos…</p>`;
  },

  renderError(msg, retry) {
    const el = document.getElementById("marketsList");
    if (!el) return;
    el.innerHTML = `
      <div style="text-align:center; padding:40px 20px">
        <p style="color:var(--text-secondary); font-size:13px; margin-bottom:14px">No se pudieron cargar los mercados</p>
        <p style="color:var(--text-tertiary); font-size:11px; margin-bottom:16px">${escapeHtml(msg)}</p>
        <button class="btn btn-primary btn-sm" id="marketsRetryBtn">Reintentar</button>
      </div>`;
    document.getElementById("marketsRetryBtn").onclick = retry;
  },

  renderPrediction() {
    const el = document.getElementById("marketsList");
    if (!el) return;
    if (!this.events.length) {
      el.innerHTML = `
        <div style="text-align:center; padding:48px 20px; border:1px dashed var(--border-subtle); border-radius:var(--radius-md)">
          <p style="font-size:26px; margin-bottom:8px">🎯</p>
          <p style="color:var(--text-secondary); font-size:13px">No hay mercados en esta categoría</p>
        </div>`;
      return;
    }
    el.innerHTML = this.events
      .map((ev) => {
        const m = (ev.markets || [])[0] || {};
        const outcomes = m.outcomes || ["Sí", "No"];
        const prices = (m.outcomePrices || ["0", "0"]).map(Number);
        const pct = Math.round((prices[0] || 0) * 100);
        return `
        <div style="background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:var(--radius-md); padding:14px 16px; margin-bottom:10px; cursor:pointer" onclick="window.MarketsEngine.openEvent('${safeAttr(ev.slug)}')">
          <div style="display:flex; gap:12px; align-items:flex-start">
            ${ev.image ? `<img src="${escapeHtml(ev.image)}" alt="" style="width:42px; height:42px; border-radius:var(--radius-sm); object-fit:cover; flex-shrink:0" onerror="this.style.display='none'">` : ""}
            <div style="flex:1; min-width:0">
              <p style="font-size:13px; font-weight:600; color:var(--text-primary); margin-bottom:5px">${escapeHtml(ev.title)}</p>
              <div style="display:flex; gap:12px; font-size:10.5px; color:var(--text-tertiary)">
                <span>📊 ${fmtCompact(ev.volumeUsd)}</span>
                <span>💧 ${fmtCompact(ev.liquidityUsd)}</span>
                ${ev.endDate ? `<span>📅 ${new Date(ev.endDate).toLocaleDateString("es", { month: "short", year: "numeric" })}</span>` : ""}
              </div>
            </div>
            <div style="text-align:right; flex-shrink:0">
              <div style="font-size:17px; font-weight:700; color:var(--accent-green)">${pct}%</div>
              <div style="font-size:9.5px; color:var(--text-tertiary)">${escapeHtml(outcomes[0])}</div>
            </div>
          </div>
        </div>`;
      })
      .join("");
  },

  renderLaunchpad() {
    const el = document.getElementById("marketsList");
    if (!el) return;
    if (!this.launches.length) {
      el.innerHTML = `
        <div style="text-align:center; padding:48px 20px; border:1px dashed var(--border-subtle); border-radius:var(--radius-md)">
          <p style="font-size:26px; margin-bottom:8px">🚀</p>
          <p style="color:var(--text-secondary); font-size:13px; margin-bottom:6px">Nadie ha lanzado un token todavía</p>
          <p style="color:var(--text-tertiary); font-size:11.5px; margin-bottom:16px">Sé el primero — bonding curve, price discovery automático</p>
          <button class="btn btn-primary btn-sm" onclick="window.MarketsEngine.promptCreateLaunch()">🚀 Crear el primer token</button>
        </div>`;
      return;
    }
    el.innerHTML = this.launches
      .map((l) => {
        const mcap = Number(l.marketCapUsd || l.market_cap_usdc || 0) / 1e6;
        const raised = Number(l.raisedUsd || l.raised_usdc || 0) / 1e6;
        const progress = Math.min(100, (raised / (Number(l.graduateThresholdUsd || 0) || 1)) * 100);
        return `
        <div style="background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:var(--radius-md); padding:14px 16px; margin-bottom:10px">
          <div style="display:flex; gap:12px; align-items:flex-start; margin-bottom:10px">
            ${l.imageUrl ? `<img src="${escapeHtml(l.imageUrl)}" alt="" style="width:42px; height:42px; border-radius:var(--radius-sm); object-fit:cover" onerror="this.style.display='none'">` : `<div style="width:42px; height:42px; border-radius:var(--radius-sm); background:var(--bg-canvas); display:flex; align-items:center; justify-content:center; font-size:18px">🪙</div>`}
            <div style="flex:1; min-width:0">
              <p style="font-size:13.5px; font-weight:700; color:var(--text-primary)">${escapeHtml(l.name)} <span style="color:var(--text-tertiary); font-weight:400">\$${escapeHtml(l.symbol)}</span></p>
              <div style="display:flex; gap:12px; font-size:10.5px; color:var(--text-tertiary); margin-top:3px">
                <span>⛓ ${escapeHtml(l.chain)}</span>
                <span>💰 MC ${fmtUsd(mcap)}</span>
                <span>👥 ${l.buyersCount ?? l.buyers_count ?? 0}</span>
              </div>
            </div>
            <div style="text-align:right">
              <div style="font-size:13px; font-weight:700; color:var(--accent-green)">${fmtUsd(raised)}</div>
              <div style="font-size:9.5px; color:var(--text-tertiary)">recaudado</div>
            </div>
          </div>
          ${l.description ? `<p style="font-size:11.5px; color:var(--text-secondary); margin-bottom:10px; line-height:1.5">${escapeHtml(String(l.description).slice(0, 140))}</p>` : ""}
          <div style="height:5px; background:var(--bg-canvas); border-radius:3px; overflow:hidden; margin-bottom:10px">
            <div style="height:100%; width:${progress}%; background:linear-gradient(90deg, var(--accent-green), var(--accent-teal, var(--accent-green)))"></div>
          </div>
          <div style="display:flex; gap:8px">
            <button class="btn btn-primary btn-sm" style="flex:1" onclick="window.MarketsEngine.promptBuy(${Number(l.id)}, '${safeAttr(l.symbol)}')">Comprar</button>
            <button class="btn btn-sm" style="flex:1; background:var(--bg-canvas); border:1px solid var(--border-subtle); color:var(--text-secondary)" onclick="window.MarketsEngine.promptSell(${Number(l.id)}, '${safeAttr(l.symbol)}')">Vender</button>
          </div>
        </div>`;
      })
      .join("");
  },
};

// Expose for inline onclick handlers
if (typeof window !== "undefined") {
  window.MarketsEngine = MarketsEngine;
}
