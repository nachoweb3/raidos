import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SourceTextModule, SyntheticModule, createContext } from "node:vm";
import { fileURLToPath } from "node:url";

async function loadTrading(api: any = {}, globals: Record<string, unknown> = {}) {
  const alerts: string[] = [];
  let signatureRequests = 0;
  const context = createContext({
    ...globals,
    alert: (message: string) => alerts.push(message),
    document: { getElementById: () => null },
    window: { solana: { signAndSendTransaction: () => { signatureRequests++; } } },
  });
  const module = new SourceTextModule(readFileSync(fileURLToPath(new URL("../../../site/js/trading.js", import.meta.url)), "utf8"), { context });
  const exports: Record<string, Record<string, unknown>> = {
    "./api.js": { ApiClient: api },
    "./discover.js": { PriceFeed: {} },
    "./tokens.js": { TokenMeta: {} },
    "./dexfeed.js": { DexFeed: { get: () => null } },
  };
  await module.link(async (specifier) => {
    const values = exports[specifier];
    return new SyntheticModule(Object.keys(values), function () {
      for (const [name, value] of Object.entries(values)) this.setExport(name, value);
    }, { context });
  });
  await module.evaluate();
  return { engine: (module.namespace as any).TradingEngine, alerts, signatureRequests: () => signatureRequests };
}
describe("trading UI truthfulness", () => {
  it("does not expose a made-up spendable balance", async () => {
    const { engine } = await loadTrading();
    expect(engine.availableBalance()).toBeNull();
  });
  it("never removes a backend position when Close has not settled", async () => {
    const { engine } = await loadTrading();
    engine.positions = [{ id: "api_pos_1", symbol: "TOKEN" }];
    await engine.closePosition("api_pos_1");
    expect(engine.positions).toHaveLength(1);
  });
  it("checks server capability before asking the wallet to sign", async () => {
    let prepares = 0;
    const { engine, signatureRequests } = await loadTrading({
      request: async () => ({ mode: "live", chains: [{ id: "solana", liveExecution: false, status: "UNAVAILABLE" }] }),
      prepareSelfCustodyTrade: async () => { prepares++; throw new Error("must not prepare"); },
    });
    await expect(engine.submitSelfCustodyTrade({ fromChain: "solana" }, "wallet")).rejects.toThrow(/disponible|UNAVAILABLE/i);
    expect(prepares).toBe(0);
    expect(signatureRequests()).toBe(0);
  });
});

describe("market chart data", () => {
  it("leaves the chart empty when no real price history is available", async () => {
    const { engine } = await loadTrading({}, { fetch: async () => { throw new Error("offline"); }, AbortSignal });
    const calls: any[] = [];
    engine.currentPrice = 100;
    engine.candleSeries = { setData: (rows: any[]) => calls.push(rows) };
    await engine.generateCandleData();
    expect(calls.at(-1)).toEqual([]);
  });
  it("renders actual OHLC fields instead of fabricating candles from prices", async () => {
    let requested = "";
    const { engine } = await loadTrading({
      request: async (url: string) => {
        requested = url;
        return { candles: [{ time: 1700000000, open: 10, high: 14, low: 9, close: 12 }],
          source: "coingecko", asOf: 1700000000000, status: "LIVE" };
      },
    });
    const calls: any[] = [];
    engine.candleSeries = { setData: (rows: any[]) => calls.push(rows) };
    await engine.fetchRealCandles();
    expect(requested).toContain("/api/market/reference-candles?coin=solana");
    expect(calls.at(-1)).toEqual([{ time: 1700000000, open: 10, high: 14, low: 9, close: 12 }]);
  });
});
