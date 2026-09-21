import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SourceTextModule, SyntheticModule, createContext } from "node:vm";
import { fileURLToPath } from "node:url";

async function loadTrading(api: any = {}, globals: Record<string, unknown> = {}, dex: any = { get: () => null }) {
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
    "./dexfeed.js": { DexFeed: dex },
    "./chart-tools.js": { ChartTools: class {} },
    "./pool-activity.js": { PoolActivity: class {} },
    "./public-market.js": { publicPoolData: async () => { throw Error("offline"); } },
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
  it("never paints an old token response over the newly selected token", async () => {
    let finishOld!: (value: unknown) => void;
    const pending = new Promise((resolve) => { finishOld = resolve; });
    const payload = (price: number) => ({ candles: [{ time: 1, open: price, high: price, low: price, close: price, volume: 25 }], asOf: 1, source: "test", status: "LIVE" });
    const { engine } = await loadTrading({ request: async (path: string) => path.includes("token=first") ? pending : payload(2) }, {}, { get: () => ({ pairAddress: "pool" }) });
    const calls: any[] = [];
    engine.candleSeries = { setData() {} };
    engine.chartTools = { setData: (rows: any[]) => calls.push(rows) };
    engine.currentChain = "base"; engine.currentTokenAddress = "first";
    const oldRequest = engine.fetchRealCandles();
    engine.currentTokenAddress = "second";
    await engine.fetchRealCandles();
    finishOld(payload(1)); await oldRequest;
    expect(calls.at(-1)[0]).toMatchObject({ close: 2, volume: 25 });
    expect(calls.some((rows) => rows[0]?.close === 1)).toBe(false);
  });
  it("clears every indicator when its current market request fails", async () => {
    const { engine } = await loadTrading({ request: async () => { throw new Error("offline"); } });
    const calls: any[] = [];
    engine.candleSeries = { setData() {} };
    engine.chartTools = { setData: (rows: any[]) => calls.push(rows) };
    await engine.fetchRealCandles();
    expect(calls.at(-1)).toEqual([]);
  });
  it("uses reference OHLC for the known asset when its pool history fails", async () => {
    const paths: string[] = [];
    const { engine } = await loadTrading({ request: async (path: string) => {
      paths.push(path);
      if (path.includes("/candles?")) throw new Error("pool not indexed");
      return { candles: [{ time: 1, open: 1, high: 2, low: 1, close: 2 }], source: "coingecko", asOf: 1, status: "LIVE" };
    } }, {}, { get: () => ({ pairAddress: "pool" }) });
    const calls: any[] = [];
    engine.candleSeries = { setData: (rows: any[]) => calls.push(rows) };
    await engine.fetchRealCandles();
    expect(paths).toHaveLength(2);
    expect(paths[1]).toContain("reference-candles?coin=solana");
    expect(calls.at(-1)).toHaveLength(1);
  });
  it("never uses reference candles for an unrelated contract named SOL", async () => {
    const paths: string[] = [];
    const { engine } = await loadTrading({ request: async (path: string) => { paths.push(path); throw new Error("no history"); } },
      {}, { get: () => ({ pairAddress: "pool" }) });
    engine.currentTokenAddress = "UnrelatedMint";
    engine.candleSeries = { setData: () => {} };
    await engine.fetchRealCandles();
    expect(paths).toHaveLength(1);
    expect(paths[0]).not.toContain("reference-candles");
  });

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
