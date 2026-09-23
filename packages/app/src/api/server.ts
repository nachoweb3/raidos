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
import { registerTokenMetadataRoutes } from "./token-metadata.js";
import { MarketDataService } from "../market/data.js";
import { registerMarketCatalogRoutes } from "../market/routes.js";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, normalize, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AppDb } from "../database/app-db.js";
import { WalletManager } from "../wallets/manager.js";
import { decrypt, verifyPassword, type EncryptedPayload } from "../wallets/crypto.js";
import { TradingEngine, type TradeParams } from "../trading/engine.js";
import { TokenLaunchpad } from "../trading/launchpad.js";
import { LaunchRaydium, LaunchLabError, sessionIdFor } from "../trading/launch-raydium.js";
import { LaunchCpmm, CpmmError } from "../trading/launch-cpmm.js";
import { Connection, Keypair, Transaction } from "@solana/web3.js";
import { FactoryError, LaunchFactory, planFromJson, planToJson } from "../trading/launch-factory.js";
import { AmmError, LaunchAmm, quoteSwap, poolExecutionEnabled, SWAP_FEE_BPS } from "../trading/launch-amm.js";
import { RewardsPayout, PayoutError, rewardsPayoutFromEnv } from "../trading/rewards-payout.js";
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
import { BalanceScanner } from "../wallets/balances.js";
import { BlockscoutHoldersProvider, MockHoldersProvider, pickHoldersProvider, type HoldersProvider } from "../market/holders.js";
import { fetchPredictionEvents, fetchPredictionEventCached, PREDICTION_CATEGORIES } from "../market/prediction.js";
import { hashExecutionRequest } from "../trading/lifecycle.js";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { isUsdc as isChainUsdc, toMicroUsdc } from "../trading/pnl.js";
import { ExecutionReconciler, RpcReceiptProvider, type ReceiptFill, type ReceiptProvider } from "../trading/reconciler.js";

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
  /** Explicit adapter injection for isolated integration tests. */
  marketData?: MarketDataService;
  /** Explicit receipt provider injection for isolated integration tests. */
  receiptProvider?: ReceiptProvider;
  /** Explicit Solana Connection factory for isolated integration tests
   *  (LaunchLab / factory / AMM). Default: SOLANA_RPC_URL or none. */
  solanaConnectionFactory?: () => Connection;
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
  private readonly balanceScanner: BalanceScanner;
  private readonly trading: TradingEngine;
  private readonly launchpad: TokenLaunchpad;
  private launchFactory!: LaunchFactory;
  private launchAmm!: LaunchAmm;
  private launchLab!: LaunchRaydium;
  private launchCpmm!: LaunchCpmm;
  private readonly social: SocialTrading;
  private readonly revenue: RevenueEngine;
  private readonly rewards: RewardsEngine;
  private readonly history: TradeHistory;
  private readonly router = new Router();
  private readonly marketData: MarketDataService;
  private readonly receiptProvider: ReceiptProvider | null;
  private readonly siteDir: string | null;
  private readonly bootstrapSecret?: string;
  private readonly holdersProviders: HoldersProvider[];
  private server: http.Server | null = null;
  private readonly port: number;
  private reconcileTimer: NodeJS.Timeout | null = null;
  /** Solana connection factory (LaunchLab/factory/AMM); returns null without RPC. */
  private readonly solanaConnectionFactory: () => Connection | null;
  constructor(options: ServerOptions) {
    this.appMode = options.appMode ?? ((process.env.APP_MODE as "live" | "mock") ?? "mock");
    if (this.appMode !== "live" && this.appMode !== "mock") throw new Error("APP_MODE must be live or mock");
    this.db = new AppDb(options.dbPath, this.appMode);
    this.marketData = options.marketData ?? new MarketDataService();
    this.receiptProvider = options.receiptProvider ?? null;
    this.port = options.port ?? Number(process.env.PORT ?? 8787);
    this.bootstrapSecret = options.bootstrapSecret ?? process.env.BOOTSTRAP_SECRET;
    this.solanaConnectionFactory =
      options.solanaConnectionFactory ??
      (process.env.SOLANA_RPC_URL ? () => new Connection(process.env.SOLANA_RPC_URL!, "confirmed") : () => null);

    // <repo>/packages/app/{src|dist}/api/server.js → 4 levels up = repo root /site
    const defaultSiteDir = resolve(fileURLToPath(new URL("../../../../site/", import.meta.url)));
    this.siteDir = options.siteDir !== undefined ? options.siteDir : (process.env.SITE_DIR ?? defaultSiteDir);

    // Holders providers: Blockscout (keyless) where available, mock fallback.
    // LIVE_HOLDER_DATA=1 forces live providers even in mock mode (read-only).
    this.holdersProviders = [new BlockscoutHoldersProvider(), new MockHoldersProvider()];

    this.auth = new AuthService(this.db);
    this.wallets = new WalletManager(this.db);
    this.balanceScanner = new BalanceScanner();
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
    // Live mode reconciles pending self-custody transactions periodically.
    // One pass at a time; errors are logged, never fatal, and stop() clears it.
    if (this.appMode === "live") {
      this.reconcileTimer = setInterval(() => {
        void this.reconcileExecutionTransactions().catch((err) => {
          console.warn("[api] periodic reconcile failed:", err instanceof Error ? err.message : "unknown error");
        });
      }, 15_000);
      this.reconcileTimer.unref?.();
    }
    return this.portNumber;
  }

  async stop(): Promise<void> {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
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
      this.writeCorsHeaders(req, res);
      res.writeHead(204);
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

    this.writeCorsHeaders(req, res);
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

  private writeCorsHeaders(req: http.IncomingMessage, res: http.ServerResponse): void {
    const requestOrigin = req.headers.origin;
    const configured = (process.env.ALLOWED_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean);
    const allowed = requestOrigin && (configured.length === 0 ? requestOrigin === `http://${req.headers.host}` : configured.includes(requestOrigin));
    if (allowed) res.setHeader("Access-Control-Allow-Origin", requestOrigin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
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
    registerTokenMetadataRoutes(this.router, this.db);
    registerMarketCatalogRoutes(this.router, this.db.marketCatalog, this.marketData);
    // Shared public market data; these endpoints never authorize trades.
    const marketReply = async (ctx: RequestContext, field: string, operation: () => Promise<import("../market/data.js").MarketSnapshot<any[]>>) => {
      try {
        const result = await operation();
        if (field === "pairs") this.db.marketCatalog.ingest(result);
        const { data, ...meta } = result;
        sendJson(ctx.res, 200, { ...meta, [field]: field === "pairs"
          ? data.map((pair) => ({ ...pair, marketStatus: pair.marketStatus ?? meta.status, marketAsOf: pair.marketAsOf ?? meta.asOf, source: pair.source ?? meta.source }))
          : data });
      } catch (err) {
        const message = err instanceof Error ? err.message : "market data unavailable";
        const invalid = /^(invalid|token batch)/i.test(message);
        sendJson(ctx.res, invalid ? 400 : 503, { status: "UNAVAILABLE", error: invalid ? message : "Market data temporarily unavailable" });
      }
    };
    this.router.publicRoute("GET", "/api/market/security", async (ctx) => {
      try { sendJson(ctx.res, 200, await this.marketData.security(ctx.query.get("chain") ?? "", ctx.query.get("token") ?? "")); }
      catch { sendJson(ctx.res, 400, { status: "UNAVAILABLE", report: null, error: "invalid security query" }); }
    });
    this.router.publicRoute("GET", "/api/market/reference", (ctx) =>
      marketReply(ctx, "markets", () => this.marketData.referenceMarkets(ctx.query.get("ids") ?? "")));
    this.router.publicRoute("GET", "/api/market/search", (ctx) =>
      marketReply(ctx, "pairs", () => this.marketData.search(ctx.query.get("q") ?? "", ctx.query.get("chain") ?? undefined)));
    this.router.publicRoute("GET", "/api/market/tokens/:chain/:addresses", (ctx) =>
      marketReply(ctx, "pairs", () => this.marketData.tokens(ctx.params.chain!, (ctx.params.addresses ?? "").split(","))));
    this.router.publicRoute("GET", "/api/market/pools", (ctx) =>
      marketReply(ctx, "pairs", () => this.marketData.pools(ctx.query.get("chain") ?? "all", ctx.query.get("kind") ?? "trending", Number(ctx.query.get("page") ?? 1))));
    this.router.publicRoute("GET", "/api/market/candles", (ctx) =>
      marketReply(ctx, "candles", () => this.marketData.candles(ctx.query.get("chain") ?? "", ctx.query.get("pool") ?? "", ctx.query.get("token") ?? "", Number(ctx.query.get("aggregate") ?? 5))));
    this.router.publicRoute("GET", "/api/market/reference-candles", (ctx) =>
      marketReply(ctx, "candles", () => this.marketData.referenceCandles(ctx.query.get("coin") ?? "")));


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
      if (!this.challenges.consume(nonce, message, chain)) throw new HttpError(400, "expired or invalid challenge — request a new one");

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
      const chains = Object.values(CHAINS).map((c) => {
        // Configuration permits requesting a quote; it is not a provider probe
        // or evidence of a valid route. Never advertise testnets/other adapters.
        const quotes = c.id === "solana" ? Boolean(process.env.JUPITER_API_KEY) :
          ["ethereum", "base"].includes(c.id) && c.dexAggregator === "0x" && Boolean(process.env.ZERO_X_API_KEY);
        const selfCustody = this.appMode === "live" && quotes && SELF_CUSTODY_CHAINS.has(c.id);
        return {
          id: c.id, name: c.name, chainId: c.chainId, evm: c.evm,
          nativeCurrency: c.nativeCurrency, usdcAddress: c.usdcAddress,
          usdcDecimals: c.usdcDecimals, dexAggregator: c.dexAggregator,
          supportsLaunches: false,
          quotes,
          quoteStatus: "UNVERIFIED",
          // Self-custody signing never runs on the server: the user signs in
          // their own wallet and settlement requires a verified chain receipt.
          liveExecution: selfCustody,
          selfCustody,
          status: selfCustody ? "LIVE" : "UNAVAILABLE",
          ...(selfCustody ? {} : { reason: "Self-custody execution is available on solana, ethereum and base; this network stays read-only" }),
        };
      });
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

    // ── Access code verification (closed beta gate) ──
    // OPEN_REGISTRATION=1 opens the doors to everyone: any code verifies and
    // the UI treats the app as public (wallet/Google/X signup was always
    // self-serve; this only switches the copy/gate back on if removed).
    // Kill-switch is re-read per request — flippable in Fly without redeploy.
    this.router.publicRoute("POST", "/api/auth/access-code", (ctx) => {
      const code = (this.str(ctx, "code") ?? "").trim().toUpperCase();
      if (process.env.OPEN_REGISTRATION === "1") {
        sendJson(ctx.res, 200, { valid: true, access: "open", message: "TRENCHES is in public launch — welcome aboard" });
        return;
      }
      const validCodes = new Set(
        (process.env.ACCESS_CODES ? process.env.ACCESS_CODES.split(",") : ["ALPHA2027", "TRENCHES", "EARLYACCESS", "FOUNDER"])
          .map((c) => c.trim().toUpperCase())
      );
      if (validCodes.has(code)) {
        sendJson(ctx.res, 200, { valid: true, access: "beta", message: "Welcome to TRENCHES Closed Beta" });
      } else {
        throw new HttpError(401, "Invalid access code. Request an invitation below.");
      }
    });

    // ── Wallets ──
    this.router.route("GET", "/api/wallets", (ctx) => {
      const userId = this.requireUserId(ctx);
      sendJson(ctx.res, 200, { wallets: this.wallets.listWallets(userId) });
    });

    // Read-only on-chain balances for every wallet (public RPCs, keyless).
    this.router.route("GET", "/api/wallets/balances", async (ctx) => {
      const userId = this.requireUserId(ctx);
      const wallets = this.wallets.listWallets(userId);
      const balances = await this.balanceScanner.scanWallets(wallets);
      sendJson(ctx.res, 200, { balances, scannedAt: Math.floor(Date.now() / 1000) });
    });

    this.router.route("POST", "/api/wallets", (ctx) => {
      if (this.appMode === "live") throw new HttpError(403, "custodial wallets are disabled in live mode; connect a wallet");
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
      if (this.appMode === "live") throw new HttpError(403, "custodial wallet import is disabled in live mode; connect a wallet");
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
      if (this.appMode === "live") throw new HttpError(403, "custodial wallets are disabled in live mode; connect a wallet");
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

    // No certified non-custodial CLOB adapter. In particular, demo must never
    // decrypt keys or place a real order on the external exchange.
    this.router.route("POST", "/api/prediction/order", (ctx) => {
      sendJson(ctx.res, 503, {
        status: "UNAVAILABLE", mode: this.appMode,
        error: "Prediction order signing and settlement are not verified; market data is read-only",
      });
    });

    // ── Wallet linking (authenticated) ──
    // Adds a signature-verified wallet to the CURRENT account without rotating
    // API keys or switching identity — the missing piece for Google/X users
    // who want to trade self-custody. Existing wallet-login users already link
    // implicitly via /api/auth/wallet.
    this.router.route("POST", "/api/wallet/link", async (ctx) => {
      const userId = this.requireUserId(ctx);
      const chain = ctx.body.chain === "evm" ? "evm" : "solana";
      const address = this.str(ctx, "address");
      const message = this.str(ctx, "message");
      const signature = this.str(ctx, "signature");
      const nonce = this.str(ctx, "nonce");
      if (!this.challenges.consume(nonce, message, chain)) throw new HttpError(400, "expired or invalid challenge — request a new one");

      let identity: string;
      if (chain === "solana") {
        if (!verifySolanaSignature(address, message, signature)) throw new HttpError(401, "signature verification failed");
        identity = address;
      } else {
        const recovered = await verifyEvmSignature(message, signature);
        if (!recovered || recovered !== normalizeEvmAddress(address)) throw new HttpError(401, "signature verification failed");
        identity = recovered;
      }

      const existing = this.db.getUserByIdentity(chain, identity);
      if (existing && existing.user_id !== userId) {
        throw new HttpError(409, "this wallet already belongs to another account");
      }
      const displayName = `${address.slice(0, 4)}…${address.slice(-4)}`;
      const created = this.db.createIdentity(chain, identity, userId, displayName);
      if (!created && !existing) throw new HttpError(409, "wallet could not be linked");
      sendJson(ctx.res, 200, { linked: true, chain, address: identity, mode: this.appMode });
    });

    // ── Operator controls (admin) ──
    this.router.route("GET", "/api/admin/execution", (ctx) => {
      this.requireAdminSecret(ctx);
      sendJson(ctx.res, 200, {
        executionEnabled: this.executionEnabled(),
        source: this.db.getAppSetting("execution_enabled") !== undefined ? "database" : "environment",
        dailyLimitUsdc: process.env.EXECUTION_DAILY_LIMIT_USDC ?? "1000",
        mode: this.appMode,
      });
    });

    this.router.route("POST", "/api/admin/execution", (ctx) => {
      this.requireAdminSecret(ctx);
      const enabled = ctx.body?.enabled;
      if (typeof enabled !== "boolean") throw new HttpError(400, "body must be { enabled: true|false }");
      this.db.setAppSetting("execution_enabled", enabled ? "1" : "0");
      console.warn(`[admin] execution kill switch -> ${enabled ? "ENABLED" : "PAUSED"}`);
      sendJson(ctx.res, 200, {
        executionEnabled: enabled,
        source: "database",
        dailyLimitUsdc: process.env.EXECUTION_DAILY_LIMIT_USDC ?? "1000",
        mode: this.appMode,
      });
    });

    // ── Receipt reconciliation ──
    this.router.route("POST", "/api/admin/reconcile", async (ctx) => {
      const provided = ctx.req.headers["x-admin-secret"];
      if (!process.env.ADMIN_SECRET || provided !== process.env.ADMIN_SECRET) throw new HttpError(403, "admin secret required");
      const rpcUrls = Object.fromEntries(Object.values(CHAINS).map((chain) => [chain.id, getChain(chain.id)!.rpcUrl]));
      const result = await new ExecutionReconciler(
        this.db,
        new RpcReceiptProvider(rpcUrls),
        async (tx, _receipt, fill) => {
          // A receipt is not enough for accounting. The chain adapter must
          // provide exact, receipt-derived amounts before this transaction can
          // become a settled fill.
          if (!fill) return;
          this.settleReceiptBackedTransaction(tx, fill);
        },
      ).reconcilePending();
      sendJson(ctx.res, 200, { ...result, mode: this.appMode });
    });

    // ── Self-custody execution (real, non-custodial) ──
    // The server prepares an unsigned transaction from a live provider quote.
    // The user signs it in their own wallet (Phantom/MetaMask); the server
    // never receives a private key. Settlement happens only after the chain
    // receipt is reconciled with exact, verified token amounts.
    this.router.route("POST", "/api/trades/prepare", async (ctx) => {
      const userId = this.requireUserId(ctx);
      if (this.appMode !== "live") throw new HttpError(403, "self-custody preparation requires live mode");
      this.requireExecutionEnabled();
      const idempotencyKey = this.idempotencyKey(ctx);
      const walletAddress = this.str(ctx, "walletAddress");
      if (!/^\d{1,78}$/.test(walletAddress) && !/^0x[0-9a-fA-F]{40}$/.test(walletAddress) && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress)) {
        throw new HttpError(400, "walletAddress is missing or malformed");
      }
      const params = this.parseTradeParams(ctx);
      const config = getChain(params.fromChain);
      if (!config) throw new HttpError(400, `unknown chain: ${params.fromChain}`);
      if (!SELF_CUSTODY_CHAINS.has(params.fromChain)) {
        throw new HttpError(403, "self-custody execution is not enabled on this network");
      }

      // Ownership: the taker must have proven possession of this address by
      // signing a challenge, and it must be linked to the authenticated user.
      const identity = this.db.getUserByIdentity(config.evm ? "evm" : "solana", this.normalizedIdentity(config.evm, walletAddress));
      if (!identity || identity.user_id !== userId) {
        throw new HttpError(403, "connect this wallet to your account first (sign-in challenge), then retry");
      }

      const request = { params, walletAddress };
      const requestHash = hashExecutionRequest(request);
      const sessionId = randomUUID();
      try {
        // Exposure gate: buys check the known USDC leg before contacting the
        // provider; sells resolve their USDC leg from the quote and re-check
        // afterwards. The resolved leg is persisted with the session so daily
        // accounting counts each swap exactly once.
        const isUsdcLeg = (token: string) => isChainUsdc(token, params.fromChain);
        if (isUsdcLeg(params.sellToken)) {
          this.assertDailyExposure(userId, params.fromChain, BigInt(params.amount));
        }
        const prepared = await this.trading.prepareSelfCustodyTransaction({ ...params, userId }, walletAddress);
        const usdcLegMicro = isUsdcLeg(params.sellToken) ? BigInt(params.amount) : BigInt(prepared.quote.buyAmount);
        if (!isUsdcLeg(params.sellToken)) {
          this.assertDailyExposure(userId, params.fromChain, usdcLegMicro);
        }
        const requestWithLeg = { ...request, usdcLegMicro: usdcLegMicro.toString(), platformFeeBps: prepared.platformFeeBps ?? 0 };
        const unsigned = prepared.unsignedTransaction;
        this.db.createSelfCustodySession({
          id: sessionId,
          userId,
          chain: params.fromChain,
          walletAddress,
          requestJson: JSON.stringify(requestWithLeg),
        });
        let intentId: number;
        try {
          intentId = this.db.createExecutionIntent({
            userId,
            endpoint: "POST /api/trades/prepare",
            idempotencyKey,
            requestHash,
            requestJson: JSON.stringify(requestWithLeg),
            mode: this.appMode,
          });
        } catch {
          // Duplicate Idempotency-Key: resolve idempotently instead of failing.
          const existing = this.db.getExecutionIntent(userId, "POST /api/trades/prepare", idempotencyKey);
          if (!existing) throw new HttpError(409, "could not claim preparation request");
          if (existing.request_hash !== requestHash) throw new HttpError(409, "Idempotency-Key was already used with a different request");
          if (existing.result_json) {
            sendJson(ctx.res, 200, JSON.parse(existing.result_json));
          } else {
            sendJson(ctx.res, 202, { success: false, pending: true, intentId: existing.id, status: existing.status, mode: existing.mode });
          }
          return;
        }
        const responseBody = {
          sessionId,
          mode: this.appMode,
          quote: prepared.quote,
          unsignedTransaction: unsigned,
          selfCustody: true,
        };
        this.db.updateExecutionIntent(intentId, {
          status: "submitted",
          resultJson: JSON.stringify(responseBody),
        });
        sendJson(ctx.res, 200, responseBody);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("quote")) {
          console.warn("[api] self-custody prepare failed:", message);
          throw new HttpError(503, "quote provider temporarily unavailable; retry shortly");
        }
        throw err;
        
      }
    });

    this.router.route("POST", "/api/trades/submit", async (ctx) => {
      const userId = this.requireUserId(ctx);
      if (this.appMode !== "live") throw new HttpError(403, "self-custody submission requires live mode");
      this.requireExecutionEnabled();
      const sessionId = this.str(ctx, "sessionId");
      const txHash = this.str(ctx, "txHash");
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(sessionId)) throw new HttpError(400, "sessionId is missing or malformed");
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(txHash)) throw new HttpError(400, "txHash is missing or malformed");

      // Exactly-once: a replayed or foreign submission cannot register a swap.
      const claim = this.db.consumeSelfCustodySession(sessionId, userId);
      if (!claim.ok) {
        if (claim.reason === "already_submitted") {
          throw new HttpError(409, "this session was already submitted; check /api/trades/pending for its status");
        }
        throw new HttpError(claim.reason === "forbidden" ? 403 : 404, "unknown or expired execution session");
      }
      const session = claim.session;

      const request = JSON.parse(session.request_json) as { params: TradeParams; walletAddress: string };
      const params = request.params;
      const idempotencyKey = "sc-" + sessionId.replace(/-/g, "");
      const requestHash = hashExecutionRequest(request);
      let intentId: number;
      try {
        intentId = this.db.createExecutionIntent({
          userId,
          endpoint: "POST /api/trades/submit",
          idempotencyKey,
          requestHash,
          requestJson: session.request_json,
          mode: this.appMode,
        });
      } catch {
        const existing = this.db.getExecutionIntent(userId, "POST /api/trades/submit", idempotencyKey);
        if (!existing) throw new HttpError(409, "could not claim execution request");
        if (existing.request_hash !== requestHash) throw new HttpError(409, "session payload does not match its intent");
        intentId = existing.id;
      }

      const tradeId = this.db.addTrade({
        user_id: userId, type: "swap", from_chain: params.fromChain, to_chain: params.toChain,
        sell_token: params.sellToken, buy_token: params.buyToken, sell_amount: params.amount,
        buy_amount: "0", sell_price_usdc: "0", buy_price_usdc: "0", fee_usdc: "0",
        tx_hash: txHash, launch_id: null, copied_user_id: null, realized_pnl_usdc: null,
        status: "pending", ts: Math.floor(Date.now() / 1000),
      });
      const transactionId = this.db.createExecutionTransaction({
        intentId,
        tradeId,
        userId,
        chain: params.fromChain,
        txHash,
        status: "submitted",
      });
      this.db.updateExecutionIntent(intentId, { status: "submitted" });

      // Reconcile this transaction immediately so a confirmed receipt settles
      // without waiting for the periodic pass. On transient failure the
      // periodic reconciler still picks it up (durable pending).
      let reconcile: { pending: number; confirmed: number; failed: number } | null = null;
      try {
        reconcile = await this.reconcileExecutionTransactions(userId);
      } catch (err) {
        console.warn("[api] inline reconcile failed:", err instanceof Error ? err.message : "unknown error");
      }

      const tx = this.db.getExecutionTransaction(intentId);
      const trade = this.db.getTrade(tradeId);
      sendJson(ctx.res, 202, {
        status: tx?.status ?? "submitted",
        transactionId,
        intentId,
        tradeId,
        txHash,
        chain: params.fromChain,
        buyAmount: trade?.buy_amount ?? null,
        realizedPnlUsdc: trade?.realized_pnl_usdc ?? null,
        reconcile,
        mode: this.appMode,
        selfCustody: true,
      });
    });

    // ── Trades (quote) ──

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
      let quote;
      if (this.appMode === "mock") {
        quote = buildMockQuote(params);
      } else {
        try {
          quote = await this.trading.getQuote(params);
        } catch (err) {
          console.warn("[api] live quote provider failed:", err instanceof Error ? err.message : "unknown error");
          throw new HttpError(503, "live quote temporarily unavailable; retry shortly");
        }
      }
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
      sendJson(ctx.res, 200, { pnl: this.db.getUserPnl(userId), mode: this.appMode, source: "settled_fills" });
    });

    this.router.route("GET", "/api/trades/pending", (ctx) => {
      const userId = this.requireUserId(ctx);
      const transactions = this.db.getPendingExecutionTransactions(userId, true).map((tx: any) => ({
        intentId: tx.intent_id,
        transactionId: tx.id,
        chain: tx.chain,
        txHash: tx.tx_hash,
        status: tx.status,
        submittedAt: tx.submitted_at,
        updatedAt: tx.updated_at,
        error: tx.error_message ?? null,
      }));
      sendJson(ctx.res, 200, { transactions, mode: this.appMode });
    });

    this.router.route("POST", "/api/trades/execute", async (ctx) => {
      const userId = this.requireUserId(ctx);
      const idempotencyKey = this.idempotencyKey(ctx);
      const params = this.parseTradeParams(ctx);
      if (this.appMode === "live") {
        throw new HttpError(403, "live custodial execution is disabled; connect and sign with your wallet");
      }
      const password = this.str(ctx, "password");
      const requestForHash = { ...params, password: undefined };
      const requestHash = hashExecutionRequest(requestForHash);
      let intentId: number;
      try {
        intentId = this.db.createExecutionIntent({
          userId,
          endpoint: "POST /api/trades/execute",
          idempotencyKey,
          requestHash,
          requestJson: JSON.stringify(requestForHash),
          mode: this.appMode,
        });
      } catch {
        const existing = this.db.getExecutionIntent(userId, "POST /api/trades/execute", idempotencyKey);
        if (!existing) throw new HttpError(409, "could not claim execution request");
        if (existing.request_hash !== requestHash) throw new HttpError(409, "Idempotency-Key was already used with a different request");
        if (existing.result_json) {
          sendJson(ctx.res, 200, JSON.parse(existing.result_json));
        } else {
          sendJson(ctx.res, 202, { success: false, pending: true, intentId: existing.id, status: existing.status, mode: existing.mode });
        }
        return;
      }

      if (params.fromChain !== params.toChain) {
        throw new HttpError(501, "cross-chain bridge execution is not implemented yet (quotes only)");
      }
      const config = getChain(params.fromChain);
      if (!config) throw new HttpError(400, `unknown chain: ${params.fromChain}`);

      const wallet = this.db.getWallet(userId, params.fromChain);
      if (!wallet) {
        this.db.updateExecutionIntent(intentId, { status: "failed", errorMessage: "wallet not found" });
        throw new HttpError(404, `no ${params.fromChain} wallet — create one first`);
      }

      // encrypted_key is stored as a JSON string in SQLite — normalize before crypto
      const encrypted: EncryptedPayload = typeof wallet.encrypted_key === "string"
        ? JSON.parse(wallet.encrypted_key)
        : wallet.encrypted_key;
      if (!verifyPassword(encrypted, password)) {
        this.db.updateExecutionIntent(intentId, { status: "failed", errorMessage: "wrong wallet password" });
        throw new HttpError(401, "wrong wallet password");
      }
      const privateKey = decrypt(encrypted, password);

      const quote = this.appMode === "mock" ? buildMockQuote(params) : await this.trading.getQuote(params);
      const chainUsdc = config.usdcAddress;
      const isUsdc = (token: string) => token === chainUsdc || token.toUpperCase() === "USDC";
      if (!isUsdc(params.sellToken) && !isUsdc(params.buyToken)) {
        this.db.updateExecutionIntent(intentId, { status: "failed", errorMessage: "swap must contain one USDC leg" });
        throw new HttpError(400, "one side of the swap must be USDC (USDC-native routing)");
      }

      // Calculate now; record revenue only inside the atomic settlement.
      const quotedUsdc = isUsdc(params.sellToken) ? params.amount : quote.buyAmount;
      const fee = this.trading.calculateFee(toMicroUsdc(quotedUsdc, params.fromChain).toString(), false);
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
        this.db.updateExecutionIntent(intentId, {
          status: "failed",
          errorMessage: "swap execution failed",
        });
        this.db.addTrade({
          user_id: userId, type: "swap", from_chain: params.fromChain, to_chain: params.toChain,
          sell_token: params.sellToken, buy_token: params.buyToken, sell_amount: params.amount,
          buy_amount: "0", sell_price_usdc: "0", buy_price_usdc: "0", fee_usdc: fee,
          tx_hash: "", launch_id: null, copied_user_id: null, realized_pnl_usdc: null,
          status: "failed", ts: Math.floor(Date.now() / 1000),
        });
        throw new HttpError(502, `swap execution failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      this.db.updateExecutionIntent(intentId, { status: "submitted" });
      const transactionId = this.db.createExecutionTransaction({
        intentId,
        tradeId: null,
        userId,
        chain: params.fromChain,
        txHash: out.txHash,
        status: this.appMode === "mock" ? "pending" : "submitted",
      });
      this.db.updateExecutionTransaction(transactionId, { status: "pending" });
      this.db.updateExecutionIntent(intentId, { status: "pending" });

      const tradeId = this.db.addTrade({
        user_id: userId, type: "swap", from_chain: params.fromChain, to_chain: params.toChain,
        sell_token: params.sellToken, buy_token: params.buyToken, sell_amount: params.amount,
        buy_amount: out.buyAmount, sell_price_usdc: "0", buy_price_usdc: "0", fee_usdc: fee,
        tx_hash: out.txHash, launch_id: null, copied_user_id: null, realized_pnl_usdc: null,
        status: "pending", ts: Math.floor(Date.now() / 1000),
      });
      this.db.updateExecutionTransaction(transactionId, { tradeId });

      // Position aggregation + feed event. USDC appears on exactly one side of
      // every swap (USDC-native routing). Identify it via the chain config's
      // usdcAddress (e.g. EPjFW... on Solana), falling back to a literal "USDC".
      const sellTokenIsUsdc = isUsdc(params.sellToken);
      const buyTokenIsUsdc = isUsdc(params.buyToken);
      const isBuy = sellTokenIsUsdc; // buying the token = paying USDC
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
      let realizedPnl: string | null = null;
      let rewardsInfo: { accrued: boolean; amountUsdc?: string; referralAccrued?: boolean } | null = null;

      // A mock broadcast is immediately eligible for deterministic settlement,
      // but it still follows the same confirmed → settled atomic projection as
      // a receipt-backed live transaction.
      this.db.updateExecutionTransaction(transactionId, { status: "confirmed" });
      this.db.updateExecutionIntent(intentId, { status: "confirmed" });
      try {
        this.db.settleExecutionTransaction({
          transactionId,
          intentId,
          userId,
          chain: params.fromChain,
          sellToken: params.sellToken,
          buyToken: params.buyToken,
          sellAmount: params.amount,
          buyAmount: out.buyAmount,
          feeUsdc: fee,
          settlementSource: "mock",
          apply: () => {
            realizedPnl = this.applyToPosition(userId, params.fromChain, token, usdcSide === "sell" ? "buy" : "sell", tokenAmount, usdcLeg, fee, symbolHint);
            this.db.updateTradeStatus(tradeId, "confirmed", realizedPnl);
            this.revenue.recordTradingFee(userId, toMicroUsdc(usdcLeg, params.fromChain).toString(), false, "swap", tradeId);
            rewardsInfo = this.rewards.accrueTradingReward({
              userId,
              tradeId,
              feeUsdc: fee,
              volumeUsdc: toMicroUsdc(usdcLeg, params.fromChain).toString(),
            });
            this.db.addFeedEvent({
              type: "swap", actor_id: userId, chain: params.fromChain, token,
              token_symbol: symbolHint || token.slice(0, 6),
              payload: { side: usdcSide === "sell" ? "buy" : "sell", usdc: usdcLeg, tokens: tokenAmount, txHash: out.txHash },
              ts: Math.floor(Date.now() / 1000),
            });
          },
        });
      } catch (err) {
        this.db.updateExecutionTransaction(transactionId, { status: "failed", errorMessage: "position settlement failed" });
        this.db.updateExecutionIntent(intentId, { status: "failed", errorMessage: "position settlement failed" });
        this.db.updateTradeStatus(tradeId, "failed");
        throw new HttpError(409, err instanceof Error ? err.message : "position settlement failed");
      }

      const response = {
        success: true, mode: this.appMode, tradeId, intentId, txHash: out.txHash,
        status: "settled" as const,
        sellAmount: params.amount, buyAmount: out.buyAmount, feeUsdc: fee,
        aggregator: quote.aggregator, route: quote.route,
        rewards: rewardsInfo,
      };
      this.db.updateExecutionIntent(intentId, { resultJson: JSON.stringify(response) });
      sendJson(ctx.res, 200, response);
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
      if (this.appMode === "live") throw new HttpError(503, "This operation has no verified on-chain execution yet");
      const sanitizeUrl = (v: unknown): string => {
        const s = typeof v === "string" ? v.trim() : "";
        if (!s) return "";
        if (!/^https:\/\/[\w.-]+/i.test(s)) return ""; // silently drop invalid links
        return s.slice(0, 300);
      };
      const draft = {
        chain: this.str(ctx, "chain"),
        name: this.str(ctx, "name"),
        symbol: this.str(ctx, "symbol"),
        description: this.str(ctx, "description", false),
        imageUrl: sanitizeUrl(ctx.body?.imageUrl),
        totalSupply: this.str(ctx, "totalSupply", false) || "1000000000000",
      };
      this.launchpad.validateDraft(draft); // reject before any revenue is charged
      const launch = await this.launchpad.createLaunch(userId, {
        ...draft,
        twitterUrl: sanitizeUrl(ctx.body?.twitterUrl),
        telegramUrl: sanitizeUrl(ctx.body?.telegramUrl),
        websiteUrl: sanitizeUrl(ctx.body?.websiteUrl),
      });
      this.revenue.recordLaunchFee(userId, launch.id);
      sendJson(ctx.res, 201, { launch, curveSimulated: true });
    });

    this.router.route("POST", "/api/launches/:id/buy", async (ctx) => {
      const userId = this.requireUserId(ctx);
      if (this.appMode === "live") throw new HttpError(503, "This operation has no verified on-chain execution yet");
      const id = Number(ctx.params.id);
      if (!Number.isFinite(id)) throw new HttpError(400, "invalid launch id");
      const usdcAmount = this.str(ctx, "usdcAmount");
      const result = await this.launchpad.buyTokens(userId, id, usdcAmount);
      if (!result.success) throw new HttpError(400, result.error ?? "buy failed");
      sendJson(ctx.res, 200, { result, mode: this.appMode });
    });

    this.router.route("POST", "/api/launches/:id/sell", async (ctx) => {
      const userId = this.requireUserId(ctx);
      if (this.appMode === "live") throw new HttpError(503, "This operation has no verified on-chain execution yet");
      const id = Number(ctx.params.id);
      if (!Number.isFinite(id)) throw new HttpError(400, "invalid launch id");
      const tokenAmount = this.str(ctx, "tokenAmount");
      const result = await this.launchpad.sellTokens(userId, id, tokenAmount);
      if (!result.success) throw new HttpError(400, result.error ?? "sell failed");
      sendJson(ctx.res, 200, { result, mode: this.appMode, curveSimulated: true });
    });

    // Real ledger activity across all launches.
    // NOTE: registered before "/api/launches/:id" so "activity" is not parsed as an id.
    this.router.publicRoute("GET", "/api/launches/activity", (ctx) => {
      const limit = Math.min(Math.max(Number(ctx.query.get("limit") ?? 15), 1), 50);
      sendJson(ctx.res, 200, { activity: this.launchpad.listActivity(limit), curveSimulated: true });
    });

    // Public curve quote — no auth, never mutates state.
    this.router.publicRoute("GET", "/api/launches/:id/quote", (ctx) => {
      const id = Number(ctx.params.id);
      if (!Number.isFinite(id)) throw new HttpError(400, "invalid launch id");
      const launch = this.db.getLaunch(id);
      if (!launch) throw new HttpError(404, "launch not found");
      const side = ctx.query.get("side") === "sell" ? "sell" : "buy";
      const raw = ctx.query.get("amount") ?? "";
      if (!/^\d{1,30}$/.test(raw)) throw new HttpError(400, "invalid amount");
      const amount = BigInt(raw);
      if (amount <= 0n) throw new HttpError(400, "invalid amount");
      let out = 0n;
      if (side === "buy") {
        out = this.launchpad.quoteBuy(launch, amount);
      } else {
        const p = this.launchpad.getLaunchPosition(ctx.userId ?? 0, id);
        const held = p ? BigInt(p.tokens) : 0n;
        out = this.launchpad.quoteSell(launch, amount > held && held > 0n ? held : amount);
      }
      sendJson(ctx.res, 200, {
        side, amount: raw, out: out.toString(),
        expiry: Date.now() + TokenLaunchpad.QUOTE_TTL_MS,
        curveSimulated: true,
      });
    });

    // Public launch detail.
    this.router.publicRoute("GET", "/api/launches/:id", (ctx) => {
      const id = Number(ctx.params.id);
      if (!Number.isFinite(id)) throw new HttpError(400, "invalid launch id");
      const launch = this.launchpad.getLaunchPublic(id);
      if (!launch) throw new HttpError(404, "launch not found");
      sendJson(ctx.res, 200, { launch, curveSimulated: true });
    });

    // The caller's own position on a launch (requires auth).
    this.router.route("GET", "/api/launches/:id/position", (ctx) => {
      const userId = this.requireUserId(ctx);
      const id = Number(ctx.params.id);
      if (!Number.isFinite(id)) throw new HttpError(400, "invalid launch id");
      const position = this.launchpad.getLaunchPosition(userId, id);
      if (!position) throw new HttpError(404, "launch not found");
      sendJson(ctx.res, 200, { position, curveSimulated: true });
    });

    // ── Launchpad claims: register the wallet that would receive curve holdings ──
    // The curve is simulated; when the on-chain factory lands, tokens will be
    // minted to these signature-verified wallets. Registration is a pure
    // ledger write — it never moves funds — but it still 503s in live mode to
    // keep the whole launchpad surface consistently gated.
    this.router.route("POST", "/api/launches/:id/claim", async (ctx) => {
      const userId = this.requireUserId(ctx);
      if (this.appMode === "live") throw new HttpError(503, "This operation has no verified on-chain execution yet");
      const id = Number(ctx.params.id);
      if (!Number.isFinite(id)) throw new HttpError(400, "invalid launch id");
      const chain = ctx.body?.chain === "evm" ? "evm" : ctx.body?.chain === "solana" ? "solana" : "";
      if (!chain) throw new HttpError(400, "chain must be 'solana' or 'evm'");
      const address = this.str(ctx, "address");
      const message = this.str(ctx, "message");
      const signature = this.str(ctx, "signature");
      try {
        const wallet = await this.launchpad.registerClaim(userId, id, { chain, address, message, signature });
        sendJson(ctx.res, 200, { claim: wallet, curveSimulated: true });
      } catch (err) {
        const code = err instanceof Error ? err.message : "";
        if (code === "NOT_FOUND") throw new HttpError(404, "launch not found");
        if (code === "INVALID_ADDRESS" || code === "INVALID_MESSAGE" || code === "INVALID_SIGNATURE") throw new HttpError(400, "invalid claim payload");
        if (code === "BAD_SIGNATURE") throw new HttpError(401, "signature verification failed");
        if (code === "WALLET_IN_USE") throw new HttpError(409, "this wallet is already registered for this launch by another account");
        if (code === "DISTRIBUTION_LOCKED") throw new HttpError(409, "distribution is locked for on-chain issuance or review");
        throw err;
      }
    });

    // The caller's claim state: net curve tokens + registered payout wallet.
    this.router.route("GET", "/api/launches/:id/claim", (ctx) => {
      const userId = this.requireUserId(ctx);
      const id = Number(ctx.params.id);
      if (!Number.isFinite(id)) throw new HttpError(400, "invalid launch id");
      const status = this.launchpad.getClaimStatus(userId, id);
      if (!status) throw new HttpError(404, "launch not found");
      sendJson(ctx.res, 200, { claim: status, curveSimulated: true });
    });

    // Operator snapshot: who would receive how many tokens on a real migration.
    // Contains user ids and wallet addresses, so it stays behind the admin secret.
    this.router.route("GET", "/api/launches/:id/distribution", (ctx) => {
      this.requireAdminSecret(ctx);
      const id = Number(ctx.params.id);
      if (!Number.isFinite(id)) throw new HttpError(400, "invalid launch id");
      const launch = this.db.getLaunch(id);
      if (!launch) throw new HttpError(404, "launch not found");
      const distribution = this.launchpad.getLaunchDistribution(id);
      sendJson(ctx.res, 200, {
        launchId: id,
        symbol: launch.symbol,
        status: launch.status,
        entries: distribution,
        claimedTokens: distribution.reduce((acc, e) => acc + BigInt(e.tokens), 0n).toString(),
        curveSimulated: true,
      });
    });

    // ── Raydium LaunchLab (REAL on-chain curve, self-custody) ──
    // Curve state lives in the LaunchLab program; this server only READS it
    // (SDK decoders over RPC) and hands unsigned transactions to the user's
    // wallet. Sessions are durable and exactly-once: the session id is the
    // hash of the exact unsigned message and every submit re-verifies the
    // signed transaction against the STORED prepare payload (never body data).
    this.launchLab = new LaunchRaydium(
      this.solanaConnectionFactory(),
      this.db,
    );

    const launchLabErrorStatus = (code: LaunchLabError["code"]): number =>
      code === "RPC_DISABLED" || code === "CONFIRMATION_FAILED" ? 503
      : code === "LAUNCH_NOT_FOUND" || code === "CONFIG_NOT_FOUND" ? 404
      : code === "NOT_USER_SIGNED" ? 401
      : code === "SHAPE_MISMATCH" || code === "CURVE_CLOSED" || code === "UNSUPPORTED_CONFIG" ? 409
      : 400;

    const requireLaunchLabWallet = (ctx: { userId: number | null }, wallet: string): number => {
      const userId = this.requireUserId(ctx as never);
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) throw new HttpError(400, "wallet is missing or malformed");
      const identity = this.db.getUserByIdentity("solana", wallet);
      if (!identity || identity.user_id !== userId) throw new HttpError(403, "connect this wallet to your account first (sign-in challenge), then retry");
      return userId;
    };

    // Our confirmed LaunchLab launches (registry only; state is on-chain).
    this.router.publicRoute("GET", "/api/launchlab/list", (ctx) => {
      const limit = Math.min(Math.max(Number(ctx.query.get("limit") ?? 50), 1), 100);
      const launches = this.db.listLaunchLabLaunches(limit)
        .filter((l) => l.confirmed_at)
        .map((l) => ({ mintA: l.mint_a, symbol: l.symbol, name: l.name, poolId: l.pool_id, creator: l.creator, confirmedAt: l.confirmed_at, confirmedSignature: l.confirmed_signature }));
      sendJson(ctx.res, 200, { launches, source: "our-registry" });
    });

    // Live on-chain curve state for one mint (public, read-only).
    this.router.publicRoute("GET", "/api/launchlab/:mintA/state", async (ctx) => {
      const mintA = String(ctx.params.mintA ?? "");
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mintA)) throw new HttpError(400, "invalid mint");
      const quote = ctx.query.get("quote") ?? "sol";
      try {
        const state = await this.launchLab.state(mintA, quote);
        const row = this.db.getLaunchLabLaunch(mintA);
        sendJson(ctx.res, 200, {
          state,
          platformLaunched: row && row.confirmed_at ? { confirmedAt: row.confirmed_at, confirmedSignature: row.confirmed_signature } : null,
        });
      } catch (err) {
        if (err instanceof LaunchLabError) throw new HttpError(launchLabErrorStatus(err.code), err.message);
        throw err;
      }
    });

    // Live curve quote (public, never mutates anything).
    this.router.publicRoute("GET", "/api/launchlab/:mintA/quote", async (ctx) => {
      const mintA = String(ctx.params.mintA ?? "");
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mintA)) throw new HttpError(400, "invalid mint");
      const side = ctx.query.get("side") === "sell" ? "sell" : "buy";
      const raw = ctx.query.get("amount") ?? "";
      if (!/^\d{1,20}$/.test(raw)) throw new HttpError(400, "invalid amount");
      const slippageBps = Number(ctx.query.get("slippageBps") ?? 100);
      if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 5000) throw new HttpError(400, "slippageBps must be 0..5000");
      try {
        const quote = await this.launchLab.quote(mintA, ctx.query.get("quote") ?? "sol", side, BigInt(raw), slippageBps);
        sendJson(ctx.res, 200, { quote, expiry: Date.now() + 10_000 });
      } catch (err) {
        if (err instanceof LaunchLabError) throw new HttpError(launchLabErrorStatus(err.code), err.message);
        throw err;
      }
    });

    // Prepare an unsigned curve buy/sell (durable session, exactly-once).
    this.router.route("POST", "/api/launchlab/:mintA/prepare", async (ctx) => {
      const wallet = this.str(ctx, "wallet");
      const userId = requireLaunchLabWallet(ctx, wallet);
      if (this.appMode !== "live") throw new HttpError(503, "LaunchLab trading requires live mode");
      this.requireExecutionEnabled();
      const mintA = String(ctx.params.mintA ?? "");
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mintA)) throw new HttpError(400, "invalid mint");
      const side = ctx.body?.side === "sell" ? "sell" : ctx.body?.side === "buy" ? "buy" : "";
      if (!side) throw new HttpError(400, "side must be 'buy' or 'sell'");
      const amountStr = this.str(ctx, "amountIn");
      if (!/^\d{1,20}$/.test(amountStr)) throw new HttpError(400, "amountIn must be a decimal string");
      const slippageBps = Number(ctx.body?.slippageBps ?? 100);
      if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 5000) throw new HttpError(400, "slippageBps must be 0..5000");
      try {
        const prepared = await this.launchLab.prepareSwap({ userId, user: wallet, mintA, quote: "sol", side, amountIn: BigInt(amountStr), slippageBps });
        this.db.createSelfCustodySession({
          id: prepared.sessionId,
          userId,
          chain: "solana",
          walletAddress: wallet,
          requestJson: JSON.stringify({
            kind: "launchlab-swap", mintA, quote: "sol", side, slippageBps,
            amountIn: amountStr, minOut: prepared.quote.minOut, user: wallet,
            unsignedSerialized: prepared.serialized,
          }),
        });
        sendJson(ctx.res, 200, { ...prepared, side, wallet });
      } catch (err) {
        if (err instanceof LaunchLabError) throw new HttpError(launchLabErrorStatus(err.code), err.message);
        throw err;
      }
    });

    // Submit a user-signed curve trade: session consumed once, shape re-checked
    // against the stored prepare payload, then broadcast + confirm + record.
    this.router.route("POST", "/api/launchlab/:mintA/submit", async (ctx) => {
      const wallet = this.str(ctx, "wallet");
      const userId = requireLaunchLabWallet(ctx, wallet);
      if (this.appMode !== "live") throw new HttpError(503, "LaunchLab trading requires live mode");
      this.requireExecutionEnabled();
      const mintA = String(ctx.params.mintA ?? "");
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mintA)) throw new HttpError(400, "invalid mint");
      const signedTx = this.str(ctx, "signedTx");
      const sessionId = this.str(ctx, "sessionId");
      if (!signedTx || !sessionId) throw new HttpError(400, "sessionId and signedTx are required");
      const consumed = this.db.consumeSelfCustodySession(sessionId, userId);
      if (!consumed.ok) {
        if (consumed.reason === "forbidden") throw new HttpError(403, "this session belongs to another account");
        if (consumed.reason === "already_submitted") throw new HttpError(409, "session already submitted");
        if (consumed.reason === "not_found") throw new HttpError(404, "unknown session (expired or never prepared)");
        throw new HttpError(409, "session is not in a submittable state");
      }
      let payload: any;
      try { payload = JSON.parse(consumed.session.request_json); } catch { throw new HttpError(500, "corrupted session payload"); }
      if (payload.kind !== "launchlab-swap" || payload.mintA !== mintA) throw new HttpError(400, "session does not match this launch");
      // The signed message must be EXACTLY the prepared one.
      let unsigned: string;
      try {
        unsigned = Transaction.from(Buffer.from(signedTx, "base64")).serializeMessage().toString("base64");
      } catch {
        throw new HttpError(400, "signed transaction could not be parsed");
      }
      if (unsigned !== Transaction.from(Buffer.from(payload.unsignedSerialized, "base64")).serializeMessage().toString("base64")) throw new HttpError(400, "signed transaction does not match the prepared session");
      try {
        const result = await this.launchLab.submitSwap({
          userId, user: wallet, mintA, quote: payload.quote, side: payload.side,
          amountIn: BigInt(payload.amountIn), minOut: BigInt(payload.minOut),
          signedTxBase64: signedTx,
          beforeBroadcast: signature => this.db.setAppSetting(`launchlab:${sessionId}`, JSON.stringify({ signature })),
        });
        sendJson(ctx.res, 200, result);
      } catch (err) {
        if (err instanceof LaunchLabError) throw new HttpError(launchLabErrorStatus(err.code), err.message);
        throw err;
      }
    });

    // Build the unsigned create-launch tx (mint keypair stays in the browser).
    this.router.route("POST", "/api/launchlab/create-tx", async (ctx) => {
      const wallet = this.str(ctx, "wallet");
      const userId = requireLaunchLabWallet(ctx, wallet);
      if (this.appMode !== "live") throw new HttpError(503, "LaunchLab creation requires live mode");
      this.requireExecutionEnabled();
      const mintPubkey = this.str(ctx, "mintPubkey");
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mintPubkey)) throw new HttpError(400, "mintPubkey must be a fresh Solana pubkey (generated in your wallet)");
      if (this.db.getLaunchLabLaunch(mintPubkey)) throw new HttpError(409, "this mint is already registered on the platform");
      const name = this.str(ctx, "name").trim();
      const symbol = this.str(ctx, "symbol").trim().toUpperCase();
      const uri = this.str(ctx, "uri").trim();
      if (!/^https:\/\//.test(uri)) throw new HttpError(400, "uri must be an https metadata URL");
      const buyRaw = this.str(ctx, "buyAmountLamports", false);
      const buyAmountLamports = buyRaw && /^\d{1,20}$/.test(buyRaw) ? BigInt(buyRaw) : 0n;
      try {
        const prepared = await this.launchLab.prepareCreateTx({ creator: wallet, mintPubkey, name, symbol, uri, buyAmountLamports });
        this.db.createSelfCustodySession({
          id: prepared.sessionId,
          userId,
          chain: "solana",
          walletAddress: wallet,
          requestJson: JSON.stringify({
            kind: "launchlab-create", mint: mintPubkey, creator: wallet, name, symbol, uri,
            buyAmountLamports: buyAmountLamports.toString(), unsignedSerialized: prepared.serialized,
          }),
        });
        sendJson(ctx.res, 200, prepared);
      } catch (err) {
        if (err instanceof LaunchLabError) throw new HttpError(launchLabErrorStatus(err.code), err.message);
        throw err;
      }
    });

    // Confirm a browser-signed create tx: session exactly-once + byte-level
    // verification that the tx REALLY creates that mint on LaunchLab.
    this.router.route("POST", "/api/launchlab/confirm-create", async (ctx) => {
      const wallet = this.str(ctx, "wallet");
      const userId = requireLaunchLabWallet(ctx, wallet);
      if (this.appMode !== "live") throw new HttpError(503, "LaunchLab creation requires live mode");
      this.requireExecutionEnabled();
      const signedTx = this.str(ctx, "signedTx");
      const sessionId = this.str(ctx, "sessionId");
      if (!signedTx || !sessionId) throw new HttpError(400, "sessionId and signedTx are required");
      const consumed = this.db.consumeSelfCustodySession(sessionId, userId);
      if (!consumed.ok) {
        if (consumed.reason === "forbidden") throw new HttpError(403, "this session belongs to another account");
        if (consumed.reason === "already_submitted") throw new HttpError(409, "session already submitted");
        if (consumed.reason === "not_found") throw new HttpError(404, "unknown session (expired or never prepared)");
        throw new HttpError(409, "session is not in a submittable state");
      }
      let payload: any;
      try { payload = JSON.parse(consumed.session.request_json); } catch { throw new HttpError(500, "corrupted session payload"); }
      if (payload.kind !== "launchlab-create") throw new HttpError(400, "session is not a LaunchLab creation");
      let unsigned: string;
      try {
        unsigned = Transaction.from(Buffer.from(signedTx, "base64")).serializeMessage().toString("base64");
      } catch {
        throw new HttpError(400, "signed transaction could not be parsed");
      }
      if (unsigned !== Transaction.from(Buffer.from(payload.unsignedSerialized, "base64")).serializeMessage().toString("base64")) throw new HttpError(400, "signed transaction does not match the prepared session");
      try {
        const result = await this.launchLab.confirmCreateTx({
          userId,
          creator: payload.creator,
          mint: payload.mint,
          symbol: payload.symbol,
          name: payload.name,
          uri: payload.uri,
          signedTxBase64: signedTx,
          beforeBroadcast: signature => this.db.setAppSetting(`launchlab:${sessionId}`, JSON.stringify({ signature })),
        });
        console.warn(`[launchlab] launch created on-chain: mint ${payload.mint} (tx ${result.signature})`);
        sendJson(ctx.res, 200, { ...result, mint: payload.mint });
      } catch (err) {
        if (err instanceof LaunchLabError) throw new HttpError(launchLabErrorStatus(err.code), err.message);
        throw err;
      }
    });

    // Recovery after timeout/restart: only the durably journaled signature is checked.
    this.router.route("GET", "/api/launchlab/sessions/:id", async (ctx) => {
      const userId = this.requireUserId(ctx);
      const session = this.db.getSelfCustodySession(ctx.params.id!);
      if (!session || session.user_id !== userId) throw new HttpError(404, "session not found");
      const payload = JSON.parse(session.request_json);
      if (!String(payload.kind).startsWith("launchlab-")) throw new HttpError(404, "not a LaunchLab session");
      const journal = this.db.getAppSetting(`launchlab:${session.id}`);
      if (!journal) return sendJson(ctx.res, 200, { status: session.status === "prepared" ? "prepared" : "not_broadcast" });
      const { signature } = JSON.parse(journal);
      const connection = this.solanaConnectionFactory();
      if (!connection) throw new HttpError(503, "Solana RPC unavailable");
      const receipt = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
      if (!receipt.value) return sendJson(ctx.res, 200, { status: "unknown", signature });
      if (receipt.value.err) return sendJson(ctx.res, 200, { status: "failed", signature });
      if (!["confirmed", "finalized"].includes(receipt.value.confirmationStatus || "")) return sendJson(ctx.res, 200, { status: "pending", signature });
      if (payload.kind === "launchlab-create") {
        const state = await this.launchLab.state(payload.mint, "sol");
        if (state.creator !== payload.creator) throw new HttpError(409, "creator mismatch");
        const ts = Math.floor(Date.now() / 1000);
        this.db.upsertLaunchLabLaunch({ mintA: payload.mint, quoteMint: state.quoteMint, poolId: state.poolId, symbol: payload.symbol, name: payload.name, creator: payload.creator, ts });
        this.db.markLaunchLabLaunchConfirmed(payload.mint, signature, ts);
      } else {
        this.db.recordLaunchLabTrade({ mintA: payload.mintA, quoteMint: "So11111111111111111111111111111111111111112", userId, side: payload.side, amountIn: payload.amountIn, minOut: payload.minOut, signature });
      }
      sendJson(ctx.res, 200, { status: "confirmed", signature, mint: payload.mint ?? payload.mintA });
    });

    // The caller's own LaunchLab fills (auth; on-chain program is the truth).
    this.router.route("GET", "/api/launchlab/:mintA/activity", (ctx) => {
      const userId = this.requireUserId(ctx);
      const mintA = String(ctx.params.mintA ?? "");
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mintA)) throw new HttpError(400, "invalid mint");
      const limit = Math.min(Math.max(Number(ctx.query.get("limit") ?? 20), 1), 50);
      sendJson(ctx.res, 200, { activity: this.launchLab.listOwnActivity(mintA, limit, userId) });
    });

    // ── Raydium CPMM (REAL post-graduation market, self-custody) ──
    // After LaunchLab migrates a curve, the real liquidity lives in the CPMM
    // pool. Same honesty contract: read-only state, unsigned tx to the user,
    // exactly-once sessions and byte-exact submit verification.
    this.launchCpmm = new LaunchCpmm(this.solanaConnectionFactory(), this.db);
    const cpmmErrorStatus = (code: CpmmError["code"]): number =>
      code === "RPC_DISABLED" || code === "CONFIRMATION_FAILED" ? 503
      : code === "POOL_NOT_FOUND" || code === "CONFIG_NOT_FOUND" ? 404
      : code === "NOT_USER_SIGNED" ? 401
      : code === "SHAPE_MISMATCH" || code === "POOL_DISABLED" ? 409
      : 400;
    const requireCpmmWallet = requireLaunchLabWallet;

    // Live CPMM pool state for one mint (public, read-only).
    this.router.publicRoute("GET", "/api/cpmm/:mintA/state", async (ctx) => {
      const mintA = String(ctx.params.mintA ?? "");
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mintA)) throw new HttpError(400, "invalid mint");
      try {
        sendJson(ctx.res, 200, { state: await this.launchCpmm.state(mintA) });
      } catch (err) {
        if (err instanceof CpmmError) throw new HttpError(cpmmErrorStatus(err.code), err.message);
        throw err;
      }
    });

    // Live CPMM quote (public, never mutates anything).
    this.router.publicRoute("GET", "/api/cpmm/:mintA/quote", async (ctx) => {
      const mintA = String(ctx.params.mintA ?? "");
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mintA)) throw new HttpError(400, "invalid mint");
      const side = ctx.query.get("side") === "sell" ? "sell" : "buy";
      const raw = ctx.query.get("amount") ?? "";
      if (!/^\d{1,20}$/.test(raw)) throw new HttpError(400, "invalid amount");
      const slippageBps = Number(ctx.query.get("slippageBps") ?? 100);
      if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 5000) throw new HttpError(400, "slippageBps must be 0..5000");
      try {
        sendJson(ctx.res, 200, { quote: await this.launchCpmm.quote(mintA, side, BigInt(raw), slippageBps), expiry: Date.now() + 10_000 });
      } catch (err) {
        if (err instanceof CpmmError) throw new HttpError(cpmmErrorStatus(err.code), err.message);
        throw err;
      }
    });

    // Prepare an unsigned CPMM swap (durable session, exactly-once).
    this.router.route("POST", "/api/cpmm/:mintA/prepare", async (ctx) => {
      if (process.env.CPMM_EXECUTION_ENABLED !== "1") throw new HttpError(503, "Direct CPMM execution is not available; use the token terminal for available routes");
      const wallet = this.str(ctx, "wallet");
      const userId = requireCpmmWallet(ctx, wallet);
      if (this.appMode !== "live") throw new HttpError(503, "CPMM trading requires live mode");
      this.requireExecutionEnabled();
      const mintA = String(ctx.params.mintA ?? "");
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mintA)) throw new HttpError(400, "invalid mint");
      const side = ctx.body?.side === "sell" ? "sell" : ctx.body?.side === "buy" ? "buy" : "";
      if (!side) throw new HttpError(400, "side must be 'buy' or 'sell'");
      const amountStr = this.str(ctx, "amountIn");
      if (!/^\d{1,20}$/.test(amountStr)) throw new HttpError(400, "amountIn must be a decimal string");
      const slippageBps = Number(ctx.body?.slippageBps ?? 100);
      if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 5000) throw new HttpError(400, "slippageBps must be 0..5000");
      try {
        const prepared = await this.launchCpmm.prepareSwap({ user: wallet, mintA, side, amountIn: BigInt(amountStr), slippageBps });
        this.db.createSelfCustodySession({
          id: prepared.sessionId,
          userId,
          chain: "solana",
          walletAddress: wallet,
          requestJson: JSON.stringify({
            kind: "cpmm-swap", mintA, side, slippageBps,
            amountIn: amountStr, minOut: prepared.quote.minOut, user: wallet,
            unsignedSerialized: prepared.serialized,
          }),
        });
        sendJson(ctx.res, 200, { ...prepared, side, wallet });
      } catch (err) {
        if (err instanceof CpmmError) throw new HttpError(cpmmErrorStatus(err.code), err.message);
        throw err;
      }
    });

    // Submit a user-signed CPMM swap: session consumed once, signed message
    // must be EXACTLY the prepared one, shape re-checked on-chain, broadcast.
    this.router.route("POST", "/api/cpmm/:mintA/submit", async (ctx) => {
      if (process.env.CPMM_EXECUTION_ENABLED !== "1") throw new HttpError(503, "Direct CPMM execution is not available; use the token terminal for available routes");
      const wallet = this.str(ctx, "wallet");
      const userId = requireCpmmWallet(ctx, wallet);
      if (this.appMode !== "live") throw new HttpError(503, "CPMM trading requires live mode");
      this.requireExecutionEnabled();
      const mintA = String(ctx.params.mintA ?? "");
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mintA)) throw new HttpError(400, "invalid mint");
      const signedTx = this.str(ctx, "signedTx");
      const sessionId = this.str(ctx, "sessionId");
      if (!signedTx || !sessionId) throw new HttpError(400, "sessionId and signedTx are required");
      const consumed = this.db.consumeSelfCustodySession(sessionId, userId);
      if (!consumed.ok) {
        if (consumed.reason === "forbidden") throw new HttpError(403, "this session belongs to another account");
        if (consumed.reason === "already_submitted") throw new HttpError(409, "session already submitted");
        if (consumed.reason === "not_found") throw new HttpError(404, "unknown session (expired or never prepared)");
        throw new HttpError(409, "session is not in a submittable state");
      }
      let payload: any;
      try { payload = JSON.parse(consumed.session.request_json); } catch { throw new HttpError(500, "corrupted session payload"); }
      if (payload.kind !== "cpmm-swap" || payload.mintA !== mintA) throw new HttpError(400, "session does not match this launch");
      let unsigned: string;
      try {
        unsigned = Transaction.from(Buffer.from(signedTx, "base64")).serializeMessage().toString("base64");
      } catch {
        throw new HttpError(400, "signed transaction could not be parsed");
      }
      if (unsigned !== Transaction.from(Buffer.from(payload.unsignedSerialized, "base64")).serializeMessage().toString("base64")) throw new HttpError(400, "signed transaction does not match the prepared session");
      try {
        const result = await this.launchCpmm.submitSwap({
          userId, user: wallet, mintA, side: payload.side,
          amountIn: BigInt(payload.amountIn), minOut: BigInt(payload.minOut),
          signedTxBase64: signedTx,
          beforeBroadcast: signature => this.db.setAppSetting(`cpmm:${sessionId}`, JSON.stringify({ signature })),
        });
        sendJson(ctx.res, 200, result);
      } catch (err) {
        if (err instanceof CpmmError) throw new HttpError(cpmmErrorStatus(err.code), err.message);
        throw err;
      }
    });

    // Recovery after timeout/restart: only the durably journaled signature is
    // checked on-chain — a crash between prepare and broadcast leaves the
    // session "prepared" (nothing was sent), one between broadcast and record
    // is resolved against the RPC (mirrors the LaunchLab recovery contract).
    this.router.route("GET", "/api/cpmm/sessions/:id", async (ctx) => {
      const userId = this.requireUserId(ctx);
      const session = this.db.getSelfCustodySession(ctx.params.id!);
      if (!session || session.user_id !== userId) throw new HttpError(404, "session not found");
      const payload = JSON.parse(session.request_json);
      if (payload.kind !== "cpmm-swap") throw new HttpError(404, "not a CPMM session");
      const journal = this.db.getAppSetting(`cpmm:${session.id}`);
      if (!journal) return sendJson(ctx.res, 200, { status: session.status === "prepared" ? "prepared" : "not_broadcast" });
      const { signature } = JSON.parse(journal);
      const connection = this.solanaConnectionFactory();
      if (!connection) throw new HttpError(503, "Solana RPC unavailable");
      const receipt = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
      if (!receipt.value) return sendJson(ctx.res, 200, { status: "unknown", signature });
      if (receipt.value.err) return sendJson(ctx.res, 200, { status: "failed", signature });
      if (!["confirmed", "finalized"].includes(receipt.value.confirmationStatus || "")) return sendJson(ctx.res, 200, { status: "pending", signature });
      this.db.recordLaunchLabTrade({
        mintA: payload.mintA, quoteMint: "So11111111111111111111111111111111111111112",
        userId, side: payload.side, amountIn: payload.amountIn, minOut: payload.minOut, signature,
      });
      sendJson(ctx.res, 200, { status: "confirmed", signature, mint: payload.mintA });
    });

    // The caller's own CPMM fills (auth; same launchlab_trades ledger).
    this.router.route("GET", "/api/cpmm/:mintA/activity", (ctx) => {
      const userId = this.requireUserId(ctx);
      const mintA = String(ctx.params.mintA ?? "");
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mintA)) throw new HttpError(400, "invalid mint");
      const limit = Math.min(Math.max(Number(ctx.query.get("limit") ?? 20), 1), 50);
      sendJson(ctx.res, 200, { activity: this.launchCpmm.listOwnActivity(mintA, limit, userId) });
    });

    // ── On-chain graduation factory (operator-gated) ──
    // v1 honesty contract: the curve never custodied USDC, so graduation
    // mints the real SPL token and distributes it to the signed-claim wallets
    // — it does not conjure liquidity. Supply is fixed (authority revoked).
    this.launchFactory = new LaunchFactory(this.db, {
      solana: this.solanaConnectionFactory() ?? undefined,
    });

    // Factory status for one launch (plan JSON, mint, lifecycle state).
    this.router.route("GET", "/api/launches/:id/factory", (ctx) => {
      this.requireAdminSecret(ctx);
      const id = Number(ctx.params.id);
      if (!Number.isFinite(id)) throw new HttpError(400, "invalid launch id");
      const launch = this.db.getLaunch(id);
      if (!launch) throw new HttpError(404, "launch not found");
      sendJson(ctx.res, 200, {
        launchId: id,
        factoryStatus: launch.factory_status ?? null,
        mintAddress: launch.mint_address ?? null,
        graduatedOnChain: launch.graduated_on_chain === 1,
        factoryResult: launch.factory_result ? JSON.parse(launch.factory_result) : null,
        rpcConfigured: Boolean(process.env.SOLANA_RPC_URL),
        killSwitch: this.executionEnabled(),
      });
    });

    // Step 1 — generate the graduation plan (no chain interaction, no keys).
    this.router.route("POST", "/api/launches/:id/factory/plan", (ctx) => {
      this.requireAdminSecret(ctx);
      if (!this.executionEnabled()) throw new HttpError(503, "graduation is paused by the operator kill switch");
      const id = Number(ctx.params.id);
      if (!Number.isFinite(id)) throw new HttpError(400, "invalid launch id");
      try {
        const plan = this.launchFactory.plan(id);
        sendJson(ctx.res, 200, { plan: planToJson(plan), dryRun: this.launchFactory.dryRun(plan) });
      } catch (err) {
        if (err instanceof FactoryError) {
          const status = err.code === "LAUNCH_NOT_FOUND" ? 404 : err.code === "ALREADY_GRADUATED" || err.code === "RECOVERY_REQUIRED" ? 409 : 400;
          throw new HttpError(status, err.message);
        }
        throw err;
      }
    });

    // Step 2 — execute the plan against Solana. Requires the treasury keypair
    // material (TREASURY_KEYPAIR_BASE64) and a configured RPC. Kill switch
    // applies; state transitions are persisted for operator review.
    this.router.route("POST", "/api/launches/:id/factory/execute", async (ctx) => {
      this.requireAdminSecret(ctx);
      if (!this.executionEnabled()) throw new HttpError(503, "graduation is paused by the operator kill switch");
      const id = Number(ctx.params.id);
      if (!Number.isFinite(id)) throw new HttpError(400, "invalid launch id");
      const secret = process.env.TREASURY_KEYPAIR_BASE64;
      if (!secret) throw new HttpError(503, "TREASURY_KEYPAIR_BASE64 is not configured; the server stays keyless by default");
      let planJson = ctx.body?.plan;
      if (!planJson || typeof planJson !== "object") throw new HttpError(400, "body must include the plan returned by /factory/plan");
      try {
        const plan = planFromJson(planJson);
        if (plan.launchId !== id) throw new HttpError(400, "plan launchId must match the URL");
        const treasury = Keypair.fromSecretKey(Buffer.from(secret, "base64"));
        const result = await this.launchFactory.execute(plan, treasury);
        console.warn(`[factory] launch ${id} graduated on-chain: mint ${result.mint} (${result.signatures.length} txs)`);
        sendJson(ctx.res, 200, { ...result, graduatedOnChain: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof FactoryError) {
          const status = err.code === "LAUNCH_NOT_FOUND" ? 404 : err.code === "CONFIRMATION_FAILED" ? 503 : err.code === "ALREADY_GRADUATED" || err.code === "STALE_PLAN" || err.code === "RECOVERY_REQUIRED" ? 409 : 400;
          throw new HttpError(status, `${err.code}: ${err.message}`);
        }
        throw err;
      }
    });

    // ── Launch AMM: post-graduation secondary market ──
    // Non-custodial: the server prepares unsigned swaps, the user signs first
    // (fee payer), the pool co-signs only after verifying the exact prepared
    // shape. Reserves come from the chain on every read — never the DB.
    this.launchAmm = new LaunchAmm(
      this.db,
      this.solanaConnectionFactory(),
      process.env.LAUNCH_POOL_KEYPAIR_BASE64 ? Keypair.fromSecretKey(Buffer.from(process.env.LAUNCH_POOL_KEYPAIR_BASE64, "base64")) : null,
    );

    // Pool execution is real now: durable exactly-once sessions (same
    // self_custody_sessions table), byte-exact shape verification, reserve
    // re-check at submit and a pre-broadcast signature journal. Armed by
    // POOL_EXECUTION_ENABLED=1 (+ live mode + global kill switch).
    const requirePoolExecutionEnabled = (): void => {
      if (!poolExecutionEnabled()) throw new HttpError(503, "Pool execution is not enabled on this server (POOL_EXECUTION_ENABLED must be 1). Spot self-custody trading remains available.");
    };
    // Pool snapshot for a launch: live reserves + price (chain truth).
    this.router.publicRoute("GET", "/api/launches/:id/pool", async (ctx) => {
      const id = Number(ctx.params.id);
      if (!Number.isFinite(id)) throw new HttpError(400, "invalid launch id");
      const pool = this.db.getLaunchPoolByLaunch(id);
      if (!pool) throw new HttpError(404, "no pool for this launch");
      const snapshot = await this.launchAmm.snapshot(pool);
      sendJson(ctx.res, 200, { pool: { ...snapshot, reserveToken: snapshot.reserveToken.toString(), reserveUsdc: snapshot.reserveUsdc.toString(), executionAvailable: poolExecutionEnabled() && this.appMode === "live" && this.executionEnabled(), custody: "operator", feeBps: SWAP_FEE_BPS } });
    });

    // Quote a swap against live reserves (read-only, no state change).
    this.router.publicRoute("POST", "/api/launches/:id/pool/quote", async (ctx) => {
      const id = Number(ctx.params.id);
      if (!Number.isFinite(id)) throw new HttpError(400, "invalid launch id");
      const pool = this.db.getLaunchPoolByLaunch(id);
      if (!pool) throw new HttpError(404, "no pool for this launch");
      const side = ctx.body?.side === "sell" ? "sell" : ctx.body?.side === "buy" ? "buy" : "";
      if (!side) throw new HttpError(400, "side must be 'buy' or 'sell'");
      const amountStr = this.str(ctx, "amountIn");
      if (!/^\d{1,30}$/.test(amountStr)) throw new HttpError(400, "amountIn must be a decimal string");
      const slippage = Number(ctx.body?.slippageBps ?? 100);
      if (!Number.isInteger(slippage) || slippage < 0 || slippage > 5000) throw new HttpError(400, "slippageBps must be 0..5000");
      try {
        const { reserveToken, reserveUsdc } = await this.launchAmm.getReserves(pool);
        const quote = quoteSwap(side, reserveToken, reserveUsdc, BigInt(amountStr), slippage);
        sendJson(ctx.res, 200, {
          quote: { ...quote, amountIn: quote.amountIn.toString(), amountOut: quote.amountOut.toString(), minOut: quote.minOut.toString() },
          curveSimulated: false,
        });
      } catch (err) {
        if (err instanceof AmmError) {
          const status = err.code === "NO_POOL" ? 409 : 400;
          throw new HttpError(status, err.message);
        }
        throw err;
      }
    });

    // Prepare an unsigned swap tx (user signs first; pool slot stays empty).
    // Durable session = hash of the exact unsigned message, like LaunchLab/CPMM.
    this.router.route("POST", "/api/launches/:id/pool/swap/prepare", async (ctx) => {
      requirePoolExecutionEnabled();
      const userId = this.requireUserId(ctx);
      if (this.appMode !== "live") throw new HttpError(503, "pool swaps require live mode");
      this.requireExecutionEnabled();
      const id = Number(ctx.params.id);
      if (!Number.isFinite(id)) throw new HttpError(400, "invalid launch id");
      const pool = this.db.getLaunchPoolByLaunch(id);
      if (!pool) throw new HttpError(404, "no pool for this launch");
      const side = ctx.body?.side === "sell" ? "sell" : ctx.body?.side === "buy" ? "buy" : "";
      if (!side) throw new HttpError(400, "side must be 'buy' or 'sell'");
      const amountStr = this.str(ctx, "amountIn");
      if (!/^\d{1,30}$/.test(amountStr)) throw new HttpError(400, "amountIn must be a decimal string");
      const minOutStr = this.str(ctx, "minOut");
      if (!/^\d{1,30}$/.test(minOutStr)) throw new HttpError(400, "minOut must be a decimal string");
      const wallet = this.str(ctx, "wallet");
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) throw new HttpError(400, "wallet is missing or malformed");
      const identity = this.db.getUserByIdentity("solana", wallet);
      if (!identity || identity.user_id !== userId) throw new HttpError(403, "connect this wallet to your account first (sign-in challenge), then retry");
      try {
        const prepared = await this.launchAmm.buildSwapTx({ pool, side, user: wallet, amountIn: BigInt(amountStr), minOut: BigInt(minOutStr) });
        // Quote reserves at prepare time — submit re-checks them (STALE_QUOTE).
        const reserves = await this.launchAmm.getReserves(pool);
        this.db.createSelfCustodySession({
          id: prepared.sessionId,
          userId,
          chain: "solana",
          walletAddress: wallet,
          requestJson: JSON.stringify({
            kind: "pool-swap", poolId: pool.id, launchId: id, side,
            amountIn: amountStr, minOut: minOutStr, user: wallet,
            quoteReserves: { reserveToken: reserves.reserveToken.toString(), reserveUsdc: reserves.reserveUsdc.toString() },
            unsignedSerialized: prepared.serialized,
          }),
        });
        sendJson(ctx.res, 200, { ...prepared, poolAddress: pool.poolAddress, side });
      } catch (err) {
        if (err instanceof AmmError) {
          const status = err.code === "RPC_DISABLED" ? 503 : 400;
          throw new HttpError(status, err.message);
        }
        throw err;
      }
    });

    // Submit a user-signed swap: session consumed exactly once, the signed
    // message must be EXACTLY the prepared one, reserves re-checked, pool
    // co-signs after journaling the signature, broadcast + confirm + record.
    this.router.route("POST", "/api/launches/:id/pool/swap/submit", async (ctx) => {
      requirePoolExecutionEnabled();
      const userId = this.requireUserId(ctx);
      if (this.appMode !== "live") throw new HttpError(503, "pool swaps require live mode");
      this.requireExecutionEnabled();
      const id = Number(ctx.params.id);
      if (!Number.isFinite(id)) throw new HttpError(400, "invalid launch id");
      const pool = this.db.getLaunchPoolByLaunch(id);
      if (!pool) throw new HttpError(404, "no pool for this launch");
      const signedTx = this.str(ctx, "signedTx");
      const sessionId = this.str(ctx, "sessionId");
      if (!signedTx || !sessionId) throw new HttpError(400, "sessionId and signedTx are required");
      const wallet = this.str(ctx, "wallet");
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) throw new HttpError(400, "wallet is missing or malformed");
      const identity = this.db.getUserByIdentity("solana", wallet);
      if (!identity || identity.user_id !== userId) throw new HttpError(403, "connect this wallet to your account first (sign-in challenge), then retry");

      // Exactly-once: a replayed or foreign submission cannot swap again.
      const consumed = this.db.consumeSelfCustodySession(sessionId, userId);
      if (!consumed.ok) {
        if (consumed.reason === "forbidden") throw new HttpError(403, "this session belongs to another account");
        if (consumed.reason === "already_submitted") throw new HttpError(409, "session already submitted; use the recovery endpoint for its status");
        if (consumed.reason === "not_found") throw new HttpError(404, "unknown session (expired or never prepared)");
        throw new HttpError(409, "session is not in a submittable state");
      }
      let payload: any;
      try { payload = JSON.parse(consumed.session.request_json); } catch { throw new HttpError(500, "corrupted session payload"); }
      if (payload.kind !== "pool-swap" || payload.poolId !== pool.id) throw new HttpError(400, "session does not match this pool");
      // The signed message must be EXACTLY the prepared one.
      let unsigned: string;
      try {
        unsigned = Transaction.from(Buffer.from(signedTx, "base64")).serializeMessage().toString("base64");
      } catch {
        throw new HttpError(400, "signed transaction could not be parsed");
      }
      if (unsigned !== Transaction.from(Buffer.from(payload.unsignedSerialized, "base64")).serializeMessage().toString("base64")) throw new HttpError(400, "signed transaction does not match the prepared session");
      try {
        const result = await this.launchAmm.submitSwap({
          pool, side: payload.side, userId, user: wallet,
          amountIn: BigInt(payload.amountIn), minOut: BigInt(payload.minOut),
          signedTxBase64: signedTx,
          quoteReserves: {
            reserveToken: BigInt(payload.quoteReserves.reserveToken),
            reserveUsdc: BigInt(payload.quoteReserves.reserveUsdc),
          },
          beforeBroadcast: signature => this.db.setAppSetting(`pool:${sessionId}`, JSON.stringify({ signature })),
        });
        sendJson(ctx.res, 200, { ...result, amountOut: result.amountOut.toString() });
      } catch (err) {
        if (err instanceof AmmError) {
          const status = err.code === "RPC_DISABLED" || err.code === "NO_KEYPAIR" ? 503 : err.code === "STALE_QUOTE" ? 409 : 400;
          throw new HttpError(status, err.message);
        }
        throw err;
      }
    });

    // Recovery after timeout/restart: the pre-broadcast journal signature is
    // checked on-chain (mirrors the LaunchLab/CPMM recovery contract).
    this.router.route("GET", "/api/launches/:id/pool/sessions/:sessionId", async (ctx) => {
      const userId = this.requireUserId(ctx);
      const session = this.db.getSelfCustodySession(ctx.params.sessionId!);
      if (!session || session.user_id !== userId) throw new HttpError(404, "session not found");
      const payload = JSON.parse(session.request_json);
      if (payload.kind !== "pool-swap") throw new HttpError(404, "not a pool swap session");
      const journal = this.db.getAppSetting(`pool:${session.id}`);
      if (!journal) return sendJson(ctx.res, 200, { status: session.status === "prepared" ? "prepared" : "not_broadcast" });
      const { signature } = JSON.parse(journal);
      const connection = this.solanaConnectionFactory();
      if (!connection) throw new HttpError(503, "Solana RPC unavailable");
      const receipt = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
      if (!receipt.value) return sendJson(ctx.res, 200, { status: "unknown", signature });
      if (receipt.value.err) return sendJson(ctx.res, 200, { status: "failed", signature });
      if (!["confirmed", "finalized"].includes(receipt.value.confirmationStatus || "")) return sendJson(ctx.res, 200, { status: "pending", signature });
      // Confirmed: record the history row exactly once.
      if (!this.db.getPoolSwapBySignature(signature)) {
        this.db.recordPoolSwap(payload.poolId, userId, payload.side, payload.amountIn, payload.minOut, payload.minOut, signature);
      }
      sendJson(ctx.res, 200, { status: "confirmed", signature });
    });

    // Operator: register a pool for a graduated launch (never moves funds;
    // the operator funds the vaults separately).
    this.router.route("POST", "/api/launches/:id/pool", async (ctx) => {
      this.requireAdminSecret(ctx);
      const id = Number(ctx.params.id);
      if (!Number.isFinite(id)) throw new HttpError(400, "invalid launch id");
      const launch = this.db.getLaunch(id);
      if (!launch) throw new HttpError(404, "launch not found");
      if (launch.graduated_on_chain !== 1 || !launch.mint_address) throw new HttpError(409, "launch has not graduated on-chain; there is no real token to pool");
      if (this.db.getLaunchPoolByLaunch(id)) throw new HttpError(409, "pool already exists for this launch");
      const usdc = CHAINS.solana?.usdcAddress;
      if (!usdc) throw new HttpError(500, "Solana USDC mint is not configured");
      try {
        const created = this.launchAmm.createPool(id, launch.mint_address, usdc);
        console.warn(`[amm] pool registered for launch ${id}: pool ${created.poolAddress}`);
        sendJson(ctx.res, 200, { ...created, launchId: id, note: "vaults are NOT funded by this call; fund them from the operator wallet" });
      } catch (err) {
        if (err instanceof AmmError && err.code === "NO_KEYPAIR") throw new HttpError(503, err.message);
        throw err;
      }
    });

    // ── Social / leaderboard ──
    this.router.publicRoute("GET", "/api/leaderboard", (ctx) => {
      const period = ctx.query.get("period") ?? "all";
      const durations: Record<string, number> = { "1h": 3600, "24h": 86400, "7d": 604800, "30d": 2592000, all: 0 };
      if (!(period in durations)) throw new HttpError(400, "invalid leaderboard period");
      const limit = Number(ctx.query.get("limit") ?? 20);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, "invalid leaderboard limit");
      const chain = ctx.query.get("chain") ?? "all";
      if (chain !== "all" && !getChain(chain)) throw new HttpError(400, "unknown chain");
      const since = durations[period] ? Math.floor(Date.now() / 1000) - durations[period]! : 0;
      sendJson(ctx.res, 200, { period, chain, mode: this.appMode, source: "settled_fills",
        leaders: this.db.getTopTraders(chain, limit, since) });
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
      const providers = this.appMode === "live"
        ? this.holdersProviders.filter((provider) => provider.id !== "mock")
        : this.holdersProviders;
      const provider = pickHoldersProvider(chain, providers);
      if (!provider) throw new HttpError(503, "Live holders data is unavailable for this chain");

      try {
        const result = await provider.getHolders(chain, address, limit);
        sendJson(ctx.res, 200, { ...result, labeled: provider.id === "mock" ? "SIMULATED" : "on-chain" });
      } catch (err) {
        if (this.appMode === "live") throw new HttpError(503, "Live holders data is temporarily unavailable");
        // Only sandbox responses may contain simulated holders.
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

    this.router.route("POST", "/api/feed/post", (ctx) => {
      const actorId = this.requireUserId(ctx);
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
      // Client-supplied ticker wins when the token ref is an address — the UI
      // knows the live symbol (row context) that a bare address can't provide.
      const clientSymbol = this.str(ctx, "tokenSymbol", false);
      if (clientSymbol && /^[A-Za-z][A-Za-z0-9]{1,11}$/.test(clientSymbol)) {
        tokenSymbol = clientSymbol.toUpperCase();
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
        if (p.token) metaByToken.set(p.chain + ":" + (getChain(p.chain)?.evm ? p.token.toLowerCase() : p.token), p);
      }
      const wellKnownSymbol = (raw: string): string => {
        const hit = WELL_KNOWN_TOKENS[raw] ?? WELL_KNOWN_TOKENS[raw.toLowerCase()];
        return hit?.symbol ?? "";
      };
      const holdings = Object.entries(pnl.pnlByToken).map(([assetKey, v]) => {
        const separator = assetKey.indexOf(":");
        const chain = assetKey.slice(0, separator);
        const token = assetKey.slice(separator + 1);
        const pos = metaByToken.get(assetKey);
        const posSymbol = pos?.token_symbol || "";
        // A backend symbol that is just the address prefix is not a symbol.
        const meaningful = posSymbol && posSymbol.toUpperCase() !== token.slice(0, posSymbol.length).toUpperCase();
        return {
          token,
          symbol: meaningful ? posSymbol.toUpperCase() : wellKnownSymbol(token) || token.slice(0, 6),
          chain,
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

    // Claim rewards — REAL on-chain USDC payout when the operator treasury is
    // configured (live mode); internal-ledger claim (labeled) otherwise.
    this.router.route("POST", "/api/rewards/claim", async (ctx) => {
      const userId = this.requireUserId(ctx);
      // Payout destination: a Solana wallet linked to THIS account (required
      // in live mode — we refuse to pay an unverified address).
      const destination = typeof ctx.body?.destination === "string" ? ctx.body.destination.trim() : "";
      if (this.appMode === "live") {
        this.requireExecutionEnabled();
        if (!destination) {
          throw new HttpError(400, "destination (your linked Solana wallet) is required for the on-chain payout");
        }
        const identity = this.db.getUserByIdentity("solana", destination);
        if (!identity || identity.user_id !== userId) throw new HttpError(403, "destination wallet must be linked to your account first (sign-in challenge)");
        const connection = this.solanaConnectionFactory();
        if (!connection) throw new HttpError(503, "Solana RPC unavailable for rewards payout");
        try {
          const payout = rewardsPayoutFromEnv(this.db, connection);
          const result = await payout.claim({ userId, destinationAddress: destination });
          console.warn(`[rewards] on-chain payout user ${userId}: ${result.amountUsdc} micro-USDC → ${result.destination} (${result.signature})`);
          sendJson(ctx.res, 200, { ...result, onChain: true, status: "CLAIMED", mode: this.appMode });
        } catch (err) {
          if (err instanceof PayoutError) {
            const status = err.code === "NO_TREASURY" || err.code === "RPC_DISABLED" || err.code === "CONFIRMATION_FAILED" ? 503 : err.code === "ALREADY_CLAIMED" ? 409 : err.code === "BAD_ADDRESS" ? 400 : 400;
            throw new HttpError(status, err.message);
          }
          throw err;
        }
        return;
      }
      try {
        const result = this.rewards.claim(userId);
        sendJson(ctx.res, 200, { ...result, onChain: false, status: "CLAIMED", mode: this.appMode });
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : "claim failed");
      }
    });

    // Payout recovery: resolve a journaled claim against the RPC (never re-send).
    this.router.route("GET", "/api/rewards/claim/:sessionId", async (ctx) => {
      const userId = this.requireUserId(ctx);
      const sessionId = String(ctx.params.sessionId ?? "");
      if (!/^[a-f0-9]{32}$/.test(sessionId)) throw new HttpError(400, "invalid session id");
      const connection = this.solanaConnectionFactory();
      if (!connection) throw new HttpError(503, "Solana RPC unavailable");
      const payout = rewardsPayoutFromEnv(this.db, connection);
      try {
        const status = await payout.status(sessionId);
        void userId;
        sendJson(ctx.res, 200, { ...status, mode: this.appMode });
      } catch (err) {
        if (err instanceof PayoutError) throw new HttpError(503, err.message);
        throw err;
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

  /**
   * Reconcile the user's (or every user's) pending self-custody transactions
   * using the live RPC receipt provider. Settlement happens through the same
   * atomic receipt-backed path used by the admin endpoint.
   */
  private async reconcileExecutionTransactions(userId?: number): Promise<{ pending: number; confirmed: number; failed: number }> {
    const rpcUrls = Object.fromEntries(Object.values(CHAINS).map((chain) => [chain.id, getChain(chain.id)!.rpcUrl]));
    return new ExecutionReconciler(
      this.db,
      this.receiptProvider ?? new RpcReceiptProvider(rpcUrls),
      async (tx, _receipt, fill) => {
        if (!fill) return;
        this.settleReceiptBackedTransaction(tx, fill);
      },
    ).reconcilePending(userId);
    
  }

  /** Lowercase hex for EVM, base58 passthrough for Solana. */
  private normalizedIdentity(evm: boolean, walletAddress: string): string {
    return evm ? normalizeEvmAddress(walletAddress) : walletAddress;
  }

  /** Constant-time admin secret check; 503 without configuration. */
  private requireAdminSecret(ctx: RequestContext): void {
    const provided = ctx.req.headers["x-admin-secret"];
    const expected = process.env.ADMIN_SECRET;
    if (!expected || typeof provided !== "string" || provided.length !== expected.length ||
      !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
      throw new HttpError(403, "admin secret required");
    }
  }

  /**
   * Durable execution kill switch. A DB flag takes effect on every request;
   * when no DB flag has ever been set, EXECUTION_ENABLED=0 (env) also blocks,
   * so the switch can be armed before the first request after a fresh deploy.
   */
  private executionEnabled(): boolean {
    const flag = this.db.getAppSetting("execution_enabled");
    if (flag !== undefined) return flag === "1";
    return process.env.EXECUTION_ENABLED !== "0";
  }

  private requireExecutionEnabled(): void {
    if (!this.executionEnabled()) {
      throw new HttpError(503, "execution is paused by the operator kill switch; try again later");
    }
  }

  /**
   * Daily per-user exposure limit in USDC. Counts the persisted USDC leg of
   * every self-custody session opened in the trailing 24h (one session per
   * swap, including unsigned/prepared ones, so retries cannot multiply
   * exposure). Default 1,000 USDC/day; EXECUTION_DAILY_LIMIT_USDC=0 disables.
   */
  private assertDailyExposure(userId: number, chain: string, requestedMicro: bigint): void {
    const limitUsdc = process.env.EXECUTION_DAILY_LIMIT_USDC ?? "1000";
    if (!/^\d+$/.test(limitUsdc)) throw new HttpError(500, "EXECUTION_DAILY_LIMIT_USDC must be a non-negative integer");
    const limitMicro = BigInt(limitUsdc) * 1_000_000n;
    if (limitMicro === 0n) return; // explicitly disabled
    const since = Math.floor(Date.now() / 1000) - 86_400;
    let total = 0n;
    for (const session of this.db.getSelfCustodySessionsSince(userId, since)) {
      try {
        const request = JSON.parse(session.request_json) as { params?: TradeParams; usdcLegMicro?: string };
        const p = request?.params;
        if (!p || p.fromChain !== chain) continue;
        if (typeof request.usdcLegMicro === "string" && /^\d+$/.test(request.usdcLegMicro)) {
          total += BigInt(request.usdcLegMicro);
        } else if (isChainUsdc(p.sellToken, chain) && /^\d+$/.test(p.amount)) {
          total += BigInt(p.amount); // legacy sessions before the leg was persisted
        }
      } catch { /* malformed row: skip */ }
    }
    if (total + requestedMicro > limitMicro) {
      throw new HttpError(429, `daily execution limit exceeded for ${chain}: try again tomorrow or contact support`);
    }
  }

  /** Apply exact receipt-derived amounts to accounting exactly once. */
  private settleReceiptBackedTransaction(tx: any, fill: ReceiptFill): void {
    const request = JSON.parse(tx.request_json) as {
      params: TradeParams;
      quote?: { aggregator?: string; route?: string };
      platformFeeBps?: number;
    };
    const params = request.params;
    const config = getChain(tx.chain);
    if (!config || params.fromChain !== tx.chain || params.toChain !== tx.chain) {
      throw new Error("receipt fill chain does not match execution intent");
    }
    const isUsdc = (token: string) => isChainUsdc(token, tx.chain);
    if (isUsdc(fill.sellToken) === isUsdc(fill.buyToken)) {
      throw new Error("receipt fill must contain one USDC leg");
    }
    if (fill.sellToken !== params.sellToken || fill.buyToken !== params.buyToken) {
      throw new Error("receipt fill tokens do not match execution intent");
    }
    if (fill.sellAmount !== params.amount) {
      throw new Error("receipt fill sell amount does not match execution intent");
    }
    if (!/^\d+$/.test(fill.buyAmount) || BigInt(fill.buyAmount) <= 0n || !/^\d+$/.test(fill.feeAmount)) {
      throw new Error("receipt fill amounts must be non-negative integers");
    }

    // The session persisted the bps actually applied when the swap was built
    // (fee ATAs may not exist for every mint, so the fee can legitimately be
    // absent per swap). Never re-derive from live env: a config change between
    // prepare and receipt must not rewrite accounted history.
    const appliedFeeBps = Number(request.platformFeeBps ?? 0);
    if (!Number.isInteger(appliedFeeBps) || appliedFeeBps < 0 || appliedFeeBps > 1000) {
      throw new Error("session fee bps is malformed");
    }

    const sellTokenIsUsdc = isUsdc(fill.sellToken);
    // The platform fee counts in USDC only when it was taken in USDC itself
    // (sell-side fees on EVM buys, buy-side fees on Solana sells). Fees taken
    // in the trade token are reported in raw units via the feed and are not
    // converted with estimates.
    const feeUsdc = (fill.feeToken === "buy" ? isUsdc(fill.buyToken) : isUsdc(fill.sellToken))
      ? fill.feeAmount
      : "0";
    const token = sellTokenIsUsdc ? fill.buyToken : fill.sellToken;
    const tokenAmount = sellTokenIsUsdc ? fill.buyAmount : fill.sellAmount;
    const usdcLeg = sellTokenIsUsdc ? fill.sellAmount : fill.buyAmount;
    const side = sellTokenIsUsdc ? "buy" : "sell";
    const symbolHit = WELL_KNOWN_TOKENS[token] ?? WELL_KNOWN_TOKENS[token.toLowerCase()];
    const symbol = /^[A-Za-z][A-Za-z0-9]{1,11}$/.test(token) && !/^0x/i.test(token)
      ? token.toUpperCase() : (symbolHit?.symbol ?? "");
    const tradeId = tx.trade_id ?? this.db.addTrade({
      user_id: tx.user_id, type: "swap", from_chain: tx.chain, to_chain: tx.chain,
      sell_token: fill.sellToken, buy_token: fill.buyToken, sell_amount: fill.sellAmount,
      buy_amount: fill.buyAmount, sell_price_usdc: "0", buy_price_usdc: "0", fee_usdc: feeUsdc,
      tx_hash: tx.tx_hash, launch_id: null, copied_user_id: null, realized_pnl_usdc: null,
      status: "pending", ts: Math.floor(Date.now() / 1000),
    });

    let realizedPnl: string | null = null;
    this.db.settleExecutionTransaction({
      transactionId: tx.id,
      intentId: tx.intent_id,
      userId: tx.user_id,
      chain: tx.chain,
      sellToken: fill.sellToken,
      buyToken: fill.buyToken,
      sellAmount: fill.sellAmount,
      buyAmount: fill.buyAmount,
      feeUsdc,
      settlementSource: "receipt",
      apply: () => {
        realizedPnl = this.applyToPosition(tx.user_id, tx.chain, token, side, tokenAmount, usdcLeg, feeUsdc, symbol);
        this.db.updateTradeSettlement(tradeId, fill.buyAmount, feeUsdc);
        this.db.updateTradeStatus(tradeId, "confirmed", realizedPnl);
        try {
          this.rewards.accrueTradingReward({ userId: tx.user_id, tradeId, feeUsdc, volumeUsdc: toMicroUsdc(usdcLeg, tx.chain).toString() });
        } catch (err) {
          console.warn("[rewards] receipt settlement accrual failed:", err instanceof Error ? err.message : "unknown error");
        }
        this.db.addFeedEvent({
          type: "swap", actor_id: tx.user_id, chain: tx.chain, token,
          token_symbol: symbol || token.slice(0, 6),
          payload: { side, usdc: usdcLeg, tokens: tokenAmount, txHash: tx.tx_hash, settlementSource: "receipt" },
          ts: Math.floor(Date.now() / 1000),
        });
      },
    });
  }

  /** Aggregate a buy/sell leg into the user's open position and emit close events. */
  private applyToPosition(userId: number, chain: string, token: string, side: "buy" | "sell", tokenAmount: string, usdcAmount: string, feeUsdc = "0", symbol = ""): string | null {
    const existing = this.db.getOpenPosition(userId, chain, token);
    const merged = applySwapToPosition(existing, { side, tokenAmount, usdcAmount: toMicroUsdc(usdcAmount, chain).toString(), feeUsdc, ts: Math.floor(Date.now() / 1000) });
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
    return side === "buy" ? null : (BigInt(merged.realized_pnl_usdc ?? "0") - BigInt(existing?.realized_pnl_usdc ?? "0")).toString();
  }

  /** Refresh a period snapshot lazily (24h/7d/30d) — cheap for small DBs. */
  private refreshLeaderboardPeriod(period: string): void {
    const seconds = period === "24h" ? 86400 : period === "7d" ? 604800 : period === "30d" ? 2592000 : 0;
    if (seconds <= 0) return;
    const rows = this.db.getPnlSince(Math.floor(Date.now() / 1000) - seconds, 25);
    this.db.saveLeaderboardSnapshot(period, rows);
  }

  private idempotencyKey(ctx: RequestContext): string {
    const value = ctx.req.headers["idempotency-key"];
    if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(value)) {
      throw new HttpError(400, "Idempotency-Key header is required (8-128 safe characters)");
    }
    return value;
  }

  private parseTradeParams(ctx: RequestContext): TradeParams {
    const fromChain = this.str(ctx, "fromChain");
    const toChain = this.str(ctx, "toChain", false) || fromChain;
    const sellToken = this.str(ctx, "sellToken");
    const buyToken = this.str(ctx, "buyToken");
    const amount = this.str(ctx, "amount");
    if (!/^\d{1,78}$/.test(amount) || BigInt(amount) <= 0n) throw new HttpError(400, "amount must be a positive integer in smallest units");
    const typeRaw = this.str(ctx, "type", false) || "swap";
    if (typeRaw !== "swap") throw new HttpError(400, "only spot swaps are supported");
    if (ctx.body.slippageBps !== undefined && typeof ctx.body.slippageBps !== "number") throw new HttpError(400, "slippageBps must be a number");
    const slippageBps = ctx.body.slippageBps === undefined ? 50 : ctx.body.slippageBps as number;
    if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 5_000) {
      throw new HttpError(400, "slippageBps must be an integer between 1 and 5000");
    }
    const config = getChain(fromChain);
    if (!config) throw new HttpError(400, `unknown chain: ${fromChain}`);
    if (fromChain !== toChain) throw new HttpError(501, "cross-chain execution is not implemented");
    if (isChainUsdc(sellToken, fromChain) === isChainUsdc(buyToken, fromChain)) throw new HttpError(400, "swap must contain exactly one USDC leg");
    return { userId: ctx.userId ?? 0, fromChain, toChain, sellToken, buyToken, amount: BigInt(amount).toString(), slippageBps, type: "swap" };
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

/** Chains whose self-custody execution path is implemented and receipt-verified. */
const SELF_CUSTODY_CHAINS = new Set(["solana", "ethereum", "base"]);

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
