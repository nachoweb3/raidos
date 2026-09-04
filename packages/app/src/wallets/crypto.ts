/**
 * 🔐 WALLET CRYPTO — AES-256-GCM encryption for private keys
 * Private keys are encrypted with a user-derived password before storage.
 * The user can export their keys at any time — we never hold plaintext.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const SALT_LENGTH = 32;
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const SCRYPT_N = 2 ** 14; // 16384 — good balance of security and memory
const SCRYPT_R = 8;
const SCRYPT_P = 1;

/** Derive a 256-bit key from a password + salt using scrypt. */
function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }) as Buffer;
}

/** Encrypted payload structure stored in the database. */
export interface EncryptedPayload {
  /** Salt used for key derivation (hex) */
  salt: string;
  /** Initialization vector (hex) */
  iv: string;
  /** Auth tag from GCM (hex) */
  tag: string;
  /** Ciphertext (hex) */
  data: string;
  /** Version for future migration */
  version: number;
}

/**
 * Encrypt a plaintext string (e.g. private key) with a user password.
 * Returns a JSON-serializable encrypted payload.
 */
export function encrypt(plaintext: string, password: string): EncryptedPayload {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = deriveKey(password, salt);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    data: encrypted.toString("hex"),
    version: 1,
  };
}

/**
 * Decrypt an encrypted payload back to plaintext.
 * Throws if the password is wrong (GCM auth tag verification).
 */
export function decrypt(payload: EncryptedPayload, password: string): string {
  const salt = Buffer.from(payload.salt, "hex");
  const iv = Buffer.from(payload.iv, "hex");
  const tag = Buffer.from(payload.tag, "hex");
  const data = Buffer.from(payload.data, "hex");
  const key = deriveKey(password, salt);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString("utf8");
}

/** Quick validation: try decrypting to verify the password is correct. */
export function verifyPassword(payload: EncryptedPayload, password: string): boolean {
  try {
    decrypt(payload, password);
    return true;
  } catch {
    return false;
  }
}
