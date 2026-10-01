/**
 * 🎯 TOKEN OVERLAYS — timeline del token sobre el chart del terminal.
 *
 * Primera piedra del Token Workspace V2 (docs/ROADMAP_V2.md §3.4): el chart
 * deja de ser solo precio y pasa a contar la historia del token con marcadores:
 *   🟣 llamada de la pestaña Señales TG (autor + MC entrada, hover verificable)
 *   🔵 tus fills propios (swaps settleados por el backend, /api/trades)
 *   🟢 S smart money observado on-chain (wallet ingestion, gate 24h)
 *   🟡 D ventas del deployer observadas on-chain
 *   🔴 tus ventas
 * Los swaps observados del pool siguen en PoolActivity (flechas cian/rosa).
 *
 * Honesto por diseño: solo dibuja eventos con datos reales guardados (llamadas
 * del canal TG, fills settleados, swaps on-chain observados por el ingester).
 * Nada simulado, nada estimado.
 */

import { ApiClient } from "./api.js";
import { gateHeaders } from "./gate-state.js?v=20261001-4";

const LS_KEY = "trenches_chart_overlays_v1";
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Equivalente al intervalo de velas más cercano hacia abajo (1m..1d). */
export function overlayInterval(seconds) {
  const steps = [86400, 14400, 3600, 900, 300, 60];
  return steps.find((step) => step <= seconds) || 60;
}

/** Agrupa eventos por vela contenedora: un marcador por (time, kind). */
export function overlayMarkers(events, candleTimes, interval) {
  const times = new Set(candleTimes);
  const groups = new Map();
  for (const event of events) {
    const time = Math.floor(event.time / interval) * interval;
    if (!times.has(time)) continue;
    const key = time + ":" + event.kind;
    const group = groups.get(key) || { ...event, time, count: 0 };
    group.count++;
    groups.set(key, group);
  }
  // Formas disjuntas de las del pool (arrowUp/arrowDown): cuadrado = tus fills,
  // círculo = señal. Así el merge nunca descarta un marcador legítimo.
  return [...groups.values()].sort((a, b) => a.time - b.time || a.kind.localeCompare(b.kind)).map((g) => ({
    time: g.time,
    position: g.kind === "signal" || g.kind === "buy" || g.kind === "smart" ? "belowBar" : "aboveBar",
    color: g.kind === "signal" ? "#bba3e9"
      : g.kind === "buy" ? "#87dded"
      : g.kind === "smart" ? "#4ade80"
      : g.kind === "dev" ? "#facc15"
      : "#f38c9a",
    shape: g.kind === "signal" ? "circle" : "square",
    text: g.kind === "signal" ? "📡"
      : g.kind === "buy" ? "C"
      : g.kind === "smart" ? "S"
      : g.kind === "dev" ? "D"
      : "V",
    size: g.kind === "signal" ? 1.1 : 0.7,
  }));
}

export class TokenOverlays {
  constructor() {
    this.events = [];
    this.context = null;
    this.enabled = (() => { try { return localStorage.getItem(LS_KEY) !== "0"; } catch { return true; } })();
  }

  setEnabled(value) {
    this.enabled = Boolean(value);
    try { localStorage.setItem(LS_KEY, this.enabled ? "1" : "0"); } catch { /* private mode */ }
    this.mark();
  }

  /** Cambio de token en el terminal: reinicia y recarga si hay dirección. */
  setToken(chain, token) {
    this.stop();
    if (!chain || !token) return null;
    this.context = { chain, token };
    return this.refresh();
  }

  stop() {
    this.sequence = (this.sequence || 0) + 1;
    clearTimeout(this.timer);
    this.context = null;
    this.events = [];
    this.renderLegend();
  }

  async refresh() {
    if (!this.context) return;
    const context = this.context, sequence = this.sequence = (this.sequence || 0) + 1;
    const results = await Promise.allSettled([
      ApiClient.request(`/api/tg/signals?limit=500&chain=${encodeURIComponent(context.chain)}&caller=`, { headers: gateHeaders() }),
      this._fetchMyTrades(context),
      ApiClient.request(`/api/tokens/${encodeURIComponent(context.chain)}/${encodeURIComponent(context.token)}/onchain-activity?limit=100`, { headers: gateHeaders() }),
    ]);
    if (sequence !== this.sequence || context !== this.context) return;
    const events = [];
    const signals = results[0].status === "fulfilled" ? results[0].value?.signals : null;
    for (const s of Array.isArray(signals) ? signals : []) {
      if (String(s.token).toLowerCase() !== context.token.toLowerCase()) continue;
      const ts = Number(s.ts);
      if (!Number.isFinite(ts) || ts <= 0) continue;
      events.push({ kind: "signal", time: ts, author: String(s.authorName || s.authorId || "call"), entryMcap: s.entryMcap, entryPrice: s.entryPrice });
    }
    const trades = results[1].status === "fulfilled" ? results[1].value?.trades : null;
    // /api/trades devuelve filas crudas del historial (snake_case: buy_token, from_chain, ts).
    for (const t of Array.isArray(trades) ? trades : []) {
      const time = Number(t.time ?? t.ts);
      if (!Number.isFinite(time) || time <= 0) continue;
      if (String(t.from_chain ?? t.fromChain ?? "").toLowerCase() !== context.chain.toLowerCase()) continue;
      const buy = String(t.buyToken ?? t.buy_token ?? "").toLowerCase();
      const sell = String(t.sellToken ?? t.sell_token ?? "").toLowerCase();
      if (buy === context.token.toLowerCase()) events.push({ kind: "buy", time });
      else if (sell === context.token.toLowerCase()) events.push({ kind: "sell", time });
    }
    // Smart money / dev / whale observados on-chain (wallet ingestion, gate 24h).
    const onchain = results[2].status === "fulfilled" ? results[2].value?.swaps : null;
    for (const s of Array.isArray(onchain) ? onchain : []) {
      const time = Number(s.ts);
      if (!Number.isFinite(time) || time <= 0) continue;
      if (String(s.chain ?? context.chain).toLowerCase() !== context.chain.toLowerCase()) continue;
      if (String(s.token ?? "").toLowerCase() !== context.token.toLowerCase()) continue;
      const category = String(s.walletCategory || "watch");
      const kind = category === "dev" ? "dev" : "smart";
      events.push({
        kind, time,
        label: String(s.walletLabel || ""),
        side: String(s.side || ""),
        amountUsd: s.amountUsd != null ? Number(s.amountUsd) : null,
      });
    }
    this.events = events.sort((a, b) => a.time - b.time);
    this.renderLegend();
    this.mark();
    // Refresco suave de las llamadas TG mientras el terminal esté abierto.
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), 120000);
  }

  async _fetchMyTrades(context) {
    if (!ApiClient.isAuthenticated()) return { trades: [] };
    return ApiClient.request("/api/trades?limit=200").catch(() => ({ trades: [] }));
  }

  /** Marcadores propios fusionados con los del pool (PoolActivity manda en su zona). */
  merge(poolMarkers = []) {
    if (!this.enabled) return poolMarkers;
    const tools = window.TradingEngine?.chartTools;
    if (!tools) return poolMarkers;
    const interval = overlayInterval(window.TradingEngine.chartInterval || 300);
    const mine = overlayMarkers(this.events, (tools.data || []).map((row) => row.time), interval);
    // Cada fuente ya agrupa por su propia clave (pool: time+side; overlays: time+kind)
    // y las formas son disjuntas: solo hace falta orden temporal para pintar.
    return [...(poolMarkers || []), ...mine].sort((a, b) => a.time - b.time);
  }

  /** Repinta: pide a PoolActivity que recompute sus marcas y fusione las nuestras. */
  mark() {
    const pool = window.TradingEngine?.poolActivity;
    if (pool?.mark) pool.mark();
    else window.TradingEngine?.chartTools?.setMarkers(this.merge([]));
  }

  renderLegend() {
    const root = document.getElementById("tokenOverlays");
    if (!root) return;
    const counts = { signal: 0, buy: 0, sell: 0, smart: 0, dev: 0 };
    for (const event of this.events) counts[event.kind] = (counts[event.kind] || 0) + 1;
    const chip = (cls, label, n, title) =>
      `<span class="tk ${cls}" title="${title}">${n} ${label}${n === 1 ? "" : "s"}</span>`;
    const parts = [];
    if (counts.signal) parts.push(`<span class="tk tk-signal" title="Llamadas de la pestaña Señales TG">📡 ${counts.signal} ${counts.signal === 1 ? "llamada" : "llamadas"}</span>`);
    if (counts.buy) parts.push(`<span class="tk tk-buy" title="Tus compras settleadas en el backend">🔵 ${counts.buy} ${counts.buy === 1 ? "compra" : "compras"}</span>`);
    if (counts.sell) parts.push(`<span class="tk tk-sell" title="Tus ventas settleadas en el backend">🔴 ${counts.sell} ${counts.sell === 1 ? "venta" : "ventas"}</span>`);
    if (counts.smart) parts.push(`<span class="tk tk-smart" title="Compras de wallets smart money observadas on-chain">🟢 ${counts.smart} smart</span>`);
    if (counts.dev) parts.push(`<span class="tk tk-dev" title="Movimientos del deployer observados on-chain">🟡 ${counts.dev} dev</span>`);
    root.innerHTML = `
      <div class="overlays-legend" role="status" aria-label="Eventos sobre el gráfico">
        <span class="overlays-title">Línea de tiempo</span>
        ${parts.length ? parts.join("") : `<span class="overlays-empty">${this.context ? "Sin llamadas, fills ni actividad on-chain de este token aún" : ""}</span>`}
        <label class="overlays-toggle"><input type="checkbox" data-overlays-toggle ${this.enabled ? "checked" : ""}> Marcadores</label>
      </div>`;
    const toggle = root.querySelector("[data-overlays-toggle]");
    if (toggle) toggle.onchange = () => this.setEnabled(toggle.checked);
  }

  /** Aviso enriquecido para el hover de una llamada (usado por la leyenda/tooltip). */
  static signalTooltip(event) {
    const mc = event.entryMcap != null && Number(event.entryMcap) > 0
      ? ` · MC $${new Intl.NumberFormat("es", { maximumFractionDigits: 0 }).format(Number(event.entryMcap))}` : "";
    return `Llamada de ${esc(event.author || "call")}${mc}`;
  }
}

export const TokenOverlaysEngine = new TokenOverlays();

// PoolActivity fusiona sus marcadores con los nuestros vía window (bajo acoplamiento,
// mismo patrón que el resto de engines del site).
if (typeof window !== "undefined") window.TokenOverlaysEngine = TokenOverlaysEngine;
