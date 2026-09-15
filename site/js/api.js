/**
 * ⚡ TRENCHES API CLIENT — Core Communication Layer
 * Handles authentication, API keys, wallet cryptographic signatures, and live/mock execution.
 */

// Credentials only go to the deployed API or the same-origin local development server.
export const API_BASE = ["localhost", "127.0.0.1"].includes(location.hostname)
  ? location.origin : "https://raidos-api.fly.dev";

export const ApiClient = {
  getApiKey() {
    return localStorage.getItem("raidos_key") || "";
  },

  setApiKey(key) {
    if (key) localStorage.setItem("raidos_key", key);
    else localStorage.removeItem("raidos_key");
  },

  isAuthenticated() {
    return Boolean(this.getApiKey());
  },

  isBetaUnlocked() {
    return sessionStorage.getItem("trenches_beta_unlocked") === "1" || Boolean(this.getApiKey());
  },

  unlockBeta() {
    sessionStorage.setItem("trenches_beta_unlocked", "1");
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
    // Referral attribution: ?ref=CODE captured on landing is attached to the
    // FIRST wallet login (server binds referred_by once, immutably).
    const refCode = sessionStorage.getItem("trenches_ref") || undefined;
    const data = await this.request("/api/auth/wallet", {
      method: "POST",
      body: JSON.stringify({ chain, address, message, signature, nonce, ref: refCode }),
    });
    if (data.apiKey) {
      this.setApiKey(data.apiKey);
      this.unlockBeta();
      sessionStorage.removeItem("trenches_ref");
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

  async prepareSelfCustodyTrade(params, walletAddress) {
    const idempotencyKey = `prepare_${crypto.randomUUID()}`;
    return this.request("/api/trades/prepare", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ ...params, walletAddress }),
    });
  },

  async submitSelfCustodyTrade(sessionId, txHash) {
    return this.request("/api/trades/submit", {
      method: "POST",
      body: JSON.stringify({ sessionId, txHash }),
    });
  },

  async executeTrade(params, password) {
    const idempotencyKey = `trade_${crypto.randomUUID()}`;
    return this.request("/api/trades/execute", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
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

  async getPendingTrades() {
    return this.request("/api/trades/pending");
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

  /** Read-only on-chain balances for every wallet (public RPCs, keyless). */
  async getWalletBalances() {
    return this.request("/api/wallets/balances");
  },

  async createWallet(chain, password, label = "Primary") {
    return this.request("/api/wallets", {
      method: "POST",
      body: JSON.stringify({ chain, password, label }),
    });
  },

  async getReferrals() {
    return this.request("/api/me/referrals");
  },

  async getSubscription() {
    return this.request("/api/subscription");
  },

  async subscribe(tierId) {
    return this.request("/api/subscription", {
      method: "POST",
      body: JSON.stringify({ tierId }),
    });
  },

  async importWallet(chain, privateKey, password, label = "Imported") {
    return this.request("/api/wallets/import", {
      method: "POST",
      body: JSON.stringify({ chain, privateKey, password, label }),
    });
  },

  async deleteWallet(walletId, password) {
    return this.request(`/api/wallets/${walletId}`, {
      method: "DELETE",
      body: JSON.stringify({ password }),
    });
  },

  async search(query, limit = 10) {
    return this.request(`/api/search?q=${encodeURIComponent(query)}&limit=${limit}`);
  },

  /** Launchpad token metadata (names + logos) by symbol. */
  async getTokenMeta(symbols) {
    const q = Array.isArray(symbols) && symbols.length ? `?symbols=${encodeURIComponent(symbols.join(","))}` : "";
    return this.request(`/api/tokens/meta${q}`);
  },

  /** Full portfolio snapshot: PnL + per-token holdings in one call. */
  async getPortfolio() {
    return this.request("/api/portfolio");
  },

  // ── Advanced user profile (photo, bio, socials, name) ──
  async getMyProfile() {
    return this.request("/api/me/profile");
  },

  /** PATCH-style update (Router has no PATCH → POST). Send only changed fields. */
  async updateMyProfile(patch) {
    return this.request("/api/me/profile", {
      method: "POST",
      body: JSON.stringify(patch ?? {}),
    });
  },

  // ── Prediction markets (Polymarket) ──
  async getPredictionCategories() {
    return this.request("/api/prediction/categories");
  },

  async getPredictionEvents(opts = {}) {
    const q = new URLSearchParams();
    if (opts.category) q.set("category", opts.category);
    if (opts.sort) q.set("sort", opts.sort);
    q.set("limit", String(opts.limit ?? 30));
    q.set("offset", String(opts.offset ?? 0));
    return this.request(`/api/prediction/events?${q.toString()}`);
  },

  async placePredictionOrder(payload) {
    return this.request("/api/prediction/order", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  // ── Launchpad ──
  async getLaunches(opts = {}) {
    const q = new URLSearchParams();
    if (opts.chain) q.set("chain", opts.chain);
    if (opts.status) q.set("status", opts.status);
    if (opts.sort) q.set("sort", opts.sort);
    q.set("limit", String(opts.limit ?? 30));
    return this.request(`/api/launches?${q.toString()}`);
  },

  async createLaunch(payload) {
    return this.request("/api/launches", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async buyLaunchTokens(launchId, usdcAmount) {
    return this.request(`/api/launches/${launchId}/buy`, {
      method: "POST",
      body: JSON.stringify({ usdcAmount }),
    });
  },

  async sellLaunchTokens(launchId, tokenAmount) {
    return this.request(`/api/launches/${launchId}/sell`, {
      method: "POST",
      body: JSON.stringify({ tokenAmount }),
    });
  },

  // ── Copy-trade settings ──
  async getCopySettings() {
    return this.request("/api/copy-settings");
  },

  async saveCopySettings(payload) {
    return this.request("/api/copy-settings", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
};
