import { describe, it, expect, vi } from "vitest";
import { MarketDataService } from "../src/market/data.js";
describe("market provider resilience", () => {
  it("serves pools from the official CoinGecko onchain endpoint after Gecko fails", async () => {
    const fetcher = vi.fn(async (url: string) => url.includes("geckoterminal") ? new Response("{}", {status: 429}) : Response.json({data: []}));
    const service = new MarketDataService({fetcher});
    const result = await service.pools("solana", "new");
    expect(result.source).toBe("coingecko");
    expect(fetcher.mock.calls[1][0]).toContain("/api/v3/onchain/networks/solana/new_pools");
  });
  it("respects Retry-After across different URLs", async () => {
    let now = 100000;
    const fetcher = vi.fn(async () => new Response("{}", {status: 429, headers: {"Retry-After": "120"}}));
    const service = new MarketDataService({fetcher, now: () => now});
    await expect(service.pools("solana", "new")).rejects.toThrow();
    now += 61000;
    await expect(service.pools("base", "new")).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("sends the configured demo key only to the CoinGecko provider", async () => {
    const prev = process.env.COINGECKO_API_KEY;
    process.env.COINGECKO_API_KEY = "CG-testKey123";
    try {
      const fetcher = vi.fn()
        .mockResolvedValueOnce(new Response("{}", { status: 429 }))
        .mockResolvedValueOnce(Response.json({ data: [] }));
      const service = new MarketDataService({ fetcher });
      await service.pools("solana", "new");
      const [, primaryInit] = fetcher.mock.calls[0]!;
      expect(new Headers(primaryInit?.headers).get("x-cg-demo-api-key")).toBeNull();
      const [, fallbackInit] = fetcher.mock.calls[1]!;
      expect(fallbackInit?.headers).toMatchObject({ "x-cg-demo-api-key": "CG-testKey123" });
    } finally { if (prev === undefined) delete process.env.COINGECKO_API_KEY; else process.env.COINGECKO_API_KEY = prev; }
  });

  it("uses the same fallback for candles without inventing rows", async () => {
    const service = new MarketDataService({fetcher: async url => url.includes("geckoterminal") ? new Response("{}", {status: 503}) : Response.json({data: {attributes: {ohlcv_list: [[1, 2, 3, 1, 2, 4]]}}})});
    const result = await service.candles("solana", "A".repeat(32), "B".repeat(32));
    expect(result.source).toBe("coingecko");
    expect(result.data).toHaveLength(1);
  });
});
