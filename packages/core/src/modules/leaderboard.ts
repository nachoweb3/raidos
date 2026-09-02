import type { BrainDb } from "../database/db.js";
import { levelFromXp, LEVEL_TITLES } from "./xp.js";

/**
 * 🏆 LEADERBOARD MODULE
 * Individual (top contributors) and per-chat rankings from real XP data.
 */

export interface LeaderboardEntry {
  rank: number;
  username: string;
  xp: number;
  level: number;
}

export function topUsers(db: BrainDb, chatId: number, limit = 10): LeaderboardEntry[] {
  return db
    .topUsersByXp(chatId, limit)
    .map((row, i) => ({
      rank: i + 1,
      username: row.username ?? `user${row.user_id}`,
      xp: row.xp,
      level: levelFromXp(row.xp),
    }));
}

const MEDALS = ["🥇", "🥈", "🥉"];

export function leaderboardText(entries: LeaderboardEntry[], title = "🏆 TOP CONTRIBUTORS"): string {
  if (entries.length === 0) {
    return `${title}\n\nNo XP recorded yet. Talk, build, contribute — the board fills itself.`;
  }
  const lines = entries.map((e) => {
    const medal = MEDALS[e.rank - 1] ?? `#${e.rank}`;
    const title_ = LEVEL_TITLES[Math.min(e.level - 1, LEVEL_TITLES.length - 1)] ?? "";
    return `${medal} ${e.username} — ${e.xp} XP · Lvl ${e.level} ${title_}`;
  });
  return [title, "━━━━━━━━━━━━━━━━━━━", ...lines].join("\n");
}
