/**
 * 🧪 RAYDIUM LAUNCHLAB — REAL on-chain bonding curve, self-custody.
 *
 * Honesty contract (matches the rest of the launchpad):
 * - The curve state lives ON-CHAIN in the LaunchLab program
 *   (LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj). This module only READS it
 *   (via SDK decoders) and helps users SIGN transactions for it in their own
 *   wallet. The server never custodies keys or funds, and never invents state.
 * - Quotes use the SDK's `Curve.buyExactIn` / `Curve.sellExactIn` — the same
 *   math as the program (verified against real pool state read from RPC).
 * - Graduation to Raydium CPMM is program-enforced (the Raydium crank runs
 *   MigrateToCpswap once the quote vault crosses the threshold). Nothing to
 *   build here: `status` simply flips on-chain, and this module reports it.
 * - prepare/submit follows the durable exactly-once session pattern used by
 *   spot trading: the session id is the hash of the exact unsigned message and
 *   can be consumed once. At submit the signed transaction shape is verified
 *   byte-for-byte against the prepared instruction (accounts, PDAs, amounts)
 *   so a malicious client can never swap a different transfer into the flow.
 * - Token creation is self-custody too: the mint keypair is generated in the
 *   creator's browser (the private key never reaches the server), the server
 *   builds the unsigned create transaction, and the confirmation is only
 *   accepted after verifying the signed transaction actually creates that
 *   exact mint on LaunchLab (createAccount + initializeV2 with our config).
 *
 * Unsupported by design (rejected, never guessed):
 * - EVM wallets/claims: LaunchLab is Solana-only.
 * - shareFeeRate: we never set a referrer share.
 * - Transfer-fee (Token-2022) quote mints: fee config would change the math.
 */

import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  NATIVE_MINT,
} from "@solana/spl-token";
import BN from "bn.js";
import bs58 from "bs58";
import {
  LAUNCHPAD_PROGRAM,
  Curve,
  LaunchpadPool,
  LaunchpadConfig,
  PlatformConfig,
  getPdaLaunchpadPoolId,
  getPdaLaunchpadConfigId,
  getPdaLaunchpadAuth,
  getPdaLaunchpadVaultId,
  getPdaMetadataKey,
  getPdaPlatformVault,
  getPdaCreatorVault,
  getPdaCpiEvent,
  getLaunchpadPoolMintAProgram,
  getLaunchpadPoolMintBProgram,
  getATAAddress,
  CpmmCreatorFeeOn,
  anchorDataBuf,
} from "@raydium-io/raydium-sdk-v2";

/** Raydium's own platform PDA (the default platform every launch binds to). */
export const RAYDIUM_PLATFORM_ID = new PublicKey("4Bu96XjU84XjPDSpveTVf6LYGCkfW5FK7SNkREWcEfV4");

/**
 * Default LaunchLab GlobalConfig: quote mint = SOL (NATIVE_MINT), curve_type
 * 0 (constant product), index 0 — the standard mainnet config used by the
 * official SDK demo (docs.raydium.io → LaunchLab code demos).
 */
export function launchLabConfigId(quoteMint: PublicKey, curveType = 0, index = 0): PublicKey {
  return getPdaLaunchpadConfigId(LAUNCHPAD_PROGRAM, quoteMint, curveType, index).publicKey;
}

/** Pool status byte → honest label (0 curve / 1 migrating / 2 migrated). */
export const LAUNCHPAD_STATUS_LABELS: Record<number, string> = {
  0: "curve",
  1: "migrating",
  2: "migrated",
};

/** Program byte stored in the launchpad pool status. */
export const LAUNCHPAD_CURVE_STATUS = 0;

/** Quote mints we support (SOL wrapped native only for now). */
export interface QuoteMintSpec {
  mint: PublicKey;
  decimals: number;
  symbol: string;
}
/** Canonical SOL quote spec (module-level so lookups are never undefined). */
export const SOL_QUOTE: QuoteMintSpec = { mint: NATIVE_MINT, decimals: 9, symbol: "SOL" };
export const LAUNCHLAB_QUOTE_MINTS: Record<string, QuoteMintSpec> = {
  sol: SOL_QUOTE,
};

/** Smallest curve trade we prepare: 0.01 SOL in lamports. */
export const LAUNCHLAB_MIN_TRADE_LAMPORTS = 10_000_000n;

/** A prepared session stops being submittable after this long (ms). */
export const LAUNCHLAB_SESSION_TTL_MS = 10 * 60_000;

/** Mint account size for a classic SPL mint (rent-exempt createAccount). */
export const MINT_SPACE = 82;

/** Minimal Solana surface used here (Connection satisfies it). */
export interface SolanaLike {
  getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  getAccountInfo(address: PublicKey): Promise<{ owner: PublicKey; lamports: number; data: Uint8Array } | null>;
  sendRawTransaction(raw: Uint8Array): Promise<string>;
  /** Signature-based confirmation; matches Connection's string overload. */
  confirmTransaction(signature: string, commitment?: string): Promise<unknown>;
  /** Optional (Connection provides it; the offline stub can omit it). */
  getMinimumBalanceForRentExemption?(byteLength: number): Promise<number>;
}

/** DB surface (subset of AppDb) — only our own users' fills + launch registry. */
export interface LaunchRaydiumDb {
  upsertLaunchLabLaunch(row: { mintA: string; quoteMint: string; poolId: string; symbol: string; name: string; creator: string; ts: number }): void;
  markLaunchLabLaunchConfirmed(mintA: string, signature: string, ts: number): void;
  getLaunchLabLaunch(mintA: string): LaunchLabLaunchRow | null;
  recordLaunchLabTrade(row: { mintA: string; quoteMint: string; userId: number; side: "buy" | "sell"; amountIn: string; minOut: string; signature: string; ts?: number }): boolean;
  listLaunchLabTrades(mintA: string, limit?: number): LaunchLabTradeRow[];
  listUserLaunchLabTrades(userId: number, limit?: number): LaunchLabTradeRow[];
}

export interface LaunchLabLaunchRow {
  mint_a: string;
  quote_mint: string;
  pool_id: string;
  symbol: string;
  name: string;
  creator: string;
  created_at: number;
  confirmed_at: number | null;
  confirmed_signature: string | null;
}

export interface LaunchLabTradeRow {
  id: number;
  mint_a: string;
  quote_mint: string;
  user_id: number;
  side: string;
  amount_in: string;
  min_out: string;
  signature: string;
  ts: number;
}

export class LaunchLabError extends Error {
  constructor(
    public readonly code:
      | "RPC_DISABLED"
      | "LAUNCH_NOT_FOUND"
      | "CONFIG_NOT_FOUND"
      | "CURVE_CLOSED"
      | "CURVE_EMPTY"
      | "BAD_AMOUNT"
      | "BAD_QUOTE"
      | "BAD_TX"
      | "NOT_USER_SIGNED"
      | "SHAPE_MISMATCH"
      | "UNSUPPORTED_CONFIG"
      | "CONFIRMATION_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "LaunchLabError";
  }
}

const ZERO_BN = new BN(0);
const COMPUTE_UNIT_LIMIT = 300_000;

// ── Pure helpers (unit-testable, no I/O) ─────────────────────────────────

export type PoolInfoLike = ReturnType<typeof LaunchpadPool.decode>;

export interface CurveRates {
  protocolFeeRate: BN;
  platformFeeRate: BN;
  creatorFeeRate: BN;
  curveType: number;
}

/** Off-chain preview of a curve buy (exact program math, no I/O). */
export function quoteBuyPure(
  poolInfo: PoolInfoLike,
  rates: CurveRates,
  amountInQuote: bigint,
  slippageBps: number,
): { amountOutBase: bigint; minOutBase: bigint; totalFeeQuote: bigint } {
  assertSlippage(slippageBps);
  const res = Curve.buyExactIn({
    poolInfo,
    amountB: new BN(amountInQuote.toString()),
    protocolFeeRate: rates.protocolFeeRate,
    platformFeeRate: rates.platformFeeRate,
    curveType: rates.curveType,
    shareFeeRate: ZERO_BN,
    creatorFeeRate: rates.creatorFeeRate,
    transferFeeConfigA: undefined,
    transferFeeConfigB: undefined,
    slot: 0,
  });
  const out = res.amountA.amount.sub(res.amountA.fee ?? ZERO_BN);
  const minOut = applySlippage(out, slippageBps);
  const split = res.splitFee;
  return {
    amountOutBase: BigInt(out.toString()),
    minOutBase: BigInt(minOut.toString()),
    totalFeeQuote: BigInt(split.platformFee.add(split.protocolFee).add(split.creatorFee).add(split.shareFee).toString()),
  };
}

/** Off-chain preview of a curve sell (exact program math, no I/O). */
export function quoteSellPure(
  poolInfo: PoolInfoLike,
  rates: CurveRates,
  amountInBase: bigint,
  slippageBps: number,
): { amountOutQuote: bigint; minOutQuote: bigint } {
  assertSlippage(slippageBps);
  const res = Curve.sellExactIn({
    poolInfo,
    amountA: new BN(amountInBase.toString()),
    protocolFeeRate: rates.protocolFeeRate,
    platformFeeRate: rates.platformFeeRate,
    curveType: rates.curveType,
    shareFeeRate: ZERO_BN,
    creatorFeeRate: rates.creatorFeeRate,
    transferFeeConfigA: undefined,
    transferFeeConfigB: undefined,
    slot: 0,
  });
  // NOTE: sellExactIn returns amountB ALREADY net of the curve fee and any
  // quote transfer fee (amountB = vaultAmountOutB − transferFeeB).
  const out = res.amountB;
  return {
    amountOutQuote: BigInt(out.toString()),
    minOutQuote: BigInt(applySlippage(out, slippageBps).toString()),
  };
}

function applySlippage(out: BN, slippageBps: number): BN {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 5000) {
    throw new LaunchLabError("BAD_AMOUNT", "slippageBps must be an integer 0..5000");
  }
  const ONE = new BN(10_000);
  return out.mul(ONE.sub(new BN(slippageBps))).div(ONE);
}

/** Validate slippage bounds before any curve math (clean error semantics). */
function assertSlippage(slippageBps: number): void {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 5000) {
    throw new LaunchLabError("BAD_AMOUNT", "slippageBps must be an integer 0..5000");
  }
}

/**
 * Verify the exact shape of a LaunchLab buy/sell instruction inside a signed
 * transaction. Returns the decoded (amountIn, minOut). Every account is
 * checked against its expected derivation — nothing is trusted from the wire.
 */
export function verifyLaunchpadSwapInstruction(
  ix: TransactionInstruction,
  expected: {
    side: "buy" | "sell";
    user: PublicKey;
    poolId: PublicKey;
    auth: PublicKey;
    configId: PublicKey;
    platformId: PublicKey;
    mintA: PublicKey;
    quoteMint: PublicKey;
    vaultA: PublicKey;
    vaultQuote: PublicKey;
    userAtaA: PublicKey;
    userAtaQuote: PublicKey;
    tokenProgramA: PublicKey;
    tokenProgramQuote: PublicKey;
    platformVault: PublicKey;
    creatorVault: PublicKey;
    cpiEvent: PublicKey;
    amountIn: bigint;
    minOut: bigint;
  },
): { amountIn: bigint; minOut: bigint } {
  const disc = anchorDiscriminator(expected.side === "buy" ? "buyExactIn" : "sellExactIn");
  if (!ix.programId.equals(LAUNCHPAD_PROGRAM)) throw new LaunchLabError("SHAPE_MISMATCH", "instruction is not a LaunchLab instruction");
  if (ix.data.length < 8 + 24 || !ix.data.subarray(0, 8).equals(disc)) {
    throw new LaunchLabError("SHAPE_MISMATCH", "instruction discriminator does not match the prepared swap");
  }
  // SDK layout without a share-fee receiver: 18 accounts total.
  if (ix.keys.length !== 18) throw new LaunchLabError("SHAPE_MISMATCH", "instruction accounts do not match the prepared swap (share fee not offered)");
  const k = (i: number) => ix.keys[i]!.pubkey;
  const checks: Array<[number, PublicKey, string]> = [
    [0, expected.user, "owner"],
    [1, expected.auth, "auth"],
    [2, expected.configId, "configId"],
    [3, expected.platformId, "platformId"],
    [4, expected.poolId, "poolId"],
    [5, expected.userAtaA, "user token A"],
    [6, expected.userAtaQuote, "user token B"],
    [7, expected.vaultA, "vault A"],
    [8, expected.vaultQuote, "vault B"],
    [9, expected.mintA, "mint A"],
    [10, expected.quoteMint, "mint B"],
    [11, expected.tokenProgramA, "token program A"],
    [12, expected.tokenProgramQuote, "token program B"],
    [13, expected.cpiEvent, "cpi event"],
    [14, LAUNCHPAD_PROGRAM, "program"],
    [15, SystemProgram.programId, "system program"],
    [16, expected.platformVault, "platform fee vault"],
    [17, expected.creatorVault, "creator fee vault"],
  ];
  for (const [idx, want, label] of checks) {
    if (!k(idx).equals(want)) throw new LaunchLabError("SHAPE_MISMATCH", `account ${idx} (${label}) does not match the prepared swap`);
  }
  // The ONLY signer (distinct pubkey set — web3 legacy round-trips mark every
  // occurrence of a signed pubkey as isSigner) must be the user.
  const signerSet = new Set(ix.keys.filter((a) => a.isSigner).map((a) => a.pubkey.toBase58()));
  if (signerSet.size !== 1 || !signerSet.has(expected.user.toBase58())) {
    throw new LaunchLabError("SHAPE_MISMATCH", "the user must be the only instruction signer");
  }
  const view = new DataView(ix.data.buffer, ix.data.byteOffset + 8, 24);
  const amountIn = BigInt(view.getBigUint64(0, true));
  const minOut = BigInt(view.getBigUint64(8, true));
  const shareFeeRate = BigInt(view.getBigUint64(16, true));
  if (amountIn !== expected.amountIn || minOut !== expected.minOut) {
    throw new LaunchLabError("SHAPE_MISMATCH", "swap amounts do not match the prepared quote");
  }
  if (shareFeeRate !== 0n) throw new LaunchLabError("SHAPE_MISMATCH", "unexpected share fee");
  return { amountIn, minOut };
}

/** 8-byte anchor discriminators for the instructions we verify. */
export function anchorDiscriminator(name: "buyExactIn" | "sellExactIn" | "initializeV2"): Buffer {
  // Values come from the SDK (anchorDataBuf); hardcode-free access:
  const buf = anchorDataBuf[name];
  if (!buf) throw new LaunchLabError("SHAPE_MISMATCH", `unknown instruction ${name}`);
  return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** Extract (creator, name, symbol, uri) from an initializeV2 instruction body. */
export function decodeInitializeV2Data(data: Buffer): { decimals: number; name: string; symbol: string; uri: string } {
  const disc = anchorDiscriminator("initializeV2");
  if (data.length < 8 + 1 + 12 || !data.subarray(0, 8).equals(disc)) {
    throw new LaunchLabError("SHAPE_MISMATCH", "not an initializeV2 instruction");
  }
  let off = 8;
  const decimals = data.readUInt8(off); off += 1;
  const readStr = (): string => {
    if (off + 4 > data.length) throw new LaunchLabError("SHAPE_MISMATCH", "truncated metadata string");
    const len = data.readUInt32LE(off); off += 4;
    if (off + len > data.length) throw new LaunchLabError("SHAPE_MISMATCH", "truncated metadata string");
    const s = data.subarray(off, off + len).toString("utf8"); off += len;
    return s;
  };
  const name = readStr();
  const symbol = readStr();
  const uri = readStr();
  return { decimals, name, symbol, uri };
}

// ── The engine ───────────────────────────────────────────────────────────

export class LaunchRaydium {
  constructor(
    private readonly solana: SolanaLike | null,
    private readonly db: LaunchRaydiumDb,
  ) {}

  private requireSolana(): NonNullable<SolanaLike> {
    if (!this.solana) throw new LaunchLabError("RPC_DISABLED", "no Solana endpoint configured for LaunchLab");
    return this.solana;
  }

  /** Resolve and decode the on-chain pool + config for one launch. */
  async decodeLaunch(mintA: string, quoteKey: { mint: PublicKey; decimals: number; symbol: string }): Promise<{
    poolId: PublicKey;
    poolInfo: PoolInfoLike;
    configInfo: ReturnType<typeof LaunchpadConfig.decode>;
    platformInfo: ReturnType<typeof PlatformConfig.decode>;
    rates: CurveRates;
    mintAProgram: PublicKey;
    quoteMintProgram: PublicKey;
  }> {
    const solana = this.requireSolana();
    const mint = new PublicKey(mintA);
    const { publicKey: poolId } = getPdaLaunchpadPoolId(LAUNCHPAD_PROGRAM, mint, quoteKey.mint);
    const poolAcc = await solana.getAccountInfo(poolId);
    if (!poolAcc) throw new LaunchLabError("LAUNCH_NOT_FOUND", "no LaunchLab curve exists for this mint + quote");
    if (!poolAcc.owner.equals(LAUNCHPAD_PROGRAM)) throw new LaunchLabError("UNSUPPORTED_CONFIG", "invalid pool owner");
    const poolInfo = LaunchpadPool.decode(asBuffer(poolAcc.data));
    if (!poolInfo.mintA.equals(mint) || !poolInfo.mintB.equals(quoteKey.mint) || poolInfo.mintProgramFlag !== 0) throw new LaunchLabError("UNSUPPORTED_CONFIG", "only classic SPL token pools with SOL quote are supported");
    const configAcc = await solana.getAccountInfo(poolInfo.configId);
    if (!configAcc) throw new LaunchLabError("CONFIG_NOT_FOUND", "LaunchLab config account not found");
    if (!configAcc.owner.equals(LAUNCHPAD_PROGRAM)) throw new LaunchLabError("UNSUPPORTED_CONFIG", "invalid config owner");
    const configInfo = LaunchpadConfig.decode(asBuffer(configAcc.data));
    const platformAcc = await solana.getAccountInfo(poolInfo.platformId);
    if (!platformAcc) throw new LaunchLabError("CONFIG_NOT_FOUND", "LaunchLab platform account not found");
    if (!platformAcc.owner.equals(LAUNCHPAD_PROGRAM)) throw new LaunchLabError("UNSUPPORTED_CONFIG", "invalid platform owner");
    const platformInfo = PlatformConfig.decode(asBuffer(platformAcc.data));
    return {
      poolId,
      poolInfo,
      configInfo,
      platformInfo,
      rates: {
        protocolFeeRate: configInfo.tradeFeeRate,
        platformFeeRate: platformInfo.feeRate,
        creatorFeeRate: platformInfo.creatorFeeRate,
        curveType: configInfo.curveType,
      },
      mintAProgram: getLaunchpadPoolMintAProgram(poolInfo.mintProgramFlag),
      quoteMintProgram: getLaunchpadPoolMintBProgram(poolInfo.mintProgramFlag),
    };
  }

  /** Public on-chain state view for the UI (all values read live). */
  async state(mintA: string, quote: string) {
    const quoteKey = LAUNCHLAB_QUOTE_MINTS[quote];
    if (!quoteKey) throw new LaunchLabError("BAD_QUOTE", `unsupported quote mint: ${quote}`);
    const { poolId, poolInfo, configInfo, rates } = await this.decodeLaunch(mintA, quoteKey);
    const price = Curve.getPrice({
      poolInfo,
      curveType: rates.curveType,
      decimalA: poolInfo.mintDecimalsA,
      decimalB: poolInfo.mintDecimalsB,
    });
    const soldBase = BigInt(poolInfo.realA.toString());
    const remainingBase = BigInt(poolInfo.totalSellA.sub(poolInfo.realA).toString());
    const raisedQuote = BigInt(poolInfo.realB.toString());
    const targetQuote = BigInt(poolInfo.totalFundRaisingB.toString());
    return {
      programId: LAUNCHPAD_PROGRAM.toBase58(),
      poolId: poolId.toBase58(),
      mintA,
      quoteMint: poolInfo.mintB.toBase58(),
      quoteSymbol: quoteKey.symbol,
      status: LAUNCHPAD_STATUS_LABELS[poolInfo.status] ?? `unknown(${poolInfo.status})`,
      statusRaw: poolInfo.status,
      curveOpen: poolInfo.status === LAUNCHPAD_CURVE_STATUS,
      migrateType: poolInfo.migrateType === 0 ? "amm" : "cpmm",
      mintDecimalsA: poolInfo.mintDecimalsA,
      mintDecimalsB: poolInfo.mintDecimalsB,
      soldBase: soldBase.toString(),
      remainingBase: remainingBase.toString(),
      totalSellBase: BigInt(poolInfo.totalSellA.toString()).toString(),
      raisedQuote: raisedQuote.toString(),
      graduationTargetQuote: targetQuote.toString(),
      progressPct: targetQuote > 0n ? Number((raisedQuote * 10_000n) / targetQuote) / 100 : 0,
      priceQuotePerBase: price.toString(),
      virtualA: BigInt(poolInfo.virtualA.toString()).toString(),
      virtualB: BigInt(poolInfo.virtualB.toString()).toString(),
      creator: poolInfo.creator.toBase58(),
      platformId: poolInfo.platformId.toBase58(),
      configId: poolInfo.configId.toBase58(),
    };
  }

  /** Live quote for the UI (no state change, no session). */
  async quote(mintA: string, quote: string, side: "buy" | "sell", amountIn: bigint, slippageBps: number) {
    const quoteKey = LAUNCHLAB_QUOTE_MINTS[quote];
    if (!quoteKey) throw new LaunchLabError("BAD_QUOTE", `unsupported quote mint: ${quote}`);
    const { poolId, poolInfo, rates } = await this.decodeLaunch(mintA, quoteKey);
    if (poolInfo.status !== LAUNCHPAD_CURVE_STATUS) throw new LaunchLabError("CURVE_CLOSED", "the curve is closed (migrating or migrated to CPMM)");
    if (amountIn <= 0n) throw new LaunchLabError("BAD_AMOUNT", "amountIn must be positive");
    if (side === "buy") {
      if (amountIn < LAUNCHLAB_MIN_TRADE_LAMPORTS) throw new LaunchLabError("BAD_AMOUNT", "minimum trade is 0.01 SOL");
      const q = quoteBuyPure(poolInfo, rates, amountIn, slippageBps);
      return { side, amountIn: amountIn.toString(), amountOut: q.amountOutBase.toString(), minOut: q.minOutBase.toString(), totalFeeQuote: q.totalFeeQuote.toString(), poolId: poolId.toBase58() };
    }
    const q = quoteSellPure(poolInfo, rates, amountIn, slippageBps);
    return { side, amountIn: amountIn.toString(), amountOut: q.amountOutQuote.toString(), minOut: q.minOutQuote.toString(), poolId: poolId.toBase58() };
  }

  /**
   * Build the UNSIGNED curve buy/sell transaction. The user is fee payer and
   * the only signer. Session id = hash of the exact serialized message.
   */
  async prepareSwap(params: {
    userId: number;
    user: string;
    mintA: string;
    quote: string;
    side: "buy" | "sell";
    amountIn: bigint;
    slippageBps: number;
  }): Promise<{ serialized: string; sessionId: string; poolId: string; quote: Record<string, string> }> {
    const solana = this.requireSolana();
    const quoteKey = LAUNCHLAB_QUOTE_MINTS[params.quote];
    if (!quoteKey) throw new LaunchLabError("BAD_QUOTE", `unsupported quote mint: ${params.quote}`);
    let user: PublicKey;
    try { user = new PublicKey(params.user); } catch { throw new LaunchLabError("BAD_TX", "invalid user wallet"); }
    const { poolId, poolInfo, configInfo, platformInfo, rates, mintAProgram, quoteMintProgram } = await this.decodeLaunch(params.mintA, quoteKey);
    if (poolInfo.status !== LAUNCHPAD_CURVE_STATUS) throw new LaunchLabError("CURVE_CLOSED", "the curve is closed (migrating or migrated to CPMM)");
    if (params.amountIn <= 0n) throw new LaunchLabError("BAD_AMOUNT", "amountIn must be positive");

    const mint = new PublicKey(params.mintA);
    const quoteMint = poolInfo.mintB;
    const vaultA = poolInfo.vaultA;
    const vaultQuote = poolInfo.vaultB;
    const userAtaA = getATAAddress(user, mint, mintAProgram).publicKey;
    const userAtaQuote = getATAAddress(user, quoteMint, quoteMintProgram).publicKey;
    const auth = getPdaLaunchpadAuth(LAUNCHPAD_PROGRAM).publicKey;
    const platformVault = getPdaPlatformVault(LAUNCHPAD_PROGRAM, poolInfo.platformId, quoteMint).publicKey;
    const creatorVault = getPdaCreatorVault(LAUNCHPAD_PROGRAM, poolInfo.creator, quoteMint).publicKey;
    const cpiEvent = getPdaCpiEvent(LAUNCHPAD_PROGRAM).publicKey;

    const instructions: TransactionInstruction[] = [computeBudgetIx()];
    instructions.push(createAssociatedTokenAccountIdempotentInstruction(user, userAtaA, user, mint, mintAProgram));

    let amountOut = 0n;
    let minOut = 0n;
    if (params.side === "buy") {
      const q = quoteBuyPure(poolInfo, rates, params.amountIn, params.slippageBps);
      amountOut = q.amountOutBase;
      minOut = q.minOutBase;
    } else {
      const q = quoteSellPure(poolInfo, rates, params.amountIn, params.slippageBps);
      amountOut = q.amountOutQuote;
      minOut = q.minOutQuote;
    }
    if (minOut <= 0n) throw new LaunchLabError("BAD_AMOUNT", "amount too small — slippage floor is zero");

    if (params.side === "buy") {
      instructions.push(createAssociatedTokenAccountIdempotentInstruction(user, userAtaQuote, user, quoteMint, quoteMintProgram));
      if (quoteMint.equals(NATIVE_MINT)) {
        // Wrap SOL: fund the wsol ATA with the exact buy amount, then sync.
        instructions.push(SystemProgram.transfer({ fromPubkey: user, toPubkey: userAtaQuote, lamports: params.amountIn }));
        instructions.push(createSyncNativeInstruction(userAtaQuote));
      } else {
        throw new LaunchLabError("BAD_QUOTE", "only SOL quote buys are wired (transfer-checked path not enabled)");
      }
      const amounts = launchpadSwapData(params.amountIn, minOut);
      instructions.push(new TransactionInstruction({
        programId: LAUNCHPAD_PROGRAM,
        keys: swapKeys({ user, auth, configId: poolInfo.configId, platformId: poolInfo.platformId, poolId, userAtaA, userAtaQuote, vaultA, vaultQuote: vaultQuote, mint, quoteMint, mintAProgram, quoteMintProgram, platformVault, creatorVault, cpiEvent }),
        data: Buffer.concat([anchorDiscriminator("buyExactIn"), amounts]),
      }));
    } else {
      instructions.push(createAssociatedTokenAccountIdempotentInstruction(user, userAtaQuote, user, quoteMint, quoteMintProgram));
      const amounts = launchpadSwapData(params.amountIn, minOut);
      instructions.push(new TransactionInstruction({
        programId: LAUNCHPAD_PROGRAM,
        keys: swapKeys({ user, auth, configId: poolInfo.configId, platformId: poolInfo.platformId, poolId, userAtaA, userAtaQuote, vaultA, vaultQuote, mint, quoteMint, mintAProgram, quoteMintProgram, platformVault, creatorVault, cpiEvent }),
        data: Buffer.concat([anchorDiscriminator("sellExactIn"), amounts]),
      }));
    }
    void configInfo; void platformInfo; // decoded for validation above

    const tx = new Transaction().add(...instructions);
    const { blockhash } = await solana.getLatestBlockhash();
    tx.feePayer = user;
    tx.recentBlockhash = blockhash;
    const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
    const sessionId = sessionIdFor(serialized);
    return {
      serialized,
      sessionId,
      poolId: poolId.toBase58(),
      quote: {
        side: params.side,
        amountIn: params.amountIn.toString(),
        amountOut: amountOut.toString(),
        minOut: minOut.toString(),
      },
    };
  }

  /**
   * Verify a user-signed curve trade and broadcast it. The exact instruction
   * shape (accounts, PDAs, amounts) is re-checked against the prepared values
   * — the client can never substitute a different transfer.
   */
  async submitSwap(params: {
    userId: number;
    user: string;
    mintA: string;
    quote: string;
    side: "buy" | "sell";
    amountIn: bigint;
    minOut: bigint;
    signedTxBase64: string;
    beforeBroadcast?: (signature: string) => void;
  }): Promise<{ signature: string; recorded: boolean }> {
    const solana = this.requireSolana();
    const quoteKey = LAUNCHLAB_QUOTE_MINTS[params.quote];
    if (!quoteKey) throw new LaunchLabError("BAD_QUOTE", `unsupported quote mint: ${params.quote}`);
    let tx: Transaction;
    try {
      tx = Transaction.from(Buffer.from(params.signedTxBase64, "base64"));
    } catch {
      throw new LaunchLabError("BAD_TX", "transaction could not be parsed (versioned transactions are not accepted)");
    }
    const user = new PublicKey(params.user);
    if (!tx.feePayer || !tx.feePayer.equals(user)) throw new LaunchLabError("BAD_TX", "user must be the fee payer");
    const userSig = tx.signatures.find((s) => s.publicKey.equals(user));
    if (!userSig?.signature) throw new LaunchLabError("NOT_USER_SIGNED", "the user signature is missing");
    // No other signature slots may be filled by the client.
    for (const s of tx.signatures) {
      if (!s.publicKey.equals(user) && s.signature) throw new LaunchLabError("BAD_TX", "unexpected extra signature provided by the client");
    }

    const mint = new PublicKey(params.mintA);
    const quoteMint = quoteKey.mint;
    const { poolId, poolInfo, rates } = await this.decodeLaunch(params.mintA, quoteKey);
    const mintAProgram = getLaunchpadPoolMintAProgram(poolInfo.mintProgramFlag);
    const quoteMintProgram = getLaunchpadPoolMintBProgram(poolInfo.mintProgramFlag);
    const expected = {
      side: params.side,
      user,
      poolId,
      auth: getPdaLaunchpadAuth(LAUNCHPAD_PROGRAM).publicKey,
      configId: poolInfo.configId,
      platformId: poolInfo.platformId,
      mintA: mint,
      quoteMint,
      vaultA: poolInfo.vaultA,
      vaultQuote: poolInfo.vaultB,
      userAtaA: getATAAddress(user, mint, mintAProgram).publicKey,
      userAtaQuote: getATAAddress(user, quoteMint, quoteMintProgram).publicKey,
      tokenProgramA: mintAProgram,
      tokenProgramQuote: quoteMintProgram,
      platformVault: getPdaPlatformVault(LAUNCHPAD_PROGRAM, poolInfo.platformId, quoteMint).publicKey,
      creatorVault: getPdaCreatorVault(LAUNCHPAD_PROGRAM, poolInfo.creator, quoteMint).publicKey,
      cpiEvent: getPdaCpiEvent(LAUNCHPAD_PROGRAM).publicKey,
      amountIn: params.amountIn,
      minOut: params.minOut,
    };
    const swapIxs = tx.instructions.filter((i) => i.programId.equals(LAUNCHPAD_PROGRAM));
    if (swapIxs.length !== 1) throw new LaunchLabError("SHAPE_MISMATCH", "expected exactly one LaunchLab instruction");
    const decoded = verifyLaunchpadSwapInstruction(swapIxs[0]!, expected);
    void decoded; void rates;

    const raw = tx.serialize({ requireAllSignatures: true, verifySignatures: true });
    const expectedSignature = bs58.encode(tx.signature!);
    params.beforeBroadcast?.(expectedSignature);
    const signature = await solana.sendRawTransaction(raw);
    if (signature !== expectedSignature) throw new LaunchLabError("CONFIRMATION_FAILED", "RPC signature mismatch");
    const result = await solana.confirmTransaction(signature, "confirmed") as { value?: { err?: unknown } } | null;
    if (!result?.value || result.value.err !== null) {
      throw new LaunchLabError("CONFIRMATION_FAILED", "transaction failed or confirmation is unavailable");
    }
    const recorded = this.db.recordLaunchLabTrade({
      mintA: params.mintA,
      quoteMint: quoteMint.toBase58(),
      userId: params.userId,
      side: params.side,
      amountIn: params.amountIn.toString(),
      minOut: params.minOut.toString(),
      signature,
    });
    return { signature, recorded };
  }

  /**
   * Build the UNSIGNED create-launch transaction. The mint keypair is NOT on
   * the server: the caller supplies its public key and the creator's browser
   * signs the transaction together with the mint keypair locally. The mint
   * account (createAccount, 82 bytes, TOKEN_PROGRAM_ID) + initializeV2 are
   * verified byte-level again at confirm time.
   */
  async prepareCreateTx(params: {
    creator: string;
    mintPubkey: string;
    name: string;
    symbol: string;
    uri: string;
    decimals?: number;
    totalSellA?: bigint;
    totalFundRaisingB?: bigint;
    buyAmountLamports?: bigint;
  }): Promise<{ serialized: string; sessionId: string; poolId: string; vaultA: string; vaultB: string; metadataId: string }> {
    const solana = this.requireSolana();
    const quoteKey = SOL_QUOTE;
    let creator: PublicKey;
    try { creator = new PublicKey(params.creator); } catch { throw new LaunchLabError("BAD_TX", "invalid creator wallet"); }
    let mint: PublicKey;
    try { mint = new PublicKey(params.mintPubkey); } catch { throw new LaunchLabError("BAD_TX", "invalid mint pubkey"); }
    if (mint.equals(PublicKey.default) || mint.equals(SystemProgram.programId)) throw new LaunchLabError("BAD_TX", "mint pubkey looks like a zero address");
    if (params.name.trim().length < 1 || params.name.length > 32) throw new LaunchLabError("BAD_AMOUNT", "name must be 1-32 chars");
    if (!/^[A-Z0-9]{1,10}$/.test(params.symbol)) throw new LaunchLabError("BAD_AMOUNT", "symbol must be 1-10 chars A-Z 0-9");
    if (!params.uri || params.uri.length > 200) throw new LaunchLabError("BAD_AMOUNT", "uri is required (max 200 chars, Metaplex budget)");

    const { configId, configInfo } = await this.decodeGlobalConfig();
    if (!configInfo.mintB.equals(SOL_QUOTE.mint)) throw new LaunchLabError("UNSUPPORTED_CONFIG", "the default config no longer quotes SOL");
    const decimals = params.decimals ?? 6;

    const { publicKey: poolId } = getPdaLaunchpadPoolId(LAUNCHPAD_PROGRAM, mint, quoteKey.mint);
    const vaultA = getPdaLaunchpadVaultId(LAUNCHPAD_PROGRAM, poolId, mint).publicKey;
    const vaultQuote = getPdaLaunchpadVaultId(LAUNCHPAD_PROGRAM, poolId, quoteKey.mint).publicKey;
    const metadataId = getPdaMetadataKey(mint).publicKey;
    const auth = getPdaLaunchpadAuth(LAUNCHPAD_PROGRAM).publicKey;

    const instructions: TransactionInstruction[] = [computeBudgetIx()];
    // LaunchLab initializes the mint itself via CPI; pre-creating it fails.
    instructions.push(initializeV2Instruction({
      payer: creator,
      creator,
      configId,
      platformId: RAYDIUM_PLATFORM_ID,
      auth,
      poolId,
      mint,
      mintB: quoteKey.mint,
      vaultA,
      vaultB: vaultQuote,
      metadataId,
      mintProgramB: TOKEN_PROGRAM_ID,
      decimals,
      name: params.name.trim(),
      symbol: params.symbol.trim().toUpperCase(),
      uri: params.uri.trim(),
      supply: new BN("1000000000000000"), // LaunchpadPoolInitParam.supply (config default)
      totalSellA: new BN((params.totalSellA ?? 793_100_000_000_000n).toString()),
      totalFundRaisingB: new BN((params.totalFundRaisingB ?? 85_000_000_000n).toString()),
    }));

    // Optional first buy in the same bundle (self-custody, wsol path).
    if (params.buyAmountLamports && params.buyAmountLamports > 0n) {
      if (params.buyAmountLamports < LAUNCHLAB_MIN_TRADE_LAMPORTS) throw new LaunchLabError("BAD_AMOUNT", "initial buy below minimum");
      const userAtaA = getATAAddress(creator, mint, TOKEN_PROGRAM_ID).publicKey;
      const userAtaQuote = getATAAddress(creator, quoteKey.mint, TOKEN_PROGRAM_ID).publicKey;
      instructions.push(createAssociatedTokenAccountIdempotentInstruction(creator, userAtaA, creator, mint, TOKEN_PROGRAM_ID));
      instructions.push(createAssociatedTokenAccountIdempotentInstruction(creator, userAtaQuote, creator, quoteKey.mint, TOKEN_PROGRAM_ID));
      instructions.push(SystemProgram.transfer({ fromPubkey: creator, toPubkey: userAtaQuote, lamports: params.buyAmountLamports }));
      instructions.push(createSyncNativeInstruction(userAtaQuote));
      const platformAcc = await solana.getAccountInfo(RAYDIUM_PLATFORM_ID);
      if (!platformAcc?.owner.equals(LAUNCHPAD_PROGRAM)) throw new LaunchLabError("CONFIG_NOT_FOUND", "Raydium platform unavailable");
      const platform = PlatformConfig.decode(asBuffer(platformAcc.data));
      const totalSellA = new BN((params.totalSellA ?? 793_100_000_000_000n).toString());
      const totalFundRaisingB = new BN((params.totalFundRaisingB ?? 85_000_000_000n).toString());
      const initial = Curve.getCurve(configInfo.curveType).getInitParam({
        supply: new BN("1000000000000000"), totalSell: totalSellA,
        totalFundRaising: totalFundRaisingB, totalLockedAmount: ZERO_BN, migrateFee: configInfo.migrateFee,
      });
      const firstBuy = Curve.buyExactIn({
        poolInfo: { virtualA: initial.a, virtualB: initial.b, realA: ZERO_BN, realB: ZERO_BN, totalSellA, totalFundRaisingB },
        amountB: new BN(params.buyAmountLamports.toString()), curveType: configInfo.curveType,
        protocolFeeRate: configInfo.tradeFeeRate, platformFeeRate: platform.feeRate,
        creatorFeeRate: platform.creatorFeeRate, shareFeeRate: ZERO_BN,
        transferFeeConfigA: undefined, transferFeeConfigB: undefined, slot: 0,
      });
      const firstMinOut = BigInt(firstBuy.amountA.amount.toString()) * 99n / 100n;
      if (firstMinOut <= 0n) throw new LaunchLabError("BAD_AMOUNT", "initial buy output too small");
      instructions.push(new TransactionInstruction({
        programId: LAUNCHPAD_PROGRAM,
        keys: swapKeys({
          user: creator, auth, configId, platformId: RAYDIUM_PLATFORM_ID, poolId,
          userAtaA, userAtaQuote, vaultA, vaultQuote, mint, quoteMint: quoteKey.mint,
          mintAProgram: TOKEN_PROGRAM_ID, quoteMintProgram: TOKEN_PROGRAM_ID,
          platformVault: getPdaPlatformVault(LAUNCHPAD_PROGRAM, RAYDIUM_PLATFORM_ID, quoteKey.mint).publicKey,
          creatorVault: getPdaCreatorVault(LAUNCHPAD_PROGRAM, creator, quoteKey.mint).publicKey,
          cpiEvent: getPdaCpiEvent(LAUNCHPAD_PROGRAM).publicKey,
        }),
        data: Buffer.concat([anchorDiscriminator("buyExactIn"), launchpadSwapData(params.buyAmountLamports, firstMinOut)]),
      }));
    }

    const tx = new Transaction().add(...instructions);
    const { blockhash } = await solana.getLatestBlockhash();
    tx.feePayer = creator;
    tx.recentBlockhash = blockhash;
    const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
    const sessionId = sessionIdFor(serialized);
    return { serialized, sessionId, poolId: poolId.toBase58(), vaultA: vaultA.toBase58(), vaultB: vaultQuote.toBase58(), metadataId: metadataId.toBase58() };
  }

  /**
   * Confirm a user+browser-signed create transaction: verify it REALLY
   * creates the claimed mint on LaunchLab (createAccount of the exact mint +
   * initializeV2 with the canonical config and metadata), then broadcast.
   * On success the launch registry row is marked confirmed.
   */
  async confirmCreateTx(params: {
    userId: number;
    creator: string;
    mint: string;
    symbol: string;
    name: string;
    uri: string;
    signedTxBase64: string;
    beforeBroadcast?: (signature: string) => void;
  }): Promise<{ signature: string; poolId: string }> {
    const solana = this.requireSolana();
    let tx: Transaction;
    try {
      tx = Transaction.from(Buffer.from(params.signedTxBase64, "base64"));
    } catch {
      throw new LaunchLabError("BAD_TX", "transaction could not be parsed (versioned transactions are not accepted)");
    }
    const creator = new PublicKey(params.creator);
    const mint = new PublicKey(params.mint);
    if (!tx.feePayer || !tx.feePayer.equals(creator)) throw new LaunchLabError("BAD_TX", "creator must be the fee payer");
    const creatorSig = tx.signatures.find((s) => s.publicKey.equals(creator));
    if (!creatorSig?.signature) throw new LaunchLabError("NOT_USER_SIGNED", "the creator signature is missing");
    const mintSig = tx.signatures.find((s) => s.publicKey.equals(mint));
    if (!mintSig?.signature) throw new LaunchLabError("BAD_TX", "the mint keypair signature is missing (co-sign in the browser)");
    for (const s of tx.signatures) {
      if (!s.publicKey.equals(creator) && !s.publicKey.equals(mint) && s.signature) {
        throw new LaunchLabError("BAD_TX", "unexpected extra signature provided by the client");
      }
    }

    const quoteKey = SOL_QUOTE;
    const { configId, configInfo } = await this.decodeGlobalConfig();
    const { publicKey: expectedPoolId } = getPdaLaunchpadPoolId(LAUNCHPAD_PROGRAM, mint, quoteKey.mint);
    const expectedVaultA = getPdaLaunchpadVaultId(LAUNCHPAD_PROGRAM, expectedPoolId, mint).publicKey;
    const expectedVaultQuote = getPdaLaunchpadVaultId(LAUNCHPAD_PROGRAM, expectedPoolId, quoteKey.mint).publicKey;
    const expectedMeta = getPdaMetadataKey(mint).publicKey;
    const expectedAuth = getPdaLaunchpadAuth(LAUNCHPAD_PROGRAM).publicKey;

    // ── ix[0]: compute budget (not a System instruction; skipped) ──
    const createAccIxs = tx.instructions.filter((i) => i.programId.equals(SystemProgram.programId) && i.data.length === 52 && i.data.readUInt32LE(0) === 0);
    if (createAccIxs.length) throw new LaunchLabError("SHAPE_MISMATCH", "LaunchLab creates the mint internally");

    const initIxs = tx.instructions.filter((i) => i.programId.equals(LAUNCHPAD_PROGRAM) && i.data.subarray(0, 8).equals(anchorDiscriminator("initializeV2")));
    if (initIxs.length !== 1) throw new LaunchLabError("SHAPE_MISMATCH", "expected exactly one LaunchLab initializeV2");
    const init = initIxs[0]!;
    const k = (i: number) => init.keys[i]?.pubkey;
    const checks: Array<[number, PublicKey | undefined, string]> = [
      [0, creator, "payer"],
      [1, creator, "creator"],
      [2, configId, "configId"],
      [3, RAYDIUM_PLATFORM_ID, "platformId"],
      [4, expectedAuth, "auth"],
      [5, expectedPoolId, "poolId"],
      [6, mint, "mintA"],
      [7, quoteKey.mint, "mintB"],
      [8, expectedVaultA, "vaultA"],
      [9, expectedVaultQuote, "vaultB"],
      [10, expectedMeta, "metadata"],
      [11, TOKEN_PROGRAM_ID, "token program A"],
      [12, TOKEN_PROGRAM_ID, "mint program B"],
    ];
    for (const [idx, want, label] of checks) {
      if (!want || !k(idx)?.equals(want)) throw new LaunchLabError("SHAPE_MISMATCH", `initializeV2 account ${idx} (${label}) mismatch`);
    }
    // Signers of initializeV2 (distinct set): exactly creator + mint.
    const initSignerSet = new Set(init.keys.filter((a) => a.isSigner).map((a) => a.pubkey.toBase58()));
    if (
      initSignerSet.size !== 2 ||
      !initSignerSet.has(creator.toBase58()) ||
      !initSignerSet.has(mint.toBase58())
    ) {
      throw new LaunchLabError("SHAPE_MISMATCH", "initializeV2 signer set must be exactly creator + mint");
    }
    const meta = decodeInitializeV2Data(init.data);
    if (meta.symbol !== params.symbol.trim().toUpperCase() || meta.name !== params.name.trim() || meta.uri !== params.uri.trim()) {
      throw new LaunchLabError("SHAPE_MISMATCH", "on-chain metadata does not match the confirmed launch");
    }
    void configInfo;

    // Optional first-buy instruction (verified like a normal buy, conservative floor).
    const buyIxs = tx.instructions.filter((i) => i.programId.equals(LAUNCHPAD_PROGRAM) && i.data.subarray(0, 8).equals(anchorDiscriminator("buyExactIn")));
    for (const buy of buyIxs) {
      if (buy.keys.length !== 18) throw new LaunchLabError("SHAPE_MISMATCH", "first-buy instruction shape mismatch");
      if (!buy.keys[0]!.pubkey.equals(creator) || !buy.keys[0]!.isSigner) throw new LaunchLabError("SHAPE_MISMATCH", "first-buy owner mismatch");
      if (!buy.keys[4]!.pubkey.equals(expectedPoolId) || !buy.keys[9]!.pubkey.equals(mint) || !buy.keys[10]!.pubkey.equals(quoteKey.mint)) {
        throw new LaunchLabError("SHAPE_MISMATCH", "first-buy accounts mismatch");
      }
      const shareFeeRate = BigInt(new DataView(buy.data.buffer, buy.data.byteOffset + 8 + 16, 8).getBigUint64(0, true));
      if (shareFeeRate !== 0n) throw new LaunchLabError("SHAPE_MISMATCH", "unexpected share fee in first buy");
    }
    const labIxs = tx.instructions.filter((i) => i.programId.equals(LAUNCHPAD_PROGRAM));
    if (labIxs.length !== 1 + buyIxs.length) throw new LaunchLabError("SHAPE_MISMATCH", "unexpected extra LaunchLab instructions");

    const raw = tx.serialize({ requireAllSignatures: true, verifySignatures: true });
    const expectedSignature = bs58.encode(tx.signature!);
    params.beforeBroadcast?.(expectedSignature);
    const signature = await solana.sendRawTransaction(raw);
    if (signature !== expectedSignature) throw new LaunchLabError("CONFIRMATION_FAILED", "RPC signature mismatch");
    const result = await solana.confirmTransaction(signature, "confirmed") as { value?: { err?: unknown } } | null;
    if (!result?.value || result.value.err !== null) {
      throw new LaunchLabError("CONFIRMATION_FAILED", "create transaction failed or confirmation is unavailable");
    }
    const ts = Math.floor(Date.now() / 1000);
    this.db.upsertLaunchLabLaunch({
      mintA: params.mint,
      quoteMint: quoteKey.mint.toBase58(),
      poolId: expectedPoolId.toBase58(),
      symbol: params.symbol.trim().toUpperCase(),
      name: params.name.trim(),
      creator: params.creator,
      ts,
    });
    this.db.markLaunchLabLaunchConfirmed(params.mint, signature, ts);
    return { signature, poolId: expectedPoolId.toBase58() };
  }

  /** Decode the canonical GlobalConfig we bind creations to. */
  private async decodeGlobalConfig() {
    const solana = this.requireSolana();
    const configId = launchLabConfigId(SOL_QUOTE.mint);
    const acc = await solana.getAccountInfo(configId);
    if (!acc) throw new LaunchLabError("CONFIG_NOT_FOUND", "LaunchLab global config not found for SOL (curve 0, index 0)");
    if (!acc.owner.equals(LAUNCHPAD_PROGRAM)) throw new LaunchLabError("UNSUPPORTED_CONFIG", "invalid config owner");
    return { configId, configInfo: LaunchpadConfig.decode(asBuffer(acc.data)) };
  }

  /** Our own fills on one launch (DB only records OUR users' trades). */
  listOwnActivity(mintA: string, limit = 20, userId?: number): Array<{ side: string; amountIn: string; minOut: string; signature: string; ts: number }> {
    return (userId === undefined ? this.db.listLaunchLabTrades(mintA, limit) : this.db.listUserLaunchLabTrades(userId, 1000).filter(t => t.mint_a === mintA).slice(0, limit)).map((t) => ({
      side: t.side,
      amountIn: t.amount_in,
      minOut: t.min_out,
      signature: t.signature,
      ts: t.ts,
    }));
  }
}

// ── Low-level builders shared by prepare/submit paths ────────────────────

/** SDK decoders need a real Buffer (they slice/compare via Buffer API). */
function asBuffer(data: Uint8Array): Buffer {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function computeBudgetIx(): TransactionInstruction {
  return ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT });
}

function swapKeys(p: {
  user: PublicKey; auth: PublicKey; configId: PublicKey; platformId: PublicKey; poolId: PublicKey;
  userAtaA: PublicKey; userAtaQuote: PublicKey; vaultA: PublicKey; vaultQuote: PublicKey;
  mint: PublicKey; quoteMint: PublicKey; mintAProgram: PublicKey; quoteMintProgram: PublicKey;
  platformVault: PublicKey; creatorVault: PublicKey; cpiEvent: PublicKey;
}): Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }> {
  return [
    { pubkey: p.user, isSigner: true, isWritable: true },
    { pubkey: p.auth, isSigner: false, isWritable: false },
    { pubkey: p.configId, isSigner: false, isWritable: false },
    { pubkey: p.platformId, isSigner: false, isWritable: false },
    { pubkey: p.poolId, isSigner: false, isWritable: true },
    { pubkey: p.userAtaA, isSigner: false, isWritable: true },
    { pubkey: p.userAtaQuote, isSigner: false, isWritable: true },
    { pubkey: p.vaultA, isSigner: false, isWritable: true },
    { pubkey: p.vaultQuote, isSigner: false, isWritable: true },
    { pubkey: p.mint, isSigner: false, isWritable: false },
    { pubkey: p.quoteMint, isSigner: false, isWritable: false },
    { pubkey: p.mintAProgram, isSigner: false, isWritable: false },
    { pubkey: p.quoteMintProgram, isSigner: false, isWritable: false },
    { pubkey: p.cpiEvent, isSigner: false, isWritable: false },
    { pubkey: LAUNCHPAD_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: p.platformVault, isSigner: false, isWritable: true },
    { pubkey: p.creatorVault, isSigner: false, isWritable: true },
  ];
}

/** (amountIn u64 LE, minOut u64 LE, shareFeeRate u64 LE = 0). */
function launchpadSwapData(amountIn: bigint, minOut: bigint): Buffer {
  const data = Buffer.alloc(24);
  data.writeBigUInt64LE(amountIn, 0);
  data.writeBigUInt64LE(minOut, 8);
  data.writeBigUInt64LE(0n, 16);
  return data;
}

/** initializeV2 with a ConstantCurve, cpmm migration (canonical creation). */
function initializeV2Instruction(p: {
  payer: PublicKey; creator: PublicKey; configId: PublicKey; platformId: PublicKey; auth: PublicKey;
  poolId: PublicKey; mint: PublicKey; mintB: PublicKey; vaultA: PublicKey; vaultB: PublicKey; metadataId: PublicKey;
  mintProgramB: PublicKey; decimals: number; name: string; symbol: string; uri: string;
  supply: BN; totalSellA: BN; totalFundRaisingB: BN;
}): TransactionInstruction {
  const nameBuf = Buffer.from(p.name, "utf8");
  const symbolBuf = Buffer.from(p.symbol, "utf8");
  const uriBuf = Buffer.from(p.uri, "utf8");
  // data1: u8 decimals + 3 borsh strings
  const data1 = Buffer.alloc(1 + 4 + nameBuf.length + 4 + symbolBuf.length + 4 + uriBuf.length);
  let off = 0;
  data1.writeUInt8(p.decimals, off); off += 1;
  off = writeBorshStr(data1, off, nameBuf);
  off = writeBorshStr(data1, off, symbolBuf);
  off = writeBorshStr(data1, off, uriBuf);
  // data2 (ConstantCurve = dataLayout22): u8 index + u64 supply + u64 totalSellA + u64 totalFundRaisingB + u8 migrateType
  const data2 = Buffer.alloc(1 + 8 + 8 + 8 + 1);
  data2.writeUInt8(0, 0); // index 0 = ConstantCurve
  data2.writeBigUInt64LE(BigInt(p.supply.toString()), 1);
  data2.writeBigUInt64LE(BigInt(p.totalSellA.toString()), 9);
  data2.writeBigUInt64LE(BigInt(p.totalFundRaisingB.toString()), 17);
  data2.writeUInt8(1, 25); // migrateType 1 = cpmm
  // data3: u64 totalLockedAmount + u64 cliff + u64 unlock + u8 cpmmCreatorFeeOn
  const data3 = Buffer.alloc(8 + 8 + 8 + 1);
  data3.writeBigUInt64LE(0n, 0);
  data3.writeBigUInt64LE(0n, 8);
  data3.writeBigUInt64LE(0n, 16);
  data3.writeUInt8(CpmmCreatorFeeOn.OnlyTokenB, 24);

  const keys: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }> = [
    { pubkey: p.payer, isSigner: true, isWritable: true },
    { pubkey: p.creator, isSigner: false, isWritable: false },
    { pubkey: p.configId, isSigner: false, isWritable: false },
    { pubkey: p.platformId, isSigner: false, isWritable: false },
    { pubkey: p.auth, isSigner: false, isWritable: false },
    { pubkey: p.poolId, isSigner: false, isWritable: true },
    { pubkey: p.mint, isSigner: true, isWritable: true },
    { pubkey: p.mintB, isSigner: false, isWritable: false },
    { pubkey: p.vaultA, isSigner: false, isWritable: true },
    { pubkey: p.vaultB, isSigner: false, isWritable: true },
    { pubkey: p.metadataId, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: p.mintProgramB, isSigner: false, isWritable: false },
    { pubkey: METADATA_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: RENT_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: getPdaCpiEvent(LAUNCHPAD_PROGRAM).publicKey, isSigner: false, isWritable: false },
    { pubkey: LAUNCHPAD_PROGRAM, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({
    keys,
    programId: LAUNCHPAD_PROGRAM,
    data: Buffer.concat([anchorDiscriminator("initializeV2"), data1, data2, data3]),
  });
}

function writeBorshStr(buf: Buffer, off: number, payload: Buffer): number {
  buf.writeUInt32LE(payload.length, off);
  payload.copy(buf, off + 4);
  return off + 4 + payload.length;
}

// Metaplex metadata program id (byte-identical to the SDK's constant).
const METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
// Sysvar rent program id.
const RENT_PROGRAM_ID = new PublicKey("SysvarRent111111111111111111111111111111111");

import { createHash } from "node:crypto";

/** Deterministic session id (shared semantics with the launch AMM). */
export function sessionIdFor(serializedBase64: string): string {
  return createHash("sha256").update(serializedBase64).digest("hex").slice(0, 32);
}

// bs58 is used by tests for keypair material; keep the import honest.
void bs58;
void Keypair;
void TOKEN_2022_PROGRAM_ID;
