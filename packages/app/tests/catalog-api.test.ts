import { afterEach, describe, expect, it } from "vitest";
import { ApiServer } from "../src/api/server.js";
import { MarketDataService } from "../src/market/data.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let app: ApiServer | undefined;
let dir: string | undefined;
afterEach(async () => {
  await app?.stop(); app = undefined;
  if (dir) { rmSync(dir, { recursive: true, force: true }); dir = undefined; }
});
const token = "0x" + "a".repeat(40);
const pair = { chainId: "base", pairAddress: "0x" + "b".repeat(40), baseToken: { address: token, symbol: "CAT", name: "Catalog" }, liquidity: { usd: 1234 } };
async function setup(dbPath = ":memory:") {
  let calls = 0;
  app = new ApiServer({ dbPath, port: 0, siteDir: null, appMode: "live", marketData: new MarketDataService({
    fetcher: async (url) => { calls++; return new Response(JSON.stringify(url.includes("/search") ? { pairs: [pair] } : [pair])); },
  }) });
  return { base: "http://127.0.0.1:" + await app.start(), calls: () => calls };
}
describe("market catalog HTTP integration", () => {
  it("persists searched assets automatically and exposes bounded server filters", async () => {
    const { base } = await setup();
    expect((await fetch(base + "/api/market/search?q=CAT&chain=base")).status).toBe(200);
    const page = await (await fetch(base + "/api/market/catalog?chain=base&minLiquidity=1000")).json();
    expect(page.pairs).toHaveLength(1); expect(page.pairs[0].baseToken.address).toBe(token);
    expect(page.pairs[0].tradable).toBe(false);
    expect((await fetch(base + "/api/market/catalog?limit=NaN")).status).toBe(400);
  });
  it("imports a contract, rejects malformed addresses before I/O, and survives an actual database reopen", async () => {
    dir = mkdtempSync(join(tmpdir(), "trenches-catalog-"));
    const path = join(dir, "test.db");
    let { base, calls } = await setup(path);
    const imported = await fetch(base + "/api/market/import", { method: "POST", body: JSON.stringify({ chain: "base", address: token }) });
    expect(imported.status).toBe(200); expect((await imported.json()).imported).toBe(true);
    const before = calls();
    expect((await fetch(base + "/api/market/import", { method: "POST", body: JSON.stringify({ chain: "base", address: "CAT" }) })).status).toBe(400);
    expect(calls()).toBe(before);
    await app!.stop(); app = undefined;
    ({ base } = await setup(path));
    expect((await (await fetch(base + "/api/market/catalog/stats")).json()).assets).toBe(1);
  });
});
