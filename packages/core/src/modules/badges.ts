import type { BrainDb } from "../database/db.js";

/**
 * 🏅 RECOGNITION BADGES MODULE
 * Milestone badges auto-awarded as members level up, plus manual honors
 * an admin can grant. Badges are permanent and shown with /badges.
 */

export interface UserStatsLike {
  xp: number;
  level: number;
  streak: number;
}

export interface BadgeDef {
  code: string;
  emoji: string;
  name: string;
  description: string;
  /** Auto-award once the member reaches this level. */
  minLevel?: number;
  /** Auto-award once the member holds this activity streak (days). */
  minStreak?: number;
  /** Auto-award once the member earns this much total XP. */
  minXp?: number;
}

export const BADGES: BadgeDef[] = [
  { code: "first_words", emoji: "🌱", name: "First Words", description: "Reached level 2", minLevel: 2 },
  { code: "regular", emoji: "💬", name: "Regular", description: "Reached level 3", minLevel: 3 },
  { code: "helper", emoji: "🛠️", name: "Helper", description: "Reached level 4", minLevel: 4 },
  { code: "legend", emoji: "👑", name: "Legend", description: "Reached level 6", minLevel: 6 },
  { code: "streak_7", emoji: "📅", name: "Week Streak", description: "7-day activity streak", minStreak: 7 },
  { code: "streak_30", emoji: "🗓️", name: "Month Streak", description: "30-day activity streak", minStreak: 30 },
  { code: "xp_500", emoji: "✨", name: "500 Club", description: "Earned 500 XP", minXp: 500 },
  { code: "xp_2500", emoji: "🌟", name: "2500 Club", description: "Earned 2500 XP", minXp: 2500 },
];

export function badgeByCode(code: string): BadgeDef | undefined {
  return BADGES.find((b) => b.code === code);
}

export const BADGE_CODES = BADGES.map((b) => b.code);

/** Pure check: does the member's current stats qualify for this badge? */
export function qualifiesFor(badge: BadgeDef, stats: UserStatsLike): boolean {
  if (badge.minLevel !== undefined && stats.level >= badge.minLevel) return true;
  if (badge.minStreak !== undefined && stats.streak >= badge.minStreak) return true;
  if (badge.minXp !== undefined && stats.xp >= badge.minXp) return true;
  return false;
}

/** Pure check: which badges would be newly earned, given already-held codes? */
export function earnedBadges(stats: UserStatsLike, alreadyAwarded: string[]): BadgeDef[] {
  const held = new Set(alreadyAwarded);
  return BADGES.filter((b) => !held.has(b.code) && qualifiesFor(b, stats));
}

export function badgeLine(def: BadgeDef): string {
  return `${def.emoji} ${def.name} — ${def.description}`;
}

export class BadgeEngine {
  constructor(private db: BrainDb) {}

  /** Check milestones after a stats update; awards and returns the new badges. */
  checkMilestones(chatId: number, userId: number, stats: UserStatsLike): BadgeDef[] {
    const already = this.db.listBadges(chatId, userId).map((b) => b.code);
    const newly: BadgeDef[] = [];
    for (const badge of earnedBadges(stats, already)) {
      if (this.db.awardBadge(chatId, userId, badge.code)) newly.push(badge);
    }
    return newly;
  }

  /** Manually grant an honor. Returns the badge or null when unknown/already held. */
  grant(chatId: number, userId: number, code: string): BadgeDef | null {
    const def = badgeByCode(code);
    if (!def) return null;
    return this.db.awardBadge(chatId, userId, code) ? def : null;
  }

  list(chatId: number, userId: number): string[] {
    return this.db.listBadges(chatId, userId).map((b) => b.code);
  }

  /** Text for /badges: earned badges first, then the ones still locked. */
  render(chatId: number, userId: number): string {
    const earned = new Set(this.list(chatId, userId));
    const lines = BADGES.map((b) => `${earned.has(b.code) ? b.emoji : "🔒"} ${b.name} — ${b.description}`);
    const count = earned.size;
    const header = count === 0 ? "No badges yet — chat, help and complete quests to earn them." : `🏅 ${count} badge${count === 1 ? "" : "s"} earned`;
    return ["🏅 YOUR BADGES", "━━━━━━━━━━━━━━━━━━━", header, "", ...lines].join("\n");
  }
}
