import { MarketCatalog, MARKET_CHAINS, assetAddress } from "./catalog.js";
import { MarketDataService } from "./data.js";

/** Bounded incremental ingestion. A page checkpoint is not an upstream cursor. */
export class MarketIndexer {
  constructor(private readonly catalog: MarketCatalog, private readonly market: MarketDataService) {}
  seed(chains = ["solana", "base"]) {
    if (chains.some((c) => !MARKET_CHAINS.includes(c))) throw new Error("invalid discovery chain");
    for (const chain of chains) for (const kind of ["new", "trending"]) {
      this.catalog.enqueue(`discover:${chain}:${kind}`, "discover", { chain, kind, page: 1 });
    }
  }
  async importToken(chain: string, rawAddress: string) {
    const address = assetAddress(chain, rawAddress);
    const result = await this.market.tokens(chain, [address]);
    const pairs = result.data.filter((p) => {
      try { return p.chainId === chain && assetAddress(chain, p.baseToken?.address) === address; } catch { return false; }
    });
    this.catalog.ingest({ ...result, data: pairs });
    return { ...result, data: pairs, imported: pairs.length > 0, address, chain,
      tradable: false, routeStatus: "UNVERIFIED" };
  }
  async runOnce(): Promise<{ status: "idle" | "updated" | "retry" | "lease_lost"; kind?: string }> {
    const job = this.catalog.claim();
    if (!job) return { status: "idle" };
    try {
      const payload = JSON.parse(job.payload);
      const result = job.kind === "discover"
        ? await this.market.pools(payload.chain, payload.kind, payload.page)
        : await this.market.tokens(payload.chain, [payload.address]);
      // A stale cache hit does not advance discovery or declare a successful refresh.
      if (result.status !== "LIVE") throw new Error("degraded provider");
      const next = job.kind === "discover"
        ? { ...payload, page: result.data.length && payload.page < 10 ? payload.page + 1 : 1 }
        : payload;
      const active = result.data.some((p) => Number(p.liquidity?.usd) > 0 && Number(p.volume?.h24) >= 50000);
      const delay = job.kind === "discover" ? (next.page === 1 ? 300000 : 15000) : active ? 60000 : result.data.length ? 900000 : 3600000;
      const completed = this.catalog.complete(job, () => this.catalog.ingest(result), next, delay);
      return { status: completed ? "updated" : "lease_lost", kind: job.kind };
    } catch {
      return { status: this.catalog.fail(job) ? "retry" : "lease_lost", kind: job.kind };
    }
  }
}
