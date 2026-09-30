/**
 * 📊 WALLET POSITIONS — position accounting for OBSERVED on-chain swaps.
 *
 * The same average-cost engine that powers user positions (positions.ts)
 * generalized to external wallets: `applySwapToPosition` keys a position by
 * user_id, this one keys by wallet address (Position Engine V2,
 * docs/ROADMAP_V2.md §3.1). It consumes the observation layer
 * (`onchain_swaps`) and produces `wallet_positions` + POSITION_xX milestones.
 *
 * Honesty rules (same bar as the rest of the repo):
 * - USD metrics (avg entry, cost basis, realized PnL, multiples) exist ONLY
 *   when the provider observed USD prices. Any unpriced buy makes the basis
 *   unknown (null) — we never interpolate or invent a price.
 * - Orphan sells (a sell observed without a previously-built position — the
 *   wallet traded before tracking started) do NOT fabricate a position; the
 *   caller skips them.
 * - A sell larger than the tracked position is skipped by the caller too:
 *   some swaps are legitimately unobserved (ambiguous legs, provider gaps),
 *   so the tracker must never clamp or guess.
 * - Floats here are ANALYTICS (UI multiples, PnL badges), never funds: money
 *   moves as integer base units elsewhere.
 */

export interface WalletPositionState {
  wallet: string;
  chain: string;
  token: string;
  status: "open" | "closed";
  /** Smallest-unit strings (same convention as onchain_swaps.amount_token). */
  amount_remaining: string;
  total_bought: string;
  total_sold: string;
  /** USD per whole token; null = unknown (unpriced buys). */
  avg_entry_usd: number | null;
  /** Remaining cost basis in USD; null = unknown. */
  net_invested_usd: number | null;
  realized_pnl_usd: number | null;
  /** MAX PnL (x): highest price/avg-entry multiple ever observed. */
  max_multiple: number | null;
  opened_at: number;
  closed_at: number | null;
  last_swap_ts: number;
}

export type WalletPositionMilestoneKind = "POSITION_2X" | "POSITION_5X" | "POSITION_10X";

export interface WalletPositionMilestone {
  kind: WalletPositionMilestoneKind;
  multiple: number;
  ts: number;
}

const MILESTONE_THRESHOLDS: Array<[WalletPositionMilestoneKind, number]> = [
  ["POSITION_2X", 2],
  ["POSITION_5X", 5],
  ["POSITION_10X", 10],
];

function tokens(value: string, field: string): bigint {
  if (!/^\d+$/.test(value)) throw new Error(`${field} must be a non-negative integer string`);
  return BigInt(value);
}

/** Current value multiple of a position mark over its average entry. */
function multipleNow(avgEntryUsd: number | null, priceUsd: number | null | undefined): number | null {
  if (avgEntryUsd == null || avgEntryUsd <= 0 || priceUsd == null || !Number.isFinite(priceUsd) || priceUsd < 0) return null;
  return priceUsd / avgEntryUsd;
}

/**
 * Apply one observed buy/sell to a wallet position using average cost.
 * Throws when the observation cannot be accounted honestly (zero amount,
 * negative price, sell beyond the tracked position) — the caller decides to
 * skip those instead of inventing state.
 */
export function applySwapToWalletPosition(
  position: WalletPositionState | undefined,
  swap: { side: "buy" | "sell"; amountToken: string; priceUsd?: number | null; ts: number },
): WalletPositionState & { milestones: WalletPositionMilestone[] } {
  const amount = tokens(swap.amountToken, "amountToken");
  if (amount <= 0n) throw new Error("amountToken must be greater than zero");
  const price = swap.priceUsd ?? null;
  if (price !== null && (!Number.isFinite(price) || price < 0)) throw new Error("priceUsd must be a finite non-negative number");

  const base: WalletPositionState = {
    wallet: position?.wallet ?? "",
    chain: position?.chain ?? "",
    token: position?.token ?? "",
    status: position?.status ?? "open",
    amount_remaining: position?.amount_remaining ?? "0",
    total_bought: position?.total_bought ?? "0",
    total_sold: position?.total_sold ?? "0",
    avg_entry_usd: position?.avg_entry_usd ?? null,
    net_invested_usd: position?.net_invested_usd ?? null,
    realized_pnl_usd: position?.realized_pnl_usd ?? null,
    max_multiple: position?.max_multiple ?? null,
    opened_at: position?.opened_at ?? swap.ts,
    closed_at: position?.closed_at ?? null,
    last_swap_ts: swap.ts,
  };
  const milestones: WalletPositionMilestone[] = [];

  if (swap.side === "buy") {
    const remaining = tokens(base.amount_remaining, "amount_remaining") + amount;
    const totalBought = tokens(base.total_bought, "total_bought") + amount;
    // Cost basis is only tracked while EVERY buy carries an observed USD price.
    const basisKnown = position ? base.net_invested_usd !== null : true; // fresh position starts empty (0)
    const buyCost = price !== null ? price * Number(amount) : null;
    const basis = basisKnown && buyCost !== null ? (position?.net_invested_usd ?? 0) + buyCost : null;
    const avgEntry = basis !== null ? basis / Number(remaining) : null;

    const current = multipleNow(avgEntry, price);
    const prevMax = base.max_multiple;
    for (const [kind, threshold] of MILESTONE_THRESHOLDS) {
      if (current !== null && current >= threshold && (prevMax ?? 0) < threshold) {
        milestones.push({ kind, multiple: current, ts: swap.ts });
      }
    }

    return {
      ...base,
      status: "open",
      amount_remaining: remaining.toString(),
      total_bought: totalBought.toString(),
      avg_entry_usd: avgEntry,
      net_invested_usd: basis,
      max_multiple: current !== null ? Math.max(prevMax ?? 0, current) : prevMax,
      closed_at: null, // a buy re-opens a closed position (opened_at preserved)
      milestones,
    };
  }

  if (!position || position.status !== "open") throw new Error("cannot sell without an open position");
  const oldRemaining = tokens(base.amount_remaining, "amount_remaining");
  if (amount > oldRemaining) throw new Error("sell amount exceeds tracked position");

  const oldBasis = base.net_invested_usd;
  const proceeds = price !== null ? price * Number(amount) : null;
  // Pro-rata allocation preserves the cost basis through partial closes.
  const allocated = oldBasis !== null ? oldBasis * (Number(amount) / Number(oldRemaining)) : null;
  const remaining = oldRemaining - amount;
  const remainingBasis = oldBasis !== null && allocated !== null ? oldBasis - allocated : null;
  const totalSold = tokens(base.total_sold, "total_sold") + amount;
  // Realized PnL requires both the allocated cost and the sell proceeds; if
  // either is unknown the cumulative figure becomes unknown (never partial).
  const realized =
    proceeds !== null && allocated !== null
      ? (base.realized_pnl_usd ?? 0) + proceeds - allocated
      : null;
  const avgEntry = remainingBasis !== null && remaining > 0n ? remainingBasis / Number(remaining) : null;

  const current = multipleNow(avgEntry, price);
  const prevMax = base.max_multiple;
  for (const [kind, threshold] of MILESTONE_THRESHOLDS) {
    if (current !== null && current >= threshold && (prevMax ?? 0) < threshold) {
      milestones.push({ kind, multiple: current, ts: swap.ts });
    }
  }

  if (remaining === 0n) {
    return {
      ...base,
      status: "closed",
      amount_remaining: "0",
      total_sold: totalSold.toString(),
      net_invested_usd: 0,
      avg_entry_usd: null,
      realized_pnl_usd: realized,
      max_multiple: current !== null ? Math.max(prevMax ?? 0, current) : prevMax,
      closed_at: swap.ts,
      milestones,
    };
  }

  return {
    ...base,
    status: "open",
    amount_remaining: remaining.toString(),
    total_sold: totalSold.toString(),
    avg_entry_usd: avgEntry,
    net_invested_usd: remainingBasis,
    realized_pnl_usd: realized,
    max_multiple: current !== null ? Math.max(prevMax ?? 0, current) : prevMax,
    milestones,
  };
}
