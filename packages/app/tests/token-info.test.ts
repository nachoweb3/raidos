import { describe, expect, it } from "vitest";
import { MarketDataService } from "../src/market/data.js";

const mint = "AjtWmyesJDvhnUk79jct4W8cVs4sHRuXktTTH2nVpump";
const contract = "0x" + "a".repeat(40);

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status });
}

/** Solana getAccountInfo jsonParsed fixture: SPL mint with 6 decimals. */
const solanaMintAccount = {
  jsonrpc: "2.0", id: 1,
  result: {
    value: {
      data: { parsed: { type: "mint", info: { decimals: 6, symbol: "NEW", name: "New Token" } } },
      executable: false, lamports: 1_000_000, owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    },
  },
};

describe("tokenInfo (on-chain decimals, keyless RPC)", () => {
  it("reads decimals/symbol from a Solana mint account", async () => {
    const service = new MarketDataService({ fetcher: async () => jsonResponse(solanaMintAccount) });
    const info = await service.tokenInfo("solana", mint);
    expect(info.decimals).toBe(6);
    expect(info.symbol).toBe("NEW");
    expect(info.source).toBe("rpc");
    expect(info.status).toBe("LIVE");
  });

  it("reads decimals from an EVM contract via eth_call", async () => {
    const service = new MarketDataService({
      fetcher: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        const selector = body.params?.[0]?.data;
        const result =
          selector === "0x313ce567" ? "0x0000000000000000000000000000000000000000000000000000000000000012" : // 18
          selector === "0x95d89b41" ? "0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000003544b310000000000000000000000000000000000000000000000000000000000" : // "TK1"
            "0x";
        return jsonResponse({ jsonrpc: "2.0", id: 1, result });
      },
    });
    const info = await service.tokenInfo("base", contract);
    expect(info.decimals).toBe(18);
    expect(info.symbol).toBe("TK1");
    expect(info.name).toBeNull(); // 0x → honest null, never guessed
  });

  it("caches the second call (one upstream fetch for repeated asks)", async () => {
    let calls = 0;
    const service = new MarketDataService({ fetcher: async () => { calls++; return jsonResponse(solanaMintAccount); } });
    await service.tokenInfo("solana", mint);
    await service.tokenInfo("solana", mint);
    expect(calls).toBe(1);
  });

  it("falls back to stale cache as DEGRADED when the RPC starts failing", async () => {
    let failing = false;
    const service = new MarketDataService({ fetcher: async () => failing ? jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "boom" } }) : jsonResponse(solanaMintAccount) });
    const first = await service.tokenInfo("solana", mint);
    expect(first.status).toBe("LIVE");
    failing = true;
    service["cache"].get("tokeninfo:solana:" + mint)!.expires = Date.now() - 1; // force refetch past TTL
    const second = await service.tokenInfo("solana", mint);
    expect(second.status).toBe("DEGRADED");
    expect(second.decimals).toBe(6);
  });

  it("returns unknown (nulls) when the account does not exist — never guesses", async () => {
    const service = new MarketDataService({
      fetcher: async () => jsonResponse({ jsonrpc: "2.0", id: 1, result: { value: { data: { parsed: {} } } } }),
    });
    const info = await service.tokenInfo("solana", mint);
    expect(info.decimals).toBeNull();
    expect(info.symbol).toBeNull();
  });

  it("rejects invalid chain and address with a 400-shaped error", async () => {
    const service = new MarketDataService({ fetcher: async () => { throw new Error("no network"); } });
    await expect(service.tokenInfo("polygon", mint)).rejects.toThrow("invalid");
    await expect(service.tokenInfo("solana", "short")).rejects.toThrow("invalid");
  });
});
