/**
 * 📱 SOCIAL FEED ENGINE — Interactive Market Stream (real data layer)
 * Real on-chain events (swaps, closed positions) and user theses from /api/feed.
 * Ticker mentions ($SOL, $BTC) resolve through PriceFeed for live price/delta.
 * No fabricated posts: when the feed is empty, we say so.
 */

import { ApiClient, API_BASE } from "./api.js";
import { EliteScoreEngine } from "./intelligence.js";
import { PriceFeed } from "./discover.js";

/**
 * Resolve a ticker symbol to a real price row from PriceFeed, falling back to
 * a sensible default so pills still render even before the cache is populated.
 */
function resolveToken(symbol) {
  const row = PriceFeed.get(symbol);
  const elite = EliteScoreEngine.calculate({
    volume24hUsd: row.vol24h,
    mcapUsd: row.mcap,
    priceChange24h: row.delta24h,
  });
  return {
    symbol: symbol.toUpperCase(),
    chain: guessChain(symbol),
    price: row.price,
    delta: row.delta24h,
    score: elite.score,
  };
}

/** Best-guess chain for a ticker so pills/deep-links route correctly. */
function guessChain(symbol) {
  const s = symbol.toUpperCase();
  if (s === "SOL" || s === "JUP" || s === "BONK" || s === "WIF" || s === "PEPE") return "solana";
  if (s === "BRETT" || s === "VIRTUAL" || s === "AERO") return "base";
  if (s === "ETH" || s === "PENDLE" || s === "POL") return "ethereum";
  if (s === "BNB") return "bsc";
  if (s === "GMX") return "arbitrum";
  if (s === "MON") return "monad";
  if (s === "ARC") return "arc";
  return "solana";
}

/** Sanitize a string for safe interpolation into inline HTML/handlers. */
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const FeedEngine = {
  container: null,
  activeFilter: "for_you", // 'for_you' | 'theses' | 'smart_money' | 'following'
  posts: [],
  lastFeedId: 0,
  sseSource: null,

  init(containerElement) {
    this.container = containerElement;
    this.renderLoading();
    this.fetchLiveFeed();
    this.setupSseStream();
  },

  /** Turn $TICKER mentions into interactive pills using real prices. */
  parseInteractiveAssets(text) {
    if (!text) return "";
    const safe = esc(text);
    return safe.replace(/\$([A-Za-z0-9]{2,10})\b/g, (match, symbol) => {
      const token = resolveToken(symbol);

      const isUp = token.delta >= 0;
      const formattedPrice =
        token.price < 0.01
          ? token.price.toFixed(6)
          : token.price.toLocaleString(undefined, { minimumFractionDigits: token.price < 1 ? 4 : 2 });
      const deltaText = (isUp ? "+" : "") + token.delta.toFixed(2) + "%";

      return `
        <span class="asset-pill" onclick="if(window.openAssetPreview){ window.openAssetPreview({ symbol: '${token.symbol}', chain: '${token.chain}', price: ${token.price}, delta: ${token.delta}, score: ${token.score} }); } else { window.App.openTradeForToken('${token.symbol}', '${token.chain}', ${token.price}); }" title="Click para ver gráfico y operar $${token.symbol}">
          <span class="pill-sym">$${token.symbol}</span>
          <span class="pill-price">$${formattedPrice}</span>
          <span class="pill-delta ${isUp ? 'up' : 'down'}">${deltaText}</span>
          <span class="pill-action">TRADE</span>
        </span>
      `;
    });
  },

  /** Map a real feed_events row to a post card. */
  mapEvent(e) {
    const p = e.payload || {};
    const actor = `Trader #${e.actor_id}`;

    if (e.type === "thesis" || e.type === "post") {
      const text = p.text || "";
      return {
        id: "live_" + e.id,
        author: { name: actor, handle: `@trader_${e.actor_id}`, avatar: "T#", verified: false },
        type: e.type,
        direction: p.direction,
        token: e.token_symbol || undefined,
        entryPrice: p.entryPrice || undefined,
        targetPrice: p.targetPrice || undefined,
        stopLoss: p.stopLoss || undefined,
        content: text,
        likes: 0,
        reposts: 0,
        timestamp: e.ts * 1000,
        isLive: true,
      };
    }

    // On-chain events: swap / position_closed — narrate strictly from payload
    if (e.type === "swap") {
      const side = p.side === "sell" ? "Venta" : "Compra";
      const usdc = Number(p.usdc ?? 0) / 1e6;
      return {
        id: "live_" + e.id,
        author: { name: actor, handle: `@trader_${e.actor_id}`, avatar: "⛓", verified: true },
        type: "swap",
        token: e.token_symbol || undefined,
        content: `${side} on-chain de $${esc(e.token_symbol || "TOKEN")} en ${esc(e.chain)} por ${usdc.toLocaleString("en-US", { style: "currency", currency: "USD" })} en USDC. Verificado en bloque.`,
        likes: 0,
        reposts: 0,
        timestamp: e.ts * 1000,
        isLive: true,
      };
    }

    if (e.type === "position_closed") {
      const pnl = Number(p.pnl ?? 0) / 1e6;
      const up = pnl >= 0;
      return {
        id: "live_" + e.id,
        author: { name: actor, handle: `@trader_${e.actor_id}`, avatar: "⛓", verified: true },
        type: "position_closed",
        token: e.token_symbol || undefined,
        content: `Posición cerrada en $${esc(e.token_symbol || "TOKEN")} (${esc(e.chain)}): ${up ? "ganancia" : "pérdida"} de ${Math.abs(pnl).toLocaleString("en-US", { style: "currency", currency: "USD" })}.`,
        likes: 0,
        reposts: 0,
        timestamp: e.ts * 1000,
        isLive: true,
      };
    }

    return null;
  },

  async fetchLiveFeed() {
    try {
      const data = await ApiClient.getFeed(undefined, 30);
      if (data && data.events) {
        this.posts = data.events.map((e) => this.mapEvent(e)).filter(Boolean);
        this.lastFeedId = data.maxId ?? this.posts.reduce((m, p) => Math.max(m, Number(String(p.id).slice(5)) || 0), 0);
      } else {
        this.posts = [];
      }
    } catch {
      this.posts = [];
    }
    this.render();
  },

  setupSseStream() {
    try {
      if (this.sseSource) this.sseSource.close();
      // Static hosting can't proxy /api/* — target the API origin explicitly.
      this.sseSource = new EventSource(`${API_BASE}/api/feed/stream`);
      this.sseSource.onmessage = (event) => {
        try {
          const item = JSON.parse(event.data);
          if (item && item.id && !this.posts.some((p) => p.id === "live_" + item.id)) {
            const mapped = this.mapEvent(item);
            if (mapped) {
              this.posts.unshift(mapped);
              this.render();
            }
          }
        } catch {
          // ignore heartbeat pings
        }
      };
    } catch {
      // SSE not available or browser restricted
    }
  },

  async addNewPost(postData) {
    // Optimistic local render, then persist server-side
    const optimistic = {
      id: "local_" + Date.now(),
      author: { name: "Mi Cuenta", handle: "@yo", avatar: "ME", verified: false },
      type: postData.direction ? "thesis" : "post",
      direction: postData.direction,
      token: postData.token,
      entryPrice: postData.entryPrice,
      targetPrice: postData.targetPrice,
      stopLoss: postData.stopLoss,
      content: postData.text,
      likes: 0,
      reposts: 0,
      timestamp: Date.now(),
      isLive: false,
    };
    this.posts.unshift(optimistic);
    this.render();

    try {
      await ApiClient.request("/api/feed/post", {
        method: "POST",
        body: JSON.stringify({
          text: postData.text,
          token: postData.token,
          direction: postData.direction,
          entryPrice: postData.entryPrice,
          targetPrice: postData.targetPrice,
          stopLoss: postData.stopLoss,
        }),
      });
    } catch {
      // Optimistic local post preserved
    }
  },

  setFilter(filter) {
    this.activeFilter = filter;
    this.render();
  },

  render() {
    if (!this.container) return;

    let filtered = this.posts;
    if (this.activeFilter === "theses") {
      filtered = this.posts.filter((p) => p.type === "thesis");
    } else if (this.activeFilter === "smart_money") {
      filtered = this.posts.filter((p) => p.type === "position_closed" || p.type === "swap");
    } else if (this.activeFilter === "following") {
      // Local follow graph (trenches_following); matches author handles
      const following = JSON.parse(localStorage.getItem("trenches_following") || "[]");
      filtered = this.posts.filter((p) => following.includes(p.author.handle));
    }

    if (filtered.length === 0) {
      const msgs = {
        for_you: "El feed está vacío — sé el primero en publicar una tesis o ejecutar un swap.",
        theses: "Aún no hay tesis publicadas. Comparte tu análisis con la comunidad.",
        smart_money: "Sin actividad on-chain registrada todavía. Los swaps y cierres de posición aparecerán aquí en tiempo real.",
        following: "No hay actividad de los traders que sigues. Sigue a alguien desde el Leaderboard.",
      };
      this.container.innerHTML = `
        <div class="glass-panel" style="padding:40px 28px; text-align:center">
          <div style="font-size:34px; margin-bottom:12px">📡</div>
          <h3 style="font-size:16px; font-weight:800; margin-bottom:8px">Sin señal todavía</h3>
          <p style="font-size:13px; color:var(--text-secondary); max-width:420px; margin:0 auto 20px">${msgs[this.activeFilter] || msgs.for_you}</p>
          <button class="btn btn-primary btn-lg" onclick="window.App.openNewPostModal()">Publicar tesis</button>
        </div>`;
      return;
    }

    this.container.innerHTML = filtered.map((p) => this.renderPostCard(p)).join("");
  },

  renderPostCard(p) {
    const parsedText = this.parseInteractiveAssets(p.content);
    const timeAgo = formatTimeAgo(p.timestamp);

    let thesisBadge = "";
    if (p.type === "thesis" && p.direction) {
      const isLong = p.direction === "LONG";
      thesisBadge = `
        <div style="display:flex; align-items:center; gap:12px; margin-bottom:12px; padding:8px 12px; background:rgba(255,255,255,0.03); border:1px solid var(--border-subtle); border-radius:var(--radius-md); font-family:var(--font-mono); font-size:11px">
          <span style="font-weight:800; color:${isLong ? "var(--delta-green)" : "var(--delta-red)"}">${esc(p.direction)} $${esc(p.token)}</span>
          ${p.entryPrice ? `<span>Entry: <strong>${esc(p.entryPrice)}</strong></span>` : ""}
          ${p.targetPrice ? `<span>TP: <strong style="color:var(--delta-green)">${esc(p.targetPrice)}</strong></span>` : ""}
          ${p.stopLoss ? `<span>SL: <strong style="color:var(--delta-red)">${esc(p.stopLoss)}</strong></span>` : ""}
        </div>
      `;
    }

    const onchainBadge =
      p.isLive && (p.type === "swap" || p.type === "position_closed")
        ? `<span class="brand-badge" style="font-size:9px; margin-left:6px">ON-CHAIN</span>`
        : "";

    return `
      <article class="post-card glass-panel-interactive" style="padding:18px; border-bottom:1px solid var(--border-subtle); margin-bottom:12px; border-radius:var(--radius-lg)">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px">
          <div style="display:flex; align-items:center; gap:10px">
            <div class="author-avatar" style="width:36px; height:36px; font-size:13px">${esc(p.author.avatar)}</div>
            <div>
              <div style="display:flex; align-items:center; gap:6px">
                <span style="font-weight:700; font-size:14px; color:#fff">${esc(p.author.name)}</span>
                ${p.author.verified ? `<span style="font-size:11px; color:#ffffff" title="Verificado on-chain">✓</span>` : ""}
                <span style="font-size:12px; color:var(--text-tertiary); font-family:var(--font-mono)">${esc(p.author.handle)}</span>
                ${onchainBadge}
              </div>
            </div>
          </div>
          <span style="font-size:11px; color:var(--text-tertiary); font-family:var(--font-mono)">${timeAgo}</span>
        </div>

        ${thesisBadge}

        <div style="font-size:13.5px; color:var(--text-primary); line-height:1.55; margin-bottom:14px">
          ${parsedText}
        </div>

        <div style="display:flex; justify-content:space-between; align-items:center; font-size:12px; color:var(--text-tertiary); font-family:var(--font-mono); padding-top:10px; border-top:1px solid var(--border-ultra-subtle)">
          <div style="display:flex; gap:20px">
            <span style="cursor:pointer; display:inline-flex; align-items:center; gap:5px" onclick="this.querySelector('.n').textContent = Number(this.querySelector('.n').textContent)+1">
              🤍 <span class="n">${p.likes}</span>
            </span>
            <span style="cursor:pointer; display:inline-flex; align-items:center; gap:5px" onclick="this.querySelector('.n').textContent = Number(this.querySelector('.n').textContent)+1">
              🔄 <span class="n">${p.reposts}</span>
            </span>
            <span style="cursor:pointer" onclick="if(window.App.sharePost) window.App.sharePost('${esc(p.id)}'); else if(navigator.share){ navigator.share({ text: '${esc(p.content).slice(0, 180)}' }).catch(()=>{}); } else { navigator.clipboard && navigator.clipboard.writeText('${esc(p.content).slice(0, 180)}'); }">
              ↗ Share
            </span>
          </div>
          <button class="btn btn-ghost btn-sm" onclick="window.App.openProfileModal('${esc(p.author.handle)}')">Perfil</button>
        </div>
      </article>
    `;
  },
};

function formatTimeAgo(ms) {
  const diffSec = Math.floor((Date.now() - ms) / 1000);
  if (diffSec < 60) return "ahora";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  return `${Math.floor(diffSec / 86400)}d`;
}
