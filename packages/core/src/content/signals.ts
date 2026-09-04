import type { BrainDb } from "../database/db.js";
import type { TokenStats } from "../market/providers.js";
import { communityMemory } from "../modules/memory.js";

/**
 * 📡 CONTENT SIGNALS — the input side of the Content Engine
 * One place where brain signals, market signals and raid/quest signals
 * converge per chat. The engine only recommends posts when there is a real,
 * measured signal to ground them in.
 *
 * Honesty rules: every signal is measured from captured data or structurally
 * true. Cooldowns (per chat per signal kind) keep the engine from suggesting
 * the same post twice in a short window.
 */

export type SignalKind =
  | "confusion_cluster"
  | "kb_gap"
  | "pulse_recap"
  | "market_alert"
  | "raid_completed"
  | "quest_milestone"
  | "join_spike";

export interface ContentSignal {
  kind: SignalKind;
  /** Human-readable, grounded description shown to the admin. */
  detail: string;
  /** Strength 0..1 — used for ranking when several signals fire at once. */
  strength: number;
  /** Extra data the template renderer needs (already measured). */
  data: Record<string, unknown>;
}

export interface SignalOptions {
  /** Cooldown seconds per signal kind (default 6h). */
  cooldownSeconds: number;
  /** Join-spike threshold: new members in 24h that trigger the welcome signal. */
  joinSpikeMembers: number;
  /** Raid-wrap lookback: consider raids finished within this window. */
  raidWrapWindowHours: number;
}

export const DEFAULT_SIGNAL_OPTIONS: SignalOptions = {
  cooldownSeconds: 6 * 3600,
  joinSpikeMembers: 5,
  raidWrapWindowHours: 24,
};

const HOUR = 3600;
const DAY = 24 * HOUR;

/** Pure: is the signal kind out of cooldown for this chat? */
export function isOnCooldown(
  db: BrainDb,
  chatId: number,
  kind: SignalKind,
  now: number,
  cooldownSeconds: number
): boolean {
  const last = db.recentContentSuggestionByKind(chatId, kind, now - cooldownSeconds);
  return last !== undefined;
}

/**
 * Gather the current signals for one chat. Reads only already-captured
 * aggregates (clusters, insights, snapshots, raids, quests) — it never calls
 * an AI provider and never touches the message hot path.
 */
export function gatherSignals(
  db: BrainDb,
  chatId: number,
  marketKinds: string[] = [],
  marketStats: TokenStats | null = null,
  opts: SignalOptions = DEFAULT_SIGNAL_OPTIONS,
  now = Math.floor(Date.now() / 1000)
): ContentSignal[] {
  const out: ContentSignal[] = [];

  // 1) Confusion cluster: a labeled cluster promoted by the analyzer.
  const topCluster = communityMemory(db, chatId, 1)
    .filter((m) => m.status === "open")
    [0];
  if (topCluster) {
    out.push({
      kind: "confusion_cluster",
      detail: `“${topCluster.question}” has been asked ×${topCluster.count} and is still unanswered`,
      strength: Math.min(1, 0.4 + topCluster.count * 0.1),
      data: { question: topCluster.question, count: topCluster.count, clusterId: topCluster.id },
    });
  }

  // 2) Knowledge base gap: questions are being asked, but the KB has no entries.
  const kbCount = db.listKbEntries(chatId).length;
  const questions24h = db.questionCount(chatId, now - DAY);
  if (kbCount === 0 && questions24h > 0) {
    out.push({
      kind: "kb_gap",
      detail: `${questions24h} question${questions24h === 1 ? "" : "s"} in 24h but the knowledge base is empty — this is an admin nudge, not a group post`,
      strength: 0.5,
      data: { questions24h, kbCount },
    });
  }

  // 3) Pulse recap: a weekly pulse exists to recap.
  const latestPulse = db.latestInsight(chatId, "pulse");
  if (latestPulse && now - latestPulse.ts < 3 * DAY) {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(latestPulse.payload) as Record<string, unknown>;
    } catch {
      payload = {};
    }
    const messages = typeof payload.messages === "number" ? payload.messages : null;
    if (messages !== null && messages > 0) {
      out.push({
        kind: "pulse_recap",
        detail: `Last weekly pulse measured ${messages} messages and ${String(payload.activeUsers ?? "?")} active members`,
        strength: 0.6,
        data: { ...payload, pulseTs: latestPulse.ts },
      });
    }
  }

  // 4) Market alert: fired by the poller this cycle (passed in — never re-fetched).
  if (marketKinds.length > 0 && marketStats) {
    out.push({
      kind: "market_alert",
      detail: `Market alert fired: ${marketKinds.join(" · ")} on $${marketStats.symbol}`,
      strength: 0.8,
      data: { kinds: marketKinds, stats: marketStats },
    });
  }

  // 5) Raid completed: a raid finished within the lookback window.
  // finished_at can be NULL for rows closed before the column existed — fall back to ends_at.
  const finished = db
    .listRaids(chatId, "finished")
    .map((r) => ({ ...r, finished_at: r.finished_at ?? r.ends_at }))
    .filter((r) => r.finished_at !== null && now - r.finished_at < opts.raidWrapWindowHours * HOUR);
  if (finished.length > 0) {
    const raid = finished[0]!;
    const parts = db.listRaidParticipants(raid.id);
    const actions = parts.reduce((a, p) => a + p.checkins, 0);
    out.push({
      kind: "raid_completed",
      detail: `Raid #${raid.id} “${raid.title}” finished — ${parts.length} participants, ${actions} tracked actions`,
      strength: 0.7,
      data: {
        raidId: raid.id,
        title: raid.title,
        participants: parts.length,
        actions,
        objective: raid.objective,
        topRaider: parts.length > 0 ? parts.reduce((a, b) => (b.checkins > a.checkins ? b : a)).username : null,
      },
    });
  }

  // 6) Quest milestone: the most recent quest completion.
  const latestQuestXp = db.latestXpLedger(chatId, "quest:");
  if (latestQuestXp && now - latestQuestXp.ts < DAY) {
    const questRef = latestQuestXp.reason.slice("quest:".length);
    const quest = db.getQuest(Number(questRef));
    out.push({
      kind: "quest_milestone",
      detail: `Quest “${quest?.name ?? questRef}” was just completed (${latestQuestXp.xp} XP earned)`,
      strength: 0.6,
      data: { questId: questRef, questName: quest?.name ?? null, username: latestQuestXp.username, userId: latestQuestXp.user_id, xp: latestQuestXp.xp },
    });
  }

  // 7) Join spike: new members in the last 24h.
  const joins = db.newMembersBetween(chatId, now - DAY, now);
  if (joins >= opts.joinSpikeMembers) {
    out.push({
      kind: "join_spike",
      detail: `${joins} new members joined in the last 24h`,
      strength: Math.min(1, joins / (opts.joinSpikeMembers * 4)),
      data: { joins },
    });
  }

  return out;
}

/**
 * Filter signals whose kind is on cooldown. Suggestion records are created by
 * the suggester; this check looks at the audit trail only.
 */
export function filterByCooldown(
  db: BrainDb,
  chatId: number,
  signals: ContentSignal[],
  opts: SignalOptions = DEFAULT_SIGNAL_OPTIONS,
  now = Math.floor(Date.now() / 1000)
): { ready: ContentSignal[]; cooled: SignalKind[] } {
  const ready: ContentSignal[] = [];
  const cooled: SignalKind[] = [];
  for (const s of signals) {
    if (isOnCooldown(db, chatId, s.kind, now, opts.cooldownSeconds)) {
      cooled.push(s.kind);
    } else {
      ready.push(s);
    }
  }
  return { ready, cooled };
}
