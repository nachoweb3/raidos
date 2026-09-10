/**
 * 🖥 API SERVER — HTTP interface for the RaidOS trading app
 * Node-native http (zero dependencies). Serves:
 *   - /api/*    JSON API (Bearer API-key auth)
 *   - static    the trading dashboard from SITE_DIR (same origin)
 *
 * Modes: APP_MODE=live signs and broadcasts real transactions;
 * APP_MODE=mock simulates fills deterministically and is always labeled.
 */

import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, normalize, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AppDb } from "../database/app-db.js";
import { WalletManager } from "../wallets/manager.js";
import { decrypt, verifyPassword, type EncryptedPayload } from "../wallets/crypto.js";
import { TradingEngine, type TradeParams } from "../trading/engine.js";
import { TokenLaunchpad } from "../trading/launchpad.js";
import { SocialTrading } from "../profiles/social.js";
import { RevenueEngine } from "../trading/revenue.js";
import { TradeHistory } from "../trading/history.js";
import { getChain, CHAINS } from "../chains/config.js";
import { AuthService, AuthError, ChallengeStore } from "./auth.js";
import { verifySolanaSignature, verifyEvmSignature, normalizeEvmAddress } from "./verify-login.js";
import { verifyGoogleIdToken, verifyXCode } from "./providers.js";
import { Router, sendJson, readJsonBody, HttpError, type RequestContext } from "./router.js";
import { executeSolanaSwap, executeEvmSwap, type ExecutionContext } from "./executors.js";
import { applySwapToPosition } from "../trading/positions.js";
import { RewardsEngine } from "../trading/rewards.js";
import { BlockscoutHoldersProvider, MockHoldersProvider, pickHoldersProvider, type HoldersProvider } from "../market/holders.js";
import { fetchPredictionEvents, fetchPredictionEventCached, PREDICTION_CATEGORIES } from "../market/prediction.js";
import { placeClobOrder } from "../market/clob.js";

export interface ServerOptions {
  /** Path to the SQLite database file. */
  dbPath: string;
  /** Port to listen on (0 = ephemeral). Default: env PORT or 8787. */
  port?: number;
  /** Directory with static dashboard files, or null to disable. Default: SITE_DIR env or repo site/. */
  siteDir?: string | null;
  /** "live" | "mock". Default: APP_MODE env or "mock" (safe default). */
  appMode?: "live" | "mock";
  /** Secret required to register users after the first one. Default: BOOTSTRAP_SECRET env. */
  bootstrapSecret?: string;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

/**
 * Canonical on-chain token addresses (verified, well-known mints/contracts)
 * → display symbol. Used to resolve real tickers when holdings/positions are
 * keyed by raw address and no position row carries a friendlier symbol.
 */
export const WELL_KNOWN_TOKENS: Record<string, { symbol: string; name: string }> = {
  // Solana
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: "USDC", name: "USD Coin" },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: "USDT", name: "Tether USD" },
  So11111111111111111111111111111111111111112: { symbol: "SOL", name: "Solana (wrapped)" },
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: { symbol: "BONK", name: "Bonk" },
  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: { symbol: "WIF", name: "dogwifhat" },
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: { symbol: "JUP", name: "Jupiter" },
  // Ethereum
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": { symbol: "USDC", name: "USD Coin" },
  "0xdAC17F958D2ee523a2206206994597C13D831ec7": { symbol: "USDT", name: "Tether USD" },
  "0x6982508145454Ce325dDbE47a25d4ec3d2311933": { symbol: "PEPE", name: "Pepe" },
  // Base
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913": { symbol: "USDC", name: "USD Coin" },
  // BSC
  "0x2170Ed0880ac9A755fd29B2688956BD959F933F8": { symbol: "ETH", name: "Ethereum (BSC)" },
  "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c": { symbol: "BNB", name: "BNB" },
  // Polygon
  "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359": { symbol: "USDC", name: "USD Coin" },
};

export class ApiServer {
  readonly db: AppDb;
  readonly appMode: "live" | "mock";
  private readonly auth: AuthService;
  private readonly challenges = new ChallengeStore();
  private readonly wallets: WalletManager;
  private readonly trading: TradingEngine;
  private readonly launchpad: TokenLaunchpad;
  private readonly social: SocialTrading;
  private readonly revenue: RevenueEngine;
  private readonly rewards: RewardsEngine;
  private readonly history: TradeHistory;
  private readonly router = new Router();
  private readonly siteDir: string | null;
  private readonly bootstrapSecret?: string;
  private readonly holdersProviders: HoldersProvider[];
  private server: http.Server | null = null;
  private readonly port: number;

  constructor(options: ServerOptions) {
    this.db = new AppDb(options.dbPath);
    this.appMode = options.appMode ?? ((process.env.APP_MODE as "live" | "mock") ?? "mock");
    this.port = options.port ?? Number(process.env.PORT ?? 8787);
    this.bootstrapSecret = options.bootstrapSecret ?? process.env.BOOTSTRAP_SECRET;

    // <repo>/packages/app/{src|dist}/api/server.js → 4 levels up = repo root /site
    const defaultSiteDir = resolve(fileURLToPath(new URL("../../../../site/", import.meta.url)));
    this.siteDir = options.siteDir !== undefined ? options.siteDir : (process.env.SITE_DIR ?? defaultSiteDir);

    // Holders providers: Blockscout (keyless) where available, mock fallback.
    // LIVE_HOLDER_DATA=1 forces live providers even in mock mode (read-only).
    this.holdersProviders = [new BlockscoutHoldersProvider(), new MockHoldersProvider()];

    this.auth = new AuthService(this.db);
    this.wallets = new WalletManager(this.db);
    this.trading = new TradingEngine();
    this.launchpad = new TokenLaunchpad(this.db);
    this.social = new SocialTrading(this.db);
    this.revenue = new RevenueEngine(this.db);
    this.rewards = new RewardsEngine(this.db);
    this.history = new TradeHistory(this.db);

    this.registerRoutes();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  /** Start listening. Returns the actual port (useful with port 0). */
  async start(): Promise<number> {
    this.server = http.createServer((req, res) => {
      void this.handle(req, res).catch((err) => {
        console.error("[api] unhandled error:", err);
        if (!res.headersSent) sendJson(res, 500, { error: "internal server error" });
        else res.end();
      });
    });
    await new Promise<void>((resolvePromise) => this.server!.listen(this.port, () => resolvePromise()));
    return this.portNumber;
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolvePromise) => this.server!.close(() => resolvePromise()));
      this.server = null;
    }
    this.db.close();
  }

  get portNumber(): number {
    const addr = this.server?.address();
    return typeof addr === "object" && addr ? addr.port : this.port;
  }

  // ── Request handling ──────────────────────────────────────────────────

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost`);

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      });
      res.end();
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      await this.handleApi(req, res, url);
      return;
    }

    this.serveStatic(url.pathname, res);
  }

  private async handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const pathSegments = url.pathname.split("/").filter(Boolean);
    const match = this.router.match(req.method ?? "GET", pathSegments);
    if (!match) {
      sendJson(res, 404, { error: "not found" });
      return;
    }

    const userId = this.auth.authenticate(req.headers.authorization);
    if (match.route.requiresAuth && userId === null) {
      sendJson(res, 401, { error: "missing or invalid API key" });
      return;
    }

    try {
      const body = req.method === "GET" ? {} : await readJsonBody(req);
      await match.route.handler({ req, res, params: match.params, query: url.searchParams, body, userId });
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message });
      } else if (err instanceof AuthError) {
        sendJson(res, err.status, { error: err.message });
      } else {
        console.error("[api] handler error:", err);
        sendJson(res, 500, { error: "internal server error" });
      }
    }
  }

  // ── Static dashboard ──────────────────────────────────────────────────

  private serveStatic(pathname: string, res: http.ServerResponse): void {
    if (!this.siteDir) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    let rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    if (rel.endsWith("/")) rel += "index.html";
    let filePath = normalize(join(this.siteDir, rel));
    if (!filePath.startsWith(normalize(this.siteDir))) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    if ((!existsSync(filePath) || !statSync(filePath).isFile()) && existsSync(filePath + ".html")) {
      filePath = filePath + ".html";
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    const data = readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": data.length,
    });
    res.end(data);
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private requireUserId(ctx: RequestContext): number {
    if (ctx.userId === null) throw new HttpError(401, "missing or invalid API key");
    return ctx.userId;
  }

  private str(ctx: RequestContext, key: string, required = true): string {
    const v = ctx.body[key];
    if (typeof v === "string" && v.length > 0) return v;
    if (required) throw new HttpError(400, `missing field: ${key}`);
    return "";
  }

  private registerRoutes(): void {
    // ── Auth ──
    this.router.publicRoute("POST", "/api/auth/register", (ctx) => {
      const secret = typeof ctx.body.bootstrapSecret === "string" ? ctx.body.bootstrapSecret : undefined;
      const refCode = typeof ctx.body.ref === "string" ? ctx.body.ref.trim() : undefined;
      const referrer = refCode ? this.db.getUserByRefCode(refCode) : undefined;
      if (refCode && !referrer) throw new HttpError(400, `unknown referral code: ${refCode}`);
      const { userId, apiKey, refCode: myRefCode } = this.auth.register(this.bootstrapSecret, secret, referrer?.user_id);
      sendJson(ctx.res, 201, { userId, apiKey, refCode: myRefCode, referredBy: referrer?.user_id ?? null, mode: this.appMode });
    });

    // ── Social / wallet login (public) ──
    this.router.publicRoute("POST", "/api/auth/challenge", (ctx) => {
      const chain = ctx.body.chain === "evm" ? "evm" : "solana";
      const { nonce, message } = this.challenges.issue(chain);
      sendJson(ctx.res, 200, { nonce, message });
    });

    this.router.publicRoute("POST", "/api/auth/wallet", async (ctx) => {
      const chain = ctx.body.chain === "evm" ? "evm" : "solana";
      const address = this.str(ctx, "address");
      const message = this.str(ctx, "message");
      const signature = this.str(ctx, "signature");
      const nonce = this.str(ctx, "nonce");
      if (!this.challenges.consume(nonce)) throw new HttpError(400, "expired or invalid challenge — request a new one");

      let externalId: string;
      let displayName = "";
      if (chain === "solana") {
        if (!verifySolanaSignature(address, message, signature)) throw new HttpError(401, "signature verification failed");
        externalId = address; // base58 — unique by construction
        displayName = `${address.slice(0, 4)}…${address.slice(-4)}`;
      } else {
        const recovered = await verifyEvmSignature(message, signature);
        if (!recovered || recovered !== normalizeEvmAddress(address)) throw new HttpError(401, "signature verification failed");
        externalId = recovered; // lowercase hex
        displayName = `${address.slice(0, 6)}…${address.slice(-4)}`;
      }

      // Referral attribution on FIRST wallet login (immutable afterwards).
      const refRaw = typeof ctx.body?.ref === "string" ? ctx.body.ref.trim() : "";
      const login = this.auth.loginWithIdentity(chain, externalId, displayName, "", refRaw || undefined);
      sendJson(ctx.res, 200, {
        userId: login.userId, apiKey: login.apiKey, isNew: login.isNew,
        provider: chain, displayName, mode: this.appMode,
      });
    });

    this.router.publicRoute("POST", "/api/auth/google", async (ctx) => {
      const credential = this.str(ctx, "credential");
      const profile = await verifyGoogleIdToken(credential, process.env.GOOGLE_CLIENT_ID ?? "");
      const login = this.auth.loginWithIdentity("google", profile.sub, profile.name || profile.email, profile.picture);
      sendJson(ctx.res, 200, {
        userId: login.userId, apiKey: login.apiKey, isNew: login.isNew,
        provider: "google", displayName: profile.name || profile.email, email: profile.email,
        avatarUrl: profile.picture, mode: this.appMode,
      });
    });

    this.router.publicRoute("POST", "/api/auth/x", async (ctx) => {
      const code = this.str(ctx, "code");
      const redirectUri = this.str(ctx, "redirectUri");
      const codeVerifier = this.str(ctx, "codeVerifier");
      const profile = await verifyXCode(code, redirectUri, codeVerifier);
      if (!profile) throw new HttpError(501, "X login is not configured (set X_CLIENT_ID / X_CLIENT_SECRET)");
      const login = this.auth.loginWithIdentity("x", profile.id, profile.name || `@${profile.username}`);
      sendJson(ctx.res, 200, {
        userId: login.userId, apiKey: login.apiKey, isNew: login.isNew,
        provider: "x", displayName: profile.name || `@${profile.username}`, username: profile.username,
        mode: this.appMode,
      });
    });

    // ── Provider config (public) — what the frontend should render ──
    this.router.publicRoute("GET", "/api/auth/providers", (ctx) => {
      sendJson(ctx.res, 200, {
        google: process.env.GOOGLE_CLIENT_ID ?? null,
        x: Boolean(process.env.X_CLIENT_ID && process.env.X_CLIENT_SECRET),
        xClientId: process.env.X_CLIENT_ID ?? null,
      });
    });

    // ── Advanced user profile (photo, bio, socials, name) ──
    this.router.route("GET", "/api/me/profile", (ctx) => {
      const userId = this.requireUserId(ctx);
      const row = this.db.getProfile(userId);
      const socialLinks = parseSocialLinks(row?.social_links);
      const pnl = this.db.getUserPnl(userId);
      sendJson(ctx.res, 200, {
        profile: {
          userId,
          displayName: row?.display_name ?? "",
          bio: row?.bio ?? "",
          avatarUrl: row?.avatar_url ?? "",
          xHandle: row?.x_handle ?? "",
          socialLinks,
          followersCount: row?.followers_count ?? 0,
          followingCount: row?.following_count ?? 0,
          joinedAt: row?.joined_at ?? null,
        },
        stats: {
          totalPnlUsdc: pnl.totalPnlUsdc,
          winRate: pnl.winRate,
          totalTrades: pnl.totalTrades,
          volumeUsdc: pnl.volumeUsdc,
        },
        mode: this.appMode,
      });
    });

    this.router.route("POST", "/api/me/profile", (ctx) => {
      const userId = this.requireUserId(ctx);
      const str = (key: string, max: number): string => {
        const v = ctx.body?.[key];
        if (v === undefined || v === null) return ""; // absent → no change handled below
        return String(v).trim().slice(0, max);
      };
      const updates: Record<string, string> = {};
      const displayName = str("displayName", 40);
      if (displayName !== "") updates.displayName = displayName;
      const bio = typeof ctx.body?.bio === "string" ? ctx.body.bio.trim().slice(0, 280) : undefined;
      if (bio !== undefined) updates.bio = bio;
      const avatarUrl = str("avatarUrl", 300);
      if (avatarUrl && !/^https:\/\//i.test(avatarUrl)) throw new HttpError(400, "avatarUrl must be an https URL");
      if (avatarUrl) updates.avatarUrl = avatarUrl;
      const xHandle = str("xHandle", 30);
      if (xHandle) updates.xHandle = xHandle.replace(/^@/, "");
      const socialRaw = ctx.body?.socialLinks;
      if (socialRaw !== undefined) {
        if (typeof socialRaw !== "object" || socialRaw === null || Array.isArray(socialRaw)) {
          throw new HttpError(400, "socialLinks must be an object");
        }
        const links: Record<string, string> = {};
        for (const key of ["twitter", "telegram", "website", "discord"] as const) {
          const raw = (socialRaw as Record<string, unknown>)[key];
          if (raw === undefined || raw === null || raw === "") continue;
          const s = String(raw).trim().slice(0, 300);
          if (!/^https:\/\/[\w.-]+/i.test(s)) throw new HttpError(400, `socialLinks.${key} must be an https URL`);
          links[key] = s;
        }
        updates.socialLinks = JSON.stringify(links);
      }
      if (!Object.keys(updates).length) throw new HttpError(400, "no profile fields to update");
      this.db.updateProfile(userId, updates);
      const row = this.db.getProfile(userId);
      sendJson(ctx.res, 200, {
        profile: {
          userId,
          displayName: row?.display_name ?? "",
          bio: row?.bio ?? "",
          avatarUrl: row?.avatar_url ?? "",
          xHandle: row?.x_handle ?? "",
          socialLinks: parseSocialLinks(row?.social_links),
          followersCount: row?.followers_count ?? 0,
          followingCount: row?.following_count ?? 0,
          joinedAt: row?.joined_at ?? null,
        },
        mode: this.appMode,
      });
    });

    this.router.route("GET", "/api/me", (ctx) => {
      const userId = this.requireUserId(ctx);
      const user = this.db.getUserById(userId);
      sendJson(ctx.res, 200, { userId, refCode: user?.ref_code ?? null, referredBy: user?.referred_by ?? null, mode: this.appMode });
    });

    // ── Referrals ──
    this.router.route("GET", "/api/me/referrals", (ctx) => {
      const userId = this.requireUserId(ctx);
      const user = this.db.getUserById(userId);
      sendJson(ctx.res, 200, {
        refCode: user?.ref_code ?? null,
        count: this.db.countReferrals(userId),
        referrals: this.db.getReferrals(userId, 100),
      });
    });

    // ── Search (tokens + users, fomo-style fuzzy) ──
    this.router.publicRoute("GET", "/api/search", (ctx) => {
      const term = (ctx.query.get("q") ?? "").trim();
      if (term.length < 2) throw new HttpError(400, "query `q` must be at least 2 characters");
      const limit = Math.min(Number(ctx.query.get("limit") ?? 10), 25);
      sendJson(ctx.res, 200, {
        tokens: this.db.searchLaunches(term, limit).map((l) => this.launchpad.formatLaunchPublic(l)),
        users: this.db.searchUsers(term, limit),
      });
    });

    // ── Token metadata (public) — name + logo for launchpad tokens by symbol.
    // The frontend's shared TokenMeta layer consumes this to give every token a
    // real logo/name; unknown symbols simply won't appear in the response.
    this.router.publicRoute("GET", "/api/tokens/meta", (ctx) => {
      const q = (ctx.query.get("symbols") ?? "").toUpperCase();
      const requested = q.split(",").map((s) => s.trim()).filter(Boolean);
      const launches = this.db.listAllLaunches(undefined, "latest", 100);
      const meta: Record<string, { name: string; symbol: string; chain: string; imageUrl: string | null; tokenAddress: string | null }> = {};
      for (const l of launches) {
        const sym = (l.symbol ?? "").toUpperCase();
        if (!sym) continue;
        if (requested.length > 0 && !requested.includes(sym)) continue;
        meta[sym] = {
          name: l.name ?? sym,
          symbol: sym,
          chain: l.chain ?? "",
          imageUrl: l.image_url || null,
          tokenAddress: l.token_address || null,
        };
      }
      sendJson(ctx.res, 200, { meta, count: Object.keys(meta).length });
    });

    // ── Chains (public) ──
    this.router.publicRoute("GET", "/api/chains", (ctx) => {
      const chains = Object.values(CHAINS).map((c) => ({
        id: c.id, name: c.name, chainId: c.chainId, evm: c.evm,
        nativeCurrency: c.nativeCurrency, usdcAddress: c.usdcAddress,
        usdcDecimals: c.usdcDecimals, dexAggregator: c.dexAggregator,
        supportsLaunches: c.supportsLaunches,
      }));
      sendJson(ctx.res, 200, { chains, mode: this.appMode });
    });

    // ── Health ──
    this.router.publicRoute("GET", "/api/health", (ctx) => {
      sendJson(ctx.res, 200, { ok: true, mode: this.appMode });
    });

    // ── Waitlist (landing page email capture) ──
    this.router.publicRoute("GET", "/api/waitlist/count", (ctx) => {
      sendJson(ctx.res, 200, { count: this.db.countWaitlist(), mode: this.appMode });
    });

    this.router.publicRoute("POST", "/api/waitlist", (ctx) => {
      const email = this.str(ctx, "email");
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "invalid email");
      const added = this.db.addWaitlist(email);
      const entry = this.db.getWaitlistEntry(email);
      const position = entry ? entry.id : this.db.countWaitlist();
      const refCode = `TRN-${position.toString(36).toUpperCase()}-${Math.floor(1000 + Math.random() * 9000)}`;
      sendJson(ctx.res, added ? 201 : 200, {
        added,
        count: this.db.countWaitlist(),
        position,
        refCode,
        mode: this.appMode,
      });
    });

    // ── Closed Beta Access Code Verification ──
    this.router.publicRoute("POST", "/api/auth/access-code", (ctx) => {
      const code = (this.str(ctx, "code") ?? "").trim().toUpperCase();
      const validCodes = new Set(
        (process.env.ACCESS_CODES ? process.env.ACCESS_CODES.split(",") : ["ALPHA2027", "TRENCHES", "EARLYACCESS", "FOUNDER"])
          .map((c) => c.trim().toUpperCase())
      );
      if (validCodes.has(code)) {
        sendJson(ctx.res, 200, { valid: true, message: "Welcome to TRENCHES Closed Beta" });
      } else {
        throw new HttpError(401, "Invalid access code. Request an invitation below.");
      }
    });

    // ── Wallets ──
    this.router.route("GET", "/api/wallets", (ctx) => {
      const userId = this.requireUserId(ctx);
      sendJson(ctx.res, 200, { wallets: this.wallets.listWallets(userId) });
    });

    this.router.route("POST", "/api/wallets", (ctx) => {
      const userId = this.requireUserId(ctx);
      const chain = this.str(ctx, "chain");
      const password = this.str(ctx, "password");
      const label = this.str(ctx, "label", false) || "Primary";
      const config = getChain(chain);
      if (!config) throw new HttpError(400, `unknown chain: ${chain}`);
      const wallet = chain === "solana"
        ? this.wallets.createSolanaWallet(userId, password, label)
        : this.wallets.createEvmWallet(userId, chain, password, label);
      sendJson(ctx.res, 201, { wallet });
    });

    this.router.route("POST", "/api/wallets/import", (ctx) => {
      const userId = this.requireUserId(ctx);
      const chain = this.str(ctx, "chain");
      const privateKey = this.str(ctx, "privateKey");
      const password = this.str(ctx, "password");
      const label = this.str(ctx, "label", false) || "Imported";
      if (!getChain(chain)) throw new HttpError(400, `unknown chain: ${chain}`);
      try {
        const wallet = this.wallets.importWallet(userId, chain, privateKey, password, label);
        sendJson(ctx.res, 201, { wallet });
      } catch {
        throw new HttpError(400, "invalid private key for chain");
      }
    });

    this.router.route("DELETE", "/api/wallets/:id", (ctx) => {
      const userId = this.requireUserId(ctx);
      const walletId = Number(ctx.params.id);
      if (!Number.isFinite(walletId)) throw new HttpError(400, "invalid wallet id");
      const password = this.str(ctx, "password");
      const deleted = this.wallets.deleteWallet(userId, walletId, password);
      if (!deleted) throw new HttpError(404, "wallet not found or wrong password");
      sendJson(ctx.res, 200, { deleted: true });
    });

    // ── Prediction markets (public market data from Polymarket) ──
    this.router.publicRoute("GET", "/api/prediction/categories", (ctx) => {
      sendJson(ctx.res, 200, { categories: PREDICTION_CATEGORIES });
    });

    this.router.publicRoute("GET", "/api/prediction/events", async (ctx) => {
      const category = ctx.query.get("category") || undefined;
      const trending = ctx.query.get("sort") === "trending";
      const limit = Math.min(Number(ctx.query.get("limit") ?? 30), 100);
      const offset = Number(ctx.query.get("offset") ?? 0);
      const events = await fetchPredictionEvents({ category, limit, offset, trending });
      sendJson(ctx.res, 200, { events, count: events.length, source: "polymarket" });
    });

    this.router.publicRoute("GET", "/api/prediction/events/:slug", async (ctx) => {
      const slug = ctx.params.slug;
      if (!slug) throw new HttpError(400, "missing event slug");
      const event = await fetchPredictionEventCached(slug);
      if (!event) throw new HttpError(404, "event not found");
      sendJson(ctx.res, 200, { event, source: "polymarket" });
    });

    // ── Prediction order execution (auth — places a real Polymarket order) ──
    this.router.route("POST", "/api/prediction/order", async (ctx) => {
      const userId = this.requireUserId(ctx);
      const password = this.str(ctx, "password");
      const tokenId = this.str(ctx, "tokenId");
      const side = this.str(ctx, "side").toUpperCase() === "SELL" ? "SELL" : "BUY";
      const price = this.str(ctx, "price");
      const size = this.str(ctx, "size");

      const wallet = this.db.getWallet(userId, "polygon");
      if (!wallet) throw new HttpError(404, "no polygon wallet — create one in the Wallet tab first");
      const encrypted: EncryptedPayload = typeof wallet.encrypted_key === "string"
        ? JSON.parse(wallet.encrypted_key)
        : wallet.encrypted_key;
      if (!verifyPassword(encrypted, password)) throw new HttpError(401, "wrong wallet password");
      const privateKey = decrypt(encrypted, password);

      const { ethers } = await import("ethers");
      const signer = new ethers.Wallet(privateKey);
      const result = await placeClobOrder(signer, { tokenId, side, price, size });
      sendJson(ctx.res, 200, { ok: true, result, mode: this.appMode });
    });

    // ── Trades (quote) ──
    // Real quotes are the default when the server is live. Mock mode remains
    // explicitly labelled so the UI never presents a simulated fill as real.
    this.router.route("POST", "/api/trades/quote", async (ctx) => {
      this.requireUserId(ctx);
      const params = this.parseTradeParams(ctx);
      // 0x v2 wants the taker address; use the user's wallet on the source
      // chain when it exists (quote stays valid without it).
      if (params.fromChain !== "solana") {
        const takerWallet = this.db.getWallet(ctx.userId ?? 0, params.fromChain);
        if (takerWallet?.address) params.taker = takerWallet.address;
      }
      const quote = this.appMode === "mock"
        ? buildMockQuote(params)
        : await this.trading.getQuote(params).catch((err) => {
            // Real quote provider failed (network/RPC/aggregator) → fall back to
            // an honest mock quote rather than a 502, but label it clearly.
            console.warn("[api] real quote failed, using labeled mock:", err);
            return buildMockQuote(params);
          });
      sendJson(ctx.res, 200, { quote, mode: this.appMode });
    });

    this.router.route("GET", "/api/trades", (ctx) => {
      const userId = this.requireUserId(ctx);
      const limit = Math.min(Number(ctx.query.get("limit") ?? 50), 200);
      const offset = Number(ctx.query.get("offset") ?? 0);
      sendJson(ctx.res, 200, { trades: this.history.getHistory(userId, limit, offset) });
    });

    this.router.route("GET", "/api/trades/pnl", (ctx) => {
      const userId = this.requireUserId(ctx);
      sendJson(ctx.res, 200, { pnl: this.db.getUserPnl(userId) });
    });

    this.router.route("POST", "/api/trades/execute", async (ctx) => {
      const userId = this.requireUserId(ctx);
      const params = this.parseTradeParams(ctx);
      const password = this.str(ctx, "password");

      if (params.fromChain !== params.toChain) {
        throw new HttpError(501, "cross-chain bridge execution is not implemented yet (quotes only)");
      }
      const config = getChain(params.fromChain);
      if (!config) throw new HttpError(400, `unknown chain: ${params.fromChain}`);

      const wallet = this.db.getWallet(userId, params.fromChain);
      if (!wallet) throw new HttpError(404, `no ${params.fromChain} wallet — create one first`);

      // encrypted_key is stored as a JSON string in SQLite — normalize before crypto
      const encrypted: EncryptedPayload = typeof wallet.encrypted_key === "string"
        ? JSON.parse(wallet.encrypted_key)
        : wallet.encrypted_key;
      if (!verifyPassword(encrypted, password)) throw new HttpError(401, "wrong wallet password");
      const privateKey = decrypt(encrypted, password);

      const quote = this.appMode === "mock" ? buildMockQuote(params) : await this.trading.getQuote(params);

      // Fee first (revenue event), then execute, then record the trade.
      const fee = this.revenue.recordTradingFee(userId, params.amount, false, "swap", 0);
      const execCtx: ExecutionContext = { mode: this.appMode, privateKey };

      let out;
      try {
        out = config.evm
          ? await executeEvmSwap({
              ctx: execCtx, chainId: config.chainId, rpcUrl: config.rpcUrl,
              zeroXApiUrl: config.dexApiUrl, sellToken: params.sellToken,
              buyToken: params.buyToken, sellAmount: params.amount, buyAmount: quote.buyAmount,
              raw: quote.raw ?? undefined, taker: wallet.address,
              slippageBps: params.slippageBps,
            })
          : await executeSolanaSwap({
              ctx: execCtx, quoteResponse: quote.raw ?? null,
              walletAddress: wallet.address, buyAmount: quote.buyAmount,
            });
      } catch (err) {
        this.db.addTrade({
          user_id: userId, type: "swap", from_chain: params.fromChain, to_chain: params.toChain,
          sell_token: params.sellToken, buy_token: params.buyToken, sell_amount: params.amount,
          buy_amount: "0", sell_price_usdc: "0", buy_price_usdc: "0", fee_usdc: fee,
          tx_hash: "", launch_id: null, copied_user_id: null, realized_pnl_usdc: null,
          status: "failed", ts: Math.floor(Date.now() / 1000),
        });
        throw new HttpError(502, `swap execution failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      const tradeId = this.db.addTrade({
        user_id: userId, type: "swap", from_chain: params.fromChain, to_chain: params.toChain,
        sell_token: params.sellToken, buy_token: params.buyToken, sell_amount: params.amount,
        buy_amount: out.buyAmount, sell_price_usdc: "0", buy_price_usdc: "0", fee_usdc: fee,
        tx_hash: out.txHash, launch_id: null, copied_user_id: null, realized_pnl_usdc: null,
        status: "confirmed", ts: Math.floor(Date.now() / 1000),
      });

      // Rewards: carved out of the REAL fee, only after the trade confirmed.
      // Idempotent per tradeId — retries can never double-pay.
      let rewardsInfo: { accrued: boolean; amountUsdc?: string; referralAccrued?: boolean } | null = null;
      try {
        rewardsInfo = this.rewards.accrueTradingReward({
          userId,
          tradeId,
          feeUsdc: fee,
          volumeUsdc: params.amount,
        });
      } catch (err) {
        console.warn("[rewards] accrual failed (trade unaffected):", err);
      }

      // Position aggregation + feed event. USDC appears on exactly one side of
      // every swap (USDC-native routing). Identify it via the chain config's
      // usdcAddress (e.g. EPjFW... on Solana), falling back to a literal "USDC".
      const chainUsdc = config.usdcAddress;
      const isUsdc = (t: string) => t === chainUsdc || t.toUpperCase() === "USDC";
      const sellTokenIsUsdc = isUsdc(params.sellToken);
      const buyTokenIsUsdc = isUsdc(params.buyToken);
      const isBuy = sellTokenIsUsdc; // buying the token = paying USDC
      if (!sellTokenIsUsdc && !buyTokenIsUsdc) {
        throw new HttpError(400, "one side of the swap must be USDC (USDC-native routing)");
      }
      const token = isBuy ? params.buyToken : params.sellToken;
      const tokenAmount = isBuy ? out.buyAmount : params.amount;
      const usdcLeg = isBuy ? params.amount : out.buyAmount;
      const usdcSide = sellTokenIsUsdc ? "sell" : "buy"; // which leg was the USDC
      // Symbol hint: the UI trades plain tickers ("SOL", "BRETT") while real
      // chain calls pass mints/addresses (long base58/hex). Capture the ticker
      // so positions, holdings and feed events carry a proper symbol + logo.
      const looksLikeTicker = /^[A-Za-z][A-Za-z0-9]{1,11}$/.test(token) && !/^0x/i.test(token);
      const wellKnownHit = WELL_KNOWN_TOKENS[token] ?? WELL_KNOWN_TOKENS[token.toLowerCase()];
      const symbolHint = looksLikeTicker ? token.toUpperCase() : (wellKnownHit?.symbol ?? "");
      this.applyToPosition(userId, params.fromChain, token, usdcSide === "sell" ? "buy" : "sell", tokenAmount, usdcLeg, fee, symbolHint);
      this.db.addFeedEvent({
        type: "swap", actor_id: userId, chain: params.fromChain, token,
        token_symbol: symbolHint || token.slice(0, 6),
        payload: { side: usdcSide === "sell" ? "buy" : "sell", usdc: usdcLeg, tokens: tokenAmount, txHash: out.txHash },
        ts: Math.floor(Date.now() / 1000),
      });

      sendJson(ctx.res, 200, {
        success: true, mode: this.appMode, tradeId, txHash: out.txHash,
        sellAmount: params.amount, buyAmount: out.buyAmount, feeUsdc: fee,
        aggregator: quote.aggregator, route: quote.route,
        rewards: rewardsInfo,
      });
    });

    // ── Launchpad ──
    this.router.publicRoute("GET", "/api/launches", (ctx) => {
      const limit = Math.min(Number(ctx.query.get("limit") ?? 30), 100);
      const status = ctx.query.get("status") ?? undefined;
      const chain = ctx.query.get("chain");
      const sort = ctx.query.get("sort") ?? "latest"; // latest | raised | buyers | price
      const launches = chain
        ? this.launchpad.listLaunches(chain, status as never, limit)
        : this.db.listAllLaunches(status, sort, limit).map((l) => this.launchpad.formatLaunchPublic(l));
      sendJson(ctx.res, 200, { launches, mode: this.appMode });
    });

    this.router.route("POST", "/api/launches", async (ctx) => {
      const userId = this.requireUserId(ctx);
      const sanitizeUrl = (v: unknown): string => {
        const s = typeof v === "string" ? v.trim() : "";
        if (!s) return "";
        if (!/^https:\/\/[\w.-]+/i.test(s)) return ""; // silently drop invalid links
        return s.slice(0, 300);
      };
      const launch = await this.launchpad.createLaunch(userId, {
        chain: this.str(ctx, "chain"),
        name: this.str(ctx, "name"),
        symbol: this.str(ctx, "symbol"),
        description: this.str(ctx, "description", false),
        imageUrl: this.str(ctx, "imageUrl", false),
        totalSupply: this.str(ctx, "totalSupply", false) || "1000000000000",
        twitterUrl: sanitizeUrl(ctx.body?.twitterUrl),
        telegramUrl: sanitizeUrl(ctx.body?.telegramUrl),
        websiteUrl: sanitizeUrl(ctx.body?.websiteUrl),
      });
      this.revenue.recordLaunchFee(userId, launch.id);
      sendJson(ctx.res, 201, { launch });
    });

    this.router.route("POST", "/api/launches/:id/buy", async (ctx) => {
      const userId = this.requireUserId(ctx);
      const id = Number(ctx.params.id);
      if (!Number.isFinite(id)) throw new HttpError(400, "invalid launch id");
      const usdcAmount = this.str(ctx, "usdcAmount");
      const result = await this.launchpad.buyTokens(userId, id, usdcAmount);
      if (!result.success) throw new HttpError(400, result.error ?? "buy failed");
      sendJson(ctx.res, 200, { result, mode: this.appMode });
    });

    this.router.route("POST", "/api/launches/:id/sell", async (ctx) => {
      const userId = this.requireUserId(ctx);
      const id = Number(ctx.params.id);
      if (!Number.isFinite(id)) throw new HttpError(400, "invalid launch id");
      const tokenAmount = this.str(ctx, "tokenAmount");
      const result = await this.launchpad.sellTokens(userId, id, tokenAmount);
      if (!result.success) throw new HttpError(400, result.error ?? "sell failed");
      sendJson(ctx.res, 200, { result, mode: this.appMode });
    });

    // ── Social / leaderboard ──
    this.router.publicRoute("GET", "/api/leaderboard", (ctx) => {
      const period = ctx.query.get("period") ?? "all";
      const limit = Math.min(Number(ctx.query.get("limit") ?? 20), 100);
      if (period !== "all") {
        // period snapshots (24h/7d/30d) refreshed lazily on read
        this.refreshLeaderboardPeriod(period);
        const rows = this.db.getLeaderboardByPeriod(period, limit);
        return sendJson(ctx.res, 200, { period, leaders: rows });
      }
      const chain = ctx.query.get("chain") ?? "all";
      sendJson(ctx.res, 200, { period: "all", leaders: this.social.getLeaderboard(chain, limit) });
    });

    // ── Positions ──
    this.router.route("GET", "/api/positions", (ctx) => {
      const userId = this.requireUserId(ctx);
      const status = ctx.query.get("status");
      sendJson(ctx.res, 200, { positions: this.db.getUserPositions(userId, status, 100) });
    });

    // ── Token holders (fomo-style token page) ──
    // Live Blockscout is the default for EVM chains that have an instance.
    // Mock is reserved as a labeled fallback only when live actually fails or is
    // unavailable for the chain — never the first thing shown to a live site.
    this.router.publicRoute("GET", "/api/tokens/:chain/:address/holders", async (ctx) => {
      const chain = ctx.params.chain ?? "";
      const address = ctx.params.address ?? "";
      if (!chain || !address || !getChain(chain)) throw new HttpError(400, `unknown chain: ${chain}`);
      const limit = Math.min(Number(ctx.query.get("limit") ?? 20), 50);

      // Order matters: first supported provider wins. Blockscout before mock.
      const providers = this.holdersProviders;
      const provider = pickHoldersProvider(chain, providers);
      if (!provider) throw new HttpError(404, `no holders provider for chain "${chain}"`);

      try {
        const result = await provider.getHolders(chain, address, limit);
        sendJson(ctx.res, 200, { ...result, labeled: provider.id === "mock" ? "SIMULATED" : "on-chain" });
      } catch (err) {
        // Live provider failed → fall back to mock, but label it honestly.
        const mock = new MockHoldersProvider();
        const result = await mock.getHolders(chain, address, limit);
        sendJson(ctx.res, 200, {
          ...result,
          labeled: "SIMULATED",
          fallbackReason: err instanceof Error ? err.message : String(err),
        });
      }
    });

    // ── Social feed ──
    this.router.publicRoute("GET", "/api/feed", (ctx) => {
      const sinceId = ctx.query.get("sinceId") !== null ? Number(ctx.query.get("sinceId")) : undefined;
      const limit = Math.min(Number(ctx.query.get("limit") ?? 30), 100);
      const events = this.db.getFeed({
        sinceId: Number.isFinite(sinceId) ? sinceId : undefined,
        limit,
        chain: ctx.query.get("chain") ?? undefined,
        token: ctx.query.get("token") ?? undefined,
      }).map((e) => ({ ...e, payload: safeParse(e.payload) }));
      sendJson(ctx.res, 200, { events, maxId: this.db.getFeedMaxId(), mode: this.appMode });
    });

    this.router.publicRoute("POST", "/api/feed/post", (ctx) => {
      const actorId = ctx.userId ?? 1;
      const text = this.str(ctx, "text");
      if (text.length > 2000) throw new HttpError(400, "text too long (max 2000 chars)");
      const rawToken = this.str(ctx, "token", false) || "SOL";
      const chain = this.str(ctx, "chain", false) || "solana";
      const direction = this.str(ctx, "direction", false) || "LONG";
      const entryPrice = this.str(ctx, "entryPrice", false) || "";
      const targetPrice = this.str(ctx, "targetPrice", false) || "";
      const stopLoss = this.str(ctx, "stopLoss", false) || "";
      const launchIdRaw = Number(ctx.body?.launchId);

      // Resolve real token metadata: launchpad tokens carry name/image via
      // their launch row; everything else falls back to the well-known map or
      // a clean ticker (never an address prefix) for the feed pill.
      let token = rawToken.slice(0, 120);
      let tokenSymbol = "";
      if (Number.isFinite(launchIdRaw) && launchIdRaw > 0) {
        const launch = this.db.getLaunch(launchIdRaw);
        if (launch) {
          token = launch.token_address || String(launch.id); // stable ref for the pill
          tokenSymbol = String(launch.symbol).toUpperCase();
        }
      }
      if (!tokenSymbol) {
        const known = WELL_KNOWN_TOKENS[token] ?? WELL_KNOWN_TOKENS[token.toLowerCase()];
        const looksLikeTicker = /^[A-Za-z][A-Za-z0-9]{1,11}$/.test(token) && !/^0x/i.test(token);
        tokenSymbol = known?.symbol ?? (looksLikeTicker ? token.toUpperCase() : token.slice(0, 6).toUpperCase());
      }

      const eventId = this.db.addFeedEvent({
        type: direction ? "thesis" : "post",
        actor_id: actorId,
        chain,
        token,
        token_symbol: tokenSymbol,
        payload: { text, direction, entryPrice, targetPrice, stopLoss, launchId: Number.isFinite(launchIdRaw) && launchIdRaw > 0 ? launchIdRaw : undefined },
        ts: Math.floor(Date.now() / 1000),
      });
      sendJson(ctx.res, 201, { success: true, eventId, tokenSymbol, mode: this.appMode });
    });

    // Server-Sent Events stream (realtime feed; polling fallback via sinceId)
    this.router.publicRoute("GET", "/api/feed/stream", (ctx) => {
      const res = ctx.res;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      res.write(": connected\n\n");
      let lastId = Number(ctx.query.get("sinceId") ?? this.db.getFeedMaxId());
      const timer = setInterval(() => {
        try {
          const events = this.db.getFeed({ sinceId: lastId, limit: 20 });
          for (const e of events) {
            lastId = Math.max(lastId, e.id);
            res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify({ ...e, payload: safeParse(e.payload) })}\n\n`);
          }
          res.write(": ping\n\n");
        } catch {
          clearInterval(timer);
          res.end();
        }
      }, 3000);
      ctx.req.on("close", () => clearInterval(timer));
    });

    // ── Portfolio ──
    this.router.route("GET", "/api/portfolio", (ctx) => {
      const userId = this.requireUserId(ctx);
      const pnl = this.db.getUserPnl(userId);
      // Enrich holdings with symbol/chain from the user's positions (pnlByToken
      // keys are token addresses; positions carry the display metadata).
      const positions = this.db.getUserPositions(userId, null, 200);
      const metaByToken = new Map();
      for (const p of positions) {
        if (p.token && p.token_symbol) metaByToken.set(p.token, p);
      }
      const wellKnownSymbol = (raw: string): string => {
        const hit = WELL_KNOWN_TOKENS[raw] ?? WELL_KNOWN_TOKENS[raw.toLowerCase()];
        return hit?.symbol ?? "";
      };
      const holdings = Object.entries(pnl.pnlByToken).map(([token, v]) => {
        const pos = metaByToken.get(token);
        const posSymbol = pos?.token_symbol || "";
        // A backend symbol that is just the address prefix is not a symbol.
        const meaningful = posSymbol && posSymbol.toUpperCase() !== token.slice(0, posSymbol.length).toUpperCase();
        return {
          token,
          symbol: meaningful ? posSymbol.toUpperCase() : wellKnownSymbol(token) || token.slice(0, 6),
          chain: pos?.chain || "",
          balance: v.balance,
          realizedPnlUsdc: v.realizedPnlUsdc,
        };
      });
      sendJson(ctx.res, 200, { pnl, holdings, positions, mode: this.appMode });
    });

    // ── Rewards (fee-funded trading + referral program) ──
    this.router.route("GET", "/api/rewards", (ctx) => {
      const userId = this.requireUserId(ctx);
      const refCode = this.db.getUserById(userId)?.ref_code ?? null;
      const stats = this.rewards.getStats(userId);
      const pnl = this.db.getUserPnl(userId);
      sendJson(ctx.res, 200, {
        balance: this.rewards.getBalance(userId),
        stats: { ...stats, myVolumeUsdc: pnl.volumeUsdc, myFeesUsdc: pnl.totalFeesUsdc },
        flag: this.rewards.getFlag(userId),
        refCode,
        mode: this.appMode,
      });
    });

    this.router.route("GET", "/api/rewards/balance", (ctx) => {
      const userId = this.requireUserId(ctx);
      sendJson(ctx.res, 200, { balance: this.rewards.getBalance(userId), flag: this.rewards.getFlag(userId) });
    });

    this.router.route("GET", "/api/rewards/stats", (ctx) => {
      const userId = this.requireUserId(ctx);
      sendJson(ctx.res, 200, { stats: this.rewards.getStats(userId), program: this.rewards.getProgramMetrics() });
    });

    this.router.route("GET", "/api/rewards/history", (ctx) => {
      const userId = this.requireUserId(ctx);
      const entries = this.rewards.getHistory(userId, {
        type: ctx.query.get("type") ?? undefined,
        status: ctx.query.get("status") ?? undefined,
        limit: Math.min(Number(ctx.query.get("limit") ?? 100), 500),
        offset: Number(ctx.query.get("offset") ?? 0),
      });
      sendJson(ctx.res, 200, { entries });
    });

    this.router.route("POST", "/api/rewards/claim", (ctx) => {
      const userId = this.requireUserId(ctx);
      try {
        const result = this.rewards.claim(userId);
        sendJson(ctx.res, 200, { ...result, status: "CLAIMED", mode: this.appMode });
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : "claim failed");
      }
    });

    this.router.publicRoute("GET", "/api/rewards/leaderboard", (ctx) => {
      const periodRaw = ctx.query.get("period") ?? "all";
      const period = (["24h", "7d", "30d", "all"] as const).includes(periodRaw as never) ? (periodRaw as "24h" | "7d" | "30d" | "all") : "all";
      const rows = this.rewards.getLeaderboard(period, Math.min(Number(ctx.query.get("limit") ?? 20), 100));
      sendJson(ctx.res, 200, {
        period,
        leaders: rows.map((r, i) => ({
          rank: i + 1,
          userId: r.user_id,
          totalUsdc: (Number(BigInt(r.total)) / 1e6).toFixed(2),
          entries: r.entries,
        })),
      });
    });

    // ── Referrals ──
    this.router.route("GET", "/api/referrals", (ctx) => {
      const userId = this.requireUserId(ctx);
      const volumes = this.db.referralVolumes(userId, 200);
      const user = this.db.getUserById(userId);
      sendJson(ctx.res, 200, {
        refCode: user?.ref_code ?? null,
        referrals: volumes.map((r) => ({
          userId: r.user_id,
          joinedAt: r.created_at,
          volumeUsdc: r.volume_usdc,
          trades: r.trades,
          status: Number(r.volume_usdc ?? 0) > 0 ? "active" : "inactive",
        })),
      });
    });

    this.router.route("GET", "/api/referrals/stats", (ctx) => {
      const userId = this.requireUserId(ctx);
      const s = this.rewards.getStats(userId);
      sendJson(ctx.res, 200, {
        total: s.referralsTotal,
        active: s.referralsActive,
        inactive: s.referralsInactive,
        volumeUsdc: s.referralVolumeUsdc,
        rewardsUsdc: s.referralRewardsUsdc,
      });
    });

    this.router.route("GET", "/api/referrals/link", (ctx) => {
      const userId = this.requireUserId(ctx);
      const user = this.db.getUserById(userId);
      const code = user?.ref_code ?? null;
      sendJson(ctx.res, 200, {
        refCode: code,
        link: code ? `/join?ref=${code}` : null,
      });
    });

    // ── Rewards admin config (protected by ADMIN_SECRET header/body) ──
    const requireAdmin = (ctx: RequestContext): void => {
      const secret = process.env.ADMIN_SECRET ?? "";
      const provided = ctx.req.headers["x-admin-secret"] ?? "";
      if (!secret || provided !== secret) throw new HttpError(403, "admin secret required");
    };

    this.router.route("GET", "/api/rewards/config", (ctx) => {
      const userId = this.requireUserId(ctx);
      requireAdmin(ctx);
      sendJson(ctx.res, 200, { config: this.rewards.getConfig(), raw: this.db.getAllRewardsConfig(), metrics: this.rewards.getProgramMetrics() });
      void userId;
    });

    this.router.route("POST", "/api/rewards/config", (ctx) => {
      requireAdmin(ctx);
      const config = this.rewards.setConfig((ctx.body ?? {}) as Record<string, number | string | boolean>);
      sendJson(ctx.res, 200, { config });
    });

    this.router.route("POST", "/api/rewards/flags", (ctx) => {
      requireAdmin(ctx);
      const target = Number(ctx.body?.userId);
      const flag = String(ctx.body?.flag ?? "").toUpperCase();
      if (!Number.isFinite(target)) throw new HttpError(400, "invalid userId");
      if (!["NORMAL", "REVIEW", "BLOCKED"].includes(flag)) throw new HttpError(400, "flag must be NORMAL | REVIEW | BLOCKED");
      this.rewards.setFlag(target, flag as never, String(ctx.body?.reason ?? ""));
      sendJson(ctx.res, 200, { userId: target, flag, reason: String(ctx.body?.reason ?? "") });
    });

    // ── Subscriptions ──
    this.router.route("GET", "/api/subscription", (ctx) => {
      const userId = this.requireUserId(ctx);
      sendJson(ctx.res, 200, { tier: this.revenue.getSubscription(userId) });
    });

    this.router.route("POST", "/api/subscription", (ctx) => {
      const userId = this.requireUserId(ctx);
      const tierId = this.str(ctx, "tierId");
      try {
        const tier = this.revenue.subscribe(userId, tierId);
        sendJson(ctx.res, 200, { tier });
      } catch {
        throw new HttpError(400, `unknown tier: ${tierId}`);
      }
    });

    // ── Copy-trade settings (preferences only; execution not active in beta) ──
    this.router.route("GET", "/api/copy-settings", (ctx) => {
      const userId = this.requireUserId(ctx);
      const row = this.db.getCopySettings(userId);
      if (!row) {
        sendJson(ctx.res, 200, { settings: null, mode: this.appMode });
        return;
      }
      let chains: string[] = ["solana", "ethereum", "base"];
      try {
        const parsed = JSON.parse(row.chains);
        if (Array.isArray(parsed)) chains = parsed;
      } catch {}
      sendJson(ctx.res, 200, {
        settings: {
          enabled: Boolean(row.enabled),
          maxPerTradeUsdc: Number(row.max_per_trade_usdc ?? 0) / 1e6,
          maxTotalUsdc: Number(row.max_total_usdc ?? 0) / 1e6,
          chains,
        },
        mode: this.appMode,
      });
    });

    this.router.route("POST", "/api/copy-settings", (ctx) => {
      const userId = this.requireUserId(ctx);
      const enabled = Boolean(ctx.body?.enabled);
      const maxPerTrade = Number(ctx.body?.maxPerTradeUsdc);
      const maxTotal = Number(ctx.body?.maxTotalUsdc);
      if (!Number.isFinite(maxPerTrade) || maxPerTrade <= 0) throw new HttpError(400, "maxPerTradeUsdc must be a positive number");
      if (!Number.isFinite(maxTotal) || maxTotal < maxPerTrade) throw new HttpError(400, "maxTotalUsdc must be >= maxPerTradeUsdc");
      const ALLOWED_CHAINS = new Set(["solana", "ethereum", "base", "bsc", "arbitrum", "polygon", "robinhood", "monad", "arc"]);
      const chains = Array.isArray(ctx.body?.chains)
        ? (ctx.body.chains as unknown[]).filter((c): c is string => typeof c === "string" && ALLOWED_CHAINS.has(c))
        : ["solana", "ethereum", "base"];
      this.db.setCopySettings(userId, {
        userId,
        maxPerTradeUsdc: String(Math.round(maxPerTrade * 1e6)),
        maxTotalUsdc: String(Math.round(maxTotal * 1e6)),
        enabled: enabled ? 1 : 0,
        chains,
      } as never);
      sendJson(ctx.res, 200, {
        settings: { enabled, maxPerTradeUsdc: maxPerTrade, maxTotalUsdc: maxTotal, chains },
        mode: this.appMode,
      });
    });
  }

  /** Aggregate a buy/sell leg into the user's open position and emit close events. */
  private applyToPosition(userId: number, chain: string, token: string, side: "buy" | "sell", tokenAmount: string, usdcAmount: string, feeUsdc = "0", symbol = ""): void {
    const existing = this.db.getOpenPosition(userId, chain, token);
    const merged = applySwapToPosition(existing, { side, tokenAmount, usdcAmount, feeUsdc, ts: Math.floor(Date.now() / 1000) });
    // identity fields must win over merged's placeholders (merged re-derives them);
    // symbol fills empty metadata (new positions) and backfills legacy empty rows.
    const row = {
      ...merged,
      id: existing?.id,
      user_id: userId,
      chain,
      token,
      token_symbol: existing?.token_symbol || symbol || merged.token_symbol || "",
    };
    this.db.upsertPosition(row);
    if (merged.status === "closed" && merged.realized_pnl_usdc !== null) {
      this.db.addFeedEvent({
        type: "position_closed", actor_id: userId, chain, token,
        payload: { pnl: merged.realized_pnl_usdc },
        ts: Math.floor(Date.now() / 1000),
      });
    }
  }

  /** Refresh a period snapshot lazily (24h/7d/30d) — cheap for small DBs. */
  private refreshLeaderboardPeriod(period: string): void {
    const seconds = period === "24h" ? 86400 : period === "7d" ? 604800 : period === "30d" ? 2592000 : 0;
    if (seconds <= 0) return;
    const rows = this.db.getPnlSince(Math.floor(Date.now() / 1000) - seconds, 25);
    this.db.saveLeaderboardSnapshot(period, rows);
  }

  private parseTradeParams(ctx: RequestContext): TradeParams {
    const fromChain = this.str(ctx, "fromChain");
    const toChain = this.str(ctx, "toChain", false) || fromChain;
    const sellToken = this.str(ctx, "sellToken");
    const buyToken = this.str(ctx, "buyToken");
    const amount = this.str(ctx, "amount");
    if (!/^\d+$/.test(amount)) throw new HttpError(400, "amount must be an integer in smallest units");
    const type = (this.str(ctx, "type", false) || "swap") as TradeParams["type"];
    const slippageBps = typeof ctx.body.slippageBps === "number" ? ctx.body.slippageBps : undefined;
    return { userId: ctx.userId ?? 0, fromChain, toChain, sellToken, buyToken, amount, slippageBps, type };
  }
}

/** Safe JSON.parse for stored payload strings. */
function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return {}; }
}

/** Parse a profiles.social_links JSON string into a safe record. */
function parseSocialLinks(raw: unknown): Record<string, string> {
  if (typeof raw !== "string" || !raw) return {};
  const parsed = safeParse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === "string" && /^https:\/\//i.test(v)) out[k] = v;
  }
  return out;
}

/** Deterministic offline quote for mock mode (always labeled mock upstream). */
export function buildMockQuote(params: TradeParams): import("../trading/engine.js").TradeQuote {
  const isBridge = params.fromChain !== params.toChain;
  const engine = new TradingEngine();
  const fee = engine.calculateFee(params.amount, isBridge);
  return {
    fromChain: params.fromChain,
    toChain: params.toChain,
    sellToken: params.sellToken,
    buyToken: params.buyToken,
    sellAmount: params.amount,
    buyAmount: params.amount, // 1:1 simulated rate
    priceImpact: "0",
    feeUsdc: fee,
    gasEstimate: "0",
    route: "mock",
    aggregator: "mock",
    expiresAt: Date.now() + 30_000,
    raw: null,
  };
}
