// 🧬 COPY — signal + 1-tap copy trading UI.
// Honest by design: signals are evidence, never auto-execution. Ratings come
// from self-observed on-chain trades with a public formula. Every mirrored
// trade is signed by the user in their own wallet (no custody, ever).
import { ApiClient } from "./api.js";

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
const shortAddr = (a) => (!a ? "" : a.length > 12 ? a.slice(0, 5) + "…" + a.slice(-4) : a);
const fmtUsd = (n) => "$" + Number(n ?? 0).toLocaleString("en-US", { maximumFractionDigits: 0 });

export const CopyEngine = {
  tab: "leaders", // leaders | signals | following | ct
  leaderboard: null,
  ratingCache: new Map(),

  root() { return document.getElementById("copyRoot"); },

  async load() {
    const root = this.root();
    if (!root) return;
    root.innerHTML = '<div style="padding:24px;color:var(--text-secondary)">Cargando…</div>';
    try { this.leaderboard = await ApiClient.request("/api/copy/leaderboard?limit=40"); } catch { this.leaderboard = null; }
    this.render();
  },

  setTab(tab) { this.tab = tab; this.render(); },

  async render() {
    const root = this.root();
    if (!root) return;
    const tabs = [
      ["leaders", "🏆 Traders"], ["ct", "📣 CT Calls"],
      ["signals", "⚡ Señales"], ["following", "🎯 Siguiendo"],
    ].map(([id, label]) =>
      `<button class="pill-tab ${this.tab === id ? "active" : ""}" onclick="window.CopyEngine.setTab('${id}')">${label}</button>`).join("");

    let body = "";
    if (this.tab === "leaders") body = await this.renderLeaders();
    else if (this.tab === "ct") body = await this.renderCt();
    else if (this.tab === "signals") body = await this.renderSignals();
    else body = await this.renderFollowing();

    root.innerHTML = `
      <div style="margin-bottom:16px">
        <h2 style="font-size:22px; font-weight:800; margin-bottom:4px">🧬 Copy Trading</h2>
        <p style="font-size:12.5px; color:var(--text-secondary); max-width:760px">
          Señales de wallets reales observadas on-chain + llamadas de CT. <b>Tú firmas cada trade</b> en tu wallet —
          nunca custodiamos claves ni ejecutamos sin ti. Rating con fórmula pública,
          sin promesas: copiar también copia las pérdidas.
        </p>
      </div>
      <div class="pill-tabs-bar" style="margin-bottom:14px">${tabs}</div>
      ${body}`;
  },

  async renderLeaders() {
    if (!this.leaderboard) {
      return '<div style="padding:20px;color:var(--text-secondary)">Radar de wallets no disponible ahora mismo. Reintenta en un minuto.</div>';
    }
    const { wallets, formula, weights, minTradesForScore, coverage } = this.leaderboard;
    const rows = wallets.map((w, i) => {
      const score = w.score !== null && w.score !== undefined
        ? `<span style="font-weight:800; color:${w.score >= 70 ? "#39ff14" : w.score >= 50 ? "#ffd75e" : "#ff7a7a"}">${w.score}</span>`
        : '<span style="opacity:0.45">—</span>';
      const verdict = w.copyable
        ? '<span style="color:#39ff14">✅ copiable</span>'
        : `<span style="opacity:0.6">${esc(w.verdict)}</span>`;
      return `<div class="token-row" style="display:flex; align-items:center; gap:12px; padding:12px 14px; border-bottom:1px solid var(--border-subtle)">
        <span style="width:26px; opacity:0.5; font-weight:700">${i + 1}</span>
        <div style="flex:1; min-width:0">
          <div style="font-family:monospace; font-size:13px">${esc(shortAddr(w.wallet))} <span style="opacity:0.5">· ${esc(w.chain)}</span></div>
          <div style="font-size:11px; color:var(--text-secondary)">${fmtUsd(w.volumeUsd)} observados · ${w.trades} trades</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:16px">${score}</div>
          <div style="font-size:10.5px">${verdict}</div>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="window.CopyEngine.showRating('${esc(w.chain)}','${esc(w.wallet)}')">Ver</button>
        <button class="btn btn-primary btn-sm" onclick="window.CopyEngine.followPrompt('${esc(w.chain)}','${esc(w.wallet)}')">Copiar</button>
      </div>`;
    }).join("");
    const w = weights ?? {};
    return `
      <div style="font-size:11px; color:var(--text-secondary); margin-bottom:10px">
        Cobertura: ${esc(coverage)} · fórmula <b>${esc(formula)}</b> · score requiere ≥${minTradesForScore} trades observados y posiciones cerradas.
        Pesos: expectativa ${(w.expectancy * 100).toFixed(0)}% · PnL realizado ${(w.realizedShare * 100).toFixed(0)}% · muestra ${(w.sample * 100).toFixed(0)}% · profit factor ${(w.profitFactor * 100).toFixed(0)}% · hold ${(w.holdStyle * 100).toFixed(0)}% · consistencia ${(w.consistency * 100).toFixed(0)}% · concentración ${(w.concentration * 100).toFixed(0)}%
      </div>
      ${rows || '<div style="padding:20px;color:var(--text-secondary)">Aún no hay wallets observadas — el radar lleva unas horas de marcha.</div>'}
      <div id="ratingDetail" style="margin-top:14px"></div>`;
  },

  async showRating(chain, wallet) {
    const box = document.getElementById("ratingDetail");
    if (!box) return;
    box.innerHTML = '<div style="padding:12px;color:var(--text-secondary)">Calculando rating…</div>';
    try {
      const data = await ApiClient.request(`/api/copy/rating/${chain}/${wallet}`);
      const r = data.rating;
      if (!r) { box.innerHTML = '<div style="padding:12px;color:var(--text-secondary)">Sin datos observados aún.</div>'; return; }
      const m = r.metrics;
      box.innerHTML = `<div style="border:1px solid var(--border-subtle); border-radius:12px; padding:16px">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px">
          <b style="font-family:monospace">${esc(shortAddr(wallet))} <span style="opacity:0.5">· ${esc(chain)}</span></b>
          <span style="font-weight:800">${r.score !== null ? r.score + "/100" : "sin score"} — ${esc(r.verdict)}</span>
        </div>
        <div style="font-size:12px; color:var(--text-secondary); line-height:1.7">
          ${r.reasons.map((x) => `• ${esc(x)}`).join("<br>")}
          ${m.avgHoldSeconds ? `<br>• Hold mediano ${(m.avgHoldSeconds / 3600).toFixed(1)}h` : ""}
        </div>
      </div>`;
    } catch { box.innerHTML = '<div style="padding:12px;color:var(--text-secondary)">No se pudo calcular ahora mismo.</div>'; }
  },

  async followPrompt(chain, wallet) {
    const input = prompt(
      "Máximo a invertir POR TRADE copiado (USDC):",
      "10"
    );
    if (input === null) return;
    const maxUsdc = String(Math.round(Number(input) * 1e6));
    if (!/^\d{1,15}$/.test(maxUsdc) || BigInt(maxUsdc) <= 0n) { alert("Importe inválido"); return; }
    try {
      await ApiClient.request("/api/copy/subscriptions", { method: "POST", body: JSON.stringify({ chain, wallet, maxPerTradeUsdc: maxUsdc, mirrorSells: true }) });
      alert(`Siguiendo a ${shortAddr(wallet)}: recibirás señales 1-tap con tope de ${input} USDC por trade.`);
      this.tab = "following"; this.render();
    } catch (e) { alert("No se pudo crear la suscripción: " + (e?.message ?? "error")); }
  },

  async renderCt() {
    let data;
    try { data = await ApiClient.request("/api/copy/ct-calls"); } catch { data = { calls: [] }; }
    const calls = data.calls ?? [];
    if (!calls.length) {
      return `<div style="padding:20px; color:var(--text-secondary)">
        Sin llamadas de CT todavía. El monitor vigila cuentas curadas de Crypto Twitter y registra
        <b>solo tweets con dirección on-chain resoluble</b> — nada de cashtags adivinados.
        Requiere TWITTERAPI_IO_KEY activa en el servidor.
      </div>`;
    }
    return calls.map((c) => {
      const perf = c.performancePct !== null && c.performancePct !== undefined
        ? `<span style="font-weight:800; color:${c.performancePct >= 0 ? "#39ff14" : "#ff7a7a"}">${(c.performancePct * 100).toFixed(1)}%</span>`
        : '<span style="opacity:0.4">—</span>';
      return `<div style="padding:12px 14px; border-bottom:1px solid var(--border-subtle)">
        <div style="display:flex; gap:10px; align-items:center">
          <b>@${esc(c.handle)}</b>
          <span style="opacity:0.5">·</span>
          <span style="font-size:12px">${esc(c.symbol || shortAddr(c.token))} <span style="opacity:0.5">(${esc(c.chain)})</span></span>
          <span style="margin-left:auto">${perf}</span>
          <a class="btn btn-ghost btn-sm" href="${esc(c.tweetUrl)}" target="_blank" rel="noopener">Tweet</a>
        </div>
        <div style="font-size:11.5px; color:var(--text-secondary); margin-top:4px; overflow-wrap:anywhere">${esc(c.excerpt)}</div>
        ${c.priceAtCall ? `<div style="font-size:11px; color:var(--text-secondary); margin-top:2px">precio en la llamada: $${c.priceAtCall.toPrecision(4)}${c.priceNow ? ` → ahora $${c.priceNow.toPrecision(4)}` : ""}</div>` : ""}
      </div>`;
    }).join("") + `<div style="padding:10px; font-size:11px; color:var(--text-secondary)">${esc(data.note ?? "")}</div>`;
  },

  async renderSignals() {
    let data;
    try { data = await ApiClient.request("/api/copy/signals"); } catch { data = { signals: [] }; }
    const signals = data.signals ?? [];
    if (!signals.length) {
      return '<div style="padding:20px;color:var(--text-secondary)">Sin señales aún. Sigue wallets en 🏆 Traders y aparecerán aquí con el trade pre-armado.</div>';
    }
    return signals.map((s) => {
      const who = s.source === "ct" ? `📣 @${esc(s.handle)}` : `👛 ${esc(shortAddr(s.wallet))}`;
      const side = s.side === "buy"
        ? '<span style="color:#39ff14; font-weight:700">COMPRA</span>'
        : '<span style="color:#ff7a7a; font-weight:700">VENTA</span>';
      const maxUsdc = Number(s.maxPerTradeUsdc) / 1e6;
      return `<div style="padding:12px 14px; border-bottom:1px solid var(--border-subtle); display:flex; gap:12px; align-items:center; flex-wrap:wrap">
        <div style="flex:1; min-width:220px">
          <div>${who} ${side} <b>${esc(s.symbol || shortAddr(s.token))}</b> <span style="opacity:0.5">· ${esc(s.chain)}</span></div>
          <div style="font-size:11px; color:var(--text-secondary)">
            ref $${Number(s.refPriceUsd).toPrecision(4)} · tu tope ${maxUsdc} USDC/trade · ${new Date(s.ts * 1000).toLocaleTimeString()}
          </div>
        </div>
        ${s.side === "buy" ? `<button class="btn btn-primary btn-sm" onclick="window.App.openTradeForToken('${esc(s.symbol || shortAddr(s.token))}','${esc(s.chain)}',${Number(s.refPriceUsd)},'${esc(s.token)}')">⚡ 1-TAP</button>` : ""}
      </div>`;
    }).join("");
  },

  async renderFollowing() {
    let data;
    try { data = await ApiClient.request("/api/copy/subscriptions"); } catch { data = { subscriptions: [] }; }
    const subs = data.subscriptions ?? [];
    if (!subs.length) return '<div style="padding:20px;color:var(--text-secondary)">No sigues a nadie todavía. Explora 🏆 Traders o 📣 CT Calls.</div>';
    return subs.map((s) => {
      const isCt = s.chain === "ct";
      const label = isCt ? `@${esc(String(s.wallet).replace(/^@/, ""))}` : esc(shortAddr(s.wallet));
      return `<div style="padding:12px 14px; border-bottom:1px solid var(--border-subtle); display:flex; gap:12px; align-items:center">
        <div style="flex:1">
          <div>${isCt ? "📣" : "👛"} ${label} <span style="opacity:0.5">· ${isCt ? "CT" : esc(s.chain)}</span></div>
          <div style="font-size:11px; color:var(--text-secondary)">tope ${Number(s.max_per_trade_usdc) / 1e6} USDC/trade · ${s.mirror_sells ? "espeja ventas" : "solo compras"}</div>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="window.CopyEngine.toggleSub(${s.id},${s.enabled ? 0 : 1})">${s.enabled ? "Pausar" : "Reanudar"}</button>
        <button class="btn btn-ghost btn-sm" onclick="window.CopyEngine.deleteSub(${s.id})">Eliminar</button>
      </div>`;
    }).join("");
  },

  async toggleSub(id, enabled) {
    try { await ApiClient.request(`/api/copy/subscriptions/${id}`, { method: "PATCH", body: JSON.stringify({ enabled: !!enabled }) }); this.render(); }
    catch (e) { alert(e?.message ?? "error"); }
  },
  async deleteSub(id) {
    if (!confirm("¿Dejar de seguir esta wallet?")) return;
    try { await ApiClient.request(`/api/copy/subscriptions/${id}`, { method: "DELETE" }); this.render(); }
    catch (e) { alert(e?.message ?? "error"); }
  },
};
