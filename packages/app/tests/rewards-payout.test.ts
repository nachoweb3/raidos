/**
 * 💸 Rewards payout tests — real on-chain USDC claims must be exactly-once,
 * journaled before broadcast and recoverable without re-sending.
 */

import { Keypair, PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createTransferCheckedInstruction } from "@solana/spl-token";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { PayoutError, RewardsPayout, payoutSessionId, payoutSignatureOf, type PayoutDb } from "../src/trading/rewards-payout.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

interface Rig {
  db: PayoutDb & { settings: Map<string, string>; rows: Array<{ id: number; amount_usdc: string; status: string }> };
  solana: {
    sent: Uint8Array[];
    getLatestBlockhash: () => Promise<{ blockhash: string; lastValidBlockHeight: number }>;
    getAccountInfo: (address: PublicKey) => Promise<{ owner: PublicKey; lamports: number; data: Uint8Array } | null>;
    getSignatureStatus: (sig: string) => Promise<{ err: unknown; confirmationStatus?: string } | null>;
    sendRawTransaction: (raw: Uint8Array) => Promise<string>;
    confirmTransaction: (sig: string) => Promise<unknown>;
  };
}

function makeRig(available: string[] = ["1000000", "250000"]): Rig {
  const settings = new Map<string, string>();
  const rows = available.map((amount_usdc, i) => ({ id: i + 1, amount_usdc, status: "AVAILABLE" }));
  const sent: Uint8Array[] = [];
  const db: Rig["db"] = {
    settings,
    rows,
    getRewardEntries: () => rows,
    markRewardsClaimed: (_userId, txHash) => {
      let total = 0n;
      for (const r of rows) {
        if (r.status === "AVAILABLE") {
          r.status = "CLAIMED";
          total += BigInt(r.amount_usdc);
        }
      }
      if (total > 0n) settings.set("lastClaimHash", txHash);
      return total;
    },
    setAppSetting: (k, v) => settings.set(k, v),
    getAppSetting: (k) => settings.get(k),
    transaction: <T,>(fn: () => T): T => fn(),
  };
  const solana = {
    sent,
    getLatestBlockhash: async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 100 }),
    getAccountInfo: async () => null, // destination ATA missing → creation leg expected
    getSignatureStatus: async (sig: string) => settings.has(`status:${sig}`) ? (settings.get(`status:${sig}`) as never) : null,
    sendRawTransaction: async (raw: Uint8Array) => {
      sent.push(raw);
      return "sig-broadcast";
    },
    confirmTransaction: async () => ({}),
  };
  return { db, solana };
}

describe("rewards payout (real on-chain claim)", () => {
  it("pays the exact AVAILABLE amount in a real transfer-checked USDC tx", async () => {
    const rig = makeRig();
    const treasury = Keypair.generate();
    const payout = new RewardsPayout(rig.db, rig.solana, treasury, USDC);
    const destination = Keypair.generate().publicKey.toBase58();

    const result = await payout.claim({ userId: 1, destinationAddress: destination });
    expect(result.amountUsdc).toBe("1250000"); // 1.25 USDC in micro
    expect(rig.solana.sent).toHaveLength(1);
    expect(rig.db.rows.every((r) => r.status === "CLAIMED")).toBe(true);

    const tx = Transaction.from(rig.solana.sent[0]!);
    const transfers = tx.instructions.filter((i) => i.programId.equals(TOKEN_PROGRAM_ID));
    // 1 create ATA (ATA program leg) + 1 transferChecked
    expect(transfers.length).toBe(1);
    const ataLeg = tx.instructions.find((i) => !i.programId.equals(TOKEN_PROGRAM_ID) && i.programId.toBase58() !== ComputeBudgetProgram.programId.toBase58());
    expect(ataLeg).toBeTruthy(); // createAssociatedTokenAccount → ATA program
    const transfer = transfers[0]!;
    // transferChecked data: id(1) + amount u64 LE(8) + decimals(1)
    expect(transfer.data.readBigUInt64LE(1)).toBe(1_250_000n);
    expect(transfer.data[9]).toBe(6);
  });

  it("refuses to claim when nothing is AVAILABLE (no double pay)", async () => {
    const rig = makeRig([]);
    const treasury = Keypair.generate();
    const payout = new RewardsPayout(rig.db, rig.solana, treasury, USDC);
    await expect(payout.claim({ userId: 1, destinationAddress: Keypair.generate().publicKey.toBase58() }))
      .rejects.toMatchObject({ code: "NOTHING_TO_CLAIM" });
    expect(rig.solana.sent).toHaveLength(0);
  });

  it("is idempotent per batch: a retried identical claim cannot double-pay", async () => {
    const rig = makeRig();
    const treasury = Keypair.generate();
    const payout = new RewardsPayout(rig.db, rig.solana, treasury, USDC);
    const destination = Keypair.generate().publicKey.toBase58();
    const batchKey = "batch-1";
    await payout.claim({ userId: 1, destinationAddress: destination, batchKey });
    await expect(payout.claim({ userId: 1, destinationAddress: destination, batchKey }))
      .rejects.toMatchObject({ code: "ALREADY_CLAIMED" });
    expect(rig.solana.sent).toHaveLength(1); // only one broadcast ever
  });

  it("journals the signature BEFORE broadcast with the ledger flip in one transaction", async () => {
    const rig = makeRig();
    const treasury = Keypair.generate();
    const payout = new RewardsPayout(rig.db, rig.solana, treasury, USDC);
    const destination = Keypair.generate().publicKey.toBase58();
    const promise = payout.claim({ userId: 1, destinationAddress: destination });
    const result = await promise;
    // Journal exists and matches the deterministic signature extraction.
    const journal = rig.db.settings.get(`rewards-payout:${result.sessionId}`);
    expect(journal).toBeTruthy();
    expect(JSON.parse(journal!).signature).toBe(result.signature);
    expect(rig.db.settings.get("lastClaimHash")).toBe(result.signature);
  });

  it("recovery resolves status against the RPC without re-sending", async () => {
    const rig = makeRig();
    const treasury = Keypair.generate();
    const payout = new RewardsPayout(rig.db, rig.solana, treasury, USDC);
    const destination = Keypair.generate().publicKey.toBase58();
    const { sessionId, signature } = await payout.claim({ userId: 1, destinationAddress: destination });

    // Unknown on RPC → unknown
    expect(await payout.status(sessionId)).toMatchObject({ status: "unknown", signature });
    // Pending
    rig.db.settings.set(`status:${signature}`, { err: null, confirmationStatus: "processed" });
    expect(await payout.status(sessionId)).toMatchObject({ status: "pending" });
    // Confirmed
    rig.db.settings.set(`status:${signature}`, { err: null, confirmationStatus: "confirmed" });
    expect(await payout.status(sessionId)).toMatchObject({ status: "confirmed" });
    // Failed
    rig.db.settings.set(`status:${signature}`, { err: "InstructionError" });
    expect(await payout.status(sessionId)).toMatchObject({ status: "failed" });
    // Never re-broadcast during recovery.
    expect(rig.solana.sent).toHaveLength(1);
  });

  it("status without journal = prepared (nothing was ever sent)", async () => {
    const rig = makeRig();
    const payout = new RewardsPayout(rig.db, rig.solana, Keypair.generate(), USDC);
    expect(await payout.status(payoutSessionId("a", "b", "1", "c"))).toMatchObject({ status: "prepared" });
  });

  it("keyless server (no treasury) refuses honestly", async () => {
    const rig = makeRig();
    const payout = new RewardsPayout(rig.db, rig.solana, null, USDC);
    await expect(payout.claim({ userId: 1, destinationAddress: Keypair.generate().publicKey.toBase58() }))
      .rejects.toMatchObject({ code: "NO_TREASURY" });
  });

  it("rejects malformed destination addresses before any chain call", async () => {
    const rig = makeRig();
    const payout = new RewardsPayout(rig.db, rig.solana, Keypair.generate(), USDC);
    await expect(payout.claim({ userId: 1, destinationAddress: "0xdeadbeef" }))
      .rejects.toMatchObject({ code: "BAD_ADDRESS" });
    expect(rig.solana.sent).toHaveLength(0);
  });

  it("payoutSignatureOf extracts the fee payer signature from a signed tx", () => {
    const signer = Keypair.generate();
    const tx = new Transaction().add(
      createTransferCheckedInstruction(PublicKey.default, PublicKey.default, PublicKey.default, signer.publicKey, 1n, 6),
    );
    tx.feePayer = signer.publicKey;
    tx.recentBlockhash = "11111111111111111111111111111111";
    tx.sign(signer);
    const raw = tx.serialize();
    const sig = payoutSignatureOf(raw);
    expect(sig).toBe(bs58.encode(tx.signatures[0]!.signature!));
  });
});
