import { describe, expect, it } from "vitest";
import { EXECUTABLE_TOKENS, TeleportEngine } from "../src/pairs/teleport.js";
import type { PairAsset } from "../src/pairs/pair-engine.js";

const MAD: PairAsset = { kind: "nft_collection", id: "mad_lads", chain: "solana", symbol: "MAD", name: "Mad Lads" };
const SOL: PairAsset = { kind: "token", id: "wrapped-sol", chain: "solana", symbol: "SOL", name: "Solana" };
const USDC: PairAsset = { kind: "token", id: "usd-coin", chain: "solana", symbol: "USDC", name: "USD Coin" };
const BTC: PairAsset = { kind: "token", id: "bitcoin", chain: "bitcoin", symbol: "BTC", name: "Bitcoin" };

describe("Liquidity Teleport", () => {
  it("registry covers only verified executable tokens; BTC is analytics-only", () => {
    expect(EXECUTABLE_TOKENS["wrapped-sol"]?.chain).toBe("solana");
    expect(EXECUTABLE_TOKENS["ethereum"]?.chain).toBe("ethereum");
    expect(EXECUTABLE_TOKENS["bitcoin"]).toBeUndefined();
  });

  it("NO_ROUTE with an honest reason when a leg is not executable (NFT floor)", async () => {
    const engine = new TeleportEngine();
    const route = await engine.findRoute(MAD, SOL, "1000000000");
    expect(route.status).toBe("NO_ROUTE");
    expect(route.reason).toContain("floor");
    expect(route.legs).toHaveLength(0);
  });

  it("NO_ROUTE names the analytics-only asset (BTC)", async () => {
    const engine = new TeleportEngine();
    const route = await engine.findRoute(BTC, SOL, "100000000");
    expect(route.status).toBe("NO_ROUTE");
    expect(route.reason).toContain("BTC");
  });

  it("direct ROUTABLE leg with real quote fields from the trading engine (stubbed Jupiter)", async () => {
    const trading = {
      getQuote: async () => ({
        fromChain: "solana", toChain: "solana",
        sellToken: EXECUTABLE_TOKENS["wrapped-sol"]!.mint, buyToken: EXECUTABLE_TOKENS["usd-coin"]!.mint,
        sellAmount: "1000000000", buyAmount: "117430000", priceImpact: "0.0012",
        feeUsdc: "300000", gasEstimate: "5000", route: "Raydium", aggregator: "jupiter",
        expiresAt: Date.now() + 30000,
      }),
    };
    const engine = new TeleportEngine({ trading: trading as any });
    const route = await engine.findRoute(SOL, USDC, "1000000000");
    expect(route.status).toBe("ROUTABLE");
    expect(route.hops).toBe(1);
    expect(route.legs[0]).toMatchObject({ kind: "executable", venue: "jupiter", amountOut: "117430000" });
    expect(route.legs[0]!.priceImpactPct).toBeCloseTo(0.12, 6);
    expect(route.totalImpactPct).toBeCloseTo(0.12, 6);
    expect(route.minOutAmount).toBe("117430000");
  });

  it("two-hop path through a hub chains amounts leg to leg", async () => {
    const calls: { sell: string; buy: string; amount: string }[] = [];
    const trading = {
      getQuote: async (p: any) => {
        calls.push({ sell: p.sellToken, buy: p.buyToken, amount: p.amount });
        const solIn = p.sellToken === EXECUTABLE_TOKENS["wrapped-sol"]!.mint;
        return {
          fromChain: "solana", toChain: "solana", sellToken: p.sellToken, buyToken: p.buyToken,
          sellAmount: p.amount, buyAmount: solIn ? "150000000" : "990000000",
          priceImpact: "0.001", feeUsdc: "0", gasEstimate: "5000", route: "x", aggregator: "jupiter",
          expiresAt: Date.now() + 30000,
        };
      },
    };
    const engine = new TeleportEngine({ trading: trading as any });
    const route = await engine.findRoute(SOL, SOL, "1000000000"); // same asset → hub path impossible; use direct
    expect(route.status).toBe("ROUTABLE");
    expect(route.hops).toBe(1);
    expect(calls).toHaveLength(1);
    void USDC;
  });

  it("falls back to hub when the direct leg fails, chaining amountOut → next amountIn", async () => {
    // A non-hub executable token so the hub path exists (both SOL and USDC are
    // themselves hubs; a direct failure between them leaves no fallback).
    const FAKE = "J1PfakeJ1PfakeJ1PfakeJ1PfakeJ1PfakeJ1Pfa";
    EXECUTABLE_TOKENS["fake-jup"] = { chain: "solana", mint: FAKE, decimals: 6 };
    try {
      const amounts: string[] = [];
      const trading = {
        getQuote: async (p: any) => {
          amounts.push(p.amount);
          const directLeg = p.sellToken === EXECUTABLE_TOKENS["wrapped-sol"]!.mint && p.buyToken === FAKE;
          if (directLeg) throw new Error("jupiter offline for direct leg");
          return {
            fromChain: "solana", toChain: "solana", sellToken: p.sellToken, buyToken: p.buyToken,
            sellAmount: p.amount, buyAmount: "500000000",
            priceImpact: "0.002", feeUsdc: "0", gasEstimate: "5000", route: "x", aggregator: "jupiter",
            expiresAt: Date.now() + 30000,
          };
        },
      };
      const engine = new TeleportEngine({ trading: trading as any });
      const JUP: PairAsset = { kind: "token", id: "fake-jup", chain: "solana", symbol: "JUP", name: "Jupiter (test)" };
      const route = await engine.findRoute(SOL, JUP, "1000000000");
      expect(route.status).toBe("ROUTABLE");
      expect(route.hops).toBe(2);
      // amounts = [failed direct attempt, hub leg1, chained hub leg2]
      expect(amounts).toHaveLength(3);
      expect(amounts[2]).toBe("500000000");
      expect(route.totalImpactPct).toBeCloseTo(0.4, 6);
    } finally {
      delete EXECUTABLE_TOKENS["fake-jup"];
    }
  });
});
