import { describe, expect, it } from "vitest";
import { computeWalletRating, MIN_TRADES_FOR_SCORE, type WalletTrade } from "../src/social/rating.js";
import { extractCallSignals } from "../src/social/sources.js";

/** Deterministic fake catalog for signal extraction tests. */
function fakeCatalog(assets: { chain: string; address: string; symbol: string }[]) {
  return {
    findAsset: (chain: string, address: string) =>
      assets.find((a) => a.chain === chain && a.address.toLowerCase() === address.toLowerCase()),
  } as any;
}

const SOL_TOKEN = "So11111111111111111111111111111111111111112";
const EVM_TOKEN = "0x" + "a".repeat(40);

function buy(token: string, volumeUsd: number, price: number, time: number, qty?: number): WalletTrade {
  return { chain: "solana", wallet: "W", token, side: "buy", priceUsd: price, volumeUsd, amount: String(qty ?? volumeUsd / price), time };
}
function sell(token: string, volumeUsd: number, price: number, time: number, qty?: number): WalletTrade {
  return { chain: "solana", wallet: "W", token, side: "sell", priceUsd: price, volumeUsd, amount: String(qty ?? volumeUsd / price), time };
}

describe("wallet rating v1", () => {
  it("returns null with no trades", () => {
    expect(computeWalletRating([])).toBeNull();
  });

  it("gives NO score to a wallet below the sample minimum (honest insufficiency)", () => {
    const trades = [buy(SOL_TOKEN, 1000, 1, 1000), sell(SOL_TOKEN, 2000, 2, 2000)];
    const r = computeWalletRating(trades)!;
    expect(r.score).toBeNull();
    expect(r.verdict).toBe("EVIDENCIA INSUFICIENTE");
    expect(r.metrics.trades).toBe(2);
  });

  it("gives NO score to a wallet that only buys (no realized evidence)", () => {
    const trades = Array.from({ length: MIN_TRADES_FOR_SCORE + 4 }, (_, i) =>
      buy(SOL_TOKEN, 500, 1, 1000 + i * 60));
    const r = computeWalletRating(trades)!;
    expect(r.score).toBeNull();
    expect(r.reasons.some((x) => x.includes("cerrado"))).toBe(true);
  });

  it("scores a consistently profitable wallet high and marks it copyable", () => {
    const trades: WalletTrade[] = [];
    // 12 cycles: buy at 1.0, sell at 1.5 → all wins, holds of ~6h (copyable)
    for (let i = 0; i < 12; i++) {
      const t0 = 10 * 86400 + i * 21_600;
      trades.push(buy(SOL_TOKEN, 1000, 1, t0));
      trades.push(sell(SOL_TOKEN, 1500, 1.5, t0 + 21_600));
    }
    const r = computeWalletRating(trades)!;
    expect(r.score).not.toBeNull();
    expect(r.score!).toBeGreaterThanOrEqual(50);
    expect(r.copyable).toBe(true);
    expect(r.metrics.winRate).toBe(1);
    expect(r.metrics.profitFactor).toBeCloseTo(3, 0);
    expect(r.metrics.realizedPnlUsd).toBeGreaterThan(0);
  });

  it("punishes a high win-rate wallet with catastrophic losses (the 70% trap)", () => {
    const trades: WalletTrade[] = [];
    // 9 small wins (+10%), 3 catastrophic losses (-80%)
    for (let i = 0; i < 9; i++) {
      const t0 = i * 3600;
      trades.push(buy(SOL_TOKEN, 1000, 1, t0));
      trades.push(sell(SOL_TOKEN, 1100, 1.1, t0 + 1800));
    }
    for (let i = 0; i < 3; i++) {
      const t0 = 40_000 + i * 3600;
      trades.push(buy(SOL_TOKEN, 5000, 1, t0));
      trades.push(sell(SOL_TOKEN, 1000, 0.2, t0 + 1800));
    }
    const r = computeWalletRating(trades)!;
    expect(r.metrics.winRate!).toBeGreaterThan(0.7);
    // Realized PnL: 9×100 − 3×4000 = −11100 → negative edge must block copyability
    expect(r.metrics.realizedPnlUsd).toBeLessThan(0);
    expect(r.copyable).toBe(false);
  });

  it("flags concentration when one token dominates PnL", () => {
    const trades: WalletTrade[] = [];
    const OTHER = "OtherToken111111111111111111111111111111111";
    // One big moonshot
    trades.push(buy(SOL_TOKEN, 500, 1, 1000));
    trades.push(sell(SOL_TOKEN, 25000, 50, 200_000));
    // Many tiny losing trades on another token
    for (let i = 0; i < 10; i++) {
      const t0 = 5000 + i * 7200;
      trades.push(buy(OTHER, 200, 1, t0));
      trades.push(sell(OTHER, 180, 0.9, t0 + 3600));
    }
    const r = computeWalletRating(trades)!;
    expect(r.metrics.topTokenShare!).toBeGreaterThan(0.7);
    expect(r.reasons.some((x) => x.includes("UN solo token"))).toBe(true);
  });

  it("marks sub-5-minute scalping as not copyable even when profitable", () => {
    const trades: WalletTrade[] = [];
    for (let i = 0; i < 15; i++) {
      const t0 = i * 60; // 1-minute holds
      trades.push(buy(SOL_TOKEN, 1000, 1, t0));
      trades.push(sell(SOL_TOKEN, 1300, 1.3, t0 + 30));
    }
    const r = computeWalletRating(trades)!;
    expect(r.score).not.toBeNull();
    expect(r.copyable).toBe(false);
    expect(r.reasons.some((x) => x.includes("Hold times"))).toBe(true);
  });

  it("weights paper (unrealized) PnL against realized share", () => {
    const trades: WalletTrade[] = [];
    for (let i = 0; i < 8; i++) {
      const t0 = i * 7200;
      trades.push(buy(SOL_TOKEN, 1000, 1, t0));
      trades.push(sell(SOL_TOKEN, 1200, 1.2, t0 + 3600));
    }
    // One huge open position, then a small buy marks the observed price up 2x
    // → the open lot carries large paper gains vs its 1.0 cost.
    trades.push(buy(SOL_TOKEN, 50_000, 1, 100_000));
    trades.push(buy(SOL_TOKEN, 20, 2, 100_060));
    const r = computeWalletRating(trades)!;
    expect(r.metrics.unrealizedPnlUsd).not.toBeNull();
    expect(r.metrics.realizedShare!).toBeLessThan(0.5);
  });
});

describe("CT call extraction", () => {
  const catalog = fakeCatalog([
    { chain: "solana", address: SOL_TOKEN, symbol: "SOL" },
    { chain: "base", address: EVM_TOKEN, symbol: "FAKE" },
  ]);

  it("extracts a signal when the tweet contains a resolvable address", () => {
    const signals = extractCallSignals([{
      handle: "kol", id: "1", text: `apex entry ${SOL_TOKEN} lfg`, createdAt: 1000, url: "u",
    }], catalog);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ chain: "solana", token: SOL_TOKEN, handle: "kol" });
  });

  it("NEVER signals from cashtags alone (no address → no signal)", () => {
    const signals = extractCallSignals([{
      handle: "kol", id: "2", text: "$SOL is going to the moon, trust me", createdAt: 1000, url: "u",
    }], catalog);
    expect(signals).toHaveLength(0);
  });

  it("ignores addresses not present in the catalog", () => {
    const unknown = "0x" + "f".repeat(40);
    const signals = extractCallSignals([{
      handle: "kol", id: "3", text: `check ${unknown} now`, createdAt: 1000, url: "u",
    }], catalog);
    expect(signals).toHaveLength(0);
  });

  it("dedupes the same address repeated in one tweet", () => {
    const signals = extractCallSignals([{
      handle: "kol", id: "4", text: `${EVM_TOKEN} ... ${EVM_TOKEN} again`, createdAt: 1000, url: "u",
    }], catalog);
    expect(signals).toHaveLength(1);
  });
});
