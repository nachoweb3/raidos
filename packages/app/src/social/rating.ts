/**
 * 🧮 WALLET RATING v1 — transparent copy-trading score (0-100).
 *
 * Public formula (Cheetah keeps theirs secret; ours is published in the UI):
 * built over SELF-OBSERVED on-chain trades harvested from pools we already
 * index. No third-party API, no invented data — only what our indexer saw.
 *
 * Six factors (mirroring the industry-standard guidance):
 *   1. expectancy     — realized edge per trade vs its size        (weight 30%)
 *   2. sample         — trade count (50+ = full marks)            (weight 15%)
 *   3. realizedShare  — realized PnL vs paper (unrealized) PnL    (weight 20%)
 *   4. profitFactor   — gross wins / gross losses (cap 3)         (weight 15%)
 *   5. holdStyle      — hold time band copyable by humans         (weight 10%)
 *   6. consistency    — older half of the window also profitable  (weight  5%)
 *   + concentration   — 1 − share of the single best token        (weight  5%)
 *
 * Honesty rules:
 *   - Fewer than MIN_TRADES_FOR_SCORE trades → no numeric score, only metrics.
 *   - A wallet that only buys (nothing closed) gets no score: there is no
 *     realized evidence of skill, exactly the trap the guides warn about.
 *   - `copyable` is a hard gate, not vibes: sample + realized share + positive
 *     expectancy + sane hold style must all pass.
 */

export const RATING_FORMULA_VERSION = "wallet-rating-v1";
export const RATING_WEIGHTS = {
  expectancy: 0.3,
  sample: 0.15,
  realizedShare: 0.2,
  profitFactor: 0.15,
  holdStyle: 0.1,
  consistency: 0.05,
  concentration: 0.05,
} as const;
export const MIN_TRADES_FOR_SCORE = 8;
/** Full sample score at 50+ trades (industry guidance: "dozens, not three"). */
const FULL_SAMPLE_TRADES = 50;
const HOLD_SECONDS_MIN = 300; // below 5 min is nearly impossible to mirror
const HOLD_SECONDS_MAX = 2_592_000; // 30 days — above this smells like bag-holding
const DAY = 86_400;

export interface WalletTrade {
  chain: string;
  wallet: string;
  token: string;
  tokenSymbol?: string;
  side: "buy" | "sell";
  priceUsd: number;
  volumeUsd: number;
  amount: string;
  time: number; // unix seconds
}

export interface WalletRating {
  version: string;
  score: number | null; // 0-100, null when there is not enough evidence
  copyable: boolean;
  verdict: string;
  metrics: {
    trades: number;
    tokensTraded: number;
    winRate: number | null; // 0-1 over closed tokens
    realizedPnlUsd: number;
    unrealizedPnlUsd: number | null;
    realizedShare: number | null; // realized / (realized + |unrealized|)
    expectancyUsd: number | null; // per closed trade
    expectancyPct: number | null; // vs average closed-trade size
    profitFactor: number | null; // gross win / gross loss
    avgHoldSeconds: number | null;
    topTokenShare: number | null; // best token PnL / total realized PnL
    consistentFirstHalf: boolean | null;
  };
  reasons: string[]; // human-readable, shown in the UI next to the score
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

interface TokenCycle {
  buyVolumeUsd: number;
  sellVolumeUsd: number;
  boughtQty: number;
  soldQty: number;
  firstBuyTs: number | null;
  lastSellTs: number | null;
  lastPriceUsd: number | null;
  lastTradeTs: number;
}

export function computeWalletRating(trades: WalletTrade[], now = Math.floor(Date.now() / 1000)): WalletRating | null {
  const clean = trades.filter((t) =>
    Number.isFinite(t.priceUsd) && t.priceUsd > 0 &&
    Number.isFinite(t.volumeUsd) && t.volumeUsd >= 0 &&
    (t.side === "buy" || t.side === "sell") &&
    Number.isFinite(t.time) && t.time > 0 && t.time <= now + 300);
  if (!clean.length) return null;
  clean.sort((a, b) => a.time - b.time);

  const WINDOW = 45 * DAY;
  const windowStart = now - WINDOW;

  // ── FIFO lot accounting per token ──
  // Each buy opens a lot; each sell consumes the OLDEST lots first. Every
  // matched buy+sell pair is one CLOSED TRADE with its own PnL and hold time.
  // This attributes round-trips correctly even when a wallet re-enters the
  // same token repeatedly (the aggregate-cycle model merged them all).
  const lots = new Map<string, { qty: number; costUsd: number; ts: number }[]>();
  const lastPrice = new Map<string, number>();
  const tokenPnl = new Map<string, number>(); // realized per token
  const tokenLastTs = new Map<string, number>(); // last realized sell per token
  const holdTimes: number[] = [];
  const closedTrades: { pnl: number; ts: number }[] = []; // per round-trip
  let grossWin = 0, grossLoss = 0, wins = 0, losses = 0;
  let closedTradeVolume = 0;
  let realizedPnl = 0, unrealizedPnl = 0, hasUnrealized = false;
  const tokensTraded = new Set<string>();

  for (const t of clean) {
    const key = `${t.chain}:${t.token}`;
    tokensTraded.add(key);
    lastPrice.set(key, t.priceUsd);
    const qty = Number(t.amount);
    const safeQty = Number.isFinite(qty) && qty > 0 ? qty : t.volumeUsd / t.priceUsd;
    const book = lots.get(key) ?? [];
    if (t.side === "buy") {
      book.push({ qty: safeQty, costUsd: t.volumeUsd, ts: t.time });
    } else {
      // Sell: consume oldest lots (FIFO). Sells without lots = bought before
      // our observation window → PnL unknown, NEVER counted as profit.
      let remaining = safeQty;
      while (remaining > 0 && book.length) {
        const lot = book[0]!;
        const take = Math.min(lot.qty, remaining);
        const ratio = take / lot.qty;
        const cost = lot.costUsd * ratio;
        const proceeds = t.volumeUsd * (take / safeQty);
        const pnl = proceeds - cost;
        realizedPnl += pnl;
        tokenPnl.set(key, (tokenPnl.get(key) ?? 0) + pnl);
        tokenLastTs.set(key, t.time);
        holdTimes.push(t.time - lot.ts);
        closedTrades.push({ pnl, ts: t.time });
        closedTradeVolume += cost + proceeds;
        if (pnl >= 0) { wins += 1; grossWin += pnl; } else { losses += 1; grossLoss += -pnl; }
        lot.qty -= take; lot.costUsd -= cost;
        remaining -= take;
        if (lot.qty <= 1e-12) book.shift();
      }
    }
    if (book.length) lots.set(key, book); else lots.delete(key);
  }

  // Open positions: paper PnL at last observed price.
  for (const [key, book] of lots) {
    if (!book.length) continue;
    hasUnrealized = true;
    const cost = book.reduce((a, l) => a + l.costUsd, 0);
    const qty = book.reduce((a, l) => a + l.qty, 0);
    const avgCost = qty > 0 ? cost / qty : 0;
    unrealizedPnl += ((lastPrice.get(key) ?? avgCost) - avgCost) * qty;
  }

  const tradesCount = clean.length;
  const closedCount = wins + losses;
  const winRate = closedCount > 0 ? wins / closedCount : null;
  const avgHold = median(holdTimes);
  const avgClosedTrade = closedCount > 0 ? closedTradeVolume / closedCount : null;
  const expectancy = closedCount > 0 ? (grossWin - grossLoss) / closedCount : null;
  const expectancyPct = expectancy !== null && avgClosedTrade ? expectancy / avgClosedTrade : null;
  const profitFactor = grossLoss > 0 ? Math.min(grossWin / grossLoss, 3) : grossWin > 0 ? 3 : null;
  const pnlValues = [...tokenPnl.values()];
  const totalRealizedAbs = pnlValues.reduce((a, b) => a + Math.abs(b), 0);
  const topTokenShare = totalRealizedAbs > 0 ? Math.max(...pnlValues) / totalRealizedAbs : null;

  // Consistency: were the OLDER closed trades also net-positive? Assessed per
  // closed round-trip (a single-token roller is still assessable). Null only
  // when there is no older half to compare — never faked.
  const firstHalfEnd = windowStart + WINDOW / 2;
  const older = closedTrades.filter((c) => c.ts < firstHalfEnd);
  const consistentFirstHalf: boolean | null = !closedTrades.length || !older.length
    ? null
    : older.reduce((a, c) => a + c.pnl, 0) > 0;

  // ── Scores ──
  const sampleScore = clamp01(tradesCount / FULL_SAMPLE_TRADES);
  const realizedTotal = realizedPnl + (hasUnrealized ? Math.abs(unrealizedPnl) : 0);
  const realizedShare = realizedTotal > 0 ? clamp01(Math.max(realizedPnl, 0) / realizedTotal) : null;
  const expectancyScore = expectancyPct !== null ? clamp01(0.5 + expectancyPct) : null;
  const holdScore: number | null = avgHold == null ? null
    : avgHold < 60 ? 0.1
    : avgHold < HOLD_SECONDS_MIN ? 0.4
    : avgHold <= HOLD_SECONDS_MAX ? 1
    : 0.5;
  const concentrationScore = topTokenShare === null ? null : clamp01(1 - topTokenShare * 0.8);

  const enoughEvidence = tradesCount >= MIN_TRADES_FOR_SCORE && closedCount >= 2;
  let score: number | null = null;
  if (enoughEvidence && expectancyScore !== null && realizedShare !== null && profitFactor !== null && holdScore !== null && concentrationScore !== null && consistentFirstHalf !== null) {
    score = Math.round(100 * (
      RATING_WEIGHTS.expectancy * expectancyScore +
      RATING_WEIGHTS.sample * sampleScore +
      RATING_WEIGHTS.realizedShare * realizedShare +
      RATING_WEIGHTS.profitFactor * (profitFactor / 3) +
      RATING_WEIGHTS.holdStyle * holdScore +
      RATING_WEIGHTS.consistency * (consistentFirstHalf ? 1 : 0.25) +
      RATING_WEIGHTS.concentration * concentrationScore
    ));
  }

  const copyable = score !== null
    && sampleScore >= 0.4
    && realizedShare !== null && realizedShare >= 0.5
    && (expectancy ?? -1) > 0
    && (holdScore ?? 0) >= 0.4;

  const reasons: string[] = [];
  if (tradesCount < MIN_TRADES_FOR_SCORE) reasons.push(`Solo ${tradesCount} trades observados — se necesita una muestra real (mín. ${MIN_TRADES_FOR_SCORE}).`);
  if (closedCount < 2) reasons.push("Casi nada cerrado: sin ventas no hay PnL realizado que demuestre habilidad (el paper profit se evapora).");
  if (winRate !== null) reasons.push(`Win rate ${(winRate * 100).toFixed(0)}% sobre ${closedCount} posiciones cerradas${profitFactor !== null ? ` · profit factor ${profitFactor.toFixed(2)}` : ""}.`);
  if (expectancy !== null && avgClosedTrade) reasons.push(`Expectativa ${(expectancyPct! * 100).toFixed(1)}% por trade cerrado.`);
  if (hasUnrealized && realizedTotal > 0 && realizedShare != null) reasons.push(`${(realizedShare * 100).toFixed(0)}% del PnL está realizado (lo demás es papel).`);
  if (avgHold != null) reasons.push(avgHold < HOLD_SECONDS_MIN
    ? "Hold times de segundos/minutos: casi imposible de copiar sin latencia de bot."
    : `Hold mediano ${(avgHold / 3600).toFixed(1)}h — copiable.`);
  if (topTokenShare !== null && topTokenShare > 0.7) reasons.push(`${(topTokenShare * 100).toFixed(0)}% del PnL viene de UN solo token: un moonshot, no una estrategia.`);

  const verdict = !enoughEvidence ? "EVIDENCIA INSUFICIENTE"
    : copyable ? (score! >= 70 ? "FUERTE — copiable" : score! >= 50 ? "DECENTE — copiable con cuidado" : "DÉBIL")
    : "NO RECOMENDADO PARA COPIAR";

  return {
    version: RATING_FORMULA_VERSION,
    score, copyable, verdict,
    metrics: {
      trades: tradesCount,
      tokensTraded: tokensTraded.size,
      winRate, realizedPnlUsd: Math.round(realizedPnl * 100) / 100,
      unrealizedPnlUsd: hasUnrealized ? Math.round(unrealizedPnl * 100) / 100 : null,
      realizedShare: realizedShare ?? null, expectancyUsd: expectancy, expectancyPct: expectancyPct ?? null,
      profitFactor, avgHoldSeconds: avgHold ?? null, topTokenShare: topTokenShare ?? null, consistentFirstHalf,
    },
    reasons,
  };
}
