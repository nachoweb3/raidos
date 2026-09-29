/**
 * 📡 TG SIGNALS — pestaña de llamadas de memes scrapeadas del canal VIP de
 * Telegram (bot scrapperweb3vip_bot, lectura vía API backend /api/tg/signals).
 *
 * Honesto por diseño: el backend scrapea los chats observados y guarda SOLO lo
 * verificado (contrato + ticker + autor + texto + fecha + precio entrada).
 * Con DexFeed en vivo muestra precio actual, MCap y ROI/multiplicador desde la
 * llamada. Cada fila abre el terminal self-custody con el contrato: TÚ firmas cada operación.
 *
 * v2 — Filtros de tiempo (1h/6h/12h/24h/7d/30d), logos de tokens, avatares de callers.
 */

import { ApiClient } from "./api.js";
import { DexFeed } from "./dexfeed.js?v=20260928-6";

// ─── Helpers de formato ─────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function shortAddr(a) {
  return a && a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : String(a ?? "");
}

function timeAgo(ts) {
  const s = Math.max(1, Math.floor(Date.now() / 1000 - ts));
  if (s < 90) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 36) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function chainChip(chain) {
  const c = String(chain ?? "");
  const map = {
    bsc: ["🟡 BSC", "tg-evm"], base: ["🔵 Base", "tg-evm"],
    ethereum: ["Ξ ETH", "tg-evm"], arbitrum: ["Arb", "tg-evm"],
    polygon: ["POL", "tg-evm"], avalanche: ["AVAX", "tg-evm"],
    solana: ["◎ SOL", "tg-sol"],
  };
  const entry = map[c];
  if (entry) return `<span class="tg-chip ${entry[1]}">${entry[0]}</span>`;
  if (c === "evm") return `<span class="tg-chip tg-evm">EVM</span>`;
  return `<span class="tg-chip tg-unk">?</span>`;
}

function formatPrice(p) {
  const n = Number(p);
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n < 0.000001) return "$" + n.toExponential(2);
  if (n < 0.01) return "$" + n.toFixed(6);
  if (n < 1) return "$" + n.toFixed(4);
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatMcap(m) {
  const n = Number(m);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
  return "$" + n.toFixed(0);
}

function formatPercent(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) return "";
  const sign = n > 0 ? "+" : "";
  const cls = n > 0 ? "tg-delta-pos" : n < 0 ? "tg-delta-neg" : "tg-delta-zero";
  return `<span class="tg-delta ${cls}">${sign}${n.toFixed(1)}%</span>`;
}

function formatRoi(entryPrice, currentPrice) {
  const e = Number(entryPrice);
  const c = Number(currentPrice);
  if (!Number.isFinite(e) || e <= 0 || !Number.isFinite(c) || c <= 0) return "";
  const mult = c / e;
  const pct = ((c - e) / e) * 100;
  const cls = mult >= 1 ? "tg-roi-pos" : "tg-roi-neg";
  const sign = pct >= 0 ? "+" : "";
  return `<span class="tg-roi-badge ${cls}" title="Entrada: ${formatPrice(e)} · Actual: ${formatPrice(c)}">
    <span class="tg-roi-mult">${mult.toFixed(2)}x</span>
    <span class="tg-roi-pct">${sign}${pct.toFixed(1)}%</span>
  </span>`;
}

function getMarketData(token, chain) {
  if (!token) return null;
  const ch = chain && chain !== "unknown" && chain !== "evm" ? chain : (/^0x/i.test(token) ? "ethereum" : "solana");
  const direct = DexFeed.cache?.[DexFeed._key(ch, token)];
  if (direct) return direct;
  return DexFeed.get?.(token, ch) || DexFeed.get?.(token) || null;
}

/** Genera una URL de logo para el token desde DexScreener CDN. */
function tokenLogoUrl(token, chain) {
  if (!token) return null;
  const ch = chain && chain !== "unknown" && chain !== "evm" ? chain : (/^0x/i.test(token) ? "ethereum" : "solana");
  // DexScreener CDN — disponible para la mayoría de tokens conocidos
  return `https://dd.dexscreener.com/ds-data/tokens/${ch}/${token.toLowerCase()}.png`;
}

/** Genera un avatar con iniciales para callers sin foto. */
function initialsAvatar(name) {
  const n = String(name || "?").replace(/^@/, "").trim();
  const initials = n.length > 1 ? n.slice(0, 2).toUpperCase() : n.toUpperCase();
  // Colores suaves deterministas
  const colors = ["#6366f1","#8b5cf6","#ec4899","#f59e0b","#10b981","#3b82f6","#ef4444"];
  const color = colors[n.charCodeAt(0) % colors.length];
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36"><circle cx="18" cy="18" r="18" fill="${color}"/><text x="18" y="23" text-anchor="middle" font-family="system-ui,sans-serif" font-size="13" font-weight="700" fill="white">${initials}</text></svg>`)}`;
}

// ─── Caché de avatares en memoria ───────────────────────────────────────────
const _avatarCache = new Map(); // authorId → url | null

async function fetchAvatar(authorId) {
  if (!authorId || authorId === "0") return null;
  if (_avatarCache.has(authorId)) return _avatarCache.get(authorId);
  _avatarCache.set(authorId, null); // optimistic null para evitar dobles llamadas
  try {
    const res = await ApiClient.request(`/api/tg/avatar/${encodeURIComponent(authorId)}`);
    const url = res.url ?? null;
    _avatarCache.set(authorId, url);
    return url;
  } catch {
    return null;
  }
}

// ─── Configuración de filtros de tiempo ────────────────────────────────────
const TIME_FILTERS = [
  { key: "all",  label: "Todas",   since: 0 },
  { key: "1h",   label: "1h",      since: 3_600 },
  { key: "6h",   label: "6h",      since: 21_600 },
  { key: "12h",  label: "12h",     since: 43_200 },
  { key: "24h",  label: "24h",     since: 86_400 },
  { key: "7d",   label: "7d",      since: 604_800 },
  { key: "30d",  label: "30d",     since: 2_592_000 },
];

// ─── Motor principal ─────────────────────────────────────────────────────────
export const TgSignalsEngine = {
  chain: "",
  caller: "",
  callers: [],
  showCallers: false,
  timeFilter: "all", // key de TIME_FILTERS
  auto: true,
  _timer: null,
  _jumpToken: "",

  async load() {
    const root = document.getElementById("view-tg");
    if (!root) return;
    if (!root.querySelector(".tg-toolbar")) {
      root.innerHTML = `<div class="tg-loading">📡 Cargando llamadas del canal…</div>`;
    }

    // Callers analytics en paralelo
    try {
      const callersRes = await ApiClient.request("/api/tg/callers?limit=30");
      this.callers = callersRes.callers ?? [];
    } catch {
      this.callers = [];
    }

    const tf = TIME_FILTERS.find((f) => f.key === this.timeFilter) ?? TIME_FILTERS[0];
    const since = tf.since > 0 ? Math.floor(Date.now() / 1000) - tf.since : 0;

    const wrap = (html) => `
      <div class="tg-toolbar">
        <div class="tg-toolbar-row">
          <span class="tg-toolbar-label">📡 Señales TG · ROI en vivo</span>
          <span style="display:flex; gap:6px; align-items:center">
            <button class="btn btn-ghost btn-sm" onclick="window.TgSignalsEngine.load()" title="Actualizar">↻</button>
            <label style="font-size:11px; color:var(--text-tertiary); display:flex; gap:5px; align-items:center; cursor:pointer">
              <input type="checkbox" ${this.auto ? "checked" : ""} onchange="window.TgSignalsEngine.setAuto(this.checked)"> auto
            </label>
          </span>
        </div>
        <div class="tg-toolbar-row tg-filter-row">
          <div class="tg-filter-group">
            ${["", "solana", "evm"].map((c) => `
              <button class="tg-filter-btn ${this.chain === c ? "active" : ""}" onclick="window.TgSignalsEngine.setChain('${c}')">
                ${c === "" ? "Todas" : c === "solana" ? "◎ Solana" : "EVM"}
              </button>`).join("")}
          </div>
          <div class="tg-filter-group">
            ${TIME_FILTERS.map((f) => `
              <button class="tg-filter-btn tg-time-btn ${this.timeFilter === f.key ? "active" : ""}" onclick="window.TgSignalsEngine.setTimeFilter('${f.key}')">
                ${f.label}
              </button>`).join("")}
          </div>
          <button class="tg-filter-btn ${this.showCallers ? "active" : ""}" onclick="window.TgSignalsEngine.toggleCallers()" title="Analíticas de callers">
            📊 Callers ${this.callers.length ? `(${this.callers.length})` : ""}
          </button>
        </div>
      </div>
      ${this.caller ? `
        <div class="tg-caller-banner">
          <span>Filtrando por caller: <b>${esc(this.caller)}</b></span>
          <button class="btn btn-ghost btn-xs" onclick="window.TgSignalsEngine.setCaller('')">✕ Ver todas</button>
        </div>` : ""}
      ${this.showCallers ? this.renderCallersPanel() : ""}
      <div id="tgSignalsList">${html}</div>`;

    let data;
    try {
      let url = `/api/tg/signals`;
      const params = new URLSearchParams();
      if (since > 0) params.set("since", String(since));
      if (this.chain) params.set("chain", this.chain);
      if (this.caller) params.set("caller", this.caller);
      if (params.toString()) url += "?" + params.toString();
      data = await ApiClient.request(url);
    } catch (err) {
      const notConfigured = /TG_NOT_CONFIGURED|not configured/i.test(String(err?.message ?? err));
      root.innerHTML = wrap(`
        <div class="glass-panel-interactive" style="padding:20px; text-align:center">
          <div style="font-size:30px; margin-bottom:8px">📡</div>
          <b>${notConfigured ? "Fuente de Telegram sin configurar" : "No se pudieron cargar las llamadas"}</b>
          <p style="font-size:12px; color:var(--text-tertiary); max-width:520px; margin:8px auto 0">
            ${notConfigured
              ? "El servidor aún no tiene la credencial del bot (TG_BOT_TOKEN). Sin fuente no hay llamadas."
              : "Error de red o del proveedor. Reintenta en unos segundos."}
          </p>
        </div>`);
      return;
    }

    const signals = data.signals ?? [];
    this._lastTs = signals.length ? Number(signals[0].ts) : 0;

    if (!signals.length) {
      root.innerHTML = wrap(`
        <div class="glass-panel-interactive" style="padding:32px 20px; text-align:center">
          <div style="font-size:36px; margin-bottom:10px">🕐</div>
          <b>${this.caller ? `Sin llamadas para ${esc(this.caller)}` : tf.key !== "all" ? `Sin llamadas en las últimas ${tf.label}` : "Sin llamadas todavía"}</b>
          <p style="font-size:12px; color:var(--text-tertiary); max-width:520px; margin:8px auto 0">
            ${this.caller
              ? `Este caller aún no tiene llamadas registradas con los filtros actuales.`
              : tf.key !== "all"
                ? `No hay señales en este período. Prueba un rango mayor.`
                : `Cuando el bot lea llamadas en los canales observados, aparecerán aquí.`}
          </p>
          ${this.caller ? `<button class="btn btn-ghost btn-sm" style="margin-top:10px" onclick="window.TgSignalsEngine.setCaller('')">Ver todas las llamadas</button>` : ""}
        </div>`);
      return;
    }

    // Enrich con datos de mercado vía DexFeed
    if (typeof DexFeed?.ensureTokens === "function") {
      const refs = signals.map((s) => {
        let ch = s.chain;
        if (!ch || ch === "unknown") ch = /^0x/i.test(s.token) ? "ethereum" : "solana";
        else if (ch === "evm") ch = "ethereum";
        return { chain: ch, address: s.token };
      });
      try { await DexFeed.ensureTokens(refs); } catch {}
    }

    // Contar por período para mostrar el badge
    const periodLabel = tf.key !== "all" ? `${signals.length} calls · ${tf.label}` : `${signals.length} calls`;

    root.innerHTML = wrap(`
      <div class="tg-count-bar">
        <span class="tg-count-badge">📊 ${periodLabel}</span>
        ${since > 0 ? `<span style="font-size:11px;color:var(--text-tertiary)">desde ${new Date(since * 1000).toLocaleString()}</span>` : ""}
      </div>
      ${signals.map((s) => this._renderCard(s)).join("")}
    `);

    // Cargar avatares de manera lazy después del render
    this._loadAvatarsLazy(signals);
  },

  /** Renderiza una card individual de señal. */
  _renderCard(s) {
    const token = esc(s.token);
    const sym = s.symbol ? esc(s.symbol) : shortAddr(s.token);
    const chatId = String(s.chatId ?? "");
    const msgLink = Number(s.messageId) > 0 && chatId.startsWith("-100")
      ? `https://t.me/c/${chatId.slice(4)}/${Number(s.messageId)}`
      : "";
    const text = esc(String(s.text ?? "").slice(0, 300));
    const chainParam = esc(s.chain ?? "unknown");
    const author = s.authorName || s.authorId;
    const authorDisplay = author ? esc(author) : "";
    const entryPrice = s.entryPrice != null ? Number(s.entryPrice) : null;
    const entryMcap = s.entryMcap != null ? Number(s.entryMcap) : null;

    const market = getMarketData(s.token, s.chain);
    const currentPrice = market?.priceUsd > 0 ? market.priceUsd : null;
    const mcap = market?.mcap || market?.fdv || entryMcap;
    const change24h = market?.change24h;

    const logoUrl = tokenLogoUrl(s.token, s.chain);
    const avatarId = `tg-avatar-${esc(s.authorId)}`;

    // Avatar placeholder — se rellena lazy
    const avatarHtml = `<img
      class="tg-caller-avatar"
      id="${avatarId}"
      src="${initialsAvatar(author)}"
      alt="${authorDisplay}"
      onerror="this.src='${initialsAvatar(author)}'"
    />`;

    // Logo del token placeholder — falla silenciosamente
    const logoHtml = `<img
      class="tg-token-logo"
      src="${logoUrl}"
      alt="${sym}"
      onerror="this.style.display='none'"
    />`;

    const roiHtml = entryPrice && currentPrice ? formatRoi(entryPrice, currentPrice)
      : entryPrice ? `<span class="tg-entry-only">Entrada: ${formatPrice(entryPrice)}</span>` : "";

    const priceHtml = currentPrice ? `
      <div class="tg-metrics-group">
        <span class="tg-price-badge">${formatPrice(currentPrice)}</span>
        ${mcap ? `<span class="tg-mcap-badge">${formatMcap(mcap)}</span>` : ""}
        ${change24h != null ? formatPercent(change24h) : ""}
      </div>` : "";

    const isActiveAuthor = this.caller && (this.caller === s.authorName || this.caller === s.authorId);

    return `
    <div class="tg-card glass-panel-interactive" data-token="${token}">
      <div class="tg-card-header">
        <div class="tg-card-left">
          ${avatarHtml}
          <div class="tg-card-title">
            <div class="tg-card-sym-row">
              ${logoHtml}
              <span class="tg-sym">$${sym}</span>
              ${chainChip(String(s.chain ?? "unknown"))}
            </div>
            ${authorDisplay ? `
              <span
                class="tg-author-pill ${isActiveAuthor ? "active" : ""}"
                onclick="window.TgSignalsEngine.setCaller('${esc(author)}')"
                title="Filtrar por este caller"
              >👤 ${authorDisplay}</span>` : ""}
          </div>
        </div>
        <div class="tg-card-right">
          ${roiHtml}
          <span class="tg-ago" title="${new Date(Number(s.ts) * 1000).toLocaleString()}">
            🕐 ${timeAgo(Number(s.ts))}
          </span>
        </div>
      </div>

      ${priceHtml ? `<div class="tg-card-metrics">${priceHtml}</div>` : ""}

      <div class="tg-token-addr" title="${token}">${token}</div>

      ${text && text !== token && text !== `$${sym}` ? `<div class="tg-text">${text}</div>` : ""}

      <div class="tg-card-footer">
        <div style="display:flex; gap:6px; align-items:center">
          ${msgLink ? `<a class="tg-chip tg-link" href="${esc(msgLink)}" target="_blank" rel="noopener noreferrer">↗ t.me</a>` : ""}
        </div>
        <div style="display:flex; gap:6px; align-items:center">
          <button class="btn btn-ghost btn-sm" title="Copiar contrato"
            onclick="navigator.clipboard.writeText('${token}').then(()=>{this.textContent='✓';setTimeout(()=>{this.textContent='⧉';},1200)})">⧉</button>
          <button class="btn btn-primary btn-sm"
            onclick="window.TgSignalsEngine.openTerminal('${token}','${chainParam}','${sym}',${currentPrice || entryPrice || 0})">
            Abrir →
          </button>
        </div>
      </div>
    </div>`;
  },

  /** Carga avatares en background y actualiza las imágenes ya renderizadas. */
  async _loadAvatarsLazy(signals) {
    // Recopilar authorIds únicos que no sean "0"
    const ids = [...new Set(signals.map((s) => s.authorId).filter((id) => id && id !== "0"))];
    await Promise.allSettled(ids.map(async (id) => {
      const url = await fetchAvatar(id);
      if (!url) return;
      // Actualizar todos los elementos con este authorId
      document.querySelectorAll(`#tg-avatar-${CSS.escape(id)}`).forEach((el) => {
        if (el instanceof HTMLImageElement) el.src = url;
      });
    }));
  },

  renderCallersPanel() {
    if (!this.callers.length) {
      return `
        <div class="tg-callers-panel">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px">
            <b>📊 Analíticas de Callers</b>
            <button class="btn btn-ghost btn-xs" onclick="window.TgSignalsEngine.toggleCallers()">✕</button>
          </div>
          <p style="font-size:12px; color:var(--text-tertiary); margin:0">Aún no hay suficientes llamadas para rankear callers.</p>
        </div>`;
    }
    return `
      <div class="tg-callers-panel">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px">
          <b>📊 Callers (${this.callers.length})</b>
          <button class="btn btn-ghost btn-xs" onclick="window.TgSignalsEngine.toggleCallers()">✕ Cerrar</button>
        </div>
        <div class="tg-callers-grid">
          ${this.callers.map((c) => {
            const name = esc(c.authorName || `Autor ${c.authorId}`);
            const isSelected = this.caller && (this.caller === c.authorName || this.caller === c.authorId);
            const chainsStr = (c.chains ?? []).map((ch) => chainChip(ch)).join(" ");
            const latestTokensStr = (c.latestTokens ?? []).map((t) => esc(t.symbol || shortAddr(t.token))).join(", ");
            const avatarSrc = _avatarCache.get(c.authorId) || initialsAvatar(c.authorName || c.authorId);
            return `
              <div class="tg-caller-card ${isSelected ? "active" : ""}">
                <div style="display:flex; align-items:center; gap:8px">
                  <img class="tg-caller-avatar-sm" src="${avatarSrc}" alt="${name}"
                    onerror="this.src='${initialsAvatar(c.authorName || c.authorId)}'"/>
                  <div style="min-width:0">
                    <div style="font-weight:700; color:#fff; font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${name}</div>
                    <div style="font-size:11px; color:#f59e0b; font-weight:800">${c.totalCalls} llamadas</div>
                  </div>
                </div>
                <div style="display:flex; gap:4px; flex-wrap:wrap; font-size:11px; margin-top:4px">
                  ${chainsStr || '<span style="color:var(--text-tertiary)">—</span>'}
                </div>
                ${latestTokensStr ? `<div style="font-size:11px; color:var(--text-secondary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap" title="${latestTokensStr}">${latestTokensStr}</div>` : ""}
                <div style="display:flex; justify-content:space-between; align-items:center; margin-top:6px">
                  <span style="font-size:10.5px; color:var(--text-tertiary)">${timeAgo(c.lastCallTs)}</span>
                  <button class="btn ${isSelected ? "btn-secondary" : "btn-primary"} btn-xs"
                    onclick="window.TgSignalsEngine.setCaller('${esc(c.authorName || c.authorId)}')">
                    ${isSelected ? "✓" : "Ver →"}
                  </button>
                </div>
              </div>`;
          }).join("")}
        </div>
      </div>`;
  },

  setChain(chain) { this.chain = chain || ""; this.load(); },
  setTimeFilter(key) { this.timeFilter = key; this.load(); },
  setCaller(caller) {
    this.caller = this.caller === caller ? "" : (caller || "");
    this.load();
  },
  toggleCallers() { this.showCallers = !this.showCallers; this.load(); },

  setAuto(on) {
    this.auto = !!on;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this.auto && window.App && window.App.currentView === "tg") {
      this._timer = setInterval(() => {
        if (!document.hidden && window.App.currentView === "tg") this.load();
      }, 45_000);
    }
  },

  openSignal(address) {
    if (window.App && window.App.currentView !== "tg") window.App.switchView("tg");
    this.openTerminal(address, "unknown");
  },

  openTerminal(token, chain, symbol, priceUsd) {
    const inferred = /^0x[0-9a-fA-F]{40}$/.test(token) ? "ethereum"
      : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(token) ? "solana" : "unknown";
    const specificEvm = !!chain && isEvmFamily(chain) && chain !== "evm";
    const chainId = specificEvm ? chain : inferred;
    const sym = symbol || "TOKEN";
    const price = Number(priceUsd) > 0 ? Number(priceUsd) : 0;
    if (typeof window.App?.openTradeForToken === "function") {
      window.App.openTradeForToken(sym, chainId, price, token);
    } else if (typeof window.TradingEngine?.openPair === "function") {
      window.TradingEngine.openPair(token, chainId);
    }
  },
};

window.TgSignalsEngine = TgSignalsEngine;

function isEvmFamily(chain) {
  return ["evm","ethereum","eth","bsc","bnb","base","arbitrum","arb","optimism","op","polygon","matic","blast","avalanche","avax","tron","sui","ronin","abstract","berachain","hyperevm","hyperliquid","unichain","zora"].includes(chain);
}
