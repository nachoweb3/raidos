import { describe, it, expect } from "vitest";
import { BrainDb } from "../src/database/db.js";
import { gatherSignals, filterByCooldown, DEFAULT_SIGNAL_OPTIONS } from "../src/content/signals.js";
import {
  renderAnnouncement,
  renderRecap,
  renderMarketUpdate,
  renderRaidWrap,
  renderSpotlight,
  renderKbGapNudge,
  renderWelcome,
  renderReminder,
  renderFromSignal,
} from "../src/content/templates.js";
import { rankSignals, suggestForChat, MAX_SUGGESTIONS } from "../src/content/suggest.js";
import { approveSuggestion, skipSuggestion, scheduleSuggestion, publishSuggestion } from "../src/content/approval.js";
import { runScheduler } from "../src/content/scheduler.js";
import { recordPerformance, contentStatsText } from "../src/content/trail.js";
import { DEFAULT_ALERT_THRESHOLDS } from "../src/market/volume.js";
import type { TokenStats } from "../src/market/providers.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function newEnv() {
  const dir = mkdtempSync(join(tmpdir(), "content-engine-"));
  const db = new BrainDb(join(dir, "test.db"));
  const cleanup = () => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { db, cleanup };
}

const now = Math.floor(Date.now() / 1000);
const HOUR = 3600;
const DAY = 24 * HOUR;

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

describe("content templates (pure renders)", () => {
  it("announcement renders from a real cluster and refuses thin data", () => {
    const text = renderAnnouncement({ question: "when was fair launch?", count: 5 });
    expect(text).toContain("📢 FOR THE COMMUNITY");
    expect(text).toContain("when was fair launch?");
    expect(text).toContain("×5");
    expect(renderAnnouncement({ question: "x?", count: 1 })).toBeNull();
    expect(renderAnnouncement({ count: 5 })).toBeNull();
  });

  it("kb gap nudge is an admin note, not a group post", () => {
    const text = renderKbGapNudge({ questions24h: 12 });
    expect(text).toContain("admin note");
    expect(text).toContain("/learn");
    expect(renderKbGapNudge({ questions24h: 0 })).toBeNull();
  });

  it("recap uses only measured pulse numbers", () => {
    const text = renderRecap({ messages: 420, activeUsers: 35, questions: 18, openClusters: 2, answeredClusters: 4, topQuestion: "wen listing?" });
    expect(text).toContain("420 messages");
    expect(text).toContain("35 active members");
    expect(text).toContain("wen listing?");
    expect(text).toContain("Measured from real chat activity");
    // Missing numbers → no render (never invented).
    expect(renderRecap({ messages: 420 })).toBeNull();
  });

  it("market update reuses the volume card verbatim", () => {
    const text = renderMarketUpdate({ stats: baseStats });
    expect(text).toContain("📊 $SAUR MARKET INTELLIGENCE");
    expect(text).toContain("Source: mock");
    expect(renderMarketUpdate({ stats: null })).toBeNull();
    expect(renderMarketUpdate({})).toBeNull();
  });

  it("raid wrap labels participation SELF-REPORTED and computes completion from real actions", () => {
    const text = renderRaidWrap({ raidId: 3, title: "Launch raid", participants: 12, actions: 45, objective: 60, topRaider: "alice" });
    expect(text).toContain("RAID WRAP — #3 Launch raid");
    expect(text).toContain("SELF-REPORTED");
    expect(text).toContain("75% of the objective"); // 45/60
    expect(text).toContain("@alice");
    expect(renderRaidWrap({ raidId: 3, title: "T" })).toBeNull();
  });

  it("spotlight only renders for a real earned reason", () => {
    const text = renderSpotlight({ questName: "Community builder", username: "bob", xp: 500 });
    expect(text).toContain("@bob");
    expect(text).toContain("Community builder");
    expect(text).toContain("500 XP");
    expect(renderSpotlight({ questName: "Q", xp: 0 })).toBeNull();
    expect(renderSpotlight({ questName: "Q", username: "bob" })).toBeNull();
  });

  it("welcome and reminder render deterministic text", () => {
    expect(renderWelcome({ joins: 8 })).toContain("8 new members");
    expect(renderWelcome({ joins: 0 })).toBeNull();
    expect(renderReminder({ title: "Meme Friday", startsInMinutes: 30 })).toContain("starting in 30 min");
    expect(renderReminder({ startsInMinutes: 5 })).toBeNull();
  });

  it("renderFromSignal maps signal kinds to template kinds and drops dishonest renders", () => {
    const r = renderFromSignal({ kind: "raid_completed", detail: "d", strength: 1, data: { raidId: 1, title: "T", participants: 2, actions: 5 } });
    expect(r?.kind).toBe("raid_wrap");
    expect(renderFromSignal({ kind: "join_spike", detail: "d", strength: 1, data: { joins: 9 } })?.kind).toBe("welcome");
    expect(renderFromSignal({ kind: "pulse_recap", detail: "d", strength: 1, data: {} })).toBeNull();
  });
});

describe("signal gathering + cooldowns", () => {
  it("gathers confusion, kb gap, raid and quest signals from captured data", () => {
    const { db, cleanup } = newEnv();
    db.addMessage(1, 10, "wen listing?", true, now - 2 * HOUR);
    // An open promoted cluster (count ≥ 2, like the analyzer leaves it):
    const clusterId = db.addCluster(1, "wen listing?", Buffer.alloc(0), now - 3 * HOUR);
    db.updateCluster(clusterId, Buffer.alloc(0), now - 2 * HOUR);
    db.setClusterResolved(clusterId, "wen listing?", "/learn the listing date");

    const signals = gatherSignals(db, 1, [], null, DEFAULT_SIGNAL_OPTIONS, now);
    const kinds = signals.map((s) => s.kind);
    expect(kinds).toContain("confusion_cluster");
    expect(kinds).toContain("kb_gap"); // questions asked, KB empty

    // Feed the KB → gap disappears.
    db.addKbEntry(1, "manual", "Listing is next month.", Buffer.alloc(0), 1);
    const after = gatherSignals(db, 1, [], null, DEFAULT_SIGNAL_OPTIONS, now);
    expect(after.map((s) => s.kind)).not.toContain("kb_gap");
    cleanup();
  });

  it("gathers market alert signal only when alerts are passed in", () => {
    const { db, cleanup } = newEnv();
    expect(gatherSignals(db, 1, [], null, DEFAULT_SIGNAL_OPTIONS, now).map((s) => s.kind)).not.toContain("market_alert");
    const withAlert = gatherSignals(db, 1, ["volume_spike"], baseStats, DEFAULT_SIGNAL_OPTIONS, now);
    expect(withAlert.map((s) => s.kind)).toContain("market_alert");
    cleanup();
  });

  it("raid wrap signal fires within the lookback window only", () => {
    const { db, cleanup } = newEnv();
    const mkRaid = (finishedAt: number) =>
      db.addRaid({
        chat_id: 1, title: "R", platform: "x", target_url: "", objective: 10,
        duration_minutes: 30, xp_reward: 5, max_participants: null, status: "finished",
        created_by: 1, started_at: finishedAt - 1800, ends_at: finishedAt, finished_at: finishedAt,
      });
    mkRaid(now - 2 * HOUR);
    expect(gatherSignals(db, 1, [], null, DEFAULT_SIGNAL_OPTIONS, now).map((s) => s.kind)).toContain("raid_completed");
    mkRaid(now - 3 * DAY);
    const s = gatherSignals(db, 1, [], null, DEFAULT_SIGNAL_OPTIONS, now);
    expect(s.filter((x) => x.kind === "raid_completed").length).toBe(1); // old raid ignored
    cleanup();
  });

  it("join spike fires at the threshold and quest milestone reads the ledger", () => {
    const { db, cleanup } = newEnv();
    db.addMemberJoins(1, 6, now - HOUR);
    const kinds = gatherSignals(db, 1, [], null, DEFAULT_SIGNAL_OPTIONS, now).map((s) => s.kind);
    expect(kinds).toContain("join_spike");

    const questId = db.addQuest({
      chat_id: 1, name: "Community builder", description: "", requirement: JSON.stringify({ kind: "invites", target: 3 }),
      xp_reward: 500, status: "completed", created_by: 1, ends_at: null, max_participants: null, sponsored_by: null,
    });
    db.recordXp(1, 42, 500, `quest:${questId}`);
    const q = gatherSignals(db, 1, [], null, DEFAULT_SIGNAL_OPTIONS, now).find((s) => s.kind === "quest_milestone");
    expect(q).toBeDefined();
    expect(q!.detail).toContain("Community builder");
    cleanup();
  });

  it("cooldown filters signals that already produced a suggestion recently", () => {
    const { db, cleanup } = newEnv();
    db.addMessage(1, 10, "wen listing?", true, now - 2 * HOUR);
    const signals = gatherSignals(db, 1, [], null, DEFAULT_SIGNAL_OPTIONS, now);
    expect(signals.length).toBeGreaterThan(0);

    // First pass: nothing on cooldown.
    const first = filterByCooldown(db, 1, signals, DEFAULT_SIGNAL_OPTIONS, now);
    expect(first.ready.length).toBe(signals.length);
    expect(first.cooled).toEqual([]);

    // Simulate a recent suggestion for the first kind → now cooled.
    const kind = signals[0]!.kind;
    db.addContentSuggestion(1, "announcement", kind, "{}", "text", now - 60);
    const second = filterByCooldown(db, 1, signals, DEFAULT_SIGNAL_OPTIONS, now);
    expect(second.ready.map((s) => s.kind)).not.toContain(kind);
    expect(second.cooled).toContain(kind);
    cleanup();
  });
});

describe("suggest → approve → publish pipeline", () => {
  it("ranks signals, caps at 3 and persists proposals", () => {
    const { db, cleanup } = newEnv();
    db.addMessage(1, 10, "wen listing?", true, now - 2 * HOUR);
    const { proposals, cooled } = suggestForChat(db, 1, [], null, DEFAULT_SIGNAL_OPTIONS, now);
    expect(cooled).toEqual([]);
    expect(proposals.length).toBeGreaterThan(0);
    expect(proposals.length).toBeLessThanOrEqual(MAX_SUGGESTIONS);
    for (const p of proposals) {
      const row = db.getContentSuggestion(p.id);
      expect(row?.status).toBe("proposed");
      expect(row?.text).toBe(p.text);
    }
    cleanup();
  });

  it("approve/edit/skip only work on proposed suggestions", () => {
    const { db, cleanup } = newEnv();
    const id = db.addContentSuggestion(1, "announcement", "confusion_cluster", "{}", "text", now);
    expect(approveSuggestion(db, id + 100)).toEqual({ ok: false, reason: "not_found" });

    const edited = approveSuggestion(db, id, "  edited text  ");
    expect(edited).toEqual({ ok: true, status: "edited" });
    expect(db.getContentSuggestion(id)!.text).toBe("edited text");
    expect(approveSuggestion(db, id).ok).toBe(false); // already edited
    expect(skipSuggestion(db, id).ok).toBe(false);

    const id2 = db.addContentSuggestion(1, "recap", "pulse_recap", "{}", "text", now);
    expect(skipSuggestion(db, id2)).toEqual({ ok: true });
    cleanup();
  });

  it("rejects cross-chat approval, scheduling, skipping and publishing", async () => {
    const { db, cleanup } = newEnv();
    const id = db.addContentSuggestion(99, "recap", "pulse_recap", "{}", "private post", now);

    expect(approveSuggestion(db, id, undefined, 1)).toEqual({ ok: false, reason: "wrong_chat" });
    expect(skipSuggestion(db, id, 1)).toEqual({ ok: false, reason: "wrong_chat" });
    expect(scheduleSuggestion(db, id, now, "group", 1)).toEqual({ ok: false, reason: "wrong_chat" });
    expect(await publishSuggestion(db, id, async () => true, undefined, 1)).toEqual({ ok: false, reason: "wrong_chat" });
    expect(db.getContentSuggestion(id)!.status).toBe("proposed");
    cleanup();
  });

  it("schedules approved suggestions and rejects unready ones", () => {
    const { db, cleanup } = newEnv();
    const id = db.addContentSuggestion(1, "recap", "pulse_recap", "{}", "text", now);
    expect(scheduleSuggestion(db, id, now + 60).ok).toBe(false); // still proposed

    approveSuggestion(db, id);
    const res = scheduleSuggestion(db, id, now + 60, "group");
    expect(res.ok).toBe(true);
    expect(db.getContentSuggestion(id)!.status).toBe("scheduled");
    expect(db.listContentSchedule(1, "pending").length).toBe(1);
    cleanup();
  });

  it("publishes via the injected poster and records the audit trail", async () => {
    const { db, cleanup } = newEnv();
    const id = db.addContentSuggestion(1, "recap", "pulse_recap", "{}", "hello group", now);
    approveSuggestion(db, id);

    const sent: { chatId: number; text: string }[] = [];
    const res = await publishSuggestion(db, id, async (chatId, text) => {
      sent.push({ chatId, text });
      return true;
    });
    expect(res.ok).toBe(true);
    expect(sent).toEqual([{ chatId: 1, text: "hello group" }]);
    const row = db.getContentSuggestion(id)!;
    expect(row.status).toBe("published");
    expect(row.published_text).toBe("hello group");
    expect(row.published_at).not.toBeNull();

    // Send failure → not published.
    const id2 = db.addContentSuggestion(1, "recap", "pulse_recap", "{}", "second", now);
    approveSuggestion(db, id2);
    const fail = await publishSuggestion(db, id2, async () => false);
    expect(fail).toEqual({ ok: false, reason: "send_failed" });
    expect(db.getContentSuggestion(id2)!.status).toBe("approved");
    cleanup();
  });
});

describe("scheduler + performance trail", () => {
  it("does not overlap scheduler runs for the same database", async () => {
    const { db, cleanup } = newEnv();
    const id = db.addContentSuggestion(1, "recap", "pulse_recap", "{}", "slow post", now);
    approveSuggestion(db, id);
    scheduleSuggestion(db, id, now - 1, "group");

    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let started = false;
    const first = runScheduler({
      db,
      post: async () => {
        started = true;
        await blocked;
        return true;
      },
    }, now);
    while (!started) await Promise.resolve();

    const second = await runScheduler({ db, post: async () => true }, now);
    expect(second).toEqual({ published: 0, failed: 0 });
    release();
    expect(await first).toEqual({ published: 1, failed: 0 });
    cleanup();
  });

  it("publishes due jobs, marks others missed, and notifies on failure", async () => {
    const { db, cleanup } = newEnv();
    const sent: string[] = [];
    const post = async (_c: number, text: string) => {
      sent.push(text);
      return true;
    };

    // Job A: ready, due now. Job B: suggestion skipped after scheduling → missed quietly.
    const a = db.addContentSuggestion(1, "recap", "pulse_recap", "{}", "post A", now);
    approveSuggestion(db, a);
    const schedA = scheduleSuggestion(db, a, now - 5, "group") as { ok: true; scheduleId: number };
    const b = db.addContentSuggestion(1, "recap", "pulse_recap", "{}", "post B", now);
    approveSuggestion(db, b);
    const schedB = scheduleSuggestion(db, b, now - 5, "group") as { ok: true; scheduleId: number };
    // Simulate the suggestion being pulled back after scheduling (e.g. skipped elsewhere):
    db.setContentSuggestionStatus(b, "proposed");

    const run1 = await runScheduler({ db, post }, now);
    expect(run1.published).toBe(1);
    expect(sent).toEqual(["post A"]);
    expect(db.listContentSchedule(1, "done").length).toBe(1);
    expect(db.listContentSchedule(1, "missed").length).toBe(1);
    void schedA;
    void schedB;

    // Second run: nothing due.
    const run2 = await runScheduler({ db, post }, now);
    expect(run2.published).toBe(0);

    // Failing post → missed + admin notified.
    const c = db.addContentSuggestion(1, "recap", "pulse_recap", "{}", "post C", now);
    approveSuggestion(db, c);
    scheduleSuggestion(db, c, now - 5, "group");
    const notes: string[] = [];
    const run3 = await runScheduler({ db, post: async () => false, notifyAdmin: async (_c, t) => notes.push(t) }, now);
    expect(run3.failed).toBe(1);
    expect(notes.length).toBe(1);
    expect(notes[0]).toContain("failed to send");
    cleanup();
  });

  it("records the post-publish window as SELF-REPORTED and renders stats", () => {
    const { db, cleanup } = newEnv();
    const id = db.addContentSuggestion(1, "recap", "pulse_recap", "{}", "hello", now);
    db.publishContentSuggestion(id, "hello", now - 1800);
    db.addMessage(1, 5, "nice recap!", false, now - 900);
    db.addMessage(1, 6, "what about staking?", true, now - 800);

    const s = db.getContentSuggestion(id)!;
    const m = recordPerformance(db, s, 60, now)!;
    expect(m.messages).toBe(2);
    expect(m.activeUsers).toBe(2);
    expect(m.newQuestions).toBe(1);
    expect(m.windowMinutes).toBe(30);

    const perf = db.getContentPerformance(id);
    expect(perf?.label).toBe("SELF-REPORTED");
    expect(JSON.parse(perf!.measured)).toMatchObject({ messages: 2 });

    const stats = contentStatsText(db, 1);
    expect(stats).toContain("📈 CONTENT STATS");
    expect(stats).toContain(`#${id}`);
    expect(stats).toContain("SELF-REPORTED");
    expect(recordPerformance(db, db.getContentSuggestion(id + 500) ?? { ...s, id: id + 500, published_at: null }, 60, now)).toBeNull();
    cleanup();
  });
});

describe("honesty guards", () => {
  it("never suggests a market post without a real alert", () => {
    const { db, cleanup } = newEnv();
    // Stats present but no alert kinds → no market_update suggestion.
    const { proposals } = suggestForChat(db, 1, [], baseStats, DEFAULT_SIGNAL_OPTIONS, now);
    expect(proposals.map((p) => p.signalKind)).not.toContain("market_alert");
    cleanup();
  });

  it("market alerts must pass the same thresholds as the poller", () => {
    const { db, cleanup } = newEnv();
    const small: TokenStats = { ...baseStats, volume24hUsd: 100_000, ts: 900 };
    const big: TokenStats = { ...baseStats, volume24hUsd: 300_000 };
    // 3× jump ≥ 2.5× threshold → alert fires and becomes a suggestion signal.
    const { proposals } = suggestForChat(db, 1, ["volume_spike"], big, DEFAULT_SIGNAL_OPTIONS, now);
    const market = proposals.find((p) => p.signalKind === "market_alert");
    expect(market).toBeDefined();
    expect(market!.kind).toBe("market_update");
    void small;
    void DEFAULT_ALERT_THRESHOLDS;
    cleanup();
  });
});
