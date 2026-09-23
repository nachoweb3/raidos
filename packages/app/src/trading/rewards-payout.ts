/**
 * 💸 REWARDS PAYOUT — real on-chain claim for accrued rewards.
 *
 * Honesty contract (mirrors the rest of the platform):
 * - The rewards ledger accrues REAL fees (micro-USDC integers). The claim is a
 *   REAL transfer: the operator treasury keypair sends USDC (SPL) to the
 *   user's USDC ATA on Solana. The server never invents balances and never
 *   holds user keys — only its own treasury key (env), keyless by default.
 * - Exactly-once: the ledger row (trade/referral UNIQUE ids) is claimed inside
 *   the same DB transaction that persists the treasury signature journal.
 *   The transfer itself is verified against the RPC before it is recorded.
 * - Deterministic id: hash(treasury, destination, amountMicro, ledgerBatch)
 *   so a retried claim of the same batch cannot double-pay.
 * - Recovery: the signature is journaled BEFORE broadcast; if the process
 *   dies between broadcast and record, GET /api/rewards/claim/:sessionId
 *   resolves the on-chain status without ever re-sending.
 */

import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { createHash } from "node:crypto";

export class PayoutError extends Error {
  constructor(
    public readonly code: "NO_TREASURY" | "RPC_DISABLED" | "NOTHING_TO_CLAIM" | "ALREADY_CLAIMED" | "BAD_ADDRESS" | "CONFIRMATION_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "PayoutError";
  }
}

/** SolanaLike subset (Connection satisfies it; tests stub it). */
export interface PayoutSolanaLike {
  getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  getAccountInfo(address: PublicKey): Promise<{ owner: PublicKey; lamports: number; data: Uint8Array } | null>;
  getSignatureStatus(signature: string): Promise<{ err: unknown; confirmationStatus?: string } | null>;
  sendRawTransaction(raw: Uint8Array): Promise<string>;
  confirmTransaction(signature: string, commitment?: string): Promise<unknown>;
}

export interface PayoutDb {
  getRewardEntries(userId: number, limit?: number, offset?: number): Array<{ id: number; amount_usdc: string; status: string }>;
  markRewardsClaimed(userId: number, txHash: string): bigint;
  /** Journal the payout signature BEFORE broadcast (durable). */
  setAppSetting(key: string, value: string): void;
  getAppSetting(key: string): string | undefined;
  /** Run fn in a single SQLite transaction (AppDb.launchTransaction). */
  transaction?: <T>(fn: () => T) => T;
}

/** Deterministic session id for a payout batch (retries collapse). */
export function payoutSessionId(treasury: string, destination: string, amountMicro: string, batchKey: string): string {
  return createHash("sha256").update(`${treasury}|${destination}|${amountMicro}|${batchKey}`).digest("hex").slice(0, 32);
}

/**
 * Extract the tx signature from a serialized transaction WITHOUT the RPC:
 * the wire format starts with a compact-u16 signature count and the FIRST
 * 64-byte block is the first required signer (= fee payer here, the only
 * signer). Deterministic, so the journal can be written pre-broadcast.
 */
export function payoutSignatureOf(raw: Uint8Array): string {
  const { value: sigCount, bytesUsed } = decodeCompactU16(raw, 0);
  if (sigCount < 1) throw new PayoutError("CONFIRMATION_FAILED", "serialized tx has no signatures");
  const sig = raw.slice(bytesUsed, bytesUsed + 64);
  if (sig.length < 64) throw new PayoutError("CONFIRMATION_FAILED", "serialized tx signature truncated");
  return toBase58(sig);
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

function toBase58(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt("0x" + Buffer.from(bytes).toString("hex"));
  let out = "";
  while (n > 0n) {
    out = alphabet[Number(n % 58n)] + out;
    n /= 58n;
  }
  // Leading zero bytes → leading '1's.
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out || "1";
}

export interface PayoutResult {
  sessionId: string;
  signature: string;
  amountUsdc: string; // micro-USDC paid
  destination: string; // user's USDC ATA
}

export class RewardsPayout {
  constructor(
    private readonly db: PayoutDb,
    private readonly solana: PayoutSolanaLike | null,
    private readonly treasury: Keypair | null,
    private readonly usdcMint: string,
  ) {}

  /**
   * Claim every AVAILABLE reward row of the user as a REAL USDC transfer.
   * Flow: mark rows CLAIMED (atomic) → build transfer tx → journal → sign →
   * broadcast → confirm. Idempotent per batch: a duplicated call with no new
   * AVAILABLE rows throws NOTHING_TO_CLAIM instead of double-paying.
   */
  async claim(input: {
    userId: number;
    destinationAddress: string; // user's Solana wallet (base58)
    batchKey?: string; // extra entropy to make the session unique per attempt
  }): Promise<PayoutResult> {
    if (!this.treasury) throw new PayoutError("NO_TREASURY", "rewards treasury keypair is not configured; the server stays keyless by default");
    const solana = this.requireSolana();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(input.destinationAddress)) throw new PayoutError("BAD_ADDRESS", "destination wallet is missing or malformed");

    // What is AVAILABLE right now? (read before mutating)
    const entries = this.db.getRewardEntries(input.userId, 10_000);
    const available = entries.filter((e) => e.status === "AVAILABLE");
    const amountMicro = available.reduce((acc, e) => acc + BigInt(e.amount_usdc), 0n);

    // A retried batch (same batchKey) points to its journaled session instead
    // of a confusing "nothing to claim" — the money already went out once.
    const batchMarker = input.batchKey ? this.db.getAppSetting(`rewards-payout-batch:${input.userId}:${input.batchKey}`) : undefined;
    if (batchMarker) throw new PayoutError("ALREADY_CLAIMED", `payout already processed (session ${batchMarker}); check GET /api/rewards/claim/${batchMarker}`);
    if (amountMicro <= 0n) throw new PayoutError("NOTHING_TO_CLAIM", "no AVAILABLE rewards to claim");

    const destination = getAssociatedTokenAddressSync(new PublicKey(this.usdcMint), new PublicKey(input.destinationAddress));
    const amountUnits = amountMicro; // USDC has 6 decimals → micro-USDC IS the base unit

    const sessionId = payoutSessionId(this.treasury.publicKey.toBase58(), destination.toBase58(), amountMicro.toString(), input.batchKey ?? String(Math.floor(Date.now() / 1000)));
    if (this.db.getAppSetting(`rewards-payout:${sessionId}`)) {
      throw new PayoutError("ALREADY_CLAIMED", `payout already processed (session ${sessionId}); check GET /api/rewards/claim/${sessionId}`);
    }

    const instructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 120_000 }),
    ];
    const destInfo = await solana.getAccountInfo(destination);
    if (!destInfo) {
      // Idempotent-by-check: only create the user's USDC ATA when missing.
      instructions.push(createAssociatedTokenAccountInstruction(this.treasury.publicKey, destination, new PublicKey(input.destinationAddress), new PublicKey(this.usdcMint)));
    }
    instructions.push(createTransferCheckedInstruction(this.treasuryUsdcAta(), new PublicKey(this.usdcMint), destination, this.treasury.publicKey, amountUnits, 6));

    const tx = new Transaction().add(...instructions);
    const { blockhash } = await solana.getLatestBlockhash();
    tx.feePayer = this.treasury.publicKey;
    tx.recentBlockhash = blockhash;
    tx.sign(this.treasury);
    const raw = tx.serialize({ requireAllSignatures: true, verifySignatures: false });
    const signature = payoutSignatureOf(raw);

    // Journal BEFORE broadcast; the ledger flips to CLAIMED in the same
    // transaction so a crash can never leave rows marked CLAIMED without a
    // journaled signature to recover against.
    const journalAndClaim = (): bigint => {
      this.db.setAppSetting(`rewards-payout:${sessionId}`, JSON.stringify({ signature, amountMicro: amountMicro.toString(), destination: destination.toBase58(), ts: Math.floor(Date.now() / 1000) }));
      if (input.batchKey) this.db.setAppSetting(`rewards-payout-batch:${input.userId}:${input.batchKey}`, sessionId);
      return this.db.markRewardsClaimed(input.userId, signature);
    };
    const journaled = this.db.transaction ? this.db.transaction(journalAndClaim) : journalAndClaim();
    if (journaled <= 0n) throw new PayoutError("NOTHING_TO_CLAIM", "rewards were claimed concurrently; nothing left to pay");

    try {
      await solana.sendRawTransaction(raw);
    } catch (err) {
      // Broadcast failure: rows stay CLAIMED but the journal lets recovery
      // resolve the truth against the RPC (send may have partially succeeded).
      throw new PayoutError("CONFIRMATION_FAILED", `broadcast failed: ${err instanceof Error ? err.message : String(err)} (recover via /api/rewards/claim/${sessionId})`);
    }
    await solana.confirmTransaction(signature, "confirmed");

    return { sessionId, signature, amountUsdc: amountMicro.toString(), destination: destination.toBase58() };
  }

  /**
   * Recovery endpoint helper: resolve a journaled payout against the RPC.
   * Never re-broadcasts; the journal + chain are the only truth.
   */
  async status(sessionId: string): Promise<{ status: "prepared" | "unknown" | "pending" | "confirmed" | "failed"; signature?: string; amountUsdc?: string }> {
    const journal = this.db.getAppSetting(`rewards-payout:${sessionId}`);
    if (!journal) {
      // No journal: nothing was ever sent for this session.
      return { status: "prepared" };
    }
    const parsed = JSON.parse(journal) as { signature: string; amountMicro?: string };
    const solana = this.requireSolana();
    const receipt = await solana.getSignatureStatus(parsed.signature);
    if (!receipt) return { status: "unknown", signature: parsed.signature, amountUsdc: parsed.amountMicro };
    if (receipt.err) return { status: "failed", signature: parsed.signature, amountUsdc: parsed.amountMicro };
    if (!["confirmed", "finalized"].includes(receipt.confirmationStatus ?? "")) return { status: "pending", signature: parsed.signature, amountUsdc: parsed.amountMicro };
    return { status: "confirmed", signature: parsed.signature, amountUsdc: parsed.amountMicro };
  }

  private treasuryUsdcAta(): PublicKey {
    return getAssociatedTokenAddressSync(new PublicKey(this.usdcMint), this.treasury!.publicKey);
  }

  private requireSolana(): NonNullable<PayoutSolanaLike> {
    if (!this.solana) throw new PayoutError("RPC_DISABLED", "no Solana endpoint configured for rewards payout");
    return this.solana;
  }
}

/**
 * Build (or null) from env — keyless by default. The RPC wrapper adapts a
 * web3.js Connection to the minimal PayoutSolanaLike surface (signature
 * status comes unwrapped from RpcResponseAndContext).
 */
export function rewardsPayoutFromEnv(db: PayoutDb, connection: Connection | null): RewardsPayout {
  const secret = process.env.TREASURY_KEYPAIR_BASE64;
  const usdc = process.env.SOLANA_REWARDS_USDC_MINT ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const treasury = secret ? Keypair.fromSecretKey(Buffer.from(secret, "base64")) : null;
  const solana: PayoutSolanaLike | null = connection
    ? {
        getLatestBlockhash: () => connection.getLatestBlockhash(),
        getAccountInfo: async (address: PublicKey) => {
          const info = await connection.getAccountInfo(address);
          return info ? { owner: info.owner, lamports: info.lamports, data: info.data } : null;
        },
        getSignatureStatus: async (signature: string) => {
          const res = await connection.getSignatureStatus(signature);
          return res.value;
        },
        sendRawTransaction: (raw: Uint8Array) => connection.sendRawTransaction(Buffer.from(raw)),
        confirmTransaction: (signature: string, commitment?: string) => connection.confirmTransaction(signature, (commitment as "confirmed") ?? "confirmed"),
      }
    : null;
  return new RewardsPayout(db, solana, treasury, usdc);
}
