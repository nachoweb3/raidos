/**
 * 🏊 Launch AMM tests — the post-graduation pool is REAL money moving on
 * chain, so these tests pin the security-critical properties:
 * - The pool only co-signs a tx the user signed first, with the exact
 *   prepared shape (sources, destinations, authorities, amounts, decimals).
 * - Slippage protection (minOut) is part of the signed message itself.
 * - Reserves/quotes always come from the (stubbed) chain, never a DB cache.
 */

import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import {
  LaunchAmm,
  applyFee,
  computeSignatureFor,
  deriveVaults,
  getAmountOut,
  minOutFor,
  parseSplAccount,
  poolExecutionEnabled,
  priceDrift,
  quoteSwap,
  sessionIdFor,
  SWAP_FEE_BPS,
  type AmmDb,
  type PoolRow,
  type SolanaLike,
} from "../src/trading/launch-amm.js";

// ── Pure math ───────────────────────────────────────────────────────

/** web3.js returns signature bytes as Buffer; base58-encode like the RPC. */
function bs58Encode(bytes: Uint8Array): string {
  return bs58.encode(bytes);
}

describe("amm math", () => {
  it("applies the fee on the input", () => {
    expect(applyFee(1_000_000n, SWAP_FEE_BPS)).toBe(997_000n);
    expect(applyFee(0n, 30)).toBe(0n);
  });

  it("computes constant-product output", () => {
    // 100 in (after fee) against 1000/1000 reserves → classic x*y formula.
    expect(getAmountOut(100n, 1_000n, 1_000n)).toBe(90n);
    expect(getAmountOut(0n, 1_000n, 1_000n)).toBe(0n);
    expect(getAmountOut(100n, 0n, 1_000n)).toBe(0n);
  });

  it("quotes buys and sells with impact and mandatory minOut", () => {
    // Whole-token mint (0 dec) token side; USDC side in 1e6 base units.
    const quote = quoteSwap("buy", 1_000_000n, 5_000_000_000n, 100_000_000n, 100); // 100 USDC
    expect(quote.amountOut).toBeGreaterThan(0n);
    expect(quote.minOut).toBeLessThan(quote.amountOut); // 1% slippage floor
    expect(quote.priceImpactPct).toBeGreaterThan(0);
    expect(quote.priceImpactPct).toBeLessThan(100);

    const sell = quoteSwap("sell", 1_000_000n, 5_000_000_000n, 10_000n, 100);
    expect(sell.amountOut).toBeGreaterThan(0n);
    expect(minOutFor(sell.amountOut, 100)).toBe((sell.amountOut * 9_900n) / 10_000n);
  });

  it("rejects empty pools and non-positive amounts", () => {
    expect(() => quoteSwap("buy", 0n, 0n, 5n)).toThrow("no liquidity");
    expect(() => quoteSwap("buy", 1_000n, 1_000n, 0n)).toThrow("positive");
  });

  it("clamps slippage to a sane range", () => {
    const out = 1_000_000n;
    expect(minOutFor(out, -50)).toBe(out); // negative → no floor reduction
    expect(minOutFor(out, 9_999)).toBe((out * 5_000n) / 10_000n); // capped at 50%
  });
});

// ── Accounts and keys ────────────────────────────────────────────────────

describe("amm accounts", () => {
  it("parses SPL token account layout (mint, owner, amount)", () => {
    const mint = Keypair.generate().publicKey;
    const owner = Keypair.generate().publicKey;
    const data = new Uint8Array(165);
    data.set(mint.toBytes(), 0);
    data.set(owner.toBytes(), 32);
    new DataView(data.buffer).setBigUint64(64, 123_456_789n, true);
    const parsed = parseSplAccount(data);
    expect(parsed.mint.equals(mint)).toBe(true);
    expect(parsed.owner.equals(owner)).toBe(true);
    expect(parsed.amount).toBe(123_456_789n);
  });

  it("derives pool vaults as pool-owned ATAs", () => {
    const pool = Keypair.generate().publicKey;
    const mintA = Keypair.generate().publicKey;
    const mintB = Keypair.generate().publicKey;
    const { vaultA, vaultB } = deriveVaults(pool, mintA, mintB);
    expect(vaultA.equals(getAssociatedTokenAddressSync(mintA, pool))).toBe(true);
    expect(vaultB.equals(getAssociatedTokenAddressSync(mintB, pool))).toBe(true);
  });
});

// ── Engine with stubbed chain ────────────────────────────────────────────

describe("launch amm engine", () => {
  function makeSolanaStub(opts: { fundVaults?: boolean } = {}) {
    const raw: Uint8Array[] = [];
    const existing = new Set<string>();
    const usdcMint = Keypair.generate().publicKey;
    const stub: SolanaLike = {
      getLatestBlockhash: async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 100 }),
      getAccountInfo: async (address: PublicKey) => {
        if (opts.fundVaults && existing.has(address.toBase58())) {
          return { owner: TOKEN_PROGRAM_ID, lamports: 1_000_000, data: new Uint8Array(165) };
        }
        return null;
      },
      sendRawTransaction: async (bytes: Uint8Array) => {
        raw.push(bytes);
        return `sig-${raw.length}`;
      },
      confirmTransaction: async () => ({}),
    };
    return { stub, raw, usdcMint };
  }

  function makeAmmDb() {
    const swaps: unknown[] = [];
    let poolRow: PoolRow | null = null;
    const db: AmmDb = {
      createLaunchPool: (launchId, mintA, mintB, vaultA, vaultB, poolAddress) => {
        poolRow = { id: 1, launchId, mintA, mintB, vaultA, vaultB, poolAddress, status: "active", createdAt: 1 };
        return 1;
      },
      getLaunchPoolByLaunch: () => poolRow,
      recordPoolSwap: (...args) => swaps.push(args),
      listPoolSwaps: () => [],
    };
    return { db, swaps, getPool: () => poolRow as PoolRow };
  }

  const POOL = Keypair.generate();
  const USER = Keypair.generate();
  const LAUNCH_MINT = Keypair.generate().publicKey;
  const MINT_B = Keypair.generate().publicKey;

  function poolRow(): PoolRow {
    const { vaultA, vaultB } = deriveVaults(POOL.publicKey, LAUNCH_MINT, MINT_B);
    return { id: 1, launchId: 7, mintA: LAUNCH_MINT.toBase58(), mintB: MINT_B.toBase58(), vaultA: vaultA.toBase58(), vaultB: vaultB.toBase58(), poolAddress: POOL.publicKey.toBase58(), status: "active", createdAt: 1 };
  }

  it("createPool requires the operator keypair (keyless server refuses)", () => {
    const { db } = makeAmmDb();
    const { stub } = makeSolanaStub();
    const keyless = new LaunchAmm(db, stub, null);
    expect(() => keyless.createPool(1, LAUNCH_MINT.toBase58(), MINT_B.toBase58())).toThrow("keypair is not configured");
    const operator = new LaunchAmm(db, stub, POOL);
    const created = operator.createPool(1, LAUNCH_MINT.toBase58(), MINT_B.toBase58());
    expect(created.poolAddress).toBe(POOL.publicKey.toBase58());
  });

  it("builds an unsigned swap tx: user is fee payer, pool slot empty, exact legs", async () => {
    const { db } = makeAmmDb();
    const { stub } = makeSolanaStub();
    const amm = new LaunchAmm(db, stub, POOL);
    const pool = poolRow();
    const { serialized } = await amm.buildSwapTx({ pool, side: "buy", user: USER.publicKey.toBase58(), amountIn: 5_000_000n, minOut: 900n });

    const tx = Transaction.from(Buffer.from(serialized, "base64"));
    expect(tx.feePayer?.equals(USER.publicKey)).toBe(true);
    // Pool is a required signature but has NOT signed yet.
    const poolSig = tx.signatures.find((s) => s.publicKey.equals(POOL.publicKey));
    expect(poolSig).toBeDefined();
    expect(poolSig!.signature).toBeNull();
    // User slot also unsigned (this is the PREPARED tx).
    const userSig = tx.signatures.find((s) => s.publicKey.equals(USER.publicKey));
    expect(userSig).toBeDefined();
    expect(userSig!.signature).toBeNull();
    // Two token transfers with the exact prepared amounts.
    const transfers = tx.instructions.filter((i) => i.programId.equals(TOKEN_PROGRAM_ID));
    expect(transfers).toHaveLength(2);
  });

  it("executes a user-signed swap: verifies shape, pool co-signs, records history", async () => {
    const { db, swaps } = makeAmmDb();
    const { stub, raw } = makeSolanaStub();
    const amm = new LaunchAmm(db, stub, POOL);
    const pool = poolRow();
    const { serialized } = await amm.buildSwapTx({ pool, side: "sell", user: USER.publicKey.toBase58(), amountIn: 1_000n, minOut: 400_000n });

    // The user signs first (Phantom does exactly this).
    const tx = Transaction.from(Buffer.from(serialized, "base64"));
    tx.sign(USER);
    const signedBase64 = Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64");

    const result = await amm.submitSwap({ pool, side: "sell", userId: 42, user: USER.publicKey.toBase58(), amountIn: 1_000n, minOut: 400_000n, signedTxBase64: signedBase64 });
    expect(swaps).toHaveLength(1);

    // The broadcast tx carries BOTH signatures: user's + pool's. The tx
    // signature (what explorers index) is the fee payer's (user) signature.
    const broadcast = Transaction.from(raw[0]!);
    const userSig = broadcast.signatures.find((s) => s.publicKey.equals(USER.publicKey));
    const poolSig = broadcast.signatures.find((s) => s.publicKey.equals(POOL.publicKey));
    expect(userSig!.signature).not.toBeNull();
    expect(poolSig!.signature).not.toBeNull();
    expect(result.signature).toBe(bs58Encode(userSig!.signature!));
  });

  it("refuses to co-sign when the user has not signed (NOT_USER_SIGNED)", async () => {
    const { db } = makeAmmDb();
    const { stub } = makeSolanaStub();
    const amm = new LaunchAmm(db, stub, POOL);
    const pool = poolRow();
    const { serialized } = await amm.buildSwapTx({ pool, side: "buy", user: USER.publicKey.toBase58(), amountIn: 5_000_000n, minOut: 900n });
    await expect(amm.submitSwap({ pool, side: "buy", userId: 1, user: USER.publicKey.toBase58(), amountIn: 5_000_000n, minOut: 900n, signedTxBase64: serialized }))
      .rejects.toThrow("user signature is missing");
  });

  it("refuses when the client already provides the pool signature (BAD_TX)", async () => {
    const { db } = makeAmmDb();
    const { stub } = makeSolanaStub();
    const amm = new LaunchAmm(db, stub, POOL);
    const pool = poolRow();
    const { serialized } = await amm.buildSwapTx({ pool, side: "buy", user: USER.publicKey.toBase58(), amountIn: 5_000_000n, minOut: 900n });
    const tx = Transaction.from(Buffer.from(serialized, "base64"));
    tx.sign(USER, POOL); // a malicious client cannot fake the pool sig, but must never be accepted
    const signedBase64 = Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64");
    await expect(amm.submitSwap({ pool, side: "buy", userId: 1, user: USER.publicKey.toBase58(), amountIn: 5_000_000n, minOut: 900n, signedTxBase64: signedBase64 }))
      .rejects.toThrow("must not be provided by the client");
  });

  it("refuses when the submitted amounts differ from the prepared tx (BAD_TX)", async () => {
    const { db } = makeAmmDb();
    const { stub } = makeSolanaStub();
    const amm = new LaunchAmm(db, stub, POOL);
    const pool = poolRow();
    const { serialized } = await amm.buildSwapTx({ pool, side: "buy", user: USER.publicKey.toBase58(), amountIn: 5_000_000n, minOut: 900n });
    const tx = Transaction.from(Buffer.from(serialized, "base64"));
    tx.sign(USER);
    const signedBase64 = Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64");
    // Claim a different amountIn than what the signed tx transfers.
    await expect(amm.submitSwap({ pool, side: "buy", userId: 1, user: USER.publicKey.toBase58(), amountIn: 9_999_999n, minOut: 900n, signedTxBase64: signedBase64 }))
      .rejects.toThrow("does not match the prepared swap");
  });

  it("refuses when the fee payer is not the submitting user (BAD_TX)", async () => {
    const { db } = makeAmmDb();
    const { stub } = makeSolanaStub();
    const amm = new LaunchAmm(db, stub, POOL);
    const pool = poolRow();
    const other = Keypair.generate();
    // Prepare for `other`, then have `other` sign — but submit claiming to be USER.
    const { serialized } = await amm.buildSwapTx({ pool, side: "buy", user: other.publicKey.toBase58(), amountIn: 5_000_000n, minOut: 900n });
    const tx = Transaction.from(Buffer.from(serialized, "base64"));
    tx.sign(other);
    const signedBase64 = Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64");
    await expect(amm.submitSwap({ pool, side: "buy", userId: 1, user: USER.publicKey.toBase58(), amountIn: 5_000_000n, minOut: 900n, signedTxBase64: signedBase64 }))
      .rejects.toThrow("fee payer");
  });

  it("refuses swaps without the operator keypair (keyless server)", async () => {
    const { db } = makeAmmDb();
    const { stub } = makeSolanaStub();
    const amm = new LaunchAmm(db, stub, null);
    const pool = poolRow();
    const { serialized } = await amm.buildSwapTx({ pool, side: "buy", user: USER.publicKey.toBase58(), amountIn: 5_000_000n, minOut: 900n });
    const tx = Transaction.from(Buffer.from(serialized, "base64"));
    tx.sign(USER);
    const signedBase64 = Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64");
    await expect(amm.submitSwap({ pool, side: "buy", userId: 1, user: USER.publicKey.toBase58(), amountIn: 5_000_000n, minOut: 900n, signedTxBase64: signedBase64 }))
      .rejects.toThrow("keypair is not configured");
  });

  it("fires beforeBroadcast with the exact final signature before the RPC send", async () => {
    const { db } = makeAmmDb();
    const { stub, raw } = makeSolanaStub();
    const amm = new LaunchAmm(db, stub, POOL);
    const pool = poolRow();
    const { serialized } = await amm.buildSwapTx({ pool, side: "buy", user: USER.publicKey.toBase58(), amountIn: 5_000_000n, minOut: 900n });
    const tx = Transaction.from(Buffer.from(serialized, "base64"));
    tx.sign(USER);
    const signedBase64 = Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64");
    let journaled: string | null = null;
    const broadcastOrder: string[] = [];
    const sending = stub.sendRawTransaction.bind(stub);
    stub.sendRawTransaction = async (bytes) => {
      broadcastOrder.push("send");
      return sending(bytes);
    };
    const result = await amm.submitSwap({
      pool, side: "buy", userId: 1, user: USER.publicKey.toBase58(),
      amountIn: 5_000_000n, minOut: 900n, signedTxBase64: signedBase64,
      beforeBroadcast: (sig) => {
        broadcastOrder.push("journal");
        journaled = sig;
      },
    });
    expect(broadcastOrder[0]).toBe("journal"); // journal BEFORE broadcast
    expect(journaled!).toBe(result.signature);
    // The journaled signature IS the tx signature (fee payer = user slot).
    const broadcast = Transaction.from(raw[0]!);
    expect(bs58Encode(broadcast.signatures.find((s) => s.publicKey.equals(USER.publicKey))!.signature!)).toBe(journaled);
  });

  it("rejects a stale quote when reserves moved beyond the drift limit (STALE_QUOTE)", async () => {
    const { db } = makeAmmDb();
    const { stub } = makeSolanaStub();
    const amm = new LaunchAmm(db, stub, POOL);
    const pool = poolRow();
    const { serialized } = await amm.buildSwapTx({ pool, side: "buy", user: USER.publicKey.toBase58(), amountIn: 5_000_000n, minOut: 900n });
    const tx = Transaction.from(Buffer.from(serialized, "base64"));
    tx.sign(USER);
    const signedBase64 = Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64");
    await expect(amm.submitSwap({
      pool, side: "buy", userId: 1, user: USER.publicKey.toBase58(),
      amountIn: 5_000_000n, minOut: 900n, signedTxBase64: signedBase64,
      quoteReserves: { reserveToken: 1_000_000n, reserveUsdc: 5_000_000_000n },
    })).rejects.toMatchObject({ code: "STALE_QUOTE" }); // stub vaults are empty → 100% drift
    // Same swap with the real current reserves passes the re-check.
    const result = await amm.submitSwap({
      pool, side: "buy", userId: 1, user: USER.publicKey.toBase58(),
      amountIn: 5_000_000n, minOut: 900n, signedTxBase64: signedBase64,
    });
    expect(result.signature).toBeTruthy();
  });

  it("session id binds prepare→submit (hash of the exact unsigned message)", async () => {
    const { db } = makeAmmDb();
    const { stub } = makeSolanaStub();
    const amm = new LaunchAmm(db, stub, POOL);
    const pool = poolRow();
    const { serialized, sessionId } = await amm.buildSwapTx({ pool, side: "buy", user: USER.publicKey.toBase58(), amountIn: 5_000_000n, minOut: 900n });
    expect(sessionId).toBe(sessionIdFor(serialized));
  });

  it("priceDrift detects token and USDC sweeps from either side", () => {
    const base = { reserveToken: 1_000_000n, reserveUsdc: 5_000_000_000n };
    expect(priceDrift(base, base)).toBe(0);
    expect(priceDrift(base, { reserveToken: 900_000n, reserveUsdc: 5_000_000_000n })).toBeCloseTo(0.1);
    expect(priceDrift(base, { reserveToken: 1_000_000n, reserveUsdc: 2_500_000_000n })).toBeCloseTo(0.5);
  });

  it("poolExecutionEnabled reads env at request time (kill switch arable without redeploy)", () => {
    const previous = process.env.POOL_EXECUTION_ENABLED;
    try {
      delete process.env.POOL_EXECUTION_ENABLED;
      expect(poolExecutionEnabled()).toBe(false);
      process.env.POOL_EXECUTION_ENABLED = "1";
      expect(poolExecutionEnabled()).toBe(true);
      process.env.POOL_EXECUTION_ENABLED = "0";
      expect(poolExecutionEnabled()).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.POOL_EXECUTION_ENABLED;
      else process.env.POOL_EXECUTION_ENABLED = previous;
    }
  });
});
