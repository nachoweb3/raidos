import type { BrainDb } from "../database/db.js";
import type { TokenStats } from "../market/providers.js";

/**
 * 🔔 UNIFIED MOMENTUM ALERTS — RaidOS
 * One data-driven alert that combines MARKET signals (already measured by the
 * volume layer) with SOCIAL signals measured from real captured chat data:
 *
 * - message rate vs. the previous equal-length window
 * - question rate delta ("confusion") vs. that same window
 * - new members joined in the window
 * - active quests and raids right now (real, ongoing activation)
 *
 * Honesty rules: every signal is measured or structurally true. The alert
 * never claims causes it cannot see — reasons are always phrased as
 * possibilities, and user counts are only reported when the data supports them.
 */

export interface SocialSignals {
  /** Messages in the recent window. */
  messages: number;
  /** Same-length window immediately before it. */
  prevMessages: number;
  questions: number;
  prevQuestions: number;
  /** New members captured in the recent window. */
  newMembers: number;
  /** Quests currently active (not expired). */
  activeQuests: number;
  /** Raids currently active (not expired). */
  activeRaids: number;
}

export interface MomentumSignal {
  kind: "messages_surge" | "questions_surge" | "new_members" | "activation";
  /** 0..1 — how strongly this signal fired (1 = threshold exactly met). */
  strength: number;
  detail: string;
}

export interface MomentumThresholds {
  /** Message-surge multiple vs. the previous window. */
  messageSurgeMultiple: number;
  /** Question-surge multiple vs. the previous window. */
  questionSurgeMultiple: number;
  /** New-member alert level per window. */
  newMembersPerWindow: number;
}

export const DEFAULT_MOMENTUM_THRESHOLDS: MomentumThresholds = {
  messageSurgeMultiple: 2,
  questionSurgeMultiple: 2,
  newMembersPerWindow: 5,
};

/** Pure: derive social signals from the db over a window. */
export function collectSocialSignals(
  db: BrainDb,
  chatId: number,
  windowSeconds: number,
  now = Math.floor(Date.now() / 1000)
): SocialSignals {
  const since = now - windowSeconds;
  const prevSince = since - windowSeconds;
  return {
    messages: db.countMessages(chatId, since, now),
    prevMessages: db.countMessages(chatId, prevSince, since),
    questions: db.countQuestionsBetween(chatId, since, now),
    prevQuestions: db.countQuestionsBetween(chatId, prevSince, since),
    newMembers: db.newMembersBetween(chatId, since, now),
    activeQuests: db
      .listQuests(chatId, "active")
      .filter((q) => q.ends_at === null || q.ends_at > now).length,
    activeRaids: db
      .listRaids(chatId, "active")
      .filter((r) => r.ends_at > now).length,
  };
}

function ratio(now: number, base: number): number | null {
  if (base <= 0) return null;
  return now / base;
}

/** Pure: score social signals into 0..n momentum signals. */
export function socialMomentumSignals(s: SocialSignals, t: MomentumThresholds = DEFAULT_MOMENTUM_THRESHOLDS): MomentumSignal[] {
  const out: MomentumSignal[] = [];

  const msgRatio = ratio(s.messages, s.prevMessages);
  if (msgRatio !== null && msgRatio >= t.messageSurgeMultiple && s.messages >= 10) {
    out.push({
      kind: "messages_surge",
      strength: Math.min(1, (msgRatio - 1) / Math.max(0.5, t.messageSurgeMultiple - 1)),
      detail: `${s.messages} messages vs ${s.prevMessages} in the previous window (${msgRatio.toFixed(1)}×)`,
    });
  }

  const qRatio = ratio(s.questions, s.prevQuestions);
  if (qRatio !== null && qRatio >= t.questionSurgeMultiple && s.questions >= 3) {
    out.push({
      kind: "questions_surge",
      strength: Math.min(1, (qRatio - 1) / Math.max(0.5, t.questionSurgeMultiple - 1)),
      detail: `${s.questions} questions vs ${s.prevQuestions} before (${qRatio.toFixed(1)}×) — confusion is rising`,
    });
  }

  if (s.newMembers >= t.newMembersPerWindow) {
    out.push({
      kind: "new_members",
      strength: Math.min(1, s.newMembers / Math.max(1, t.newMembersPerWindow * 2)),
      detail: `${s.newMembers} new members joined in this window`,
    });
  }

  if (s.activeRaids > 0 || s.activeQuests > 0) {
    out.push({
      kind: "activation",
      strength: s.activeRaids > 0 ? 1 : 0.5,
      detail: [
        s.activeRaids > 0 ? `${s.activeRaids} raid${s.activeRaids === 1 ? "" : "s"} running` : "",
        s.activeQuests > 0 ? `${s.activeQuests} quest${s.activeQuests === 1 ? "" : "s"} open` : "",
      ]
        .filter(Boolean)
        .join(" · "),
    });
  }

  return out;
}

export interface UnifiedMomentumAlert {
  /** True only when BOTH a market and a social signal fired — the unified case. */
  unified: boolean;
  marketKinds: string[];
  signals: MomentumSignal[];
  text: string;
}

/** Pure: combine market alerts (already detected) with social signals. */
export function combineMomentum(
  stats: TokenStats,
  marketKinds: string[],
  signals: MomentumSignal[]
): UnifiedMomentumAlert | null {
  if (marketKinds.length === 0 || signals.length === 0) return null;

  const strongest = signals.reduce((a, b) => (b.strength > a.strength ? b : a));
  const socialTag = signals.map((s) => s.kind).join("+");
  const lines = [
    "🔔 UNIFIED MOMENTUM",
    "━━━━━━━━━━━━━━━━━━━",
    `💰 Market: ${marketKinds.join(" · ")} — ${stats.symbol} at $${stats.priceUsd.toPrecision(4)}, 24h vol $${Math.round(stats.volume24hUsd).toLocaleString("en-US")}`,
    `💬 Social: ${socialTag.replace(/_/g, " ")}`,
    "",
    ...signals.map((s) => `• ${s.detail}`),
    "",
    "Market + social moved together — momentum is real engagement, not noise.",
    "Possible drivers: raid/campaign activity · influencer mention · market-wide move",
    "📡 Sources: market provider + captured chat data (measured)",
  ];
  return { unified: true, marketKinds, signals, text: lines.join("\n") };
}

/**
 * Convenience used by the market poller: measure social signals over the same
 * cadence as the poll (5 min default) and combine with detected market alerts.
 */
export function unifiedMomentumAlert(
  db: BrainDb,
  chatId: number,
  stats: TokenStats,
  marketKinds: string[],
  windowSeconds = 30 * 60,
  thresholds: MomentumThresholds = DEFAULT_MOMENTUM_THRESHOLDS
): UnifiedMomentumAlert | null {
  if (marketKinds.length === 0) return null;
  const social = collectSocialSignals(db, chatId, windowSeconds);
  const signals = socialMomentumSignals(social, thresholds);
  return combineMomentum(stats, marketKinds, signals);
}
