/**
 * 🔐 ACCESS CODES — pases de 24h para la pestaña 📡 Señales TG de la web.
 *
 * Flujo: miembro verificado del grupo escribe /code en DM → el bot verifica
 * membresía (getChatMember) → minta el código vía la API de TRENCHES
 * (secreto admin compartido) → responde por DM con el código personal.
 *
 * El canje ocurre en la web: un solo uso, ventana de 24h desde el canje.
 */

export interface AccessCodeApiOptions {
  /** Base de la API TRENCHES (ej. https://raidos-api.fly.dev). */
  apiBase: string;
  /** ADMIN_SECRET compartido con la API (header x-admin-secret). */
  adminSecret: string;
  /** Injected fetch para tests. */
  fetchImpl?: typeof fetch;
}

export interface MintedCode {
  code: string;
  /** Unix seconds: caducidad del código SIN canjear (el canje da 24h nuevos). */
  expiresAt: number;
}

export class AccessCodeClient {
  private readonly apiBase: string;
  private readonly adminSecret: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AccessCodeApiOptions) {
    this.apiBase = options.apiBase.replace(/\/+$/, "");
    this.adminSecret = options.adminSecret;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get configured(): boolean {
    return Boolean(this.apiBase && this.adminSecret);
  }

  /** Minta (o rota) el código de un miembro. Rotar revoca el código anterior. */
  async mint(telegramUserId: string, telegramUsername = "", chatId = ""): Promise<MintedCode> {
    if (!this.configured) throw new Error("access codes disabled: TRENCHES_API_BASE/ADMIN_SECRET missing");
    const res = await this.fetchImpl(`${this.apiBase}/api/admin/tg/mint-code`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-secret": this.adminSecret,
      },
      body: JSON.stringify({ telegramUserId, telegramUsername, chatId }),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => null)) as { code?: string; expiresAt?: number; error?: string } | null;
    if (!res.ok || !json?.code || !json?.expiresAt) {
      throw new Error(json?.error ?? `mint failed: HTTP ${res.status}`);
    }
    return { code: String(json.code), expiresAt: Number(json.expiresAt) };
  }
}

/** Cooldown simple en memoria anti-spam de /code por usuario. */
export class MintRateLimiter {
  private last = new Map<string, number>();
  constructor(private readonly cooldownMs = 60_000, private readonly now: () => number = Date.now) {}

  /** true cuando la petición puede pasar; registra el intento. */
  allow(userId: string): boolean {
    const now = this.now();
    const prev = this.last.get(userId) ?? 0;
    if (now - prev < this.cooldownMs) return false;
    this.last.set(userId, now);
    // Poda ligera para no crecer sin límite.
    if (this.last.size > 5_000) {
      for (const [k, ts] of this.last) if (now - ts > this.cooldownMs * 10) this.last.delete(k);
    }
    return true;
  }
}
