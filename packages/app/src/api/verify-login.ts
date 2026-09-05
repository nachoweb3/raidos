/**
 * 🔏 LOGIN VERIFICATION — proves a user owns a wallet before linking it.
 *
 * Solana (Phantom): the message is signed with the wallet's ed25519 keypair.
 *   `verifySolanaSignature(address, message, signature)` checks the raw
 *   ed25519 signature against the address' public key.
 * EVM (MetaMask): `personal_sign` produces an EIP-191 signature over the
 *   message; ethers `verifyMessage` recovers the signer address.
 */

import bs58 from "bs58";
import { verify as ed25519Verify, createPublicKey, type KeyObject } from "node:crypto";
import { PublicKey } from "@solana/web3.js";

/** Convert a base58 Solana address to an ed25519 SPKI public key. */
function addressToPublicKey(address: string): KeyObject {
  const raw = bs58.decode(address);
  if (raw.length !== 32) throw new Error("invalid public key length");
  // ed25519 SPKI DER prefix + 32-byte raw key
  const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

/** Verify a raw ed25519 signature (Phantom `signMessage`). */
export function verifySolanaSignature(address: string, message: string, signatureHex: string): boolean {
  try {
    const pub = new PublicKey(address); // validates base58 + curve
    if (pub.toBase58() !== address) return false;
    const sig = Buffer.from(signatureHex, "hex");
    if (sig.length !== 64) return false;
    const key = addressToPublicKey(address);
    return ed25519Verify(null, Buffer.from(message, "utf8"), key, sig);
  } catch {
    return false;
  }
}

/** Verify an EIP-191 `personal_sign` signature (MetaMask). Returns the recovered address or null. */
export async function verifyEvmSignature(message: string, signature: string): Promise<string | null> {
  try {
    const { ethers } = await import("ethers");
    const recovered = ethers.verifyMessage(message, signature);
    return recovered.toLowerCase();
  } catch {
    return null;
  }
}

/** Normalize an EVM address for identity lookups (lowercase hex). */
export function normalizeEvmAddress(address: string): string {
  return address.toLowerCase().startsWith("0x") ? address.toLowerCase() : `0x${address.toLowerCase()}`;
}