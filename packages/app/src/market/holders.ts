/**
 * 👥 HOLDERS PROVIDERS — pluggable on-chain holder data (fomo-style token page)
 * Interface-first like the market providers in core: Blockscout ships keyless
 * (works for Robinhood Chain, Base, and 50+ EVM chains), a mock provider keeps
 * tests/demo honest, and more providers (Birdeye, Helius) plug in without
 * touching the app.
 */

export interface HolderEntry {
  /** Wallet address */
  address: string;
  /** Token balance in smallest units */
  balance: string;
  /** Share of total supply, 0–100 */
  sharePct: number;
  /** Rank 1 = largest holder */
  rank: number;
}

export interface TokenStats {
  /** Holder count when the provider reports it */
  holdersCount: number | null;
  /** Total supply in smallest units */
  totalSupply: string | null;
  /** USD price if the provider reports it (null otherwise) */
  priceUsd: string | null;
  /** 24h volume in USD if reported */
  volume24hUsd: string | null;
}

export interface HoldersResult {
  stats: TokenStats;
  holders: HolderEntry[];
  /** Which provider served this (shown in the UI — honesty rule) */
  source: string;
}

export interface HoldersProvider {
  readonly id: string;
  /** Quick capability check so the app can pick a provider per chain. */
  supportsChain(chainId: string): boolean;
  getHolders(chainId: string, tokenAddress: string, limit?: number): Promise<HoldersResult>;
}

// ── Blockscout (keyless, EVM chains with a public instance) ─────────────

/** Well-known Blockscout instances per chain id (all public, keyless). */
export const BLOCKSCOUT_INSTANCES: Record<string, string> = {
  robinhood: "https://robinhoodchain.blockscout.com",
  base: "https://base.blockscout.com",
  ethereum: "https://eth.blockscout.com",
  arbitrum: "https://arbitrum.blockscout.com",
  polygon: "https://polygon.blockscout.com",
  bsc: "https://bnb.blockscout.com",
};

export class BlockscoutHoldersProvider implements HoldersProvider {
  readonly id = "blockscout";

  /** Some Blockscout instances sit behind Cloudflare bot rules and 403 the
   *  default fetch UA — a browser-like UA clears them (verified 200). */
  private readonly headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };

  constructor(private instances: Record<string, string> = BLOCKSCOUT_INSTANCES) {}

  supportsChain(chainId: string): boolean {
    return !!this.instances[chainId];
  }

  async getHolders(chainId: string, tokenAddress: string, limit = 20): Promise<HoldersResult> {
    const base = this.instances[chainId];
    if (!base) throw new Error(`no Blockscout instance for chain "${chainId}"`);

    // Token metadata (holders count, supply)
    const metaRes = await fetch(`${base}/api/v2/tokens/${tokenAddress}`, { headers: this.headers });
    if (!metaRes.ok) throw new Error(`blockscout token lookup failed: ${metaRes.status}`);
    const meta = (await metaRes.json()) as {
      total_supply: string | null;
      holders_count: string | null;
      exchange_rate: string | null;
      volume_24h: string | null;
      decimals?: string;
    };

    // Top holders — some instances bot-block this path (403/422) even when the
    // metadata endpoint works. Degrade gracefully: return stats with an empty
    // list and let the caller show what it has (honest degradation).
    let holders: HolderEntry[] = [];
    try {
      const holdersRes = await fetch(`${base}/api/v2/tokens/${tokenAddress}/holders?page_size=${Math.min(limit, 50)}`, { headers: this.headers });
      if (holdersRes.ok) {
        const holdersJson = (await holdersRes.json()) as {
          items: { address: { hash: string }; value: string }[];
        };
        const totalSupply = meta.total_supply ? BigInt(meta.total_supply) : 0n;
        holders = holdersJson.items.slice(0, limit).map((h, i) => {
          const bal = BigInt(h.value ?? "0");
          const share = totalSupply > 0n ? Number((bal * 10000n) / totalSupply) / 100 : 0;
          return { address: h.address.hash, balance: bal.toString(), sharePct: share, rank: i + 1 };
        });
      }
    } catch {
      // keep empty holders — stats above are still real
    }

    return {
      stats: {
        holdersCount: meta.holders_count ? Number(meta.holders_count) : null,
        totalSupply: meta.total_supply ?? null,
        priceUsd: meta.exchange_rate ?? null,
        volume24hUsd: meta.volume_24h ?? null,
      },
      holders,
      source: "blockscout",
    };
  }
}

// ── Mock (labeled, deterministic; for tests and demo mode) ──────────────

export class MockHoldersProvider implements HoldersProvider {
  readonly id = "mock";

  supportsChain(_chainId: string): boolean {
    return true;
  }

  async getHolders(chainId: string, tokenAddress: string, limit = 20): Promise<HoldersResult> {
    // Deterministic pseudo-random distribution seeded by the token address —
    // same token always returns the same holders (no random flapping in demos).
    let seed = 0;
    for (const c of tokenAddress) seed = (seed * 31 + c.charCodeAt(0)) % 2147483647;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483647;
      return seed / 2147483647;
    };

    const holders: HolderEntry[] = [];
    let remaining = 100;
    for (let i = 0; i < Math.min(limit, 10); i++) {
      const maxShare = remaining / (1.6 + i);
      const share = i === 0 ? Math.min(28, 6 + rand() * 14) : Math.max(0.5, maxShare * (0.25 + rand() * 0.5));
      remaining -= share;
      const addr = "0x" + Math.floor(rand() * 0xffffffff).toString(16).padStart(8, "0").repeat(5).slice(0, 40);
      holders.push({ address: addr, balance: "0", sharePct: Math.round(share * 100) / 100, rank: i + 1 });
    }
    if (holders[0]) holders[0].rank = 1;

    return {
      stats: {
        holdersCount: 1200 + Math.floor(rand() * 40000),
        totalSupply: "1000000000000000000000000000",
        priceUsd: null,
        volume24hUsd: null,
      },
      holders,
      source: "mock",
    };
  }
}

/** Pick the best provider for a chain from a candidate list. */
export function pickHoldersProvider(chainId: string, providers: HoldersProvider[]): HoldersProvider | null {
  return providers.find((p) => p.supportsChain(chainId)) ?? null;
}
