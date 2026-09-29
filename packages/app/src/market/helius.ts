import { validChain, validAddress } from "./validate.js";


/**
 * Bounded Solana observations. Tip payments do not prove bundle membership.
 * The initialization fee payer is a deployment payer, not verified creator identity.
 * HELIUS_RPC_URL stays server-side; missing credentials produce an explicit 503.
 * Tip accounts verified with official Jito getTipAccounts on 2026-09-27.
 */
export const JITO_TIP_ACCOUNTS = [
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
] as const;

const TOKEN_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // SPL Token
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // Token-2022
]);

/** Minimum observed Jito-account credit: 1000 lamports (0.000001 SOL). */
const MIN_TIP_LAMPORTS = 1_000;
const SIG_SAMPLE = 150;
const TX_BATCH = 60;
const CONCURRENCY = 2;
const CREATOR_SIG_SAMPLE = 60;
const CREATOR_TX_BATCH = 25;
const CREATION_PAGES = 3;
const CACHE_TTL = 300_000;
const CACHE_MAX = 200;

export class HeliusUnavailableError extends Error {
  readonly reason = "HELIUS_RPC_URL_NOT_CONFIGURED";
  constructor() { super("HELIUS_RPC_URL not configured"); }
}

export interface BundleProbe {
  observedBuys: number | null; bundleBuys: number | null; bundlesPct: number | null;
  tippedTransactions: number; requestedSampleSize: number; complete: boolean;
  sampleSize: number; windowFrom: number | null; windowTo: number | null;
  method: string; note: string;
}
export interface CreatorLaunch {
  mint: string; poolFound: boolean | null; liquidityUsd: number | null; note: string;
}
export interface CreatorProfile {
  creator: string | null; creatorSol: number | null;
  tokensLaunched: number | null; sampleSize: number;
  launches: CreatorLaunch[]; note: string;
  historyComplete?: boolean; historySource?: "helius-archive" | "rpc-sample";
  requestedSampleSize?: number; creationSignature?: string | null; createdAt?: number | null;
}
export interface OnchainRisk {
  chain: string; address: string;
  bundle: BundleProbe; creator: CreatorProfile;
  source: string; status: "LIVE" | "DEGRADED"; asOf: number;
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Decode(s: string): Uint8Array | null {
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(s) || !s) return null;
  const bytes: number[] = [0];
  for (const ch of s) {
    let carry = B58.indexOf(ch);
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (let i = 0; s[i] === "1" && i < s.length - 1; i++) bytes.push(0);
  return new Uint8Array(bytes.reverse());
}

const chunks = <T>(arr: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

export class HeliusOnchainService {
  private readonly fetcher: Fetcher;
  private readonly artworkCache = new Map<string, { imageUrls: string[]; asOf: number }>();
  private readonly artworkPending = new Map<string, Promise<{ imageUrls: string[]; asOf: number }>>();
  private rpcTurn: Promise<void> = Promise.resolve();
  private archiveRetryAt = 0;
  private readonly rpcIntervalMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, { value: OnchainRisk; expires: number }>();
  private readonly inflight = new Map<string, Promise<OnchainRisk>>();
  constructor(options: { fetcher?: Fetcher; now?: () => number } = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.rpcIntervalMs = options.fetcher ? 0 : 150;
    this.now = options.now ?? Date.now;
  }

  private rpcUrl(): string {
    const key = process.env.HELIUS_API_KEY?.trim();
    const url = process.env.HELIUS_RPC_URL?.trim() || (key ? "https://mainnet.helius-rpc.com/?api-key=" + encodeURIComponent(key) : "");
    if (!url) throw new HeliusUnavailableError();
    return url;
  }

  private async rpc<T = any>(method: string, params: unknown[] | Record<string, unknown>): Promise<T> {
    // Share pacing across token probes to avoid bursts exhausting the RPC quota.
    const turn = this.rpcTurn;
    this.rpcTurn = turn.then(() => new Promise<void>(resolve => setTimeout(resolve, this.rpcIntervalMs)));
    await turn;
    const response = await this.fetcher(this.rpcUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("helius rpc unavailable: " + response.status);
    const body: any = await response.json();
    if (body?.error) throw new Error("helius rpc error: " + (body.error?.message ?? "unknown"));
    return body?.result as T;
  }

  /**
   * Full on-chain risk snapshot for one Solana mint. Cached 5 min per token:
   * a probe costs up to ~60 getTransaction calls, callers must not re-run it
   * per render tick.
   */
  async risk(chain: string, token: string): Promise<OnchainRisk> {
    validChain(chain);
    if (chain !== "solana") throw new Error("invalid chain: helius analytics is solana-only");
    validAddress(token);
    this.rpcUrl(); // throws HeliusUnavailableError before any caching
    const key = "risk:" + token;
    const cached = this.cache.get(key);
    if (cached && cached.expires > this.now()) return Promise.resolve(cached.value);
    const running = this.inflight.get(key);
    if (running) return running;
    if (this.inflight.size >= 2) throw new Error("helius analytics capacity reached; retry later");
    const promise = this.computeRisk(token).then((value) => {
      if (this.cache.size >= CACHE_MAX && !this.cache.has(key)) {
        this.cache.delete(this.cache.keys().next().value!);
      }
      this.cache.set(key, { value, expires: this.now() + CACHE_TTL });
      return value;
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  async artwork(token: string): Promise<{ imageUrls: string[]; asOf: number }> {
    validAddress(token);
    this.rpcUrl();
    const hit = this.artworkCache.get(token);
    if (hit && this.now() - hit.asOf < 3600000) return hit;
    const pending = this.artworkPending.get(token);
    if (pending) return pending;
    if (this.artworkPending.size >= 4) throw new Error("Artwork capacity reached");
    const task = (async () => {
      const asset: any = await this.rpc("getAsset", { id: token });
      if (asset?.id !== token) throw new Error("Asset metadata mismatch");
      const candidates = [asset.content?.links?.image, ...(asset.content?.files ?? []).flatMap((f: any) => [f.cdn_uri, f.uri])];
      const imageUrls = [...new Set<string>(candidates.filter((u: unknown): u is string =>
        typeof u === "string" && u.length < 2048 && /^(https:\/\/|ipfs:\/\/)/.test(u)))].slice(0, 4);
      const value = { imageUrls, asOf: this.now() };
      if (this.artworkCache.size >= 300) this.artworkCache.delete(this.artworkCache.keys().next().value!);
      this.artworkCache.set(token, value);
      return value;
    })().finally(() => this.artworkPending.delete(token));
    this.artworkPending.set(token, task);
    return task;
  }

  /** Bounded archive query; transient/unsupported providers fall back to standard RPC. */
  private async archive(address: string, sortOrder: "asc" | "desc", limit: number, paginationToken?: string): Promise<{ data: any[]; paginationToken?: string } | null> {
    if (this.archiveRetryAt > this.now()) return null;
    try {
      const result: any = await this.rpc("getTransactionsForAddress", [address, {
        transactionDetails: "full", encoding: "json", sortOrder, limit,
        maxSupportedTransactionVersion: 1, filters: { status: "succeeded", tokenAccounts: "none" },
        ...(paginationToken ? { paginationToken } : {}),
      }]);
      if (!Array.isArray(result?.data) || result.data.length > limit ||
          (result.paginationToken != null && typeof result.paginationToken !== "string")) throw new Error("Invalid archive");
      return result;
    } catch {
      this.archiveRetryAt = this.now() + 60000;
      return null;
    }
  }

  private async computeRisk(token: string): Promise<OnchainRisk> {
    const bundle = await this.bundleProbe(token);
    let creator: CreatorProfile;
    let degraded = !bundle.probe.complete;
    try { creator = await this.creatorProfile(token, bundle.oldestSignature); }
    catch {
      degraded = true;
      creator = { creator: null, creatorSol: null, tokensLaunched: null, sampleSize: 0, launches: [], note: "Historial temporalmente no disponible" };
    }
    return {
      chain: "solana", address: token, bundle: bundle.probe, creator,
      source: "helius-rpc", status: degraded ? "DEGRADED" : "LIVE", asOf: this.now(),
    };
  }

  private async bundleProbe(token: string): Promise<{ probe: BundleProbe; oldestSignature: string | null }> {
    const page = await this.archive(token, "desc", TX_BATCH);
    if (page) {
      const txs = page.data.filter(tx => tx?.transaction?.message && tx?.meta?.err === null);
      const times = txs.map(tx => tx.blockTime).filter(Number.isInteger);
      return { oldestSignature: txs.at(-1)?.transaction?.signatures?.[0] ?? null, probe: {
        observedBuys: null, bundleBuys: null, bundlesPct: null,
        tippedTransactions: txs.filter(hasJitoTip).length,
        sampleSize: txs.length, requestedSampleSize: page.data.length,
        complete: txs.length === page.data.length,
        windowFrom: times.length ? Math.min(...times) : null,
        windowTo: times.length ? Math.max(...times) : null,
        method: "jito-tip-transfer",
        note: "Pagos observados a cuentas Jito (>= 1000 lamports). No demuestran compras ni pertenencia a bundles. Muestra limitada de transacciones del mint.",
      }};
    }
    const sigs: any[] = await this.rpc("getSignaturesForAddress", [token, { limit: SIG_SAMPLE }]);
    if (!Array.isArray(sigs)) throw new Error("helius signature response invalid");
    const ok = (Array.isArray(sigs) ? sigs : []).filter((s) => s?.signature && s.err === null && Number.isInteger(s.blockTime));
    const sample = ok.slice(0, TX_BATCH);
    const times = sample.map((s) => s.blockTime as number);
    const probe: BundleProbe = {
      observedBuys: null, bundleBuys: null, bundlesPct: null, tippedTransactions: 0,
      sampleSize: 0, requestedSampleSize: sample.length, complete: true,
      windowFrom: times.length ? Math.min(...times) : null,
      windowTo: times.length ? Math.max(...times) : null,
      method: "jito-tip-transfer",
      note: "Pagos observados a cuentas Jito (>= 1000 lamports). No demuestran compras ni pertenencia a bundles. Muestra limitada de transacciones del mint.",
    };
    if (!sample.length) return { probe, oldestSignature: ok[ok.length - 1]?.signature ?? null };
    const txs = await this.fetchTxs(sample.map((s) => s.signature as string));
    probe.sampleSize = txs.length;
    probe.complete = txs.length === sample.length;
    probe.tippedTransactions = txs.filter(hasJitoTip).length;
    // The creation tx is the oldest in the sample when the sample reaches it.
    const oldest = ok.length ? ok[ok.length - 1] : null;
    return { probe, oldestSignature: oldest?.signature ?? null };
  }

  private async fetchTxs(signatures: string[]): Promise<any[]> {
    const out: any[] = [];
    for (const batch of chunks(signatures, CONCURRENCY)) {
      const settled = await Promise.allSettled(
        batch.map((sig) => this.rpc("getTransaction", [sig, { encoding: "json", maxSupportedTransactionVersion: 1 }])),
      );
      for (const r of settled) if (r.status === "fulfilled" && r.value) out.push(r.value);
    }
    return out;
  }

  /**
   * Creator = fee payer of the mint's creation tx. The recent-signature sample
   * of an old token may not reach creation, so walk up to CREATION_PAGES older
   * pages looking for a tx that initializes our mint; otherwise stay null.
   */
  private async creatorProfile(token: string, oldestSignature: string | null): Promise<CreatorProfile> {
    const profile: CreatorProfile = {
      creator: null, creatorSol: null, tokensLaunched: null, sampleSize: 0,
      launches: [],
      note: "Pagador de despliegue (no identidad verificada del creador) = fee payer de la transacción de creación del mint. Lanzamientos = instrucciones initializeMint firmadas por esa cartera en una muestra acotada de su actividad reciente.",
    };
    profile.historyComplete = false;
    profile.historySource = "rpc-sample";
    const firstPage = await this.archive(token, "asc", 20);
    let creation: any = firstPage?.data.find(tx => createsMint(tx, token)) ?? null;
    if (!creation && oldestSignature) {
      const first = (await this.fetchTxs([oldestSignature]))[0];
      if (first && createsMint(first, token)) creation = first;
      if (!creation) {
        let before = oldestSignature;
        for (let page = 0; page < CREATION_PAGES && !creation; page++) {
          const sigs: any[] = await this.rpc("getSignaturesForAddress", [token, { limit: 100, before }]);
          const ok = (Array.isArray(sigs) ? sigs : []).filter((s) => s?.signature && s.err === null);
          if (!ok.length) break;
          const candidate = ok[ok.length - 1];
          const tx = (await this.fetchTxs([candidate.signature]))[0];
          if (tx && createsMint(tx, token)) creation = tx;
          before = candidate.signature;
        }
      }
    }
    if (!creation) {
      profile.note += " La muestra no alcanzó la transacción de creación: creador desconocido.";
      return profile;
    }
    const creator = feePayer(creation);
    if (!creator) return profile;
    profile.creator = creator;
    profile.creationSignature = creation.transaction?.signatures?.[0] ?? null;
    profile.createdAt = Number.isInteger(creation.blockTime) ? creation.blockTime : null;
    const balance: any = await this.rpc("getBalance", [creator]).catch(() => null);
    if (balance && Number.isFinite(balance.value)) profile.creatorSol = Math.round((balance.value / 1e9) * 1e6) / 1e6;

    // Scan up to 300 successful payer transactions; cursor exhaustion is explicit.
    let txs: any[] = [];
    let requested = 0;
    const recent = await this.archive(creator, "desc", 100);
    if (recent) {
      profile.historySource = "helius-archive";
      let page = recent;
      const seenCursors = new Set<string>();
      let valid = true;
      for (let i = 0; i < 3; i++) {
        requested += page.data.length;
        const usable = page.data.filter(tx => tx?.transaction?.message && tx?.meta?.err === null);
        valid = valid && usable.length === page.data.length;
        txs.push(...usable);
        if (!page.paginationToken) { profile.historyComplete = valid; break; }
        if (i === 2 || seenCursors.has(page.paginationToken)) break;
        seenCursors.add(page.paginationToken);
        const next = await this.archive(creator, "desc", 100, page.paginationToken);
        if (!next) break;
        page = next;
      }
    } else {
      const sigs: any[] = await this.rpc("getSignaturesForAddress", [creator, { limit: CREATOR_SIG_SAMPLE }]);
      if (!Array.isArray(sigs)) throw new Error("helius creator history invalid");
      const ok = sigs.filter(s => s?.signature && s.err === null);
      requested = Math.min(ok.length, CREATOR_TX_BATCH);
      txs = await this.fetchTxs(ok.slice(0, CREATOR_TX_BATCH).map(s => s.signature as string));
    }
    profile.requestedSampleSize = requested;
    profile.sampleSize = txs.length;
    profile.note = "Pagador de despliegue, no identidad verificada del creador. Otros mints inicializados y pagados por esta cartera. " +
      (profile.historyComplete ? "Se alcanzo el final del historial de transacciones exitosas devuelto por Helius." : "Muestra acotada: no representa todo el historial.") +
      (txs.length < requested ? " Hay transacciones no disponibles." : "");
    const mints = new Set<string>();
    for (const tx of txs) {
      if (feePayer(tx) !== creator) continue;
      for (const mint of initializedMints(tx)) mints.add(mint);
    }
    mints.delete(token);
    profile.tokensLaunched = txs.length || requested === 0 ? mints.size : null;
    const head = [...mints].slice(0, 8);
    for (const mint of head) profile.launches.push(await this.launchStatus(mint));
    return profile;
  }

  /** Pool status via injected DexScreener lookup — absent lookup stays honest-null. */
  protected async launchStatus(mint: string): Promise<CreatorLaunch> {
    return { mint, poolFound: null, liquidityUsd: null, note: "Sin verificación de pool (lookup no configurado)" };
  }
}

/** Pool-status decorator: resolves each observed launch against DexScreener. */
export class HeliusRiskService extends HeliusOnchainService {
  constructor(private readonly lookupPool: (mint: string) => Promise<{ liquidityUsd: number | null } | undefined>, options: { fetcher?: Fetcher; now?: () => number } = {}) {
    super(options);
  }
  protected override async launchStatus(mint: string): Promise<CreatorLaunch> {
    const base = await super.launchStatus(mint);
    try {
      const pool = await this.lookupPool(mint);
      if (!pool) return { ...base, poolFound: false, note: "Sin pool observado en DexScreener; no demuestra un rug ni ausencia de mercado" };
      return { ...base, poolFound: true, liquidityUsd: pool.liquidityUsd, note: "Pool indexado observado" };
    } catch {
      return { ...base, note: "Verificación de pool no disponible ahora" };
    }
  }
}

// ── transaction classification helpers (pure, json encoding) ────────────

function accountKeys(tx: any): string[] {
  const raw = tx?.transaction?.message?.accountKeys;
  if (!Array.isArray(raw)) return [];
  const keys = raw.map((k: any) => typeof k === "string" ? k : k?.pubkey);
  // json encoding indexes static keys followed by writable/readonly lookup keys.
  return [...keys, ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])];
}

function feePayer(tx: any): string | null {
  return accountKeys(tx)[0] ?? null;
}

const rawAmount = (entry: any): bigint => {
  const amount = entry?.uiTokenAmount?.amount;
  return typeof amount === "string" && /^\d+$/.test(amount) ? BigInt(amount) : 0n;
};

/** Raw balance changes alone cannot distinguish swaps from transfers or LP activity. */
export function classifySwap(_tx: any, _mint: string): "buy" | "sell" | null {
  return null;
}

/** True when any account ends the tx with a ≥ MIN_TIP_LAMPORTS credit to a Jito tip account. */
export function hasJitoTip(tx: any): boolean {
  if (!tx || tx.meta?.err != null) return false;
  const keys = accountKeys(tx);
  const pre = tx?.meta?.preBalances;
  const post = tx?.meta?.postBalances;
  if (!Array.isArray(pre) || !Array.isArray(post) || pre.length !== post.length) return false;
  for (let i = 0; i < keys.length; i++) {
    if (!(JITO_TIP_ACCOUNTS as readonly string[]).includes(keys[i]!)) continue;
    const delta = Number(post[i]) - Number(pre[i]);
    if (Number.isSafeInteger(delta) && delta >= MIN_TIP_LAMPORTS) return true;
  }
  return false;
}

/** Only an actual successful initializeMint instruction proves mint creation. */
export function createsMint(tx: any, mint: string): boolean {
  return initializedMints(tx).includes(mint);
}

/** Mints of initializeMint/initializeMint2 instructions (SPL Token and Token-2022). */
export function initializedMints(tx: any): string[] {
  if (!tx || tx.meta?.err != null) return [];
  const keys = accountKeys(tx);
  const out: string[] = [];
  const instructions = [
    ...(tx?.transaction?.message?.instructions ?? []),
    ...((tx?.meta?.innerInstructions ?? []).flatMap((i: any) => i?.instructions ?? [])),
  ];
  for (const ix of instructions) {
    const program = ix?.programId ?? keys[ix?.programIdIndex];
    if (!TOKEN_PROGRAMS.has(program)) continue;
    const data = base58Decode(typeof ix?.data === "string" ? ix.data : "");
    // SPL Token opcodes: InitializeMint = 0, InitializeMint2 = 20.
    if (!data || data.length < 35 || (data[0] !== 0 && data[0] !== 20)) continue;
    const accounts: any[] = ix.accounts ?? [];
    const mintIndex = accounts[0];
    const mint = typeof mintIndex === "number" ? keys[mintIndex] : mintIndex;
    if (typeof mint === "string") out.push(mint);
  }
  return out;
}
