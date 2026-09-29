/**
 * 📡 TG SIGNALS — pestaña de llamadas de memes scrapeadas del canal VIP de
 * Telegram (bot scrapperweb3vip_bot, lectura vía API backend /api/tg/signals).
 *
 * Honesto por diseño: el backend scrapea el chat configurado y guarda SOLO lo
 * observado (contrato + ticker + autor + texto + fecha). Sin fuente configurada
 * la pestaña muestra el estado vacío, nunca señales inventadas. Cada fila
 * abre el terminal self-custody con el contrato: TÚ firmas cada operación.
 */

import { ApiClient } from "./api.js";

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function shortAddr(a) {
  return a && a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : String(a ?? "");
}

function timeAgo(ts) {
  const s = Math.max(1, Math.floor(Date.now() / 1000 - ts));
  if (s < 90) return `hace ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 90) return `hace ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 36) return `hace ${h}h`;
  return `hace ${Math.floor(h / 24)}d`;
}

function chainChip(chain) {
  if (chain === "solana") return `<span class="tg-chip tg-sol">◎ Solana</span>`;
  if (chain === "evm") return `<span class="tg-chip tg-evm">EVM</span>`;
  return `<span class="tg-chip tg-unk">¿Cadena?</span>`;
}

export const TgSignalsEngine = {
  chain: "", // "" | solana | evm
  auto: true,
  _timer: null,
  _jumpToken: "",

  async load() {
    const root = document.getElementById("view-tg");
    if (!root) return;
    root.innerHTML = `<div class="tg-loading">📡 Cargando llamadas del canal…</div>`;

    const wrap = (html) => `
      <div class="tg-toolbar">
        <span style="font-size:11px; color:var(--text-tertiary)">
          Llamadas scrapeadas del canal VIP de Telegram · lectura, sin ejecución automática.
        </span>
        <span style="display:flex; gap:8px; align-items:center; flex-wrap:wrap">
          <button class="pill-tab ${this.chain === "" ? "active" : ""}" onclick="window.TgSignalsEngine.setChain('')">Todas</button>
          <button class="pill-tab ${this.chain === "solana" ? "active" : ""}" onclick="window.TgSignalsEngine.setChain('solana')">◎ Solana</button>
          <button class="pill-tab ${this.chain === "evm" ? "active" : ""}" onclick="window.TgSignalsEngine.setChain('evm')">EVM</button>
          <label style="font-size:11px; color:var(--text-tertiary); display:flex; gap:5px; align-items:center; cursor:pointer">
            <input type="checkbox" ${this.auto ? "checked" : ""} onchange="window.TgSignalsEngine.setAuto(this.checked)"> auto
          </label>
          <button class="btn btn-ghost btn-sm" onclick="window.TgSignalsEngine.load()">↻</button>
        </span>
      </div>
      <div id="tgSignalsList">${html}</div>`;

    let data;
    try {
      data = await ApiClient.request(`/api/tg/signals?limit=150${this.chain ? `&chain=${encodeURIComponent(this.chain)}` : ""}`);
    } catch (err) {
      const notConfigured = /TG_NOT_CONFIGURED|not configured/i.test(String(err?.message ?? err));
      root.innerHTML = wrap(`
        <div class="glass-panel-interactive" style="padding:20px; text-align:center">
          <div style="font-size:30px; margin-bottom:8px">📡</div>
          <b>${notConfigured ? "Fuente de Telegram sin configurar" : "No se pudieron cargar las llamadas"}</b>
          <p style="font-size:12px; color:var(--text-tertiary); max-width:520px; margin:8px auto 0">
            ${notConfigured
              ? "El servidor aún no tiene la credencial del bot (TG_BOT_TOKEN + TG_CHAT_ID). Sin fuente no hay llamadas: nunca se inventan."
              : "Error de red o del proveedor. Reintenta en unos segundos."}
          </p>
        </div>`);
      return;
    }

    const signals = data.signals ?? [];
    this._lastTs = signals.length ? Number(signals[0].ts) : 0;

    if (!signals.length) {
      root.innerHTML = wrap(`
        <div class="glass-panel-interactive" style="padding:20px; text-align:center">
          <div style="font-size:30px; margin-bottom:8px">🕐</div>
          <b>Sin llamadas todavía</b>
          <p style="font-size:12px; color:var(--text-tertiary); max-width:520px; margin:8px auto 0">
            Cuando el bot lea llamadas en el canal configurado, aparecerán aquí al momento.
          </p>
        </div>`);
      return;
    }

    root.innerHTML = wrap(
      signals.map((s) => {
        const token = esc(s.token);
        const sym = s.symbol ? esc(s.symbol) : shortAddr(s.token);
        const chatId = String(s.chatId ?? "");
        const msgLink = Number(s.messageId) > 0 && chatId.startsWith("-100")
          ? `https://t.me/c/${chatId.slice(4)}/${Number(s.messageId)}`
          : "";
        const text = esc(String(s.text ?? "").slice(0, 280));
        const chainParam = esc(s.chain ?? "unknown");
        return `
        <div class="glass-panel-interactive tg-row" data-token="${token}" style="padding:12px 14px; margin-bottom:8px">
          <div class="tg-row-top">
            <div style="display:flex; gap:8px; align-items:center; min-width:0">
              <span class="tg-sym">${sym}</span>
              ${chainChip(String(s.chain ?? "unknown"))}
            </div>
            <span class="tg-ago" title="${new Date(Number(s.ts) * 1000).toLocaleString()}">${timeAgo(Number(s.ts))}</span>
          </div>
          <div class="tg-token" title="${token}">${token}</div>
          ${text && text !== token ? `<div class="tg-text">${text}</div>` : ""}
          <div class="tg-row-actions">
            <span class="tg-author">${s.authorName ? `👤 ${esc(s.authorName)}` : ""}</span>
            <span style="display:flex; gap:8px; align-items:center">
              ${msgLink ? `<a class="tg-chip tg-link" href="${esc(msgLink)}" target="_blank" rel="noopener noreferrer">↗ t.me</a>` : ""}
              <button class="btn btn-primary btn-sm" onclick="window.TgSignalsEngine.openTerminal('${token}','${chainParam}','${sym}')">Abrir terminal →</button>
              <button class="btn btn-ghost btn-sm" title="Copiar contrato" onclick="navigator.clipboard.writeText('${token}').then(()=>{this.textContent='✓'; setTimeout(()=>{this.textContent='⧉';},1200)})">⧉</button>
            </span>
          </div>
        </div>`;
      }).join("")
    );
  },

  setChain(chain) {
    this.chain = chain || "";
    this.load();
  },

  setAuto(on) {
    this.auto = !!on;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this.auto && window.App && window.App.currentView === "tg") {
      this._timer = setInterval(() => {
        if (!document.hidden && window.App.currentView === "tg") this.load();
      }, 45_000);
    }
  },

  /** Deep link #tg=<address> → abre el terminal con ese contrato. */
  openSignal(address) {
    if (window.App && window.App.currentView !== "tg") window.App.switchView("tg");
    this.openTerminal(address, "unknown");
  },

  openTerminal(token, chain, symbol) {
    // App.openTradeForToken abre el terminal self-custody; el terminal resuelve
    // el pool real desde la dirección (import on-demand). Sin sesión pide login.
    // La cadena se infiere de la FORMA de la dirección (el scrape guarda la
    // geometría, no la red exacta): base58 → solana; 0x… → ethereum (mejor
    // esfuerzo EVM; el terminal muestra error honesto si el pool no está ahí).
    const inferred = /^0x[0-9a-fA-F]{40}$/.test(token) ? "ethereum"
      : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(token) ? "solana" : "unknown";
    const chainId = chain === "solana" || chain === "evm" || chain === "unknown" ? inferred : (chain || inferred);
    const sym = symbol || "TOKEN";
    if (typeof window.App?.openTradeForToken === "function") {
      window.App.openTradeForToken(sym, chainId, 0, token);
    } else if (typeof window.TradingEngine?.openPair === "function") {
      window.TradingEngine.openPair(token, chainId);
    }
  },
};

window.TgSignalsEngine = TgSignalsEngine;
