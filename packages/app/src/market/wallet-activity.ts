/**
 * 🔎 WALLET ACTIVITY PROVIDERS — observed on-chain swaps of tracked wallets.
 *
 * Interface-first like holders.ts: the Helius Enhanced Transactions provider
 * ships first (the Enhanced API needs an api-key — there is no keyless
 * variant), a mock keeps tests/demo honest, and more providers (webhooks,
 * other chains) plug in without touching the app.
 *
 * Honest by design: this is the raw OBSERVATION layer — every row carries its
 * signature and provider id. No PnL is invented here; positions/aggregators
 * build on top of these rows later (docs/ROADMAP_V2.md §3.1).
 */

export interface ObservedSwap {
  /** Transaction signature/tx hash (dedupe key). */
  signature: string;
  /** Token contract of the non-quote leg (the memecoin side). */
  token: string;
  /** Wallet observed (the tracked wallet). */
  wallet: string;
  /** buy = token acquired, sell = token disposed. */
  side: "buy" | "sell";
  /** Token amount in smallest units (string to avoid float drift). */
  amountToken: string;
  /** USD value when the provider reports it. */
  amountUsd: number | null;
  /** USD per token when the provider reports it. */
  priceUsd: number | null;
  /** Block time, unix seconds. */
  ts: number;
  /** Provider that served the observation (honesty rule: shown in UI). */
  source: string;
}

export interface WalletActivityResult {
  swaps: ObservedSwap[];
  /** Which provider served this batch. */
  source: string;
}

export interface WalletActivityProvider {
  readonly id: string;
  supportsChain(chainId: string): boolean;
  /** Latest swaps of one wallet, newest first, bounded by `limit`. */
  getWalletActivity(chainId: string, wallet: string, limit?: number): Promise<WalletActivityResult>;
}

// ── Helius Enhanced Transactions (Solana) ────────────────────────────────
// GET https://api.helius.xyz/v0/addresses/{address}/transactions?api-key=…
// 100 credits per call; free plan 1M credits/month → ~10k wallet polls.
// Only SWAP-typed parsed transactions are translated; everything else is
// ignored (transfers/collections are not swaps).

const HELIUS_ENHANCED_URL = "https://api.helius.xyz/v0/addresses";
const SOLANA_WRAPPED_SOL = "So11111111111111111111111111111111111111112";

/** Quote-side mints that identify the token leg of a Solana swap. */
const SOLANA_QUOTE_MINTS = new Set([
  SOLANA_WRAPPED_SOL,
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

type HeliusTokenTransfer = {
  from_user_account?: string;
  to_user_account?: string;
  from_token_account?: string;
  to_token_account?: string;
  mint?: string;
  token_amount?: number;
  token_standard?: string;
};

type HeliusTx = {
  signature?: string;
  timestamp?: number;
  type?: string;
  token_transfers?: HeliusTokenTransfer[];
  native_transfers?: Array<{ from_user_account?: string; to_user_account?: string; amount?: number }>;
};

export class HeliusWalletActivityProvider implements WalletActivityProvider {
  readonly id = "helius";
  constructor(
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  supportsChain(chainId: string): boolean {
    return chainId === "solana";
  }

  async getWalletActivity(chainId: string, wallet: string, limit = 20): Promise<WalletActivityResult> {
    if (!this.supportsChain(chainId)) throw new Error(`provider ${this.id} does not support chain ${chainId}`);
    const capped = Math.min(Math.max(limit, 1), 100);
    const url = `${HELIUS_ENHANCED_URL}/${encodeURIComponent(wallet)}/transactions?api-key=${encodeURIComponent(this.apiKey)}&limit=${capped}&type=SWAP`;
    const res = await this.fetcher(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`helius enhanced api ${res.status}`);
    const rows = (await res.json()) as HeliusTx[];
    const swaps: ObservedSwap[] = [];
    for (const tx of Array.isArray(rows) ? rows : []) {
      const signature = String(tx.signature ?? "");
      const ts = Number(tx.timestamp ?? 0);
      if (!signature || !Number.isFinite(ts) || ts <= 0) continue;
      // Defensive: the URL asks for SWAP-typed txs only, but if the upstream
      // ever returns other types (contract change, proxy response) we must not
      // count plain transfers as swaps.
      if (tx.type && tx.type !== "SWAP") continue;
      const swap = this.translateSwap(tx, wallet);
      if (swap) swaps.push({ ...swap, signature, ts, source: this.id });
    }
    return { swaps, source: this.id };
  }

  /** Reduce one parsed SWAP tx to the tracked wallet's token leg (or null). */
  private translateSwap(tx: HeliusTx, wallet: string): Omit<ObservedSwap, "signature" | "ts" | "source"> | null {
    const transfers = Array.isArray(tx.token_transfers) ? tx.token_transfers : [];
    const legs = transfers.filter((t) => t.mint && !SOLANA_QUOTE_MINTS.has(t.mint));
    if (legs.length !== 1) return null; // ambiguous or non-swap-shaped → skip, never guess
    const leg = legs[0]!;
    const mint = leg.mint!;
    const amount = Math.abs(Number(leg.token_amount ?? 0));
    if (!(amount > 0)) return null;
    const incoming = leg.to_user_account === wallet || leg.to_token_account === wallet;
    const outgoing = leg.from_user_account === wallet || leg.from_token_account === wallet;
    if (!incoming && !outgoing) return null; // swap does not involve the tracked wallet
    return { token: mint, wallet, side: incoming && !outgoing ? "buy" : "sell", amountToken: String(amount), amountUsd: null, priceUsd: null };
  }
}

// ── Mock (labeled SIMULATED — only ever used in mock mode / tests) ────────

export class MockWalletActivityProvider implements WalletActivityProvider {
  readonly id = "mock";
  constructor(private readonly fixture: ObservedSwap[] = []) {}
  supportsChain(): boolean {
    return true;
  }
  async getWalletActivity(_chainId: string, wallet: string, limit = 20): Promise<WalletActivityResult> {
    return {
      swaps: this.fixture
        .filter((s) => s.wallet === wallet)
        .slice(0, Math.min(Math.max(limit, 1), 100))
        .map((s) => ({ ...s, source: this.id })),
      source: this.id,
    };
  }
}
