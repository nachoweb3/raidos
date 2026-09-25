import { describe, expect, it } from "vitest";
import { FloorLiquidityService } from "../src/pairs/floor-liquidity.js";

/** Raw rows shaped exactly like the live Magic Eden listings payload (verified). */
const row = (over: Record<string, unknown> = {}) => ({
  pdaAddress: "pda", auctionHouse: "ah", tokenAddress: "ta",
  tokenMint: "MINT111111111111111111111111111111111111111",
  price: 9.5247,
  priceInfo: { solPrice: { rawAmount: "9524700000", address: "So…", decimals: 9 } },
  rarity: { howrare: { rank: 3423 }, moonrank: { rank: 2816, absolute_rarity: 2816 }, meInstant: { rank: 2816 } },
  token: { name: "Mad Lads #4591", collection: "mad_lads" },
  ...over,
});

const makeService = (pages: unknown[][], calls: string[] = []) => {
  let page = 0;
  return new FloorLiquidityService({
    pageSize: 2,
    maxPages: 5,
    now: () => 1_000_000,
    fetcher: async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => pages[page++] ?? [] } as Response;
    },
  });
};

describe("FloorLiquidityService (Magic Eden real listings)", () => {
  it("classifies a real listing: cheapest-first, meInstant rank wins, lamports preserved", async () => {
    const svc = makeService([[row()]]);
    const snap = await svc.floorFor("mad_lads", 250);
    expect(snap.source).toBe("magiceden");
    expect(snap.listingsObserved).toBe(1);
    expect(snap.floor).toMatchObject({
      mint: "MINT111111111111111111111111111111111111111",
      priceSol: 9.5247,
      priceLamports: "9524700000",
      name: "Mad Lads #4591",
      rarityRank: 2816,
      raritySource: "meInstant",
      collection: "mad_lads",
    });
    expect(snap.floor!.listingUrl).toContain("magiceden.io/item-details/");
  });

  it("rarity guard: skips top-N rarest listings and keeps paginating to a passing one", async () => {
    const calls: string[] = [];
    const svc = makeService(
      [
        [row({ tokenMint: "RARE1", rarity: { meInstant: { rank: 50 } } }), row({ tokenMint: "RARE2", rarity: { moonrank: { rank: 120 } } })],
        [row({ tokenMint: "OKFLOOR", rarity: { howrare: { rank: 9000 } } })],
      ],
      calls,
    );
    const snap = await svc.floorFor("mad_lads", 1_000);
    expect(snap.excludedByRarity).toBe(2);
    expect(snap.floor?.mint).toBe("OKFLOOR");
    expect(snap.floor?.raritySource).toBe("howrare");
    expect(calls.some((u) => u.includes("offset=2"))).toBe(true); // pagination happened
  });

  it("maxRank=100: top-100 rarest excluded → honest empty floor with counts", async () => {
    const svc = makeService([
      [row({ rarity: { meInstant: { rank: 50 } } }), row({ rarity: { meInstant: { rank: 90 } } })],
    ]);
    const snap = await svc.floorFor("mad_lads", 100);
    expect(snap.floor).toBeNull();
    expect(snap.listingsObserved).toBe(2);
    expect(snap.excludedByRarity).toBe(2);
  });

  it("listing without any rarity source passes when under an explicit cap check (rank null ≠ excluded)", async () => {
    const svc = makeService([[row({ rarity: null })]]);
    const snap = await svc.floorFor("mad_lads", 10);
    expect(snap.floor).not.toBeNull(); // unknown rank is not invented, not excluded
    expect(snap.floor?.rarityRank).toBeNull();
    expect(snap.floor?.raritySource).toBeNull();
  });

  it("empty collection: zero listings observed, floor null", async () => {
    const svc = makeService([[]]);
    const snap = await svc.floorFor("ghost_collection", 10_000);
    expect(snap.floor).toBeNull();
    expect(snap.listingsObserved).toBe(0);
  });

  it("upstream failure propagates (no invented floors)", async () => {
    const svc = new FloorLiquidityService({
      pageSize: 2, now: () => 1_000_000,
      fetcher: async () => ({ ok: false, status: 503, json: async () => ({}) } as unknown as Response),
    });
    await expect(svc.floorFor("mad_lads", 10_000)).rejects.toThrow("magiceden listings HTTP 503");
  });
});
