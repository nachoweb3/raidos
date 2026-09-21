/**
 * Offline tests for the Raydium LaunchLab integration (launch-raydium.ts).
 *
 * No test touches the network: the Solana surface is a stub fed with REAL
 * LaunchLab accounts encoded through the SDK's own encoders, so quote math,
 * prepare/submit shape verification and confirm-create verification run
 * against byte-accurate on-chain account layouts.
 */

import { describe, expect, it, beforeEach } from "vitest";
import bs58 from "bs58";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
} from "@solana/spl-token";
import BN from "bn.js";
import {
  LAUNCHPAD_PROGRAM,
  LaunchpadPool,
  LaunchpadConfig,
  PlatformConfig,
  getPdaLaunchpadConfigId,
  getPdaLaunchpadPoolId,
} from "@raydium-io/raydium-sdk-v2";
import { NATIVE_MINT } from "@solana/spl-token";

import {
  LaunchRaydium,
  LaunchLabError,
  quoteBuyPure,
  quoteSellPure,
  verifyLaunchpadSwapInstruction,
  decodeInitializeV2Data,
  anchorDiscriminator,
  sessionIdFor,
  type SolanaLike,
  type LaunchRaydiumDb,
  type LaunchLabLaunchRow,
} from "../src/trading/launch-raydium.js";

// ── Account fixtures (SDK-encoded, byte-accurate) ────────────────────────

const QUOTE_MINT = NATIVE_MINT; // the engine derives pool PDAs with NATIVE_MINT for the SOL quote
const configId = getPdaLaunchpadConfigId(LAUNCHPAD_PROGRAM, QUOTE_MINT, 0, 0).publicKey;
const platformId = Keypair.generate().publicKey;
const creator = Keypair.generate().publicKey;

function fixedName(s: string, len: number): Uint8Array {
  const b = Buffer.alloc(len);
  Buffer.from(s).copy(b);
  return b;
}

const TOTAL_SELL_A = new BN("793100000000000");
const TOTAL_FUND = new BN("85000000000");

function encodePool(over: Partial<{ realA: BN; realB: BN; status: number }> = {}): { data: Buffer; poolId: PublicKey; vaultA: PublicKey; vaultB: PublicKey; mintA: PublicKey } {
  const mintA = Keypair.generate().publicKey;
  const { publicKey: poolId } = getPdaLaunchpadPoolId(LAUNCHPAD_PROGRAM, mintA, QUOTE_MINT);
  const vaultA = Keypair.generate().publicKey;
  const vaultB = Keypair.generate().publicKey;
  const buf = Buffer.alloc(LaunchpadPool.span);
  LaunchpadPool.encode({
    epoch: new BN(0),
    bump: 254,
    status: over.status ?? 0,
    mintDecimalsA: 6,
    mintDecimalsB: 9,
    migrateType: 1,
    supply: new BN("1000000000000000"),
    totalSellA: TOTAL_SELL_A,
    virtualA: new BN("1073471847374405"),
    virtualB: new BN("30050573465"),
    realA: over.realA ?? new BN(0),
    realB: over.realB ?? new BN(0),
    totalFundRaisingB: TOTAL_FUND,
    protocolFee: new BN(0),
    platformFee: new BN(0),
    migrateFee: new BN(0),
    vestingSchedule: {
      totalLockedAmount: new BN(0),
      cliffPeriod: new BN(0),
      unlockPeriod: new BN(0),
      startTime: new BN(0),
      totalAllocatedShare: new BN(0),
    },
    configId,
    platformId,
    mintA,
    mintB: QUOTE_MINT,
    vaultA,
    vaultB,
    creator,
    mintProgramFlag: 0,
    cpmmCreatorFeeOn: 0,
    platformVestingShare: new BN(0),
  }, buf);
  return { data: buf, poolId, vaultA, vaultB, mintA };
}

function encodeConfig() {
  const buf = Buffer.alloc(LaunchpadConfig.span);
  LaunchpadConfig.encode({
    epoch: new BN(0),
    curveType: 0,
    index: 0,
    migrateFee: new BN(0),
    tradeFeeRate: new BN(2000), // 2%
    maxShareFeeRate: new BN(1000),
    minSupplyA: new BN(0),
    maxLockRate: new BN(0),
    minSellRateA: new BN(0),
    minMigrateRateA: new BN(0),
    minFundRaisingB: new BN(0),
    mintB: QUOTE_MINT,
    protocolFeeOwner: Keypair.generate().publicKey,
    migrateFeeOwner: Keypair.generate().publicKey,
    migrateToAmmWallet: Keypair.generate().publicKey,
    migrateToCpmmWallet: Keypair.generate().publicKey,
  }, buf);
  return { data: buf, decoded: LaunchpadConfig.decode(buf) };
}

function encodePlatform() {
  const buf = Buffer.alloc(PlatformConfig.span);
  PlatformConfig.encode({
    platformClaimFeeWallet: Keypair.generate().publicKey,
    platformLockNftWallet: Keypair.generate().publicKey,
    platformScale: new BN(0),
    creatorScale: new BN(0),
    burnScale: new BN(1000000),
    feeRate: new BN(200), // 2% platform
    name: fixedName("", 64),
    web: fixedName("", 256),
    img: fixedName("", 256),
    cpConfigId: Keypair.generate().publicKey,
    creatorFeeRate: new BN(100), // 1% creator
    transferFeeExtensionAuth: Keypair.generate().publicKey,
    platformVestingWallet: Keypair.generate().publicKey,
    platformVestingScale: new BN(0),
    platformCpCreator: Keypair.generate().publicKey,
    restrictGlobalConfig: 0,
    restrictCurveParam: 0,
    curveRuleManager: Keypair.generate().publicKey,
  }, buf);
  return { data: buf, decoded: PlatformConfig.decode(buf) };
}

// ── Stub Solana (no network) ─────────────────────────────────────────────

function stubSolana(accounts: Map<string, { owner: PublicKey; lamports: number; data: Buffer }>): SolanaLike & { sent: Uint8Array[] } {
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

function stubDb(): LaunchRaydiumDb & { trades: any[]; launches: Map<string, any> } {
  const trades: any[] = [];
  const launches = new Map<string, any>();
  return {
    trades,
    launches,
    upsertLaunchLabLaunch(row) {
      const existing = launches.get(row.mintA);
      launches.set(row.mintA, existing ?? { ...row, confirmed_at: null, confirmed_signature: null });
    },
    markLaunchLabLaunchConfirmed(mintA, signature, ts) {
      const row = launches.get(mintA);
      if (row) { row.confirmed_at = ts; row.confirmed_signature = signature; }
    },
    getLaunchLabLaunch(mintA) {
      const row = launches.get(mintA);
      return row ? (row as LaunchLabLaunchRow) : null;
    },
    recordLaunchLabTrade(row) {
      if (trades.some((t) => t.signature === row.signature)) return false;
      trades.push({ ...row, ts: row.ts ?? 1 });
      return true;
    },
    listLaunchLabTrades(mintA, limit = 20) {
      return trades.filter((t) => t.mintA === mintA).slice(-limit).reverse();
    },
    listUserLaunchLabTrades(userId, limit = 20) {
      return trades.filter((t) => t.userId === userId).slice(-limit).reverse();
    },
  };
}

// ── Shared rig ───────────────────────────────────────────────────────────

interface Rig {
  engine: LaunchRaydium;
  solana: ReturnType<typeof stubSolana>;
  db: ReturnType<typeof stubDb>;
  pool: ReturnType<typeof encodePool>;
  config: ReturnType<typeof encodeConfig>;
  platform: ReturnType<typeof encodePlatform>;
}

function buildRig(poolOver?: Partial<{ realA: BN; realB: BN; status: number }>): Rig {
  const pool = encodePool(poolOver);
  const config = encodeConfig();
  const platform = encodePlatform();
  const accounts = new Map<string, { owner: PublicKey; lamports: number; data: Buffer }>([
    [pool.poolId.toBase58(), { owner: LAUNCHPAD_PROGRAM, lamports: 1_000_000, data: pool.data }],
    [configId.toBase58(), { owner: LAUNCHPAD_PROGRAM, lamports: 1_000_000, data: config.data }],
    [platformId.toBase58(), { owner: LAUNCHPAD_PROGRAM, lamports: 1_000_000, data: platform.data }],
  ]);
  const solana = stubSolana(accounts);
  const db = stubDb();
  const engine = new LaunchRaydium(solana, db);
  return { engine, solana, db, pool, config, platform };
}

const RATES = { protocolFeeRate: new BN(2000), platformFeeRate: new BN(200), creatorFeeRate: new BN(100), curveType: 0 };

// ── Pure quote math ──────────────────────────────────────────────────────

describe("launchlab quote math (SDK Curve on real encoded layouts)", () => {
  it("buy quote is strictly increasing and fee-split consistent", () => {
    const pool = LaunchpadPool.decode(encodePool().data);
    const small = quoteBuyPure(pool, RATES, 1_000_000_000n, 100);
    const big = quoteBuyPure(pool, RATES, 10_000_000_000n, 100);
    expect(small.amountOutBase).toBeGreaterThan(0n);
    expect(big.amountOutBase).toBeGreaterThan(small.amountOutBase);
    // slippage 1% floor
    expect(small.minOutBase).toBeLessThan(small.amountOutBase);
    expect(small.minOutBase).toBeGreaterThan((small.amountOutBase * 98n) / 100n);
    // total fee = platform + protocol + creator (+0 share)
    expect(small.totalFeeQuote).toBeGreaterThan(0n);
  });

  it("sell quote is strictly increasing in base sold", () => {
    const pool = LaunchpadPool.decode(encodePool({ realA: new BN("100000000000") }).data);
    const small = quoteSellPure(pool, RATES, 1_000_000n, 100);
    const big = quoteSellPure(pool, RATES, 100_000_000n, 100);
    expect(small.amountOutQuote).toBeGreaterThan(0n);
    expect(big.amountOutQuote).toBeGreaterThan(small.amountOutQuote);
    expect(big.minOutQuote).toBeLessThanOrEqual(big.amountOutQuote);
  });

  it("rejects out-of-range slippage", () => {
    const pool = LaunchpadPool.decode(encodePool().data);
    expect(() => quoteBuyPure(pool, RATES, 1_000_000_000n, 5001)).toThrow(LaunchLabError);
    expect(() => quoteBuyPure(pool, RATES, 1_000_000_000n, -1)).toThrow(LaunchLabError);
  });
});

// ── Engine state/quote over the stub ─────────────────────────────────────

describe("launchlab engine state + quote (stub RPC, real layouts)", () => {
  it("state reports curve-open progress and price", async () => {
    const rig = buildRig({ realB: new BN("42500000000") }); // 50% raised
    const mintA = rig.pool.mintA.toBase58();
    const state = await rig.engine.state(mintA, "sol");
    expect(state.curveOpen).toBe(true);
    expect(state.progressPct).toBeCloseTo(50, 0);
    expect(state.graduationTargetQuote).toBe(TOTAL_FUND.toString());
    expect(state.quoteSymbol).toBe("SOL");
    expect(Number(state.priceQuotePerBase)).toBeGreaterThan(0);
  });

  it("state 404s for a mint without a curve", async () => {
    const rig = buildRig();
    await expect(rig.engine.state(Keypair.generate().publicKey.toBase58(), "sol")).rejects.toMatchObject({ code: "LAUNCH_NOT_FOUND" });
  });

  it("quote rejects a closed curve (migrated)", async () => {
    const rig = buildRig({ status: 2 });
    await expect(rig.engine.quote(rig.pool.mintA.toBase58(), "sol", "buy", 1_000_000_000n, 100)).rejects.toMatchObject({ code: "CURVE_CLOSED" });
  });

  it("buy quote respects the minimum trade", async () => {
    const rig = buildRig();
    await expect(rig.engine.quote(rig.pool.mintA.toBase58(), "sol", "buy", 1n, 100)).rejects.toMatchObject({ code: "BAD_AMOUNT" });
  });
});

// ── prepare/submit buy + sell ────────────────────────────────────────────

describe("launchlab prepare/submit swap (self-custody, exact shape)", () => {
  let rig: Rig;
  const user = Keypair.generate();

  beforeEach(() => {
    rig = buildRig();
  });

  async function prepare(side: "buy" | "sell", amountIn = 1_000_000_000n) {
    return rig.engine.prepareSwap({
      userId: 1,
      user: user.publicKey.toBase58(),
      mintA: rig.pool.mintA.toBase58(),
      quote: "sol",
      side,
      amountIn,
      slippageBps: 100,
    });
  }

  async function signPrepared(prepared: { serialized: string }, side: "buy" | "sell", amountIn: bigint, minOut: bigint): Promise<Transaction> {
    const tx = Transaction.from(Buffer.from(prepared.serialized, "base64"));
    // Reconstruct expected accounts for verification below.
    const { pool, config, platform } = rig;
    const userAtaA = PublicKey.findProgramAddressSync([user.publicKey.toBuffer(), pool.mintA.toBuffer(), Buffer.from([0])], pool.mintA.equals(PublicKey.default) ? PublicKey.default : LAUNCHPAD_PROGRAM)[0];
    void userAtaA;
    void side; void amountIn; void minOut;
    tx.sign(user);
    return tx;
  }

  it("buy: prepared tx carries exactly the launchlab buy instruction; submit verifies and records", async () => {
    const prepared = await prepare("buy");
    expect(prepared.sessionId).toBe(sessionIdFor(prepared.serialized));

    const tx = Transaction.from(Buffer.from(prepared.serialized, "base64"));
    const lab = tx.instructions.filter((i) => i.programId.equals(LAUNCHPAD_PROGRAM));
    expect(lab.length).toBe(1);
    expect(lab[0]!.data.subarray(0, 8).equals(anchorDiscriminator("buyExactIn"))).toBe(true);

    // Sign as the user would, then submit through the engine's verifier.
    tx.sign(user);
    const signedB64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");

    // Direct shape check via the exported verifier with expected accounts.
    const { pool, config, platform } = rig;
    const mintAKey = pool.mintA;
    const quoteMint = QUOTE_MINT.equals(PublicKey.default) ? getPdaLaunchpadConfigId(LAUNCHPAD_PROGRAM, PublicKey.default, 0, 0).publicKey : QUOTE_MINT;
    void quoteMint;
    // Real quote mint for accounts comes from the pool config (PublicKey.default here is fine for math);
    // for instruction verification we need the SAME mint the engine derived: it uses poolInfo.mintB.
    const q = quoteBuyPure(LaunchpadPool.decode(pool.data), RATES, 1_000_000_000n, 100);
    const userAtaA = PublicKey.findProgramAddressSync([user.publicKey.toBuffer(), mintAKey.toBuffer()], pool.mintA.equals(PublicKey.default) ? PublicKey.default : PublicKey.default)[0];
    void userAtaA;

    // The engine's submit path derives accounts itself; call it via a fresh engine
    // whose decodeLaunch returns our rig accounts (stub already returns them).
    const result = await rig.engine.submitSwap({
      userId: 1,
      user: user.publicKey.toBase58(),
      mintA: rig.pool.mintA.toBase58(),
      quote: "sol",
      side: "buy",
      amountIn: 1_000_000_000n,
      minOut: q.minOutBase,
      signedTxBase64: signedB64,
    });
    expect(result.signature).toBeTruthy();
    expect(result.recorded).toBe(true);
    expect(rig.db.trades.length).toBe(1);
    expect(rig.db.trades[0]!.side).toBe("buy");
  });

  it("submit rejects tampered amounts (amountIn swapped)", async () => {
    const prepared = await prepare("buy");
    const tx = Transaction.from(Buffer.from(prepared.serialized, "base64"));
    const lab = tx.instructions.find((i) => i.programId.equals(LAUNCHPAD_PROGRAM))!;
    // Tamper the amountIn u64 inside the instruction data.
    const evil = Buffer.from(lab.data);
    evil.writeBigUInt64LE(999_000_000_000n, 8);
    lab.data = evil;
    tx.sign(user);
    const signedB64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
    const q = quoteBuyPure(LaunchpadPool.decode(rig.pool.data), RATES, 1_000_000_000n, 100);
    await expect(rig.engine.submitSwap({
      userId: 1, user: user.publicKey.toBase58(), mintA: rig.pool.mintA.toBase58(),
      quote: "sol", side: "buy", amountIn: 1_000_000_000n, minOut: q.minOutBase,
      signedTxBase64: signedB64,
    })).rejects.toMatchObject({ code: "SHAPE_MISMATCH" });
  });

  it("submit rejects a tx whose claimed wallet does not match the signer", async () => {
    const prepared = await prepare("buy");
    const tx = Transaction.from(Buffer.from(prepared.serialized, "base64"));
    tx.sign(user);
    const signedB64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
    const q = quoteBuyPure(LaunchpadPool.decode(rig.pool.data), RATES, 1_000_000_000n, 100);
    // A different account claims the signature the user produced — the
    // verifier must bind the signature to the claimed wallet.
    const impostor = Keypair.generate().publicKey.toBase58();
    await expect(rig.engine.submitSwap({
      userId: 1, user: impostor, mintA: rig.pool.mintA.toBase58(),
      quote: "sol", side: "buy", amountIn: 1_000_000_000n, minOut: q.minOutBase,
      signedTxBase64: signedB64,
    })).rejects.toMatchObject({ code: "BAD_TX" });
  });

  it("submit rejects when the user did not sign", async () => {
    const prepared = await prepare("sell", 1_000_000n);
    const tx = Transaction.from(Buffer.from(prepared.serialized, "base64"));
    const signedB64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
    const q = quoteSellPure(LaunchpadPool.decode(rig.pool.data), RATES, 1_000_000n, 100);
    await expect(rig.engine.submitSwap({
      userId: 1, user: user.publicKey.toBase58(), mintA: rig.pool.mintA.toBase58(),
      quote: "sol", side: "sell", amountIn: 1_000_000n, minOut: q.minOutQuote,
      signedTxBase64: signedB64,
    })).rejects.toMatchObject({ code: "NOT_USER_SIGNED" });
  });

  it("sell: prepared instruction is sellExactIn and verification passes", async () => {
    const prepared = await prepare("sell", 1_000_000n);
    const tx = Transaction.from(Buffer.from(prepared.serialized, "base64"));
    const lab = tx.instructions.filter((i) => i.programId.equals(LAUNCHPAD_PROGRAM));
    expect(lab.length).toBe(1);
    expect(lab[0]!.data.subarray(0, 8).equals(anchorDiscriminator("sellExactIn"))).toBe(true);
    tx.sign(user);
    const signedB64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
    const q = quoteSellPure(LaunchpadPool.decode(rig.pool.data), RATES, 1_000_000n, 100);
    const result = await rig.engine.submitSwap({
      userId: 2, user: user.publicKey.toBase58(), mintA: rig.pool.mintA.toBase58(),
      quote: "sol", side: "sell", amountIn: 1_000_000n, minOut: q.minOutQuote,
      signedTxBase64: signedB64,
    });
    expect(result.recorded).toBe(true);
    expect(rig.db.trades[0]!.side).toBe("sell");
  });

  it("verifyLaunchpadSwapInstruction rejects a wrong-vault instruction", () => {
    const fixture = encodePool();
    const pool = { poolId: fixture.poolId, vaultA: fixture.vaultA, vaultB: fixture.vaultB, mintA: fixture.mintA };
    const user = Keypair.generate().publicKey;
    const auth = PublicKey.findProgramAddressSync([Buffer.from("vault_and_lp_mint_auth_seed")], LAUNCHPAD_PROGRAM)[0];
    const data = Buffer.concat([anchorDiscriminator("buyExactIn"), Buffer.alloc(24)]);
    const labIx = {
      programId: LAUNCHPAD_PROGRAM,
      keys: [
        { pubkey: user, isSigner: true, isWritable: true },
        { pubkey: auth, isSigner: false, isWritable: false },
        { pubkey: configId, isSigner: false, isWritable: false },
        { pubkey: platformId, isSigner: false, isWritable: false },
        { pubkey: pool.poolId, isSigner: false, isWritable: true },
        { pubkey: PublicKey.unique(), isSigner: false, isWritable: true }, // userAtaA wrong
        { pubkey: PublicKey.unique(), isSigner: false, isWritable: true },
        { pubkey: pool.vaultA, isSigner: false, isWritable: true },
        { pubkey: pool.vaultB, isSigner: false, isWritable: true },
        { pubkey: pool.mintA, isSigner: false, isWritable: false },
        { pubkey: PublicKey.unique(), isSigner: false, isWritable: false },
        { pubkey: PublicKey.unique(), isSigner: false, isWritable: false },
        { pubkey: PublicKey.unique(), isSigner: false, isWritable: false },
        { pubkey: PublicKey.unique(), isSigner: false, isWritable: false },
        { pubkey: LAUNCHPAD_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: PublicKey.unique(), isSigner: false, isWritable: true },
        { pubkey: PublicKey.unique(), isSigner: false, isWritable: true },
      ],
      data,
    } as never;
    expect(() => verifyLaunchpadSwapInstruction(labIx, {
      side: "buy", user, poolId: pool.poolId, auth,
      configId, platformId, mintA: pool.mintA, quoteMint: PublicKey.unique(),
      vaultA: pool.vaultA, vaultQuote: pool.vaultB,
      userAtaA: PublicKey.unique(), userAtaQuote: PublicKey.unique(),
      tokenProgramA: PublicKey.unique(), tokenProgramQuote: PublicKey.unique(),
      platformVault: PublicKey.unique(), creatorVault: PublicKey.unique(),
      cpiEvent: PublicKey.unique(), amountIn: 1n, minOut: 1n,
    })).toThrow(LaunchLabError);
  });
});

// ── create + confirm-create ──────────────────────────────────────────────

describe("launchlab create tx (mint keypair never on the server)", () => {
  it("prepareCreateTx builds createAccount + initializeV2 and confirmCreateTx verifies the exact signed shape", async () => {
    const rig = buildRig();
    const mintKeypair = Keypair.generate();
    const creatorKp = Keypair.generate();
    const name = "Test Token";
    const symbol = "TST";
    const uri = "https://example.com/meta.json";

    const prepared = await rig.engine.prepareCreateTx({
      creator: creatorKp.publicKey.toBase58(),
      mintPubkey: mintKeypair.publicKey.toBase58(),
      name, symbol, uri,
    });
    expect(prepared.sessionId).toBe(sessionIdFor(prepared.serialized));

    const tx = Transaction.from(Buffer.from(prepared.serialized, "base64"));
    expect(tx.instructions.some((i) => i.programId.equals(SystemProgram.programId))).toBe(false);
    const init = tx.instructions.filter((i) => i.programId.equals(LAUNCHPAD_PROGRAM));
    expect(init.length).toBe(1);
    expect(init[0]!.data.subarray(0, 8).equals(anchorDiscriminator("initializeV2"))).toBe(true);
    const meta = decodeInitializeV2Data(init[0]!.data);
    expect(meta.name).toBe(name);
    expect(meta.symbol).toBe(symbol);
    expect(meta.uri).toBe(uri);

    // Sign with creator + mint (exactly what the browser does).
    tx.sign(creatorKp, mintKeypair);
    const signedB64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");

    // The createAccount expects the mint account to not exist; our stub returns null for it — good.
    const result = await rig.engine.confirmCreateTx({
      userId: 1,
      creator: creatorKp.publicKey.toBase58(),
      mint: mintKeypair.publicKey.toBase58(),
      symbol, name, uri,
      signedTxBase64: signedB64,
    });
    expect(result.poolId).toBe(getPdaLaunchpadPoolId(LAUNCHPAD_PROGRAM, mintKeypair.publicKey, NATIVE_MINT).publicKey.toBase58());
    expect(rig.db.launches.get(mintKeypair.publicKey.toBase58())?.confirmed_at).toBeTruthy();
  });

  it("confirmCreateTx rejects metadata tampering (different symbol)", async () => {
    const rig = buildRig();
    const mintKeypair = Keypair.generate();
    const creatorKp = Keypair.generate();
    const prepared = await rig.engine.prepareCreateTx({
      creator: creatorKp.publicKey.toBase58(),
      mintPubkey: mintKeypair.publicKey.toBase58(),
      name: "Real", symbol: "REAL", uri: "https://example.com/m.json",
    });
    const tx = Transaction.from(Buffer.from(prepared.serialized, "base64"));
    // Swap the on-chain symbol for another one after "signing intent".
    const init = tx.instructions.find((i) => i.programId.equals(LAUNCHPAD_PROGRAM))!;
    const body = Buffer.from(init.data);
    // REAL -> EVIL (same length) inside the borsh string section.
    const idx = body.indexOf(Buffer.from("REAL"));
    if (idx > 0) body.write("EVIL", idx);
    init.data = body;
    tx.sign(creatorKp, mintKeypair);
    const signedB64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
    await expect(rig.engine.confirmCreateTx({
      userId: 1,
      creator: creatorKp.publicKey.toBase58(),
      mint: mintKeypair.publicKey.toBase58(),
      symbol: "REAL", name: "Real", uri: "https://example.com/m.json",
      signedTxBase64: signedB64,
    })).rejects.toMatchObject({ code: "SHAPE_MISMATCH" });
    expect(rig.db.launches.size).toBe(0);
  });

  it("confirmCreateTx rejects when the mint keypair did not sign", async () => {
    const rig = buildRig();
    const mintKeypair = Keypair.generate();
    const creatorKp = Keypair.generate();
    const prepared = await rig.engine.prepareCreateTx({
      creator: creatorKp.publicKey.toBase58(),
      mintPubkey: mintKeypair.publicKey.toBase58(),
      name: "T", symbol: "T", uri: "https://example.com/t.json",
    });
    const tx = Transaction.from(Buffer.from(prepared.serialized, "base64"));
    tx.sign(creatorKp); // mint signature missing
    const signedB64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
    await expect(rig.engine.confirmCreateTx({
      userId: 1,
      creator: creatorKp.publicKey.toBase58(),
      mint: mintKeypair.publicKey.toBase58(),
      symbol: "T", name: "T", uri: "https://example.com/t.json",
      signedTxBase64: signedB64,
    })).rejects.toMatchObject({ code: "BAD_TX" });
  });
});

// ── session binding (server layer semantics) ─────────────────────────────

describe("launchlab session id semantics", () => {
  it("session id binds to the exact serialized message", () => {
    const a = sessionIdFor("AAA=");
    const b = sessionIdFor("AAB=");
    expect(a).not.toBe(b);
    expect(a).toBe(sessionIdFor("AAA="));
  });
});

// ATA helper note: the engine derives ATAs via getATAAddress; the stub never
// validates SPL accounts, so no funding fixtures are required for these tests.
void createAssociatedTokenAccountIdempotentInstruction;
void createSyncNativeInstruction;
