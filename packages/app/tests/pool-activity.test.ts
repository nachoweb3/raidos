import { readFileSync } from "node:fs";
import { SourceTextModule, SyntheticModule } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { MarketDataService } from "../src/market/data.js";
import { ApiServer } from "../src/api/server.js";

const token = "0x" + "a".repeat(40), other = "0x" + "b".repeat(40), pool = "0x" + "c".repeat(40);
const trade = { id: "swap-1", attributes: { from_token_address: other, to_token_address: token,
  tx_from_address: "0x" + "d".repeat(40), tx_hash: "0x" + "e".repeat(64),
  block_timestamp: "2026-09-20T12:00:00Z", price_to_in_usd: "2", price_from_in_usd: "1",
  from_token_amount: "10", to_token_amount: "5", volume_in_usd: "10", kind: "sell" } };
describe("observed pool activity", () => {
  it("orients swaps to the selected contract, deduplicates events and excludes unrelated tokens", async () => {
    const service = new MarketDataService({ fetcher: async () => new Response(JSON.stringify({ data: [trade, trade,
      { ...trade, id: "unrelated", attributes: { ...trade.attributes, to_token_address: other } },
      { ...trade, id: "bad-price", attributes: { ...trade.attributes, price_to_in_usd: null } },
    ] })) });
    const buys = await service.trades("base", pool, token);
    expect(buys.data).toHaveLength(1);
    expect(buys.data[0]).toMatchObject({ side: "buy", priceUsd: 2, amount: "5" });
    expect((await service.trades("base", pool, other)).data[0]).toMatchObject({ side: "sell", priceUsd: 1, amount: "10" });
  });
  it("bounds cache freshness and preserves provenance on upstream failure", async () => {
    let now = 100000, offline = false;
    const fetcher = vi.fn(async () => { if (offline) throw Error("offline"); return new Response(JSON.stringify({ data: [trade] })); });
    const service = new MarketDataService({ now: () => now, fetcher });
    await service.trades("base", pool, token); await service.trades("base", pool, token);
    expect(fetcher).toHaveBeenCalledTimes(1);
    offline = true; now += 31000;
    expect(await service.trades("base", pool, token)).toMatchObject({ status: "DEGRADED", asOf: 100000 });
    now += 300000;
    await expect(service.trades("base", pool, token)).rejects.toThrow("unavailable");
  });
  it("rejects unsafe query paths and disabled chains before fetching", async () => {
    const fetcher = vi.fn(); const service = new MarketDataService({ fetcher });
    await expect(service.trades("base", "../../secrets", token)).rejects.toThrow("invalid");
    await expect(service.trades("polygon", pool, token)).rejects.toThrow("disabled");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("groups only observed events inside loaded candles and supports wallet isolation", async () => {
    const module = new SourceTextModule(readFileSync(new URL("../../../site/js/pool-activity.js", import.meta.url), "utf8"));
    await module.link(() => new SyntheticModule(["ApiClient", "publicPoolData"], function () { this.setExport("ApiClient", {}); this.setExport("publicPoolData", () => {}); }));
    await module.evaluate();
    const markers = (module.namespace as any).activityMarkers;
    const trades = [{ time: 301, wallet: "A", side: "buy" }, { time: 302, wallet: "B", side: "buy" },
      { time: 303, wallet: "A", side: "sell" }, { time: 50, wallet: "A", side: "buy" }];
    expect(markers(trades, [{ time: 300 }], 300).map((m: any) => m.position)).toEqual(["belowBar", "aboveBar"]);
    expect(markers(trades, [{ time: 300 }], 300, "B")).toHaveLength(1);
    expect(markers(trades, [], 300)).toEqual([]);
  });
  it("serves an explicit partial sample and gates unsafe launch pool signing", async () => {
    const app = new ApiServer({ dbPath: ":memory:", port: 0, siteDir: null, appMode: "mock",
      marketData: new MarketDataService({ fetcher: async () => new Response(JSON.stringify({ data: [trade] })) }) });
    try {
      const base = "http://127.0.0.1:" + await app.start();
      const result = await (await fetch(base + `/api/market/trades?chain=base&pool=${pool}&token=${token}`)).json();
      expect(result.completeHistory).toBe(false); expect(result.trades).toHaveLength(1);
      const { apiKey } = await (await fetch(base + "/api/auth/register", { method: "POST", body: "{}" })).json();
      for (const endpoint of ["prepare", "submit"]) {
        const response = await fetch(base + "/api/launches/1/pool/swap/" + endpoint, { method: "POST", headers: { Authorization: "Bearer " + apiKey }, body: "{}" });
        expect(response.status).toBe(503);
        expect((await response.json()).error).toContain("POOL_EXECUTION_ENABLED");
      }
    } finally { await app.stop(); }
  });
});
