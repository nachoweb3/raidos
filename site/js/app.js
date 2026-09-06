/**
 * 🚀 TRENCHES APP CONTROLLER — Mobile-First Orchestrator
 * Coordinates Feed, Discover, Trading Terminal, Social Reputation, and Wallets.
 */

import { ApiClient } from "./api.js";
import { FeedEngine } from "./feed.js";
import { DiscoverEngine } from "./discover.js";
import { TradingEngine } from "./trading.js";
import { SocialEngine } from "./social.js";

export const App = {
  currentView: "feed",
  user: null,

  async init() {
    // 1. Closed Beta Access Gate Check
    if (!ApiClient.isBetaUnlocked()) {
      // If user came without unlocking, prompt access code modal
      this.openAccessCodeModal();
    }

    // 2. Initialize Subsystems
    await DiscoverEngine.init(document.getElementById("discoverTokensList"));
    FeedEngine.init(document.getElementById("feedPostsList"));
    TradingEngine.init();
    SocialEngine.init(document.getElementById("leaderboardList"));

    // 3. Check Auth State
    this.checkUserAuth();

    // 4. Start background real-data refresh loops
    this.startRealDataLoops();

    // 5. Setup Navigation Handlers
    this.setupNavigation();

    // 6. Setup Viewport Mobile Fixes
    this.setupMobileViewport();
  },

  /** Keep prices, candles and discover tokens fresh in the background. */
  startRealDataLoops() {
    // Refresh discover tokens + prices every 5 minutes (CoinGecko cache TTL).
    setInterval(() => {
      try {
        DiscoverEngine.refresh();
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
      }, 50);
    } else if (viewName === "discover") {
      DiscoverEngine.render();
    } else if (viewName === "leaderboard") {
      SocialEngine.render();
    }
  },

  openTradeForToken(symbol, chain, price) {
    TradingEngine.setAsset(symbol, chain, price);
    this.switchView("trade");
  },

  async checkUserAuth() {
    const user = await ApiClient.getMe();
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

  openNewPostModal() {
    const modal = document.getElementById("newPostModal");
    if (modal) modal.classList.add("active");
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

document.addEventListener("DOMContentLoaded", () => {
  App.init();
});
