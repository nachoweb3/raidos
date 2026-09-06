/**
 * ⚡ RAY 2 API CLIENT — Core Communication Layer
 * Handles authentication, API keys, wallet cryptographic signatures, and live/mock execution.
 */

const API_BASE = ""; // Same-origin relative URLs

export const ApiClient = {
  getApiKey() {
    return localStorage.getItem("raidos_key") || "";
  },

  setApiKey(key) {
    if (key) localStorage.setItem("raidos_key", key);
    else localStorage.removeItem("raidos_key");
  },

  isBetaUnlocked() {
    return sessionStorage.getItem("ray2_beta_unlocked") === "1" || Boolean(this.getApiKey());
  },

  unlockBeta() {
    sessionStorage.setItem("ray2_beta_unlocked", "1");
  },

  async request(path, opts = {}) {
    const key = this.getApiKey();
    const headers = {
      "Content-Type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(opts.headers || {}),
    };

    const res = await fetch(API_BASE + path, { ...opts, headers });
    let data;
    try {
      data = await res.json();
    } catch {
      data = { error: "Failed to parse response" };
    }

    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  },

  // ── Auth Methods ──
  async getProviders() {
    return this.request("/api/auth/providers");
  },

  async register(bootstrapSecret, refCode) {
    const data = await this.request("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ bootstrapSecret, ref: refCode }),
    });
    if (data.apiKey) {
      this.setApiKey(data.apiKey);
      this.unlockBeta();
    }
    return data;
  },

  async getChallenge(chain = "solana") {
    return this.request("/api/auth/challenge", {
      method: "POST",
      body: JSON.stringify({ chain }),
    });
  },

  async loginWallet(chain, address, message, signature, nonce) {
    const data = await this.request("/api/auth/wallet", {
      method: "POST",
      body: JSON.stringify({ chain, address, message, signature, nonce }),
    });
    if (data.apiKey) {
      this.setApiKey(data.apiKey);
      this.unlockBeta();
    }
    return data;
  },

  async verifyAccessCode(code) {
    const data = await this.request("/api/auth/access-code", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
    if (data.valid) {
      this.unlockBeta();
    }
    return data;
  },

  async getMe() {
    if (!this.getApiKey()) return null;
    try {
      return await this.request("/api/me");
    } catch {
      return null;
    }
  },

  // ── Trading & Markets ──
  async getChains() {
    return this.request("/api/chains");
  },

  async getQuote(params) {
    return this.request("/api/trades/quote", {
      method: "POST",
      body: JSON.stringify(params),
    });
  },

  async executeTrade(params, password) {
    return this.request("/api/trades/execute", {
      method: "POST",
      body: JSON.stringify({ ...params, password }),
    });
  },

  async getTrades(limit = 25) {
    return this.request(`/api/trades?limit=${limit}`);
  },

  async getPositions() {
    return this.request("/api/positions");
  },

  async getPnl() {
    return this.request("/api/trades/pnl");
  },

  async getFeed(sinceId, limit = 30, chain) {
    const q = new URLSearchParams();
    if (sinceId !== undefined) q.set("sinceId", String(sinceId));
    if (limit) q.set("limit", String(limit));
    if (chain) q.set("chain", chain);
    return this.request(`/api/feed?${q.toString()}`);
  },

  async getLeaderboard(period = "all", limit = 25) {
    return this.request(`/api/leaderboard?period=${period}&limit=${limit}`);
  },

  async getWallets() {
    return this.request("/api/wallets");
  },

  async createWallet(chain, password, label = "Primary") {
    return this.request("/api/wallets", {
      method: "POST",
      body: JSON.stringify({ chain, password, label }),
    });
  },

  async search(query, limit = 10) {
    return this.request(`/api/search?q=${encodeURIComponent(query)}&limit=${limit}`);
  },
};
