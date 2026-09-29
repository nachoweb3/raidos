import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { SourceTextModule, SyntheticModule, createContext } from "node:vm";

async function load(api: any = {}) {
  const security: any = {
    cache: {}, ttlMs: 300000,
    get(address: string, chain: string) { return this.cache[chain + ":" + address]?.v || null; },
    async fetch(address: string, chain: string) {
      this.cache[chain + ":" + address] = { _at: Date.now(), v: { metrics: { top10Pct: 25 }, imageUrl: "https://example.com/token.png" } };
    }
  };
  const elements: any[] = [];
  const panelStub = { innerHTML: "", offsetParent: null };
  const context = createContext({
    window: { innerHeight: 900, matchMedia: () => ({ matches: context.__wide === true }) },
    document: { visibilityState: "visible", querySelectorAll: () => elements, getElementById: (id: string) => (id === "trenchesSidePanel" ? panelStub : null) },
    setTimeout: () => 1, clearTimeout: () => {}, console, URLSearchParams,
  });
  const mod = new SourceTextModule(readFileSync(new URL("../../../site/js/trenches.js", import.meta.url), "utf8"), { context });
  const dependencies: any = {
    "./api.js": { ApiClient: api, API_BASE: "" }, "./tokens.js": { TokenMeta: {} },
    "./dexfeed.js": { DexFeed: {}, SecurityFeed: security }, "./catalog-board.js": { CatalogBoard: class {} },
  };
  await mod.link(async name => {
    const values = dependencies[name.split("?")[0]];
    return new SyntheticModule(Object.keys(values), function() {
      for (const [k,v] of Object.entries(values)) this.setExport(k,v);
    }, { context });
  });
  await mod.evaluate();
  const engine: any = (mod.namespace as any).TrenchesEngine;
  engine.tokens = []; engine.market = []; engine.render = () => {};
  context.window.App = { openTradeForToken: () => { context.__terminalCalls = (context.__terminalCalls || 0) + 1; } };
  const token = (id: string) => ({ id, chain: "solana", tokenAddress: id });
  const visible = (id: string, top = 100) => elements.push({
    dataset: { tokenId: id }, getBoundingClientRect: () => ({ top, bottom: top + 148, width: 400 }),
    closest: () => ({ getBoundingClientRect: () => ({ top: 80, bottom: 800 }) }),
  });
  return { engine, security, token, visible, panel: panelStub, context };
}
describe("visible trenches risk hydration", () => {
  it("loads only visible rows and shares cached metrics and logos across fresh duplicate objects", async () => {
    const { engine, security, token, visible } = await load();
    engine.market = Array.from({ length: 80 }, (_, i) => token("mint" + i));
    visible("mint0"); visible("mint1", 1000);
    await engine.loadSecurity();
    expect(Object.keys(security.cache)).toEqual(["solana:mint0"]);
    expect(engine.riskStrip(token("mint0"))).toContain("25.0%");
    expect(engine.riskImage(token("mint0"))).toBe("https://example.com/token.png");
    expect(engine.riskStrip(token("mint1"))).not.toContain("25.0%");
  });
  it("bounds security batches to four, then continues with uncached visible rows", async () => {
    const { engine, security, token, visible } = await load();
    for (let i = 0; i < 6; i++) { engine.market.push(token("mint" + i)); visible("mint" + i); }
    await engine.loadSecurity(); expect(Object.keys(security.cache)).toHaveLength(4);
    await engine.loadSecurity(); expect(Object.keys(security.cache)).toHaveLength(6);
  });
  it("one failed RPC token does not block the following visible token or invent bundles", async () => {
    const calls: string[] = [];
    const { engine, token, visible } = await load({ request: async (url: string) => {
      calls.push(url);
      if (url.endsWith("bad")) throw Error("temporarily unavailable");
      return { bundle: { tippedTransactions: 2, sampleSize: 20, note: "tips" }, creator: { creator: "knownPayer123456789", note: "payer", sampleSize: 3, tokensLaunched: 1 } };
    }});
    engine.market = [token("bad"), token("good")]; visible("bad"); visible("good");
    await engine.loadOnchainRisk();
    expect(calls).toHaveLength(2);
    expect(engine.riskStrip(token("good"))).toContain("2/20 tx");
    expect(engine.riskStrip(token("good"))).toContain("Bundles <b>N/D</b>");
    await engine.loadOnchainRisk(); expect(calls).toHaveLength(2);
  });
  it("uses reported creator without presenting it as an onchain deployment payer", async () => {
    const { engine, security, token } = await load();
    security.cache["solana:known"] = { v: { metrics: { creatorAddress: "creatorAddress1234567" } } };
    const html = engine.riskStrip(token("known"));
    expect(html).toContain("Creador <b>crea...4567</b>");
    expect(html).toContain("Creador reportado por el proveedor");
    expect(html).not.toContain("Despliegue <b>");
  });
});

describe("token logo direction", () => {
 it("uses real five-minute movement and keeps missing/invalid/flat data neutral", async () => {
  const { engine } = await load();
  expect(engine.logoTrend({dex:{change5m:2}})).toBe("trend-up");
  expect(engine.logoTrend({dex:{change5m:-2}})).toBe("trend-down");
  for(const change5m of [null,undefined,0,NaN,Infinity,"3"]) expect(engine.logoTrend({dex:{change5m}})).toBe("trend-flat");
  expect(engine.logoTrend({})).toBe("trend-flat");
  expect(engine.logoTrendTitle({dex:{change5m:-2}})).toContain("Bajista en 5 min: -2.00%");
 });
});

describe("trenches side panel and real graduation", () => {
 it("maps graduation only from the on-chain factory flag, never from liquidity or status strings", async () => {
  const { engine } = await load();
  const grad = engine.normalize({ id: 1, symbol: "GRAD", graduatedOnChain: true, mintAddress: "MintAddr1111" });
  expect(grad.graduatedOnChain).toBe(true);
  expect(grad.mintAddress).toBe("MintAddr1111");
  // A launch that merely closed its curve is NOT graduated until the factory flags it.
  const pending = engine.normalize({ id: 2, symbol: "CURV", status: "graduated" });
  expect(pending.graduatedOnChain).toBe(false);
 });

 it("side panel shows real graduation or real curve progress, with contract and Solscan link", async () => {
  const { engine, panel } = await load();
  engine.tokens = [
    { id: "g1", symbol: "GRAD", name: "Graduated", chain: "solana", graduatedOnChain: true, mintAddress: "MintAddr1111", progress: 0, raisedUsd: 0, priceUsd: 0.5, mcapUsd: 1000, tokenAddress: "Addr1111aaaaaaaaaaaaaaaa", dex: null },
    { id: "c1", symbol: "CURV", name: "On curve", chain: "solana", graduatedOnChain: false, progress: 42, raisedUsd: 8400, priceUsd: 0.1, mcapUsd: 900, tokenAddress: null, dex: null },
  ];
  engine.selected = engine.tokens[0];
  engine.renderSidePanel();
  expect(panel.innerHTML).toContain("Graduado on-chain");
  expect(panel.innerHTML).toContain("solscan.io/token/MintAddr1111");
  engine.selected = engine.tokens[1];
  engine.renderSidePanel();
  expect(panel.innerHTML).toContain("Curva: 42%");
  expect(panel.innerHTML).not.toContain("Graduado");
 });

 it("wide viewports defer the terminal to the panel; narrow ones open it directly", async () => {
  const { engine, panel, context } = await load();
  const t = { id: "g1", symbol: "GRAD", name: "G", chain: "solana", graduatedOnChain: true, progress: 0, priceUsd: 0.5, mcapUsd: 1000, tokenAddress: "Addr1111aaaaaaaaaaaaaaaa", dex: null };
  engine.tokens = [t];
  context.__wide = true;
  engine.select(t);
  expect(context.__terminalCalls).toBeUndefined();
  expect(panel.innerHTML).toContain("GRAD");
  context.__wide = false;
  engine.select(t);
  expect(context.__terminalCalls).toBe(1);
 });
});
