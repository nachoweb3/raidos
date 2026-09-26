import { Router, sendJson, type RequestContext } from "../api/router.js";
import { MarketCatalog, type CatalogQuery } from "./catalog.js";
import { MarketIndexer } from "./indexer.js";
import { MarketDataService } from "./data.js";
import { GmgnService, GmgnUnavailableError, GMGN_CHAINS } from "./gmgn.js";

export function registerMarketCatalogRoutes(router: Router, catalog: MarketCatalog, market: MarketDataService, gmgn?: GmgnService) {
  const indexer = new MarketIndexer(catalog, market);
  const gmgnService = gmgn ?? new GmgnService();
  const gmgnFail = (ctx: RequestContext, err: unknown) => {
    if (err instanceof GmgnUnavailableError) {
      const msg = err.message || "GMGN unavailable";
      const disabled = msg.includes("GMGN_API_KEY not configured");
      sendJson(ctx.res, 503, { status: "UNAVAILABLE", error: msg, reason: disabled ? "GMGN_API_KEY_NOT_CONFIGURED" : "GMGN_PROVIDER_UNAVAILABLE" });
    } else {
      sendJson(ctx.res, 503, { status: "UNAVAILABLE", error: "Market provider unavailable; retry later" });
    }
  };
  // GMGN trenches: the three FOMO-board categories with smart money / KOL /
  // sniper / bundler / rug analytics. Read-only; degrades honestly to 503.
  router.publicRoute("GET", "/api/market/gmgn/trenches", async (ctx) => {
    try {
      const chain = ctx.query.get("chain") ?? "solana";
      if (!GMGN_CHAINS.includes(chain)) {
        sendJson(ctx.res, 400, { status: "UNAVAILABLE", error: `invalid chain: ${chain}` });
        return;
      }
      const platform = ctx.query.get("platform") ?? undefined;
      const result = await gmgnService.trenches(chain, platform && /^[a-z0-9_-]{1,32}$/.test(platform) ? platform : undefined);
      sendJson(ctx.res, 200, {
        ...result,
        enabled: gmgnService.enabled,
        source: "gmgn",
        note: "Analítica de wallets (smart money/KOL/sniper/bundler) según el algoritmo de GMGN. Solo lectura: la ejecución sigue siendo self-custody en TRENCHES.",
      });
    } catch (err) { gmgnFail(ctx, err); }
  });
  // GMGN token security: rug ratio 0-1 + honeypot for one address.
  router.publicRoute("GET", "/api/market/gmgn/security", async (ctx) => {
    try {
      const chain = ctx.query.get("chain") ?? "solana";
      const address = ctx.query.get("address") ?? "";
      const result = await gmgnService.tokenSecurity(chain, address);
      sendJson(ctx.res, 200, result);
    } catch (err) { gmgnFail(ctx, err); }
  });
  // On-chain token decimals/symbol straight from the chain RPC (keyless).
  // Sell orders route in token smallest units — decimals must be real, never guessed.
  router.publicRoute("GET", "/api/market/token-info", async (ctx) => {
    try {
      const chain = ctx.query.get("chain") ?? "";
      const address = ctx.query.get("address") ?? "";
      sendJson(ctx.res, 200, await market.tokenInfo(chain, address));
    } catch (err) { fail(ctx, err); }
  });
  const fail = (ctx: RequestContext, err: unknown) => {
    const message = err instanceof Error ? err.message : "";
    const invalid = message.startsWith("invalid");
    sendJson(ctx.res, invalid ? 400 : 503, { status: "UNAVAILABLE", error: invalid ? message : "Market provider unavailable; retry later" });
  };
  router.publicRoute("GET", "/api/market/trades", async (ctx) => {
    try {
      const result = await market.trades(ctx.query.get("chain") ?? "", ctx.query.get("pool") ?? "", ctx.query.get("token") ?? "");
      const { data, ...meta } = result;
      sendJson(ctx.res, 200, { ...meta, trades: data, coverage: "recent_pool_sample", completeHistory: false });
    } catch (err) { fail(ctx, err); }
  });
  router.publicRoute("GET", "/api/market/catalog", (ctx) => {
    try {
      const q: CatalogQuery = {};
      for (const field of ["chain", "q", "cursor"] as const) if (ctx.query.has(field)) q[field] = ctx.query.get(field)!;
      if (ctx.query.has("sort")) q.sort = ctx.query.get("sort") as CatalogQuery["sort"];
      for (const field of ["limit", "minLiquidity", "maxLiquidity", "minPrice", "maxPrice", "minMarketCap", "maxMarketCap", "minVolume", "maxVolume", "maxAgeHours"] as const) {
        if (ctx.query.has(field)) q[field] = ctx.query.get(field)!.trim() === "" ? NaN : Number(ctx.query.get(field));
      }
      sendJson(ctx.res, 200, catalog.list(q));
    } catch (err) { fail(ctx, err); }
  });
  router.publicRoute("GET", "/api/market/catalog/stats", (ctx) => sendJson(ctx.res, 200, catalog.stats()));
  router.publicRoute("POST", "/api/market/import", async (ctx) => {
    try {
      if (typeof ctx.body.chain !== "string" || typeof ctx.body.address !== "string") throw new Error("invalid chain or contract address");
      const result = await indexer.importToken(ctx.body.chain, ctx.body.address);
      const { data, ...meta } = result;
      sendJson(ctx.res, result.imported ? 200 : result.status === "DEGRADED" ? 503 : 404,
        { ...meta, pairs: data, ...(!result.imported ? { error: "No observed market pool for this contract; trading unavailable" } : {}) });
    } catch (err) { fail(ctx, err); }
  });
}
