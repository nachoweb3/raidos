import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiServer } from "../src/api/server.js";
import { TradingEngine, erc20ApproveCalldata } from "../src/trading/engine.js";
import { parseEvmTransferFill } from "../src/trading/reconciler.js";
import { getChain } from "../src/chains/config.js";

let server: ApiServer | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await server?.stop();
  server = undefined;
});

const ARC = getChain("arc")!;
const ARC_USDC = ARC.usdcAddress;
const ARC_WETH = "0x93ffd195481e8c08eb25a158689e4d9e61313111";
const DIAMOND = "0xA4072583658Fae592A3506A42431cb6316a8d40b";
const WALLET = "0x" + "c1".repeat(20);

/** Real Li.Fi response shape captured live on 2026-09-24 (WETH/USDC pool). */
function lifiQuoteBody() {
  return {
    tool: "kyberswap",
    toolDetails: { name: "Kyberswap" },
    estimate: {
      tool: "kyberswap",
      approvalAddress: DIAMOND,
      fromAmount: "1000000",
      toAmount: "362857525429408",
      toAmountMin: "361042248802261",
      feeCosts: [],
      gasCosts: [],
    },
    transactionRequest: {
      to: DIAMOND,
      data: "0x5fd9ae2e",
      value: "0x0",
      gasLimit: "0x10d4c0",
      gasPrice: "0x4ae0da900",
      chainId: 5042,
    },
  };
}

/** Passthrough fetch stub: Li.Fi is mocked, localhost API traffic is real. */
function stubLiFi(body: unknown | ((url: URL) => unknown), status = 200): { urls: URL[] } {
  const realFetch = globalThis.fetch.bind(globalThis);
  const urls: URL[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: any, init?: any) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname === "li.quest") {
      urls.push(url);
      const payload = typeof body === "function" ? body(url) : body;
      return new Response(JSON.stringify(payload), { status });
    }
    return realFetch(input, init);
  }));
  return { urls };
}

async function liveApp() {
  server = new ApiServer({
    dbPath: ":memory:", port: 0, siteDir: null, appMode: "live",
    receiptProvider: { getReceipt: async () => { throw new Error("no network in tests"); } },
  });
  const base = "http://127.0.0.1:" + await server.start();
  const registered = await fetch(base + "/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const { apiKey, userId } = await registered.json();
  const call = (path: string, body?: unknown, idempotencyKey = "arc-lifi-test-0001") =>
    fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
        "Idempotency-Key": idempotencyKey,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { app: server, call, userId, base };
}

describe("arc execution capability", () => {
  it("advertises arc as LIVE self-custody with no aggregator API key at all", async () => {
    const { call } = await liveApp();
    const { chains } = await (await call("/api/chains")).json();
    expect(chains.find((c: any) => c.id === "arc")).toMatchObject({
      quotes: true, liveExecution: true, selfCustody: true, status: "LIVE", dexAggregator: "lifi",
    });
  });
  it("keeps arc read-only outside live mode", async () => {
    server = new ApiServer({ dbPath: ":memory:", port: 0, siteDir: null, appMode: "mock" });
    const base = "http://127.0.0.1:" + await server.start();
    const { chains } = await (await fetch(base + "/api/chains")).json();
    expect(chains.find((c: any) => c.id === "arc")).toMatchObject({ quotes: true, liveExecution: false, status: "UNAVAILABLE" });
  });
});

describe("Li.Fi arc quote + prepare", () => {
  const tradeParams = {
    userId: 1, fromChain: "arc", toChain: "arc",
    sellToken: ARC_USDC, buyToken: ARC_WETH, amount: "1000000",
    slippageBps: 50, type: "swap" as const,
  };

  it("routes arc quotes through Li.Fi with fraction slippage and carries toAmountMin", async () => {
    const { urls } = stubLiFi(lifiQuoteBody());
    const quote = await new TradingEngine().getQuote(tradeParams);
    expect(quote.aggregator).toBe("lifi");
    expect(quote.buyAmount).toBe("362857525429408");
    expect(quote.buyAmountMin).toBe("361042248802261");
    expect(quote.route).toBe("Kyberswap");
    expect(urls[0]!.searchParams.get("fromChain")).toBe("5042");
    expect(urls[0]!.searchParams.get("fromToken")).toBe(ARC_USDC.toLowerCase());
    expect(urls[0]!.searchParams.get("slippage")).toBe("0.005");
    // Li.Fi 400s without fromAddress even on price-only quotes (verified live).
    expect(urls[0]!.searchParams.get("fromAddress")).toMatch(/^0x[0-9a-f]{40}$/);
  });
  it("uses the real taker as fromAddress when provided", async () => {
    const { urls } = stubLiFi(lifiQuoteBody());
    await new TradingEngine().getQuote({ ...tradeParams, taker: WALLET });
    expect(urls[0]!.searchParams.get("fromAddress")).toBe(WALLET);
  });
  it("propagates integrator and fee params when configured", async () => {
    vi.stubEnv("LIFI_INTEGRATOR", "trenches");
    vi.stubEnv("LIFI_FEE_PCT", "0.3");
    const { urls } = stubLiFi(lifiQuoteBody());
    await new TradingEngine().getQuote(tradeParams);
    expect(urls[0]!.searchParams.get("integrator")).toBe("trenches");
    expect(urls[0]!.searchParams.get("fee")).toBe("0.3");
  });
  it("prepare returns the unsigned swap plus the exact approve for the Li.Fi Diamond", async () => {
    stubLiFi(lifiQuoteBody());
    const prepared = await new TradingEngine().prepareSelfCustodyTransaction(tradeParams, WALLET);
    expect(prepared.platformFeeBps).toBe(0); // fee travels inside the Li.Fi route
    expect(prepared.unsignedTransaction).toMatchObject({
      kind: "evm", to: DIAMOND, data: "0x5fd9ae2e", value: "0x0", chainId: 5042,
    });
    expect(prepared.unsignedTransaction.approveTx).toEqual({
      to: ARC_USDC,
      data: erc20ApproveCalldata(DIAMOND, 1_000_000n),
    });
  });
  it("maps provider failures to honest 503s, never a fake quote", async () => {
    const { call, userId } = await liveApp();
    stubLiFi({ message: "no route" }, 500);
    server!.db.createIdentity("evm", WALLET, userId);
    const response = await call("/api/trades/prepare", {
      fromChain: "arc", toChain: "arc", sellToken: ARC_USDC, buyToken: ARC_WETH,
      amount: "1000000", walletAddress: WALLET,
    }, "arc-lifi-error-001");
    expect(response.status).toBe(503);
  });
});

describe("arc self-custody session flow over HTTP", () => {
  it("prepare persists one session whose approve+swap the client signs; submit consumes exactly once", async () => {
    const { app, call, userId } = await liveApp();
    stubLiFi(lifiQuoteBody());
    app.db.createIdentity("evm", WALLET, userId);

    const prepared = await (await call("/api/trades/prepare", {
      fromChain: "arc", toChain: "arc", sellToken: ARC_USDC, buyToken: ARC_WETH,
      amount: "1000000", walletAddress: WALLET,
    }, "arc-lifi-e2e-0001")).json();
    expect(prepared.sessionId).toBeTruthy();
    expect(prepared.unsignedTransaction.approveTx.to).toBe(ARC_USDC);

    const txHash = "arcLifiSwapTxHash0000000000000001";
    const first = await call("/api/trades/submit", { sessionId: prepared.sessionId, txHash }, "arc-lifi-e2e-0002");
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ status: "submitted", chain: "arc", selfCustody: true });
    // Replay cannot register the swap twice.
    const replay = await call("/api/trades/submit", { sessionId: prepared.sessionId, txHash }, "arc-lifi-e2e-0003");
    expect(replay.status).toBe(409);
    expect(app.db.getUserTrades(userId).filter((t: any) => t.tx_hash === txHash)).toHaveLength(1);
  });
  it("rejects prepare for a wallet that is not linked before contacting Li.Fi", async () => {
    const { call } = await liveApp();
    const { urls } = stubLiFi(lifiQuoteBody());
    const response = await call("/api/trades/prepare", {
      fromChain: "arc", toChain: "arc", sellToken: ARC_USDC, buyToken: ARC_WETH,
      amount: "1000000", walletAddress: WALLET,
    }, "arc-lifi-e2e-0004");
    expect(response.status).toBe(403);
    expect(urls).toHaveLength(0);
  });
});

describe("erc20ApproveCalldata", () => {
  it("encodes selector + padded spender + amount", () => {
    const data = erc20ApproveCalldata(DIAMOND, 1_000_000n);
    expect(data).toBe("0x095ea7b3" + "a4072583658fae592a3506a42431cb6316a8d40b".padStart(64, "0") + "f4240".padStart(64, "0"));
  });
  it("refuses malformed spenders instead of encoding garbage", () => {
    expect(() => erc20ApproveCalldata("0x1234", 1n)).toThrow();
  });
});

describe("arc receipt settlement (Li.Fi shape)", () => {
  const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4dfbff2e9";
  const topic = (addr: string) => "0x" + addr.toLowerCase().slice(2).padStart(64, "0");
  it("parses the USDC→WETH fill from owner-scoped Transfer deltas", () => {
    const receipt = {
      status: "0x1",
      logs: [
        // user sends exactly 1 USDC to the Diamond
        { address: ARC_USDC, topics: [TRANSFER, topic(WALLET), topic(DIAMOND)], data: "0x" + (1_000_000n).toString(16).padStart(64, "0") },
        // user receives WETH net of route fees
        { address: ARC_WETH, topics: [TRANSFER, topic(DIAMOND), topic(WALLET)], data: "0x" + (361_042_248_802_261n).toString(16).padStart(64, "0") },
      ],
    };
    const fill = parseEvmTransferFill(receipt, {
      walletAddress: WALLET, sellToken: ARC_USDC, buyToken: ARC_WETH, sellAmount: "1000000", expectedFeeBps: 30,
    });
    expect(fill).toMatchObject({
      sellToken: ARC_USDC, buyToken: ARC_WETH, sellAmount: "1000000", buyAmount: "361042248802261",
      feeAmount: "3000", feeToken: "sell",
    });
  });
});
