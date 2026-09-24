import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiServer } from "../src/api/server.js";
import { MarketDataService } from "../src/market/data.js";

let server: ApiServer | undefined;
afterEach(async () => { vi.restoreAllMocks(); await server?.stop(); server = undefined; });

describe("all financial endpoints fail closed", () => {
  it("does not advertise unsupported quote adapters or testnets even with credentials", async () => {
    vi.stubEnv("ZERO_X_API_KEY", "test-only");
    vi.stubEnv("JUPITER_API_KEY", "");
    try {
      server = new ApiServer({ dbPath: ":memory:", port: 0, siteDir: null, appMode: "live" });
      const response = await fetch("http://127.0.0.1:" + await server.start() + "/api/chains");
      const { chains } = await response.json();
      // Solana quotes stay off without a Jupiter key; EVM quote adapters with
      // keys expose real self-custody execution (signed client-side).
      expect(chains.find((c: any) => c.id === "solana")).toMatchObject({ quotes: false, liveExecution: false, status: "UNAVAILABLE" });
      // Arc quotes and executes keylessly via Li.Fi (no API key needed).
      for (const id of ["bsc", "robinhood"]) {
        expect(chains.find((c: any) => c.id === id)).toMatchObject({ quotes: false, liveExecution: false, status: "UNAVAILABLE" });
      }
      expect(chains.find((c: any) => c.id === "base")).toMatchObject({ quotes: true, quoteStatus: "UNVERIFIED", liveExecution: true, selfCustody: true, status: "LIVE" });
      for (const id of ["polygon", "arbitrum", "monad"]) expect(chains.some((c: any) => c.id === id)).toBe(false);
    } finally { vi.unstubAllEnvs(); }
  });
  it.each(["live", "mock"] as const)("never submits prediction orders in %s", async (appMode) => {
    server = new ApiServer({ dbPath: ":memory:", port: 0, siteDir: null, appMode });
    const base = "http://127.0.0.1:" + await server.start();
    const registration = await fetch(base + "/api/auth/register", { method: "POST", body: "{}" });
    const { apiKey } = await registration.json();
    // No password should even be requested/read before capability rejection.
    const response = await fetch(base + "/api/prediction/order", {
      method: "POST", headers: { Authorization: "Bearer " + apiKey }, body: "{}",
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: "UNAVAILABLE" });
  });
});

describe("market provenance", () => {
  it("rejects disabled networks before contacting providers and omits them from global search", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ pairs:
      ["base", "polygon", "arbitrum", "monad"].map((chainId) => ({ chainId, baseToken: { address: "0x" + "a".repeat(40) } }))
    })));
    const market = new MarketDataService({ fetcher });
    for (const chain of ["polygon", "arbitrum", "monad"]) {
      await expect(market.pools(chain)).rejects.toThrow(/network disabled/);
      await expect(market.search("example", chain)).rejects.toThrow(/network disabled/);
      await expect(market.tokens(chain, ["0x" + "a".repeat(40)])).rejects.toThrow(/network disabled/);
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect((await market.search("example")).data.map((p) => p.chainId)).toEqual(["base"]);
  });
  it("keeps acquisition timestamps and degraded state on returned pairs", async () => {
    let now = 1_700_000_000_000;
    let available = true;
    const service = new MarketDataService({ now: () => now, fetcher: async () => {
      if (!available) throw new Error("offline");
      return new Response(JSON.stringify({ pairs: [{ chainId: "base", pairAddress: "0x" + "b".repeat(40),
        baseToken: { address: "0x" + "a".repeat(40) }, liquidity: { usd: 10 } }] }));
    } });
    await service.search("example");
    now += 31_000; available = false;
    const result = await service.search("example");
    expect(result.status).toBe("DEGRADED");
    // The envelope must be propagated by the consumer, never Date.now().
    expect(result.asOf).toBe(1_700_000_000_000);
  });
});
