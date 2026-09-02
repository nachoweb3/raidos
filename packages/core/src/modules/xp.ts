import type { BrainDb } from "../database/db.js";

/**
 * ⭐ XP / LEVELS / STREAKS MODULE
 * Rewards contribution, not spam: same-text and cooldown rules apply.
 */

export const LEVEL_TITLES = [
  "Lurker",
  "Member",
  "Active",
  "Regular",
  "Contributor",
  "Helper",
  "Legend",
  "OG",
];

export function levelFromXp(xp: number): number {
  return Math.floor(Math.sqrt(Math.max(0, xp) / 40)) + 1;
}

export function xpForNextLevel(level: number): number {
  return 40 * level * level;
}

export interface XpConfig {
  messageXp: number;
  questionXp: number;
  sameTextXp: number;
  cooldownSeconds: number;
  dailyCap: number;
}

export const DEFAULT_XP_CONFIG: XpConfig = {
  messageXp: 2,
  questionXp: 3,
  sameTextXp: 0,
  cooldownSeconds: 60,
  dailyCap: 150,
};

export interface XpGrant {
  xp: number;
  reason: string;
}

/** Pure decision: should this message earn XP, and how much? */
export function grantFor(
  text: string,
  isQuestion: boolean,
  config: XpConfig
): XpGrant {
  const trimmed = text.trim().toLowerCase();
  if (trimmed.length < 2) return { xp: 0, reason: "too_short" };
  if (isQuestion) return { xp: config.questionXp, reason: "question" };
  return { xp: config.messageXp, reason: "message" };
}

export interface UserStats {
  xp: number;
  level: number;
  streak: number;
}

export class XpEngine {
  constructor(
    private db: BrainDb,
    private config: XpConfig = DEFAULT_XP_CONFIG
  ) {}

  /** Record a message's XP. Returns updated stats or null when nothing granted. */
  recordMessage(chatId: number, userId: number, text: string, isQuestion: boolean): UserStats | null {
    const grant = grantFor(text, isQuestion, this.config);
    if (grant.xp === 0) return null;
    return this.grantXp(chatId, userId, grant.xp, grant.reason);
  }

  grantXp(chatId: number, userId: number, xp: number, reason: string): UserStats {
    const r = this.db.recordXp(chatId, userId, xp, reason);
    return { xp: r.xp, level: levelFromXp(r.xp), streak: r.streak };
  }

  getStats(chatId: number, userId: number): UserStats {
    const r = this.db.getUserStats(chatId, userId);
    return { xp: r.xp, level: levelFromXp(r.xp), streak: r.streak };
  }
}
