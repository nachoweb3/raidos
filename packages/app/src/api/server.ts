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
import { AuthService, AuthError } from "./auth.js";
import { Router, sendJson, readJsonBody, HttpError, type RequestContext } from "./router.js";
import { executeSolanaSwap, executeEvmSwap, type ExecutionContext } from "./executors.js";
import { applySwapToPosition } from "../trading/positions.js";
import { BlockscoutHoldersProvider, MockHoldersProvider, pickHoldersProvider, type HoldersProvider } from "../market/holders.js";

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

export class ApiServer {
  readonly db: AppDb;
  readonly appMode: "live" | "mock";
  private readonly auth: AuthService;
  private readonly wallets: WalletManager;
  private readonly trading: TradingEngine;
  private readonly launchpad: TokenLaunchpad;
  private readonly social: SocialTrading;
  private readonly revenue: RevenueEngine;
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
    const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const filePath = normalize(join(this.siteDir, rel));
    if (!filePath.startsWith(normalize(this.siteDir))) {
      sendJson(res, 403, { error: "forbidden" });
      return;
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

    // ── Trades ──
    this.router.route("POST", "/api/trades/quote", async (ctx) => {
      this.requireUserId(ctx);
      const params = this.parseTradeParams(ctx);
      const quote = this.appMode === "mock" ? buildMockQuote(params) : await this.trading.getQuote(params);
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
      this.applyToPosition(userId, params.fromChain, token, usdcSide === "sell" ? "buy" : "sell", tokenAmount, usdcLeg, fee);
      this.db.addFeedEvent({
        type: "swap", actor_id: userId, chain: params.fromChain, token,
        token_symbol: token.slice(0, 6),
        payload: { side: usdcSide === "sell" ? "buy" : "sell", usdc: usdcLeg, tokens: tokenAmount, txHash: out.txHash },
        ts: Math.floor(Date.now() / 1000),
      });

      sendJson(ctx.res, 200, {
        success: true, mode: this.appMode, tradeId, txHash: out.txHash,
        sellAmount: params.amount, buyAmount: out.buyAmount, feeUsdc: fee,
        aggregator: quote.aggregator, route: quote.route,
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
      const launch = await this.launchpad.createLaunch(userId, {
        chain: this.str(ctx, "chain"),
        name: this.str(ctx, "name"),
        symbol: this.str(ctx, "symbol"),
        description: this.str(ctx, "description", false),
        imageUrl: this.str(ctx, "imageUrl", false),
        totalSupply: this.str(ctx, "totalSupply", false) || "1000000000000",
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
    this.router.publicRoute("GET", "/api/tokens/:chain/:address/holders", async (ctx) => {
      const chain = ctx.params.chain ?? "";
      const address = ctx.params.address ?? "";
      if (!chain || !address || !getChain(chain)) throw new HttpError(400, `unknown chain: ${chain}`);
      const limit = Math.min(Number(ctx.query.get("limit") ?? 20), 50);
      const forceMock = this.appMode === "mock" && process.env.LIVE_HOLDER_DATA !== "1";
      const providers = forceMock
        ? this.holdersProviders.filter((p) => p.id === "mock")
        : this.holdersProviders;
      const provider = pickHoldersProvider(chain, providers);
      if (!provider) throw new HttpError(404, `no holders provider for chain "${chain}"`);
      try {
        const result = await provider.getHolders(chain, address, limit);
        sendJson(ctx.res, 200, { ...result, labeled: provider.id === "mock" ? "SIMULATED" : "on-chain" });
      } catch (err) {
        // live provider failed → fall back to mock, but say so honestly
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
      const holdings = Object.entries(pnl.pnlByToken).map(([token, v]) => ({
        token, balance: v.balance, realizedPnlUsdc: v.realizedPnlUsdc,
      }));
      sendJson(ctx.res, 200, { pnl, holdings, mode: this.appMode });
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
  }

  /** Aggregate a buy/sell leg into the user's open position and emit close events. */
  private applyToPosition(userId: number, chain: string, token: string, side: "buy" | "sell", tokenAmount: string, usdcAmount: string, feeUsdc = "0"): void {
    const existing = this.db.getOpenPosition(userId, chain, token);
    const merged = applySwapToPosition(existing, { side, tokenAmount, usdcAmount, feeUsdc, ts: Math.floor(Date.now() / 1000) });
    // identity fields must win over merged's placeholders (merged re-derives them)
    const row = {
      ...merged,
      id: existing?.id,
      user_id: userId,
      chain,
      token,
      token_symbol: existing?.token_symbol ?? "",
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
