import { Router, sendJson, type RequestContext } from "../api/router.js";
import { MarketCatalog, type CatalogQuery } from "./catalog.js";
import { MarketIndexer } from "./indexer.js";
import { MarketDataService } from "./data.js";

export function registerMarketCatalogRoutes(router: Router, catalog: MarketCatalog, market: MarketDataService) {
  const indexer = new MarketIndexer(catalog, market);
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
