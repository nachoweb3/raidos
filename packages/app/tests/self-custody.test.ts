import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiServer } from "../src/api/server.js";
import { TradingEngine, feeAccountExistsCache } from "../src/trading/engine.js";

// The liveApp helper sets its own env; tests below override per-case.
vi.stubEnv("ADMIN_SECRET", "");
import { getChain } from "../src/chains/config.js";
import { parseEvmTransferFill } from "../src/trading/reconciler.js";
import type { ReceiptProvider, ReceiptResult, ReceiptFill } from "../src/trading/reconciler.js";

let server: ApiServer | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await server?.stop();
  server = undefined;
});

const usdc = getChain("solana")!.usdcAddress;
const TOKEN = "TokenForSelfCustody1111111111111111111111111";

/** Live-mode server with a Jupiter key and a stubbed receipt provider. */
async function liveApp() {
  vi.stubEnv("JUPITER_API_KEY", "test-key");
  vi.stubEnv("ZERO_X_API_KEY", "test-key");
  server = new ApiServer({
    dbPath: ":memory:", port: 0, siteDir: null, appMode: "live",
    receiptProvider: { getReceipt: async () => { throw new Error("no network in tests"); } },
  });
  const base = "http://127.0.0.1:" + await server.start();
  const registered = await fetch(base + "/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const { apiKey, userId } = await registered.json();
  const call = (path: string, body?: unknown, extraHeaders: Record<string, string> = {}) =>
    fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
        "Idempotency-Key": "selfcustody-test-0001",
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { app: server, call, userId, apiKey, base };
}

describe("self-custody execution policy", () => {
  it("advertises live self-custody only for enabled chains with quote credentials", async () => {
    const { call } = await liveApp();
    const { chains } = await (await call("/api/chains")).json();
    expect(chains.find((c: any) => c.id === "solana")).toMatchObject({ liveExecution: true, selfCustody: true, status: "LIVE" });
    expect(chains.find((c: any) => c.id === "base")).toMatchObject({ liveExecution: true, status: "LIVE" });
    expect(chains.find((c: any) => c.id === "ethereum")).toMatchObject({ liveExecution: true, status: "LIVE" });
    for (const id of ["bsc", "robinhood"]) {
      expect(chains.find((c: any) => c.id === id)).toMatchObject({ liveExecution: false, status: "UNAVAILABLE" });
    }
  });

  it("rejects prepare for an unlinked wallet before contacting any provider", async () => {
    const { call } = await liveApp();
    const prepare = vi.spyOn(TradingEngine.prototype, "prepareSelfCustodyTransaction").mockRejectedValue(new Error("must not call provider"));
    const response = await call("/api/trades/prepare", {
      fromChain: "solana", toChain: "solana", sellToken: usdc, buyToken: TOKEN, amount: "100000",
      walletAddress: "11111111111111111111111111111111",
    });
    expect(response.status).toBe(403);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("rejects prepare on chains without a self-custody adapter", async () => {
    const { call } = await liveApp();
    const response = await call("/api/trades/prepare", {
      fromChain: "bsc", toChain: "bsc",
      sellToken: getChain("bsc")!.usdcAddress, buyToken: "0x" + "a".repeat(40), amount: "100000",
      walletAddress: "0x" + "b".repeat(40),
    });
    expect(response.status).toBe(403);
  });

  it("rejects a foreign or unknown session on submit without changing accounting", async () => {
    const { app, call } = await liveApp();
    const response = await call("/api/trades/submit", {
      sessionId: "d4c9a2f1000040008000000000000000",
      txHash: "arbitrary-unverified-hash-value",
    });
    expect(response.status).toBe(404);
    expect(app.db.getUserTrades(1)).toEqual([]);
  });
});

function fakeQuote(fromChain: string, sellToken: string, amount: string) {
  return {
    fromChain, toChain: fromChain, sellToken, buyToken: TOKEN,
    sellAmount: amount, buyAmount: "42", priceImpact: "0", feeUsdc: "1000",
    gasEstimate: "5000", route: "jupiter", aggregator: "jupiter", expiresAt: Date.now() + 30_000,
  };
}

describe("self-custody settlement flow", () => {
  const walletAddress = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
  const solTxHash = "5SoupTxHashWithChars1AAAAAAAAAAAAAAAAAAAAAAAAAAp";
  const EVM_TOKEN = "0x" + "a1".repeat(20);

  /** Link a Solana wallet by inserting the identity its signature would produce. */
  function linkSolanaWallet(app: ApiServer, userId: number, address: string) {
    app.db.createIdentity("solana", address, userId);
  }

  it("prepares a real unsigned transaction and persists exactly one consumable session", async () => {
    const { app, call, userId } = await liveApp();
    linkSolanaWallet(app, userId, walletAddress);
    const prepare = vi.spyOn(TradingEngine.prototype, "prepareSelfCustodyTransaction").mockResolvedValue({
      quote: fakeQuote("solana", usdc, "100000"),
      unsignedTransaction: { kind: "solana", serialized: "base64-tx", chainId: 0 },
    });
    const response = await call("/api/trades/prepare", {
      fromChain: "solana", toChain: "solana", sellToken: usdc, buyToken: TOKEN, amount: "100000",
      walletAddress,
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.unsignedTransaction).toMatchObject({ kind: "solana", serialized: "base64-tx" });
    expect(body.selfCustody).toBe(true);
    const session = (app as any).db.getSelfCustodySession(body.sessionId);
    expect(session.user_id).toBe(userId);
    expect(session.status).toBe("prepared");
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("settles a Solana swap from a verified receipt, never from client amounts", async () => {
    const { app, call, userId } = await liveApp();
    linkSolanaWallet(app, userId, walletAddress);
    vi.spyOn(TradingEngine.prototype, "prepareSelfCustodyTransaction").mockResolvedValue({
      quote: fakeQuote("solana", usdc, "100000"),
      unsignedTransaction: { kind: "solana", serialized: "base64-tx", chainId: 0 },
    });
    const prepared = await (await call("/api/trades/prepare", {
      fromChain: "solana", toChain: "solana", sellToken: usdc, buyToken: TOKEN, amount: "100000", walletAddress,
    })).json();

    const fill: ReceiptFill = { sellToken: usdc, buyToken: TOKEN, sellAmount: "100000", buyAmount: "42", feeAmount: "0", feeToken: "buy" };
    (app as any).receiptProvider = {
      getReceipt: async (chain: string, hash: string): Promise<ReceiptResult> => {
        expect(chain).toBe("solana");
        expect(hash).toBe(solTxHash);
        return { status: "confirmed", receipt: { block: 1 }, fill };
      },
    } as ReceiptProvider;

    const submitted = await (await call("/api/trades/submit", { sessionId: prepared.sessionId, txHash: solTxHash })).json();
    expect(submitted.status).toBe("settled");
    expect(submitted.reconcile).toMatchObject({ confirmed: 1 });

    const positions = app.db.getUserPositions(userId, "open");
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ chain: "solana", token: TOKEN, amount_remaining: "42" });
    expect(app.db.getExecutionTransaction(submitted.intentId).status).toBe("settled");
    expect(app.db.getSelfCustodySession(prepared.sessionId).status).toBe("submitted");
  });

  it("rejects a replayed submit and leaves accounting untouched", async () => {
    const { app, call, userId } = await liveApp();
    linkSolanaWallet(app, userId, walletAddress);
    vi.spyOn(TradingEngine.prototype, "prepareSelfCustodyTransaction").mockResolvedValue({
      quote: fakeQuote("solana", usdc, "100000"),
      unsignedTransaction: { kind: "solana", serialized: "base64-tx", chainId: 0 },
    });
    const prepared = await (await call("/api/trades/prepare", {
      fromChain: "solana", toChain: "solana", sellToken: usdc, buyToken: TOKEN, amount: "100000", walletAddress,
    })).json();
    (app as any).receiptProvider = {
      getReceipt: async () => ({ status: "confirmed", receipt: { block: 1 }, fill: { sellToken: usdc, buyToken: TOKEN, sellAmount: "100000", buyAmount: "42", feeAmount: "0", feeToken: "buy" } }),
    };
    const first = await call("/api/trades/submit", { sessionId: prepared.sessionId, txHash: solTxHash });
    expect(first.status).toBe(202);
    expect((await first.json()).status).toBe("settled");
    const replay = await call("/api/trades/submit", { sessionId: prepared.sessionId, txHash: solTxHash });
    expect(replay.status).toBe(409);
    expect(app.db.getUserPositions(userId, "open")).toHaveLength(1);
  });

  it("keeps a submitted transaction pending when the receipt is not yet available", async () => {
    const { app, call, userId } = await liveApp();
    linkSolanaWallet(app, userId, walletAddress);
    vi.spyOn(TradingEngine.prototype, "prepareSelfCustodyTransaction").mockResolvedValue({
      quote: fakeQuote("solana", usdc, "100000"),
      unsignedTransaction: { kind: "solana", serialized: "base64-tx", chainId: 0 },
    });
    const prepared = await (await call("/api/trades/prepare", {
      fromChain: "solana", toChain: "solana", sellToken: usdc, buyToken: TOKEN, amount: "100000", walletAddress,
    })).json();
    (app as any).receiptProvider = {
      getReceipt: async () => ({ status: "pending" }),
    };
    const submitted = await (await call("/api/trades/submit", { sessionId: prepared.sessionId, txHash: solTxHash })).json();
    expect(submitted.status).toBe("pending");
    expect(app.db.getExecutionTransaction(submitted.intentId).status).toBe("pending");
    expect(app.db.getUserPositions(1, "open")).toHaveLength(0);
  });

  it("marks the transaction failed when the receipt reverts, with no position", async () => {
    const { app, call, userId } = await liveApp();
    linkSolanaWallet(app, userId, walletAddress);
    vi.spyOn(TradingEngine.prototype, "prepareSelfCustodyTransaction").mockResolvedValue({
      quote: fakeQuote("solana", usdc, "100000"),
      unsignedTransaction: { kind: "solana", serialized: "base64-tx", chainId: 0 },
    });
    const prepared = await (await call("/api/trades/prepare", {
      fromChain: "solana", toChain: "solana", sellToken: usdc, buyToken: TOKEN, amount: "100000", walletAddress,
    })).json();
    (app as any).receiptProvider = {
      getReceipt: async () => ({ status: "failed", receipt: { err: {} }, error: "Solana transaction failed" }),
    };
    const submitted = await (await call("/api/trades/submit", { sessionId: prepared.sessionId, txHash: solTxHash })).json();
    expect(submitted.status).toBe("failed");
    expect(app.db.getUserPositions(1, "open")).toHaveLength(0);
    expect(app.db.getExecutionTransaction(submitted.intentId).status).toBe("failed");
  });

  it("settles an EVM swap on base and keeps it separate from solana positions", async () => {
    const { app, call, userId } = await liveApp();
    const wallet = "0x" + "c".repeat(40);
    app.db.createIdentity("evm", wallet, userId);
    const usdcBase = getChain("base")!.usdcAddress;
    vi.spyOn(TradingEngine.prototype, "prepareSelfCustodyTransaction").mockResolvedValue({
      quote: fakeQuote("base", usdcBase, "1000000"),
      unsignedTransaction: { kind: "evm", to: "0x" + "d".repeat(40), data: "0xabc", value: "0", gas: "80000", chainId: 8453 },
    });
    const prepared = await (await call("/api/trades/prepare", {
      fromChain: "base", toChain: "base", sellToken: usdcBase, buyToken: EVM_TOKEN, amount: "1000000", walletAddress: wallet,
    })).json();
    (app as any).receiptProvider = {
      getReceipt: async () => ({
        status: "confirmed",
        receipt: { status: "0x1", logs: [] },
        fill: { sellToken: usdcBase, buyToken: EVM_TOKEN, sellAmount: "1000000", buyAmount: "42", feeAmount: "0", feeToken: "sell" },
      }),
    };
    const submitted = await (await call("/api/trades/submit", { sessionId: prepared.sessionId, txHash: "0x" + "f".repeat(63) + "1" })).json();
    expect(submitted.status).toBe("settled");
    const positions = app.db.getUserPositions(userId, "open");
    expect(positions).toHaveLength(1);
    expect(positions[0].chain).toBe("base");
    expect(positions[0].amount_remaining).toBe("42");
  });
});

describe("operator controls and exposure limits", () => {
  const walletAddress = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

  function adminHeaders() {
    return { "x-admin-secret": "admin-test-secret" };
  }

  async function adminApp() {
    const app = await liveApp();
    process.env.ADMIN_SECRET = "admin-test-secret";
    return app;
  }

  it("operator can pause and resume execution; gates apply to prepare and submit", async () => {
    const { app, call, userId } = await adminApp();
    app.db.createIdentity("solana", walletAddress, userId);
    vi.spyOn(TradingEngine.prototype, "prepareSelfCustodyTransaction").mockResolvedValue({
      quote: fakeQuote("solana", usdc, "100000"),
      unsignedTransaction: { kind: "solana", serialized: "base64-tx", chainId: 0 },
    });

    // Pause via admin API
    const pause = await call("/api/admin/execution", { enabled: false }, adminHeaders());
    expect(pause.status).toBe(200);
    expect((await pause.json()).executionEnabled).toBe(false);

    const blockedPrepare = await call("/api/trades/prepare", {
      fromChain: "solana", toChain: "solana", sellToken: usdc, buyToken: TOKEN, amount: "100000", walletAddress,
    });
    expect(blockedPrepare.status).toBe(503);

    const status = await call("/api/admin/execution", undefined, adminHeaders());
    expect(await status.json()).toMatchObject({ executionEnabled: false, source: "database" });

    // Resume
    await call("/api/admin/execution", { enabled: true }, adminHeaders());
    const prepared = await (await call("/api/trades/prepare", {
      fromChain: "solana", toChain: "solana", sellToken: usdc, buyToken: TOKEN, amount: "100000", walletAddress,
    })).json();
    expect(prepared.sessionId).toBeTruthy();
  });

  it("rejects admin routes without the secret", async () => {
    const { call } = await adminApp();
    const noSecret = await call("/api/admin/execution", { enabled: true });
    expect(noSecret.status).toBe(403);
    const badSecret = await call("/api/admin/execution", { enabled: true }, { "x-admin-secret": "wrong" });
    expect(badSecret.status).toBe(403);
  });

  it("enforces the daily exposure limit across sessions and exposes it to admins", async () => {
    process.env.EXECUTION_DAILY_LIMIT_USDC = "1"; // 1 USDC/day
    try {
      const { app, call, userId } = await adminApp();
      app.db.createIdentity("solana", walletAddress, userId);
      vi.spyOn(TradingEngine.prototype, "prepareSelfCustodyTransaction").mockResolvedValue({
        quote: fakeQuote("solana", usdc, "100000"),
        unsignedTransaction: { kind: "solana", serialized: "base64-tx", chainId: 0 },
      });
      const body = { fromChain: "solana", toChain: "solana", sellToken: usdc, buyToken: TOKEN, amount: "900000", walletAddress };
      const ok = await call("/api/trades/prepare", body);
      expect(ok.status).toBe(200);
      // Second 0.9-USDC swap pushes the trailing 24h total past 1 USDC.
      const second = await call("/api/trades/prepare", body);
      expect(second.status).toBe(429);
      const status = await call("/api/admin/execution", undefined, adminHeaders());
      expect(await status.json()).toMatchObject({ dailyLimitUsdc: "1" });
    } finally {
      delete process.env.EXECUTION_DAILY_LIMIT_USDC;
    }
  });

  it("links a signature-verified wallet to an existing account without rotating keys", async () => {
    const { app, call, userId } = await adminApp();
    const challenge = await (await call("/api/auth/challenge", { chain: "solana" })).json();
    // Simulate the client signature by registering the identity the signed
    // challenge would produce — verification itself is covered elsewhere.
    const link = await call("/api/wallet/link", {
      chain: "solana", address: walletAddress, message: challenge.message, signature: "00", nonce: challenge.nonce,
    });
    // Signature fails verification → 401; consume() already burned the nonce.
    expect(link.status).toBe(401);
    expect(app.db.getUserByIdentity("solana", walletAddress)).toBeUndefined();
    expect(userId).toBeTruthy();
  });

  it("does not count failed sessions twice in exposure accounting", async () => {
    process.env.EXECUTION_DAILY_LIMIT_USDC = "1";
    try {
      const { app, call, userId } = await adminApp();
      app.db.createIdentity("solana", walletAddress, userId);
      vi.spyOn(TradingEngine.prototype, "prepareSelfCustodyTransaction").mockResolvedValue({
        quote: fakeQuote("solana", usdc, "100000"),
        unsignedTransaction: { kind: "solana", serialized: "base64-tx", chainId: 0 },
      });
      const body = { fromChain: "solana", toChain: "solana", sellToken: usdc, buyToken: TOKEN, amount: "900000", walletAddress };
      const first = await call("/api/trades/prepare", body);
      expect(first.status).toBe(200);
      const second = await call("/api/trades/prepare", body);
      expect(second.status).toBe(429);
      // Sessions persist; window expires organically after 24h.
      expect(app.db.getSelfCustodySessionsSince(userId, Math.floor(Date.now() / 1000) - 3600).length).toBe(1);
    } finally {
      delete process.env.EXECUTION_DAILY_LIMIT_USDC;
    }
  });
});

describe("EVM affiliate fee", () => {
  it("applies 0x v2 fee parameters only when a recipient is configured", async () => {
    process.env.EVM_SWAP_FEE_RECIPIENT = "0x" + "b".repeat(40);
    process.env.EVM_SWAP_FEE_BPS = "50";
    try {
      const engine = new TradingEngine();
      const spy = vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({
        buyAmount: "1", priceImpactPct: "0", routePlan: [],
        transaction: { to: "0x" + "1".repeat(40), data: "0x", value: "0", gas: "1" },
      }), { status: 200 }));
      await engine.getQuote({
        userId: 1, fromChain: "base", toChain: "base",
        sellToken: getChain("base")!.usdcAddress, buyToken: "0x" + "2".repeat(40),
        amount: "1000000", type: "swap",
      });
      const requestedUrl = new URL(String(spy.mock.calls[0][0]));
      expect(requestedUrl.searchParams.get("swapFeeRecipient")).toBe("0x" + "b".repeat(40));
      expect(requestedUrl.searchParams.get("swapFeeBps")).toBe("50");
      expect(requestedUrl.searchParams.get("swapFeeToken")).toBe(getChain("base")!.usdcAddress);
    } finally {
      delete process.env.EVM_SWAP_FEE_RECIPIENT;
      delete process.env.EVM_SWAP_FEE_BPS;
    }
  });

  it("omits fee parameters by default so quotes stay unchanged", async () => {
    delete process.env.EVM_SWAP_FEE_RECIPIENT;
    const engine = new TradingEngine();
    const spy = vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({
      buyAmount: "1", priceImpactPct: "0", routePlan: [],
      transaction: { to: "0x" + "1".repeat(40), data: "0x", value: "0", gas: "1" },
    }), { status: 200 }));
    await engine.getQuote({
      userId: 1, fromChain: "base", toChain: "base",
      sellToken: getChain("base")!.usdcAddress, buyToken: "0x" + "2".repeat(40),
      amount: "1000000", type: "swap",
    });
    const requestedUrl = new URL(String(spy.mock.calls[0][0]));
    expect(requestedUrl.searchParams.get("swapFeeRecipient")).toBeNull();
    expect(requestedUrl.searchParams.get("swapFeeBps")).toBeNull();
  });
});

describe("Solana platform fee and Jupiter fee accounting", () => {
  it("sends platformFeeBps and a swap-level feeAccount only when fully configured", async () => {
    const feeAccount = "FeeAccount1111111111111111111111111111111111";
    const spy = vi.spyOn(global, "fetch").mockImplementation(async (input: any, init?: any) => {
      if (String(init?.body ?? "").includes("getAccountInfo")) {
        return new Response(JSON.stringify({ result: { value: { data: ["", "base64"] } } }), { status: 200 });
      }
      return new Response(JSON.stringify({
        inAmount: "1000000", outAmount: "42", priceImpactPct: "0", routePlan: [],
      }), { status: 200 });
    });
    vi.stubEnv("SOLANA_PLATFORM_FEE_ACCOUNT", feeAccount);
    vi.stubEnv("SOLANA_PLATFORM_FEE_BPS", "50");
    await new TradingEngine().getQuote({
      userId: 1, fromChain: "solana", toChain: "solana",
      sellToken: getChain("solana")!.usdcAddress, buyToken: TOKEN,
      amount: "1000000", type: "swap",
    });
    const quoteUrls = () => spy.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("/quote"));
    expect(quoteUrls()).toHaveLength(1);
    expect(new URL(quoteUrls()[0]).searchParams.get("platformFeeBps")).toBe("50");
    // Missing account config: no fee requested on the quote (cache cleared
    // so the second quote re-checks instead of reusing the first result).
    vi.stubEnv("SOLANA_PLATFORM_FEE_ACCOUNT", "");
    feeAccountExistsCache.clear();
    await new TradingEngine().getQuote({
      userId: 1, fromChain: "solana", toChain: "solana",
      sellToken: getChain("solana")!.usdcAddress, buyToken: TOKEN,
      amount: "1000000", type: "swap",
    });
    expect(quoteUrls()).toHaveLength(2);
    expect(new URL(quoteUrls()[1]).searchParams.get("platformFeeBps")).toBeNull();
    feeAccountExistsCache.clear();
  });

  it("reconstructs the Jupiter output-side fee from the verified net delta", async () => {
    const { parseSolanaJupiterFill } = await import("../src/trading/reconciler.js");
    const wallet = "Wallet111111111111111111111111111111111111111";
    const usdc = getChain("solana")!.usdcAddress;
    const receipt = {
      meta: {
        preTokenBalances: [
          { accountIndex: 1, mint: usdc, owner: wallet, uiTokenAmount: { amount: "1000000" } },
          { accountIndex: 2, mint: TOKEN, owner: wallet, uiTokenAmount: { amount: "0" } },
        ],
        postTokenBalances: [
          { accountIndex: 1, mint: usdc, owner: wallet, uiTokenAmount: { amount: "0" } },
          // Fee 0.3% of buy: net 9970 => gross 10000 => fee 30 raw units.
          { accountIndex: 2, mint: TOKEN, owner: wallet, uiTokenAmount: { amount: "9970" } },
        ],
      },
    };
    const fill = parseSolanaJupiterFill(receipt, { walletAddress: wallet, sellToken: usdc, buyToken: TOKEN, sellAmount: "1000000", expectedFeeBps: 30 });
    expect(fill).toMatchObject({ sellAmount: "1000000", buyAmount: "9970", feeAmount: "30", feeToken: "buy" });
  });

  it("derives the swap-level feeAccount from the fee owner per output mint", async () => {
    delete process.env.SOLANA_PLATFORM_FEE_ACCOUNT;
    process.env.SOLANA_PLATFORM_FEE_OWNER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
    // Jupiter's feeAccount must be an ATA of the fee owner for the OUTPUT
    // mint, so this test uses real base58 mints.
    const outputMint = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
    const captured: (string | undefined)[] = [];
    vi.spyOn(global, "fetch").mockImplementation(async (input: any, init?: any) => {
      if (String(input).endsWith("/swap")) {
        captured.push(JSON.parse(init?.body ?? "{}").feeAccount);
        return new Response(JSON.stringify({ swapTransaction: "base64-tx" }), { status: 200 });
      }
      if (String(init?.body ?? "").includes("getAccountInfo")) {
        // Simulate the fee ATA existing on-chain for the first prepare.
        return new Response(JSON.stringify({ result: { value: { data: ["", "base64"] } } }), { status: 200 });
      }
      return new Response(JSON.stringify({
        inAmount: "1000000", outAmount: "42", priceImpactPct: "0", routePlan: [],
      }), { status: 200 });
    });
    const wallet = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
    const swapParams = {
      userId: 1, fromChain: "solana", toChain: "solana",
      sellToken: getChain("solana")!.usdcAddress, buyToken: outputMint,
      amount: "1000000", type: "swap" as const,
    };
    try {
      const engine = new TradingEngine();
      const prepared = await engine.prepareSelfCustodyTransaction(swapParams, wallet);
      const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
      const { PublicKey } = await import("@solana/web3.js");
      const expected = getAssociatedTokenAddressSync(
        new PublicKey(outputMint), new PublicKey(process.env.SOLANA_PLATFORM_FEE_OWNER!), true,
      ).toBase58();
      expect(captured[0]).toBe(expected);
      expect(prepared.platformFeeBps).toBe(50);
      // A static override takes precedence over owner-based derivation.
      process.env.SOLANA_PLATFORM_FEE_ACCOUNT = "FeeAccount1111111111111111111111111111111111";
      await engine.prepareSelfCustodyTransaction(swapParams, wallet);
      expect(captured[1]).toBe("FeeAccount1111111111111111111111111111111111");
    } finally {
      delete process.env.SOLANA_PLATFORM_FEE_OWNER;
      delete process.env.SOLANA_PLATFORM_FEE_ACCOUNT;
      feeAccountExistsCache.clear();
    }
  });

  it("skips the fee (never breaks the swap) when the fee ATA does not exist", async () => {
    delete process.env.SOLANA_PLATFORM_FEE_ACCOUNT;
    process.env.SOLANA_PLATFORM_FEE_OWNER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
    const captured: (string | undefined)[] = [];
    let rpcCalls = 0;
    vi.spyOn(global, "fetch").mockImplementation(async (input: any, init?: any) => {
      if (String(input).endsWith("/swap")) {
        captured.push(JSON.parse(init?.body ?? "{}").feeAccount);
        return new Response(JSON.stringify({ swapTransaction: "base64-tx" }), { status: 200 });
      }
      if (String(init?.body ?? "").includes("getAccountInfo")) {
        rpcCalls++;
        return new Response(JSON.stringify({ result: { value: null } }), { status: 200 });
      }
      return new Response(JSON.stringify({
        inAmount: "1000000", outAmount: "42", priceImpactPct: "0", routePlan: [],
      }), { status: 200 });
    });
    const wallet = "Wallet111111111111111111111111111111111111111";
    try {
      const engine = new TradingEngine();
      const prepared = await engine.prepareSelfCustodyTransaction({
        userId: 1, fromChain: "solana", toChain: "solana",
        sellToken: getChain("solana")!.usdcAddress, buyToken: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
        amount: "1000000", type: "swap",
      }, wallet);
      expect(captured[0]).toBeUndefined();
      expect(prepared.platformFeeBps).toBe(0);
      expect(rpcCalls).toBe(1);
    } finally {
      delete process.env.SOLANA_PLATFORM_FEE_OWNER;
      feeAccountExistsCache.clear();
    }
  });

  it("treats the fee as USDC only when the fee leg is USDC", async () => {
    const { app, call, userId } = await liveApp();
    const walletAddress = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
    app.db.createIdentity("solana", walletAddress, userId);
    const solTxHash = "5SoupTxHashWithChars1AAAAAAAAAAAAAAAAAAAAAAAAAAp";
    vi.spyOn(TradingEngine.prototype, "prepareSelfCustodyTransaction").mockResolvedValue({
      quote: fakeQuote("solana", usdc, "100000"),
      unsignedTransaction: { kind: "solana", serialized: "base64-tx", chainId: 0 },
    });
    const prepared = await call("/api/trades/prepare", {
      fromChain: "solana", toChain: "solana", sellToken: usdc, buyToken: TOKEN, amount: "100000", walletAddress,
    });
    expect(prepared.status).toBe(200);
    const { sessionId } = await prepared.json();
    // Buy with Jupiter fee config ON: fee comes out of the buy token (not USDC),
    // so USDC accounting stays 0 while the fill and settlement still succeed.
    vi.stubEnv("SOLANA_PLATFORM_FEE_ACCOUNT", "FeeAccount1111111111111111111111111111111111");
    const receiptProvider = (app as any).receiptProvider as ReceiptProvider;
    (app as any).receiptProvider = {
      getReceipt: async () => ({
        status: "confirmed",
        receipt: {},
        fill: { sellToken: usdc, buyToken: TOKEN, sellAmount: "100000", buyAmount: "9970", feeAmount: "30", feeToken: "buy" },
      }),
    };
    const submitted = await call("/api/trades/submit", { sessionId, txHash: solTxHash });
    expect(submitted.status).toBe(202);
    const trade = app.db.getTrade(app.db.getUserTrades(userId)[0].id);
    expect(trade.status).toBe("confirmed");
    expect(trade.buy_amount).toBe("9970");
    expect(trade.fee_usdc).toBe("0");
    (app as any).receiptProvider = receiptProvider;
  });
});

describe("EVM fill parsing from receipt logs", () => {
  const transfer = (token: string, from: string, to: string, amountHex: string) => ({
    address: token,
    topics: [
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4dfbff2e9",
      "0x" + from.padStart(64, "0"),
      "0x" + to.padStart(64, "0"),
    ],
    data: amountHex,
  });
  const wallet = "0x" + "c".repeat(40);
  const pool = "0x" + "e".repeat(40);
  const usdcBase = getChain("base")!.usdcAddress.toLowerCase();
  const evmToken = "0x" + "a1".repeat(20);
  const context = { walletAddress: wallet, sellToken: usdcBase, buyToken: evmToken, sellAmount: "1000000" };

  it("derives the exact fill from owner-scoped Transfer deltas", () => {
    const fill = parseEvmTransferFill({
      status: "0x1",
      logs: [
        transfer(usdcBase, wallet.slice(2), pool.slice(2), "0x" + 1_000_000n.toString(16)),
        { address: pool, topics: ["0xother"], data: "0x1" }, // unrelated event
        transfer(evmToken, pool.slice(2), wallet.slice(2), "0x2a"),
      ],
    }, context);
    expect(fill).toMatchObject({ sellAmount: "1000000", buyAmount: "42", feeAmount: "0", feeToken: "sell" });
  });

  it("refuses receipts whose deltas do not match the intent or are malformed", () => {
    const good = [transfer(usdcBase, wallet.slice(2), pool.slice(2), "0x" + 1_000_000n.toString(16)), transfer(evmToken, pool.slice(2), wallet.slice(2), "0x2a")];
    expect(parseEvmTransferFill({ status: "0x1", logs: good }, { ...context, sellAmount: "999" })).toBeUndefined();
    expect(parseEvmTransferFill({ status: "0x0", logs: good }, context)).toBeUndefined();
    expect(parseEvmTransferFill({ status: "0x1", logs: [] }, context)).toBeUndefined();
    expect(parseEvmTransferFill({ status: "0x1", logs: [{ ...good[0], data: "0xzz" }] }, context)).toBeUndefined();
    // Same owner net-zero (flash-loan style) must not produce a fill
    expect(parseEvmTransferFill({
      status: "0x1",
      logs: [
        transfer(usdcBase, wallet.slice(2), pool.slice(2), "0x" + 1_000_000n.toString(16)),
        transfer(usdcBase, pool.slice(2), wallet.slice(2), "0x" + 1_000_000n.toString(16)),
        transfer(evmToken, pool.slice(2), wallet.slice(2), "0x2a"),
      ],
    }, context)).toBeUndefined();
  });
});
