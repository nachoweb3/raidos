import { readFileSync } from "node:fs";
import { SourceTextModule } from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";
let indicators: any;
beforeAll(async () => {
  const module = new SourceTextModule(readFileSync(new URL("../../../site/js/chart-indicators.js", import.meta.url), "utf8"));
  await module.link(() => { throw new Error("Pure module must have no dependencies"); });
  await module.evaluate(); indicators = module.namespace;
});
describe("chart mathematics", () => {
  it("calculates SMA without padding the warmup", () => {
    expect(indicators.sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });
  it("seeds EMA with the initial SMA and applies exponential weighting", () => {
    expect(indicators.ema([1, 2, 3, 8, 4], 3)).toEqual([null, null, 2, 5, 4.5]);
  });
  it("calculates Bollinger population deviation", () => {
    const result = indicators.bollinger([1, 2, 3], 3);
    expect(result.middle).toEqual([null, null, 2]);
    expect(result.upper[2]).toBeCloseTo(2 + 2 * Math.sqrt(2 / 3), 12);
    expect(result.lower[2]).toBeCloseTo(2 - 2 * Math.sqrt(2 / 3), 12);
  });
  it("uses Wilder smoothing for RSI and defines flat/one-sided series", () => {
    expect(indicators.rsi([1, 2, 3, 2, 4], 3)[3]).toBeCloseTo(66.6666666667);
    expect(indicators.rsi([1, 2, 3, 2, 4], 3)[4]).toBeCloseTo(83.3333333333);
    expect(indicators.rsi([1, 2, 3, 4], 3)).toEqual([null, null, null, 100]);
    expect(indicators.rsi([4, 3, 2, 1], 3)[3]).toBe(0);
    expect(indicators.rsi([2, 2, 2, 2], 3)[3]).toBe(50);
  });
  it("does not invent values for insufficient samples", () => {
    expect(indicators.ema([1, 2], 5)).toEqual([null, null]);
    expect(indicators.rsi([], 14)).toEqual([]);
  });
  it("rejects invalid periods, nonfinite inputs and missing prices", () => {
    for (const period of [0, 1.5, 501]) expect(() => indicators.sma([1, 2], period)).toThrow();
    for (const value of [NaN, Infinity, null]) expect(() => indicators.ema([1, value], 2)).toThrow();
  });
  it("never uses a future sample to calculate an earlier indicator", () => {
    for (const method of ["sma", "ema", "rsi"]) {
      const prefix = indicators[method]([1, 3, 2, 4, 6], 3);
      expect(indicators[method]([1, 3, 2, 4, 6, 1000], 3).slice(0, 5)).toEqual(prefix);
    }
  });
});
