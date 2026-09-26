import { readFileSync } from "node:fs";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";
import { describe, expect, it } from "vitest";

async function boardWith(request: (url: string) => Promise<unknown>) {
  const context = createContext({ URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    location: { href: "http://localhost/app.html" }, document: { getElementById: () => null }, window: { addEventListener() {} } });
  const module = new SourceTextModule(readFileSync(new URL("../../../site/js/catalog-board.js", import.meta.url), "utf8"), { context });
  await module.link(async (specifier) => {
    // GmgnBoard stub: inactive (no GMGN in unit tests) so CatalogBoard owns the DOM.
    if (specifier.includes("gmgn")) {
      return new SyntheticModule(["GmgnBoard"], function () {
        this.setExport("GmgnBoard", { active: false, status: "UNAVAILABLE", error: "gmgn off (test)", renderFallbackBanner() {} });
      }, { context });
    }
    const name = specifier.includes("api") ? "ApiClient" : "DexFeed";
    return new SyntheticModule([name], function () { this.setExport(name, name === "ApiClient" ? { request } : { _rows: (rows: unknown[]) => rows }); }, { context });
  });
  await module.evaluate();
  const engine = { activeChain: "solana", search: "", market: [], target: () => null, normalizeMarket: (row: unknown) => row };
  const Board = (module.namespace as any).CatalogBoard;
  return { board: new Board(engine), engine };
}
const page = (start: number, nextCursor: string | null) => ({ total: 120, nextCursor,
  pairs: Array.from({ length: 40 }, (_, i) => ({ id: String(start + i), dex: { _updatedAt: 1700000000000 } })) });

describe("catalog board pagination state", () => {
  it("refreshes every loaded page instead of discarding results after the first 40", async () => {
    const calls: URL[] = [];
    const { board } = await boardWith(async (url) => {
      const u = new URL(url, "http://localhost"); calls.push(u);
      return u.searchParams.has("cursor") ? page(40, "third") : page(0, "second");
    });
    const c = board.columns[0];
    await board.load(c); await board.load(c, true); await board.load(c);
    expect(c.rows).toHaveLength(80); expect(c.pages).toBe(2);
    expect(calls.map((u) => u.searchParams.get("cursor"))).toEqual([null, "second", null, "second"]);
  });
  it("does not display old results under changed filters when the new request fails", async () => {
    let available = true;
    const { board, engine } = await boardWith(async () => {
      if (!available) throw new Error("offline"); return page(0, "second");
    });
    const c = board.columns[0]; await board.load(c);
    available = false; engine.search = "DifferentCaseSensitiveContract";
    await board.load(c);
    expect(c.rows).toHaveLength(0); expect(c.cursor).toBeNull(); expect(c.error).toContain("offline");
  });
  it("keeps previous data on a failed refresh of the same query", async () => {
    let available = true;
    const { board } = await boardWith(async () => {
      if (!available) throw new Error("offline"); return page(0, "second");
    });
    const c = board.columns[0]; await board.load(c); available = false; await board.load(c);
    expect(c.rows).toHaveLength(40); expect(c.error).toContain("offline");
  });
});
