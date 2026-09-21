import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { MarketCatalog } from "../src/market/catalog.js";

let db: Database.Database;
afterEach(() => db?.close());
const address = (i: number) => "0x" + i.toString(16).padStart(40, "0");
const pair = (i: number, chain = "base") => ({ chainId: chain, pairAddress: address(i + 10000),
  baseToken: { address: address(i), symbol: "TOKEN" + i, name: "Token " + i, decimals: 18 },
  quoteToken: { address: address(9999), decimals: 6 }, priceUsd: "1.5", liquidity: { usd: i },
  volume: { h24: i * 2 }, source: "dexscreener" });
const snapshot = (data: any[], asOf = 1700000000000) => ({ data, asOf, source: "dexscreener" as const, status: "LIVE" as const, cacheAgeMs: 0 });
function setup() { db = new Database(":memory:"); return new MarketCatalog(db, () => 1700000000000); }

describe("persistent market catalog", () => {
  it("keeps historical disabled-chain rows but excludes them from discovery", () => {
    const catalog = setup();
    catalog.ingest(snapshot([pair(1), pair(2)]));
    db.prepare("UPDATE market_assets SET chain='polygon' WHERE address=?").run(address(1));
    expect(catalog.list({}).pairs).toHaveLength(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM market_assets").get() as any).n).toBe(2);
    for (const chain of ["polygon", "arbitrum", "monad"]) expect(() => catalog.list({ chain })).toThrow(/invalid market chain/);
  });
  it("paginates 251 distinct assets beyond 100 without duplicates and excludes later inserts", () => {
    const catalog = setup();
    catalog.ingest(snapshot(Array.from({ length: 251 }, (_, i) => pair(i + 1))));
    const first = catalog.list({ limit: 37 });
    catalog.ingest(snapshot([pair(999)]));
    const ids = first.pairs.map((p: any) => p.baseToken.address);
    let cursor = first.nextCursor;
    while (cursor) {
      const page = catalog.list({ limit: 37, cursor });
      ids.push(...page.pairs.map((p: any) => p.baseToken.address)); cursor = page.nextCursor;
    }
    expect(ids).toHaveLength(251); expect(new Set(ids).size).toBe(251);
    expect(catalog.stats().assets).toBe(252);
  });
  it("deduplicates by chain and contract and preserves pools across service restarts", () => {
    const catalog = setup();
    catalog.ingest(snapshot([pair(1), pair(1), pair(1, "ethereum")]));
    const restarted = new MarketCatalog(db, () => 1700000000000);
    expect(restarted.stats()).toMatchObject({ assets: 2, pools: 2 });
    expect(restarted.list({ chain: "base" }).pairs).toHaveLength(1);
  });
  it("does not replace newer data with an older provider snapshot", () => {
    const catalog = setup();
    catalog.ingest(snapshot([pair(1)], 1700000000000));
    catalog.ingest(snapshot([{ ...pair(1), priceUsd: "999" }], 1699999900000));
    expect(catalog.list({}).pairs[0].priceUsd).toBe("1.5");
  });
  it("filters on the server and does not turn unknown liquidity into zero", () => {
    const catalog = setup();
    catalog.ingest(snapshot([pair(1), pair(200), { ...pair(3), liquidity: {} }]));
    expect(catalog.list({ minLiquidity: 100 }).pairs).toHaveLength(1);
    expect(catalog.list({ minLiquidity: 0 }).pairs).toHaveLength(2);
    expect(catalog.list({ q: "Token 200" }).pairs[0].baseToken.address).toBe(address(200));
    expect(catalog.list({ q: address(1).toUpperCase().replace("0X", "0x") }).pairs).toHaveLength(1);
  });
  it("rejects invalid query bounds and reusing a cursor with different filters", () => {
    const catalog = setup(); catalog.ingest(snapshot([pair(1), pair(2)]));
    const cursor = catalog.list({ limit: 1 }).nextCursor!;
    expect(() => catalog.list({ cursor, chain: "ethereum" })).toThrow(/cursor/);
    expect(() => catalog.list({ limit: -1 })).toThrow(/limit/);
    expect(() => catalog.list({ minLiquidity: NaN })).toThrow(/filter/);
    expect(() => catalog.list({ cursor: "garbage" })).toThrow(/cursor/);
  });
  it.each(["liquidity", "volume", "marketCap", "marketCapAsc", "newest"])("paginates tied %s values deterministically", (sort) => {
    const catalog = setup();
    catalog.ingest(snapshot(Array.from({ length: 121 }, (_, i) => ({ ...pair(i + 1),
      marketCap: Math.floor(i / 4), pairCreatedAt: 1700000000000 - Math.floor(i / 4) * 1000 }))));
    const ids: string[] = []; let cursor: string | null = null;
    do {
      const page = catalog.list({ sort, limit: 17, cursor: cursor ?? undefined });
      ids.push(...page.pairs.map((p: any) => p.baseToken.address)); cursor = page.nextCursor;
    } while (cursor);
    expect(ids).toHaveLength(121); expect(new Set(ids).size).toBe(121);
    const expected = catalog.list({ sort, limit: 100 }).pairs.map((p: any) => p.baseToken.address);
    expect(ids.slice(0, 100)).toEqual(expected);
  });
  it("retains source timestamps and marks old data unavailable, never tradable", () => {
    const catalog = setup(); catalog.ingest(snapshot([pair(1)], 1699990000000));
    const p = catalog.list({}).pairs[0];
    expect(p.marketAsOf).toBe(1699990000000);
    expect(p.marketStatus).toBe("UNAVAILABLE");
    expect(p.tradable).toBe(false);
  });
});
