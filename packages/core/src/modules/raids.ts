import type { BrainDb, RaidRow } from "../database/db.js";

/**
 * ⚡ RAID ENGINE — RaidOS activation layer
 * Coordinated community engagement with honest tracking:
 * - Participation is SELF-REPORTED (check-ins). The bot never claims a user
 *   liked/reposted anything unless a platform API verified it (V1: never).
 * - Anti-abuse: join caps, check-in cooldowns, per-raid check-in caps,
 *   diminishing XP per check-in, and a daily raid-XP cap per user.
 */

export interface RaidConfig {
  /** Minimum seconds between check-ins per user per raid. */
  checkinCooldownSeconds: number;
  /** Maximum check-ins counted per user per raid. */
  maxCheckinsPerRaid: number;
  /** XP decays by this factor for each extra check-in beyond the first (diminishing returns). */
  checkinXpDecay: number;
  /** Maximum raid XP a user can earn per UTC day (anti-spam). */
  dailyXpCap: number;
}

export const DEFAULT_RAID_CONFIG: RaidConfig = {
  checkinCooldownSeconds: 10 * 60,
  maxCheckinsPerRaid: 6,
  checkinXpDecay: 0.5,
  dailyXpCap: 500,
};

export const RAID_PLATFORMS = ["x", "telegram", "discord", "youtube", "tiktok", "instagram", "other"] as const;

export function parseDuration(spec: string): number | null {
  const m = /^(\d+)(m|h)$/i.exec(spec.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (n <= 0) return null;
  return m[2]!.toLowerCase() === "h" ? n * 60 : n;
}

/** Pure check: is this check-in allowed for this user on this raid? */
export function checkinAllowed(
  participant: { last_checkin_at: number; checkins: number } | undefined,
  cfg: RaidConfig,
  now: number
): { ok: boolean; reason?: string } {
  if (!participant) return { ok: false, reason: "not_joined" };
  if (participant.checkins >= cfg.maxCheckinsPerRaid) return { ok: false, reason: "checkin_cap" };
  // Cooldown only applies after the first tracked action; joining then acting
  // immediately is legitimate (the anti-spam cap still applies).
  if (participant.checkins > 0 && now - participant.last_checkin_at < cfg.checkinCooldownSeconds)
    return { ok: false, reason: "cooldown" };
  return { ok: true };
}

/** Pure XP computation with diminishing returns. */
export function checkinXp(baseXp: number, previousCheckins: number, decay: number): number {
  const factor = Math.pow(decay, Math.min(previousCheckins, 10));
  return Math.max(1, Math.round(baseXp * factor));
}

export function raidIsExpired(r: RaidRow, now = Math.floor(Date.now() / 1000)): boolean {
  return r.status === "active" && r.ends_at <= now;
}

export interface RaidScore {
  participants: number;
  trackedActions: number;
  completionPct: number | null;
  velocity: "low" | "steady" | "high";
}

/** Quality-oriented score from measurable data only. */
export function raidScore(r: RaidRow, participants: number, trackedActions: number, now = Math.floor(Date.now() / 1000)): RaidScore {
  const elapsedMin = Math.max(1, Math.min(now, r.ends_at) - r.started_at) / 60;
  const expectedActions = r.objective > 0 ? r.objective : participants * 3; // soft default
  const completionPct = r.objective > 0 ? Math.min(100, (trackedActions / r.objective) * 100) : null;
  const actionsPerParticipantPerMin = trackedActions / Math.max(1, participants) / elapsedMin;
  const velocity: RaidScore["velocity"] = actionsPerParticipantPerMin >= 0.5 ? "high" : actionsPerParticipantPerMin >= 0.15 ? "steady" : "low";
  void expectedActions;
  return { participants, trackedActions, completionPct, velocity };
}

export function raidScoreText(score: RaidScore): string {
  const vEmoji = score.velocity === "high" ? "🔥" : score.velocity === "steady" ? "➡️" : "🐢";
  const lines = [
    "📊 RAID SCORE",
    `Participants: ${score.participants}`,
    `Tracked actions: ${score.trackedActions}`,
  ];
  if (score.completionPct !== null) lines.push(`Completion: ${score.completionPct.toFixed(0)}%`);
  lines.push(`Engagement velocity: ${vEmoji} ${score.velocity}`);
  return lines.join("\n");
}

export type JoinResult = "ok" | "already" | "full" | "raid_closed";
export type CheckinResult =
  | { status: "ok"; xp: number; totalXp: number; checkins: number }
  | { status: "not_joined" | "cooldown" | "checkin_cap" | "raid_closed" | "daily_cap"; waitSeconds?: number };

export class RaidEngine {
  constructor(
    private db: BrainDb,
    private cfg: RaidConfig = DEFAULT_RAID_CONFIG
  ) {}

  createRaid(input: {
    chatId: number;
    title: string;
    platform: string;
    targetUrl: string;
    objective: number;
    durationMinutes: number;
    xpReward: number;
    maxParticipants: number | null;
    createdBy: number | null;
  }): number {
    const now = Math.floor(Date.now() / 1000);
    return this.db.addRaid({
      chat_id: input.chatId,
      title: input.title,
      platform: input.platform,
      target_url: input.targetUrl,
      objective: input.objective,
      duration_minutes: input.durationMinutes,
      xp_reward: input.xpReward,
      max_participants: input.maxParticipants,
      status: "active",
      created_by: input.createdBy,
      started_at: now,
      ends_at: now + input.durationMinutes * 60,
    });
  }

  join(raidId: number, userId: number, username: string | null, expectedChatId?: number): JoinResult {
    return this.db.joinRaidParticipant(raidId, userId, username, expectedChatId);
  }

  /**
   * Self-reported action check-in. Awards XP with diminishing returns and a
   * daily cap. Always labeled SELF-REPORTED in the UI layer.
   */
  checkin(raidId: number, userId: number, expectedChatId?: number): CheckinResult {
    const r = this.db.getRaid(raidId);
    if (!r) return { status: "raid_closed" };
    const result = this.db.checkinRaidParticipant({
      raidId,
      userId,
      expectedChatId,
      now: Math.floor(Date.now() / 1000),
      cooldownSeconds: this.cfg.checkinCooldownSeconds,
      maxCheckins: this.cfg.maxCheckinsPerRaid,
      baseXp: r.xp_reward,
      decay: this.cfg.checkinXpDecay,
      dailyXpCap: this.cfg.dailyXpCap,
    });
    return result;
  }

  finish(raidId: number, expectedChatId?: number): { score: RaidScore; top: { user_id: number; username: string | null; checkins: number } | null } | null {
    const r = this.db.getRaid(raidId);
    if (!r || (expectedChatId !== undefined && r.chat_id !== expectedChatId) || r.status !== "active") return null;
    if (!this.db.finishRaidRow(raidId)) return null;
    const parts = this.db.listRaidParticipants(raidId);
    const trackedActions = parts.reduce((a, p) => a + p.checkins, 0);
    const score = raidScore(r, parts.length, trackedActions);
    const top = parts.length > 0 ? parts.reduce((a, b) => (b.checkins > a.checkins ? b : a)) : null;
    return { score, top: top ? { user_id: top.user_id, username: top.username, checkins: top.checkins } : null };
  }

  score(raidId: number, expectedChatId?: number): RaidScore | null {
    const r = this.db.getRaid(raidId);
    if (!r || (expectedChatId !== undefined && r.chat_id !== expectedChatId)) return null;
    const parts = this.db.listRaidParticipants(raidId);
    const trackedActions = parts.reduce((a, p) => a + p.checkins, 0);
    return raidScore(r, parts.length, trackedActions);
  }

  /** One-line status for dashboards. */
  statusLine(r: RaidRow): string {
    const parts = this.db.listRaidParticipants(r.id).length;
    const now = Math.floor(Date.now() / 1000);
    const remaining = Math.max(0, r.ends_at - now);
    const mins = Math.floor(remaining / 60);
    return `🚨 #${r.id} ${r.title} — ${parts} raider${parts === 1 ? "" : "s"} · ${mins}m left`;
  }
}
