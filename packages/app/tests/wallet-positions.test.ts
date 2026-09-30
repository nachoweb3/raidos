import { describe, expect, it } from "vitest";
import { AppDb } from "../src/database/app-db.js";
import { applySwapToWalletPosition } from "../src/trading/wallet-positions.js";
import { MockWalletActivityProvider } from "../src/market/wallet-activity.js";
import { ApiServer } from "../src/api/server.js";

const WALLET = "7XaBcDeFgHiJkLmNoPqRsTuVwXyZ123456789AbCdEf"; // valid base58 (no 0/O/I/l)
const OTHER = "9xFake1111111111111111111111111111111111111";
const TOKEN = "MoMuVWx5cYCGXcDjQ5M6Z6Bs6c3T7eTTC6PxC1gVaaa";

describe("wallet position aggregator (unit)", () => {
  it("average-costs buys and pro-rates partial sells (USD metrics only when priced)", () => {
    let pos = applySwapToWalletPosition(undefined, { side: "buy", amountToken: "1000", priceUsd: 0.001, ts: 100 });
    expect(pos).toMatchObject({ status: "open", amount_remaining: "1000", avg_entry_usd: 0.001, net_invested_usd: 1, max_multiple: 1 });

    // Second buy at a higher price: avg entry blends, current multiple 1.5 → no milestone yet.
    pos = applySwapToWalletPosition(pos, { side: "buy", amountToken: "1000", priceUsd: 0.003, ts: 200 });
    expect(pos).toMatchObject({ amount_remaining: "2000", avg_entry_usd: 0.002, net_invested_usd: 4, max_multiple: 1.5 });

    // Partial sell at 0.01: allocated cost 1, proceeds 5 → realized +4; avg entry preserved pro-rata.
    pos = applySwapToWalletPosition(pos, { side: "sell", amountToken: "500", priceUsd: 0.01, ts: 300 });
    expect(pos.status).toBe("open");
    expect(pos.amount_remaining).toBe("1500");
    expect(pos.net_invested_usd).toBeCloseTo(3, 10);
    expect(pos.avg_entry_usd).toBeCloseTo(0.002, 12);
    expect(pos.realized_pnl_usd).toBeCloseTo(4, 10);
    // 0.01 / 0.002 = 5x → crosses both thresholds in one swap.
    expect(pos.max_multiple).toBe(5);
    expect(pos.milestones.map((m) => m.kind)).toEqual(["POSITION_2X", "POSITION_5X"]);
    expect(pos.milestones.every((m) => m.ts === 300)).toBe(true);

    // Full close at 0.008: proceeds 12, allocated 3 → realized 4 + 9 = 13.
    pos = applySwapToWalletPosition(pos, { side: "sell", amountToken: "1500", priceUsd: 0.008, ts: 400 });
    expect(pos.status).toBe("closed");
    expect(pos.amount_remaining).toBe("0");
    expect(pos.realized_pnl_usd).toBeCloseTo(13, 10);
    expect(pos.closed_at).toBe(400);
    expect(pos.milestones).toEqual([]); // 4x < prevMax 5 → nothing new
  });

  it("milestones fire exactly once per threshold and re-arming requires crossing again", () => {
    let pos = applySwapToWalletPosition(undefined, { side: "buy", amountToken: "100", priceUsd: 1, ts: 1 });
    // Small buy far above the average pulls the mark (price/avg-entry) over 2x.
    pos = applySwapToWalletPosition(pos, { side: "buy", amountToken: "10", priceUsd: 3, ts: 2 });
    expect(pos.milestones.map((m) => m.kind)).toEqual(["POSITION_2X"]);
    expect(pos.max_multiple).toBeGreaterThan(2.5);
    // Another buy whose mark (≈2.31x) is below the previous max → no duplicate.
    pos = applySwapToWalletPosition(pos, { side: "buy", amountToken: "10", priceUsd: 3.1, ts: 3 });
    expect(pos.milestones).toEqual([]);
    expect(pos.max_multiple).toBeGreaterThan(2.5); // max is monotonic, never regresses
  });

  it("unpriced observations make USD metrics unknown (never interpolated)", () => {
    let pos = applySwapToWalletPosition(undefined, { side: "buy", amountToken: "1000", priceUsd: 0.001, ts: 1 });
    // A buy without observed price poisons the basis: null from here on.
    pos = applySwapToWalletPosition(pos, { side: "buy", amountToken: "500", priceUsd: null, ts: 2 });
    expect(pos.amount_remaining).toBe("1500");
    expect(pos.avg_entry_usd).toBeNull();
    expect(pos.net_invested_usd).toBeNull();
    expect(pos.max_multiple).toBe(1); // last known value preserved, not extrapolated
    // Sells still track amounts; USD PnL becomes unknown too.
    pos = applySwapToWalletPosition(pos, { side: "sell", amountToken: "500", priceUsd: 0.002, ts: 3 });
    expect(pos.amount_remaining).toBe("1000");
    expect(pos.realized_pnl_usd).toBeNull();
    expect(pos.milestones).toEqual([]);
  });

  it("rejects unaccountable observations instead of guessing (orphan/oversell/garbage)", () => {
    expect(() => applySwapToWalletPosition(undefined, { side: "sell", amountToken: "10", priceUsd: 1, ts: 1 }))
      .toThrow("cannot sell without an open position");
    const pos = applySwapToWalletPosition(undefined, { side: "buy", amountToken: "100", priceUsd: 1, ts: 1 });
    expect(() => applySwapToWalletPosition(pos, { side: "sell", amountToken: "200", priceUsd: 1, ts: 2 }))
      .toThrow("sell amount exceeds tracked position");
    expect(() => applySwapToWalletPosition(undefined, { side: "buy", amountToken: "0", ts: 1 })).toThrow();
    expect(() => applySwapToWalletPosition(undefined, { side: "buy", amountToken: "100", priceUsd: -1, ts: 1 })).toThrow();
    // A buy re-opens a closed position without losing history.
    const closed = applySwapToWalletPosition(pos, { side: "sell", amountToken: "100", priceUsd: 2, ts: 2 });
    expect(closed.status).toBe("closed");
    const reopened = applySwapToWalletPosition(closed, { side: "buy", amountToken: "50", priceUsd: 1, ts: 3 });
    expect(reopened.status).toBe("open");
    expect(reopened.opened_at).toBe(1); // original open preserved
    expect(reopened.total_bought).toBe("150");
  });
});

describe("wallet positions db (rebuild from onchain_swaps)", () => {
  it("rebuilds positions deterministically, is idempotent and dedupes milestones", () => {
    const db = new AppDb(":memory:");
    const swap = (over: Record<string, unknown>) => ({
      signature: "sig", chain: "solana", token: TOKEN, wallet: WALLET, side: "buy" as const,
      amountToken: "1000", amountUsd: null, priceUsd: null, ts: 0, source: "mock", ...over,
    });
    db.insertOnchainSwaps([
      swap({ signature: "s1", side: "buy", amountToken: "1000", priceUsd: 0.001, ts: 100 }),
      swap({ signature: "s2", side: "buy", amountToken: "1000", priceUsd: 0.003, ts: 200 }),
      swap({ signature: "s3", side: "sell", amountToken: "500", priceUsd: 0.01, ts: 300 }),
      // Orphan sell: wallet traded before tracking started → skipped honestly.
      swap({ signature: "s4", wallet: OTHER, side: "sell", amountToken: "10", priceUsd: 0.01, ts: 310 }),
      // Oversell beyond the tracked position → skipped honestly.
      swap({ signature: "s5", side: "sell", amountToken: "999999", priceUsd: 0.01, ts: 320 }),
    ]);

    const first = db.rebuildWalletPositions();
    expect(first).toEqual({ positions: 1, unaccountable: 2 });

    const positions = db.listWalletPositionsByToken("solana", TOKEN, { openOnly: false });
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ wallet: WALLET, status: "open", amount_remaining: "1500", total_bought: "2000", total_sold: "500" });
    expect(positions[0].avg_entry_usd).toBeCloseTo(0.002, 12);
    expect(positions[0].realized_pnl_usd).toBeCloseTo(4, 10);
    expect(positions[0].max_multiple).toBe(5);

    const milestones = db.listWalletMilestonesByToken("solana", TOKEN);
    expect(milestones.map((m: any) => m.kind)).toEqual(["POSITION_5X", "POSITION_2X"]); // newest first
    expect(db.listPendingWalletMilestones()).toHaveLength(2);

    // Idempotent: same observations → same positions, no duplicated milestones.
    const second = db.rebuildWalletPositions();
    expect(second).toEqual(first);
    expect(db.listWalletMilestonesByToken("solana", TOKEN)).toHaveLength(2);
    expect(db.listPendingWalletMilestones()).toHaveLength(2); // still unemitted until marked

    // Exactly-once emission.
    const pending = db.listPendingWalletMilestones();
    db.markWalletMilestonesEmitted(pending.map((m: any) => m.id));
    expect(db.listPendingWalletMilestones()).toHaveLength(0);
    expect(db.listWalletMilestonesByToken("solana", TOKEN)).toHaveLength(2);

    // Per-wallet listing.
    expect(db.listWalletPositionsByWallet(WALLET, { chain: "solana" })).toHaveLength(1);
    expect(db.listWalletPositionsByWallet(OTHER)).toHaveLength(0); // orphan never fabricated one
    db.close();
  });
});

describe("wallet positions E2E (ingest → aggregate → feed)", () => {
  it("emits POSITION_xX milestones to the feed exactly once after ingestion", async () => {
    const t0 = Math.floor(Date.now() / 1000);
    const fixture = [
      { signature: "fx-b1", token: TOKEN, wallet: WALLET, side: "buy" as const, amountToken: "1000", amountUsd: 1, priceUsd: 0.001, ts: t0 - 120, source: "mock" },
      { signature: "fx-s1", token: TOKEN, wallet: WALLET, side: "sell" as const, amountToken: "500", amountUsd: 5, priceUsd: 0.01, ts: t0 - 60, source: "mock" },
    ];
    const server = new ApiServer({ dbPath: ":memory:", siteDir: null, port: 0, appMode: "mock", walletActivity: new MockWalletActivityProvider(fixture) });
    const port = await server.start();
    const base = `http://127.0.0.1:${port}`;
    try {
      process.env.ADMIN_SECRET = "positions-admin-secret";
      const admin = { "content-type": "application/json", "x-admin-secret": "positions-admin-secret" };
      const created = await fetch(base + "/api/admin/wallets", {
        method: "POST", headers: admin,
        body: JSON.stringify({ chain: "solana", address: WALLET, label: "Nacho", category: "smart", priority: 1 }),
      });
      expect(created.status).toBe(201);

      // Gate (same channel as the signals tab): mint → redeem → cookie.
      const src = server.telegramSource as unknown as { token: string; chatId: string };
      src.token = "test-token";
      src.chatId = "-100";
      const mintRes = await fetch(base + "/api/admin/tg/mint-code", { method: "POST", headers: admin, body: JSON.stringify({ telegramUserId: "positions" }) });
      const { code } = (await mintRes.json()) as any;
      const redeem = await fetch(base + "/api/tg/redeem", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
      const cookie = redeem.headers.get("set-cookie") ?? "";

      // First poll pass fires 2s after start(); wait for the aggregator to run.
      let activity: any = null;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 500));
        activity = await (await fetch(base + `/api/tokens/solana/${TOKEN}/onchain-activity`, { headers: { cookie } })).json() as any;
        if (activity.milestones?.length > 0) break;
      }
      expect(activity.status).toBe("LIVE");
      expect(activity.positions).toHaveLength(1);
      expect(activity.positions[0]).toMatchObject({ wallet: WALLET, status: "open", amount_remaining: "500" });
      expect(activity.positions[0].avg_entry_usd).toBeCloseTo(0.001, 12);
      // One buy @0.001 + one sell @0.01 → mark = 10x at the sell.
      expect(activity.milestones.map((m: any) => m.kind).sort()).toEqual(["POSITION_10X", "POSITION_2X", "POSITION_5X"]);

      // Milestones reached the public feed (system events, actor_id 0).
      const feed = await (await fetch(base + `/api/feed?chain=solana&token=${TOKEN}`)).json() as any;
      const kinds = feed.events.filter((e: any) => e.type.startsWith("POSITION_")).map((e: any) => e.type);
      expect(kinds.sort()).toEqual(["POSITION_10X", "POSITION_2X", "POSITION_5X"]);
      const pos5 = feed.events.find((e: any) => e.type === "POSITION_5X");
      expect(pos5.payload).toMatchObject({ wallet: WALLET, source: "mock" });

      delete process.env.ADMIN_SECRET;
    } finally {
      await server.stop();
    }
  });
});
