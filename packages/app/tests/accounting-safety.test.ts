import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiServer } from "../src/api/server.js";
import { TradingEngine } from "../src/trading/engine.js";
import { getChain } from "../src/chains/config.js";
import { ExecutionReconciler, RpcReceiptProvider, type ReceiptFill } from "../src/trading/reconciler.js";

const TOKEN = "TokenForAccounting111111111111111111111111111";
let server: ApiServer | undefined;
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await server?.stop(); server = undefined; });

function setup(mode: "mock" | "live" = "live") {
  server = new ApiServer({ dbPath: ":memory:", siteDir: null, port: 0, appMode: mode });
  return server;
}
function transaction(app: ApiServer, fill: ReceiptFill, chain = "solana", status = "confirmed") {
  const params = { fromChain: chain, toChain: chain, sellToken: fill.sellToken, buyToken: fill.buyToken, amount: fill.sellAmount, type: "swap" };
  const tradeId = app.db.addTrade({
    user_id: 1, type: "swap", from_chain: chain, to_chain: chain,
    sell_token: fill.sellToken, buy_token: fill.buyToken, sell_amount: fill.sellAmount,
    buy_amount: "999999999", sell_price_usdc: "0", buy_price_usdc: "0", fee_usdc: "0",
    tx_hash: "fixture", launch_id: null, copied_user_id: null, realized_pnl_usdc: null,
    status: "confirmed", ts: Math.floor(Date.now() / 1000),
  });
  const intentId = app.db.createExecutionIntent({
    userId: 1, endpoint: "test", idempotencyKey: String(tradeId), requestHash: "fixture",
    requestJson: JSON.stringify({ params, walletAddress: "fixture-wallet" }), mode: app.appMode,
  });
  const transactionId = app.db.createExecutionTransaction({ intentId, tradeId, userId: 1, chain, txHash: "fixture-" + tradeId, status });
  app.db.updateExecutionIntent(intentId, { status });
  return app.db.getPendingExecutionTransactions(undefined, true).find((t: any) => t.id === transactionId);
}
function settle(app: ApiServer, fill: ReceiptFill, chain = "solana") {
  const tx = transaction(app, fill, chain);
  (app as any).settleReceiptBackedTransaction(tx, fill);
  return tx;
}
async function httpApp(mode: "mock" | "live" = "live") {
  const app = setup(mode);
  const base = "http://127.0.0.1:" + await app.start();
  const registered = await fetch(base + "/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const { apiKey } = await registered.json();
  return {
    app,
    call: (path: string, body?: unknown) => fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey, "Idempotency-Key": "safety-test-0001" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  };
}
const usdc = getChain("solana")!.usdcAddress;
const buy: ReceiptFill = { sellToken: usdc, buyToken: TOKEN, sellAmount: "1000000", buyAmount: "100", feeAmount: "1000", feeToken: "sell" };

describe("settled accounting", () => {
  it("accepts integer receipt fills and projects exactly once", () => {
    const app = setup();
    const tx = settle(app, buy);
    (app as any).settleReceiptBackedTransaction(tx, buy);
    expect(app.db.getUserPositions(1, "open")[0].amount_remaining).toBe("100");
    expect(app.db.getExecutionTransaction(tx.intent_id).status).toBe("settled");
    expect(app.db.getTrade(tx.trade_id).buy_amount).toBe("100");
    expect(app.db.getFeed({ actorId: 1 }).filter((e: any) => e.type === "swap")).toHaveLength(1);
  });
  it("sums only each partial sale's realized PnL and the USDC leg as volume", () => {
    const app = setup();
    settle(app, buy);
    const partial = settle(app, { sellToken: TOKEN, buyToken: usdc, sellAmount: "40", buyAmount: "800000", feeAmount: "1000", feeToken: "buy" });
    const close = settle(app, { sellToken: TOKEN, buyToken: usdc, sellAmount: "60", buyAmount: "1500000", feeAmount: "1000", feeToken: "buy" });
    expect(app.db.getTrade(partial.trade_id).realized_pnl_usdc).toBe("398600");
    expect(app.db.getTrade(close.trade_id).realized_pnl_usdc).toBe("898400");
    const pnl = app.db.getUserPnl(1);
    expect(pnl.totalPnlUsdc).toBe("1297000");
    expect(pnl.volumeUsdc).toBe("3300000");
    expect(pnl.winRate).toBe(100);
    expect(pnl.pnlByChain).toEqual({ solana: "1297000" });
    expect(pnl.pnlByToken).not.toHaveProperty(usdc);
    expect(app.db.getPnlSince(0)[0].pnl_usdc).toBe("1297000");
  });
  it("does not repeat previous realized PnL on a later buy", () => {
    const app = setup();
    settle(app, buy);
    settle(app, { sellToken: TOKEN, buyToken: usdc, sellAmount: "40", buyAmount: "800000", feeAmount: "1000", feeToken: "buy" });
    const additional = settle(app, buy);
    expect(app.db.getTrade(additional.trade_id).realized_pnl_usdc).toBeNull();
    expect(app.db.getUserPnl(1).totalPnlUsdc).toBe("398600");
  });
  it("excludes confirmed but unfilled and legacy rows from PnL and rankings", () => {
    const app = setup();
    const tx = transaction(app, buy);
    app.db.updateTradeStatus(tx.trade_id, "confirmed", "900000000");
    expect(app.db.getUserPnl(1).totalTrades).toBe(0);
    expect(app.db.getChainPnl(1, "solana").totalPnlUsdc).toBe("0");
    expect(app.db.getPnlSince(0)).toEqual([]);
  });
  it("keeps identical token addresses on different chains separate", () => {
    const app = setup();
    settle(app, buy);
    settle(app, { ...buy, sellToken: getChain("base")!.usdcAddress, buyAmount: "20" }, "base");
    const tokens = app.db.getUserPnl(1).pnlByToken;
    expect(tokens["solana:" + TOKEN].balance).toBe("100");
    expect(tokens["base:" + TOKEN.toLowerCase()].balance).toBe("20");
  });
});

describe("live capability policy and financial input", () => {
  it("keeps chains without a verified adapter unavailable and rejects unknown wallets", async () => {
    const { call } = await httpApp();
    const prepare = vi.spyOn(TradingEngine.prototype, "prepareSelfCustodyTransaction").mockRejectedValue(new Error("must not call provider"));
    const chains = await (await call("/api/chains")).json();
    // bsc/robinhood/arc have no self-custody adapter; solana lacks a Jupiter
    // key in this fixture, so only keyed EVM chains (base) advertise LIVE.
    for (const id of ["bsc", "robinhood", "arc", "solana"]) {
      const chain = chains.chains.find((c: any) => c.id === id);
      expect(chain.liveExecution).toBe(false);
      expect(chain.status).toBe("UNAVAILABLE");
    }
    // An unlinked wallet is refused before any provider call.
    const response = await call("/api/trades/prepare", { fromChain: "solana", sellToken: usdc, buyToken: TOKEN, amount: "100", walletAddress: "11111111111111111111111111111111" });
    expect(response.status).toBe(403);
    expect(prepare).not.toHaveBeenCalled();
  });
  it("blocks unverified hash submission without changing accounting", async () => {
    const { app, call } = await httpApp();
    const response = await call("/api/trades/submit", { sessionId: "d4c9a2f1-0000-4000-8000-000000000000", txHash: "arbitrary-unverified-hash" });
    expect(response.status).toBe(404);
    expect(app.db.getUserTrades(1)).toEqual([]);
  });
  it("does not return simulated holders when live data is unavailable", async () => {
    const { call } = await httpApp();
    const response = await call("/api/tokens/solana/" + TOKEN + "/holders");
    expect(response.status).toBe(503);
    expect((await response.json()).source).not.toBe("mock");
  });
  it("does not turn a failed live quote into a mock", async () => {
    const { call } = await httpApp();
    vi.spyOn(TradingEngine.prototype, "getQuote").mockRejectedValue(new Error("offline"));
    const response = await call("/api/trades/quote", { fromChain: "solana", sellToken: usdc, buyToken: TOKEN, amount: "100" });
    expect(response.status).toBe(503);
    expect((await response.json()).quote).toBeUndefined();
  });
  it.each([
    { amount: "0" }, { amount: "0".repeat(100) }, { slippageBps: "50" },
    { slippageBps: null }, { buyToken: usdc }, { sellToken: TOKEN, buyToken: "OTHER" },
  ])("rejects invalid financial inputs: %j", async (overrides) => {
    const { call } = await httpApp("mock");
    const response = await call("/api/trades/quote", { fromChain: "solana", sellToken: usdc, buyToken: TOKEN, amount: "100", ...overrides });
    expect(response.status).toBe(400);
  });
});

describe("receipt recovery", () => {
  it("isolates transient RPC failures so another transaction can progress", async () => {
    const app = setup();
    const first = transaction(app, buy, "solana", "pending");
    const second = transaction(app, buy, "solana", "pending");
    const reconciler = new ExecutionReconciler(app.db, {
      getReceipt: async (_chain, hash) => {
        if (hash === first.tx_hash) throw new Error("RPC timeout");
        return { status: "confirmed", receipt: { block: 2 } };
      },
    });
    await expect(reconciler.reconcilePending()).resolves.toMatchObject({ pending: 1, confirmed: 1, failed: 0 });
    expect(app.db.getExecutionTransaction(first.intent_id).status).toBe("pending");
    expect(app.db.getExecutionTransaction(second.intent_id).status).toBe("confirmed");
  });
  it("does not downgrade a confirmed transaction when a later lookup is pending", async () => {
    const app = setup();
    const tx = transaction(app, buy);
    const reconciler = new ExecutionReconciler(app.db, { getReceipt: async () => ({ status: "pending" }) }, () => {});
    await expect(reconciler.reconcilePending()).resolves.toMatchObject({ pending: 1, failed: 0 });
    expect(app.db.getExecutionTransaction(tx.intent_id).status).toBe("confirmed");
  });
  it.each([
    { error: { code: -32005, message: "rate limited" } },
    { result: { transactionHash: "0x1" } },
  ])("does not mark a trade failed for an RPC error or malformed receipt: %j", async (body) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
    const result = await new RpcReceiptProvider({ base: "https://rpc.invalid" }).getReceipt("base", "0x1");
    expect(result.status).toBe("pending");
  });
  it("does not send simulated transaction hashes to RPC", async () => {
    const app = setup("mock");
    transaction(app, buy, "solana", "pending");
    const getReceipt = vi.fn(async () => ({ status: "pending" as const }));
    await new ExecutionReconciler(app.db, { getReceipt }).reconcilePending();
    expect(getReceipt).not.toHaveBeenCalled();
  });
});

describe("settlement follow-through", () => {
  it("does not collect a fee or grant rewards when an oversell fails", async () => {
    const { app, call } = await httpApp("mock");
    const wallet = await call("/api/wallets", { chain: "solana", password: "regression-password" });
    expect(wallet.status).toBe(201);
    const before = app.db.getTotalRevenue(0);
    const response = await call("/api/trades/execute", {
      fromChain: "solana", sellToken: TOKEN, buyToken: usdc, amount: "1000000", password: "regression-password",
    });
    expect(response.status).toBe(409);
    expect(app.db.getTotalRevenue(0)).toBe(before);
  });
  it("removes traders from a period snapshot after the window expires", () => {
    const app = setup();
    app.db.saveLeaderboardSnapshot("24h", [{ user_id: 1, pnl_usdc: "10", trades: 1, win_rate: 1 }]);
    app.db.saveLeaderboardSnapshot("24h", []);
    expect(app.db.getLeaderboardByPeriod("24h")).toEqual([]);
  });
  it("ranks exact settled PnL and honors the chain filter", () => {
    const app = setup();
    settle(app, buy);
    settle(app, { sellToken: TOKEN, buyToken: usdc, sellAmount: "100", buyAmount: "10000000", feeAmount: "0", feeToken: "buy" });
    expect(app.db.getTopTraders("solana")[0].total_pnl_usdc).toBe("8999000");
    expect(app.db.getTopTraders("base")).toEqual([]);
  });
  it.each(["/api/launches/1/buy", "/api/launches/1/sell", "/api/rewards/claim"])("blocks simulated financial mutations in live mode: %s", async (path) => {
    const { call } = await httpApp();
    const response = await call(path, { usdcAmount: "100", tokenAmount: "100" });
    expect(response.status).toBe(503);
  });
});

describe("position provenance", () => {
  it("does not expose old or simulated position projections as live", () => {
    const app = setup();
    const otherMode = new ApiServer({ dbPath: ":memory:", appMode: "mock", siteDir: null });
    try {
      // A position without a settled receipt must never enter live API output.
      const row = {
        user_id: 1, chain: "solana", token: TOKEN, token_symbol: "TEST", status: "open",
        amount_remaining: "100", total_bought: "100", total_sold: "0", avg_entry_usdc: "10000",
        net_invested_usdc: "1000000", realized_pnl_usdc: null, opened_at: 1, closed_at: null,
      };
      (app.db as any).db.prepare(
        "INSERT INTO positions (user_id,chain,token,token_symbol,status,amount_remaining,total_bought,total_sold,avg_entry_usdc,net_invested_usdc,opened_at) VALUES (1,'solana',?,'TEST','open','100','100','0','10000','1000000',1)"
      ).run(TOKEN);
      expect(app.db.getUserPositions(1, "open")).toEqual([]);
      expect(app.db.getOpenPosition(1, "solana", TOKEN)).toBeUndefined();
      otherMode.db.upsertPosition(row);
      expect(otherMode.db.getUserPositions(1, "open")).toHaveLength(1);
    } finally { void otherMode.stop(); }
  });
});
