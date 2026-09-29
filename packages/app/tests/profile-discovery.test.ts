import { describe, expect, it, vi } from "vitest";
import { MarketDataService } from "../src/market/data.js";
describe("independent profile discovery", () => {
  it("deduplicates and resolves only the requested chain, never treating profiles as prices", async () => {
    const a = "0x" + "a".repeat(40);
    const market = new MarketDataService({ fetcher: async () => new Response(JSON.stringify([
      { chainId: "base", tokenAddress: a }, { chainId: "base", tokenAddress: a },
      { chainId: "solana", tokenAddress: "DifferentMint" }
    ])) });
    const tokens = vi.spyOn(market, "tokens").mockResolvedValue({
      data: [{ baseToken: { address: a }, priceUsd: "1" }], status: "LIVE",
      source: "dexscreener", asOf: 1, cacheAgeMs: 0
    });
    const result = await market.profilePools("base");
    expect(tokens).toHaveBeenCalledWith("base", [a]);
    expect(result.data[0].priceUsd).toBe("1");
  });
  it("does not call token resolution for an empty profile list", async () => {
    const market = new MarketDataService({ fetcher: async () => new Response("[]") });
    const tokens = vi.spyOn(market, "tokens");
    expect((await market.profilePools("base")).data).toEqual([]);
    expect(tokens).not.toHaveBeenCalled();
  });
  it("rejects malformed profile bodies rather than reporting an empty successful page", async () => {
    const market = new MarketDataService({ fetcher: async () => new Response("{}") });
    await expect(market.profilePools("base")).rejects.toThrow("invalid token profiles");
  });
});
