/**
 * 💰 REVENUE ENGINE — multiple revenue models in one system
 * Revenue streams:
 * 1. Trading fees (0.3% per swap, 0.5% per bridge)
 * 2. Token launch fees (10 USDC per launch)
 * 3. Premium subscriptions (analytics, alerts, API)
 * 4. Advertising (sponsored tokens, banner ads)
 * 5. Sponsored placements (featured on leaderboard/profiles)
 * 6. API access fees (devs pay for data)
 * 7. Copy-trade fees (0.1% of copied trade volume)
 */

/** Revenue event stored for accounting */
export interface RevenueEvent {
  id: number;
  /** Revenue stream */
  stream: RevenueStream;
  /** User who generated the revenue */
  userId: number;
  /** Amount in USDC (6 decimals) */
  amountUsdc: string;
  /** Transaction reference */
  refType: string;
  refId: number;
  /** Metadata */
  meta: string;
  /** Created timestamp */
  ts: number;
}

export type RevenueStream =
  | "trading_fee"
  | "bridge_fee"
  | "launch_fee"
  | "premium_subscription"
  | "ad_impression"
  | "ad_click"
  | "sponsored_placement"
  | "api_access"
  | "copy_trade_fee"
  | "listing_fee";

/** Premium subscription tiers */
export interface PremiumTier {
  id: string;
  name: string;
  /** Monthly price in USDC */
  priceUsdc: string;
  /** Features included */
  features: string[];
}

/** Ad campaign */
export interface AdCampaign {
  id: number;
  /** Advertiser user ID */
  advertiserId: number;
  /** Ad type */
  type: "banner" | "sponsored_token" | "featured_call";
  /** Chain target */
  chain: string;
  /** Budget in USDC */
  budgetUsdc: string;
  /** Spent so far */
  spentUsdc: string;
  /** Impressions */
  impressions: number;
  /** Clicks */
  clicks: number;
  /** Token to promote (for sponsored_token type) */
  tokenAddress: string | null;
  /** Start timestamp */
  startsAt: number;
  /** End timestamp */
  endsAt: number;
  /** Status */
  status: "active" | "paused" | "ended";
}

export const PREMIUM_TIERS: PremiumTier[] = [
  {
    id: "free",
    name: "Free",
    priceUsdc: "0",
    features: [
      "Basic trading (swap/bridge)",
      "View leaderboard",
      "3 alerts per day",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    priceUsdc: "29000000", // 29 USDC/month
    features: [
      "Unlimited swaps",
      "Advanced alerts (volume, whale, social)",
      "Public profile + calls",
      "Copy-trade (follow 5 traders)",
      "Priority routing",
      "No ads",
    ],
  },
  {
    id: "alpha",
    name: "Alpha",
    priceUsdc: "99000000", // 99 USDC/month
    features: [
      "Everything in Pro",
      "Unlimited copy-trade",
      "API access (10k calls/mo)",
      "Advanced analytics dashboard",
      "Token launch priority",
      "Custom alert rules",
      "Early access to new features",
    ],
  },
  {
    id: "enterprise",
    name: "Enterprise",
    priceUsdc: "499000000", // 499 USDC/month
    features: [
      "Everything in Alpha",
      "Unlimited API access",
      "White-label integration",
      "Dedicated support",
      "Custom trading strategies",
      "Institutional-grade analytics",
      "Revenue share on referrals",
    ],
  },
];

export class RevenueEngine {
  /** Trading fee config */
  static FEES = {
    SWAP_BPS: 30,           // 0.3%
    BRIDGE_BPS: 50,         // 0.5%
    COPY_TRADE_BPS: 10,     // 0.1%
    LAUNCH_FEE: "10000000", // 10 USDC
    MIN_FEE: "1000",        // 0.001 USDC
  };

  constructor(
    private db: {
      addRevenueEvent(event: Omit<RevenueEvent, "id">): number;
      getRevenueByStream(stream: RevenueStream, since: number): RevenueEvent[];
      getRevenueByUser(userId: number, since?: number): RevenueEvent[];
      getTotalRevenue(since: number): string;
      getUserSubscription(userId: number): string | undefined;
      setUserSubscription(userId: number, tierId: string): void;
      addAdCampaign(input: Omit<AdCampaign, "id" | "spentUsdc" | "impressions" | "clicks">): number;
      recordAdImpression(campaignId: number): void;
      recordAdClick(campaignId: number): void;
    }
  ) {}

  /** Record a trading fee */
  recordTradingFee(userId: number, amountUsdc: string, isBridge: boolean, refType: string, refId: number): string {
    const bps = isBridge ? RevenueEngine.FEES.BRIDGE_BPS : RevenueEngine.FEES.SWAP_BPS;
    const amount = BigInt(amountUsdc);
    let fee = (amount * BigInt(bps)) / 10000n;
    const minFee = BigInt(RevenueEngine.FEES.MIN_FEE);
    if (fee < minFee) fee = minFee;

    this.db.addRevenueEvent({
      stream: isBridge ? "bridge_fee" : "trading_fee",
      userId,
      amountUsdc: fee.toString(),
      refType,
      refId,
      meta: JSON.stringify({ bps, baseAmount: amountUsdc }),
      ts: Math.floor(Date.now() / 1000),
    });

    return fee.toString();
  }

  /** Record a launch fee */
  recordLaunchFee(userId: number, launchId: number): void {
    this.db.addRevenueEvent({
      stream: "launch_fee",
      userId,
      amountUsdc: RevenueEngine.FEES.LAUNCH_FEE,
      refType: "launch",
      refId: launchId,
      meta: JSON.stringify({ symbol: "USDC" }),
      ts: Math.floor(Date.now() / 1000),
    });
  }

  /** Record a copy-trade fee */
  recordCopyTradeFee(userId: number, volumeUsdc: string, refType: string, refId: number): string {
    const volume = BigInt(volumeUsdc);
    const fee = (volume * BigInt(RevenueEngine.FEES.COPY_TRADE_BPS)) / 10000n;

    this.db.addRevenueEvent({
      stream: "copy_trade_fee",
      userId,
      amountUsdc: fee.toString(),
      refType,
      refId,
      meta: JSON.stringify({ volumeUsdc }),
      ts: Math.floor(Date.now() / 1000),
    });

    return fee.toString();
  }

  /** Upgrade user to premium tier */
  subscribe(userId: number, tierId: string): PremiumTier {
    const tier = PREMIUM_TIERS.find((t) => t.id === tierId);
    if (!tier) throw new Error(`Unknown tier: ${tierId}`);

    this.db.setUserSubscription(userId, tierId);

    if (BigInt(tier.priceUsdc) > 0n) {
      this.db.addRevenueEvent({
        stream: "premium_subscription",
        userId,
        amountUsdc: tier.priceUsdc,
        refType: "subscription",
        refId: 0,
        meta: JSON.stringify({ tier: tierId, period: "monthly" }),
        ts: Math.floor(Date.now() / 1000),
      });
    }

    return tier;
  }

  /** Create an ad campaign */
  createAdCampaign(advertiserId: number, input: Omit<AdCampaign, "id" | "spentUsdc" | "impressions" | "clicks">): number {
    return this.db.addAdCampaign(input);
  }

  /** Record ad impression + revenue */
  recordImpression(campaignId: number, costUsdc: string): void {
    this.db.recordAdImpression(campaignId);
    this.db.addRevenueEvent({
      stream: "ad_impression",
      userId: 0,
      amountUsdc: costUsdc,
      refType: "ad_campaign",
      refId: campaignId,
      meta: "{}",
      ts: Math.floor(Date.now() / 1000),
    });
  }

  /** Record ad click + revenue */
  recordClick(campaignId: number, costUsdc: string): void {
    this.db.recordAdClick(campaignId);
    this.db.addRevenueEvent({
      stream: "ad_click",
      userId: 0,
      amountUsdc: costUsdc,
      refType: "ad_campaign",
      refId: campaignId,
      meta: "{}",
      ts: Math.floor(Date.now() / 1000),
    });
  }

  /** Get revenue summary for a period */
  getRevenueSummary(since: number): Record<RevenueStream, bigint> {
    const streams: Record<string, bigint> = {};
    for (const event of this.db.getRevenueByStream("trading_fee", since)) {
      streams.trading_fee = (streams.trading_fee ?? 0n) + BigInt(event.amountUsdc);
    }
    // ... aggregate all streams
    return streams as Record<RevenueStream, bigint>;
  }

  /** Get user's subscription tier */
  getSubscription(userId: number): PremiumTier {
    const tierId = this.db.getUserSubscription(userId) ?? "free";
    return PREMIUM_TIERS.find((t) => t.id === tierId) ?? PREMIUM_TIERS[0]!;
  }
}
