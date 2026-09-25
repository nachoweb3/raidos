import { describe, expect, it } from "vitest";
import {
  buildDNA, changePct, currentRatio, pairIntelligence, pairMomentum, ratioSeries, relativeSeries,
  type AssetSeries,
} from "../src/pairs/pair-engine.js";
import { NFT_COLLECTIONS, QUOTE_TOKENS, PairPriceService } from "../src/pairs/pair-prices.js";
import { PairService, parsePairId, resolveAsset } from "../src/pairs/pair-service.js";

const S = (points: [number, number | null][]): AssetSeries => points.map(([time, priceUsd]) => ({ time, priceUsd }));

describe("pair engine — synthetic relative math", () => {
  it("ratioSeries aligns timestamps and nulls missing legs", () => {
    const base = S([[100, 10], [200, 12], [300, null]]);
    const quote = S([[100, 2], [200, null], [300, 4]]);
    const ratios = ratioSeries(base, quote);
    expect(ratios).toEqual([
      { time: 100, ratio: 5 },
      { time: 200, ratio: null },
      { time: 300, ratio: null },
    ]);
  });

  it("relativeSeries rebases both legs to 100; relative >100 = base outperforming", () => {
    const base = S([[0, 10], [60, 11.8], [120, 12]]);
    const quote = S([[0, 2], [60, 2.14], [120, 2.1]]);
    const rel = relativeSeries(base, quote)!;
    expect(rel[0]).toMatchObject({ base: 100, quote: 100, relative: 100 });
    expect(rel[rel.length - 1]!.base).toBeCloseTo(120, 5);
    expect(rel[rel.length - 1]!.quote).toBeCloseTo(105, 5);
    expect(rel[rel.length - 1]!.relative).toBeCloseTo((120 / 105) * 100, 5);
  });

  it("relativeSeries returns null when either leg lacks a starting price (no fake 100s)", () => {
    expect(relativeSeries(S([[0, null], [60, 5]]), S([[0, 2], [60, 2.2]]))).toBeNull();
    expect(relativeSeries(S([[0, 5]]), S([[0, 2], [60, 2.2]]))).toBeNull();
  });

  it("currentRatio picks the latest aligned point", () => {
    expect(currentRatio(S([[0, 10], [60, 12]]), S([[0, 2], [60, 4]]))).toBe(3);
    expect(currentRatio(S([[0, 10]]), S([[60, 4]]))).toBeNull();
  });

  it("changePct ignores nulls at the edges", () => {
    expect(changePct([null, 10, null, 12, null])).toBeCloseTo(20, 6);
    expect(changePct([null, null])).toBeNull();
  });

  it("pairMomentum flags a relative breakout with visible thresholds", () => {
    // base +20%, quote +5% → relative perf ≈ +14.3pp, ratio change ≈ +14.3% → breakout
    const base = S([[0, 10], [3600, 12]]);
    const quote = S([[0, 2], [3600, 2.1]]);
    const m = pairMomentum(base, quote);
    expect(m.relativeBreakout).toBe(true);
    expect(m.ratioChangePct).toBeCloseTo((1.2 / 1.05 - 1) * 100, 5);
    // flat → no breakout
    expect(pairMomentum(S([[0, 10], [3600, 10]]), S([[0, 2], [3600, 2]]))).toMatchObject({ relativeBreakout: false });
  });

  it("pairIntelligence splits outperforming vs underperforming with point diffs", () => {
    const intel = pairIntelligence(8, [
      { id: "a", symbol: "ETH", changePct: 3 },
      { id: "b", symbol: "BTC", changePct: 12 },
      { id: "c", symbol: "NVDAX", changePct: null },
    ]);
    expect(intel!.outperforming).toEqual([{ id: "a", symbol: "ETH", diffPp: 5 }]);
    expect(intel!.underperforming).toEqual([{ id: "b", symbol: "BTC", diffPp: -4 }]);
    // unknown change never counted
    expect(intel!.outperforming.length + intel!.underperforming.length).toBe(2);
    expect(pairIntelligence(null, [{ id: "a", symbol: "ETH", changePct: 1 }])).toBeNull();
  });

  it("DNA is honest: synthetic pairs are analytics-only with NO DIRECT LIQUIDITY", () => {
    const dna = buildDNA(NFT_COLLECTIONS[0]!, QUOTE_TOKENS[2]!, { pairMode: "synthetic", oracle: "coingecko:synthetic" });
    expect(dna.backingModel).toBe("none");
    expect(dna.vault).toBeNull();
    expect(dna.routing).toBe("none");
    expect(dna.restrictions.join(" ")).toContain("SYNTHETIC");
    expect(dna.restrictions.join(" ")).toContain("NO DIRECT LIQUIDITY");
  });
});

describe("pair price provider & service", () => {
  const snapshots: [string, number, number | null, number | null][] = [];
  const store = {
    upsertPairSnapshot: (assetId: string, ts: number, priceUsd: number | null, priceSol: number | null) => {
      const i = snapshots.findIndex(([a]) => a === assetId && Math.abs(a === assetId ? ts - ts : 0) === 0 && snapshots[snapshots.indexOf(snapshots.find(([x, t]) => x === assetId && t === ts)) as any] != null);
      void i;
      const existing = snapshots.findIndex(([x, t]) => x === assetId && t === ts);
      if (existing >= 0) snapshots[existing] = [assetId, ts, priceUsd, priceSol];
      else snapshots.push([assetId, ts, priceUsd, priceSol]);
    },
    getPairSnapshots: (assetId: string, sinceTs: number) =>
      snapshots.filter(([a, t]) => a === assetId && t >= sinceTs).sort((x, y) => x[1] - y[1])
        .map(([, time, priceUsd, priceSol]) => ({ time, priceUsd, priceSol })),
  };

  function stubFetcher(responses: Map<string, unknown>) {
    return async (url: string) => {
      const hit = [...responses.keys()].find((k) => url.includes(k));
      if (!hit) throw new Error("unexpected url " + url);
      return { ok: true, status: 200, json: async () => responses.get(hit) } as unknown as Response;
    };
  }

  it("nftStats parses lamports → SOL; tokenPrices batches ids; refreshAll persists snapshots", async () => {
    snapshots.length = 0;
    const fetcher = stubFetcher(new Map<string, unknown>([
      ["/v2/collections/mad_lads/stats", { symbol: "mad_lads", floorPrice: 8_570_000_000, listedCount: 203, avgPrice24hr: 9_678_320_000, volume7d: 1_308_114_740_954 }],
      ["/coins/markets", [
        { id: "wrapped-sol", current_price: 150, price_change_percentage_24h: 3.1 },
        { id: "nvidia-xstock", current_price: 180, price_change_percentage_24h: -1.2 },
      ]],
    ]));
    const prices = new PairPriceService(store, { fetcher, now: () => 1_000_000_000_000 });
    const stats = await prices.nftStats("mad_lads");
    expect(stats.floorSol).toBeCloseTo(8.57, 6);
    expect(stats.listedCount).toBe(203);

    const cg = await prices.tokenPrices(["wrapped-sol", "nvidia-xstock"]);
    expect(cg.get("wrapped-sol")?.priceUsd).toBe(150);

    const res = await prices.refreshAll();
    expect(res.snapshots).toBeGreaterThanOrEqual(2);
    const mad = store.getPairSnapshots("mad_lads", 0);
    expect(mad).toHaveLength(1);
    expect(mad[0]!.priceSol).toBeCloseTo(8.57, 6);
    const sol = store.getPairSnapshots("wrapped-sol", 0);
    expect(sol[0]!.priceUsd).toBe(150);
  });

  it("service: DIRECT pair NFT/SOL from floor + snapshots; synthetic token/token; detail DNA + series", async () => {
    snapshots.length = 0;
    const T0 = 1_000_000;
    store.upsertPairSnapshot("mad_lads", T0, null, 8.0);
    store.upsertPairSnapshot("mad_lads", T0 + 3600, null, 8.8);
    store.upsertPairSnapshot("wrapped-sol", T0, 100, null);
    store.upsertPairSnapshot("wrapped-sol", T0 + 3600, 100, null); // SOL flat → relative = floor move
    store.upsertPairSnapshot("ethereum-name-service", T0, 7.0, null);
    store.upsertPairSnapshot("wrapped-sol", 0, null, null); // junk ignored by range filter? (ts 0 < T0) fine
    snapshots.pop(); // remove the junk row we just asserted against

    const fetcher = stubFetcher(new Map<string, unknown>([
      ["/v2/collections/mad_lads/stats", { symbol: "mad_lads", floorPrice: 8_800_000_000, listedCount: 203, avgPrice24hr: 9_000_000_000, volume7d: 1e12 }],
      ["/coins/markets", [
        { id: "wrapped-sol", current_price: 100, price_change_percentage_24h: 0 },
        { id: "ethereum", current_price: 2500, price_change_percentage_24h: 1 },
        { id: "bitcoin", current_price: 60000, price_change_percentage_24h: 2 },
        { id: "usd-coin", current_price: 1, price_change_percentage_24h: 0 },
        { id: "nvidia-xstock", current_price: 180, price_change_percentage_24h: -2 },
        { id: "ethereum-name-service", current_price: 7, price_change_percentage_24h: 10 },
      ]],
    ]));
    const prices = new PairPriceService(store, { fetcher, now: () => (T0 + 7200) * 1000 });
    const service = new PairService(prices, () => null);

    const summary = await service.buildSummary(NFT_COLLECTIONS[0]!, QUOTE_TOKENS[0]!, T0);
    expect(summary.pairMode).toBe("direct");
    expect(summary.ratio).toBeCloseTo(8.8, 6);
    expect(summary.directPrice).toBeCloseTo(8.8, 6);
    expect(summary.ratioChange24hPct).toBeCloseTo(10, 3);

    const detail = await service.detail("mad_lads/wrapped-sol", T0);
    expect(detail.relative).not.toBeNull();
    expect(detail.relative!.at(-1)!.relative).toBeCloseTo(110, 3); // floor +10% vs flat SOL
    expect(detail.dna.pairMode).toBe("direct");
    expect(detail.nft?.floorSol).toBeCloseTo(8.8, 6);
    expect(detail.intelligence).toBeNull(); // NFT legs have no USD 24h change source yet

    const syn = await service.buildSummary(QUOTE_TOKENS[5]!, QUOTE_TOKENS[0]!, T0); // ENS/SOL
    expect(syn.pairMode).toBe("synthetic");
    expect(syn.ratio).toBeCloseTo(7 / 100, 6);
    expect(syn.directPrice).toBeNull();
  });

  it("parse/resolve helpers are strict", () => {
    expect(parsePairId("mad_lads/wrapped-sol")).toEqual({ baseId: "mad_lads", quoteId: "wrapped-sol" });
    expect(parsePairId("MAD / SOL")).toEqual({ baseId: "mad", quoteId: "sol" });
    expect(parsePairId("noslash")).toBeNull();
    expect(resolveAsset("MAD")?.id).toBe("mad_lads");
    expect(resolveAsset("wrapped-sol")?.symbol).toBe("SOL");
    expect(resolveAsset("nope")).toBeUndefined();
  });
});
