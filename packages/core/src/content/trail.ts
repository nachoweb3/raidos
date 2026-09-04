import type { BrainDb, ContentSuggestionRow } from "../database/db.js";
import { pulseMetrics } from "../modules/pulse.js";

/**
 * 📈 CONTENT TRAIL — the performance loop.
 * After a suggestion is published, a small measured window (messages, active
 * members, questions) is recorded and labeled SELF-REPORTED. This is not a
 * vanity metric: it tells the admin which template × signal combos actually
 * get the community to respond.
 */

export interface MeasuredWindow {
  messages: number;
  activeUsers: number;
  newQuestions: number;
  windowMinutes: number;
}

/** Measure the window after publish and store it (label SELF-REPORTED). */
export function recordPerformance(db: BrainDb, suggestion: ContentSuggestionRow, windowMinutes = 60, now = Math.floor(Date.now() / 1000)): MeasuredWindow | null {
  if (suggestion.published_at === null) return null;
  const chatId = suggestion.chat_id;
  const since = suggestion.published_at;
  const until = Math.min(now, since + windowMinutes * 60);
  if (until <= since) return null;
  const measured: MeasuredWindow = {
    messages: db.countMessages(chatId, since, until),
    activeUsers: db.distinctActiveUsers(chatId, since, until),
    newQuestions: db.countQuestionsBetween(chatId, since, until),
    windowMinutes: Math.round((until - since) / 60),
  };
  db.addContentPerformance(chatId, suggestion.id, JSON.stringify(measured), now);
  return measured;
}

/** Stats for one published suggestion, for `/content stats`. */
export function performanceLine(db: BrainDb, s: ContentSuggestionRow): string {
  const perf = db.getContentPerformance(s.id);
  const when = s.published_at ? new Date(s.published_at * 1000).toISOString().slice(0, 16).replace("T", " ") : "?";
  const kind = s.kind.padEnd(14, " ");
  if (!perf) return `#${s.id} ${kind} published ${when} — no measurements yet`;
  try {
    const m = JSON.parse(perf.measured) as MeasuredWindow;
    return `#${s.id} ${kind} published ${when} — 💬 ${m.messages} msgs · 👥 ${m.activeUsers} active · ❓ ${m.newQuestions} new questions (${m.windowMinutes}m window)`;
  } catch {
    return `#${s.id} ${kind} published ${when} — measurement unreadable`;
  }
}

/** Full `/content stats` view: published suggestions + measured performance + totals. */
export function contentStatsText(db: BrainDb, chatId: number): string {
  const published = db.listContentSuggestions(chatId, "published", 20);
  const lines = ["📈 CONTENT STATS", "━━━━━━━━━━━━━━━━━━━"];
  if (published.length === 0) {
    lines.push("", "Nothing published yet. Run /content suggest, approve, then publish.");
  } else {
    lines.push("", ...published.map((s) => performanceLine(db, s)));
    const totals = pulseMetrics(db, chatId, 7);
    lines.push(
      "",
      `Last 7d overall: 💬 ${totals.messages} messages · 👥 ${totals.activeUsers} active · ❓ ${totals.questions} questions`,
      "All engagement numbers are measured; participation data is SELF-REPORTED."
    );
  }
  return lines.join("\n");
}
