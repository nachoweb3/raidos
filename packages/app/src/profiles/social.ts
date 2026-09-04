/**
 * 🌐 SOCIAL TRADING — follow, copy-trade, public profiles, leaderboards
 * Traders have public profiles linked to their X handle.
 * Followers can copy trades, see call history, and rank on leaderboards.
 */

/** Public user profile */
export interface UserProfile {
  id: number;
  /** X (Twitter) handle */
  xHandle: string | null;
  /** Display name */
  displayName: string;
  /** Profile image URL */
  avatarUrl: string | null;
  /** Bio */
  bio: string;
  /** Total followers */
  followersCount: number;
  /** Total following */
  followingCount: number;
  /** Total PnL in USDC (6 decimals) */
  totalPnlUsdc: string;
  /** Win rate percentage */
  winRate: number;
  /** Total trades */
  totalTrades: number;
  /** Total calls (alerts/raids posted) */
  totalCalls: number;
  /** Follower count that copy-trades */
  copyTradeFollowers: number;
  /** Badges earned */
  badges: string[];
  /** Joined timestamp */
  joinedAt: number;
}

/** Trade call — a public trading signal */
export interface TradeCall {
  id: number;
  /** User who made the call */
  userId: number;
  /** Token address */
  tokenAddress: string;
  /** Token symbol */
  tokenSymbol: string;
  /** Chain */
  chain: string;
  /** Direction: long or short */
  direction: "long" | "short";
  /** Entry price in USDC */
  entryPrice: string;
  /** Target price */
  targetPrice: string;
  /** Stop loss */
  stopLoss: string | null;
  /** Outcome: pending, win, loss */
  outcome: "pending" | "win" | "loss";
  /** PnL if closed */
  pnlUsdc: string | null;
  /** Text description */
  text: string;
  /** Likes */
  likes: number;
  /** Comments */
  comments: number;
  /** Posted timestamp */
  postedAt: number;
}

/** Copy-trade settings */
export interface CopyTradeSettings {
  userId: number;
  /** Max USDC per copied trade */
  maxPerTradeUsdc: string;
  /** Max total USDC in copy trades */
  maxTotalUsdc: string;
  /** Whether copy-trade is enabled */
  enabled: boolean;
  /** Chains to copy on */
  chains: string[];
}

/** Leaderboard entry */
export interface LeaderboardEntry {
  rank: number;
  userId: number;
  xHandle: string | null;
  displayName: string;
  avatarUrl: string | null;
  totalPnlUsdc: string;
  winRate: number;
  totalTrades: number;
  followersCount: number;
}

export class SocialTrading {
  constructor(
    private db: {
      getProfile(userId: number): UserProfile | undefined;
      updateProfile(userId: number, updates: Partial<UserProfile>): void;
      follow(followerId: number, targetId: number): boolean;
      unfollow(followerId: number, targetId: number): boolean;
      getFollowers(userId: number, limit?: number): UserProfile[];
      getFollowing(userId: number, limit?: number): UserProfile[];
      isFollowing(followerId: number, targetId: number): boolean;
      createCall(input: Omit<TradeCall, "id" | "likes" | "comments">): number;
      getCall(callId: number): TradeCall | undefined;
      listUserCalls(userId: number, limit?: number): TradeCall[];
      likeCall(userId: number, callId: number): boolean;
      getTopTraders(chain: string, limit?: number): LeaderboardEntry[];
      getCopySettings(userId: number): CopyTradeSettings | undefined;
      setCopySettings(userId: number, settings: CopyTradeSettings): void;
    }
  ) {}

  /** Create or update profile */
  setProfile(userId: number, xHandle: string, displayName: string, bio: string, avatarUrl?: string): void {
    this.db.updateProfile(userId, {
      xHandle: xHandle.startsWith("@") ? xHandle : `@${xHandle}`,
      displayName,
      bio,
      avatarUrl: avatarUrl ?? null,
    });
  }

  /** Follow a trader */
  follow(followerId: number, targetId: number): boolean {
    if (followerId === targetId) return false;
    return this.db.follow(followerId, targetId);
  }

  /** Unfollow */
  unfollow(followerId: number, targetId: number): boolean {
    return this.db.unfollow(followerId, targetId);
  }

  /** Post a trade call (signal) */
  postCall(userId: number, call: Omit<TradeCall, "id" | "likes" | "comments">): number {
    return this.db.createCall(call);
  }

  /** Get leaderboard for a chain */
  getLeaderboard(chain: string, limit = 20): LeaderboardEntry[] {
    return this.db.getTopTraders(chain, limit);
  }

  /** Configure copy-trading */
  setCopyTrade(userId: number, settings: CopyTradeSettings): void {
    this.db.setCopySettings(userId, settings);
  }
}
