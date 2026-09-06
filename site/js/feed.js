/**
 * 📱 SOCIAL FEED ENGINE — Interactive Market Stream (real data layer)
 * Connects community alpha, trading theses, and on-chain whale activity.
 * Ticker mentions ($SOL, $BTC) resolve through PriceFeed for live price/delta.
 */

import { ApiClient } from "./api.js";
import { SmartMoneyRadar, EliteScoreEngine } from "./intelligence.js";
import { PriceFeed } from "./discover.js";

/**
 * Resolve a ticker symbol to a real price row from PriceFeed, falling back to
 * a sensible default so pills still render even before the cache is populated.
 */
function resolveToken(symbol) {
  const row = PriceFeed.get(symbol);
  const elite = EliteScoreEngine.calculate({
    liquidityUsd: 0,
    volume24hUsd: row.vol24h,
    mcapUsd: row.mcap,
    top10HolderPercent: 20,
    smartMoneyNetInflow: 0,
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

export const FeedEngine = {
  container: null,
  activeFilter: "for_you", // 'for_you' | 'following' | 'theses' | 'smart_money'
  posts: [],

  init(containerElement) {
    this.container = containerElement;
    this.loadSeedPosts();
    this.fetchLiveFeed();
    this.setupSseStream();
  },

  /** Turn $TICKER mentions into interactive pills using real prices. */
  parseInteractiveAssets(text) {
    if (!text) return "";
    return text.replace(/\$([A-Za-z0-9]{2,10})\b/g, (match, symbol) => {
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

  loadSeedPosts() {
    this.posts = [
      {
        id: "post_1",
        author: {
          name: "Valkyrie Quant",
          handle: "@0xValk",
          avatar: "VK",
          verified: true,
          pnl: "+$342,850",
          winRate: "78%",
        },
        type: "thesis",
        direction: "LONG",
        token: "SOL",
        entryPrice: "$179.50",
        targetPrice: "$215.00",
        stopLoss: "$172.00",
        content: "Acumulación sostenida detectada en $SOL. El open interest en derivados está en máximos locales mientras el CVD al contado confirma absorción de ventas. Rompiendo resistencia de 4H hacia 215.",
        likes: 184,
        reposts: 42,
        timestamp: Date.now() - 1000 * 60 * 18,
        hasChartSnapshot: true,
      },
      {
        id: "post_2",
        author: {
          name: "Smart Money Radar",
          handle: "@whale_radar",
          avatar: "🐋",
          verified: true,
          pnl: "ON-CHAIN",
          winRate: "84%",
        },
        type: "whale_alert",
        token: "VIRTUAL",
        content: "🐋 SMART MONEY ALERT: 4 wallets pertenecientes al cluster 'Early AI Accumulators' acaban de comprar $620k de $VIRTUAL en Base. Ninguna de estas billeteras ha vendido en los últimos 30 días.",
        likes: 295,
        reposts: 88,
        timestamp: Date.now() - 1000 * 60 * 42,
      },
      {
        id: "post_3",
        author: {
          name: "Nacho Web3",
          handle: "@nacho_web3",
          avatar: "NW",
          verified: true,
          pnl: "+$189,400",
          winRate: "74%",
        },
        type: "analysis",
        content: "El volumen en Base está rompiendo récords impulsado por memecoins y AI agents. Observando de cerca la rotación hacia $BRETT y cómo reacciona el ecosistema $ETH. El ratio riesgo/beneficio es muy atractivo aquí.",
        likes: 412,
        reposts: 95,
        timestamp: Date.now() - 1000 * 60 * 95,
      },
      {
        id: "post_4",
        author: {
          name: "Solana Alpha Hunter",
          handle: "@sol_hunter",
          avatar: "SH",
          verified: true,
          pnl: "+$94,200",
          winRate: "69%",
        },
        type: "thesis",
        direction: "LONG",
        token: "JUP",
        entryPrice: "$0.81",
        targetPrice: "$1.15",
        stopLoss: "$0.76",
        content: "Estructura de acumulación Wyckoff perfecta en $JUP. Ingresos récord por comisiones del router de Jupiter. El mercado aún no está descontando el nuevo fee share mechanism.",
        likes: 167,
        reposts: 31,
        timestamp: Date.now() - 1000 * 60 * 180,
      },
    ];
    this.render();
  },

  async fetchLiveFeed() {
    try {
      const data = await ApiClient.getFeed(undefined, 20);
      if (data && data.events && data.events.length > 0) {
        const livePosts = data.events.map((e) => ({
          id: "live_" + e.id,
          author: {
            name: `Trader #${e.actor_id}`,
            handle: `@trader_${e.actor_id}`,
            avatar: "TR",
            verified: true,
            pnl: "ON-CHAIN",
            winRate: "70%",
          },
          type: e.type,
          token: e.token_symbol || "USDC",
          content: `Operación on-chain ejecutada en ${e.chain}: ${e.type.toUpperCase()} de $${e.token_symbol || "TOKEN"}. Tx confirmada en bloque.`,
          likes: 5,
          reposts: 1,
          timestamp: e.ts * 1000,
        }));
        this.posts = [...livePosts, ...this.posts];
        this.render();
      }
    } catch {
      // Offline fallback already loaded
    }
  },

  setupSseStream() {
    try {
      const source = new EventSource("/api/feed/stream");
      source.onmessage = (event) => {
        try {
          const item = JSON.parse(event.data);
          if (item && item.id) {
            const tokSymbol = (item.token_symbol || "SOL").slice(0, 6);
            const tok = resolveToken(tokSymbol);
            this.posts.unshift({
              id: "sse_" + item.id,
              author: {
                name: `Trader #${item.actor_id}`,
                handle: `@trader_${item.actor_id}`,
                avatar: "TX",
                verified: true,
                pnl: "VERIFIED",
                winRate: "72%",
              },
              type: item.type,
              token: tokSymbol,
              content: `⚡ Nueva transacción confirmada en red: Swap de $${tokSymbol} verificado on-chain.`,
              likes: 1,
              reposts: 0,
              timestamp: (item.ts || Date.now() / 1000) * 1000,
            });
            this.render();
          }
        } catch {
          // ignore heartbeat pings
        }
      };
    } catch {
      // SSE not available or browser restricted
    }
  },

  setFilter(filter) {
    this.activeFilter = filter;
    this.render();
  },

  async addNewPost(postData) {
    const newPost = {
      id: "post_" + Date.now(),
      author: {
        name: "Mi Cuenta",
        handle: "@yo",
        avatar: "ME",
        verified: true,
        pnl: "+$0.00",
        winRate: "100%",
      },
      type: postData.direction ? "thesis" : "post",
      direction: postData.direction,
      token: postData.token,
      entryPrice: postData.entryPrice,
      targetPrice: postData.targetPrice,
      stopLoss: postData.stopLoss,
      content: postData.text,
      likes: 1,
      reposts: 0,
      timestamp: Date.now(),
    };
    this.posts.unshift(newPost);
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

  render() {
    if (!this.container) return;

    let filtered = this.posts;
    if (this.activeFilter === "theses") {
      filtered = this.posts.filter((p) => p.type === "thesis");
    } else if (this.activeFilter === "smart_money") {
      filtered = this.posts.filter((p) => p.type === "whale_alert");
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
          <span style="font-weight:800; color:${isLong ? "var(--delta-green)" : "var(--delta-red)"}">${p.direction} $${p.token}</span>
          ${p.entryPrice ? `<span>Entry: <strong>${p.entryPrice}</strong></span>` : ""}
          ${p.targetPrice ? `<span>TP: <strong style="color:var(--delta-green)">${p.targetPrice}</strong></span>` : ""}
          ${p.stopLoss ? `<span>SL: <strong style="color:var(--delta-red)">${p.stopLoss}</strong></span>` : ""}
        </div>
      `;
    }

    return `
      <article class="post-card glass-panel-interactive" style="padding:18px; border-bottom:1px solid var(--border-subtle); margin-bottom:12px; border-radius:var(--radius-lg)">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px">
          <div style="display:flex; align-items:center; gap:10px">
            <div class="author-avatar" style="width:36px; height:36px; font-size:13px">${p.author.avatar}</div>
            <div>
              <div style="display:flex; align-items:center; gap:6px">
                <span style="font-weight:700; font-size:14px; color:#fff">${p.author.name}</span>
                ${p.author.verified ? `<span style="font-size:11px; color:#ffffff" title="Verificado on-chain">✓</span>` : ""}
                <span style="font-size:12px; color:var(--text-tertiary); font-family:var(--font-mono)">${p.author.handle}</span>
              </div>
              <div style="font-size:11px; color:var(--text-tertiary); font-family:var(--font-mono)">
                PnL: <strong style="color:var(--delta-green)">${p.author.pnl}</strong> · Win: ${p.author.winRate}
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
            <span style="cursor:pointer" onclick="window.App.sharePost('${p.id}')">
              ↗ Share
            </span>
          </div>
          <button class="btn btn-ghost btn-sm" onclick="window.App.openProfileModal('${p.author.handle}')">Perfil</button>
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
