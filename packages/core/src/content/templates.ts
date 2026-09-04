import type { TokenStats } from "../market/providers.js";
import { volumeCard } from "../market/volume.js";
import type { ContentSignal } from "./signals.js";

/**
 * 📝 CONTENT TEMPLATES — the output side of the Content Engine
 * Pure render functions, one per post kind. No DB, no bot, no AI — every
 * function takes measured data and returns post text, or null when the text
 * cannot be rendered honestly from what the signal provides.
 *
 * Rules baked into every template:
 * - No invented numbers: if a number appears, it came from a measured signal.
 * - No fabricated momentum: hype words only when the data already says so.
 * - A template that cannot be filled honestly is never suggested.
 */

export type TemplateKind =
  | "announcement"
  | "recap"
  | "market_update"
  | "raid_wrap"
  | "spotlight"
  | "reminder"
  | "kb_gap_nudge"
  | "welcome";

export const TEMPLATE_KINDS: TemplateKind[] = [
  "announcement",
  "recap",
  "market_update",
  "raid_wrap",
  "spotlight",
  "reminder",
  "kb_gap_nudge",
  "welcome",
];

// ── Safe extraction (signals carry opaque JSON blobs) ──────────────────────

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

// ── Render functions (pure) ────────────────────────────────────────────────

/** "People keep asking X" — a clarification announcement grounded in a real cluster. */
export function renderAnnouncement(data: Record<string, unknown>): string | null {
  const question = asString(data.question);
  const count = asNumber(data.count);
  if (!question || count === null || count < 2) return null;
  return [
    "📢 FOR THE COMMUNITY",
    "",
    `Several members have asked: “${question}” (×${count})`,
    "Official answers live in the knowledge base — /ask <your question> gets one anytime.",
  ].join("\n");
}

/** Admin-only nudge when questions exist but the knowledge base is empty. */
export function renderKbGapNudge(data: Record<string, unknown>): string | null {
  const questions = asNumber(data.questions24h);
  if (questions === null || questions <= 0) return null;
  return [
    "🧠 KB GAP — admin note (not for the group)",
    "",
    `${questions} question${questions === 1 ? "" : "s"} in the last 24h, but the knowledge base is empty.`,
    "Feed me official info: /learn <fact> — then /ask can answer for you.",
  ].join("\n");
}

/** Pulse-derived weekly recap. Only numbers the pulse actually measured. */
export function renderRecap(data: Record<string, unknown>): string | null {
  const messages = asNumber(data.messages);
  const activeUsers = asNumber(data.activeUsers);
  const questions = asNumber(data.questions);
  if (messages === null || messages <= 0 || activeUsers === null || questions === null) return null;
  const open = asNumber(data.openClusters) ?? 0;
  const answered = asNumber(data.answeredClusters) ?? 0;
  const topQuestion = asString(data.topQuestion);
  const lines = [
    "📊 COMMUNITY RECAP",
    "",
    `💬 ${messages} messages · 👥 ${activeUsers} active members`,
    `❓ ${questions} questions asked`,
    `🧠 Recurring questions: ${answered} answered · ${open} still open`,
  ];
  if (topQuestion) lines.push(`🔥 Most asked: “${topQuestion}”`);
  lines.push("", "Measured from real chat activity.");
  return lines.join("\n");
}

/** Market update card — same data as /volume, nothing invented. */
export function renderMarketUpdate(data: Record<string, unknown>): string | null {
  const stats = asObject(data.stats) as unknown as import("../market/providers.js").TokenStats | null;
  if (!stats || typeof stats.symbol !== "string" || typeof stats.priceUsd !== "number") return null;
  return volumeCard(stats);
}

/** Post-raid wrap: measured participation, always labeled SELF-REPORTED. */
export function renderRaidWrap(data: Record<string, unknown>): string | null {
  const raidId = asNumber(data.raidId);
  const title = asString(data.title);
  const participants = asNumber(data.participants);
  const actions = asNumber(data.actions);
  if (raidId === null || !title || participants === null || actions === null) return null;
  const objective = asNumber(data.objective);
  const topRaider = asString(data.topRaider);
  const lines = [
    `🏁 RAID WRAP — #${raidId} ${title}`,
    "",
    `👥 ${participants} raider${participants === 1 ? "" : "s"} · ⚡ ${actions} tracked action${actions === 1 ? "" : "s"} (SELF-REPORTED)`,
  ];
  if (objective !== null && objective > 0) {
    lines.push(`🎯 ${Math.min(100, Math.round((actions / objective) * 100))}% of the objective`);
  }
  if (topRaider) lines.push(`🥇 Top raider: @${topRaider}`);
  lines.push("", "XP was granted live per tracked action.");
  return lines.join("\n");
}

/** Member spotlight — only when there is a real, earned reason. */
export function renderSpotlight(data: Record<string, unknown>): string | null {
  const questName = asString(data.questName);
  const xp = asNumber(data.xp);
  const username = asString(data.username);
  if (!questName || xp === null || xp <= 0) return null;
  const who = username ? `@${username}` : "A member";
  return [
    "🎉 MEMBER SPOTLIGHT",
    "",
    `${who} just completed the quest “${questName}” and earned ${xp} XP.`,
    "Real contribution, real reward. Join the next one: /quests",
  ].join("\n");
}

/** Deterministic reminder from a schedule (used when something is due). */
export function renderReminder(data: Record<string, unknown>): string | null {
  const title = asString(data.title);
  const minutes = asNumber(data.startsInMinutes);
  if (!title || minutes === null || minutes < 0) return null;
  const when = minutes === 0 ? "starting now" : `starting in ${minutes} min`;
  return [`⏰ REMINDER`, "", `“${title}” is ${when}.`, "Jump in — every tracked action counts."].join("\n");
}

/** Welcome nudge on a measured join spike — deterministic, never LLM-invented. */
export function renderWelcome(data: Record<string, unknown>): string | null {
  const joins = asNumber(data.joins);
  if (joins === null || joins <= 0) return null;
  return [
    "👋 WELCOME ABOARD",
    "",
    `${joins} new member${joins === 1 ? "" : "s"} joined in the last 24h.`,
    "New here? /ask answers official questions — /quests shows how to earn XP.",
  ].join("\n");
}

// ── Signal → template dispatch ─────────────────────────────────────────────

export interface RenderedSuggestion {
  kind: TemplateKind;
  text: string;
}

const RENDERERS: Record<string, (data: Record<string, unknown>) => string | null> = {
  confusion_cluster: renderAnnouncement,
  kb_gap: renderKbGapNudge,
  pulse_recap: renderRecap,
  market_alert: renderMarketUpdate,
  raid_completed: renderRaidWrap,
  quest_milestone: renderSpotlight,
  join_spike: renderWelcome,
};

/**
 * Render a signal into a proposed post. Returns null when the signal's data
 * cannot fill the template honestly — in that case nothing is suggested.
 */
export function renderFromSignal(signal: ContentSignal): RenderedSuggestion | null {
  const renderer = RENDERERS[signal.kind];
  if (!renderer) return null;
  const text = renderer(signal.data);
  if (!text) return null;
  const kind: TemplateKind =
    signal.kind === "confusion_cluster"
      ? "announcement"
      : signal.kind === "kb_gap"
        ? "kb_gap_nudge"
        : signal.kind === "pulse_recap"
          ? "recap"
          : signal.kind === "market_alert"
            ? "market_update"
            : signal.kind === "raid_completed"
              ? "raid_wrap"
              : signal.kind === "quest_milestone"
                ? "spotlight"
                : signal.kind === "join_spike"
                  ? "welcome"
                  : "reminder";
  return { kind, text };
}
