import type { BrainDb } from "../database/db.js";

// The bot is a single process, so this closes the manual-publish/scheduler
// race while the network request is in flight.
const publishingSuggestionIds = new Set<number>();

/**
 * ✅ CONTENT APPROVAL — the admin loop: approve, edit, schedule, publish, skip.
 * The engine proposes; the admin decides. Auto-publish (opt-in) reuses the
 * same approval functions with the decision made by settings, and every
 * published post lands in the same audit trail.
 */

export type ApproveResult =
  | { ok: true; status: "approved" | "edited" }
  | { ok: false; reason: "not_found" | "wrong_chat" | "not_proposed" | "empty_text" };

export function approveSuggestion(db: BrainDb, id: number, newText?: string, expectedChatId?: number): ApproveResult {
  const s = db.getContentSuggestion(id);
  if (!s) return { ok: false, reason: "not_found" };
  if (expectedChatId !== undefined && s.chat_id !== expectedChatId) return { ok: false, reason: "wrong_chat" };
  if (s.status !== "proposed") return { ok: false, reason: "not_proposed" };
  if (newText !== undefined) {
    const t = newText.trim();
    if (t.length === 0) return { ok: false, reason: "empty_text" };
    db.setSuggestionText(id, t);
    db.setContentSuggestionStatus(id, "edited");
    return { ok: true, status: "edited" };
  }
  db.setContentSuggestionStatus(id, "approved");
  return { ok: true, status: "approved" };
}

export type SkipResult = { ok: true } | { ok: false; reason: "not_found" | "wrong_chat" | "not_proposed" };

export function skipSuggestion(db: BrainDb, id: number, expectedChatId?: number): SkipResult {
  const s = db.getContentSuggestion(id);
  if (!s) return { ok: false, reason: "not_found" };
  if (expectedChatId !== undefined && s.chat_id !== expectedChatId) return { ok: false, reason: "wrong_chat" };
  if (s.status !== "proposed") return { ok: false, reason: "not_proposed" };
  db.setContentSuggestionStatus(id, "skipped");
  return { ok: true };
}

export type ScheduleResult =
  | { ok: true; scheduleId: number }
  | { ok: false; reason: "not_found" | "wrong_chat" | "not_ready" | "bad_when" };

/**
 * Schedule an approved/edited suggestion for publishing. `when` is an epoch
 * second; values in the past publish on the next scheduler tick.
 */
export function scheduleSuggestion(db: BrainDb, id: number, when: number, channel: "group" | "x" = "group", expectedChatId?: number): ScheduleResult {
  const s = db.getContentSuggestion(id);
  if (!s) return { ok: false, reason: "not_found" };
  if (expectedChatId !== undefined && s.chat_id !== expectedChatId) return { ok: false, reason: "wrong_chat" };
  if (s.status !== "approved" && s.status !== "edited" && s.status !== "scheduled") return { ok: false, reason: "not_ready" };
  if (!Number.isFinite(when)) return { ok: false, reason: "bad_when" };
  const scheduleId = db.addContentSchedule(s.chat_id, id, Math.floor(when), channel);
  if (s.status !== "scheduled") db.setContentSuggestionStatus(id, "scheduled");
  return { ok: true, scheduleId };
}

export type PublishResult =
  | { ok: true; text: string }
  | { ok: false; reason: "not_found" | "wrong_chat" | "not_ready" | "send_failed" };

/**
 * Publish now: send via the provided poster (typed API surface — the engine
 * never imports the Bot), record `published_at` + published text, and record
 * the schedule job as done when the publish came from the scheduler.
 */
export async function publishSuggestion(
  db: BrainDb,
  id: number,
  post: (chatId: number, text: string) => Promise<boolean>,
  scheduleId?: number,
  expectedChatId?: number
): Promise<PublishResult> {
  const s = db.getContentSuggestion(id);
  if (!s) return { ok: false, reason: "not_found" };
  if (expectedChatId !== undefined && s.chat_id !== expectedChatId) return { ok: false, reason: "wrong_chat" };
  if (s.status !== "approved" && s.status !== "edited" && s.status !== "scheduled") return { ok: false, reason: "not_ready" };
  if (publishingSuggestionIds.has(id)) return { ok: false, reason: "not_ready" };
  publishingSuggestionIds.add(id);
  try {
    const ok = await post(s.chat_id, s.text);
    if (!ok) return { ok: false, reason: "send_failed" };
    if (!db.publishContentSuggestion(id, s.text)) return { ok: false, reason: "not_ready" };
    if (scheduleId !== undefined) db.setScheduleStatus(scheduleId, "done");
    return { ok: true, text: s.text };
  } finally {
    publishingSuggestionIds.delete(id);
  }
}
