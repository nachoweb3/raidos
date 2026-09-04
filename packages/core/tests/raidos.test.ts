import { describe, it, expect } from "vitest";
import { MockMarketProvider, DexScreenerProvider, GeckoTerminalProvider, BirdeyeProvider, providerByName, PROVIDER_NAMES } from "../src/market/providers.js";
import { fmtUsd, fmtPrice, fmtPct, abbreviateWallet, volumeCard, trendVerdict, detectAlerts, whaleAlert, DEFAULT_ALERT_THRESHOLDS } from "../src/market/volume.js";
import type { TokenStats } from "../src/market/providers.js";
import { parseDuration, checkinAllowed, checkinXp, raidScore, raidScoreText, DEFAULT_RAID_CONFIG } from "../src/modules/raids.js";
import { BrainDb } from "../src/database/db.js";
import { RaidEngine } from "../src/modules/raids.js";
import { raidAnalytics, raidAnalyticsText, raidAnalyticsNarrative, windowStats } from "../src/modules/raid-analytics.js";
import type { RaidAnalytics } from "../src/modules/raid-analytics.js";
import type { AiProvider } from "../src/ai/provider.js";
import {
  collectSocialSignals,
  socialMomentumSignals,
  combineMomentum,
  DEFAULT_MOMENTUM_THRESHOLDS,
} from "../src/modules/momentum.js";
import type { SocialSignals } from "../src/modules/momentum.js";
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

  it("geckoterminal provider parses pools and picks the deepest", async () => {
    const payload = {
      data: [
        {
          id: "raydium_p1",
          type: "pool",
          attributes: {
            name: "SAUR / SOL",
            address: "p1",
            base_token_price_usd: "0.000042",
            volume_usd: { h24: "1000", h1: "50" },
            reserve_in_usd: "50000",
            transactions: { h24: { buys: 10, sells: 4 } },
            price_change_percentage: { h24: "12.5", h1: "2.0" },
          },
          relationships: { base_token: { data: { id: "solana_mint" } } },
        },
        {
          id: "orca_p2",
          type: "pool",
          attributes: {
            name: "SAUR / SOL",
            address: "p2",
            base_token_price_usd: "0.000041",
            volume_usd: { h24: "500" },
            reserve_in_usd: "80000",
            transactions: { h24: { buys: 5, sells: 5 } },
          },
          relationships: { base_token: { data: { id: "solana_mint" } } },
        },
      ],
      included: [
        { id: "solana_mint", type: "token", attributes: { address: "mint", name: "Saur", symbol: "SAUR" } },
      ],
    };
    const fakeFetch = (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch;
    const p = new GeckoTerminalProvider("solana", "https://fake");
    const orig = globalThis.fetch;
    globalThis.fetch = fakeFetch as typeof fetch;
    try {
      const s = await p.getTokenStats("mint");
      expect(s.pairAddress).toBe("p2"); // deeper pool wins
      expect(s.symbol).toBe("SAUR");
      expect(s.volume24hUsd).toBe(500);
      expect(s.buys24h).toBe(5);
      expect(s.change1hPct).toBe(null); // missing h1 → null, never fabricated
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("geckoterminal falls back to pool-name symbol when token include is missing", async () => {
    const payload = {
      data: [
        {
          id: "raydium_p1",
          type: "pool",
          attributes: { name: "SAUR / SOL", base_token_price_usd: "1", volume_usd: { h24: "9" }, reserve_in_usd: "100" },
        },
      ],
    };
    const fakeFetch = (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch;
    const p = new GeckoTerminalProvider("eth", "https://fake");
    const orig = globalThis.fetch;
    globalThis.fetch = fakeFetch as typeof fetch;
    try {
      const s = await p.getTokenStats("addr");
      expect(s.symbol).toBe("SAUR");
      expect(s.dexId).toBe("raydium");
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("birdeye provider parses the overview payload", async () => {
    const payload = {
      success: true,
      data: {
        address: "mint",
        symbol: "SAUR",
        name: "Saur",
        price: 0.000042,
        v24hUSD: 182000,
        liquidity: 74000,
        holder: 4892,
        buy24h: 1284,
        sell24h: 917,
        trade24h: 2201,
        priceChange24hPercent: 37,
        priceChange1hPercent: 4.2,
      },
    };
    let seenHeaders: Record<string, string> = {};
    const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      seenHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify(payload), { status: 200 });
    }) as typeof fetch;
    const p = new BirdeyeProvider("key123", "solana", "https://fake");
    const orig = globalThis.fetch;
    globalThis.fetch = fakeFetch as typeof fetch;
    try {
      const s = await p.getTokenStats("mint");
      expect(seenHeaders["X-API-KEY"]).toBe("key123");
      expect(seenHeaders["x-chain"]).toBe("solana");
      expect(s.holders).toBe(4892);
      expect(s.txns24h).toBe(2201);
      expect(s.change1hPct).toBe(4.2);
      expect(s.source).toBe("birdeye");
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("birdeye throws a clear error when the API key is missing", async () => {
    const p = new BirdeyeProvider("", "solana", "https://fake");
    await expect(p.getTokenStats("mint")).rejects.toThrow(/BIRDEYE_API_KEY/);
  });

  it("providerByName resolves every advertised provider", () => {
    for (const name of PROVIDER_NAMES) {
      expect(providerByName(name)).toBeDefined();
    }
    expect(providerByName("nope")).toBeUndefined();
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

function newEnv() {
  const dir = mkdtempSync(join(tmpdir(), "brain-raids-"));
  const db = new BrainDb(join(dir, "test.db"));
  const cleanup = () => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { db, cleanup };
}

describe("raid engine", () => {
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
    const engine = new RaidEngine(db);
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
    expect(db.getUserStats(1, 42).xp).toBe(100);
    expect(db.sumXpBetween(1, 0, Math.floor(Date.now() / 1000), "raid:", 42)).toBe(100);
    cleanup();
  });

  it("respects max participants atomically", () => {
    const { db, cleanup } = newEnv();
    const id = db.addRaid({ chat_id: 1, title: "T", platform: "x", target_url: "", objective: 0, duration_minutes: 30, xp_reward: 10, max_participants: 1, status: "active", created_by: 1, started_at: 10_000, ends_at: 20_000 });
    expect(db.joinRaidParticipant(id, 1, "a", 1, 10_001)).toBe("ok");
    expect(db.joinRaidParticipant(id, 2, "b", 1, 10_001)).toBe("full");
    expect(db.listRaidParticipants(id)).toHaveLength(1);
    cleanup();
  });

  it("enforces the raid XP cap per user and resets at the UTC day boundary", () => {
    const { db, cleanup } = newEnv();
    const dayStart = 1_735_689_600; // 2025-01-01 00:00:00 UTC
    const id = db.addRaid({ chat_id: 1, title: "T", platform: "x", target_url: "", objective: 0, duration_minutes: 60, xp_reward: 100, max_participants: null, status: "active", created_by: 1, started_at: dayStart, ends_at: dayStart + 172_800 });
    expect(db.joinRaidParticipant(id, 7, "alice", 1, dayStart + 1)).toBe("ok");
    db.recordXp(1, 7, 450, "raid:previous", dayStart + 10);

    const capped = db.checkinRaidParticipant({ raidId: id, userId: 7, expectedChatId: 1, now: dayStart + 20, cooldownSeconds: 0, maxCheckins: 6, baseXp: 100, decay: 0.5, dailyXpCap: 500 });
    expect(capped).toEqual({ status: "ok", xp: 50, totalXp: 50, checkins: 1 });
    expect(db.sumXpBetween(1, dayStart, dayStart + 86_399, "raid:", 7)).toBe(500);

    const blocked = db.checkinRaidParticipant({ raidId: id, userId: 7, expectedChatId: 1, now: dayStart + 21, cooldownSeconds: 0, maxCheckins: 6, baseXp: 100, decay: 0.5, dailyXpCap: 500 });
    expect(blocked).toEqual({ status: "daily_cap" });

    const nextDay = dayStart + 86_400;
    const next = db.checkinRaidParticipant({ raidId: id, userId: 7, expectedChatId: 1, now: nextDay, cooldownSeconds: 0, maxCheckins: 6, baseXp: 100, decay: 0.5, dailyXpCap: 500 });
    expect(next.status).toBe("ok");
    if (next.status === "ok") expect(next.xp).toBe(50);
    cleanup();
  });

  it("blocks check-ins after the raid window ends", () => {
    const { db, cleanup } = newEnv();
    const engine = new RaidEngine(db);
    const id = engine.createRaid({ chatId: 1, title: "T", platform: "x", targetUrl: "", objective: 0, durationMinutes: 1, xpReward: 10, maxParticipants: null, createdBy: 1 });
    expect(engine.join(id, 1, "a")).toBe("ok");
    // Simulate expiry by rewinding ends_at.
    db.setRaidStatus(id, "finished");
    expect(engine.checkin(id, 1).status).toBe("raid_closed");
    cleanup();
  });

  it("isolates raids by chat when using a chat-scoped engine call", () => {
    const { db, cleanup } = newEnv();
    const engine = new RaidEngine(db);
    const id = engine.createRaid({ chatId: 99, title: "Private raid", platform: "x", targetUrl: "", objective: 0, durationMinutes: 30, xpReward: 10, maxParticipants: null, createdBy: 1 });

    expect(engine.join(id, 42, "alice", 1)).toBe("raid_closed");
    expect(engine.score(id, 1)).toBeNull();
    expect(engine.finish(id, 1)).toBeNull();
    expect(db.getRaid(id)!.status).toBe("active");
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

describe("raid analytics", () => {
  it("compares the raid window against the equal-length previous window", () => {
    const { db, cleanup } = newEnv();
    const now = Math.floor(Date.now() / 1000);
    const startedAt = now - 3600; // 1h raid, just ended
    const endedAt = now;
    const raidId = db.addRaid({
      chat_id: 1, title: "Launch raid", platform: "x", target_url: "", objective: 100,
      duration_minutes: 60, xp_reward: 10, max_participants: null, status: "finished",
      created_by: 1, started_at: startedAt, ends_at: endedAt, finished_at: endedAt,
    });

    // Baseline window (the hour before): 10 messages, 2 questions, 2 users.
    for (let i = 0; i < 10; i++) db.addMessage(1, i % 2, "chat baseline", false, startedAt - 1800);
    db.addMessage(1, 0, "baseline question?", true, startedAt - 1700);
    db.addMessage(1, 1, "another baseline question?", true, startedAt - 1600);

    // Raid window: 30 messages, 6 questions, 5 users → clearly more active.
    for (let i = 0; i < 30; i++) db.addMessage(1, i % 5, "raid hype", false, startedAt + 60 * i + 15);
    for (let i = 0; i < 6; i++) db.addMessage(1, i % 5, "raid question?", true, startedAt + 60 * i + 45);

    const a = raidAnalytics(db, db.getRaid(raidId)!);
    expect(a.raid.messages).toBe(36);
    expect(a.baseline.messages).toBe(12);
    expect(a.raid.questions).toBe(6);
    expect(a.baseline.questions).toBe(2);
    expect(a.raid.activeUsers).toBe(5);
    expect(a.baseline.activeUsers).toBe(2);
    expect(a.messageDeltaPct).not.toBeNull();
    expect(a.messageDeltaPct!).toBeGreaterThan(100);
    expect(a.confusionDeltaPct).toBeCloseTo(200, 5); // 6 vs 2
    expect(a.raid.velocity).toBeGreaterThan(a.baseline.velocity);
    expect(a.completionPct).toBe(0); // objective 100, no checkins yet
    expect(a.trackedActions).toBe(0);

    const text = raidAnalyticsText(a);
    expect(text).toContain("🧠 RAID ANALYTICS");
    expect(text).toContain("confusion");
    expect(text).toContain("+200%");
    cleanup();
  });

  it("keeps zero-user velocity finite when a window has no identifiable users", () => {
    const { db, cleanup } = newEnv();
    const now = Math.floor(Date.now() / 1000);
    db.addMessage(1, null, "anonymous message", false, now - 30);
    const stats = windowStats(db, 1, now - 60, now);
    expect(stats.activeUsers).toBe(0);
    expect(stats.messages).toBe(1);
    expect(stats.velocity).toBe(0);
    expect(Number.isFinite(stats.velocity)).toBe(true);
    cleanup();
  });

  it("renders n/a deltas when there is no baseline data", () => {
    const { db, cleanup } = newEnv();
    const now = Math.floor(Date.now() / 1000);
    const raidId = db.addRaid({
      chat_id: 1, title: "Solo raid", platform: "x", target_url: "", objective: 0,
      duration_minutes: 30, xp_reward: 5, max_participants: null, status: "finished",
      created_by: 1, started_at: now - 1800, ends_at: now, finished_at: now,
    });
    db.addMessage(1, 7, "only one message during raid", false, now - 900);

    const a = raidAnalytics(db, db.getRaid(raidId)!);
    expect(a.baseline.messages).toBe(0);
    expect(a.messageDeltaPct).toBeNull();
    expect(a.confusionDeltaPct).toBeNull();
    expect(raidAnalyticsText(a)).toContain("n/a (no baseline)");
    cleanup();
  });

  it("narrative uses only provided numbers and survives AI failure", async () => {
    const now = Math.floor(Date.now() / 1000);
    const a: RaidAnalytics = {
      participants: 8, trackedActions: 40, completionPct: 80, joinRatePct: null,
      raid: { messages: 50, questions: 4, activeUsers: 8, velocity: 0.1 },
      baseline: { messages: 20, questions: 1, activeUsers: 4, velocity: 0.04 },
      messageDeltaPct: 150, confusionDeltaPct: 300, userDeltaPct: 100,
    };
    const fakeAi: AiProvider = {
      name: "fake",
      available: async () => true,
      complete: async (msgs) => {
        const user = msgs.find((m) => m.role === "user")!.content;
        expect(user).toContain("questions during raid: 4 vs 1");
        expect(user).toContain("participants: 8");
        return "Raid boosted activity; questions spiked — pin an answer via /learn.";
      },
      embed: async () => [],
    };
    const narrative = await raidAnalyticsNarrative(fakeAi, a);
    expect(narrative).toContain("/learn");

    const failingAi: AiProvider = { ...fakeAi, complete: async () => "" };
    expect(await raidAnalyticsNarrative(failingAi, a)).toBe("");
  });
});

describe("unified momentum alerts", () => {
  const baseSocial: SocialSignals = {
    messages: 80, prevMessages: 20, questions: 6, prevQuestions: 2,
    newMembers: 7, activeQuests: 1, activeRaids: 1,
  };

  it("fires message, question, member and activation signals from measured data", () => {
    const signals = socialMomentumSignals(baseSocial, DEFAULT_MOMENTUM_THRESHOLDS);
    const kinds = signals.map((s) => s.kind);
    expect(kinds).toContain("messages_surge"); // 4× baseline
    expect(kinds).toContain("questions_surge"); // 3× baseline
    expect(kinds).toContain("new_members"); // 7 ≥ 5
    expect(kinds).toContain("activation"); // raid + quest open

    const quiet = socialMomentumSignals(
      { ...baseSocial, messages: 22, questions: 2, newMembers: 1, activeQuests: 0, activeRaids: 0 },
      DEFAULT_MOMENTUM_THRESHOLDS
    );
    expect(quiet.map((s) => s.kind)).toEqual([]);
  });

  it("ignores surges when the absolute floor is not met (no noise)", () => {
    // 3 vs 1 is a 3× ratio but only 3 messages — below the 10-message floor.
    const signals = socialMomentumSignals(
      { ...baseSocial, messages: 3, prevMessages: 1, questions: 2, prevQuestions: 0, newMembers: 1, activeQuests: 0, activeRaids: 0 },
      DEFAULT_MOMENTUM_THRESHOLDS
    );
    expect(signals.map((s) => s.kind)).toEqual([]);
  });

  it("collects signals from the db: windows, joins and activation", () => {
    const { db, cleanup } = newEnv();
    const now = Math.floor(Date.now() / 1000);
    const windowSeconds = 1800;
    // Recent window: 30 messages, 4 questions. Previous window: 10 messages, 1 question.
    for (let i = 0; i < 10; i++) db.addMessage(1, i % 3, "before", false, now - windowSeconds - 100);
    db.addMessage(1, 0, "before?", true, now - windowSeconds - 90);
    for (let i = 0; i < 30; i++) db.addMessage(1, i % 4, "now", false, now - 60 * i - 30);
    for (let i = 0; i < 4; i++) db.addMessage(1, i % 4, "now?", true, now - 60 * i - 15);
    db.addMemberJoins(1, 6, now - 300);
    db.addRaid({
      chat_id: 1, title: "R", platform: "x", target_url: "", objective: 0, duration_minutes: 60,
      xp_reward: 10, max_participants: null, status: "active", created_by: 1,
      started_at: now - 600, ends_at: now + 3000,
    });

    const s = collectSocialSignals(db, 1, windowSeconds, now);
    expect(s.messages).toBe(34);
    expect(s.prevMessages).toBe(11);
    expect(s.questions).toBe(4);
    expect(s.prevQuestions).toBe(1);
    expect(s.newMembers).toBe(6);
    expect(s.activeRaids).toBe(1);
    cleanup();
  });

  it("combines market + social into one unified alert, and refuses either alone", () => {
    const signals = socialMomentumSignals(baseSocial, DEFAULT_MOMENTUM_THRESHOLDS);
    const stats = { ...baseStats };

    const unified = combineMomentum(stats, ["volume_spike"], signals);
    expect(unified).not.toBeNull();
    expect(unified!.unified).toBe(true);
    expect(unified!.text).toContain("🔔 UNIFIED MOMENTUM");
    expect(unified!.text).toContain("Market: volume_spike");
    expect(unified!.text).toContain("SAUR");
    expect(unified!.text).toContain("messages vs 20");
    expect(unified!.text).toContain("📡 Sources: market provider + captured chat data (measured)");

    // Market alone → no unified alert (the plain market alert covers it).
    expect(combineMomentum(stats, ["volume_spike"], [])).toBeNull();
    // Social alone → no unified alert.
    expect(combineMomentum(stats, [], signals)).toBeNull();
  });
});
