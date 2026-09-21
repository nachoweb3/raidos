import { readFileSync } from "node:fs";
import { createContext, SourceTextModule } from "node:vm";
import { describe, expect, it, vi } from "vitest";
async function load(fetcher: any) {
  const module = new SourceTextModule(readFileSync(new URL("../../../site/js/public-market.js", import.meta.url), "utf8"), { context: createContext({ fetch: fetcher, AbortSignal }) });
  await module.link(() => { throw Error("No imports expected"); }); await module.evaluate(); return module.namespace as any;
}
const pool = "0x" + "a".repeat(40), token = "0x" + "b".repeat(40);
describe("public read-only market fallback", () => {
  it("coalesces requests, caches results and never sends account credentials", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [] })));
    const mod = await load(fetcher);
    const results = await Promise.all([mod.publicPoolData("trades", "base", pool, token), mod.publicPoolData("trades", "base", pool, token)]);
    await mod.publicPoolData("trades", "base", pool, token);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer", headers: { Accept: "application/json" } });
    expect(results[0]).toMatchObject({ source: "geckoterminal", trades: [], transport: "public-browser", completeHistory: false });
  });
  it("honors a provider rate-limit cooldown and rejects invalid pools", async () => {
    const fetcher = vi.fn(async () => new Response("{}", { status: 429 }));
    const mod = await load(fetcher);
    await expect(mod.publicPoolData("trades", "base", "../invalid", token)).rejects.toThrow("compatible");
    await expect(mod.publicPoolData("trades", "base", pool, token)).rejects.toThrow("Cuota");
    await expect(mod.publicPoolData("trades", "base", pool, token)).rejects.toThrow("pausa");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects impossible candle geometry and deduplicates valid timestamps", async () => {
    const mod = await load(vi.fn());
    const candles = mod.normalizePoolCandles({ data: { attributes: { ohlcv_list: [[300, 2, 3, 1, 2, 5], [300, 2, 3, 1, 2, 5], [600, 5, 2, 1, 3, 1]] } } });
    expect(candles).toHaveLength(1); expect(candles[0].close).toBe(2);
  });
});
