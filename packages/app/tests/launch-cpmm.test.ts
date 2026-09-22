/**
 * Offline tests for the Raydium CPMM post-graduation market (launch-cpmm.ts).
 *
 * No test touches the network: the Solana surface is a stub fed with REAL
 * CPMM accounts encoded through the SDK's own encoders, so reserve math,
 * quote parity with CurveCalculator and prepare/submit shape verification run
 * against byte-accurate on-chain account layouts.
 */

import { describe, expect, it, beforeEach } from "vitest";
import bs58 from "bs58";
import {
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
} from "@solana/web3.js";
import BN from "bn.js";
import {
  CpmmPoolInfoLayout,
  CpmmConfigInfoLayout,
  CurveCalculator,
  getPdaPoolAuthority,
  getCpmmPdaAmmConfigId,
  getCpmmPdaPoolId,
  getPdaVault,
  getPdaObservationId,
} from "@raydium-io/raydium-sdk-v2";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";

import {
  LaunchCpmm,
  CpmmError,
  CPMM_PROGRAM,
  CPMM_SWAP_BASE_IN_DISCRIMINATOR,
  deriveCpmmPoolId,
  effectiveReserves,
  quoteSwapPure,
  verifySwapInstruction,
  sessionIdFor,
  type CpmmLike,
  type CpmmDb,
} from "../src/trading/launch-cpmm.js";

// ── Account fixtures (SDK-encoded, byte-accurate) ────────────────────────

const configId = getCpmmPdaAmmConfigId(CPMM_PROGRAM, 0).publicKey;

function encodeConfig(over: Partial<{ tradeFeeRate: BN; protocolFeeRate: BN; fundFeeRate: BN; creatorFeeRate: BN }> = {}): Buffer {
  const buf = Buffer.alloc(CpmmConfigInfoLayout.span);
  CpmmConfigInfoLayout.encode({
    bump: 254,
    disableCreatePool: false,
    index: 0,
    tradeFeeRate: over.tradeFeeRate ?? new BN(2500), // 0.25%
    protocolFeeRate: over.protocolFeeRate ?? new BN(120000), // 12%
    fundFeeRate: over.fundFeeRate ?? new BN(0),
    createPoolFee: new BN(0),
    protocolOwner: Keypair.generate().publicKey,
    fundOwner: Keypair.generate().publicKey,
    creatorFeeRate: over.creatorFeeRate ?? new BN(0),
    creatorFeeShareRate: new BN(0),
    __extra: Buffer.alloc(14 * 8),
  }, buf);
  return buf;
}

function encodePool(over: Partial<{ mintA: PublicKey; status: number; feeOn: number; mintProgramB: PublicKey; protocolFeesA: BN; fundFeesA: BN; creatorFeesA: BN; protocolFeesB: BN; fundFeesB: BN; creatorFeesB: BN }> = {}) {
  const tokenMint = over.mintA ?? Keypair.generate().publicKey;
  // REAL mainnet orientation (verified 2026-09 against migrated pools):
  // LaunchLab migrations create the CPMM pool with WSOL as pool mintA.
  const { publicKey: poolId } = getCpmmPdaPoolId(CPMM_PROGRAM, configId, NATIVE_MINT, tokenMint);
  const vaultA = getPdaVault(CPMM_PROGRAM, poolId, NATIVE_MINT).publicKey;
  const vaultB = getPdaVault(CPMM_PROGRAM, poolId, tokenMint).publicKey;
  const observationId = getPdaObservationId(CPMM_PROGRAM, poolId).publicKey;
  const buf = Buffer.alloc(CpmmPoolInfoLayout.span);
  CpmmPoolInfoLayout.encode({
    bump: 253,
    status: over.status ?? 0,
    configId,
    poolCreator: Keypair.generate().publicKey,
    vaultA,
    vaultB,
    mintLp: Keypair.generate().publicKey,
    mintA: NATIVE_MINT,
    mintB: tokenMint,
    mintProgramA: TOKEN_PROGRAM_ID,
    mintProgramB: over.mintProgramB ?? TOKEN_PROGRAM_ID,
    observationId,
    lpDecimals: 9,
    mintDecimalA: 9,
    mintDecimalB: 6,
    lpAmount: new BN("1000000000000000"),
    protocolFeesMintA: over.protocolFeesA ?? new BN(0),
    protocolFeesMintB: over.protocolFeesB ?? new BN(0),
    fundFeesMintA: over.fundFeesA ?? new BN(0),
    fundFeesMintB: over.fundFeesB ?? new BN(0),
    openTime: new BN(0),
    epoch: new BN(0),
    feeOn: over.feeOn ?? 2, // OnlyTokenB = the token side in this orientation
    enableCreatorFee: false,
    creatorFeesMintA: over.creatorFeesA ?? new BN(0),
    creatorFeesMintB: over.creatorFeesB ?? new BN(0),
  }, buf);
  return { data: buf, poolId, vaultA, vaultB, mintA: tokenMint };
}

function tokenAccount(amount: bigint, mint: PublicKey, owner: PublicKey): { owner: PublicKey; lamports: number; data: Buffer } {
  const data = Buffer.alloc(165);
  data.writeBigUInt64LE(amount, 64);
  // mint @ 0, owner @ 32 (SPL token account layout) — decoders only need owner+amount here.
  mint.toBuffer().copy(data, 0);
  owner.toBuffer().copy(data, 32);
  return { owner: TOKEN_PROGRAM_ID, lamports: 1_000_000, data };
}

/** Classic SPL mint (82 bytes): decimals @44, initialized @45, no authorities. */
function classicMintData(decimals = 6): Buffer {
  const data = Buffer.alloc(82);
  data.writeUInt8(decimals, 44);
  data.writeUInt8(1, 45);
  return data;
}

// ── Stub Solana (no network) ─────────────────────────────────────────────

function stubSolana(accounts: Map<string, { owner: PublicKey; lamports: number; data: Buffer }>): CpmmLike & { sent: Uint8Array[] } {
  const sent: Uint8Array[] = [];
  return {
    sent,
    async getLatestBlockhash() {
      return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 12345 };
    },
    async getAccountInfo(address: PublicKey) {
      const acc = accounts.get(address.toBase58());
      return acc ? { owner: acc.owner, lamports: acc.lamports, data: acc.data } : null;
    },
    async sendRawTransaction(raw: Uint8Array) {
      sent.push(raw);
      return bs58.encode(Transaction.from(raw).signature!);
    },
    async confirmTransaction(_signature: string, _commitment?: string) {
      return { value: { err: null } };
    },
  };
}

// ── Stub DB ──────────────────────────────────────────────────────────────

function stubDb(): CpmmDb & { trades: any[] } {
  const trades: any[] = [];
  return {
    trades,
    recordLaunchLabTrade(row) {
      if (trades.some((t) => t.signature === row.signature)) return false;
      trades.push({ ...row, ts: row.ts ?? 1 });
      return true;
    },
    listUserLaunchLabTrades(userId, limit = 20) {
      return trades.filter((t) => t.userId === userId).slice(-limit).reverse() as any;
    },
  };
}

// ── Shared rig ───────────────────────────────────────────────────────────

const RATES = { tradeFeeRate: new BN(2500), protocolFeeRate: new BN(120000), fundFeeRate: new BN(0), creatorFeeRate: new BN(0) };

interface Rig {
  engine: LaunchCpmm;
  solana: ReturnType<typeof stubSolana>;
  db: ReturnType<typeof stubDb>;
  pool: ReturnType<typeof encodePool>;
  mintA: PublicKey;
  user: Keypair;
  vaultAAmount: bigint;
  vaultBAmount: bigint;
}

function buildRig(opts: Partial<{ realA: bigint; realB: bigint; feeOn: number; status: number; mintData: Buffer; mintProgram: PublicKey }> = {}): Rig {
  const accounts = new Map<string, { owner: PublicKey; lamports: number; data: Buffer }>();
  const pool = encodePool({ feeOn: opts.feeOn, status: opts.status, mintProgramB: opts.mintProgram });
  const config = encodeConfig();
  const mintA = pool.mintA;
  const vaultAAmount = opts.realA ?? 85_000_000_000n; // 85 SOL (pool side A = WSOL)
  const vaultBAmount = opts.realB ?? 500_000_000_000n; // 500k tokens (6 dec, side B)
  accounts.set(pool.poolId.toBase58(), { owner: CPMM_PROGRAM, lamports: 1_000_000, data: pool.data });
  accounts.set(configId.toBase58(), { owner: CPMM_PROGRAM, lamports: 1_000_000, data: config });
  accounts.set(mintA.toBase58(), { owner: opts.mintProgram ?? TOKEN_PROGRAM_ID, lamports: 1_000_000, data: opts.mintData ?? classicMintData(6) });
  accounts.set(pool.vaultA.toBase58(), tokenAccount(vaultAAmount, NATIVE_MINT, pool.poolId));
  accounts.set(pool.vaultB.toBase58(), tokenAccount(vaultBAmount, mintA, pool.poolId));
  const solana = stubSolana(accounts);
  const db = stubDb();
  const engine = new LaunchCpmm(solana, db);
  const user = Keypair.generate();
  return { engine, solana, db, pool, mintA, user, vaultAAmount, vaultBAmount };
}

let rig: Rig;
beforeEach(() => {
  rig = buildRig();
});

const SIDE_DEFAULT = "buy" as const;

describe("cpmm reserves and pure math", () => {
  it("effective reserves subtract accrued protocol/fund/creator fees", () => {
    const pool = CpmmPoolInfoLayout.decode(encodePool({
      protocolFeesA: new BN(1000), fundFeesA: new BN(2000), creatorFeesA: new BN(500),
      protocolFeesB: new BN(300), fundFeesB: new BN(400), creatorFeesB: new BN(200),
    }).data);
    const r = effectiveReserves(pool, 1_000_000_000n, 900_000_000n);
    // Token occupies pool side B in the real orientation → base = side B vault minus side B fees.
    expect(r.baseReserve).toBe(900_000_000n - 900n);
    expect(r.quoteReserve).toBe(1_000_000_000n - 3500n);
  });

  it("quote parity with CurveCalculator on the same inputs (buy)", () => {
    const { engine } = rig;
    const pool = CpmmPoolInfoLayout.decode(rig.pool.data);
    const reserves = effectiveReserves(pool, rig.vaultAAmount, rig.vaultBAmount);
    const amountIn = 1_000_000_000n; // 1 SOL
    const direct = CurveCalculator.swapBaseInput(
      new BN(amountIn.toString()),
      new BN(reserves.quoteReserve.toString()),
      new BN(reserves.baseReserve.toString()),
      RATES.tradeFeeRate, RATES.creatorFeeRate, RATES.protocolFeeRate, RATES.fundFeeRate,
      false, // feeOn OnlyTokenB = token side; buys spend SOL → creator fee not on input
    );
    const q = quoteSwapPure(pool, configAsInfo(), reserves, "buy", amountIn, 100);
    expect(q.amountOut).toBe(BigInt(direct.outputAmount.toString()));
  });

  it("quote parity with CurveCalculator (sell)", () => {
    const pool = CpmmPoolInfoLayout.decode(rig.pool.data);
    const reserves = effectiveReserves(pool, rig.vaultAAmount, rig.vaultBAmount);
    const amountIn = 25_000_000n; // 25 tokens
    const direct = CurveCalculator.swapBaseInput(
      new BN(amountIn.toString()),
      new BN(reserves.baseReserve.toString()),
      new BN(reserves.quoteReserve.toString()),
      RATES.tradeFeeRate, RATES.creatorFeeRate, RATES.protocolFeeRate, RATES.fundFeeRate,
      true, // feeOn OnlyTokenB = token side; sells spend the token → creator fee on input
    );
    const q = quoteSwapPure(pool, configAsInfo(), reserves, "sell", amountIn, 0);
    expect(q.amountOut).toBe(BigInt(direct.outputAmount.toString()));
    expect(q.minOut).toBe(q.amountOut);
  });

  it("slippage floor and validation", async () => {
    await expect(rig.engine.quote(rig.mintA.toBase58(), "buy", 1_000_000_000n, 5001)).rejects.toMatchObject({ code: "BAD_AMOUNT" });
    await expect(rig.engine.quote(rig.mintA.toBase58(), "buy", 0n, 100)).rejects.toMatchObject({ code: "BAD_AMOUNT" });
  });

  it("state exposes real reserves and pool addresses", async () => {
    const state = await rig.engine.state(rig.mintA.toBase58());
    expect(state.poolId).toBe(rig.pool.poolId.toBase58());
    expect(state.mintA).toBe(rig.mintA.toBase58());
    expect(state.mintB).toBe(NATIVE_MINT.toBase58());
    expect(state.baseReserve).toBe(rig.vaultBAmount.toString());
    expect(state.quoteReserve).toBe(rig.vaultAAmount.toString());
    expect(Number(state.priceBaseInQuote)).toBeCloseTo(Number(rig.vaultAAmount) / Number(rig.vaultBAmount) * 0.001, 12);
  });
});

describe("cpmm prepare/submit", () => {
  async function prepare(side: "buy" | "sell", amountIn: bigint) {
    const q = await rig.engine.quote(rig.mintA.toBase58(), side, amountIn, 100);
    const prepared = await rig.engine.prepareSwap({
      user: rig.user.publicKey.toBase58(), mintA: rig.mintA.toBase58(), side, amountIn, slippageBps: 100,
    });
    return { q, prepared };
  }

  it("buy: exactly one CPMM swap instruction, correct accounts and amounts", async () => {
    const { prepared } = await prepare("buy", 1_000_000_000n);
    expect(prepared.sessionId).toBe(sessionIdFor(prepared.serialized));
    const tx = Transaction.from(Buffer.from(prepared.serialized, "base64"));
    const swaps = tx.instructions.filter((i) => i.programId.equals(CPMM_PROGRAM));
    expect(swaps.length).toBe(1);
    const keys = swaps[0]!.keys;
    expect(keys[0]!.pubkey.equals(rig.user.publicKey)).toBe(true);
    expect(keys[0]!.isSigner).toBe(true);
    expect(keys[1]!.pubkey.equals(getPdaPoolAuthority(CPMM_PROGRAM).publicKey)).toBe(true);
    expect(keys[2]!.pubkey.equals(configId)).toBe(true);
    expect(keys[3]!.pubkey.equals(rig.pool.poolId)).toBe(true);
    expect(keys[4]!.pubkey.equals(getAssociatedTokenAddressSync(NATIVE_MINT, rig.user.publicKey))).toBe(true);
    expect(keys[5]!.pubkey.equals(getAssociatedTokenAddressSync(rig.mintA, rig.user.publicKey))).toBe(true);
    expect(swaps[0]!.data.subarray(0, 8).equals(CPMM_SWAP_BASE_IN_DISCRIMINATOR)).toBe(true);
    expect(swaps[0]!.data.readBigUInt64LE(8)).toBe(1_000_000_000n);
  });

  it("buy: wsol funding (transfer + sync) present before the swap", async () => {
    const { prepared } = await prepare("buy", 1_000_000_000n);
    const tx = Transaction.from(Buffer.from(prepared.serialized, "base64"));
    const sys = tx.instructions.filter((i) => i.programId.equals(SystemProgram.programId));
    expect(sys.length).toBe(1);
    expect(sys[0]!.data.readBigUInt64LE(4)).toBe(1_000_000_000n);
    const sync = tx.instructions.find((i) => i.programId.equals(TOKEN_PROGRAM_ID));
    expect(sync).toBeTruthy();
  });

  it("sell: input is the token ATA, output wsol; no SOL transfer", async () => {
    const { prepared } = await prepare("sell", 25_000_000n);
    const tx = Transaction.from(Buffer.from(prepared.serialized, "base64"));
    const sys = tx.instructions.filter((i) => i.programId.equals(SystemProgram.programId));
    expect(sys.length).toBe(0);
    const swaps = tx.instructions.filter((i) => i.programId.equals(CPMM_PROGRAM));
    const inAta = getAssociatedTokenAddressSync(rig.mintA, rig.user.publicKey);
    const outAta = getAssociatedTokenAddressSync(NATIVE_MINT, rig.user.publicKey);
    expect(swaps[0]!.keys[4]!.pubkey.equals(inAta)).toBe(true);
    expect(swaps[0]!.keys[5]!.pubkey.equals(outAta)).toBe(true);
  });

  it("submit: user-signed tx verifies and records the trade", async () => {
    const { q } = await prepare(SIDE_DEFAULT, 1_000_000_000n);
    const prepared = await rig.engine.prepareSwap({
      user: rig.user.publicKey.toBase58(), mintA: rig.mintA.toBase58(), side: SIDE_DEFAULT, amountIn: 1_000_000_000n, slippageBps: 100,
    });
    const tx = Transaction.from(Buffer.from(prepared.serialized, "base64"));
    tx.sign(rig.user);
    const signedB64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
    const result = await rig.engine.submitSwap({
      userId: 1, user: rig.user.publicKey.toBase58(), mintA: rig.mintA.toBase58(),
      side: SIDE_DEFAULT, amountIn: 1_000_000_000n, minOut: BigInt(q.minOut), signedTxBase64: signedB64,
    });
    expect(result.signature).toBeTruthy();
    expect(result.recorded).toBe(true);
    expect(rig.db.trades.length).toBe(1);
    expect(rig.db.trades[0]!.side).toBe("buy");
  });

  it("submit rejects tampered amountIn", async () => {
    const { q } = await prepare(SIDE_DEFAULT, 1_000_000_000n);
    const prepared = await rig.engine.prepareSwap({
      user: rig.user.publicKey.toBase58(), mintA: rig.mintA.toBase58(), side: SIDE_DEFAULT, amountIn: 1_000_000_000n, slippageBps: 100,
    });
    const tx = Transaction.from(Buffer.from(prepared.serialized, "base64"));
    const swap = tx.instructions.find((i) => i.programId.equals(CPMM_PROGRAM))!;
    const evil = Buffer.from(swap.data);
    evil.writeBigUInt64LE(999_000_000_000n, 8);
    swap.data = evil;
    tx.sign(rig.user);
    const signedB64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
    await expect(rig.engine.submitSwap({
      userId: 1, user: rig.user.publicKey.toBase58(), mintA: rig.mintA.toBase58(),
      side: SIDE_DEFAULT, amountIn: 1_000_000_000n, minOut: BigInt(q.minOut), signedTxBase64: signedB64,
    })).rejects.toMatchObject({ code: "SHAPE_MISMATCH" });
    expect(rig.db.trades.length).toBe(0);
  });

  it("submit rejects tampered minOut", async () => {
    const { prepared } = await prepare(SIDE_DEFAULT, 1_000_000_000n);
    const tx = Transaction.from(Buffer.from(prepared.serialized, "base64"));
    const swap = tx.instructions.find((i) => i.programId.equals(CPMM_PROGRAM))!;
    const evil = Buffer.from(swap.data);
    evil.writeBigUInt64LE(1n, 16);
    swap.data = evil;
    tx.sign(rig.user);
    const signedB64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
    await expect(rig.engine.submitSwap({
      userId: 1, user: rig.user.publicKey.toBase58(), mintA: rig.mintA.toBase58(),
      side: SIDE_DEFAULT, amountIn: 1_000_000_000n, minOut: 1_000_000n, signedTxBase64: signedB64,
    })).rejects.toMatchObject({ code: "SHAPE_MISMATCH" });
  });

  it("submit rejects missing user signature and extra client signatures", async () => {
    const { prepared } = await prepare(SIDE_DEFAULT, 1_000_000_000n);
    const tx = Transaction.from(Buffer.from(prepared.serialized, "base64"));
    const signedB64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
    await expect(rig.engine.submitSwap({
      userId: 1, user: rig.user.publicKey.toBase58(), mintA: rig.mintA.toBase58(),
      side: SIDE_DEFAULT, amountIn: 1_000_000_000n, minOut: 1n, signedTxBase64: signedB64,
    })).rejects.toMatchObject({ code: "NOT_USER_SIGNED" });

    const evil = Keypair.generate();
    const tx2 = Transaction.from(Buffer.from(prepared.serialized, "base64"));
    tx2.add(SystemProgram.transfer({ fromPubkey: evil.publicKey, toPubkey: rig.user.publicKey, lamports: 1 }));
    tx2.sign(rig.user, evil);
    const signed2 = tx2.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
    await expect(rig.engine.submitSwap({
      userId: 1, user: rig.user.publicKey.toBase58(), mintA: rig.mintA.toBase58(),
      side: SIDE_DEFAULT, amountIn: 1_000_000_000n, minOut: 1n, signedTxBase64: signed2,
    })).rejects.toMatchObject({ code: "BAD_TX" });
  });

  it("submit rejects an account substitution (other vault)", async () => {
    const { prepared } = await prepare(SIDE_DEFAULT, 1_000_000_000n);
    const tx = Transaction.from(Buffer.from(prepared.serialized, "base64"));
    const swap = tx.instructions.find((i) => i.programId.equals(CPMM_PROGRAM))!;
    swap.keys[7] = { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }; // output vault swapped
    tx.sign(rig.user);
    const signedB64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
    await expect(rig.engine.submitSwap({
      userId: 1, user: rig.user.publicKey.toBase58(), mintA: rig.mintA.toBase58(),
      side: SIDE_DEFAULT, amountIn: 1_000_000_000n, minOut: 1n, signedTxBase64: signedB64,
    })).rejects.toMatchObject({ code: "SHAPE_MISMATCH" });
  });

  it("direct verifier: wrong discriminator/length rejected", () => {
    const mint = Keypair.generate().publicKey;
    const e = {
      programId: CPMM_PROGRAM,
      payer: Keypair.generate().publicKey,
      authority: getPdaPoolAuthority(CPMM_PROGRAM).publicKey,
      configId,
      poolId: Keypair.generate().publicKey,
      userInputAccount: Keypair.generate().publicKey,
      userOutputAccount: Keypair.generate().publicKey,
      inputVault: Keypair.generate().publicKey,
      outputVault: Keypair.generate().publicKey,
      inputTokenProgram: TOKEN_PROGRAM_ID,
      outputTokenProgram: TOKEN_PROGRAM_ID,
      inputMint: mint,
      outputMint: NATIVE_MINT,
      observationId: getPdaObservationId(CPMM_PROGRAM, Keypair.generate().publicKey).publicKey,
      amountIn: 5n,
      amountOutMin: 1n,
    };
    const good = Buffer.alloc(24);
    CPMM_SWAP_BASE_IN_DISCRIMINATOR.copy(good, 0);
    good.writeBigUInt64LE(5n, 8);
    good.writeBigUInt64LE(1n, 16);
    const keys = [
      { pubkey: e.payer, isSigner: true, isWritable: true },
      { pubkey: e.authority, isSigner: false, isWritable: false },
      { pubkey: e.configId, isSigner: false, isWritable: false },
      { pubkey: e.poolId, isSigner: false, isWritable: true },
      { pubkey: e.userInputAccount, isSigner: false, isWritable: true },
      { pubkey: e.userOutputAccount, isSigner: false, isWritable: true },
      { pubkey: e.inputVault, isSigner: false, isWritable: true },
      { pubkey: e.outputVault, isSigner: false, isWritable: true },
      { pubkey: e.inputTokenProgram, isSigner: false, isWritable: false },
      { pubkey: e.outputTokenProgram, isSigner: false, isWritable: false },
      { pubkey: e.inputMint, isSigner: false, isWritable: false },
      { pubkey: e.outputMint, isSigner: false, isWritable: false },
      { pubkey: e.observationId, isSigner: false, isWritable: true },
    ];
    verifySwapInstruction(new TransactionInstruction({ keys, programId: CPMM_PROGRAM, data: good }), e);
    const badDisc = Buffer.from(good);
    badDisc[0] = 0xff;
    expect(() => verifySwapInstruction(new TransactionInstruction({ keys, programId: CPMM_PROGRAM, data: badDisc }), e)).toThrow(CpmmError);
    expect(() => verifySwapInstruction(new TransactionInstruction({ keys, programId: CPMM_PROGRAM, data: good.subarray(0, 20) }), e)).toThrow(CpmmError);
  });
});

describe("token-2022 mint guard", () => {
  /** Token-2022 mint TLV, validated against @solana/spl-token's own unpackMint. */
  function token2022MintData(opts: { transferFeeBps?: number; mintAuthority?: boolean } = {}): Buffer {
    const data = Buffer.alloc(278);
    if (opts.mintAuthority) {
      data.writeUInt32LE(1, 0);
      Keypair.generate().publicKey.toBuffer().copy(data, 4);
    } else {
      data.writeUInt32LE(0, 0); // mintAuthorityOption = none
    }
    data.writeBigUInt64LE(1_000_000n, 36); // supply
    data.writeUInt8(6, 44); // decimals
    data.writeUInt8(1, 45); // isInitialized
    data.writeUInt8(1, 165); // AccountType::Mint
    if (opts.transferFeeBps !== undefined) {
      data.writeUInt16LE(1, 166); // extension type TransferFeeConfig
      data.writeUInt16LE(108, 168); // extension length
      data.writeUInt16LE(opts.transferFeeBps, 170 + 88); // newerTransferFee bps
    }
    return data;
  }

  it("accepts token-2022 mints without transfer fee or live authorities", async () => {
    const r = buildRig({ mintData: token2022MintData(), mintProgram: TOKEN_2022_PROGRAM_ID });
    const state = await r.engine.state(r.mintA.toBase58());
    expect(state.mintProgramA).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
  });

  it("rejects transfer-fee mints before any quote is produced", async () => {
    const r = buildRig({ mintData: token2022MintData({ transferFeeBps: 500 }), mintProgram: TOKEN_2022_PROGRAM_ID });
    await expect(r.engine.state(r.mintA.toBase58())).rejects.toMatchObject({ code: "BAD_MINT" });
    await expect(r.engine.quote(r.mintA.toBase58(), "buy", 1_000_000_000n, 100)).rejects.toMatchObject({ code: "BAD_MINT" });
    await expect(r.engine.prepareSwap({ user: r.user.publicKey.toBase58(), mintA: r.mintA.toBase58(), side: "buy", amountIn: 1_000_000_000n, slippageBps: 100 })).rejects.toMatchObject({ code: "BAD_MINT" });
  });

  it("rejects mints with an active mint authority (supply can change)", async () => {
    const r = buildRig({ mintData: token2022MintData({ mintAuthority: true }), mintProgram: TOKEN_2022_PROGRAM_ID });
    await expect(r.engine.state(r.mintA.toBase58())).rejects.toMatchObject({ code: "BAD_MINT" });
  });

  it("never consults the guard for classic SPL mints", async () => {
    const r = buildRig();
    await expect(r.engine.state(r.mintA.toBase58())).resolves.toBeTruthy();
  });
});

describe("cpmm failure modes", () => {
  it("pool not migrated → POOL_NOT_FOUND (no invented state)", async () => {
    await expect(rig.engine.state(Keypair.generate().publicKey.toBase58())).rejects.toMatchObject({ code: "POOL_NOT_FOUND" });
  });

  it("deposit and withdrawal pauses do not disable swaps", async () => {
    const paused = buildRig({ status: 3 });
    const quote = await paused.engine.quote(paused.mintA.toBase58(), "buy", 1_000_000_000n, 100);
    expect(BigInt(quote.amountOut)).toBeGreaterThan(0n);
  });

  it("rejects amounts outside Solana u64 before building instructions", async () => {
    await expect(rig.engine.quote(rig.mintA.toBase58(), "buy", 1n << 64n, 100)).rejects.toMatchObject({ code: "BAD_AMOUNT" });
  });

  it("paused pool → POOL_DISABLED on prepare", async () => {
    const paused = buildRig({ status: 4 });
    await expect(paused.engine.prepareSwap({
      user: paused.user.publicKey.toBase58(), mintA: paused.mintA.toBase58(), side: "buy", amountIn: 1_000_000_000n, slippageBps: 100,
    })).rejects.toMatchObject({ code: "POOL_DISABLED" });
  });

  it("failed confirmation → CONFIRMATION_FAILED, nothing recorded", async () => {
    const failing = buildRig();
    (failing.solana as any).confirmTransaction = async () => ({ value: { err: "AccountInUse" } });
    const q = await failing.engine.quote(failing.mintA.toBase58(), "buy", 1_000_000_000n, 100);
    const prepared = await failing.engine.prepareSwap({
      user: failing.user.publicKey.toBase58(), mintA: failing.mintA.toBase58(), side: "buy", amountIn: 1_000_000_000n, slippageBps: 100,
    });
    const tx = Transaction.from(Buffer.from(prepared.serialized, "base64"));
    tx.sign(failing.user);
    const signedB64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
    await expect(failing.engine.submitSwap({
      userId: 1, user: failing.user.publicKey.toBase58(), mintA: failing.mintA.toBase58(),
      side: "buy", amountIn: 1_000_000_000n, minOut: BigInt(q.minOut), signedTxBase64: signedB64,
    })).rejects.toMatchObject({ code: "CONFIRMATION_FAILED" });
    expect(failing.db.trades.length).toBe(0);
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────

import { ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { TransactionInstruction } from "@solana/web3.js";

function configAsInfo() {
  return {
    tradeFeeRate: RATES.tradeFeeRate,
    protocolFeeRate: RATES.protocolFeeRate,
    fundFeeRate: RATES.fundFeeRate,
    creatorFeeRate: RATES.creatorFeeRate,
  } as any;
}
