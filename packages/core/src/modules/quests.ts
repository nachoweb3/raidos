import type { BrainDb, QuestRow } from "../database/db.js";

/**
 * 🎯 QUEST ENGINE
 * Configurable missions ("send 5 messages", "invite 2 members", ...).
 * Admins create quests; the bot tracks progress; XP rewards on completion.
 */

export type QuestRequirement =
  | { kind: "messages"; target: number }
  | { kind: "reactions"; target: number }
  | { kind: "invites"; target: number }
  | { kind: "meme_submissions"; target: number }
  | { kind: "poll_votes"; target: number }
  | { kind: "raids"; target: number };

export function parseRequirement(json: string): QuestRequirement | null {
  try {
    const obj = JSON.parse(json) as { kind?: string; target?: number };
    const kinds = ["messages", "reactions", "invites", "meme_submissions", "poll_votes", "raids"];
    if (!obj || !kinds.includes(obj.kind ?? "") || typeof obj.target !== "number" || obj.target <= 0) return null;
    return { kind: obj.kind as QuestRequirement["kind"], target: obj.target } as QuestRequirement;
  } catch {
    return null;
  }
}

export function questIsExpired(q: QuestRow, now = Math.floor(Date.now() / 1000)): boolean {
  return q.ends_at !== null && q.ends_at <= now;
}

export function questIsOpen(q: QuestRow, now = Math.floor(Date.now() / 1000)): boolean {
  return q.status === "active" && !questIsExpired(q, now);
}

/** Pure: compute the next progress value after an event. */
export function nextProgress(current: number, requirement: QuestRequirement, event: QuestRequirement["kind"]): number {
  if (event !== requirement.kind) return current;
  return current + 1;
}

export class QuestEngine {
  constructor(
    private db: BrainDb,
    private grantXp: (chatId: number, userId: number, xp: number, reason: string) => void
  ) {}

  createQuest(
    chatId: number,
    input: {
      name: string;
      description?: string;
      requirement: QuestRequirement;
      xpReward: number;
      durationHours?: number;
      maxParticipants?: number;
      sponsoredBy?: string;
    },
    createdBy: number
  ): number {
    return this.db.addQuest({
      chat_id: chatId,
      name: input.name,
      description: input.description ?? "",
      requirement: JSON.stringify(input.requirement),
      xp_reward: input.xpReward,
      status: "active",
      created_by: createdBy,
      ends_at: input.durationHours ? Math.floor(Date.now() / 1000) + input.durationHours * 3600 : null,
      max_participants: input.maxParticipants ?? null,
      sponsored_by: input.sponsoredBy ?? null,
    });
  }

  /** Record an event and complete the quest when the target is reached. */
  recordEvent(chatId: number, userId: number, event: QuestRequirement["kind"]): string[] {
    const completed: string[] = [];
    const open = this.db.listQuests(chatId, "active");
    const now = Math.floor(Date.now() / 1000);
    for (const q of open) {
      if (questIsExpired(q, now)) continue;
      const req = parseRequirement(q.requirement);
      if (!req || req.kind !== event) continue;
      const participants = this.db.questParticipants(q.id);
      if (q.max_participants !== null && !participants.some((p) => p.user_id === userId) && participants.length >= q.max_participants) continue;

      const before = participants.find((p) => p.user_id === userId)?.progress ?? 0;
      const after = nextProgress(before, req, event);
      this.db.setQuestProgress(q.id, userId, after);

      if (before < req.target && after >= req.target) {
        this.db.completeQuest(q.id);
        this.grantXp(chatId, userId, q.xp_reward, `quest:${q.id}`);
        completed.push(q.name);
      }
    }
    return completed;
  }

  progressLine(q: QuestRow, userId: number): string {
    const req = parseRequirement(q.requirement);
    const target = req?.target ?? 1;
    const current = this.db.questParticipants(q.id).find((p) => p.user_id === userId)?.progress ?? 0;
    return `${q.name}: ${Math.min(current, target)}/${target}`;
  }
}
