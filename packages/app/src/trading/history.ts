/**
 * 📈 TRADE HISTORY + PNL — track every trade, calculate PnL, generate analytics
 * Every trade is recorded with timestamps, prices, and outcomes.
 * PnL is calculated in USDC across all chains.
 */

/** Stored trade row */
export interface TradeRow {
  id: number;
  userId: number;
  /** Trade type */
  type: "swap" | "bridge" | "limit" | "launch_buy" | "launch_sell" | "copy";
  /** Source chain */
  fromChain: string;
  /** Dest chain */
  toChain: string;
  /** Token sold */
  sellToken: string;
  /** Token bought */
  buyToken: string;
  /** Sell amount */
  sellAmount: string;
  /** Buy amount */
  buyAmount: string;
  /** Sell price at time of trade (USDC per token) */
  sellPriceUsdc: string;
  /** Buy price at time of trade */
  buyPriceUsdc: string;
  /** Trading fee in USDC */
  feeUsdc: string;
  /** Transaction hash */
  txHash: string;
  /** For launch buys: which launch */
  launchId: number | null;
  /** For copy trades: which user was copied */
  copiedUserId: number | null;
  /** Realized PnL (for closed positions) */
  realizedPnlUsdc: string | null;
  /** Status */
  status: "pending" | "confirmed" | "failed";
  /** Timestamp */
  ts: number;
}

/** User PnL summary */
export interface PnlSummary {
  userId: number;
  /** Total PnL across all chains */
  totalPnlUsdc: string;
  /** PnL per chain */
  pnlByChain: Record<string, string>;
  /** Win rate */
  winRate: number;
  /** Total trades */
  totalTrades: number;
  /** Winning trades */
  winningTrades: number;
  /** Losing trades */
  losingTrades: number;
  /** Best trade */
  bestTradePnlUsdc: string;
  /** Worst trade */
  worstTradePnlUsdc: string;
  /** Total fees paid */
  totalFeesUsdc: string;
  /** Volume traded in USDC */
  volumeUsdc: string;
  /** Average trade size */
  avgTradeSizeUsdc: string;
}

/** Activity timeline entry for profiles */
export interface ActivityEntry {
  type: "trade" | "call" | "launch" | "raid" | "badge";
  summary: string;
  chain: string;
  pnlUsdc?: string;
  ts: number;
}

export class TradeHistory {
  constructor(
    private db: {
      addTrade(trade: Omit<TradeRow, "id">): number;
      getTrade(id: number): TradeRow | undefined;
      getUserTrades(userId: number, limit?: number, offset?: number): TradeRow[];
      getUserPnl(userId: number): PnlSummary;
      getChainPnl(userId: number, chain: string): PnlSummary;
      getRecentActivity(userId: number, limit?: number): ActivityEntry[];
      getTopPerformers(chain: string, since: number, limit?: number): { userId: number; pnlUsdc: string; winRate: number; trades: number }[];
    }
  ) {}

  /** Record a completed trade */
  recordTrade(trade: Omit<TradeRow, "id">): number {
    return this.db.addTrade(trade);
  }

  /** Get user's full PnL summary */
  getPnl(userId: number): PnlSummary {
    return this.db.getUserPnl(userId);
  }

  /** Get PnL for a specific chain */
  getChainPnl(userId: number, chain: string): PnlSummary {
    return this.db.getChainPnl(userId, chain);
  }

  /** Get trade history with pagination */
  getHistory(userId: number, limit = 50, offset = 0): TradeRow[] {
    return this.db.getUserTrades(userId, limit, offset);
  }

  /** Get activity timeline for profile */
  getActivity(userId: number, limit = 20): ActivityEntry[] {
    return this.db.getRecentActivity(userId, limit);
  }

  /** Get top performers on a chain */
  getTopPerformers(chain: string, since: number, limit = 10) {
    return this.db.getTopPerformers(chain, since, limit);
  }
}
