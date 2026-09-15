/**
 * 📊 POSITIONS ENGINE — settled-fill position accounting.
 *
 * Financial quantities cross this module as integer base-unit strings. The
 * position keeps a remaining USDC cost basis; realized PnL is calculated from
 * that basis, not from a floating-point price.
 */

export interface PositionRow {
  id: number;
  user_id: number;
  chain: string;
  token: string;
  token_symbol: string;
  status: "open" | "closed";
  amount_remaining: string;
  total_bought: string;
  total_sold: string;
  avg_entry_usdc: string;
  /** Remaining cost basis, net of buy fees. */
  net_invested_usdc: string;
  /** Cumulative realized PnL across partial and full closes. */
  realized_pnl_usdc: string | null;
  opened_at: number;
  closed_at: number | null;
}

export interface PositionUpdateResult {
  positionId: number;
  status: "open" | "closed";
  realizedPnlUsdc: string | null;
}

function integer(value: string, field: string): bigint {
  if (!/^-?\d+$/.test(value)) throw new Error(`${field} must be an integer`);
  return BigInt(value);
}

function nonNegative(value: string, field: string): bigint {
  const parsed = integer(value, field);
  if (parsed < 0n) throw new Error(`${field} must be non-negative`);
  return parsed;
}

/** Apply one settled buy or sell fill to a position using average cost. */
export function applySwapToPosition(
  position: PositionRow | undefined,
  swap: { side: "buy" | "sell"; tokenAmount: string; usdcAmount: string; feeUsdc?: string; ts: number },
): Omit<PositionRow, "id" | "user_id" | "chain" | "token" | "token_symbol"> & {
  user_id: number; chain: string; token: string; token_symbol: string;
} {
  const tokens = nonNegative(swap.tokenAmount, "tokenAmount");
  const grossUsdc = nonNegative(swap.usdcAmount, "usdcAmount");
  const fee = nonNegative(swap.feeUsdc ?? "0", "feeUsdc");
  if (tokens <= 0n) throw new Error("tokenAmount must be greater than zero");

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

  if (swap.side === "buy") {
    const oldAmount = nonNegative(base.amount_remaining, "amount_remaining");
    const oldCost = nonNegative(base.net_invested_usdc, "net_invested_usdc");
    const buyCost = grossUsdc + fee;
    const remaining = oldAmount + tokens;
    const totalBought = nonNegative(base.total_bought, "total_bought") + tokens;
    const costBasis = oldCost + buyCost;
    return {
      ...base,
      status: "open",
      amount_remaining: remaining.toString(),
      total_bought: totalBought.toString(),
      avg_entry_usdc: (costBasis / remaining).toString(),
      net_invested_usdc: costBasis.toString(),
      opened_at: position?.opened_at ?? swap.ts,
      closed_at: null,
    };
  }

  if (!position || position.status !== "open") throw new Error("cannot sell without an open position");
  const oldAmount = nonNegative(base.amount_remaining, "amount_remaining");
  if (tokens > oldAmount) throw new Error("sell amount exceeds open position");

  const oldCost = nonNegative(base.net_invested_usdc, "net_invested_usdc");
  const proceeds = grossUsdc > fee ? grossUsdc - fee : 0n;
  // Pro-rata allocation preserves the full cost basis through partial closes.
  const allocatedCost = oldAmount === 0n ? 0n : (oldCost * tokens) / oldAmount;
  const remaining = oldAmount - tokens;
  const remainingCost = oldCost - allocatedCost;
  const totalSold = nonNegative(base.total_sold, "total_sold") + tokens;
  const previousRealized = base.realized_pnl_usdc === null ? 0n : integer(base.realized_pnl_usdc, "realized_pnl_usdc");
  const realized = previousRealized + proceeds - allocatedCost;

  if (remaining === 0n) {
    return {
      ...base,
      status: "closed",
      amount_remaining: "0",
      total_sold: totalSold.toString(),
      net_invested_usdc: "0",
      avg_entry_usdc: "0",
      realized_pnl_usdc: realized.toString(),
      closed_at: swap.ts,
    };
  }

  return {
    ...base,
    status: "open",
    amount_remaining: remaining.toString(),
    total_sold: totalSold.toString(),
    avg_entry_usdc: (remainingCost / remaining).toString(),
    net_invested_usdc: remainingCost.toString(),
    realized_pnl_usdc: realized.toString(),
  };
}
