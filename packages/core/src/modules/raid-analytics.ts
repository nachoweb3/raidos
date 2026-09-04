import type { BrainDb, RaidRow } from "../database/db.js";
import type { AiProvider } from "../ai/provider.js";
import { raidScore } from "./raids.js";

/**
 * ⚡ RAID ANALYTICS — post-raid intelligence
 * Compares the raid window against the equal-length window right before it.
 * Every number is measured from real captured data — the AI never invents
 * metrics, it only narrates them (same rule as Community Pulse).
 */

export interface RaidWindowStats {
  messages: number;
  questions: number;
  activeUsers: number;
  /** Messages per active user per minute. */
  velocity: number;
}

export interface RaidAnalytics {
  participants: number;
  trackedActions: number;
  completionPct: number | null;
  joinRatePct: number | null;
  raid: RaidWindowStats;
  baseline: RaidWindowStats;
  /** (raid − baseline) / baseline, as a fraction (null when baseline is 0). */
  messageDeltaPct: number | null;
  /** Same, for questions ("confusion delta"). */
  confusionDeltaPct: number | null;
  userDeltaPct: number | null;
}

/** Pure window statistics from captured messages. */
export function windowStats(db: BrainDb, chatId: number, sinceTs: number, untilTs: number): RaidWindowStats {
  const minutes = Math.max(1, (untilTs - sinceTs) / 60);
  const messages = db.countMessages(chatId, sinceTs, untilTs);
  const users = db.distinctActiveUsers(chatId, sinceTs, untilTs);
  return {
    messages,
    questions: db.countQuestionsBetween(chatId, sinceTs, untilTs),
    activeUsers: users,
    // No captured user means no measurable per-user rate, not Infinity.
    velocity: users > 0 ? messages / users / minutes : 0,
  };
}

function pctDelta(now: number, base: number): number | null {
  if (base === 0) return null;
  return ((now - base) / base) * 100;
}

/**
 * Full post-raid analytics. The baseline window is the equal-length window
 * immediately before the raid started — a like-for-like comparison that
 * needs no history and no assumptions.
 */
export function raidAnalytics(db: BrainDb, raid: RaidRow): RaidAnalytics {
  const parts = db.listRaidParticipants(raid.id);
  const trackedActions = parts.reduce((a, p) => a + p.checkins, 0);
  const score = raidScore(raid, parts.length, trackedActions, raid.finished_at ?? raid.ends_at);
  const joinRate = raid.max_participants && raid.max_participants > 0 ? (parts.length / raid.max_participants) * 100 : null;

  const raidStats = windowStats(db, raid.chat_id, raid.started_at, raid.finished_at ?? raid.ends_at);
  const span = raid.finished_at ?? raid.ends_at;
  const baselineStats = windowStats(db, raid.chat_id, raid.started_at - (span - raid.started_at), raid.started_at);

  return {
    participants: parts.length,
    trackedActions,
    completionPct: score.completionPct,
    joinRatePct: joinRate,
    raid: raidStats,
    baseline: baselineStats,
    messageDeltaPct: pctDelta(raidStats.messages, baselineStats.messages),
    confusionDeltaPct: pctDelta(raidStats.questions, baselineStats.questions),
    userDeltaPct: pctDelta(raidStats.activeUsers, baselineStats.activeUsers),
  };
}

function fmtDelta(pct: number | null): string {
  if (pct === null) return "n/a (no baseline)";
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%`;
}

function bar(pct: number | null, width = 10): string {
  if (pct === null) return "░".repeat(width);
  return "█".repeat(Math.max(0, Math.min(width, Math.round((pct / 100) * width)))).padEnd(width, "░");
}

export function raidAnalyticsText(a: RaidAnalytics): string {
  return [
    "🧠 RAID ANALYTICS",
    "━━━━━━━━━━━━━━━━━━━",
    `👥 Participants: ${a.participants}${a.joinRatePct !== null ? ` (${a.joinRatePct.toFixed(0)}% of cap)` : ""}`,
    `⚡ Tracked actions: ${a.trackedActions}${a.completionPct !== null ? ` — completion ${bar(a.completionPct)} ${a.completionPct.toFixed(0)}%` : ""}`,
    "",
    `💬 Messages vs previous window: ${a.raid.messages} vs ${a.baseline.messages} (${fmtDelta(a.messageDeltaPct)})`,
    `❓ Questions (confusion): ${a.raid.questions} vs ${a.baseline.questions} (${fmtDelta(a.confusionDeltaPct)})`,
    `🙋 Active members: ${a.raid.activeUsers} vs ${a.baseline.activeUsers} (${fmtDelta(a.userDeltaPct)})`,
    `⏱ Message velocity: ${a.raid.velocity.toFixed(2)}/user/min (baseline ${a.baseline.velocity.toFixed(2)})`,
  ].join("\n");
}

/**
 * One LLM call that narrates the measured post-raid numbers.
 * The model may only use the numbers provided — it never invents metrics.
 * Returns "" on any AI failure; the deterministic report stands alone.
 */
export async function raidAnalyticsNarrative(ai: AiProvider, a: RaidAnalytics): Promise<string> {
  const out = await ai.complete(
    [
      {
        role: "system",
        content:
          "You are the Community Brain. Write ONE sentence (max 25 words) interpreting this post-raid report. Direct, no hype, no invented numbers. Use only the numbers provided. If confusion rose, suggest one concrete admin action (e.g. /learn a fact).",
      },
      {
        role: "user",
        content: [
          `raid participants: ${a.participants}, tracked actions: ${a.trackedActions}`,
          a.completionPct !== null ? `objective completion: ${a.completionPct.toFixed(0)}%` : "no numeric objective set",
          `messages during raid: ${a.raid.messages} vs ${a.baseline.messages} before (${fmtDelta(a.messageDeltaPct)})`,
          `questions during raid: ${a.raid.questions} vs ${a.baseline.questions} before (${fmtDelta(a.confusionDeltaPct)})`,
          `active members: ${a.raid.activeUsers} vs ${a.baseline.activeUsers} before (${fmtDelta(a.userDeltaPct)})`,
        ].join("\n"),
      },
    ],
    { temperature: 0.3, maxTokens: 80, timeoutMs: 20_000 }
  );
  return out.trim();
}
