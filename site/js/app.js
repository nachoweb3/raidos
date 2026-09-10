/**
 * 🚀 TRENCHES APP CONTROLLER — Mobile-First Orchestrator
 * Coordinates Feed, Discover, Trading Terminal, Social Reputation, and Wallets.
 */

import { ApiClient } from "./api.js";
import { FeedEngine } from "./feed.js";
import { DiscoverEngine } from "./discover.js";
import { TradingEngine } from "./trading.js";
import { SocialEngine } from "./social.js";
import { PortfolioEngine } from "./portfolio.js";
import { TrenchesEngine } from "./trenches.js";
import { RewardsEngine } from "./rewards.js";
import { PremiumEngine } from "./premium.js";
import { MarketsEngine } from "./markets.js";
import { TokenMeta } from "./tokens.js";

export const App = {
  currentView: "feed",
  user: null,
  _thesisPrefill: null,

  async init() {
    // 0. Referral attribution: capture ?ref=CODE from the link before anything.
    const refParam = new URLSearchParams(location.search).get("ref");
    if (refParam) sessionStorage.setItem("trenches_ref", refParam.trim().slice(0, 40));

    // 1. Closed Beta Access Gate Check
    if (!ApiClient.isBetaUnlocked()) {
      // If user came without unlocking, prompt access code modal
      this.openAccessCodeModal();
    }

    // 2. Navigation FIRST — the UI must respond even if a subsystem fails
    this.setupNavigation();

    // 3. Initialize Subsystems — each isolated so one failure can't kill the app
    const safeInit = async (name, fn) => {
      try {
        await fn();
      } catch (e) {
        console.warn(`[App] ${name} init failed (app continues):`, e);
      }
    };
    await safeInit("Discover", () => DiscoverEngine.init(document.getElementById("discoverTokensList")));
    safeInit("Feed", () => FeedEngine.init(document.getElementById("feedPostsList")));
    safeInit("Trading", () => TradingEngine.init());
    safeInit("Social", () => SocialEngine.init(document.getElementById("leaderboardList")));
    safeInit("Portfolio", () => PortfolioEngine.init());
    safeInit("Premium", () => PremiumEngine.load());
    safeInit("Markets", () => MarketsEngine.init(document.getElementById("marketsContainer")));
    safeInit("Rewards", () => RewardsEngine.init(document.getElementById("rewardsRoot")));
    safeInit("Trenches", () => TrenchesEngine.init());

    // 4. Check Auth State (401 is expected for gate-unlocked users without a key)
    safeInit("Auth", () => this.checkUserAuth());
    safeInit("TokenMeta", () => this.loadTokenMeta());

    // 5. Start background real-data refresh loops
    this.startRealDataLoops();

    // 6. Populate feed sidebars with real data (movers + top traders)
    safeInit("Sidebars", () => this.loadFeedSidebars());

    // 6. Setup Viewport Mobile Fixes
    this.setupMobileViewport();
  },

  /** Populate feed sidebars: real top movers (CoinGecko) + real top traders (API). */
  async loadFeedSidebars() {
    // Top movers — from the already-loaded Discover universe (real CoinGecko prices)
    const moversEl = document.getElementById("moversPills");
    if (moversEl) {
      const movers = (DiscoverEngine.tokens || [])
        .filter((t) => t.hasLivePrice && t.price > 0 && Number.isFinite(t.delta24h))
        .sort((a, b) => Math.abs(b.delta24h) - Math.abs(a.delta24h))
        .slice(0, 3);
      moversEl.innerHTML = movers.length
        ? movers
            .map(
              (t) => `
            <div class="asset-pill" onclick="window.App.openTradeForToken('${t.symbol}', '${t.chain}', ${t.price})">
              ${TokenMeta.logoHtml(t.symbol, { size: 18 })}
              <span class="pill-sym">$${t.symbol}</span>
              <span class="pill-price">$${t.price < 0.01 ? t.price.toFixed(6) : t.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
              <span class="pill-delta ${t.delta24h >= 0 ? "up" : "down"}">${t.delta24h >= 0 ? "+" : ""}${t.delta24h.toFixed(1)}%</span>
              <span class="pill-action">TRADE</span>
            </div>`
            )
            .join("")
        : `<p style="font-size:11.5px; color:var(--text-tertiary)">Precios no disponibles ahora mismo</p>`;
    }

    // Featured traders — real leaderboard data only
    const tradersEl = document.getElementById("sidebarTraders");
    if (tradersEl) {
      try {
        const data = await ApiClient.getLeaderboard("all", 3);
        const leaders = (data?.leaders ?? []).slice(0, 3);
        tradersEl.innerHTML = leaders.length
          ? leaders
              .map((l) => {
                const handle = String(l.x_handle || `@trader_${l.user_id}`).replace(/[^a-zA-Z0-9_@.\-]/g, "");
                const initials = handle.replace("@", "").slice(0, 2).toUpperCase();
                const pnl = Number(l.total_pnl_usdc ?? 0) / 1_000_000;
                const pnlStr = (pnl >= 0 ? "+$" : "-$") + Math.abs(pnl).toLocaleString(undefined, { maximumFractionDigits: 0 });
                return `
            <div style="display:flex; align-items:center; justify-content:space-between; font-size:12px">
              <div style="display:flex; align-items:center; gap:8px">
                <div class="author-avatar" style="width:26px; height:26px; font-size:10px">${initials}</div>
                <span style="font-weight:700">${handle}</span>
              </div>
              <span style="color:${pnl >= 0 ? "var(--delta-green)" : "var(--delta-red)"}; font-family:var(--font-mono); font-weight:700">${pnlStr}</span>
            </div>`;
              })
              .join("")
          : `<p style="font-size:11.5px; color:var(--text-tertiary)">El ranking está abierto — haz tu primer trade</p>`;
      } catch (e) {
        tradersEl.innerHTML = `<p style="font-size:11.5px; color:var(--text-tertiary)">Ranking no disponible ahora mismo</p>`;
      }
    }
  },

  /** Keep prices, candles and discover tokens fresh in the background. */
  startRealDataLoops() {
    // Refresh discover tokens + prices every 5 minutes (CoinGecko cache TTL).
    setInterval(() => {
      try {
        DiscoverEngine.refresh();
        this.loadFeedSidebars();
      } catch (e) {
        console.warn("[App] discover refresh failed:", e);
      }
    }, 5 * 60 * 1000);

    // Refresh the active trading terminal price + candles every 60 seconds.
    setInterval(() => {
      try {
        TradingEngine.refreshPrice();
        TradingEngine.fetchRealCandles();
      } catch (e) {
        console.warn("[App] trading refresh failed:", e);
      }
    }, 60 * 1000);

    // Refresh feed (SSE handles real-time here; this is a resilience poll).
    setInterval(() => {
      try {
        FeedEngine.fetchLiveFeed();
      } catch (e) {
        console.warn("[App] feed refresh failed:", e);
      }
    }, 30 * 1000);
  },

  setupNavigation() {
    document.querySelectorAll("[data-nav]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const view = btn.getAttribute("data-nav");
        if (view) this.switchView(view);
      });
    });
  },

  switchView(viewName) {
    this.currentView = viewName;

    // Update bottom bar & nav tabs active styles
    document.querySelectorAll("[data-nav]").forEach((btn) => {
      if (btn.getAttribute("data-nav") === viewName) {
        btn.classList.add("active");
      } else {
        btn.classList.remove("active");
      }
    });

    // Hide all view containers, show target
    document.querySelectorAll(".view-panel").forEach((panel) => {
      panel.style.display = "none";
    });

    const target = document.getElementById(`view-${viewName}`);
    if (target) {
      target.style.display = "block";
      window.scrollTo({ top: 0, behavior: "smooth" });
    }

    // Special view triggers
    if (viewName === "trade") {
      setTimeout(() => {
        TradingEngine.initChart();
        TrenchesEngine.init();
      }, 50);
    } else if (viewName === "discover") {
      DiscoverEngine.render();
    } else if (viewName === "leaderboard") {
      SocialEngine.render();
    } else if (viewName === "profile") {
      PortfolioEngine.load();
    } else if (viewName === "rewards") {
      RewardsEngine.load();
    } else if (viewName === "markets") {
      MarketsEngine.render();
    }
  },

  openTradeForToken(symbol, chain, price) {
    TradingEngine.setAsset(symbol, chain, price);
    this.switchView("trade");
    // Reflect the selection in the Trenches board when it loads.
    setTimeout(() => TrenchesEngine.init(), 80);
  },

  /** Kick off shared token metadata (launchpad names/logos) once at startup. */
  async loadTokenMeta() {
    await TokenMeta.ensureServerMeta();
    // Re-render surfaces that already rendered before meta arrived.
    try { DiscoverEngine.render(); } catch {}
    try { FeedEngine.render(); } catch {}
    try { TradingEngine.updateTokenDisplay(); } catch {}
  },

  async checkUserAuth() {
    let user = null;
    try {
      user = await ApiClient.getMe();
    } catch {
      // 401 / network — expected for gate-unlocked users without an API key
    }
    const authBtn = document.getElementById("headerAuthBtn");
    if (user && user.userId) {
      this.user = user;
      if (authBtn) {
        authBtn.textContent = `User #${user.userId}`;
        authBtn.className = "btn btn-secondary btn-sm";
      }
    }
  },

  openWalletModal() {
    const modal = document.getElementById("walletModal");
    if (modal) modal.classList.add("active");
  },

  closeWalletModal() {
    const modal = document.getElementById("walletModal");
    if (modal) modal.classList.remove("active");
  },

  openAccessCodeModal() {
    const modal = document.getElementById("accessGateModal");
    if (modal) modal.classList.add("active");
  },

  closeAccessCodeModal() {
    const modal = document.getElementById("accessGateModal");
    if (modal) modal.classList.remove("active");
  },

  /**
   * Open the thesis composer. Optional prefill: { token, chain, price, launchId }
   * — wired from Trenches rows, Discover rows, the terminal and asset previews
   * so users can publish a thesis for exactly the token they're looking at.
   */
  openNewPostModal(prefill) {
    const modal = document.getElementById("newPostModal");
    if (!modal) return;
    const p = prefill ?? {};
    const tokenInput = document.getElementById("thesisToken");
    const entryInput = document.getElementById("thesisEntry");
    const header = document.getElementById("thesisTokenPreview");
    if (tokenInput && p.token) tokenInput.value = String(p.token).toUpperCase().slice(0, 12);
    if (entryInput && Number(p.price) > 0) {
      entryInput.value = "$" + (p.price < 0.01 ? p.price.toFixed(6) : p.price.toPrecision(4));
    }
    // Context strip: logo + live price of the token being written about.
    if (header) {
      if (p.token) {
        header.style.display = "flex";
        header.innerHTML =
          (window.TokenMeta ? TokenMeta.logoHtml(String(p.token).toUpperCase(), { size: 26, imageUrl: p.imageUrl }) : "") +
          `<div style="min-width:0"><div style="font-size:12px; font-weight:800; color:#fff">$${String(p.token).toUpperCase().slice(0, 12)}</div>` +
          `<div style="font-size:10px; color:var(--text-tertiary); font-family:var(--font-mono)">${Number(p.price) > 0 ? "$" + Number(p.price).toPrecision(4) : String(p.chain ?? "").toUpperCase().slice(0, 12)}</div></div>`;
      } else {
        header.style.display = "none";
        header.innerHTML = "";
      }
    }
    this._thesisPrefill = p;
    modal.classList.add("active");
  },

  closeNewPostModal() {
    const modal = document.getElementById("newPostModal");
    if (modal) modal.classList.remove("active");
  },

  openProfileModal(handle) {
    const title = document.getElementById("profileModalTitle");
    if (title) title.textContent = handle;
    const modal = document.getElementById("profileModal");
    if (modal) modal.classList.add("active");
  },

  closeProfileModal() {
    const modal = document.getElementById("profileModal");
    if (modal) modal.classList.remove("active");
  },

  closeShareModal() {
    const modal = document.getElementById("shareCardModal");
    if (modal) modal.classList.remove("active");
  },

  closeCopyModal() {
    const modal = document.getElementById("copyTradeModal");
    if (modal) modal.classList.remove("active");
  },

  /** Persist copy-trade preferences server-side. Execution is not active in beta. */
  async saveCopySettings() {
    const max = parseFloat(document.getElementById("copyMaxAmount")?.value);
    const slip = parseFloat(document.getElementById("copySlippage")?.value);
    if (!Number.isFinite(max) || max <= 0) {
      alert("Introduce un monto máximo válido (USDC)");
      return;
    }
    // Local mirror keeps the per-trader context + slippage, which the current
    // backend schema doesn't store.
    try {
      localStorage.setItem("trenches_copy_settings", JSON.stringify({
        trader: this._copyTrader || null,
        maxAmountUsdc: max,
        slippagePct: Number.isFinite(slip) ? slip : 0.5,
        savedAt: Date.now(),
      }));
    } catch {}
    try {
      await ApiClient.saveCopySettings({
        enabled: true,
        maxPerTradeUsdc: max,
        maxTotalUsdc: max * 10,
        chains: ["solana", "ethereum", "base"],
      });
      this.closeCopyModal();
      alert("Configuración guardada en tu cuenta. La ejecución automática estará disponible próximamente.");
    } catch (err) {
      const msg = String(err?.message || err);
      if (msg.includes("401") || /unauthorized|no auth/i.test(msg)) {
        alert("Conecta tu wallet para guardar la configuración en tu cuenta");
      } else {
        alert("No se pudo guardar: " + msg);
      }
    }
  },

  // Wallet connection methods
  async connectPhantom() {
    if (window.solana && window.solana.isPhantom) {
      try {
        const resp = await window.solana.connect();
        const address = resp.publicKey.toString();
        const ch = await ApiClient.getChallenge("solana");
        const encoded = new TextEncoder().encode(ch.message);
        const signed = await window.solana.signMessage(encoded, "utf8");
        const sigHex = Array.from(signed.signature).map((b) => b.toString(16).padStart(2, "0")).join("");
        await ApiClient.loginWallet("solana", address, ch.message, sigHex, ch.nonce);
        this.closeWalletModal();
        this.checkUserAuth();
      } catch (err) {
        alert("Firma cancelada o error de conexión con Phantom.");
      }
    } else {
      alert("Phantom wallet no detectada. Por favor instala la extensión o app de Phantom.");
    }
  },

  async connectMetaMask() {
    if (window.ethereum) {
      try {
        const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
        const address = accounts[0];
        const ch = await ApiClient.getChallenge("evm");
        const sig = await window.ethereum.request({
          method: "personal_sign",
          params: [ch.message, address],
        });
        await ApiClient.loginWallet("evm", address, ch.message, sig, ch.nonce);
        this.closeWalletModal();
        this.checkUserAuth();
      } catch (err) {
        alert("Firma cancelada o error con MetaMask.");
      }
    } else {
      alert("MetaMask no detectada. Por favor instala la extensión o app de MetaMask.");
    }
  },

  setupMobileViewport() {
    // Ensure viewport height handles dynamic mobile browser address bars
    const updateVh = () => {
      const vh = window.innerHeight * 0.01;
      document.documentElement.style.setProperty("--vh", `${vh}px`);
    };
    window.addEventListener("resize", updateVh);
    updateVh();
  },
};

// Global expose for inline HTML event handlers
window.App = App;
window.TradingEngine = TradingEngine;
window.DiscoverEngine = DiscoverEngine;
window.FeedEngine = FeedEngine;
window.SocialEngine = SocialEngine;
window.PortfolioEngine = PortfolioEngine;
window.MarketsEngine = MarketsEngine;
window.TrenchesEngine = TrenchesEngine;
window.RewardsEngine = RewardsEngine;

document.addEventListener("DOMContentLoaded", () => {
  App.init();
});
