import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SourceTextModule, SyntheticModule, createContext } from "node:vm";

async function feed(request: (path: string) => Promise<any> = async () => ({ pairs: [] })) {
  const context = createContext({ localStorage: { getItem: () => null, setItem: () => {} } });
  const module = new SourceTextModule(readFileSync(new URL("../../../site/js/dexfeed.js", import.meta.url), "utf8"), { context });
  await module.link(async () => new SyntheticModule(["ApiClient"], function () {
    this.setExport("ApiClient", { request });
  }, { context }));
  await module.evaluate();
  return (module.namespace as any).DexFeed;
}
describe("market identity and batches", () => {
  it("requests pools for the selected network, not a filtered global sample", async () => {
    const calls: string[] = [];
    const f = await feed(async (path) => { calls.push(path); return { pairs: [] }; });
    await f.getTrending({ chains: ["base"], page: 3, kind: "new" });
    expect(calls[0]).toContain("chain=base");
    expect(calls[0]).toContain("page=3");
  });

  it("does not conflate the same contract on different chains", async () => {
    const f = await feed();
    const address = "0x" + "a".repeat(40);
    for (const chain of ["base", "bsc"]) f._put({ chain, address, symbol: "X", _updatedAt: Date.now() });
    expect(f.get(address, "base").chain).toBe("base");
    expect(f.get(address, "bsc").chain).toBe("bsc");
    expect(f.get(address)).toBeNull();
  });
  it("preserves Solana case and matches EVM checksums", async () => {
    const f = await feed();
    f._put({ chain: "solana", address: "AbcMint", symbol: "X", _updatedAt: Date.now() });
    expect(f.get("abcmint", "solana")).toBeNull();
    f._put({ chain: "base", address: "0xaBc", symbol: "X", _updatedAt: Date.now() });
    expect(f.get("0xABC", "base").address).toBe("0xaBc");
  });
  it("resolves every address beyond the first provider batch", async () => {
    const calls: string[] = [];
    const f = await feed(async (path) => { calls.push(path); return { pairs: [] }; });
    await f.ensureAddresses(Array.from({ length: 61 }, (_, i) => ({ chain: "base", address: "0x" + i.toString(16).padStart(40, "0") })));
    expect(calls).toHaveLength(3);
    expect(calls[2]).toContain("0x" + (60).toString(16).padStart(40, "0"));
  });
  it("does not offer expired cached prices as current data", async () => {
    const f = await feed();
    f._put({ chain: "base", address: "0xABC", symbol: "OLD", _updatedAt: Date.now() - 300001 });
    expect(f.get("0xABC", "base")).toBeNull();
  });
});
