/**
 * 🏊 RAYDIUM CPMM — real post-graduation market, self-custody.
 *
 * Honesty contract (matches launch-raydium.ts):
 * - LaunchLab migrates graduating curves to Raydium CPMM (program
 *   CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C) by program crank. Once
 *   migrated, the REAL liquidity lives in that CPMM pool. This module READS
 *   the on-chain pool/config/vault accounts (SDK layouts) and helps users
 *   SIGN swap transactions in their own wallet. No custody, no invented state.
 * - Quotes use the SDK's `CurveCalculator.swapBaseInput` with the EXACT
 *   reserves rule (vault balance minus protocol/fund/creator fees accrued in
 *   the pool account) and the pool's own fee rates.
 * - prepare/submit follows the durable exactly-once session pattern: session
 *   id = hash of the unsigned serialized message; submit re-verifies the
 *   signed transaction byte-for-byte (accounts, PDAs, amounts) against the
 *   prepared values, so a malicious client can never swap in a different
 *   transfer.
 * - The user is always fee payer and the only signer. The pool authority PDA
 *   never signs client-side (extra client signatures are rejected).
 *
 * Unsupported by design (rejected, never guessed):
 * - baseOut / exact-output swaps (only exact-input is wired).
 * - EVM: CPMM is Solana-only.
 */

import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  NATIVE_MINT,
  unpackMint,
  getTransferFeeConfig,
} from "@solana/spl-token";
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

/** Raydium CPMM program (where LaunchLab migrates to). */
export const CPMM_PROGRAM = new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");

/** swapBaseInput anchor discriminator (8 bytes, from the CPMM IDL). */
export const CPMM_SWAP_BASE_IN_DISCRIMINATOR = Buffer.from([143, 190, 90, 218, 196, 30, 51, 222]);

/** Canonical LaunchLab→CPMM migration: ammConfig index 0. */
export const CPMM_MIGRATION_CONFIG_INDEX = 0;

export interface CpmmLike {
  getAccountInfo(address: PublicKey): Promise<{ owner: PublicKey; lamports: number; data: Uint8Array } | null>;
  getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  sendRawTransaction(raw: Uint8Array): Promise<string>;
  confirmTransaction(signature: string, commitment?: string): Promise<unknown>;
}

/**
 * Validates a token-2022 MINT account before swaps touch it. Must reject
 * extensions that silently alter transfer amounts (transfer fee) or let a
 * third party move funds (delegated authority). `null` = not token-2022.
 * Implemented with @solana/spl-token's official unpackMint by default.
 */
export interface MintGuard {
  assertTradableMint2022(mint: PublicKey, account: { owner: PublicKey; data: Uint8Array }): void;
}

export function splTokenMintGuard(): MintGuard {
  return {
    assertTradableMint2022(mint, account) {
      const decoded = unpackMint(mint, { owner: account.owner, data: Buffer.from(account.data.buffer, account.data.byteOffset, account.data.byteLength), lamports: 1, executable: false, rentEpoch: 0 }, account.owner);
      const feeCfg = getTransferFeeConfig(decoded);
      if (feeCfg && (feeCfg.olderTransferFee.transferFeeBasisPoints > 0 || feeCfg.newerTransferFee.transferFeeBasisPoints > 0)) {
        throw new CpmmError("BAD_MINT", "token-2022 transfer fee is not supported for direct CPMM swaps");
      }
      if (decoded.mintAuthority !== null) throw new CpmmError("BAD_MINT", "token still has a mint authority (supply can change)");
      if (decoded.freezeAuthority !== null) throw new CpmmError("BAD_MINT", "token still has a freeze authority");
    },
  };
}

export interface CpmmDb {
  recordLaunchLabTrade(row: { mintA: string; quoteMint: string; userId: number; side: "buy" | "sell"; amountIn: string; minOut: string; signature: string; ts?: number }): boolean;
  listUserLaunchLabTrades(userId: number, limit?: number): Array<{ mint_a: string; side: string; amount_in: string; min_out: string; signature: string; ts: number }>;
}

export class CpmmError extends Error {
  constructor(
    public readonly code:
      | "RPC_DISABLED"
      | "POOL_NOT_FOUND"
      | "CONFIG_NOT_FOUND"
      | "POOL_DISABLED"
      | "BAD_AMOUNT"
      | "BAD_MINT"
      | "BAD_TX"
      | "NOT_USER_SIGNED"
      | "SHAPE_MISMATCH"
      | "CONFIRMATION_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "CpmmError";
  }
}

const COMPUTE_UNIT_LIMIT = 300_000;
/** A prepared session stops being submittable after this long (ms). */
export const CPMM_SESSION_TTL_MS = 10 * 60_000;

// ── Pure helpers (unit-testable, no I/O) ─────────────────────────────────

export type CpmmPoolInfo = ReturnType<typeof CpmmPoolInfoLayout.decode>;
export type CpmmConfigInfo = ReturnType<typeof CpmmConfigInfoLayout.decode>;

/**
 * Reserves the program actually trades against: vault minus accrued fees.
 * baseReserve = LAUNCH TOKEN side, quoteReserve = WRAPPED SOL side, regardless
 * of which pool side each mint occupies (real migrations put WSOL on side A).
 */
export function effectiveReserves(pool: CpmmPoolInfo, vaultA: bigint, vaultB: bigint): { baseReserve: bigint; quoteReserve: bigint } {
  const tokenIsPoolA = !pool.mintA.equals(NATIVE_MINT);
  const base = BigInt(tokenIsPoolA ? vaultA : vaultB)
    - BigInt(pool.protocolFeesMintA.toString()) * (tokenIsPoolA ? 1n : 0n)
    - BigInt(pool.fundFeesMintA.toString()) * (tokenIsPoolA ? 1n : 0n)
    - BigInt(pool.creatorFeesMintA.toString()) * (tokenIsPoolA ? 1n : 0n)
    - BigInt(pool.protocolFeesMintB.toString()) * (tokenIsPoolA ? 0n : 1n)
    - BigInt(pool.fundFeesMintB.toString()) * (tokenIsPoolA ? 0n : 1n)
    - BigInt(pool.creatorFeesMintB.toString()) * (tokenIsPoolA ? 0n : 1n);
  const quote = BigInt(tokenIsPoolA ? vaultB : vaultA)
    - BigInt(pool.protocolFeesMintA.toString()) * (tokenIsPoolA ? 0n : 1n)
    - BigInt(pool.fundFeesMintA.toString()) * (tokenIsPoolA ? 0n : 1n)
    - BigInt(pool.creatorFeesMintA.toString()) * (tokenIsPoolA ? 0n : 1n)
    - BigInt(pool.protocolFeesMintB.toString()) * (tokenIsPoolA ? 1n : 0n)
    - BigInt(pool.fundFeesMintB.toString()) * (tokenIsPoolA ? 1n : 0n)
    - BigInt(pool.creatorFeesMintB.toString()) * (tokenIsPoolA ? 1n : 0n);
  if (base < 0n || quote < 0n) throw new CpmmError("POOL_NOT_FOUND", "pool reserves underflow (corrupt pool state)");
  return { baseReserve: base, quoteReserve: quote };
}

/** Off-chain exact-input preview (exact program math, no I/O). */
export function quoteSwapPure(
  pool: CpmmPoolInfo,
  config: CpmmConfigInfo,
  reserves: { baseReserve: bigint; quoteReserve: bigint },
  side: "buy" | "sell",
  amountIn: bigint,
  slippageBps: number,
): { amountOut: bigint; minOut: bigint; tradeFee: bigint } {
  if (slippageBps < 0 || slippageBps > 5000 || !Number.isInteger(slippageBps)) throw new CpmmError("BAD_AMOUNT", "slippageBps must be 0..5000");
  if (amountIn <= 0n || amountIn > 0xffffffffffffffffn) throw new CpmmError("BAD_AMOUNT", "amountIn must be positive");
  // buy = quote(SOL) in → token out; sell = token in → SOL out.
  // feeOn refers to POOL mints: 0 BothToken, 1 OnlyTokenA, 2 OnlyTokenB —
  // map the actual input side (SOL for buys, token for sells) to the pool side.
  const tokenIsPoolA = !pool.mintA.equals(NATIVE_MINT);
  const inputIsPoolA = side === "buy" ? !tokenIsPoolA : tokenIsPoolA;
  const isCreatorFeeOnInput = pool.feeOn === 0 /* BothToken */ || (inputIsPoolA ? pool.feeOn === 1 : pool.feeOn === 2);
  const res = CurveCalculator.swapBaseInput(
    new BN(amountIn.toString()),
    side === "sell" ? new BN(reserves.baseReserve.toString()) : new BN(reserves.quoteReserve.toString()),
    side === "sell" ? new BN(reserves.quoteReserve.toString()) : new BN(reserves.baseReserve.toString()),
    config.tradeFeeRate,
    pool.enableCreatorFee ? config.creatorFeeRate : new BN(0),
    config.protocolFeeRate,
    config.fundFeeRate,
    isCreatorFeeOnInput,
  );
  const out = BigInt(res.outputAmount.toString());
  if (out <= 0n) throw new CpmmError("BAD_AMOUNT", "amount too small — zero output");
  const minOut = (out * BigInt(10_000 - slippageBps)) / 10_000n;
  return { amountOut: out, minOut, tradeFee: BigInt(res.tradeFee.toString()) };
}

/** Deterministic CPMM pool id for a migrated LaunchLab token (A=token, B=WSOL). */
export function deriveCpmmPoolId(mintA: PublicKey, mintB: PublicKey, configIndex = CPMM_MIGRATION_CONFIG_INDEX): { poolId: PublicKey; configId: PublicKey } {
  const configId = getCpmmPdaAmmConfigId(CPMM_PROGRAM, configIndex).publicKey;
  const poolId = getCpmmPdaPoolId(CPMM_PROGRAM, configId, mintA, mintB).publicKey;
  return { poolId, configId };
}

export interface CpmmState {
  poolId: string;
  configId: string;
  status: number;
  mintA: string;
  mintB: string;
  mintProgramA: string;
  mintProgramB: string;
  vaultA: string;
  vaultB: string;
  baseReserve: string;
  quoteReserve: string;
  priceBaseInQuote: string | null;
  tradeFeeRate: number;
  protocolFeeRate: number;
  fundFeeRate: number;
  creatorFeeRate: number;
  feeOn: number;
}

// ── Service ──────────────────────────────────────────────────────────────

export class LaunchCpmm {
  constructor(
    private readonly solana: CpmmLike | null,
    private readonly db: CpmmDb,
    private readonly mintGuard: MintGuard = splTokenMintGuard(),
  ) {}

  private requireSolana(): NonNullable<CpmmLike> {
    if (!this.solana) throw new CpmmError("RPC_DISABLED", "no Solana endpoint configured for CPMM");
    return this.solana;
  }

  private async getAccountData(address: PublicKey, what: string): Promise<{ owner: PublicKey; data: Buffer }> {
    const info = await this.requireSolana().getAccountInfo(address);
    if (!info) throw new CpmmError("POOL_NOT_FOUND", `${what} not found on-chain: ${address.toBase58()}`);
    return { owner: info.owner, data: Buffer.from(info.data.buffer, info.data.byteOffset, info.data.byteLength) };
  }

  /** Read + decode the real on-chain pool for a migrated LaunchLab token. */
  async decodePool(mintA: string): Promise<{
    poolId: PublicKey;
    configId: PublicKey;
    pool: CpmmPoolInfo;
    config: CpmmConfigInfo;
    vaultA: bigint;
    vaultB: bigint;
    mintAProgram: PublicKey;
    mintBProgram: PublicKey;
    /** true when the launch token occupies the pool's mintA side. */
    tokenIsPoolA: boolean;
    reserves: { baseReserve: bigint; quoteReserve: bigint };
  }> {
    let mint: PublicKey;
    try { mint = new PublicKey(mintA); } catch { throw new CpmmError("BAD_MINT", "invalid token mint"); }
    if (mint.equals(NATIVE_MINT)) throw new CpmmError("BAD_MINT", "the launch token cannot be wrapped SOL");
    // Token-2022 gate: extensions that alter transfer amounts or freeze funds
    // make direct swaps unsafe — reject before any quote/tx is built.
    const mintAcc = await this.getAccountData(mint, "launch token mint");
    if (!mintAcc.owner.equals(TOKEN_PROGRAM_ID)) {
      this.mintGuard.assertTradableMint2022(mint, { owner: mintAcc.owner, data: mintAcc.data });
    }
    const { configId } = deriveCpmmPoolId(mint, NATIVE_MINT);
    // Verified on mainnet (2026-09): LaunchLab migrations create the CPMM pool
    // with WSOL as pool mintA. Try that first, then the reversed order; the
    // decoded account itself decides — never an assumption.
    const candidates = [deriveCpmmPoolId(NATIVE_MINT, mint).poolId, deriveCpmmPoolId(mint, NATIVE_MINT).poolId];
    let poolRaw: { owner: PublicKey; data: Buffer } | null = null;
    let poolId: PublicKey | null = null;
    for (const candidate of candidates) {
      try {
        const raw = await this.getAccountData(candidate, "CPMM pool");
        if (raw.owner.equals(CPMM_PROGRAM)) { poolRaw = raw; poolId = candidate; break; }
      } catch (err) {
        if (!(err instanceof CpmmError)) throw err;
      }
    }
    if (!poolRaw || !poolId) throw new CpmmError("POOL_NOT_FOUND", "this token has no CPMM pool (not migrated from LaunchLab)");
    const pool = CpmmPoolInfoLayout.decode(poolRaw.data);
    const tokenIsPoolA = pool.mintA.equals(mint);
    if (!(tokenIsPoolA ? pool.mintB.equals(NATIVE_MINT) : pool.mintA.equals(NATIVE_MINT))) {
      throw new CpmmError("POOL_NOT_FOUND", "pool does not match the expected token pair");
    }
    if (pool.configId.toBase58() !== configId.toBase58()) throw new CpmmError("CONFIG_NOT_FOUND", "pool config mismatch");
    const configRaw = await this.getAccountData(configId, "CPMM config");
    if (!configRaw.owner.equals(CPMM_PROGRAM)) throw new CpmmError("CONFIG_NOT_FOUND", "CPMM config account is not owned by the CPMM program");
    const config = CpmmConfigInfoLayout.decode(configRaw.data);
    const vaultARaw = await this.getAccountData(pool.vaultA, "vault A");
    const vaultBRaw = await this.getAccountData(pool.vaultB, "vault B");
    // SPL token account: amount is u64 LE at offset 64.
    const vaultA = BigInt(vaultARaw.data.readBigUInt64LE(64).toString());
    const vaultB = BigInt(vaultBRaw.data.readBigUInt64LE(64).toString());
    const reserves = effectiveReserves(pool, vaultA, vaultB);
    const mintAProgram = pool.mintProgramA.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    const mintBProgram = pool.mintProgramB.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    return { poolId, configId, pool, config, vaultA, vaultB, mintAProgram, mintBProgram, tokenIsPoolA, reserves };
  }

  async state(mintA: string): Promise<CpmmState> {
    const { poolId, configId, pool, config, reserves, tokenIsPoolA } = await this.decodePool(mintA);
    // Price of 1 launch token in SOL (constant product, reserves only).
    const tokenDecimals = tokenIsPoolA ? pool.mintDecimalA : pool.mintDecimalB;
    const solDecimals = tokenIsPoolA ? pool.mintDecimalB : pool.mintDecimalA;
    const price = reserves.baseReserve > 0n
      ? Number(reserves.quoteReserve) / Number(reserves.baseReserve) * 10 ** (tokenDecimals - solDecimals)
      : null;
    return {
      poolId: poolId.toBase58(),
      configId: configId.toBase58(),
      status: pool.status,
      // Canonical API semantics: mintA = launch token, mintB = wrapped SOL.
      mintA,
      mintB: NATIVE_MINT.toBase58(),
      mintProgramA: (tokenIsPoolA ? pool.mintProgramA : pool.mintProgramB).toBase58(),
      mintProgramB: (tokenIsPoolA ? pool.mintProgramB : pool.mintProgramA).toBase58(),
      vaultA: (tokenIsPoolA ? pool.vaultA : pool.vaultB).toBase58(),
      vaultB: (tokenIsPoolA ? pool.vaultB : pool.vaultA).toBase58(),
      baseReserve: reserves.baseReserve.toString(),
      quoteReserve: reserves.quoteReserve.toString(),
      priceBaseInQuote: price === null ? null : String(price),
      tradeFeeRate: config.tradeFeeRate.toNumber(),
      protocolFeeRate: config.protocolFeeRate.toNumber(),
      fundFeeRate: config.fundFeeRate.toNumber(),
      creatorFeeRate: config.creatorFeeRate.toNumber(),
      feeOn: pool.feeOn,
    };
  }

  async quote(mintA: string, side: "buy" | "sell", amountIn: bigint, slippageBps: number) {
    const { pool, config, reserves } = await this.decodePool(mintA);
    if ((pool.status & 4) !== 0 || BigInt(pool.openTime.toString()) > BigInt(Math.floor(Date.now() / 1000))) throw new CpmmError("POOL_DISABLED", "the pool is not open for swaps");
    const q = quoteSwapPure(pool, config, reserves, side, amountIn, slippageBps);
    return { side, amountIn: amountIn.toString(), amountOut: q.amountOut.toString(), minOut: q.minOut.toString(), tradeFee: q.tradeFee.toString() };
  }

  /**
   * Build the UNSIGNED CPMM swap transaction. The user is fee payer and the
   * only signer. Session id = hash of the exact serialized message.
   */
  async prepareSwap(params: {
    user: string;
    mintA: string;
    side: "buy" | "sell";
    amountIn: bigint;
    slippageBps: number;
  }): Promise<{ serialized: string; sessionId: string; poolId: string; quote: Record<string, string> }> {
    const solana = this.requireSolana();
    const { poolId, pool, config, reserves, mintAProgram, mintBProgram, tokenIsPoolA } = await this.decodePool(params.mintA);
    // The swap's output side must accept what the pool pays out: with the real
    // migration orientation the token sits on pool side B, so a BUY delivers
    // token-2022 balances — extra scrutiny on that program before building txs.
    if (!tokenIsPoolA && params.side === "buy") {
      const mintAcc = await this.getAccountData(new PublicKey(params.mintA), "launch token mint");
      this.mintGuard.assertTradableMint2022(new PublicKey(params.mintA), { owner: mintAcc.owner, data: mintAcc.data });
    }
    if ((pool.status & 4) !== 0 || BigInt(pool.openTime.toString()) > BigInt(Math.floor(Date.now() / 1000))) throw new CpmmError("POOL_DISABLED", "the pool is not open for swaps");
    let user: PublicKey;
    try { user = new PublicKey(params.user); } catch { throw new CpmmError("BAD_TX", "invalid user wallet"); }
    const q = quoteSwapPure(pool, config, reserves, params.side, params.amountIn, params.slippageBps);
    if (q.minOut <= 0n) throw new CpmmError("BAD_AMOUNT", "amount too small — slippage floor is zero");

    const mint = new PublicKey(params.mintA);
    const baseIn = params.side === "sell";
    const inputMint = baseIn ? mint : NATIVE_MINT;
    const outputMint = baseIn ? NATIVE_MINT : mint;
    // Orientation-aware side mapping (real migrations put WSOL on pool side A).
    const tokenProgram = tokenIsPoolA ? mintAProgram : mintBProgram;
    const solProgram = tokenIsPoolA ? mintBProgram : mintAProgram;
    const tokenVault = tokenIsPoolA ? pool.vaultA : pool.vaultB;
    const solVault = tokenIsPoolA ? pool.vaultB : pool.vaultA;
    const inputProgram = baseIn ? tokenProgram : solProgram;
    const outputProgram = baseIn ? solProgram : tokenProgram;
    const inputVault = baseIn ? tokenVault : solVault;
    const outputVault = baseIn ? solVault : tokenVault;
    const userAtaIn = getATA(user, inputMint, inputProgram);
    const userAtaOut = getATA(user, outputMint, outputProgram);

    const instructions: TransactionInstruction[] = [computeBudgetIx()];
    // Both ATAs are created idempotently (the swap instruction does not create
    // accounts). A wsol INPUT is funded with the exact amount and synced;
    // a wsol OUTPUT is left open (the user keeps the rent — no hidden close).
    instructions.push(createAssociatedTokenAccountIdempotentInstruction(user, userAtaIn, user, inputMint, inputProgram));
    instructions.push(createAssociatedTokenAccountIdempotentInstruction(user, userAtaOut, user, outputMint, outputProgram));

    if (inputMint.equals(NATIVE_MINT)) {
      instructions.push(new TransactionInstruction({
        programId: SystemProgramId,
        keys: [
          { pubkey: user, isSigner: true, isWritable: true },
          { pubkey: userAtaIn, isSigner: false, isWritable: true },
        ],
        data: transferSolData(params.amountIn),
      }));
      instructions.push(createSyncNativeInstruction(userAtaIn));
    }

    const authority = getPdaPoolAuthority(CPMM_PROGRAM).publicKey;
    const observationId = getPdaObservationId(CPMM_PROGRAM, poolId).publicKey;
    instructions.push(makeSwapCpmmBaseInInstruction({
      payer: user,
      authority,
      configId: pool.configId,
      poolId,
      userInputAccount: userAtaIn,
      userOutputAccount: userAtaOut,
      inputVault,
      outputVault,
      inputTokenProgram: inputProgram,
      outputTokenProgram: outputProgram,
      inputMint,
      outputMint,
      observationId,
      amountIn: params.amountIn,
      amountOutMin: q.minOut,
    }));

    const tx = new Transaction().add(...instructions);
    const { blockhash } = await solana.getLatestBlockhash();
    tx.feePayer = user;
    tx.recentBlockhash = blockhash;
    const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
    return {
      serialized,
      sessionId: sessionIdFor(serialized),
      poolId: poolId.toBase58(),
      quote: {
        side: params.side,
        amountIn: params.amountIn.toString(),
        amountOut: q.amountOut.toString(),
        minOut: q.minOut.toString(),
      },
    };
  }

  /**
   * Verify a user-signed CPMM swap and broadcast it. The exact instruction
   * shape (accounts, PDAs, amounts) is re-checked against freshly derived
   * on-chain values — the client can never substitute a different transfer.
   */
  async submitSwap(params: {
    userId: number;
    user: string;
    mintA: string;
    side: "buy" | "sell";
    amountIn: bigint;
    minOut: bigint;
    signedTxBase64: string;
    beforeBroadcast?: (signature: string) => void;
  }): Promise<{ signature: string; recorded: boolean }> {
    const solana = this.requireSolana();
    let tx: Transaction;
    try {
      tx = Transaction.from(Buffer.from(params.signedTxBase64, "base64"));
    } catch {
      throw new CpmmError("BAD_TX", "transaction could not be parsed (versioned transactions are not accepted)");
    }
    const user = new PublicKey(params.user);
    if (!tx.feePayer || !tx.feePayer.equals(user)) throw new CpmmError("BAD_TX", "user must be the fee payer");
    const userSig = tx.signatures.find((s) => s.publicKey.equals(user));
    if (!userSig?.signature) throw new CpmmError("NOT_USER_SIGNED", "the user signature is missing");
    // No other signature slots may be filled by the client (the pool authority is a PDA and never signs).
    for (const s of tx.signatures) {
      if (!s.publicKey.equals(user) && s.signature) throw new CpmmError("BAD_TX", "unexpected extra signature provided by the client");
    }

    const { poolId, pool, config, mintAProgram, mintBProgram, tokenIsPoolA } = await this.decodePool(params.mintA);
    // Same scrutiny at submit: re-check the mint in case state changed between
    // prepare and submit (new epoch = new transfer fee, authority minted, etc.).
    const submitMint = new PublicKey(params.mintA);
    const submitMintAcc = await this.getAccountData(submitMint, "launch token mint");
    if (!submitMintAcc.owner.equals(TOKEN_PROGRAM_ID)) {
      this.mintGuard.assertTradableMint2022(submitMint, { owner: submitMintAcc.owner, data: submitMintAcc.data });
    }
    const mint = new PublicKey(params.mintA);
    const baseIn = params.side === "sell";
    const inputMint = baseIn ? mint : NATIVE_MINT;
    const outputMint = baseIn ? NATIVE_MINT : mint;
    const tokenProgram = tokenIsPoolA ? mintAProgram : mintBProgram;
    const solProgram = tokenIsPoolA ? mintBProgram : mintAProgram;
    const tokenVault = tokenIsPoolA ? pool.vaultA : pool.vaultB;
    const solVault = tokenIsPoolA ? pool.vaultB : pool.vaultA;
    const expected = {
      programId: CPMM_PROGRAM,
      payer: user,
      authority: getPdaPoolAuthority(CPMM_PROGRAM).publicKey,
      configId: pool.configId,
      poolId,
      userInputAccount: getATA(user, inputMint, baseIn ? tokenProgram : solProgram),
      userOutputAccount: getATA(user, outputMint, baseIn ? solProgram : tokenProgram),
      inputVault: baseIn ? tokenVault : solVault,
      outputVault: baseIn ? solVault : tokenVault,
      inputTokenProgram: baseIn ? tokenProgram : solProgram,
      outputTokenProgram: baseIn ? solProgram : tokenProgram,
      inputMint,
      outputMint,
      observationId: getPdaObservationId(CPMM_PROGRAM, poolId).publicKey,
      amountIn: params.amountIn,
      amountOutMin: params.minOut,
    };
    const swapIxs = tx.instructions.filter((i) => i.programId.equals(CPMM_PROGRAM));
    if (swapIxs.length !== 1) throw new CpmmError("SHAPE_MISMATCH", "expected exactly one CPMM swap instruction");
    verifySwapInstruction(swapIxs[0]!, expected);

    const raw = tx.serialize({ requireAllSignatures: true, verifySignatures: true });
    const expectedSignature = bs58.encode(tx.signature!);
    params.beforeBroadcast?.(expectedSignature);
    const signature = await solana.sendRawTransaction(raw);
    if (signature !== expectedSignature) throw new CpmmError("CONFIRMATION_FAILED", "RPC signature mismatch");
    const result = await solana.confirmTransaction(signature, "confirmed") as { value?: { err?: unknown } } | null;
    if (!result?.value || result.value.err !== null) {
      throw new CpmmError("CONFIRMATION_FAILED", "transaction failed or confirmation is unavailable");
    }
    const quoteMint = NATIVE_MINT.toBase58();
    const recorded = this.db.recordLaunchLabTrade({
      mintA: params.mintA,
      quoteMint,
      userId: params.userId,
      side: params.side,
      amountIn: params.amountIn.toString(),
      minOut: params.minOut.toString(),
      signature,
    });
    return { signature, recorded };
  }

  listOwnActivity(mintA: string, limit = 20, userId?: number): Array<{ side: string; amountIn: string; minOut: string; signature: string; ts: number }> {
    return this.db.listUserLaunchLabTrades(userId!, limit)
      .filter((t) => t.mint_a === mintA)
      .map((t) => ({ side: t.side, amountIn: t.amount_in, minOut: t.min_out, signature: t.signature, ts: t.ts }));
  }
}

// ── Low-level builders shared by prepare/submit paths ────────────────────

function getATA(owner: PublicKey, mint: PublicKey, program: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, false, program);
}

function computeBudgetIx(): TransactionInstruction {
  return ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT });
}

const SystemProgramId = new PublicKey("11111111111111111111111111111111");

function transferSolData(lamports: bigint): Buffer {
  const data = Buffer.alloc(12);
  data.writeUInt32LE(2, 0); // SystemInstruction::Transfer
  data.writeBigUInt64LE(lamports, 4);
  return data;
}

interface SwapAccounts {
  payer: PublicKey; authority: PublicKey; configId: PublicKey; poolId: PublicKey;
  userInputAccount: PublicKey; userOutputAccount: PublicKey;
  inputVault: PublicKey; outputVault: PublicKey;
  inputTokenProgram: PublicKey; outputTokenProgram: PublicKey;
  inputMint: PublicKey; outputMint: PublicKey; observationId: PublicKey;
  amountIn: bigint; amountOutMin: bigint;
}

function makeSwapCpmmBaseInInstruction(p: SwapAccounts): TransactionInstruction {
  const keys: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }> = [
    { pubkey: p.payer, isSigner: true, isWritable: true },
    { pubkey: p.authority, isSigner: false, isWritable: false },
    { pubkey: p.configId, isSigner: false, isWritable: false },
    { pubkey: p.poolId, isSigner: false, isWritable: true },
    { pubkey: p.userInputAccount, isSigner: false, isWritable: true },
    { pubkey: p.userOutputAccount, isSigner: false, isWritable: true },
    { pubkey: p.inputVault, isSigner: false, isWritable: true },
    { pubkey: p.outputVault, isSigner: false, isWritable: true },
    { pubkey: p.inputTokenProgram, isSigner: false, isWritable: false },
    { pubkey: p.outputTokenProgram, isSigner: false, isWritable: false },
    { pubkey: p.inputMint, isSigner: false, isWritable: false },
    { pubkey: p.outputMint, isSigner: false, isWritable: false },
    { pubkey: p.observationId, isSigner: false, isWritable: true },
  ];
  const data = Buffer.alloc(16);
  data.writeBigUInt64LE(p.amountIn, 0);
  data.writeBigUInt64LE(p.amountOutMin, 8);
  return new TransactionInstruction({
    keys,
    programId: CPMM_PROGRAM,
    data: Buffer.concat([CPMM_SWAP_BASE_IN_DISCRIMINATOR, data]),
  });
}

/** Byte-exact re-verification of a client-signed CPMM swap instruction. */
export function verifySwapInstruction(ix: TransactionInstruction, e: SwapAccounts & { programId: PublicKey }): void {
  if (!ix.programId.equals(e.programId)) throw new CpmmError("SHAPE_MISMATCH", "wrong program");
  if (ix.keys.length !== 13) throw new CpmmError("SHAPE_MISMATCH", "wrong account count");
  const expected: Array<{ key: PublicKey; signer: boolean; writable: boolean }> = [
    { key: e.payer, signer: true, writable: true },
    { key: e.authority, signer: false, writable: false },
    { key: e.configId, signer: false, writable: false },
    { key: e.poolId, signer: false, writable: true },
    { key: e.userInputAccount, signer: false, writable: true },
    { key: e.userOutputAccount, signer: false, writable: true },
    { key: e.inputVault, signer: false, writable: true },
    { key: e.outputVault, signer: false, writable: true },
    { key: e.inputTokenProgram, signer: false, writable: false },
    { key: e.outputTokenProgram, signer: false, writable: false },
    { key: e.inputMint, signer: false, writable: false },
    { key: e.outputMint, signer: false, writable: false },
    { key: e.observationId, signer: false, writable: true },
  ];
  for (let i = 0; i < expected.length; i++) {
    const k = ix.keys[i]!;
    const w = expected[i]!;
    if (!k.pubkey.equals(w.key)) throw new CpmmError("SHAPE_MISMATCH", `account ${i} does not match the prepared swap`);
    if (k.isSigner !== w.signer || k.isWritable !== w.writable) throw new CpmmError("SHAPE_MISMATCH", `account ${i} flags changed`);
  }
  if (ix.data.length !== 24 || !ix.data.subarray(0, 8).equals(CPMM_SWAP_BASE_IN_DISCRIMINATOR)) {
    throw new CpmmError("SHAPE_MISMATCH", "instruction data is not a CPMM swapBaseInput");
  }
  const amountIn = ix.data.readBigUInt64LE(8);
  const minOut = ix.data.readBigUInt64LE(16);
  if (amountIn !== e.amountIn) throw new CpmmError("SHAPE_MISMATCH", "amountIn was altered");
  if (minOut !== e.amountOutMin) throw new CpmmError("SHAPE_MISMATCH", "minOut was altered");
}

import bs58 from "bs58";
import { createHash } from "node:crypto";

/** Deterministic session id (shared semantics with LaunchLab). */
export function sessionIdFor(serializedBase64: string): string {
  return createHash("sha256").update(serializedBase64).digest("hex").slice(0, 32);
}
