import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarketCatalog } from "../src/market/catalog.js";
import { MarketIndexer } from "../src/market/indexer.js";
import { MarketDataService } from "../src/market/data.js";
let db: Database.Database;
afterEach(() => { db?.close(); vi.restoreAllMocks(); });
const address = "0x" + "a".repeat(40);
function setup() {
  let now = 1700000000000;
  db = new Database(":memory:");
  const catalog = new MarketCatalog(db, () => now), market = new MarketDataService();
  return { catalog, market, indexer: new MarketIndexer(catalog, market), advance: (ms: number) => { now += ms; } };
}
describe("durable indexer", () => {
  it("checkpoints successful pages, retries failures with backoff, and resumes after restart", async () => {
    const { catalog, market, indexer, advance } = setup();
    catalog.enqueue("one", "discover", { chain: "base", kind: "new", page: 1 });
    const pools = vi.spyOn(market, "pools").mockRejectedValue(new Error("private provider URL"));
    expect((await indexer.runOnce()).status).toBe("retry");
    expect((await indexer.runOnce()).status).toBe("idle");
    advance(15000);
    pools.mockResolvedValue({ data: [{ chainId: "base", pairAddress: "0x" + "b".repeat(40), baseToken: { address }, liquidity: { usd: 100 } }],
      source: "geckoterminal", asOf: 1700000015000, status: "LIVE", cacheAgeMs: 0 });
    expect((await new MarketIndexer(catalog, market).runOnce()).status).toBe("updated");
    advance(15000);
    await indexer.runOnce();
    expect(pools).toHaveBeenLastCalledWith("base", "new", 2);
    expect(catalog.stats().assets).toBe(1);
  });
  it("only one worker owns a job, expired owners cannot commit", () => {
    const { catalog, advance } = setup();
    catalog.enqueue("one", "refresh", { chain: "base", address });
    const first = catalog.claim(1000)!;
    expect(catalog.claim()).toBeUndefined();
    advance(1001);
    const second = catalog.claim()!;
    const write = vi.fn();
    expect(catalog.complete(first, write, {}, 1000)).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(catalog.complete(second, write, {}, 1000)).toBe(true);
  });
  it("imports only the exact chain and contract and never authorizes trading", async () => {
    const { catalog, market, indexer } = setup();
    vi.spyOn(market, "tokens").mockResolvedValue({ data: [
      { chainId: "base", pairAddress: address, baseToken: { address }, liquidity: { usd: 100 } },
      { chainId: "ethereum", pairAddress: address, baseToken: { address } },
    ], source: "dexscreener", asOf: 1700000000000, status: "LIVE", cacheAgeMs: 0 });
    const result = await indexer.importToken("base", address);
    expect(result.imported).toBe(true); expect(result.tradable).toBe(false);
    expect(catalog.stats().assets).toBe(1);
    await expect(indexer.importToken("base", "BTC")).rejects.toThrow(/address/);
  });
  it("does not advance discovery on a degraded cached response", async () => {
    const { catalog, market, indexer } = setup();
    catalog.enqueue("one", "discover", { chain: "base", kind: "new", page: 1 });
    vi.spyOn(market, "pools").mockResolvedValue({ data: [], source: "geckoterminal", asOf: 1700000000000, status: "DEGRADED", cacheAgeMs: 1000 });
    expect((await indexer.runOnce()).status).toBe("retry");
  });
});
