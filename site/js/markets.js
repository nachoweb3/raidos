/**
 * 🎯 MARKETS ENGINE — Prediction markets (Polymarket) + Token Launchpad
 * Prediction: real events from /api/prediction/events with category filter,
 * outcome prices. CLOB order placement remains disabled until its
 * non-custodial signing and settlement path is certified.
 * Launchpad: bonding-curve token launches with create/buy/sell.
 * All data real or honestly empty — no invented content.
 */

import { ApiClient } from "./api.js";
import { TokenMeta } from "./tokens.js";

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

/** Shorten a Solana address for display. */
const shortAddr = (s) => `${String(s || "").slice(0, 4)}…${String(s || "").slice(-4)}`;

function parseLabUnits(raw, decimals) {
  if (!/^\d+(\.\d+)?$/.test(raw)) throw new Error("Introduce un importe decimal válido");
  const [whole, fraction = ""] = raw.split(".");
  if (fraction.length > decimals) throw new Error(`Máximo ${decimals} decimales`);
  const amount = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0"));
  if (amount > 18446744073709551615n) throw new Error("Importe demasiado grande");
  return amount;
}

/**
 * Connect Phantom and return the user's pubkey string (self-custody flows).
 * The server refuses any wallet not linked to the signed-in account.
 */
async function connectPhantomWallet() {
  if (!window.solana?.isPhantom) throw new Error("Instala Phantom para operar en LaunchLab (self-custody)");
  if (!window.solana.isConnected || !window.solana.publicKey) {
    await window.solana.connect();
  }
  const wallet = window.solana?.publicKey?.toString();
  if (!wallet) throw new Error("No se pudo obtener la wallet de Phantom");
  return wallet;
}

/**
 * Sign a base64 unsigned tx with Phantom and return the base64 signed tx.
 * Signature happens in the user's wallet — the server never sees keys.
 */
async function signTxWithPhantom(serializedBase64) {
  const { VersionedTransaction } = await import("https://esm.sh/@solana/web3.js@1.98.4");
  const raw = Uint8Array.from(atob(serializedBase64), (c) => c.charCodeAt(0));
  const tx = VersionedTransaction.deserialize(raw);
  const signed = await window.solana.signTransaction(tx);
  const bytes = signed.serialize();
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export const MarketsEngine = {
  container: null,
  subTab: "launchlab",
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
          <button class="btn btn-secondary btn-sm" style="width:100%" disabled title="Firma y liquidación de órdenes aún no verificadas">Solo consulta</button>
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
    alert("Solo consulta: la firma y liquidación de órdenes de predicción aún no están verificadas.");
  },

  /* ══════════ LAUNCHPAD (bonding curve, simulada en el servidor) ══════════ */

  async loadLaunches() {
    this.renderLaunchpadLoading();
    try {
      const data = await ApiClient.getLaunches({ sort: this.launchSort, limit: 30 });
      this.launches = data.launches || [];
      this.renderLaunchpad();
      this.scheduleLaunchRefresh();
    } catch (err) {
      this.renderError(String(err?.message || err), () => this.loadLaunches());
    }
  },

  /** Live board: refresh silently every 8s while the launchpad view is open. */
  scheduleLaunchRefresh() {
    clearTimeout(this._launchTimer);
    this._launchTimer = setTimeout(() => {
      if (!this.container || this.subTab !== "launchpad") return;
      if (document.hidden) { this.scheduleLaunchRefresh(); return; }
      if (document.querySelector("#launchDetailModal.open, #launchCreateModal.open")) {
        this.scheduleLaunchRefresh();
        return;
      }
      this.loadLaunches();
    }, 8000);
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
    closeLaunchModals();
    document.getElementById("launchCreateForm").reset();
    const errBox = document.getElementById("launchCreateError");
    if (errBox) { errBox.style.display = "none"; errBox.textContent = ""; }
    toggleCreateFields();
    document.getElementById("launchCreateModal").classList.add("open");
  },

  async submitCreateLaunch(e) {
    e.preventDefault();
    const get = (id) => (document.getElementById(id)?.value || "").trim();
    const payload = {
      chain: get("lcChain"),
      name: get("lcName"),
      symbol: get("lcSymbol"),
      description: get("lcDescription"),
      imageUrl: get("lcImage"),
      totalSupply: get("lcSupply").replace(/[,_]/g, "") || "1000000000000",
      twitterUrl: get("lcTwitter"),
      telegramUrl: get("lcTelegram"),
      websiteUrl: get("lcWebsite"),
    };
    const btn = document.getElementById("launchCreateSubmit");
    btn.disabled = true;
    try {
      await ApiClient.createLaunch(payload);
      closeLaunchModals();
      this.loadLaunches();
    } catch (err) {
      const box = document.getElementById("launchCreateError");
      box.textContent = "❌ " + String(err?.message || err);
      box.style.display = "block";
    } finally {
      btn.disabled = false;
    }
  },

  /** Token detail sheet: stats + position + trade panel. */
  async openLaunch(launchId) {
    closeLaunchModals();
    const modal = document.getElementById("launchDetailModal");
    document.getElementById("launchDetailBody").innerHTML = `<p style="color:var(--text-tertiary); font-size:12.5px; padding:8px 0">Cargando ficha…</p>`;
    modal.classList.add("open");
    this._detailLaunchId = launchId;
    await this.refreshLaunchDetail();
  },

  async refreshLaunchDetail() {
    const id = this._detailLaunchId;
    if (!id || !document.getElementById("launchDetailModal").classList.contains("open")) return;
    try {
      const [detail, pos, claim, pool] = await Promise.all([
        ApiClient.getLaunch(id),
        ApiClient.isAuthenticated() ? ApiClient.getLaunchPosition(id).catch(() => null) : Promise.resolve(null),
        ApiClient.isAuthenticated() ? ApiClient.getLaunchClaim(id).catch(() => null) : Promise.resolve(null),
        ApiClient.getLaunchPool(id).catch(() => null),
      ]);
      if (this._detailLaunchId !== id) return;
      this._lastPos = pos?.position || null;
      this._lastClaim = claim?.claim || null;
      this._lastPool = pool?.pool || null;
      this._lastLaunch = detail.launch;
      this.renderLaunchDetail(detail.launch, pos?.position || null, detail.curveSimulated !== false);
    } catch (err) {
      if (this._labMint !== mintA || !document.getElementById("launchDetailModal").classList.contains("open")) return;
      document.getElementById("launchDetailBody").innerHTML =
        `<p style="color:var(--text-secondary); font-size:12.5px">No se pudo cargar la ficha</p>`;
    }
  },

  renderLaunchDetail(l, pos, simulated) {
    const mcap = Number(l.marketCapUsdc || 0) / 1e6;
    const raised = Number(l.raisedUsdc || 0) / 1e6;
    const price = Number(l.currentPriceUsdc || 0) / 1e6;
    const progress = Math.min(100, Number(l.progressPct ?? 0));
    const canTrade = (l.status === "created" || l.status === "funding") && !l.distributionLocked && ApiClient.isAuthenticated();
    const held = pos ? Number(pos.tokens) : 0;
    const graduated = l.graduatedOnChain === true;
    const mintLink = l.mintAddress
      ? `<a href="https://solscan.io/token/${encodeURIComponent(l.mintAddress)}" target="_blank" rel="noopener noreferrer" style="color:var(--accent-teal, var(--accent-green)); font-family:monospace">${escapeHtml(String(l.mintAddress).slice(0, 6))}…${escapeHtml(String(l.mintAddress).slice(-6))}</a>`
      : "";
    const body = document.getElementById("launchDetailBody");
    body.innerHTML = `
      ${graduated
        ? `<p style="font-size:10.5px; color:var(--accent-green); background:var(--bg-canvas); border-radius:6px; padding:6px 10px; margin-bottom:12px">🎓 <b>Graduado on-chain:</b> token real emitido (oferta fija) · mint ${mintLink}</p>`
        : simulated ? `<p style="font-size:10px; color:var(--text-tertiary); background:var(--bg-canvas); border-radius:6px; padding:6px 10px; margin-bottom:12px">⚠️ Curva simulada en el servidor: sin contrato on-chain ni custodia de fondos todavía.</p>` : ""}
      <div style="display:flex; gap:12px; align-items:center; margin-bottom:14px">
        ${TokenMeta.logoHtml(l.symbol, { size: 46, round: false, imageUrl: l.imageUrl })}
        <div style="flex:1; min-width:0">
          <p style="font-size:15px; font-weight:700; color:var(--text-primary)">${escapeHtml(l.name)} <span style="color:var(--text-tertiary); font-weight:400">\$${escapeHtml(l.symbol)}</span></p>
          <div style="display:flex; gap:10px; font-size:10.5px; color:var(--text-tertiary); margin-top:3px; flex-wrap:wrap">
            <span>⛓ ${escapeHtml(l.chain)}</span>
            <span>📊 $${price > 0 ? price.toPrecision(3) : "0"}</span>
            <span>💰 FDV ${fmtUsd(mcap)}</span>
            <span>👥 ${l.buyersCount ?? 0}</span>
            ${l.status === "graduated" ? '<span title="Graduado">🎓</span>' : ""}
            ${l.twitterUrl ? `<a href="${escapeHtml(l.twitterUrl)}" target="_blank" rel="noopener noreferrer">𝕏</a>` : ""}
            ${l.telegramUrl ? `<a href="${escapeHtml(l.telegramUrl)}" target="_blank" rel="noopener noreferrer">✈</a>` : ""}
            ${l.websiteUrl ? `<a href="${escapeHtml(l.websiteUrl)}" target="_blank" rel="noopener noreferrer">🌐</a>` : ""}
          </div>
        </div>
      </div>
      ${l.description ? `<p style="font-size:11.5px; color:var(--text-secondary); line-height:1.5; margin-bottom:12px">${escapeHtml(String(l.description).slice(0, 300))}</p>` : ""}
      <div style="display:flex; justify-content:space-between; font-size:10.5px; color:var(--text-tertiary); margin-bottom:4px">
        <span>💰 ${fmtUsd(raised)} recaudado</span><span>meta ${fmtUsd(Number(l.graduateThreshold || 0) / 1e6)}</span>
      </div>
      <div style="height:5px; background:var(--bg-canvas); border-radius:3px; overflow:hidden; margin-bottom:14px">
        <div style="height:100%; width:${progress}%; background:linear-gradient(90deg, var(--accent-green), var(--accent-teal, var(--accent-green)))"></div>
      </div>
      ${pos ? `
      <div style="background:var(--bg-canvas); border-radius:var(--radius-md); padding:10px 14px; margin-bottom:14px; display:flex; gap:16px; flex-wrap:wrap; font-size:11px; color:var(--text-secondary)">
        <span>Tus tokens: <b style="color:var(--text-primary)">${held.toLocaleString("en-US")}</b></span>
        <span>Coste medio: <b style="color:var(--text-primary)">${pos.avgCostUsdc && Number(pos.avgCostUsdc) > 0 ? "$" + (Number(pos.avgCostUsdc) / 1e6).toPrecision(3) : "—"}</b></span>
        <span>Valor hoy: <b style="color:var(--accent-green)">${fmtUsd(Number(pos.valueUsdc || 0) / 1e6)}</b></span>
        <span>PnL ab.: <b style="color:${Number(pos.unrealizedUsdc || 0) >= 0 ? "var(--accent-green)" : "var(--accent-red, #ff5a5f)"}">${fmtUsd(Number(pos.unrealizedUsdc || 0) / 1e6)}</b></span>
      </div>` : ""}
      ${this.renderIssuanceSection(l)}
      ${graduated || l.distributionLocked ? "" : this.renderLaunchClaimSection()}
      ${this.renderPoolSection(l)}
      ${canTrade ? `
      <div style="display:flex; gap:8px; margin-bottom:10px">
        <button class="pill-tab ${this._tradeSide !== "sell" ? "active" : ""}" style="flex:1" onclick="window.MarketsEngine.setLaunchTradeSide('buy')">Comprar</button>
        <button class="pill-tab ${this._tradeSide === "sell" ? "active" : ""}" style="flex:1" ${held > 0 ? "" : "disabled"} onclick="window.MarketsEngine.setLaunchTradeSide('sell')">Vender</button>
      </div>
      <div id="launchTradePresets" style="display:flex; gap:6px; margin-bottom:8px"></div>
      <div style="display:flex; gap:8px; align-items:center; margin-bottom:8px">
        <input id="launchTradeAmount" type="text" inputmode="decimal" placeholder="${this._tradeSide === "sell" ? "Cantidad de tokens" : "Monto en USDC"}" style="flex:1; background:var(--bg-canvas); border:1px solid var(--border-subtle); border-radius:var(--radius-sm); padding:9px 12px; color:var(--text-primary); font-size:13px">
        <button class="btn btn-primary btn-sm" id="launchTradeSubmit" onclick="window.MarketsEngine.submitLaunchTrade()">${this._tradeSide === "sell" ? "Vender" : "Comprar"}</button>
      </div>
      <p id="launchQuoteLine" style="font-size:10.5px; color:var(--text-tertiary); margin-bottom:10px">Introduce un monto para ver la estimación de la curva.</p>` : `
      <p style="font-size:11.5px; color:var(--text-tertiary)">${!ApiClient.isAuthenticated() ? "Conecta tu cuenta para participar en la curva simulada." : l.distributionLocked ? "Distribución bloqueada durante la emisión o revisión on-chain." : "Este token ya no acepta operaciones en la curva."}</p>`}
      <p style="font-size:9.5px; color:var(--text-tertiary); opacity:0.7">La curva vive en la base de datos del servidor: los montos no salen de tu wallet y no existen contratos aún.</p>`;
    this._tradeSide = this._tradeSide || "buy";
    this.setLaunchTradeSide(this._tradeSide);
    if (this._detailTimer) clearInterval(this._detailTimer);
    this._detailTimer = setInterval(() => this.refreshLaunchDetail(), 6000);
  },

  /** Claim section: opt-in wallet that would receive curve holdings on a real migration. */
  renderIssuanceSection(l) {
    const issued = l.graduatedOnChain === true && Boolean(l.mintAddress);
    const states = { not_planned: "Pendiente de emisión", planned: "Distribución preparada", executing: "Emisión en curso", recovery_required: "Emisión pendiente de revisión", failed: "Emisión pendiente de revisión", completed: "Emisión confirmada" };
    const status = issued ? "Emisión confirmada" : states[l.issuanceStatus] || "Pendiente de emisión";
    return `<section class="launch-issuance" aria-label="Estado on-chain"><h3>Estado on-chain</h3>
      <dl><div><dt>Curva</dt><dd>Simulada</dd></div><div><dt>Token Solana</dt><dd>${status}</dd></div><div><dt>Mercado DEX</dt><dd>${issued ? "Consultar disponibilidad" : "Pendiente de token y liquidez"}</dd></div></dl>
      <p>${issued ? "La emisión no garantiza liquidez. Abre el terminal para consultar pools, actividad y rutas disponibles." : l.distributionLocked ? "No se repite la emisión automáticamente. Se conservan las transacciones para comprobar su resultado." : "La distribución solo se envía después de preparar y verificar las wallets receptoras."}</p>
      ${issued ? '<button class="btn btn-primary btn-sm" onclick="window.MarketsEngine.openGraduatedMarket()">Ver mercado del token</button>' : ""}</section>`;
  },

  openGraduatedMarket() {
    const launch = this._lastLaunch;
    if (!launch?.graduatedOnChain || !launch.mintAddress) return;
    closeLaunchModals();
    window.TerminalView?.open(launch.symbol, "solana", 0, launch.mintAddress);
  },

  renderLaunchClaimSection() {
    const claim = this._lastClaim;
    if (!claim) return "";
    const tokens = Number(claim.tokens || 0);
    const short = (w) => `${String(w).slice(0, 4)}…${String(w).slice(-4)}`;
    return `
    <div style="background:var(--bg-canvas); border-radius:var(--radius-md); padding:10px 14px; margin-bottom:14px; font-size:11px; color:var(--text-secondary)">
      <p style="font-weight:700; color:var(--text-primary); margin-bottom:4px">🎁 Reclamo para migración on-chain</p>
      ${claim.wallet
        ? `<p style="margin-bottom:6px">Wallet registrada: <b style="color:var(--text-primary)">${escapeHtml(short(claim.wallet.address))}</b> <span style="color:var(--text-tertiary)">(${escapeHtml(claim.wallet.chain)})</span></p>
           <p style="color:var(--text-tertiary); font-size:10.5px; margin-bottom:8px">Si este token se migra a un contrato real, ${tokens > 0 ? `${tokens.toLocaleString("en-US")} tokens` : "tus tokens netos"} se emitirían a esta wallet.</p>`
        : `<p style="margin-bottom:8px">Registra tu wallet para poder reclamar si el token llega a migrarse on-chain. Requiere firmar un mensaje gratuito (sin gas); la curva sigue siendo simulada.</p>`}
      <button class="btn btn-sm ${claim.wallet ? "" : "btn-primary"}" onclick="window.MarketsEngine.submitLaunchClaim()">${claim.wallet ? "Cambiar wallet" : "Registrar wallet para reclamo"}</button>
    </div>`;
  },

  /** Pool section: post-graduation secondary market (real on-chain reserves). */
  renderPoolSection(l) {
    const pool = this._lastPool;
    if (!pool || l.graduatedOnChain !== true) return "";
    const price = Number(pool.priceTokenInUsdc || 0);
    const rToken = Number(pool.reserveToken || 0);
    const rUsdc = Number(pool.reserveUsdc || 0) / 1e6;
    const live = pool.executionAvailable === true;
    return `
    <div style="background:var(--bg-canvas); border-radius:var(--radius-md); padding:10px 14px; margin-bottom:14px; font-size:11px; color:var(--text-secondary)">
      <p style="font-weight:700; color:var(--text-primary); margin-bottom:4px">🔄 Mercado (pool on-chain real)</p>
      <div style="display:flex; gap:14px; flex-wrap:wrap; margin-bottom:6px">
        <span>Precio: <b style="color:var(--accent-green)">$${price > 0 ? price.toPrecision(3) : "0"}</b></span>
        <span>Lado token: <b>${rToken.toLocaleString("en-US")}</b></span>
        <span>Lado USDC: <b>${fmtUsd(rUsdc)}</b></span>
        ${pool.feeBps ? `<span>Fee: <b>${(pool.feeBps / 100).toFixed(2)}%</b></span>` : ""}
      </div>
      ${live
        ? `<p style="color:var(--text-tertiary); font-size:11px; margin-bottom:8px">🔐 Self-custody: firmas la tx en tu wallet, la pool co-firma su lado solo si todo coincide (reservas verificadas al vuelo, mínimo garantizado on-chain).</p>
           <button class="btn btn-sm btn-primary" onclick="window.MarketsEngine.openPoolSwap()">Operar en la pool</button>`
        : `<p style="color:var(--text-tertiary); font-size:11px; margin-bottom:8px">La ejecución de esta pool no está activada en este servidor; el trading spot está disponible en el terminal.</p>
           <button class="btn btn-sm" disabled>Pool en preparación</button>`}
    </div>`;
  },

  /** Open the pool swap flow: wallet + quote via live reserves, then sign. */
  async openPoolSwap() {
    const pool = this._lastPool;
    const l = this._lastLaunch;
    if (!pool || pool.executionAvailable !== true) return;
    try {
      if (!window.solana?.isConnected || !window.solana.publicKey) {
        await window.solana?.connect?.();
      }
      const wallet = window.solana?.publicKey?.toString();
      if (!wallet) throw new Error("Conecta Phantom para operar en el pool");
      this._poolWallet = wallet;
      const side = prompt("Escribe 'buy' (USDC → token) o 'sell' (token → USDC):", "buy");
      if (side !== "buy" && side !== "sell") return;
      const amountStr = prompt(side === "buy" ? "USDC a gastar (ej. 5):" : "Tokens a vender (ej. 1000):", "");
      if (!amountStr) return;
      const amount = Number(amountStr);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("Monto inválido");
      // Buy: USDC has 6 decimals; sell: the mint has 0 decimals (whole tokens).
      const amountIn = BigInt(Math.round(side === "buy" ? amount * 1e6 : amount)).toString();
      const quote = await ApiClient.quoteLaunchSwap(l.id, { side, amountIn });
      const q = quote.quote;
      const outHuman = side === "buy"
        ? (Number(q.amountOut)).toLocaleString("en-US") + " tokens"
        : "$" + (Number(q.amountOut) / 1e6).toFixed(2);
      const inHuman = side === "buy" ? "$" + (Number(q.amountIn) / 1e6).toFixed(2) : Number(q.amountIn).toLocaleString("en-US") + " tokens";
      const impact = Number(q.priceImpactPct || 0).toFixed(2);
      const ok = confirm(`${side === "buy" ? "Comprar" : "Vender"} por ${inHuman}\n→ Recibes ≈ ${outHuman}\nMínimo garantizado: ${side === "buy" ? Number(q.minOut).toLocaleString("en-US") + " tokens" : "$" + (Number(q.minOut) / 1e6).toFixed(2)}\nImpacto: ${impact}%\nFee: 0.3%\n\nSe abrirá Phantom para firmar. ¿Continuar?`);
      if (!ok) return;
      await this.executePoolSwap(l.id, { side, amountIn: q.amountIn, minOut: q.minOut });
    } catch (err) {
      alert(err?.message || "No se pudo preparar el swap");
    }
  },

  /** Prepare → sign in Phantom → submit for pool co-sign + broadcast. */
  async executePoolSwap(launchId, { side, amountIn, minOut }) {
    const wallet = this._poolWallet;
    if (!wallet) throw new Error("Wallet no conectada");
    const prepared = await ApiClient.prepareLaunchSwap(launchId, { side, amountIn, minOut, wallet });
    // The server sends a legacy unsigned tx with only the pool slot empty;
    // the user is fee payer and first signer.
    const signedTx = await signTxWithPhantom(prepared.serialized);
    localStorage.setItem("inusaur.pool.pending", JSON.stringify({ launchId, sessionId: prepared.sessionId }));
    let result;
    try {
      result = await ApiClient.submitLaunchSwap(launchId, { sessionId: prepared.sessionId, wallet, signedTx });
    } catch (submitErr) {
      // Timeout/connection after signing? The durable session can be recovered.
      try {
        const s = await ApiClient.getPoolSwapSession(launchId, prepared.sessionId);
        alert(`Estado de la operación: ${s.status}${s.signature ? "\nhttps://solscan.io/tx/" + s.signature : ""}`);
        return;
      } catch { throw submitErr; }
    }
    localStorage.removeItem("inusaur.pool.pending");
    alert(`✅ Swap confirmado:\nhttps://solscan.io/tx/${result.signature}`);
    this.refreshLaunchDetail();
  },

  /** Sign a fresh challenge with the user's wallet and register the claim. */
  async submitLaunchClaim() {
    const id = this._detailLaunchId;
    if (!id) return;
    let chain, address, message, signature;
    try {
      if (window.solana?.isPhantom) {
        chain = "solana";
        const resp = await window.solana.connect();
        address = resp.publicKey.toString();
        const ch = await ApiClient.getChallenge("solana");
        const signed = await window.solana.signMessage(new TextEncoder().encode(ch.message), "utf8");
        signature = Array.from(signed.signature).map((b) => b.toString(16).padStart(2, "0")).join("");
        message = ch.message;
      } else if (window.ethereum) {
        chain = "evm";
        const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
        address = accounts[0];
        const ch = await ApiClient.getChallenge("evm");
        signature = await window.ethereum.request({ method: "personal_sign", params: [ch.message, address] });
        message = ch.message;
      } else {
        alert("No se detectó Phantom ni MetaMask. Instala una wallet para registrar el reclamo.");
        return;
      }
      await ApiClient.registerLaunchClaim(id, { chain, address, message, signature });
      await this.refreshLaunchDetail();
    } catch (err) {
      alert("❌ No se pudo registrar el reclamo: " + String(err?.message || err));
    }
  },

  setLaunchTradeSide(side) {
    this._tradeSide = side;
    const presets = document.getElementById("launchTradePresets");
    if (!presets) return;
    if (side === "buy") {
      presets.innerHTML = ["1", "5", "20", "100"].map((v) =>
        `<button class="pill-tab" onclick="window.MarketsEngine.setLaunchPreset('${v}')">${v} USDC</button>`).join("");
    } else {
      const held = Number((this._lastPos || {}).tokens || 0);
      presets.innerHTML = [25, 50, 75, 100].map((p) =>
        `<button class="pill-tab" onclick="window.MarketsEngine.setLaunchPreset('${p}')">${p}%</button>`).join("");
    }
    const submit = document.getElementById("launchTradeSubmit");
    if (submit) submit.textContent = side === "sell" ? "Vender" : "Comprar";
    const input = document.getElementById("launchTradeAmount");
    if (input) input.placeholder = side === "sell" ? "Cantidad de tokens" : "Monto en USDC";
  },

  setLaunchPreset(v) {
    const input = document.getElementById("launchTradeAmount");
    if (!input) return;
    if (this._tradeSide === "sell") {
      const held = Number((this._lastPos || {}).tokens || 0);
      input.value = String(Math.floor(held * Number(v) / 100));
    } else {
      input.value = v;
    }
    input.dispatchEvent(new Event("input"));
  },

  /** Debounced live estimate from the server curve (no mutation). */
  async debouncedLaunchQuote() {
    clearTimeout(this._quoteTimer);
    this._quoteTimer = setTimeout(() => this.fetchLaunchQuote(), 350);
  },

  async fetchLaunchQuote() {
    const id = this._detailLaunchId;
    const input = document.getElementById("launchTradeAmount");
    const line = document.getElementById("launchQuoteLine");
    if (!id || !input || !line) return;
    const raw = (input.value || "").replace(/[,_]/g, "").trim();
    if (!raw || Number(raw) <= 0) {
      line.textContent = "Introduce un monto para ver la estimación de la curva.";
      return;
    }
    try {
      if (this._tradeSide === "buy") {
        const micro = BigInt(Math.round(Number(raw) * 1e6));
        if (micro <= 0n) throw new Error("monto inválido");
        const q = await ApiClient.quoteLaunch(id, "buy", micro.toString());
        const tokens = Number(q.out);
        line.textContent = tokens > 0
          ? `≈ ${tokens.toLocaleString("en-US", { maximumFractionDigits: 0 })} tokens por ${raw} USDC`
          : "Monto demasiado pequeño para la curva (mínimo 0.1 USDC)";
      } else {
        const tokens = BigInt(Math.round(Number(raw)));
        if (tokens <= 0n) throw new Error("cantidad inválida");
        const q = await ApiClient.quoteLaunch(id, "sell", tokens.toString());
        const usdc = Number(q.out) / 1e6;
        line.textContent = usdc > 0
          ? `≈ ${usdc.toFixed(2)} USDC por ${tokens.toLocaleString("en-US")} tokens`
          : "Cantidad demasiado pequeña";
      }
    } catch (err) {
      line.textContent = "Sin estimación: " + String(err?.message || err);
    }
  },

  async submitLaunchTrade() {
    const id = this._detailLaunchId;
    const input = document.getElementById("launchTradeAmount");
    if (!id || !input) return;
    const raw = (input.value || "").replace(/[,_]/g, "").trim();
    const btn = document.getElementById("launchTradeSubmit");
    if (!raw || !(Number(raw) > 0)) {
      alert("Introduce un monto válido");
      return;
    }
    btn.disabled = true;
    try {
      if (this._tradeSide === "buy") {
        const micro = BigInt(Math.round(Number(raw) * 1e6));
        await ApiClient.buyLaunchTokens(id, micro.toString());
      } else {
        await ApiClient.sellLaunchTokens(id, BigInt(Math.round(Number(raw))).toString());
      }
      closeLaunchModals();
      this.loadLaunches();
    } catch (err) {
      alert("❌ " + String(err?.message || err));
    } finally {
      btn.disabled = false;
    }
  },

  closeLaunch() {
    closeLaunchModals();
  },

  /** Old inline actions kept working from cards. */
  async promptBuy(launchId, symbol) {
    this.openLaunch(launchId);
  },

  async promptSell(launchId, symbol) {
    this._tradeSide = "sell";
    this.openLaunch(launchId);
  },

  /* ══════════ LAUNCHLAB (Raydium, real on-chain curve, self-custody) ══════════ */

  setLaunchLabTab(tab) {
    this.subTab = tab;
    this.renderShell();
    if (tab === "launchlab") this.loadLaunchLab();
    else if (tab === "prediction") this.loadPrediction();
    else this.loadLaunches();
  },

  async loadLaunchLab() {
    const el = document.getElementById("marketsList");
    if (el) el.innerHTML = `<p style="color:var(--text-tertiary); font-size:12.5px; padding:20px 0">Cargando launches on-chain…</p>`;
    try {
      const data = await ApiClient.listLaunchLabLaunches(50);
      this._launchlabList = data.launches || [];
      this.renderLaunchLab();
    } catch (err) {
      this.renderError(String(err?.message || err), () => this.loadLaunchLab());
    }
  },

  renderLaunchLab() {
    const el = document.getElementById("marketsList");
    if (!el) return;
    const items = this._launchlabList || [];
    if (!items.length) {
      el.innerHTML = `
        <div style="text-align:center; padding:48px 20px; border:1px dashed var(--border-subtle); border-radius:var(--radius-md)">
          <p style="font-size:26px; margin-bottom:8px">🧪</p>
          <p style="color:var(--text-secondary); font-size:13px; margin-bottom:6px">Aún no hay launches LaunchLab en la plataforma</p>
          <p style="color:var(--text-tertiary); font-size:11.5px; margin-bottom:16px">Curva REAL en el programa de Raydium: el estado vive on-chain y los fondos salen de TU wallet, nunca del servidor.</p>
          <button class="btn btn-primary btn-sm" onclick="window.MarketsEngine.promptLaunchLabCreate()">🧪 Crear token on-chain</button>
        </div>`;
      return;
    }
    el.innerHTML = items.map((l) => `
      <div style="background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:var(--radius-md); padding:14px 16px; margin-bottom:10px; cursor:pointer" onclick="window.MarketsEngine.openLaunchLab('${safeAttr(l.mintA)}')">
        <div style="display:flex; gap:12px; align-items:center">
          ${TokenMeta.logoHtml(l.symbol, { size: 42, round: false })}
          <div style="flex:1; min-width:0">
            <p style="font-size:13.5px; font-weight:700; color:var(--text-primary)">${escapeHtml(l.name)} <span style="color:var(--text-tertiary); font-weight:400">\$${escapeHtml(l.symbol)}</span></p>
            <div style="display:flex; gap:10px; font-size:10.5px; color:var(--text-tertiary); margin-top:3px; flex-wrap:wrap">
              <span title="${escapeHtml(l.mintA)}" style="font-family:monospace">${shortAddr(l.mintA)}</span>
              <span>⛓ Raydium LaunchLab</span>
              <span title="${escapeHtml(l.confirmedSignature || "")}">✅ confirmado${l.confirmedAt ? " " + new Date(l.confirmedAt * 1000).toLocaleDateString("es") : ""}</span>
            </div>
          </div>
          <button class="btn btn-primary btn-sm" onclick="event.stopPropagation(); window.MarketsEngine.openLaunchLab('${safeAttr(l.mintA)}')">Operar</button>
        </div>
      </div>`).join("");
  },

  /** On-chain detail sheet: live curve state + self-custody trade panel. */
  async openLaunchLab(mintA) {
    closeLaunchModals();
    const modal = document.getElementById("launchDetailModal");
    document.getElementById("launchDetailBody").innerHTML = `<p style="color:var(--text-tertiary); font-size:12.5px; padding:8px 0">Cargando estado on-chain…</p>`;
    modal.classList.add("open");
    this._labMint = mintA;
    await this.refreshLaunchLab();
  },

  async refreshLaunchLab() {
    const mintA = this._labMint;
    if (!mintA || !document.getElementById("launchDetailModal").classList.contains("open")) return;
    try {
      const [data, activity] = await Promise.all([
        ApiClient.getLaunchLabState(mintA),
        ApiClient.isAuthenticated()
          ? ApiClient.getLaunchLabActivity(mintA, 10).catch(() => ({ activity: [] }))
          : Promise.resolve({ activity: [] }),
      ]);
      if (this._labMint !== mintA || !document.getElementById("launchDetailModal").classList.contains("open")) return;
      const curveChanged = this._labState?.curveOpen !== data.state.curveOpen;
      this._labState = { ...(this._launchlabList || []).find(l => l.mintA === mintA), ...data.state };
      this._labActivity = activity.activity || [];
      if (!this._labBusy && (curveChanged || document.activeElement?.id !== "labAmount")) this.renderLaunchLabDetail();
      if (data.state.curveOpen === false) this.refreshCpmmPanel();
      if (this._labTimer) clearInterval(this._labTimer);
      this._labTimer = setInterval(() => this.refreshLaunchLab(), 8000);
    } catch (err) {
      if (this._labMint !== mintA || !document.getElementById("launchDetailModal").classList.contains("open")) return;
      document.getElementById("launchDetailBody").innerHTML =
        `<p style="color:var(--accent-red, #ff5a5f); font-size:12px">❌ ${escapeHtml(String(err?.message || err))}</p>`;
    }
  },

  renderLaunchLabDetail() {
    const s = this._labState || {};
    const price = Number(s.priceQuotePerBase || 0);
    const progress = Math.min(100, Number(s.progressPct || 0));
    const sol = (base) => (Number(base || 0) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 3 });
    const sold = Number(s.soldBase || 0) / Math.pow(10, s.mintDecimalsA ?? 6);
    const open = s.curveOpen === true;
    const body = document.getElementById("launchDetailBody");
    body.innerHTML = `
      <div style="display:flex; gap:12px; align-items:center; margin-bottom:14px">
        ${TokenMeta.logoHtml(s.quoteSymbol === "SOL" ? "SOL" : "LL", { size: 46, round: false })}
        <div style="flex:1; min-width:0">
          <p style="font-size:15px; font-weight:700; color:var(--text-primary)">${escapeHtml(s.symbol || "?")} <span style="color:var(--text-tertiary); font-weight:400">${escapeHtml(s.name || "")}</span></p>
          <div style="display:flex; gap:10px; font-size:10.5px; color:var(--text-tertiary); margin-top:3px; flex-wrap:wrap">
            <a href="https://solscan.io/account/${encodeURIComponent(s.poolId || "")}" target="_blank" rel="noopener noreferrer" style="font-family:monospace">pool ${shortAddr(s.poolId)}</a>
            <span>📊 ${price > 0 ? price.toPrecision(4) : "0"} ${escapeHtml(s.quoteSymbol || "SOL")}</span>
            <span>${escapeHtml(s.status || "?")}</span>
          </div>
        </div>
      </div>
      <div style="display:flex; justify-content:space-between; font-size:10.5px; color:var(--text-tertiary); margin-bottom:4px">
        <span>💰 ${sol(s.raisedQuote)} ${escapeHtml(s.quoteSymbol || "SOL")} recaudado</span><span>meta ${sol(s.graduationTargetQuote)}</span>
      </div>
      <div style="height:5px; background:var(--bg-canvas); border-radius:3px; overflow:hidden; margin-bottom:6px">
        <div style="height:100%; width:${progress}%; background:linear-gradient(90deg, var(--accent-green), var(--accent-teal, var(--accent-green)))"></div>
      </div>
      <p style="font-size:9.5px; color:var(--text-tertiary); margin-bottom:14px">Vendidos ${sold.toLocaleString("en-US", { maximumFractionDigits: 0 })} de ${(Number(s.totalSellBase || 0) / Math.pow(10, s.mintDecimalsA ?? 6)).toLocaleString("en-US", { maximumFractionDigits: 0 })} · al completar, Raydium migra el pool a ${escapeHtml(s.migrateType || "cpmm").toUpperCase()} automáticamente.</p>
      ${!open && s.statusRaw === 2 ? `<div id="cpmmSection"></div>` : ""}
      ${open ? `
      <div style="display:flex; gap:8px; margin-bottom:10px">
        <button class="pill-tab ${this._labSide !== "sell" ? "active" : ""}" style="flex:1" onclick="window.MarketsEngine.setLabSide('buy')">Comprar (${escapeHtml(s.quoteSymbol || "SOL")})</button>
        <button class="pill-tab ${this._labSide === "sell" ? "active" : ""}" style="flex:1" onclick="window.MarketsEngine.setLabSide('sell')">Vender</button>
      </div>
      <div id="labPresets" style="display:flex; gap:6px; margin-bottom:8px"></div>
      <div style="display:flex; gap:8px; align-items:center; margin-bottom:8px">
        <input id="labAmount" type="text" inputmode="decimal" placeholder="${this._labSide === "sell" ? "Cantidad de tokens" : "Monto en " + (s.quoteSymbol || "SOL")}" style="flex:1; background:var(--bg-canvas); border:1px solid var(--border-subtle); border-radius:var(--radius-sm); padding:9px 12px; color:var(--text-primary); font-size:13px" oninput="window.MarketsEngine.debouncedLabQuote()">
        <button class="btn btn-primary btn-sm" id="labSubmit" onclick="window.MarketsEngine.submitLabTrade()">${this._labSide === "sell" ? "Vender" : "Comprar"}</button>
      </div>
      <p id="labQuoteLine" style="font-size:10.5px; color:var(--text-tertiary); margin-bottom:10px">Introduce un monto para ver la estimación de la curva real.</p>
      <p style="font-size:10px; color:var(--accent-green); background:var(--bg-canvas); border-radius:6px; padding:6px 10px; margin-bottom:4px">🔐 Self-custody: la tx se construye aquí, la firma TU wallet en Phantom y se envía directo a Solana. El servidor nunca custodia fondos ni claves.</p>`
      : `<p style="font-size:11.5px; color:var(--text-tertiary)">La curva ya no acepta operaciones (estado: ${escapeHtml(s.status || "?")}).${s.migrateType ? " El mercado secundario vive en el pool " + escapeHtml(s.migrateType.toUpperCase()) + " de Raydium." : ""}</p>`}
      ${!open ? '<button class="btn btn-primary btn-sm" style="margin:12px 0" onclick="window.MarketsEngine.openLaunchLabMarket()">Ver mercado y rutas disponibles</button><p style="font-size:10px;color:var(--text-tertiary)">La migraci?n puede tardar. El terminal comprueba los pools y las rutas disponibles para este contrato.</p>' : ""}
      ${this.renderLabActivity()}
      <p style="font-size:9.5px; color:var(--text-tertiary); opacity:0.7">Estado leído del programa LaunchLab (${shortAddr(s.programId)}) vía RPC · se actualiza cada 8s.</p>`;
    this._labSide = this._labSide || "buy";
    this.setLabSide(this._labSide);
  },

  openLaunchLabMarket() {
    const mint = this._labMint;
    if (!mint || this._labState?.curveOpen !== false) return;
    const symbol = this._labState?.symbol || "Token";
    closeLaunchModals();
    window.TerminalView?.open(symbol, "solana", 0, mint);
  },

  /* ══════════ CPMM (mercado real post-graduación, self-custody) ══════════ */

  async refreshCpmmPanel() {
    const mintA = this._labMint;
    const section = document.getElementById("cpmmSection");
    if (!mintA || !section) return;
    try {
      const { state } = await ApiClient.getCpmmState(mintA);
      if (this._labMint !== mintA) return;
      this._cpmmState = state;
      section.innerHTML = this.renderCpmmPanel(state);
      const line = document.getElementById("cpmmQuoteLine");
      if (line && (this._cpmmAmount || "").trim()) this.debouncedCpmmQuote();
    } catch {
      // No CPMM pool for this mint (not migrated): the honest answer is silence
      // in the pool panel; the curve view already explains the status.
      section.innerHTML = "";
    }
  },

  renderCpmmPanel(state) {
    const tok = (v, decimals = 6) => (Number(v || 0) / Math.pow(10, decimals)).toLocaleString("en-US", { maximumFractionDigits: 2 });
    const sol = (v) => (Number(v || 0) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 3 });
    const decimals = state.mintDecimalsA ?? 6;
    const price = Number(state.priceBaseInQuote || 0);
    return `
      <div style="background:var(--bg-canvas); border-radius:var(--radius-md); padding:12px 14px; margin:10px 0">
        <p style="font-size:11px; font-weight:600; color:var(--text-secondary); margin-bottom:6px">🏊 Pool CPMM de Raydium — mercado real</p>
        <div style="display:flex; gap:12px; font-size:10.5px; color:var(--text-tertiary); margin-bottom:10px; flex-wrap:wrap">
          <span>💰 ${price > 0 ? price.toPrecision(4) : "—"} SOL/token</span>
          <span>🪙 ${tok(state.baseReserve, decimals)} tokens</span>
          <span>💧 ${sol(state.quoteReserve)} SOL</span>
          <a href="https://solscan.io/account/${encodeURIComponent(state.poolId)}" target="_blank" rel="noopener noreferrer" style="font-family:monospace">pool ${shortAddr(state.poolId)}</a>
        </div>
        <div style="display:flex; gap:8px; margin-bottom:8px">
          <button class="pill-tab ${this._cpmmSide !== "sell" ? "active" : ""}" style="flex:1" onclick="window.MarketsEngine.setCpmmSide('buy')">Comprar con SOL</button>
          <button class="pill-tab ${this._cpmmSide === "sell" ? "active" : ""}" style="flex:1" onclick="window.MarketsEngine.setCpmmSide('sell')">Vender tokens</button>
        </div>
        <div style="display:flex; gap:8px; align-items:center; margin-bottom:8px">
          <input id="cpmmAmount" type="text" inputmode="decimal" placeholder="${this._cpmmSide === "sell" ? "Cantidad de tokens" : "Monto en SOL"}" value="${this._cpmmAmount || ""}" style="flex:1; background:var(--bg-canvas); border:1px solid var(--border-subtle); border-radius:var(--radius-sm); padding:9px 12px; color:var(--text-primary); font-size:13px" oninput="window.MarketsEngine._cpmmAmount=this.value; window.MarketsEngine.debouncedCpmmQuote()">
          <button class="btn btn-primary btn-sm" id="cpmmSubmit" onclick="window.MarketsEngine.submitCpmmTrade()">${this._cpmmSide === "sell" ? "Vender" : "Comprar"}</button>
        </div>
        <p id="cpmmQuoteLine" style="font-size:10.5px; color:var(--text-tertiary); margin-bottom:10px">Introduce un monto para ver la cotización de la pool real.</p>
        <p style="font-size:10px; color:var(--accent-green); background:var(--bg-canvas); border-radius:6px; padding:6px 10px; margin-bottom:4px">🔐 Self-custody: la tx se construye aquí, la firma TU wallet en Phantom y se envía directo a Solana. El servidor nunca custodia fondos ni claves.</p>
      </div>`;
  },

  setCpmmSide(side) {
    this._cpmmSide = side;
    if (this._cpmmState) {
      const section = document.getElementById("cpmmSection");
      if (section) { section.innerHTML = this.renderCpmmPanel(this._cpmmState); }
    }
  },

  debouncedCpmmQuote() {
    clearTimeout(this._cpmmQuoteTimer);
    this._cpmmQuoteTimer = setTimeout(() => this.fetchCpmmQuote(), 350);
  },

  async fetchCpmmQuote() {
    const mintA = this._labMint;
    const input = document.getElementById("cpmmAmount");
    const line = document.getElementById("cpmmQuoteLine");
    if (!mintA || !input || !line) return;
    const raw = (input.value || "").replace(/[,_]/g, "").trim();
    if (!raw || !(Number(raw) > 0)) {
      line.textContent = "Introduce un monto para ver la cotización de la pool real.";
      return;
    }
    const tok = (v, decimals = 6) => (Number(v || 0) / Math.pow(10, decimals)).toLocaleString("en-US", { maximumFractionDigits: 2 });
    try {
      const decimals = this._cpmmState?.mintDecimalsA ?? 6;
      const amountIn = parseLabUnits(raw, this._cpmmSide === "buy" ? 9 : decimals);
      const { quote } = await ApiClient.quoteCpmm(mintA, { side: this._cpmmSide, amount: amountIn.toString(), slippageBps: this._cpmmSlippageBps || 100 });
      const out = this._cpmmSide === "buy"
        ? `${tok(quote.amountOut, decimals)} tokens`
        : `${(Number(quote.amountOut) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 4 })} SOL`;
      const min = this._cpmmSide === "buy"
        ? `${tok(quote.minOut, decimals)} tokens`
        : `${(Number(quote.minOut) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 4 })} SOL`;
      line.innerHTML = `≈ Recibes <b style="color:var(--text-primary)">${out}</b> · mínimo garantizado ${min} (slippage ${(this._cpmmSlippageBps || 100) / 100}%) · fee pool 0,25%`;
    } catch (err) {
      line.textContent = "Sin estimación: " + String(err?.message || err);
    }
  },

  /** Prepare → sign in Phantom → submit → recovery endpoint on error. */
  async submitCpmmTrade() {
    const mintA = this._labMint;
    const input = document.getElementById("cpmmAmount");
    if (!mintA || !input) return;
    const raw = (input.value || "").replace(/[,_]/g, "").trim();
    if (!raw || !(Number(raw) > 0)) { alert("Introduce un monto válido"); return; }
    if (!ApiClient.isAuthenticated()) { alert("Inicia sesión antes de operar en la pool."); return; }
    const side = this._cpmmSide === "sell" ? "sell" : "buy";
    const btn = document.getElementById("cpmmSubmit");
    btn.disabled = true;
    this._labBusy = true;
    try {
      const wallet = await connectPhantomWallet();
      const decimals = this._cpmmState?.mintDecimalsA ?? 6;
      const amountIn = parseLabUnits(raw, side === "buy" ? 9 : decimals).toString();
      const tok = (v, d = 6) => (Number(v || 0) / Math.pow(10, d)).toLocaleString("en-US", { maximumFractionDigits: 2 });
      const prepared = await ApiClient.prepareCpmmSwap(mintA, { wallet, side, amountIn, slippageBps: this._cpmmSlippageBps || 100 });
      const q = prepared.quote;
      const fmtOut = side === "buy" ? `${tok(q.amountOut, decimals)} tokens` : `${(Number(q.amountOut) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 4 })} SOL`;
      const fmtMin = side === "buy" ? `${tok(q.minOut, decimals)} tokens` : `${(Number(q.minOut) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 4 })} SOL`;
      const ok = confirm(`${side === "buy" ? "Comprar" : "Vender"} en la pool CPMM de Raydium\n→ Recibes ≈ ${fmtOut}\nMínimo garantizado: ${fmtMin}\n\nSe abrirá Phantom para firmar. ¿Continuar?`);
      if (!ok) return;
      const signedTx = await signTxWithPhantom(prepared.serialized);
      localStorage.setItem("inusaur.cpmm.pending", prepared.sessionId);
      let result;
      try {
        result = await ApiClient.submitCpmmSwap(mintA, { wallet, sessionId: prepared.sessionId, signedTx });
      } catch (submitErr) {
        // Timeout/connection after signing? The durable session can be recovered.
        try { const s = await ApiClient.getCpmmSession(prepared.sessionId); alert(`Estado de la operación: ${s.status}${s.signature ? "\nhttps://solscan.io/tx/" + s.signature : ""}`); return; }
        catch { throw submitErr; }
      }
      localStorage.removeItem("inusaur.cpmm.pending");
      alert(`✅ Confirmado on-chain:\n${result.signature}`);
      await this.refreshCpmmPanel();
    } catch (err) {
      alert("❌ " + String(err?.message || err));
    } finally {
      this._labBusy = false;
      if (btn) btn.disabled = false;
    }
  },

  /** The signed-in user's own LaunchLab fills on this mint (server ledger, on-chain is truth). */
  renderLabActivity() {
    const items = this._labActivity || [];
    if (!items.length) return "";
    const decimals = (this._labState || {}).mintDecimalsA ?? 6;
    const rows = items.map((t) => {
      const time = t.ts ? new Date(t.ts * 1000).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" }) : "";
      const color = t.side === "buy" ? "var(--accent-green)" : "var(--accent-red, #ff5a5f)";
      const amountIn = t.side === "buy" ? (Number(t.amountIn) / 1e9).toFixed(3) + " SOL" : (Number(t.amountIn) / Math.pow(10, decimals)).toLocaleString("en-US", { maximumFractionDigits: 2 }) + " tokens";
      return `<div style="display:flex; justify-content:space-between; align-items:center; font-size:10px; color:var(--text-secondary); padding:4px 0; border-bottom:1px solid var(--border-subtle)">
        <span><b style="color:${color}">${t.side === "buy" ? "▲ compra" : "▼ venta"}</b> ${escapeHtml(amountIn)}</span>
        <a href="https://solscan.io/tx/${encodeURIComponent(t.signature)}" target="_blank" rel="noopener noreferrer" style="color:var(--text-tertiary); font-family:monospace">${shortAddr(t.signature)} ${time}</a>
      </div>`;
    }).join("");
    return `<div style="background:var(--bg-canvas); border-radius:var(--radius-md); padding:10px 14px; margin-bottom:14px">
      <p style="font-size:11px; font-weight:600; color:var(--text-secondary); margin-bottom:4px">Tus operaciones en esta curva</p>
      ${rows}
    </div>`;
  },

  setLabSide(side) {
    this._labSide = side;
    const presets = document.getElementById("labPresets");
    if (!presets) return;
    const sym = (this._labState || {}).quoteSymbol || "SOL";
    if (side === "buy") {
      presets.innerHTML = ["0.05", "0.1", "0.5", "1"].map((v) =>
        `<button class="pill-tab" onclick="window.MarketsEngine.setLabPreset('${v}')">${v} ${sym}</button>`).join("");
    } else {
      presets.innerHTML = `<span style="font-size:10px; color:var(--text-tertiary); align-self:center">Escribe la cantidad exacta de tokens a vender (mira tu balance en Phantom)</span>`;
    }
    const submit = document.getElementById("labSubmit");
    if (submit) submit.textContent = side === "sell" ? "Vender" : "Comprar";
    const input = document.getElementById("labAmount");
    if (input) input.placeholder = side === "sell" ? "Cantidad de tokens" : "Monto en " + sym;
  },

  setLabPreset(v) {
    const input = document.getElementById("labAmount");
    if (!input) return;
    input.value = v;
    input.dispatchEvent(new Event("input"));
  },

  debouncedLabQuote() {
    clearTimeout(this._labQuoteTimer);
    this._labQuoteTimer = setTimeout(() => this.fetchLabQuote(), 350);
  },

  async fetchLabQuote() {
    const mintA = this._labMint;
    const input = document.getElementById("labAmount");
    const line = document.getElementById("labQuoteLine");
    if (!mintA || !input || !line) return;
    const raw = (input.value || "").replace(/[,_]/g, "").trim();
    if (!raw || !(Number(raw) > 0)) {
      line.textContent = "Introduce un monto para ver la estimación de la curva real.";
      return;
    }
    try {
      const amountIn = parseLabUnits(raw, this._labSide === "buy" ? 9 : (this._labState || {}).mintDecimalsA ?? 6);
      const { quote } = await ApiClient.quoteLaunchLab(mintA, { side: this._labSide, amount: amountIn.toString(), slippageBps: this._labSlippageBps || 100 });
      const out = this._labSide === "buy"
        ? `${(Number(quote.amountOut) / Math.pow(10, (this._labState || {}).mintDecimalsA ?? 6)).toLocaleString("en-US", { maximumFractionDigits: 2 })} tokens`
        : `${(Number(quote.amountOut) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${this._labState?.quoteSymbol || "SOL"}`;
      const min = this._labSide === "buy"
        ? `${(Number(quote.minOut) / Math.pow(10, (this._labState || {}).mintDecimalsA ?? 6)).toLocaleString("en-US", { maximumFractionDigits: 2 })} tokens`
        : `${(Number(quote.minOut) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${this._labState?.quoteSymbol || "SOL"}`;
      line.innerHTML = `≈ Recibes <b style="color:var(--text-primary)">${out}</b> · mínimo garantizado ${min} (slippage ${(this._labSlippageBps || 100) / 100}%)${quote.totalFeeQuote ? ` · fee curva ${(Number(quote.totalFeeQuote) / 1e9).toFixed(4)} ${this._labState?.quoteSymbol || "SOL"}` : ""}`;
    } catch (err) {
      line.textContent = "Sin estimación: " + String(err?.message || err);
    }
  },

  /** Prepare → sign in Phantom → submit → on-chain confirm. */
  async submitLabTrade() {
    const mintA = this._labMint;
    const input = document.getElementById("labAmount");
    if (!mintA || !input) return;
    const raw = (input.value || "").replace(/[,_]/g, "").trim();
    if (!raw || !(Number(raw) > 0)) {
      alert("Introduce un monto válido");
      return;
    }
    const side = this._labSide === "sell" ? "sell" : "buy";
    const btn = document.getElementById("labSubmit");
    btn.disabled = true;
    this._labBusy = true;
    try {
      const wallet = await connectPhantomWallet();
      const amountIn = parseLabUnits(raw, side === "buy" ? 9 : (this._labState || {}).mintDecimalsA ?? 6).toString();
      const prepared = await ApiClient.prepareLaunchLabSwap(mintA, { wallet, side, amountIn, slippageBps: this._labSlippageBps || 100 });
      const q = prepared.quote;
      const outHuman = side === "buy"
        ? `${(Number(q.amountOut) / Math.pow(10, (this._labState || {}).mintDecimalsA ?? 6)).toLocaleString("en-US", { maximumFractionDigits: 2 })} tokens`
        : `${(Number(q.amountOut) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${this._labState?.quoteSymbol || "SOL"}`;
      const minHuman = side === "buy"
        ? `${(Number(q.minOut) / Math.pow(10, (this._labState || {}).mintDecimalsA ?? 6)).toLocaleString("en-US", { maximumFractionDigits: 2 })} tokens`
        : `${(Number(q.minOut) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${this._labState?.quoteSymbol || "SOL"}`;
      const ok = confirm(`${side === "buy" ? "Comprar" : "Vender"} en la curva LaunchLab\n→ Recibes ≈ ${outHuman}\nMínimo garantizado: ${minHuman}\n\nSe abrirá Phantom para firmar. ¿Continuar?`);
      if (!ok) return;
      const signedTx = await signTxWithPhantom(prepared.serialized);
      localStorage.setItem("inusaur.launchlab.pending", prepared.sessionId);
      const result = await ApiClient.submitLaunchLabSwap(mintA, { wallet, sessionId: prepared.sessionId, signedTx });
      localStorage.removeItem("inusaur.launchlab.pending");
      alert(`✅ Confirmado on-chain:\n${result.signature}`);
      this._labBusy = false;
      await this.refreshLaunchLab();
    } catch (err) {
      alert("❌ " + String(err?.message || err));
    } finally {
      this._labBusy = false;
      btn.disabled = false;
    }
  },

  async recoverLaunchLab() {
    const id = localStorage.getItem("inusaur.launchlab.pending");
    if (!id) return alert("No tienes operaciones pendientes en este navegador.");
    try {
      const result = await ApiClient.request(`/api/launchlab/sessions/${encodeURIComponent(id)}`);
      if (["confirmed", "failed", "not_broadcast"].includes(result.status)) localStorage.removeItem("inusaur.launchlab.pending");
      alert(`Estado: ${result.status}${result.signature ? "\nhttps://solscan.io/tx/" + result.signature : ""}`);
      if (result.status === "confirmed") this.loadLaunchLab();
    } catch (err) { alert(String(err?.message || err)); }
  },

  /** Create-token flow: mint keypair generated + kept in the BROWSER. */
  async promptLaunchLabCreate() {
    document.getElementById("raydiumCreateDialog")?.remove();
    const dialog = document.createElement("dialog");
    dialog.id = "raydiumCreateDialog";
    dialog.className = "raydium-create";
    dialog.innerHTML = `<form id="raydiumCreateForm">
      <div class="raydium-eyebrow">INUSAUR × RAYDIUM / SOLANA</div>
      <h2>Tu próximo lanzamiento.</h2>
      <p>Token con oferta fija de 1.000 millones. Curva en SOL y migración a Raydium CPMM al alcanzar 85 SOL.</p>
      <label>Nombre<input name="name" maxlength="32" required placeholder="Nombre del proyecto"></label>
      <label>Símbolo<input name="symbol" maxlength="10" pattern="[A-Za-z0-9]{1,10}" required placeholder="TOKEN"></label>
      <label>Foto del token<input name="photo" type="file" accept="image/jpeg,image/png,image/webp" required onchange="window.MarketsEngine.selectLaunchPhoto(this)"></label>
      <img data-photo-preview hidden alt="Vista previa del token" width="96" height="96" style="border-radius:16px;object-fit:contain">
      <small>Elige una foto de tu galeria. JPG, PNG o WebP, hasta 12 MB. La optimizamos y alojamos por ti.</small>
      <label>Descripcion<textarea name="description" maxlength="1000" rows="3" placeholder="Cuenta de que trata tu proyecto"></textarea></label>
      <fieldset class="token-socials"><legend>Redes sociales <small>Hasta 4, opcionales</small></legend>
        <label>Enlace 1<input name="social1" type="url" maxlength="300" pattern="https://.*" placeholder="https://x.com/tu_proyecto"></label>
        <label>Enlace 2<input name="social2" type="url" maxlength="300" pattern="https://.*" placeholder="https://t.me/tu_comunidad"></label>
        <label>Enlace 3<input name="social3" type="url" maxlength="300" pattern="https://.*" placeholder="https://discord.gg/tu_servidor"></label>
        <label>Enlace 4<input name="social4" type="url" maxlength="300" pattern="https://.*" placeholder="https://instagram.com/tu_proyecto"></label>
      </fieldset>
      <label>Compra inicial en SOL<input name="buy" type="text" inputmode="decimal" pattern="[0-9]+([.][0-9]{1,9})?" value="0" required></label>
      <small>0 para crear sin comprar. Mínimo de compra: 0,01 SOL. Slippage inicial: 1%. Phantom mostrará la transacción y los costes de red.</small>
      <p id="raydiumCreateError" role="status"></p>
      <div class="raydium-actions"><button type="button" class="btn" onclick="document.getElementById('raydiumCreateDialog').close()">Cerrar</button><button class="btn btn-primary" type="submit">Revisar en Phantom</button></div>
    </form>`;
    document.body.appendChild(dialog);
    dialog.querySelector("form").addEventListener("submit", event => { event.preventDefault(); this.submitLaunchLabCreate(event.target); });
    dialog.showModal();
  },

  async selectLaunchPhoto(input) {
    const file = input.files?.[0], form = input.form;
    if (!file || !form) return;
    const request = form._photoRequest = (form._photoRequest || 0) + 1;
    form._photoData = null;
    const preview = form.querySelector("[data-photo-preview]");
    preview.hidden = true;
    const error = form.querySelector("#raydiumCreateError");
    error.textContent = "";
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    let objectUrl;
    try {
      if (file.size > 12 * 1024 * 1024 || !["image/jpeg","image/png","image/webp"].includes(file.type)) throw Error("Elige una foto JPG, PNG o WebP de hasta 12 MB.");
      objectUrl = URL.createObjectURL(file);
      const image = new Image();
      image.src = objectUrl;
      await image.decode();
      if (image.naturalWidth > 8192 || image.naturalHeight > 8192) throw Error("La foto es demasiado grande. Elige una de hasta 8192 px.");
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 512;
      const context = canvas.getContext("2d");
      context.fillStyle = "#0b1221"; context.fillRect(0,0,512,512);
      const scale = Math.min(512 / image.naturalWidth, 512 / image.naturalHeight);
      const w = image.naturalWidth * scale, h = image.naturalHeight * scale;
      context.drawImage(image,(512-w)/2,(512-h)/2,w,h);
      const data = canvas.toDataURL("image/jpeg",0.88);
      if (data.length > 512 * 1024) throw Error("No se pudo optimizar la foto. Elige otra imagen.");
      if (form._photoRequest !== request) return;
      form._photoData = data;
      preview.src = data; preview.hidden = false;
    } catch (err) {
      if (form._photoRequest === request) { error.textContent = String(err.message || err); input.value = ""; }
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (form._photoRequest === request) button.disabled = false;
    }
  },

  async submitLaunchLabCreate(form) {
    if (!ApiClient.isAuthenticated()) {
      document.getElementById("raydiumCreateError").textContent = "Inicia sesión con tu wallet antes de crear el token.";
      return;
    }
    const values = new FormData(form);
    const name = String(values.get("name"));
    const symbol = String(values.get("symbol"));
    const socials = [1,2,3,4].map(i => String(values.get("social" + i) || "").trim()).filter(Boolean);
    const buySol = String(values.get("buy"));
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      if (!form._photoData) throw Error("Selecciona una foto y espera a ver su vista previa.");
      const buyAmountLamports = parseLabUnits(buySol, 9).toString();
      const wallet = await connectPhantomWallet();
      // Mint keypair is generated in the browser via a throwaway web3 import:
      // only its PUBLIC key goes to the server. The private key never leaves.
      const { Keypair, Transaction } = await import("https://esm.sh/@solana/web3.js@1.98.4");
      const { ed25519 } = await import("https://esm.sh/@noble/curves@1.9.7/ed25519");
      const mintKeypair = Keypair.generate();
      const { uri } = await ApiClient.request("/api/launchlab/metadata", {
        method: "POST", body: JSON.stringify({name:name.trim(),symbol:symbol.trim().toUpperCase(),
          description:String(values.get("description") || ""),socials,image:form._photoData})
      });
      const prepared = await ApiClient.prepareLaunchLabCreate({
        wallet, mintPubkey: mintKeypair.publicKey.toString(), name: name.trim(), symbol: symbol.trim().toUpperCase(), uri: uri.trim(), buyAmountLamports,
      });
      // The browser-held mint keypair signs the EXACT prepared message locally.
      // Some wallets replace the signature list when signing, so afterwards we
      // reconcile: the mint signature is re-attached if the provider dropped it.
      const tx = Transaction.from(Uint8Array.from(atob(prepared.serialized), (c) => c.charCodeAt(0)));
      const messageBytes = new Uint8Array(tx.serializeMessage());
      const mintSignature = tx.serializeMessage().constructor.from(ed25519.sign(messageBytes, mintKeypair.secretKey.slice(0, 32)));
      tx.addSignature(mintKeypair.publicKey, mintSignature);
      const userSigned = await window.solana.signTransaction(tx); // creator signs as fee payer
      if (userSigned?.signatures) {
        const idx = userSigned.signatures.findIndex((s) => s.publicKey.equals(mintKeypair.publicKey));
        if (idx >= 0 && !userSigned.signatures[idx].signature) {
          userSigned.signatures[idx].signature = mintSignature; // provider dropped it; restore
        }
      }
      if (!userSigned.serializeMessage().equals(tx.serializeMessage())) throw new Error("La wallet modificó la transacción preparada");
      const bytes = userSigned.serialize({ requireAllSignatures: true, verifySignatures: true });
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      localStorage.setItem("inusaur.launchlab.pending", prepared.sessionId);
      const result = await ApiClient.confirmLaunchLabCreate({ wallet, sessionId: prepared.sessionId, signedTx: btoa(binary) });
      localStorage.removeItem("inusaur.launchlab.pending");
      document.getElementById("raydiumCreateDialog")?.close();
      alert(`🚀 Token creado on-chain:\nMint: ${result.mint}\nTx: ${result.signature}`);
      this.loadLaunchLab();
    } catch (err) {
      document.getElementById("raydiumCreateError").textContent = String(err?.message || err);
    } finally {
      button.disabled = false;
    }
  },

  /* ══════════ RENDERING ══════════ */

  render() {
    if (!this.container) return;
    this.renderShell();
    if (this.subTab === "prediction") this.loadPrediction();
    else if (this.subTab === "launchlab") this.loadLaunchLab();
    else this.loadLaunches();
  },

  setSubTab(tab, btn) {
    this.setLaunchLabTab(tab, btn);
  },

  /** Jump to the launchpad from anywhere (e.g. Discover search results). */
  viewLaunchpad() {
    this.subTab = "launchlab";
    if (window.App?.switchView) window.App.switchView("markets");
    this.render();
  },

  renderShell() {
    const subtabs = `
      <div class="pill-tabs-bar" style="margin-bottom:16px">
        <button class="pill-tab markets-subtab ${this.subTab === "prediction" ? "active" : ""}" onclick="window.MarketsEngine.setSubTab('prediction', this)">🎯 Predicción</button>
        <button class="pill-tab markets-subtab ${this.subTab === "launchlab" ? "active" : ""}" onclick="window.MarketsEngine.setSubTab('launchlab', this)">Launchpad · Raydium</button>
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
    } else if (this.subTab === "launchlab") {
      this.container.innerHTML = `
        ${subtabs}
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px">
          <div><div class="raydium-eyebrow">INUSAUR × RAYDIUM</div><h2>De idea a mercado.</h2><p style="font-size:12px; color:var(--text-tertiary); margin-top:8px">Lanza en Solana. Opera la curva. Firma desde tu wallet.</p></div>
          <button class="btn btn-primary btn-sm" onclick="window.MarketsEngine.promptLaunchLabCreate()">+ Crear on-chain</button>
        </div>
        <button class="btn btn-sm" style="margin-bottom:16px" onclick="window.MarketsEngine.recoverLaunchLab()">Consultar operación pendiente</button>
        <form style="display:flex;gap:8px;margin-bottom:20px" onsubmit="event.preventDefault();window.MarketsEngine.openLaunchLab(this.elements.mint.value.trim())"><input name="mint" aria-label="Dirección del token LaunchLab" placeholder="Explorar un token LaunchLab por su dirección…" pattern="[1-9A-HJ-NP-Za-km-z]{32,44}" required style="min-width:0;flex:1;background:var(--bg-canvas);color:var(--text-primary);border:1px solid var(--border-subtle);border-radius:8px;padding:10px"><button class="btn btn-sm" type="submit">Explorar</button></form>
        <div id="marketsList"></div>`;
    } else {
      this.container.innerHTML = `
        ${subtabs}
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px">
          <div style="display:flex; gap:8px">
            <button class="pill-tab ${this.launchSort === "latest" ? "active" : ""}" onclick="window.MarketsEngine.setLaunchSort('latest')">Recientes</button>
            <button class="pill-tab ${this.launchSort === "raised" ? "active" : ""}" onclick="window.MarketsEngine.setLaunchSort('raised')">💰 Más recaudado</button>
            <button class="pill-tab ${this.launchSort === "active" ? "active" : ""}" onclick="window.MarketsEngine.setLaunchSort('active')">⏳ En curva</button>
          </div>
          <button class="btn btn-primary btn-sm" onclick="window.MarketsEngine.promptCreateLaunch()">+ Crear token</button>
        </div>
        <p style="font-size:10px; color:var(--text-tertiary); margin-bottom:12px">⚠️ Curva de bonding simulada en el servidor: sin token on-chain ni custodia todavía.</p>
        <div id="marketsList"></div>
        <div style="margin-top:16px">
          <p style="font-size:11px; font-weight:600; color:var(--text-secondary); margin-bottom:8px">Actividad reciente</p>
          <div id="launchActivity" style="display:flex; flex-direction:column; gap:6px"><p style="font-size:10.5px; color:var(--text-tertiary)">Cargando…</p></div>
        </div>`;
    }
  },

  renderPredictionLoading() {
    const el = document.getElementById("marketsList");
    if (el) el.innerHTML = `<p style="color:var(--text-tertiary); font-size:12.5px; padding:20px 0">Cargando mercados de predicción…</p>`;
  },

  renderLaunchpadLoading() {
    const el = document.getElementById("marketsList");
    if (el) el.innerHTML = `<p style="color:var(--text-tertiary); font-size:12.5px; padding:20px 0">Cargando lanzamientos…</p>`;
    this.renderLaunchActivity([]);
    ApiClient.getLaunchActivity(12)
      .then((d) => this.renderLaunchActivity(d.activity || []))
      .catch(() => this.renderLaunchActivity([]));
  },

  renderLaunchActivity(items) {
    const el = document.getElementById("launchActivity");
    if (!el) return;
    if (!items.length) {
      el.innerHTML = `<p style="font-size:10.5px; color:var(--text-tertiary)">Sin operaciones en la curva todavía.</p>`;
      return;
    }
    el.innerHTML = items.map((t) => {
      const usdc = Number(t.usdcAmount || 0) / 1e6;
      const tokens = Number(t.tokenAmount || 0);
      const time = t.ts ? new Date(t.ts * 1000).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" }) : "";
      const color = t.side === "buy" ? "var(--accent-green)" : "var(--accent-red, #ff5a5f)";
      const who = t.traderName ? escapeHtml(t.traderName) : "anon";
      return `<div style="display:flex; justify-content:space-between; align-items:center; font-size:10.5px; color:var(--text-secondary); background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:8px; padding:6px 10px">
        <span style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap"><b style="color:var(--text-primary)">${who}</b> ${t.side === "buy" ? "compró" : "vendió"} <b style="color:var(--text-primary)">${escapeHtml(t.symbol)}</b></span>
        <span style="flex-shrink:0; margin-left:8px"><b style="color:${color}">${t.side === "buy" ? "+" : "−"}${fmtUsd(usdc)}</b> <span style="color:var(--text-tertiary)">· ${tokens.toLocaleString("en-US", { maximumFractionDigits: 0 })} tokens · ${time}</span></span>
      </div>`;
    }).join("");
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
        // API returns micro-USDC units (1e6 = $1) and precomputed progressPct
        const mcap = Number(l.marketCapUsdc || 0) / 1e6;
        const raised = Number(l.raisedUsdc || 0) / 1e6;
        const price = Number(l.currentPriceUsdc || 0) / 1e6;
        const progress = Math.min(100, Number(l.progressPct ?? 0));
        return `
        <div style="background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:var(--radius-md); padding:14px 16px; margin-bottom:10px; cursor:pointer" onclick="window.MarketsEngine.openLaunch(${Number(l.id)})">
          <div style="display:flex; gap:12px; align-items:flex-start; margin-bottom:10px">
            ${TokenMeta.logoHtml(l.symbol, { size: 42, round: false, imageUrl: l.imageUrl })}
            <div style="flex:1; min-width:0">
              <p style="font-size:13.5px; font-weight:700; color:var(--text-primary)">${escapeHtml(l.name)} <span style="color:var(--text-tertiary); font-weight:400">\$${escapeHtml(l.symbol)}</span></p>
              <div style="display:flex; gap:12px; font-size:10.5px; color:var(--text-tertiary); margin-top:3px; flex-wrap:wrap">
                <span>⛓ ${escapeHtml(l.chain)}</span>
                <span>📊 $${price > 0 ? price.toPrecision(3) : "0"}</span>
                <span>💰 FDV ${fmtUsd(mcap)}</span>
                <span>👥 ${l.buyersCount ?? l.buyers_count ?? 0}</span>
                ${l.status === "graduated" ? '<span title="Graduado">🎓</span>' : ""}
                ${l.twitterUrl ? `<a href="${escapeHtml(l.twitterUrl)}" target="_blank" rel="noopener noreferrer" title="X / Twitter" onclick="event.stopPropagation()" style="color:var(--text-tertiary); text-decoration:none">𝕏</a>` : ""}
                ${l.telegramUrl ? `<a href="${escapeHtml(l.telegramUrl)}" target="_blank" rel="noopener noreferrer" title="Telegram" onclick="event.stopPropagation()" style="color:var(--text-tertiary); text-decoration:none">✈</a>` : ""}
                ${l.websiteUrl ? `<a href="${escapeHtml(l.websiteUrl)}" target="_blank" rel="noopener noreferrer" title="Website" onclick="event.stopPropagation()" style="color:var(--text-tertiary); text-decoration:none">🌐</a>` : ""}
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
            <button class="btn btn-primary btn-sm" style="flex:1" onclick="event.stopPropagation(); window.MarketsEngine.openLaunch(${Number(l.id)})">Ficha y trading</button>
            <button class="btn btn-sm" style="flex:1; background:var(--bg-canvas); border:1px solid var(--border-subtle); color:var(--text-secondary)" onclick="event.stopPropagation(); window.MarketsEngine.promptSell(${Number(l.id)}, '${safeAttr(l.symbol)}')">Vender</button>
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

/** Close every launchpad modal and stop its detail refresh timer. */
function closeLaunchModals() {
  MarketsEngine._labMint = null;
  MarketsEngine._cpmmState = null;
  MarketsEngine._cpmmAmount = "";
  clearTimeout(MarketsEngine._labQuoteTimer);
  clearTimeout(MarketsEngine._cpmmQuoteTimer);
  document.getElementById("launchDetailModal")?.classList.remove("open");
  document.getElementById("launchCreateModal")?.classList.remove("open");
  if (MarketsEngine._detailTimer) {
    clearInterval(MarketsEngine._detailTimer);
    MarketsEngine._detailTimer = null;
  }
  if (MarketsEngine._labTimer) {
    clearInterval(MarketsEngine._labTimer);
    MarketsEngine._labTimer = null;
  }
}
