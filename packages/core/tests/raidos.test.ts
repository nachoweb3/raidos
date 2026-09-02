import { describe, it, expect } from "vitest";
import { MockMarketProvider, DexScreenerProvider } from "../src/market/providers.js";
import { fmtUsd, fmtPrice, fmtPct, abbreviateWallet, volumeCard, trendVerdict, detectAlerts, whaleAlert, DEFAULT_ALERT_THRESHOLDS } from "../src/market/volume.js";
import type { TokenStats } from "../src/market/providers.js";
import { parseDuration, checkinAllowed, checkinXp, raidScore, raidScoreText, DEFAULT_RAID_CONFIG } from "../src/modules/raids.js";
import { BrainDb } from "../src/database/db.js";
import { RaidEngine } from "../src/modules/raids.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const baseStats: TokenStats = {
  symbol: "SAUR",
  name: "Saur Token",
  priceUsd: 0.000042,
  volume24hUsd: 182_000,
  liquidityUsd: 74_000,
  buys24h: 1284,
  sells24h: 917,
  txns24h: 2201,
  holders: 4892,
  change24hPct: 37,
  change1hPct: 4.2,
  pairAddress: "pair123",
  dexId: "raydium",
  source: "mock",
  ts: 1_000,
};

describe("market providers", () => {
  it("mock provider returns clearly-labeled deterministic data", async () => {
    const p = new MockMarketProvider();
    const s = await p.getTokenStats("addr");
    expect(s.symbol).toBe("SAUR");
    expect(s.source).toBe("mock");
    expect(s.volume24hUsd).toBe(182_000);
  });

  it("dexscreener provider parses pairs and picks the most liquid", async () => {
    const payload = {
      pairs: [
        {
          chainId: "solana",
          dexId: "raydium",
          pairAddress: "p1",
          baseToken: { address: "mint", name: "Saur", symbol: "SAUR" },
          priceUsd: "0.000042",
          volume: { h24: 1000, h1: 50 },
          liquidity: { usd: 50_000 },
          txns: { h24: { buys: 10, sells: 4 } },
          priceChange: { h24: 12, h1: 2 },
        },
        {
          chainId: "solana",
          dexId: "orca",
          pairAddress: "p2",
          baseToken: { address: "mint", name: "Saur", symbol: "SAUR" },
          priceUsd: "0.000041",
          volume: { h24: 500 },
          liquidity: { usd: 80_000 },
          txns: { h24: { buys: 5, sells: 5 } },
          priceChange: { h24: 9 },
        },
      ],
    };
    const fakeFetch = (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch;
    const p = new DexScreenerProvider("https://fake");
    const orig = globalThis.fetch;
    globalThis.fetch = fakeFetch as typeof fetch;
    try {
      const s = await p.getTokenStats("mint");
      expect(s.dexId).toBe("orca"); // more liquidity wins
      expect(s.volume24hUsd).toBe(500);
      expect(s.buys24h).toBe(5);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe("volume formatting + card", () => {
  it("formats usd amounts", () => {
    expect(fmtUsd(182_000)).toBe("$182.0K");
    expect(fmtUsd(1_240_000)).toBe("$1.2M");
    expect(fmtUsd(0.000042)).toBe("$0.0000420");
    expect(fmtPrice(0.000042)).toBe("$0.00004200");
    expect(fmtPct(12.34)).toBe("+12.3%");
    expect(fmtPct(null)).toBe("n/a");
  });

  it("abbreviates wallets safely", () => {
    expect(abbreviateWallet("7xK92P")).toBe("7xK92P");
    expect(abbreviateWallet("7xKd93kdmS92kas0nfa0Q")).toBe("7xKd…fa0Q");
  });

  it("renders the card with buys/sells, holders and trend", () => {
    const text = volumeCard(baseStats);
    expect(text).toContain("📊 $SAUR MARKET INTELLIGENCE");
    expect(text).toContain("24H Volume: $182.0K");
    expect(text).toContain("Liquidity: $74.0K");
    expect(text).toContain("Buy/Sell: 1.40");
    expect(text).toContain("Holders: 4,892");
    expect(text).toContain("Source: mock");
  });

  it("detects acceleration vs cooling", () => {
    const accel = trendVerdict({ ...baseStats, change1hPct: 5, change24hPct: 4 });
    expect(accel.label).toBe("ACCELERATING");
    const cool = trendVerdict({ ...baseStats, change1hPct: -3, change24hPct: 2 });
    expect(cool.label).toBe("COOLING");
  });
});

describe("market alerts", () => {
  it("fires a volume spike on a big jump vs the previous snapshot", () => {
    const prev: TokenStats = { ...baseStats, volume24hUsd: 50_000, ts: 900 };
    const alerts = detectAlerts({ ...baseStats, volume24hUsd: 200_000 }, prev, { ...DEFAULT_ALERT_THRESHOLDS, liquidityDeltaPct: 999, priceMove1hPct: 999 });
    expect(alerts.map((a) => a.kind)).toContain("volume_spike");
    expect(alerts[0]!.text).toContain("🔥 VOLUME SPIKE");
    expect(alerts[0]!.text).toContain("$SAUR");
  });

  it("fires liquidity drain and price drop alerts", () => {
    const prev: TokenStats = { ...baseStats, liquidityUsd: 100_000, ts: 900 };
    const alerts = detectAlerts({ ...baseStats, liquidityUsd: 60_000, change1hPct: -12 }, prev);
    const kinds = alerts.map((a) => a.kind);
    expect(kinds).toContain("liquidity_drain");
    expect(kinds).toContain("price_drop");
  });

  it("whale alerts use liquidity share and abbreviate the wallet", () => {
    const a = whaleAlert(baseStats, { side: "buy", usd: 7_420, wallet: "7xKd93kdmS92kas0nfa0Q" });
    expect(a).not.toBeNull();
    expect(a!.kind).toBe("whale_buy");
    expect(a!.text).toContain("10.0% of liquidity");
    expect(a!.text).toContain("`7xKd…fa0Q`");
    expect(whaleAlert(baseStats, { side: "buy", usd: 100, wallet: "x" })).toBeNull();
  });
});

describe("raid engine", () => {
  function newEnv() {
    const dir = mkdtempSync(join(tmpdir(), "brain-raids-"));
    const db = new BrainDb(join(dir, "test.db"));
    const cleanup = () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    };
    return { db, cleanup };
  }

  it("parses durations", () => {
    expect(parseDuration("30m")).toBe(30);
    expect(parseDuration("2h")).toBe(120);
    expect(parseDuration("45")).toBeNull();
    expect(parseDuration("0m")).toBeNull();
  });

  it("enforces check-in cooldown and cap (pure rules)", () => {
    const now = 10_000;
    expect(checkinAllowed(undefined, DEFAULT_RAID_CONFIG, now)).toEqual({ ok: false, reason: "not_joined" });
    const p = { last_checkin_at: now - 100, checkins: 1 };
    expect(checkinAllowed(p, DEFAULT_RAID_CONFIG, now).ok).toBe(false); // cooldown
    expect(checkinAllowed({ ...p, last_checkin_at: now - 1_000 }, DEFAULT_RAID_CONFIG, now).ok).toBe(true);
    expect(checkinAllowed({ ...p, checkins: DEFAULT_RAID_CONFIG.maxCheckinsPerRaid, last_checkin_at: now - 1_000 }, DEFAULT_RAID_CONFIG, now)).toEqual({ ok: false, reason: "checkin_cap" });
  });

  it("applies diminishing returns to check-in xp", () => {
    expect(checkinXp(100, 0, 0.5)).toBe(100);
    expect(checkinXp(100, 1, 0.5)).toBe(50);
    expect(checkinXp(100, 2, 0.5)).toBe(25);
    expect(checkinXp(0, 0, 0.5)).toBe(1); // floor
  });

  it("runs a full raid: create → join → checkins → finish with score", () => {
    const { db, cleanup } = newEnv();
    const grants: { userId: number; xp: number }[] = [];
    const engine = new RaidEngine(db, (_c, userId, xp) => grants.push({ userId, xp }));
    const id = engine.createRaid({
      chatId: 1,
      title: "Launch raid",
      platform: "x",
      targetUrl: "https://x.com/saur/status/1",
      objective: 500,
      durationMinutes: 30,
      xpReward: 100,
      maxParticipants: null,
      createdBy: 99,
    });
    const r = db.getRaid(id)!;
    expect(r.status).toBe("active");

    expect(engine.join(id, 42, "alice")).toBe("ok");
    expect(engine.join(id, 42, "alice")).toBe("already");
    expect(engine.checkin(id, 43).status).toBe("not_joined");

    const first = engine.checkin(id, 42);
    expect(first.status).toBe("ok");
    if (first.status === "ok") {
      expect(first.xp).toBe(100);
      expect(first.checkins).toBe(1);
    }

    const score = engine.score(id)!;
    expect(score.participants).toBe(1);
    expect(score.trackedActions).toBe(1);
    expect(score.completionPct).toBeCloseTo((1 / 500) * 100, 5);
    expect(raidScoreText(score)).toContain("RAID SCORE");

    const out = engine.finish(id)!;
    expect(out.top).toEqual({ user_id: 42, username: "alice", checkins: 1 });
    expect(db.getRaid(id)!.status).toBe("finished");
    expect(grants.length).toBe(1);
    cleanup();
  });

  it("respects max participants", () => {
    const { db, cleanup } = newEnv();
    const engine = new RaidEngine(db, () => {});
    const id = engine.createRaid({ chatId: 1, title: "T", platform: "x", targetUrl: "", objective: 0, durationMinutes: 30, xpReward: 10, maxParticipants: 1, createdBy: 1 });
    expect(engine.join(id, 1, "a")).toBe("ok");
    expect(engine.join(id, 2, "b")).toBe("full");
    cleanup();
  });

  it("blocks check-ins after the raid window ends", () => {
    const { db, cleanup } = newEnv();
    const engine = new RaidEngine(db, () => {});
    const id = engine.createRaid({ chatId: 1, title: "T", platform: "x", targetUrl: "", objective: 0, durationMinutes: 1, xpReward: 10, maxParticipants: null, createdBy: 1 });
    expect(engine.join(id, 1, "a")).toBe("ok");
    // Simulate expiry by rewinding ends_at.
    db.setRaidStatus(id, "finished");
    expect(engine.checkin(id, 1).status).toBe("raid_closed");
    cleanup();
  });

  it("classifies velocity in the score", () => {
    const now = Math.floor(Date.now() / 1000);
    const r = {
      id: 1, chat_id: 1, title: "T", platform: "x", target_url: "", objective: 0,
      duration_minutes: 10, xp_reward: 10, max_participants: null, status: "active" as const,
      created_by: 1, started_at: now - 600, ends_at: now + 600, finished_at: null,
    };
    const s = raidScore(r, 10, 300, now); // 300 actions / 10 users / 10min = 3/min → high
    expect(s.velocity).toBe("high");
    const slow = raidScore(r, 10, 5, now); // 0.05/min → low
    expect(slow.velocity).toBe("low");
  });
});
