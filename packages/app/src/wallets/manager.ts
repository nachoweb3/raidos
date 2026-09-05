/**
 * 👛 WALLET MANAGER — create, import, encrypt, export wallets across chains
 * Each user can have multiple wallets per chain. Private keys are encrypted
 * with AES-256-GCM and stored in the database. Users can export keys anytime.
 */

import { ethers } from "ethers";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { encrypt, decrypt, type EncryptedPayload } from "./crypto.js";
import { CHAINS, type ChainConfig } from "../chains/config.js";

/** Stored wallet row in the database. */
export interface WalletRow {
  id: number;
  user_id: number;
  /** Chain identifier (solana, ethereum, base, etc.) */
  chain: string;
  /** Public address */
  address: string;
  /** Encrypted private key */
  encrypted_key: EncryptedPayload;
  /** Optional label the user assigns */
  label: string;
  /** Whether this is the user's primary wallet for this chain */
  is_primary: number;
  created_at: number;
}

/** Public wallet info (no keys). */
export interface PublicWallet {
  id: number;
  chain: string;
  address: string;
  label: string;
  isPrimary: boolean;
  createdAt: number;
}

export class WalletManager {
  constructor(
    private db: { getWallet(userId: number, chain: string): WalletRow | undefined; getUserWallets(userId: number): WalletRow[]; createWallet(userId: number, chain: string, address: string, encryptedKey: EncryptedPayload, label: string, isPrimary: number): number; deleteWallet(walletId: number, userId: number): boolean; setPrimaryWallet(userId: number, chain: string, walletId: number): void }
  ) {}

  /** Create a fresh Solana wallet (keypair). */
  createSolanaWallet(userId: number, password: string, label = "Primary"): PublicWallet {
    // Full 64-byte secret key (seed + public key) so Keypair.fromSecretKey
    // round-trips: import/execute use fromSecretKey, not fromSeed.
    const keypair = Keypair.generate();
    const privateKey = bs58.encode(keypair.secretKey);
    const address = keypair.publicKey.toBase58();

    const encrypted = encrypt(privateKey, password);
    const isPrimary = this.db.getWallet(userId, "solana") ? 0 : 1;
    const id = this.db.createWallet(userId, "solana", address, encrypted, label, isPrimary);

    return { id, chain: "solana", address, label, isPrimary: !!isPrimary, createdAt: Date.now() };
  }

  /** Create a fresh EVM wallet for any supported EVM chain. */
  createEvmWallet(userId: number, chain: string, password: string, label = "Primary"): PublicWallet {
    const config = CHAINS[chain];
    if (!config || !config.evm) throw new Error(`Chain "${chain}" is not an EVM chain`);

    const wallet = ethers.Wallet.createRandom();
    const encrypted = encrypt(wallet.privateKey, password);
    const isPrimary = this.db.getWallet(userId, chain) ? 0 : 1;
    const id = this.db.createWallet(userId, chain, wallet.address, encrypted, label, isPrimary);

    return { id, chain, address: wallet.address, label, isPrimary: !!isPrimary, createdAt: Date.now() };
  }

  /** Import an existing private key for any chain. */
  importWallet(userId: number, chain: string, privateKey: string, password: string, label = "Imported"): PublicWallet {
    const config = CHAINS[chain];
    if (!config) throw new Error(`Unknown chain: ${chain}`);

    let address: string;

    if (chain === "solana") {
      const decoded = bs58.decode(privateKey);
      const keypair = Keypair.fromSecretKey(decoded);
      address = keypair.publicKey.toBase58();
    } else {
      const wallet = new ethers.Wallet(privateKey);
      address = wallet.address;
    }

    const encrypted = encrypt(privateKey, password);
    const isPrimary = this.db.getWallet(userId, chain) ? 0 : 1;
    const id = this.db.createWallet(userId, chain, address, encrypted, label, isPrimary);

    return { id, chain, address, label, isPrimary: !!isPrimary, createdAt: Date.now() };
  }

  /** Export a private key (decrypts it — user must provide password). */
  exportPrivateKey(userId: number, chain: string, password: string): string {
    const row = this.db.getWallet(userId, chain);
    if (!row) throw new Error(`No wallet found for chain "${chain}"`);
    return decrypt(row.encrypted_key, password);
  }

  /** Export wallet as JSON keystore (EVM) or base58 (Solana). */
  async exportKeystore(userId: number, chain: string, password: string, exportPassword: string): Promise<string> {
    const privateKey = this.exportPrivateKey(userId, chain, password);
    const config = CHAINS[chain];

    if (chain === "solana") {
      return JSON.stringify({
        chain: "solana",
        privateKey: privateKey, // base58
        exportedAt: new Date().toISOString(),
      });
    }

    // EVM: export as ethers v6 encrypted keystore
    const wallet = new ethers.Wallet(privateKey);
    return wallet.encrypt(exportPassword);
  }

  /** List all wallets for a user (public info only). */
  listWallets(userId: number): PublicWallet[] {
    return this.db.getUserWallets(userId).map((r) => ({
      id: r.id,
      chain: r.chain,
      address: r.address,
      label: r.label,
      isPrimary: !!r.is_primary,
      createdAt: r.created_at,
    }));
  }

  /** Delete a wallet (requires password verification). */
  deleteWallet(userId: number, walletId: number, password: string): boolean {
    // Verify password first
    const wallets = this.db.getUserWallets(userId);
    const wallet = wallets.find((w) => w.id === walletId);
    if (!wallet) return false;
    if (!verifyPasswordLocal(wallet.encrypted_key, password)) return false;
    return this.db.deleteWallet(walletId, userId);
  }

  /** Set a wallet as primary for its chain. */
  setPrimary(userId: number, chain: string, walletId: number): void {
    this.db.setPrimaryWallet(userId, chain, walletId);
  }
}

// Inline import to avoid circular deps
import { verifyPassword as verifyPasswordLocal } from "./crypto.js";
