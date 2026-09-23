/**
 * 🏊 Launch AMM — post-graduation secondary market for graduated launches.
 *
 * Design (honesty + self-custody, matching the rest of the platform):
 * - A graduation LP is an explicit operator decision: pool creation is
 *   admin-only and requires the operator pool keypair (env) — the server is
 *   keyless by default, exactly like the graduation factory.
 * - The pool is a Solana keypair that owns the two vaults (token A = the
 *   graduated launch token, token B = USDC). On each swap the USER signs
 *   first (they are the fee payer) and the pool only co-signs its own side
 *   after the server verifies the incoming transfer details.
 * - Reserves are NOT stored in the database. The chain is the source of
 *   truth: reserves are read from the real SPL token accounts every time.
 *   The DB keeps only the pool registry row and the swap history.
 * - Slippage protection is mandatory: every swap carries minOut, enforced
 *   on-chain by the transfer amounts themselves.
 *
 * Math: constant product with a fee taken on the input (Uniswap v2 style).
 */

import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

/** Swap fee in basis points (30 = 0.3%, Uniswap v2 default). */
export const SWAP_FEE_BPS = 30;
/** Slippage defaults for quotes (the UI can override per swap). */
export const DEFAULT_SLIPPAGE_BPS = 100;
/**
 * Pool kill switch. Value is read from env at request time so the operator
 * can flip POOL_EXECUTION_ENABLED=1 without redeploying. Kept separate from
 * the global execution switch so the graduation/pool path can be armed first.
 */
export function poolExecutionEnabled(): boolean {
  return process.env.POOL_EXECUTION_ENABLED === "1";
}
/** Max acceptable drift (fraction, 0..1) between the prepare-time quote and
 *  the reserves observed at submit. 0.02 = the price may move at most 2%. */
export const POOL_MAX_PRICE_DRIFT = 0.02;

/** Same minimal Solana port used by the graduation factory. */
export interface SolanaLike {
  getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  getAccountInfo(address: PublicKey): Promise<{ owner: PublicKey; lamports: number; data: Uint8Array } | null>;
  sendRawTransaction(raw: Uint8Array): Promise<string>;
  confirmTransaction(signature: string, commitment?: string): Promise<unknown>;
}

/** Pool registry row (no reserves — chain truth only). */
export interface PoolRow {
  id: number;
  launchId: number;
  mintA: string;
  mintB: string;
  vaultA: string;
  vaultB: string;
  poolAddress: string;
  status: string;
  createdAt: number;
}

/** Minimal DB surface for the AMM (subset of AppDb). */
export interface AmmDb {
  createLaunchPool(launchId: number, mintA: string, mintB: string, vaultA: string, vaultB: string, poolAddress: string): number;
  getLaunchPoolByLaunch(launchId: number): PoolRow | null;
  recordPoolSwap(poolId: number, userId: number, side: "buy" | "sell", amountIn: string, amountOut: string, minOut: string, signature: string, ts?: number): void;
  listPoolSwaps(poolId: number, limit?: number): Array<{ id: number; userId: number; side: string; amountIn: string; amountOut: string; signature: string; ts: number }>;
}

export class AmmError extends Error {
  constructor(
    public readonly code: "NO_POOL" | "BAD_AMOUNT" | "NO_KEYPAIR" | "BAD_TX" | "NOT_USER_SIGNED" | "WRONG_POOL" | "MIN_OUT_VIOLATED" | "RPC_DISABLED" | "STALE_QUOTE",
    message: string,
  ) {
    super(message);
    this.name = "AmmError";
  }
}

// ── Pure math (no I/O, fully unit-testable) ──────────────────────────────

/** Deduct the fee from the input amount. */
export function applyFee(amountIn: bigint, feeBps: number): bigint {
  return (amountIn * BigInt(10_000 - feeBps)) / 10_000n;
}

/** Constant-product output for an input that already had the fee applied. */
export function getAmountOut(amountInWithFee: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountInWithFee <= 0n) return 0n;
  if (reserveIn <= 0n || reserveOut <= 0n) return 0n;
  return (amountInWithFee * reserveOut) / (reserveIn + amountInWithFee);
}

export interface SwapQuote {
  side: "buy" | "sell";
  /** Human input amount in base units of the input token. */
  amountIn: bigint;
  /** Expected output in base units of the output token (fee already applied). */
  amountOut: bigint;
  /** Mandatory slippage floor passed to the tx. */
  minOut: bigint;
  /** 0..100 price impact of the trade. */
  priceImpactPct: number;
  /** Execution price: output per 1 input (base-unit ratio, display only). */
  effectivePrice: number;
  reserveIn: bigint;
  reserveOut: bigint;
}

/**
 * Quote a swap against current reserves. `buy` = USDC in / token out;
 * `sell` = token in / USDC out. Throws on empty pool or non-positive input.
 */
export function quoteSwap(
  side: "buy" | "sell",
  reserveToken: bigint,
  reserveUsdc: bigint,
  amountIn: bigint,
  slippageBps: number = DEFAULT_SLIPPAGE_BPS,
): SwapQuote {
  if (amountIn <= 0n) throw new AmmError("BAD_AMOUNT", "amount must be positive");
  const [reserveIn, reserveOut] = side === "buy" ? [reserveUsdc, reserveToken] : [reserveToken, reserveUsdc];
  if (reserveIn <= 0n || reserveOut <= 0n) throw new AmmError("NO_POOL", "pool has no liquidity on this side");
  const amountOut = getAmountOut(applyFee(amountIn, SWAP_FEE_BPS), reserveIn, reserveOut);
  if (amountOut <= 0n) throw new AmmError("BAD_AMOUNT", "amount too small for the current pool");
  // Price impact: 1 − (executed price ÷ spot price), constant-product form.
  const spot = Number(reserveOut) / Number(reserveIn);
  const exec = Number(amountOut) / Number(amountIn);
  const impact = spot > 0 ? Math.max(0, (1 - exec / spot) * 100) : 0;
  return {
    side,
    amountIn,
    amountOut,
    minOut: minOutFor(amountOut, slippageBps),
    priceImpactPct: impact,
    effectivePrice: exec,
    reserveIn,
    reserveOut,
  };
}

/** Slippage floor: never receive fewer base units than this. */
export function minOutFor(amountOut: bigint, slippageBps: number): bigint {
  const bps = Math.max(0, Math.min(5_000, Math.floor(slippageBps)));
  return (amountOut * BigInt(10_000 - bps)) / 10_000n;
}

// ── Pool keys ────────────────────────────────────────────────────────────

/** The pool keypair owns both vaults; vaults are regular ATAs of the pool. */
export function deriveVaults(pool: PublicKey, mintA: PublicKey, mintB: PublicKey, tokenProgram: PublicKey = TOKEN_PROGRAM_ID): { vaultA: PublicKey; vaultB: PublicKey } {
  return {
    vaultA: getAssociatedTokenAddressSync(mintA, pool, false, tokenProgram),
    vaultB: getAssociatedTokenAddressSync(mintB, pool, false, tokenProgram),
  };
}

/**
 * Parse an SPL token account: mint (32B @0), owner (32B @32), amount (u64 LE @64).
 * Only what reserve reads need — no full decode.
 */
export function parseSplAccount(data: Uint8Array): { mint: PublicKey; owner: PublicKey; amount: bigint } {
  if (data.length < 72) throw new AmmError("BAD_TX", "token account data too short");
  return {
    mint: new PublicKey(data.slice(0, 32)),
    owner: new PublicKey(data.slice(32, 64)),
    amount: BigInt(new DataView(data.buffer, data.byteOffset + 64, 8).getBigUint64(0, true)),
  };
}

// ── The AMM engine ───────────────────────────────────────────────────────

export class LaunchAmm {
  private readonly poolKeypair: Keypair | null;

  constructor(
    private readonly db: AmmDb,
    private readonly solana: SolanaLike | null,
    /** Operator pool keypair (env). Null = keyless server: reads/quotes only. */
    poolKeypair: Keypair | null = null,
    private readonly tokenProgram: PublicKey = TOKEN_PROGRAM_ID,
  ) {
    this.poolKeypair = poolKeypair;
  }

  /** Live reserves from the chain — the ONLY source of truth. */
  async getReserves(pool: PoolRow): Promise<{ reserveToken: bigint; reserveUsdc: bigint }> {
    const solana = this.requireSolana();
    const a = await solana.getAccountInfo(new PublicKey(pool.vaultA));
    const b = await solana.getAccountInfo(new PublicKey(pool.vaultB));
    const reserveToken = a ? parseSplAccount(a.data).amount : 0n;
    const reserveUsdc = b ? parseSplAccount(b.data).amount : 0n;
    return { reserveToken, reserveUsdc };
  }

  /** Snapshot for the UI: price + reserves + metadata, chain truth. */
  async snapshot(pool: PoolRow): Promise<{
    id: number; launchId: number; mintA: string; mintB: string;
    vaultA: string; vaultB: string; status: string;
    reserveToken: bigint; reserveUsdc: bigint; priceTokenInUsdc: number;
  }> {
    const { reserveToken, reserveUsdc } = await this.getReserves(pool);
    return {
      id: pool.id,
      launchId: pool.launchId,
      mintA: pool.mintA,
      mintB: pool.mintB,
      vaultA: pool.vaultA,
      vaultB: pool.vaultB,
      status: pool.status,
      reserveToken,
      reserveUsdc,
      priceTokenInUsdc: reserveToken > 0n ? Number(reserveUsdc) / 1e6 / Number(reserveToken) : 0,
    };
  }

  /**
   * Register a pool for a graduated launch. Requires the operator keypair
   * (vaults must be funded by the operator afterwards — creating the pool
   * never moves funds).
   */
  createPool(launchId: number, mintA: string, mintB: string): { poolAddress: string; vaultA: string; vaultB: string } {
    if (!this.poolKeypair) throw new AmmError("NO_KEYPAIR", "pool operator keypair is not configured; the server stays keyless by default");
    const mintAKey = new PublicKey(mintA);
    const mintBKey = new PublicKey(mintB);
    const { vaultA, vaultB } = deriveVaults(this.poolKeypair.publicKey, mintAKey, mintBKey, this.tokenProgram);
    const id = this.db.createLaunchPool(launchId, mintA, mintB, vaultA.toBase58(), vaultB.toBase58(), this.poolKeypair.publicKey.toBase58());
    void id;
    return { poolAddress: this.poolKeypair.publicKey.toBase58(), vaultA: vaultA.toBase58(), vaultB: vaultB.toBase58() };
  }

  /**
   * Build the UNSIGNED swap tx. The user is fee payer and first signer;
   * the pool signature slot stays empty until the server co-signs at submit.
   * sessionId = hash of the exact unsigned message, so it binds prepare→submit
   * and doubles as the durable self_custody_sessions id (like LaunchLab/CPMM).
   */
  async buildSwapTx(params: {
    pool: PoolRow;
    side: "buy" | "sell";
    user: string;
    amountIn: bigint;
    minOut: bigint;
  }): Promise<{ serialized: string; sessionId: string }> {
    const solana = this.requireSolana();
    const user = new PublicKey(params.user);
    const pool = new PublicKey(params.pool.poolAddress);
    const mintIn = new PublicKey(params.side === "buy" ? params.pool.mintB : params.pool.mintA);
    const mintOut = new PublicKey(params.side === "buy" ? params.pool.mintA : params.pool.mintB);
    const vaultIn = new PublicKey(params.side === "buy" ? params.pool.vaultB : params.pool.vaultA);
    const vaultOut = new PublicKey(params.side === "buy" ? params.pool.vaultA : params.pool.vaultB);

    const userAtaIn = getAssociatedTokenAddressSync(mintIn, user, false, this.tokenProgram);
    const userAtaOut = getAssociatedTokenAddressSync(mintOut, user, false, this.tokenProgram);

    const instructions: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 })];

    // Idempotent-by-check ATA creation for the OUTPUT token (traders may not
    // hold the launch token yet; USDC ATA they almost surely have).
    const outInfo = await solana.getAccountInfo(userAtaOut);
    if (!outInfo) {
      instructions.push(createAssociatedTokenAccountInstruction(user, userAtaOut, user, mintOut, this.tokenProgram));
    }

    // Leg 1 — user pays: user ATA in → vault (user signs).
    instructions.push(createTransferCheckedInstruction(userAtaIn, mintIn, vaultIn, user, params.amountIn, params.side === "buy" ? 6 : 0, [], this.tokenProgram));
    // Leg 2 — pool pays: vault out → user ATA (pool co-signs at submit).
    instructions.push(createTransferCheckedInstruction(vaultOut, mintOut, userAtaOut, pool, params.minOut, params.side === "buy" ? 0 : 6, [], this.tokenProgram));

    const tx = new Transaction().add(...instructions);
    const { blockhash } = await solana.getLatestBlockhash();
    tx.feePayer = user;
    tx.recentBlockhash = blockhash;

    // Session id binds prepare→submit: hash of the exact unsigned message.
    const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
    const sessionId = sessionIdFor(serialized);
    return { serialized, sessionId };
  }

  /**
   * Verify a user-signed swap and execute it: the pool co-signs ONLY if the
   * tx matches the prepared shape (pool vaults, amounts, minOut, user as fee
   * payer with a real signature). Broadcast + confirm + history record.
   */
  async submitSwap(params: {
    pool: PoolRow;
    side: "buy" | "sell";
    userId: number;
    user: string;
    amountIn: bigint;
    minOut: bigint;
    signedTxBase64: string;
    /** Journal callback fired with the calculated signature BEFORE broadcast,
     *  so a crash between send and record can be recovered against the RPC. */
    beforeBroadcast?: (signature: string) => void;
    /** Re-check the CURRENT reserves against the prepared quote before the
     *  pool co-signs. Mandatory when quoteReserves is provided. */
    quoteReserves?: { reserveToken: bigint; reserveUsdc: bigint };
    /** Max drift allowed between quote and current reserves (default 2%). */
    maxPriceDrift?: number;
  }): Promise<{ signature: string; amountOut: bigint }> {
    if (!this.poolKeypair) throw new AmmError("NO_KEYPAIR", "pool operator keypair is not configured");
    const solana = this.requireSolana();
    if (!/^\d{1,30}$/.test(params.amountIn.toString())) throw new AmmError("BAD_AMOUNT", "invalid amount");

    let tx: Transaction;
    try {
      tx = Transaction.from(Buffer.from(params.signedTxBase64, "base64"));
    } catch {
      throw new AmmError("BAD_TX", "unsigned/signed transaction could not be parsed");
    }

    const user = new PublicKey(params.user);
    const pool = new PublicKey(params.pool.poolAddress);
    if (!tx.feePayer || !tx.feePayer.equals(user)) throw new AmmError("BAD_TX", "user must be the fee payer");

    // The user must have signed: exactly the fee payer slot carries a sig
    // plus the pool slot empty. Without this check the pool would sign a
    // message its owner (the user) never authorized.
    const userSigIndex = tx.signatures.findIndex((s) => s.publicKey.equals(user));
    const poolSigIndex = tx.signatures.findIndex((s) => s.publicKey.equals(pool));
    if (userSigIndex < 0 || !tx.signatures[userSigIndex]!.signature) throw new AmmError("NOT_USER_SIGNED", "the user signature is missing");
    if (poolSigIndex >= 0 && tx.signatures[poolSigIndex]!.signature) throw new AmmError("BAD_TX", "the pool signature must not be provided by the client");

    // Shape verification: exactly two transfer-checked legs between the
    // expected vaults and the user's ATAs, with the prepared amounts.
    const mintIn = new PublicKey(params.side === "buy" ? params.pool.mintB : params.pool.mintA);
    const mintOut = new PublicKey(params.side === "buy" ? params.pool.mintA : params.pool.mintB);
    const vaultIn = new PublicKey(params.side === "buy" ? params.pool.vaultB : params.pool.vaultA);
    const vaultOut = new PublicKey(params.side === "buy" ? params.pool.vaultA : params.pool.vaultB);
    const userAtaIn = getAssociatedTokenAddressSync(mintIn, user, false, this.tokenProgram);
    const userAtaOut = getAssociatedTokenAddressSync(mintOut, user, false, this.tokenProgram);

    const transfers = tx.instructions.filter((i) => i.programId.equals(this.tokenProgram));
    if (transfers.length !== 2) throw new AmmError("BAD_TX", "expected exactly two token transfers");

    const verifyLeg = (ix: TransactionInstruction, source: PublicKey, dest: PublicKey, authority: PublicKey, amount: bigint, decimals: number) => {
      // createTransferChecked layout: [source, mint, dest, authority]
      if (ix.keys.length < 4) throw new AmmError("BAD_TX", "transfer leg is malformed");
      if (!ix.keys[0]!.pubkey.equals(source)) throw new AmmError("BAD_TX", "unexpected transfer source");
      if (!ix.keys[2]!.pubkey.equals(dest)) throw new AmmError("BAD_TX", "unexpected transfer destination");
      if (!ix.keys[3]!.pubkey.equals(authority)) throw new AmmError("BAD_TX", "unexpected transfer authority");
      const data = ix.data;
      // TransferChecked data: instruction id (1B) + amount (u64 LE) + decimals (1B)
      if (data.length < 10) throw new AmmError("BAD_TX", "transfer leg data too short");
      const amountBytes = data.slice(1, 9);
      const got = BigInt(new DataView(amountBytes.buffer, amountBytes.byteOffset, 8).getBigUint64(0, true));
      if (got !== amount) throw new AmmError("BAD_TX", "transfer amount does not match the prepared swap");
      if (data[9] !== decimals) throw new AmmError("BAD_TX", "transfer decimals mismatch");
    };

    const inDecimals = params.side === "buy" ? 6 : 0;
    const outDecimals = params.side === "buy" ? 0 : 6;
    verifyLeg(transfers[0]!, userAtaIn, vaultIn, user, params.amountIn, inDecimals);
    verifyLeg(transfers[1]!, vaultOut, userAtaOut, pool, params.minOut, outDecimals);

    // Reserves moved between quote and submit? Refuse to co-sign: the pool
    // only pays minOut on-chain, but honoring a deeply stale quote could
    // drain the pool against the operator's intent. The 2% ceiling matches
    // the default UI slippage band.
    if (params.quoteReserves) {
      const current = await this.getReserves(params.pool);
      const drift = priceDrift(params.quoteReserves, current);
      const limit = params.maxPriceDrift ?? POOL_MAX_PRICE_DRIFT;
      if (drift > limit) {
        throw new AmmError("STALE_QUOTE", `pool reserves moved ${(drift * 100).toFixed(2)}% since the quote (limit ${(limit * 100).toFixed(0)}%); request a fresh quote`);
      }
    }

    // Pool co-signs the exact verified message and broadcasts. partialSign
    // ADDS the pool signature without wiping the user's (sign() would reset
    // the whole signatures array).
    tx.partialSign(this.poolKeypair);
    const raw = tx.serialize({ requireAllSignatures: true, verifySignatures: false });
    const signature = computeSignatureFor(raw);
    // Durable journal BEFORE the broadcast (same honesty contract as
    // LaunchLab/CPMM): a crash after sendRawTransaction is recoverable.
    try {
      params.beforeBroadcast?.(signature);
    } catch {
      // Journal failure must not broadcast a swap nobody could recover.
      throw new AmmError("RPC_DISABLED", "could not journal the swap before broadcast; refusing to send");
    }
    await solana.sendRawTransaction(raw);
    await solana.confirmTransaction(signature, "confirmed");

    // History (amountOut is the realized floor; the true out is on-chain).
    this.db.recordPoolSwap(params.pool.id, params.userId, params.side, params.amountIn.toString(), params.minOut.toString(), params.minOut.toString(), signature);
    return { signature, amountOut: params.minOut };
  }

  private requireSolana(): NonNullable<SolanaLike> {
    if (!this.solana) throw new AmmError("RPC_DISABLED", "no Solana endpoint configured for the launch AMM");
    return this.solana;
  }
}

import { createHash } from "node:crypto";
import bs58 from "bs58";

/** Deterministic session id for a prepared swap (binds prepare→submit). */
export function sessionIdFor(serializedBase64: string): string {
  return createHash("sha256").update(serializedBase64).digest("hex").slice(0, 32);
}

/**
 * Deterministic tx signature WITHOUT contacting the RPC: ed25519 signatures
 * never change for the same message + keypair, so after the pool co-signs we
 * can read the signature bytes straight out of the serialized tx. The wire
 * format starts with a compact-u16 signature count; the FIRST 64-byte block
 * belongs to the first required signer — the user (fee payer) — which is the
 * tx signature explorers index. This is what the journal stores BEFORE the
 * broadcast.
 */
export function computeSignatureFor(raw: Uint8Array): string {
  const { value: sigCount, bytesUsed } = decodeCompactU16(raw, 0);
  if (sigCount < 1) throw new AmmError("BAD_TX", "serialized tx has no signatures");
  const sig = raw.slice(bytesUsed, bytesUsed + 64);
  if (sig.length < 64) throw new AmmError("BAD_TX", "serialized tx signature truncated");
  return bs58.encode(sig);
}

/** Solana compact-u16 (sleb128-style little-endian 7-bit groups). */
function decodeCompactU16(raw: Uint8Array, offset: number): { value: number; bytesUsed: number } {
  let value = 0;
  let shift = 0;
  let bytesUsed = 0;
  for (let i = offset; i < raw.length && i < offset + 3; i++) {
    value |= (raw[i]! & 0x7f) << shift;
    bytesUsed++;
    if ((raw[i]! & 0x80) === 0) break;
    shift += 7;
  }
  return { value, bytesUsed };
}

/**
 * Relative drift between the quote-time and submit-time reserves (0..∞).
 * Uses the larger reserve side so either a token or USDC sweep is detected.
 */
export function priceDrift(quote: { reserveToken: bigint; reserveUsdc: bigint }, current: { reserveToken: bigint; reserveUsdc: bigint }): number {
  const rel = (a: bigint, b: bigint): number => {
    if (a <= 0n && b <= 0n) return 0;
    const big = a >= b ? a : b;
    const small = a >= b ? b : a;
    return big === small ? 0 : Number(big - small) / Number(big);
  };
  return Math.max(rel(quote.reserveToken, current.reserveToken), rel(quote.reserveUsdc, current.reserveUsdc));
}
