/**
 * 🔑 API AUTH — API-key registration and Bearer authentication
 * Keys are generated once at registration and returned in plaintext exactly
 * once. Only a SHA-256 hash is stored, mirroring the honesty-first rules of
 * RaidOS: nothing sensitive is ever stored in recoverable form.
 */

import { createHash, randomBytes } from "node:crypto";

/** SHA-256 hex hash of an API key. */
export function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

/** Generate a fresh API key: `raidos_<32 random bytes hex>` plus its hash. */
export function generateApiKey(): { apiKey: string; keyHash: string } {
  const apiKey = `raidos_${randomBytes(32).toString("hex")}`;
  return { apiKey, keyHash: hashApiKey(apiKey) };
}

/** Extract the Bearer token from an Authorization header, if any. */
export function extractBearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match ? (match[1] as string).trim() : null;
}

/** Minimal db surface needed for auth. */
export interface AuthDb {
  getUserByApiKeyHash(keyHash: string): { user_id: number; api_key_hash: string; created_at: number } | undefined;
  countUsers(): number;
  createUser(userId: number, apiKeyHash: string): void;
}

export class AuthService {
  constructor(private db: AuthDb) {}

  /** True when the server accepts self-serve registration (no user yet). */
  needsBootstrap(): boolean {
    return this.db.countUsers() === 0;
  }

  /**
   * Register a new user. Requires the bootstrap secret once at least one user
   * exists (so a public deployment cannot be flooded with accounts).
   */
  register(bootstrapSecret: string | undefined, providedSecret: string | undefined): { userId: number; apiKey: string } {
    if (!this.needsBootstrap()) {
      const expected = bootstrapSecret ?? "";
      if (!providedSecret || providedSecret !== expected) {
        throw new AuthError("registration requires BOOTSTRAP_SECRET", 403);
      }
    }
    const userId = Math.floor(Date.now() / 1000) * 1000 + Math.floor(Math.random() * 1000);
    const { apiKey, keyHash } = generateApiKey();
    this.db.createUser(userId, keyHash);
    return { userId, apiKey };
  }

  /** Authenticate a request's Bearer token. Returns the user id or null. */
  authenticate(authorization: string | undefined): number | null {
    const token = extractBearerToken(authorization);
    if (!token) return null;
    const user = this.db.getUserByApiKeyHash(hashApiKey(token));
    return user ? user.user_id : null;
  }
}

/** Error carrying an HTTP status code. */
export class AuthError extends Error {
  constructor(message: string, public readonly status: number = 401) {
    super(message);
    this.name = "AuthError";
  }
}
