import { describe, expect, it, vi } from "vitest";
import { MarketDataService } from "../src/market/data.js";

const mint = "AjtWmyesJDvhnUk79jct4W8cVs4sHRuXktTTH2nVpump";
const pair = {
  chainId: "solana", pairAddress: "pool", baseToken: { address: mint, symbol: "NEW", name: "New token" },
  quoteToken: { address: "USDC" }, priceUsd: "0.25", liquidity: { usd: 10 },
};
const gecko = {
  data: [{ id: "solana_pool", attributes: { address: "pool", base_token_price_usd: "0.2", reserve_in_usd: "100", volume_usd: { h24: "12" } },
    relationships: { base_token: { data: { id: "solana_" + mint } }, quote_token: { data: { id: "solana_USDC" } }, dex: { data: { id: "pumpswap" } } } }],
  included: [{ id: "solana_" + mint, attributes: { address: mint, symbol: "NEW", name: "New token", decimals: 6 } },
    { id: "solana_USDC", attributes: { address: "USDC", symbol: "USDC", decimals: 6 } }],
};
function response(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status }); }

describe("shared market data", () => {
  it("looks up an arbitrary mint without any curated token list", async () => {
    const fetcher = vi.fn(async () => response([pair]));
    const service = new MarketDataService({ fetcher });
    const result = await service.tokens("solana", [mint]);
    expect(result.data[0].baseToken.address).toBe(mint);
    expect(result.source).toBe("dexscreener");
    expect(result.status).toBe("LIVE");
    expect(String(fetcher.mock.calls[0][0])).toContain(encodeURIComponent(mint));
  });
  it("coalesces simultaneous requests and reuses the shared cache", async () => {
    const fetcher = vi.fn(async () => response({ pairs: [pair] }));
    const service = new MarketDataService({ fetcher });
    await Promise.all([service.search("NEW", "solana"), service.search("NEW", "solana")]);
    await service.search("NEW", "solana");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("falls back to GeckoTerminal real pools when DEX Screener is unavailable", async () => {
    const service = new MarketDataService({ fetcher: async (url) => String(url).includes("dexscreener") ? response({}, 503) : response(gecko) });
    const result = await service.tokens("solana", [mint]);
    expect(result.source).toBe("geckoterminal");
    expect(result.data[0].baseToken.address).toBe(mint);
    expect(result.data[0].priceUsd).toBe("0.2");
  });
  it("keeps chains and case-sensitive Solana mints separate", async () => {
    const fetcher = vi.fn(async () => response({ pairs: [pair, { ...pair, chainId: "base" }] }));
    const service = new MarketDataService({ fetcher });
    const solana = await service.search(mint, "solana");
    expect(solana.data).toHaveLength(1);
    await service.search(mint.toLowerCase(), "solana");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("labels stale cached data as degraded after an upstream failure", async () => {
    let now = 1000;
    let online = true;
    const service = new MarketDataService({ now: () => now, fetcher: async () => online ? response({ pairs: [pair] }) : response({}, 503) });
    await service.search("NEW", "solana");
    now += 31000;
    online = false;
    const stale = await service.search("NEW", "solana");
    expect(stale.status).toBe("DEGRADED");
    expect(stale.asOf).toBe(1000);
  });
  it("refuses unbounded batches and invalid chain/path parameters before fetching", async () => {
    const fetcher = vi.fn(async () => response([]));
    const service = new MarketDataService({ fetcher });
    await expect(service.tokens("solana", Array(31).fill(mint))).rejects.toThrow();
    await expect(service.tokens("../admin", [mint])).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("uses pool OHLCV for the requested token, sorts and preserves the actual values", async () => {
    const fetcher = vi.fn(async () => response({ data: { attributes: { ohlcv_list: [[2, 2, 4, 1, 3, 20], [1, 1, 3, 1, 2, 10]] } } }));
    const service = new MarketDataService({ fetcher });
    const result = await service.candles("solana", "43tuNoWrEPefGWp75iJwUw5bf8SE6SZXs3faWBTJTs8m", mint);
    expect(result.data).toEqual([
      { time: 1, open: 1, high: 3, low: 1, close: 2, volume: 10 },
      { time: 2, open: 2, high: 4, low: 1, close: 3, volume: 20 },
    ]);
    expect(String(fetcher.mock.calls[0][0])).toContain("token=" + mint);
  });
  it("returns unavailable rather than inventing candles when all providers fail", async () => {
    const service = new MarketDataService({ fetcher: async () => response({}, 429) });
    await expect(service.candles("solana", "43tuNoWrEPefGWp75iJwUw5bf8SE6SZXs3faWBTJTs8m", mint)).rejects.toThrow(/unavailable/i);
  });
  it("caps provider calls even when requests use distinct queries", async () => {
    const fetcher = vi.fn(async () => response(gecko));
    const service = new MarketDataService({ fetcher, limits: { geckoterminal: 1 } });
    await service.pools("solana", "new", 1);
    await expect(service.pools("solana", "new", 2)).rejects.toThrow(/unavailable/i);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
