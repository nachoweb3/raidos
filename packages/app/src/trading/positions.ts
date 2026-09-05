/**
 * 📊 POSITIONS ENGINE — group swaps into positions (fomo-style)
 * A position is the full build-up of buys/sells on one token by one user:
 * buys average in, sells reduce the size, and the position closes when the
 * remaining amount reaches zero — at which point realized PnL is finalized.
 * This is the foundation for the social feed, profiles and share cards.
 */

export interface PositionRow {
  id: number;
  user_id: number;
  chain: string;
  /** Token contract/mint address */
  token: string;
  token_symbol: string;
  /** open | closed */
  status: "open" | "closed";
  /** Remaining token amount (smallest units) */
  amount_remaining: string;
  /** Total tokens bought over the position's life */
  total_bought: string;
  /** Total tokens sold over the position's life */
  total_sold: string;
  /** Volume-weighted average entry price in USDC (1e6 units per whole token) */
  avg_entry_usdc: string;
  /** Net USDC invested (buys − sells proceeds), 1e6 units */
  net_invested_usdc: string;
  /** Realized PnL in USDC (1e6 units) — set when closed */
  realized_pnl_usdc: string | null;
  opened_at: number;
  closed_at: number | null;
}

export interface PositionUpdateResult {
  positionId: number;
  status: "open" | "closed";
  realizedPnlUsdc: string | null;
}

/**
 * Apply one swap to a user's position on a token, creating/averaging/closing.
 * swap = { side, tokenAmount, usdcAmount, feeUsdc } (amounts in smallest units).
 * Fees count against PnL: they increase cost basis on buys and reduce proceeds
 * on sells — realized PnL is always net of fees (honest accounting).
 */
export function applySwapToPosition(
  position: PositionRow | undefined,
  swap: { side: "buy" | "sell"; tokenAmount: string; usdcAmount: string; feeUsdc?: string; ts: number },
): Omit<PositionRow, "id" | "user_id" | "chain" | "token" | "token_symbol"> & {
  user_id: number; chain: string; token: string; token_symbol: string;
} {
  const side = swap.side;
  const tokens = BigInt(swap.tokenAmount);
  const fee = BigInt(swap.feeUsdc ?? "0");
  // gross usdc leg + fee netting: buys cost usdc+fee, sells yield usdc−fee
  const usdc = BigInt(swap.usdcAmount) + (side === "buy" ? fee : -fee);

  const base = {
    user_id: position?.user_id ?? 0,
    chain: position?.chain ?? "",
    token: position?.token ?? "",
    token_symbol: position?.token_symbol ?? "",
    status: (position?.status ?? "open") as "open" | "closed",
    amount_remaining: position?.amount_remaining ?? "0",
    total_bought: position?.total_bought ?? "0",
    total_sold: position?.total_sold ?? "0",
    avg_entry_usdc: position?.avg_entry_usdc ?? "0",
    net_invested_usdc: position?.net_invested_usdc ?? "0",
    realized_pnl_usdc: position?.realized_pnl_usdc ?? null,
    opened_at: position?.opened_at ?? swap.ts,
    closed_at: position?.closed_at ?? null,
  };

  if (side === "buy") {
    const remaining = BigInt(base.amount_remaining) + tokens;
    const totalBought = BigInt(base.total_bought) + tokens;
    // new avg entry = (old avg × old amount + usdc) / new amount
    const oldAmount = BigInt(base.amount_remaining);
    const oldAvg = BigInt(base.avg_entry_usdc || "0");
    const newAvg = remaining > 0n ? (oldAvg * oldAmount + usdc) / remaining : 0n;
    const netInvested = BigInt(base.net_invested_usdc) + usdc;
    return {
      ...base,
      status: "open",
      amount_remaining: remaining.toString(),
      total_bought: totalBought.toString(),
      avg_entry_usdc: newAvg.toString(),
      net_invested_usdc: netInvested.toString(),
      opened_at: base.opened_at || swap.ts,
      closed_at: null,
    };
  }

  // sell: reduce amount, take proceeds out of net invested; close at zero
  const remaining = BigInt(base.amount_remaining) - tokens;
  const totalSold = BigInt(base.total_sold) + tokens;
  const netInvested = BigInt(base.net_invested_usdc) - usdc;

  if (remaining <= 0n) {
    // closing: realized PnL = total USDC received from sells − total USDC spent on buys
    const realized = BigInt(base.net_invested_usdc) * -1n + usdc;
    return {
      ...base,
      status: "closed",
      amount_remaining: "0",
      total_sold: totalSold.toString(),
      net_invested_usdc: netInvested.toString(),
      realized_pnl_usdc: realized.toString(),
      closed_at: swap.ts,
    };
  }

  return {
    ...base,
    amount_remaining: remaining.toString(),
    total_sold: totalSold.toString(),
    net_invested_usdc: netInvested.toString(),
  };
}
