import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchPredictionEvents, fetchPredictionEvent, PREDICTION_CATEGORIES } from "../src/market/prediction.js";

function gammaEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "123",
    title: "Bitcoin above $120K by end of year?",
    slug: "btc-120k-eoy",
    description: "Will BTC close above $120,000 on Dec 31?",
    image: "https://example.com/btc.png",
    category: "crypto",
    tags: ["bitcoin"],
    volume: "1500000",
    liquidity: "300000",
    openInterest: 50000,
    active: true,
    closed: false,
    featured: false,
    markets: [
      {
        id: "m1",
        question: "Bitcoin above $120K by end of year?",
        slug: "btc-120k-eoy",
        conditionId: "0xabc",
        outcomes: ["Yes", "No"],
        outcomePrices: ["0.62", "0.38"],
        bestAsk: "0.63",
        bestBid: "0.61",
        lastTradePrice: "0.62",
        volumeNum: "900000",
        liquidity: "200000",
        spread: "0.02",
        enableOrderBook: true,
        acceptingOrders: true,
      },
    ],
    ...overrides,
  };
}

describe("prediction markets module", () => {
  afterEach(() => vi.restoreAllMocks());

  it("maps Gamma events into the normalized shape", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
      ok: true,
      json: async () => [gammaEvent()],
    })) as any);
    const events = await fetchPredictionEvents({ limit: 5 });
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.title).toContain("Bitcoin");
    expect(e.category).toBe("crypto");
    expect(e.volumeUsd).toBe(1500000);
    expect(e.markets).toHaveLength(1);
    const m = e.markets[0]!;
    expect(m.outcomes).toEqual(["Yes", "No"]);
    expect(m.outcomePrices).toEqual([0.62, 0.38]);
    expect(m.bestAsk).toBe(0.63);
    expect(m.orderBookEnabled).toBe(true);
  });

  it("passes category + trending params to the Gamma API", async () => {
    let calledUrl = "";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calledUrl = String(url);
      return { ok: true, json: async () => [] };
    }) as any);
    await fetchPredictionEvents({ category: "crypto", trending: true, limit: 10 });
    expect(calledUrl).toContain("tag=crypto");
    expect(calledUrl).toContain("order=volume24hr");
    expect(calledUrl).toContain("closed=false");
  });

  it("fetches a single event by slug", async () => {
    let calledUrl = "";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calledUrl = String(url);
      return { ok: true, json: async () => [gammaEvent()] };
    }) as any);
    const event = await fetchPredictionEvent("btc-120k-eoy");
    expect(event?.slug).toBe("btc-120k-eoy");
    expect(calledUrl).toContain("slug=btc-120k-eoy");
  });

  it("returns null for a missing event", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => [] })) as any);
    const event = await fetchPredictionEvent("nope");
    expect(event).toBeNull();
  });

  it("throws on API failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 })) as any);
    await expect(fetchPredictionEvents()).rejects.toThrow("500");
  });

  it("exposes UI categories", () => {
    expect(PREDICTION_CATEGORIES).toContain("crypto");
    expect(PREDICTION_CATEGORIES).toContain("politics");
    expect(PREDICTION_CATEGORIES).toContain("sports");
  });
});