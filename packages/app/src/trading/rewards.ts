/**
 * 🎁 REWARDS ENGINE — fee-funded trading + referral rewards.
 *
 * Economics (the invariant): rewards are always carved out of REAL platform
 * fees. For every confirmed trade we pay at most:
 *   tradingReward  = fee × TRADING_REWARD_RATE   → to the trader
 *   referralReward = fee × REFERRAL_REWARD_RATE  → to the referrer (if any)
 * The engine refuses to accrue when TRADING_REWARD_RATE + REFERRAL_REWARD_RATE
 * would exceed 100% of the fee, and enforces daily caps and a minimum claim.
 *
 * Honesty/idempotency: ledger UNIQUE(trade_id, reward_type, user_id) makes
 * double accrual impossible; referrer attribution is immutable (users.referred_by
 * is set at registration and never updated); self-referrals are ignored.
 * Anti-fraud: account flags NORMAL/REVIEW/BLOCKED gate accrual status.
 * All rates live in the DB (rewards_config) — editable without redeploying.
 */

import type { AppDb } from "../database/app-db.js";

export interface RewardsConfigValues {
  tradingRewardRate: number; // 0..1, share of the fee returned to the trader
  referralRewardRate: number; // 0..1, share of the referred user's fee paid out
  minClaimUsdc: number; // minimum AVAILABLE balance to claim (USD)
  maxDailyRewardUsdc: number; // per-user daily accrual cap (USD)
  minTradeVolumeUsdc: number; // trades below this volume accrue nothing (anti-wash)
  enabled: boolean;
}

const DEFAULTS: RewardsConfigValues = {
  tradingRewardRate: 0.1,
  referralRewardRate: 0.1,
  minClaimUsdc: 5,
  maxDailyRewardUsdc: 500,
  minTradeVolumeUsdc: 1,
  enabled: true,
};

const DAY_SECONDS = 86_400;

export class RewardsEngine {
  constructor(private db: AppDb) {}

  /** Effective config (DB overrides > defaults), validated. */
  getConfig(): RewardsConfigValues {
    const num = (key: string, fb: number): number => {
      const v = Number(this.db.getRewardsConfig(key, String(fb)));
      return Number.isFinite(v) && v >= 0 ? v : fb;
    };
    const cfg: RewardsConfigValues = {
      tradingRewardRate: Math.min(1, num("TRADING_REWARD_RATE", DEFAULTS.tradingRewardRate)),
      referralRewardRate: Math.min(1, num("REFERRAL_REWARD_RATE", DEFAULTS.referralRewardRate)),
      minClaimUsdc: num("MIN_CLAIM_USDC", DEFAULTS.minClaimUsdc),
      maxDailyRewardUsdc: num("MAX_DAILY_REWARD_USDC", DEFAULTS.maxDailyRewardUsdc),
      minTradeVolumeUsdc: num("MIN_TRADE_VOLUME_USDC", DEFAULTS.minTradeVolumeUsdc),
      enabled: this.db.getRewardsConfig("ENABLED", "1") !== "0",
    };
    // Invariant: combined rates can never exceed 100% of the fee.
    if (cfg.tradingRewardRate + cfg.referralRewardRate > 1) {
      const scale = 1 / (cfg.tradingRewardRate + cfg.referralRewardRate);
      cfg.tradingRewardRate *= scale;
      cfg.referralRewardRate *= scale;
    }
    return cfg;
  }

  setConfig(patch: Record<string, number | string | boolean>): RewardsConfigValues {
    const allowed: Record<string, (v: number) => boolean> = {
      TRADING_REWARD_RATE: (v) => v >= 0 && v <= 1,
      REFERRAL_REWARD_RATE: (v) => v >= 0 && v <= 1,
      MIN_CLAIM_USDC: (v) => v >= 0,
      MAX_DAILY_REWARD_USDC: (v) => v >= 0,
      MIN_TRADE_VOLUME_USDC: (v) => v >= 0,
    };
    for (const [key, value] of Object.entries(patch)) {
      if (key === "ENABLED") {
        this.db.setRewardsConfig("ENABLED", value ? "1" : "0");
        continue;
      }
      const check = allowed[key];
      if (!check) continue; // silently ignore unknown keys
      const n = Number(value);
      if (!Number.isFinite(n) || !check(n)) continue;
      this.db.setRewardsConfig(key, String(n));
    }
    return this.getConfig();
  }

  getFlag(userId: number): string {
    return this.db.getRewardFlag(userId).flag;
  }

  setFlag(userId: number, flag: "NORMAL" | "REVIEW" | "BLOCKED", reason = ""): void {
    this.db.setRewardFlag(userId, flag, reason);
  }

  /** Remaining daily accrual headroom in micro-USDC (cap − earned today). */
  private dailyHeadroom(userId: number, cfg: RewardsConfigValues): bigint {
    const capMicro = BigInt(Math.round(cfg.maxDailyRewardUsdc * 1e6));
    const todayStart = Math.floor(Date.now() / 1000 / DAY_SECONDS) * DAY_SECONDS;
    const earned = this.db.sumRewardsSince(userId, todayStart);
    return capMicro > earned ? capMicro - earned : 0n;
  }

  /**
   * Accrue the trading reward for a confirmed trade. Called only from the
   * server's confirmed-swap path with the REAL recorded fee. Idempotent per
   * (tradeId, TRADING, userId).
   * @returns accrual result; amounts in micro-USDC strings.
   */
  accrueTradingReward(input: {
    userId: number;
    tradeId: number;
    feeUsdc: string; // micro-USDC actually charged
    volumeUsdc: string; // micro-USDC trade volume
  }): { accrued: boolean; reason?: string; amountUsdc?: string; duplicate?: boolean } {
    const cfg = this.getConfig();
    if (!cfg.enabled) return { accrued: false, reason: "disabled" };
    if (cfg.tradingRewardRate <= 0) return { accrued: false, reason: "rate_zero" };
    if (this.getFlag(input.userId) === "BLOCKED") return { accrued: false, reason: "blocked" };

    const volume = BigInt(input.volumeUsdc || "0");
    if (volume < BigInt(Math.round(cfg.minTradeVolumeUsdc * 1e6))) {
      return { accrued: false, reason: "volume_below_min" };
    }

    const fee = BigInt(input.feeUsdc || "0");
    if (fee <= 0n) return { accrued: false, reason: "zero_fee" };

    let amount = (fee * BigInt(Math.round(cfg.tradingRewardRate * 10_000))) / 10_000n;
    if (amount <= 0n) return { accrued: false, reason: "amount_rounds_to_zero" };

    const headroom = this.dailyHeadroom(input.userId, cfg);
    if (headroom <= 0n) return { accrued: false, reason: "daily_cap_reached" };
    if (amount > headroom) amount = headroom;

    // REVIEW accounts accrue but stay PENDING (paid only after clearance).
    const status = this.getFlag(input.userId) === "REVIEW" ? "PENDING" : "AVAILABLE";
    const id = this.db.addRewardEntry({
      user_id: input.userId,
      reward_type: "TRADING",
      source: "trade",
      amount_usdc: amount.toString(),
      status,
      trade_id: input.tradeId,
      referral_id: null,
    });
    if (id === null) return { accrued: false, duplicate: true };

    const referral = this.accrueReferralReward(input.userId, input.tradeId, fee, cfg);
    return { accrued: true, amountUsdc: amount.toString(), ...referral };
  }

  /** Pay the referrer (if any) their share of THIS trade's fee. Idempotent. */
  private accrueReferralReward(
    traderUserId: number,
    tradeId: number,
    feeMicro: bigint,
    cfg: RewardsConfigValues
  ): { referralAccrued?: boolean; referralAmountUsdc?: string; referrerId?: number } {
    if (cfg.referralRewardRate <= 0) return {};
    const user = this.db.getUserById(traderUserId);
    const referrerId = user?.referred_by;
    if (!referrerId || referrerId === traderUserId) return {}; // no/self referral
    if (this.getFlag(referrerId) === "BLOCKED") return {};

    let amount = (feeMicro * BigInt(Math.round(cfg.referralRewardRate * 10_000))) / 10_000n;
    if (amount <= 0n) return {};

    const headroom = this.dailyHeadroom(referrerId, cfg);
    if (headroom <= 0n) return { referrerId };
    if (amount > headroom) amount = headroom;

    const status = this.getFlag(referrerId) === "REVIEW" ? "PENDING" : "AVAILABLE";
    const id = this.db.addRewardEntry({
      user_id: referrerId,
      reward_type: "REFERRAL",
      source: "referral",
      amount_usdc: amount.toString(),
      status,
      trade_id: tradeId,
      referral_id: traderUserId,
    });
    if (id === null) return { referrerId }; // already paid for this trade
    return { referralAccrued: true, referralAmountUsdc: amount.toString(), referrerId };
  }

  /* ── Reads ─────────────────────────────────────────────────────────── */

  getBalance(userId: number) {
    const sums = this.db.sumRewardsByStatus(userId);
    const now = Math.floor(Date.now() / 1000);
    return {
      totalUsdc: (sums.PENDING + sums.AVAILABLE + sums.CLAIMED).toString(),
      availableUsdc: sums.AVAILABLE.toString(),
      pendingUsdc: sums.PENDING.toString(),
      claimedUsdc: sums.CLAIMED.toString(),
      todayUsdc: this.db.sumRewardsSince(userId, Math.floor(now / DAY_SECONDS) * DAY_SECONDS).toString(),
      weekUsdc: this.db.sumRewardsSince(userId, now - 7 * DAY_SECONDS).toString(),
      monthUsdc: this.db.sumRewardsSince(userId, now - 30 * DAY_SECONDS).toString(),
    };
  }

  /** Per-type lifetime summaries for the dashboard blocks. */
  getStats(userId: number) {
    const entries = this.db.getRewardEntries(userId, 10_000);
    let trading = 0n;
    let referral = 0n;
    for (const e of entries) {
      const v = BigInt(e.amount_usdc);
      if (e.reward_type === "TRADING") trading += v;
      else if (e.reward_type === "REFERRAL") referral += v;
    }
    const referrals = this.db.getReferrals(userId, 10_000);
    const referralVolumes = this.db.referralVolumes(userId);
    const active = referralVolumes.filter((r: any) => Number(r.volume_usdc ?? 0) > 0).length;
    return {
      tradingRewardsUsdc: trading.toString(),
      referralRewardsUsdc: referral.toString(),
      referralsTotal: referrals.length,
      referralsActive: active,
      referralsInactive: referrals.length - active,
      referralVolumeUsdc: referralVolumes.reduce((acc: bigint, r: any) => acc + BigInt(r.volume_usdc ?? 0), BigInt(0)).toString(),
      config: this.getConfig(),
    };
  }

  getHistory(userId: number, opts: { type?: string; status?: string; limit?: number; offset?: number } = {}) {
    let entries = this.db.getRewardEntries(userId, opts.limit ?? 100, opts.offset ?? 0);
    if (opts.type) entries = entries.filter((e) => e.reward_type === opts.type!.toUpperCase());
    if (opts.status) entries = entries.filter((e) => e.status === opts.status!.toUpperCase());
    return entries;
  }

  /**
   * Claim all AVAILABLE rewards. Internal-ledger claim for now: marks CLAIMED
   * and returns the total so a future on-chain transfer can attach its tx hash
   * (markRewardsClaimed already stores it). Enforces min claim + BLOCKED gate.
   */
  claim(userId: number): { claimedUsdc: string; txRef: string } {
    if (this.getFlag(userId) === "BLOCKED") throw new Error("account blocked: claiming disabled");
    const cfg = this.getConfig();
    const sums = this.db.sumRewardsByStatus(userId);
    if (sums.AVAILABLE < BigInt(Math.round(cfg.minClaimUsdc * 1e6))) {
      throw new Error(`minimum claim is ${cfg.minClaimUsdc} USDC`);
    }
    const txRef = `claim_${userId}_${Date.now()}`; // on-chain transfer will replace this with a real tx hash
    const total = this.db.markRewardsClaimed(userId, txRef);
    return { claimedUsdc: total.toString(), txRef };
  }

  getLeaderboard(period: "24h" | "7d" | "30d" | "all", limit = 20) {
    const now = Math.floor(Date.now() / 1000);
    const since = period === "24h" ? now - DAY_SECONDS : period === "7d" ? now - 7 * DAY_SECONDS : period === "30d" ? now - 30 * DAY_SECONDS : 0;
    return this.db.topRewardEarners(since, limit);
  }

  getProgramMetrics() {
    const m = this.db.rewardsMetrics();
    const fee = Number(m.totalFeesUsdc) / 1e6;
    const paid = Number(m.totalTradingRewards + m.totalReferralRewards) / 1e6;
    return {
      totalFeesUsdc: m.totalFeesUsdc.toString(),
      totalTradingRewardsUsdc: m.totalTradingRewards.toString(),
      totalReferralRewardsUsdc: m.totalReferralRewards.toString(),
      totalClaimedUsdc: m.totalClaimed.toString(),
      totalPendingUsdc: m.totalPending.toString(),
      rewardFeeRatio: fee > 0 ? Number((paid / fee).toFixed(4)) : 0,
      referralVolumeUsdc: m.referralVolumeUsdc.toString(),
    };
  }
}
