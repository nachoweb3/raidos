import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AppDb } from "../src/database/app-db.js";
import { ExecutionReconciler, parseSolanaJupiterFill, type ReceiptProvider } from "../src/trading/reconciler.js";
import { applySwapToPosition } from "../src/trading/positions.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "reconciler-test-"));
  const db = new AppDb(join(dir, "db.sqlite"));
  const intentId = db.createExecutionIntent({
    userId: 1,
    endpoint: "POST /api/trades/execute",
    idempotencyKey: "reconcile-0001",
    requestHash: "hash",
    requestJson: "{}",
    mode: "live",
  });  const txId = db.createExecutionTransaction({ intentId, tradeId: null, userId: 1, chain: "solana", txHash: "tx-1", status: "submitted" });
  return { dir, db, txId, intentId };
}

describe("execution reconciler", () => {
  let cleanup: (() => void) | undefined;

  it("parses a Jupiter fill from wallet-owned SPL balance deltas", () => {
    const wallet = "Wallet111111111111111111111111111111111111111";
    const usdc = "USDC1111111111111111111111111111111111111111";
    const moon = "MOON1111111111111111111111111111111111111111";
    expect(parseSolanaJupiterFill({
      meta: {
        preTokenBalances: [
          { accountIndex: 1, mint: usdc, owner: wallet, uiTokenAmount: { amount: "10000000" } },
          { accountIndex: 2, mint: moon, owner: wallet, uiTokenAmount: { amount: "25" } },
        ],
        postTokenBalances: [
          { accountIndex: 1, mint: usdc, owner: wallet, uiTokenAmount: { amount: "0" } },
          { accountIndex: 2, mint: moon, owner: wallet, uiTokenAmount: { amount: "100025" } },
        ],
      },
    }, { walletAddress: wallet, sellToken: usdc, buyToken: moon, sellAmount: "10000000" })).toEqual({
      sellToken: usdc, buyToken: moon, sellAmount: "10000000", buyAmount: "100000", feeAmount: "0", feeToken: "buy",
    });
  });

  it("rejects ambiguous or mismatched Solana balance deltas", () => {
    const wallet = "Wallet111111111111111111111111111111111111111";
    const usdc = "USDC1111111111111111111111111111111111111111";
    const moon = "MOON1111111111111111111111111111111111111111";
    const receipt = {
      meta: {
        preTokenBalances: [
          { accountIndex: 1, mint: usdc, uiTokenAmount: { amount: "100" } },
          { accountIndex: 2, mint: moon, owner: wallet, uiTokenAmount: { amount: "0" } },
        ],
        postTokenBalances: [
          { accountIndex: 1, mint: usdc, owner: wallet, uiTokenAmount: { amount: "0" } },
          { accountIndex: 2, mint: moon, owner: wallet, uiTokenAmount: { amount: "10" } },
        ],
      },
    };
    expect(parseSolanaJupiterFill(receipt, { walletAddress: wallet, sellToken: usdc, buyToken: moon, sellAmount: "100" })).toBeUndefined();
    expect(parseSolanaJupiterFill({ ...receipt, meta: { ...receipt.meta, preTokenBalances: receipt.meta.preTokenBalances.slice(1) } }, { walletAddress: wallet, sellToken: usdc, buyToken: moon, sellAmount: "100" })).toBeUndefined();
  });

  it("does not parse a failed Solana transaction", () => {
    const wallet = "Wallet111111111111111111111111111111111111111";
    const mint = "MINT11111111111111111111111111111111111111111";
    expect(parseSolanaJupiterFill({ meta: { err: { InstructionError: [0, "Custom"] } } }, {
      walletAddress: wallet, sellToken: mint, buyToken: "OUT", sellAmount: "10",
    })).toBeUndefined();
  });


  afterEach(() => cleanup?.());

  it("keeps submitted transactions pending", async () => {
    const state = setup();
    cleanup = () => { state.db.close(); rmSync(state.dir, { recursive: true, force: true }); };
    const provider: ReceiptProvider = { getReceipt: async () => ({ status: "pending" }) };
    const result = await new ExecutionReconciler(state.db, provider).reconcilePending();
    expect(result.pending).toBe(1);
    expect(state.db.getExecutionTransaction(state.intentId).status).toBe("pending");
  });

  it("marks a successful receipt confirmed and is repeat-safe", async () => {
    const state = setup();
    cleanup = () => { state.db.close(); rmSync(state.dir, { recursive: true, force: true }); };
    const provider: ReceiptProvider = { getReceipt: async () => ({ status: "confirmed", receipt: { block: 10 } }) };
    const reconciler = new ExecutionReconciler(state.db, provider);
    expect((await reconciler.reconcilePending()).confirmed).toBe(1);
    expect((await reconciler.reconcilePending()).confirmed).toBe(0);
    expect(state.db.getExecutionTransaction(state.intentId).status).toBe("confirmed");
  });

  it("settles an exact receipt fill into a position once", async () => {
    const state = setup();
    cleanup = () => { state.db.close(); rmSync(state.dir, { recursive: true, force: true }); };
    // The fixture request is intentionally minimal; the settlement handler
    // receives the verified fill from the chain adapter, not from the client.
    const provider: ReceiptProvider = {
      getReceipt: async () => ({
        status: "confirmed",
        receipt: { block: 10 },
        fill: {
          sellToken: "USDC",
          buyToken: "MOON",
          sellAmount: "10000000",
          buyAmount: "10000000",
          feeAmount: "30000",
          feeToken: "sell",
        },
      }),
    };
    const reconciler = new ExecutionReconciler(state.db, provider, async (tx, _receipt, fill) => {
      expect(fill).toBeTruthy();
      const position = applySwapToPosition(undefined, {
        side: "buy",
        tokenAmount: fill!.buyAmount,
        usdcAmount: fill!.sellAmount,
        feeUsdc: fill!.feeAmount, // sell-token fee on a USDC sell = USDC fee
        ts: Math.floor(Date.now() / 1000),
      });
      state.db.settleExecutionTransaction({
        transactionId: tx.id,
        intentId: tx.intent_id,
        userId: tx.user_id,
        chain: tx.chain,
        sellToken: fill!.sellToken,
        buyToken: fill!.buyToken,
        sellAmount: fill!.sellAmount,
        buyAmount: fill!.buyAmount,
        feeUsdc: fill!.feeAmount,
        settlementSource: "receipt",
        apply: () => state.db.upsertPosition({ ...position, id: undefined, user_id: tx.user_id, chain: tx.chain, token: "MOON", token_symbol: "MOON" }),
      });
    });

    expect((await reconciler.reconcilePending()).confirmed).toBe(1);
    expect(state.db.getExecutionFillByIntent(state.intentId).settlement_source).toBe("receipt");
    expect(state.db.getUserPositions(1, "open")[0].amount_remaining).toBe("10000000");
    expect(state.db.getExecutionTransaction(state.intentId).status).toBe("settled");
    expect(state.db.getExecutionIntent(1, "POST /api/trades/execute", "reconcile-0001").status).toBe("settled");
    expect((await reconciler.reconcilePending()).confirmed).toBe(0);
  });

  it("rolls back a fill and position when settlement projection fails", async () => {
    const state = setup();
    cleanup = () => { state.db.close(); rmSync(state.dir, { recursive: true, force: true }); };
    const provider: ReceiptProvider = {
      getReceipt: async () => ({
        status: "confirmed",
        receipt: { block: 11 },
        fill: { sellToken: "USDC", buyToken: "MOON", sellAmount: "100", buyAmount: "100", feeAmount: "1", feeToken: "sell" },
      }),
    };
    const reconciler = new ExecutionReconciler(state.db, provider, async (tx, _receipt, fill) => {
      state.db.settleExecutionTransaction({
        transactionId: tx.id,
        intentId: tx.intent_id,
        userId: tx.user_id,
        chain: tx.chain,
        sellToken: fill!.sellToken,
        buyToken: fill!.buyToken,
        sellAmount: fill!.sellAmount,
        buyAmount: fill!.buyAmount,
        feeUsdc: fill!.feeAmount,
        settlementSource: "receipt",
        apply: () => {
          state.db.addFeedEvent({ type: "swap", actor_id: 1, chain: "solana", token: "MOON", token_symbol: "MOON", ts: 1 });
          throw new Error("projection failed");
        },
      });
    });

    await expect(reconciler.reconcilePending()).rejects.toThrow("projection failed");
    expect(state.db.getExecutionFillByIntent(state.intentId)).toBeUndefined();
    expect(state.db.getExecutionTransaction(state.intentId).status).toBe("confirmed");
    expect(state.db.getFeed({ actorId: 1 }).length).toBe(0);
  });
});
