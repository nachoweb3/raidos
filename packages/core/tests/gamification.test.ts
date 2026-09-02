import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainDb } from "../src/database/db.js";
import { XpEngine, levelFromXp, grantFor, DEFAULT_XP_CONFIG } from "../src/modules/xp.js";
import { QuestEngine, parseRequirement, questIsOpen, questIsExpired, nextProgress } from "../src/modules/quests.js";
import type { QuestRequirement } from "../src/modules/quests.js";
import { MemeEngine } from "../src/modules/memes.js";
import { topUsers, leaderboardText } from "../src/modules/leaderboard.js";
import { BadgeEngine, BADGES } from "../src/modules/badges.js";

function newEnv() {
  const dir = mkdtempSync(join(tmpdir(), "brain-gamif-"));
  const db = new BrainDb(join(dir, "test.db"));
  const cleanup = () => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { db, cleanup };
}

describe("XP engine", () => {
  it("levels follow the sqrt curve", () => {
    expect(levelFromXp(0)).toBe(1);
    expect(levelFromXp(39)).toBe(1);
    expect(levelFromXp(40)).toBe(2);
    expect(levelFromXp(159)).toBe(2);
    expect(levelFromXp(160)).toBe(3);
    expect(levelFromXp(360)).toBe(4);
  });

  it("grantFor rewards questions more than plain messages and skips noise", () => {
    expect(grantFor("gm frens", false, DEFAULT_XP_CONFIG).xp).toBe(2);
    expect(grantFor("when launch?", true, DEFAULT_XP_CONFIG).xp).toBe(3);
    expect(grantFor("x", false, DEFAULT_XP_CONFIG).xp).toBe(0);
    expect(grantFor("", false, DEFAULT_XP_CONFIG).xp).toBe(0);
  });

  it("accumulates XP and keeps a same-day streak at 1", () => {
    const { db, cleanup } = newEnv();
    const engine = new XpEngine(db);
    expect(engine.getStats(1, 42).xp).toBe(0);
    engine.recordMessage(1, 42, "hello world", false);
    engine.recordMessage(1, 42, "when launch?", true);
    const st = engine.getStats(1, 42);
    expect(st.xp).toBe(5);
    expect(st.streak).toBe(1);
    expect(st.level).toBe(1);
    cleanup();
  });
});

describe("quest engine", () => {
  it("parses valid requirements and rejects garbage", () => {
    const ok = parseRequirement('{"kind":"messages","target":5}');
    expect(ok).not.toBeNull();
    expect(ok!.kind).toBe("messages");
    expect(ok!.target).toBe(5);
    expect(parseRequirement('{"kind":"messages"}')).toBeNull();
    expect(parseRequirement('{"kind":"teleport","target":5}')).toBeNull();
    expect(parseRequirement("not json")).toBeNull();
  });

  it("nextProgress only advances for the matching event kind", () => {
    const req: QuestRequirement = { kind: "messages", target: 5 };
    expect(nextProgress(0, req, "messages")).toBe(1);
    expect(nextProgress(1, req, "reactions")).toBe(1);
  });

  it("quests open until their deadline", () => {
    const now = 1_000_000;
    const q = {
      id: 1,
      chat_id: 1,
      name: "Talk",
      description: "",
      requirement: '{"kind":"messages","target":3}',
      xp_reward: 10,
      status: "active" as const,
      created_by: 1,
      ends_at: now + 3600,
      max_participants: null,
      sponsored_by: null,
      created_at: now,
    };
    expect(questIsOpen(q, now)).toBe(true);
    expect(questIsExpired(q, now + 7200)).toBe(true);
    expect(questIsOpen({ ...q, status: "completed" }, now)).toBe(false);
  });

  it("completes a quest when the target is reached and grants XP", () => {
    const { db, cleanup } = newEnv();
    const xpEngine = new XpEngine(db);
    const quests = new QuestEngine(db, (chatId, userId, xp) => xpEngine.grantXp(chatId, userId, xp, "quest"));
    const id = quests.createQuest(
      1,
      { name: "Chatterbox", requirement: { kind: "messages", target: 3 }, xpReward: 10 },
      99
    );
    for (let i = 0; i < 2; i++) {
      expect(quests.recordEvent(1, 42, "messages")).toEqual([]);
      expect(quests.progressLine(db.getQuest(id)!, 42)).toContain(`${i + 1}/3`);
    }
    expect(quests.recordEvent(1, 42, "messages")).toEqual(["Chatterbox"]);
    expect(db.getQuest(id)!.status).toBe("completed");
    expect(xpEngine.getStats(1, 42).xp).toBe(10);
    cleanup();
  });

  it("caps participation with maxParticipants", () => {
    const { db, cleanup } = newEnv();
    const xpEngine = new XpEngine(db);
    const quests = new QuestEngine(db, (chatId, userId, xp) => xpEngine.grantXp(chatId, userId, xp, "quest"));
    quests.createQuest(1, { name: "Firsties", requirement: { kind: "invites", target: 1 }, xpReward: 5, maxParticipants: 1 }, 99);
    quests.recordEvent(1, 100, "invites");
    quests.recordEvent(1, 101, "invites"); // slot already taken
    expect(xpEngine.getStats(1, 101).xp).toBe(0);
    cleanup();
  });
});

describe("meme contests", () => {
  it("runs a full contest: open → submit → vote → finish with XP reward", () => {
    const { db, cleanup } = newEnv();
    const xpEngine = new XpEngine(db);
    const memes = new MemeEngine(db, (chatId, userId, xp) => xpEngine.grantXp(chatId, userId, xp, "meme"));
    const contestId = memes.openContest(1, "Best meme of the month");
    expect(db.getMemeContest(contestId)!.status).toBe("submissions");

    const alice = memes.submit(contestId, 100, "alice", "cat with a monacle");
    const bob = memes.submit(contestId, 101, "bob", "dog on a skateboard");
    expect(alice).not.toBeNull();
    expect(bob).not.toBeNull();
    expect(memes.listSubmissions(contestId).length).toBe(2);

    // No voting until the contest moves to voting phase.
    expect(memes.vote(contestId, 102, alice!)).toBe("not_open");

    expect(memes.toVoting(contestId)).toBe(true);
    // Can't vote for your own meme.
    expect(memes.vote(contestId, 100, alice!)).toBe("own_meme");
    expect(memes.vote(contestId, 102, alice!)).toBe("ok");
    expect(memes.vote(contestId, 103, alice!)).toBe("ok");
    expect(memes.vote(contestId, 104, alice!)).toBe("ok");
    // One vote per user per contest.
    expect(memes.vote(contestId, 102, bob!)).toBe("already");

    const winner = memes.finishContest(contestId);
    expect(winner).not.toBeNull();
    expect(winner!.username).toBe("alice");
    expect(winner!.votes).toBe(3);
    expect(db.getMemeContest(contestId)!.status).toBe("finished");
    // Winner gets the contest XP reward (0 by default here).
    expect(db.topMemeSubmission(contestId)!.id).toBe(alice);
    cleanup();
  });

  it("finishes without a winner when there are no submissions", () => {
    const { db, cleanup } = newEnv();
    const memes = new MemeEngine(db, () => {});
    const id = memes.openContest(1, "Empty contest");
    expect(memes.finishContest(id)).toEqual({ username: null, userId: null, votes: 0, submissionId: 0 });
    cleanup();
  });

  it("rejects submissions once voting has started", () => {
    const { db, cleanup } = newEnv();
    const memes = new MemeEngine(db, () => {});
    const id = memes.openContest(1, "Quick contest");
    memes.toVoting(id);
    expect(memes.submit(id, 100, "alice", "late entry")).toBeNull();
    cleanup();
  });
});

describe("leaderboard", () => {
  it("ranks users by XP and renders text with medals", () => {
    const { db, cleanup } = newEnv();
    const xpEngine = new XpEngine(db);
    xpEngine.grantXp(1, 100, 60, "message");
    xpEngine.grantXp(1, 101, 20, "message");
    xpEngine.grantXp(1, 102, 90, "message");
    db.setXpUsername(1, 100, "trent");
    db.setXpUsername(1, 101, "bob");
    db.setXpUsername(1, 102, "alice");

    const board = topUsers(db, 1, 10);
    expect(board.map((e) => e.username)).toEqual(["alice", "trent", "bob"]);
    expect(board[0]!.rank).toBe(1);
    expect(board[0]!.level).toBe(2); // 90 XP → level 2
    const text = leaderboardText(board);
    expect(text).toContain("🥇 alice — 90 XP · Lvl 2");
    expect(text).toContain("🥈 trent — 60 XP");
    expect(text).toContain("🥉 bob — 20 XP");
    cleanup();
  });

  it("shows an empty state", () => {
    expect(leaderboardText([])).toContain("No XP recorded yet");
  });
});

describe("recognition badges", () => {
  it("awards level badges as members level up", () => {
    const { db, cleanup } = newEnv();
    const engine = new BadgeEngine(db);
    expect(engine.checkMilestones(1, 42, { xp: 0, level: 1, streak: 0 })).toEqual([]);

    const first = engine.checkMilestones(1, 42, { xp: 40, level: 2, streak: 0 });
    expect(first.map((b) => b.code)).toEqual(["first_words"]);

    // Idempotent: re-check at same stats awards nothing new.
    expect(engine.checkMilestones(1, 42, { xp: 40, level: 2, streak: 0 })).toEqual([]);
    cleanup();
  });

  it("awards streak, xp and multi-level milestones together", () => {
    const { db, cleanup } = newEnv();
    const engine = new BadgeEngine(db);
    const codes = engine.checkMilestones(1, 42, { xp: 600, level: 4, streak: 8 }).map((b) => b.code);
    expect(codes).toEqual(expect.arrayContaining(["first_words", "regular", "helper", "streak_7", "xp_500"]));
    expect(codes).not.toContain("legend");
    expect(codes).not.toContain("streak_30");
    expect(codes).not.toContain("xp_2500");
    cleanup();
  });

  it("supports manual grants and dedupes them", () => {
    const { db, cleanup } = newEnv();
    const engine = new BadgeEngine(db);
    expect(engine.grant(1, 42, "streak_30")?.code).toBe("streak_30");
    expect(engine.grant(1, 42, "streak_30")).toBeNull(); // already held
    expect(engine.grant(1, 42, "nope")).toBeNull(); // unknown code
    // A held badge is never re-awarded by milestone checks.
    const codes = engine.checkMilestones(1, 42, { xp: 99999, level: 8, streak: 60 }).map((b) => b.code);
    expect(codes).not.toContain("streak_30");
    expect(engine.list(1, 42)).toContain("streak_30");
    cleanup();
  });

  it("renders locked and earned badges", () => {
    const { db, cleanup } = newEnv();
    const engine = new BadgeEngine(db);
    expect(engine.render(1, 42)).toContain("No badges yet");
    expect(engine.render(1, 42)).toContain("🔒 Regular");
    engine.grant(1, 42, "regular");
    const text = engine.render(1, 42);
    expect(text).toContain("🏅 1 badge earned");
    expect(text).toContain("💬 Regular");
    expect(text).toContain("🔒 Legend");
    cleanup();
  });

  it("levels driven by XP unlock badges through the xp engine", () => {
    const { db, cleanup } = newEnv();
    const xpEngine = new XpEngine(db);
    const badges = new BadgeEngine(db);
    xpEngine.grantXp(1, 42, 90, "message");
    const newly = badges.checkMilestones(1, 42, xpEngine.getStats(1, 42));
    expect(newly.map((b) => b.code)).toEqual(["first_words"]); // 90 XP → level 2
    cleanup();
  });
});