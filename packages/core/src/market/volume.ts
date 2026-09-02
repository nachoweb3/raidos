/**
 * 📊 VOLUME INTELLIGENCE — RaidOS market layer
 * Turns provider data into a readable card, a trend verdict, and
 * threshold-based alerts (volume spike / whale / liquidity / price).
 * Never fabricates data: anything not provided by the source is omitted.
 */

import type { TokenStats } from "./providers.js";

// ── Formatting helpers ─────────────────────────────────────────────────────

export function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "$0";
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  if (abs >= 1) return `$${n.toFixed(2)}`;
  // sub-dollar: keep significant digits
  return `$${n.toPrecision(3)}`;
}

export function fmtPrice(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "$0";
  return `$${n.toPrecision(4)}`;
}

export function fmtPct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "n/a";
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

export function abbreviateWallet(addr: string): string {
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

// ── Card ───────────────────────────────────────────────────────────────────

export function trendVerdict(stats: TokenStats, prev?: TokenStats): { label: string; emoji: string } {
  // Compare 1h change against 24h change when both exist: acceleration = 1h pace above 24h pace.
  if (stats.change1hPct !== null && stats.change24hPct !== null && stats.change24hPct !== 0) {
    const accelerating = stats.change1hPct > stats.change24hPct / 24;
    if (stats.change1hPct > 0 && accelerating) return { label: "ACCELERATING", emoji: "🔥" };
    if (stats.change1hPct < 0 && !accelerating) return { label: "COOLING", emoji: "🧊" };
    return { label: "STEADY", emoji: "➡️" };
  }
  // Fallback: snapshot-to-snapshot volume delta.
  if (prev && prev.volume24hUsd > 0) {
    const delta = (stats.volume24hUsd - prev.volume24hUsd) / prev.volume24hUsd;
    if (delta >= 0.25) return { label: "ACCELERATING", emoji: "🔥" };
    if (delta <= -0.25) return { label: "COOLING", emoji: "🧊" };
  }
  return { label: "STEADY", emoji: "➡️" };
}

export function volumeCard(stats: TokenStats, prev?: TokenStats): string {
  const t = trendVerdict(stats, prev);
  const lines: string[] = [
    `📊 $${stats.symbol} MARKET INTELLIGENCE`,
    "━━━━━━━━━━━━━━━━━━━",
    `Price: ${fmtPrice(stats.priceUsd)}`,
    `24H Volume: ${fmtUsd(stats.volume24hUsd)}`,
    `Liquidity: ${fmtUsd(stats.liquidityUsd)}`,
  ];
  if (stats.buys24h !== null && stats.sells24h !== null) {
    lines.push(`Buys: ${stats.buys24h.toLocaleString("en-US")}`);
    lines.push(`Sells: ${stats.sells24h.toLocaleString("en-US")}`);
    lines.push(`Buy/Sell: ${(stats.buys24h / Math.max(1, stats.sells24h)).toFixed(2)}`);
  } else if (stats.txns24h !== null) {
    lines.push(`Transactions: ${stats.txns24h.toLocaleString("en-US")}`);
  }
  if (stats.holders !== null) lines.push(`Holders: ${stats.holders.toLocaleString("en-US")}`);
  lines.push(`24H Change: ${fmtPct(stats.change24hPct)}`);
  lines.push(`Volume trend: ${t.emoji} ${t.label}`);
  lines.push("", `📡 Source: ${stats.source}`);
  return lines.join("\n");
}

// ── Alert rules (pure functions) ───────────────────────────────────────────

export interface VolumeAlertThresholds {
  /** Volume spike when recent 1h-equivalent volume exceeds this multiple of baseline. */
  spikeMultiple: number;
  /** Whale trade when USD size exceeds this share of liquidity. */
  whaleLiquidityShare: number;
  /** Liquidity change alert at this relative delta. */
  liquidityDeltaPct: number;
  /** Price breakout/drop at this 1h change. */
  priceMove1hPct: number;
  /** Liquidity drain (exit) alert at this relative drop. */
  drainPct: number;
}

export const DEFAULT_ALERT_THRESHOLDS: VolumeAlertThresholds = {
  spikeMultiple: 2.5,
  whaleLiquidityShare: 0.05,
  liquidityDeltaPct: 20,
  priceMove1hPct: 10,
  drainPct: -30,
};

export interface MarketAlert {
  kind: "volume_spike" | "whale_buy" | "whale_sell" | "liquidity_change" | "price_breakout" | "price_drop" | "liquidity_drain";
  text: string;
}

function pctDelta(now: number, base: number): number {
  if (base === 0) return 0;
  return ((now - base) / Math.abs(base)) * 100;
}

/**
 * Compare current stats against a baseline snapshot.
 * `baseline1hVolumeUsd` is the trailing average 1h volume (24h/24).
 */
export function detectAlerts(
  stats: TokenStats,
  prev: TokenStats | undefined,
  thresholds: VolumeAlertThresholds = DEFAULT_ALERT_THRESHOLDS
): MarketAlert[] {
  const alerts: MarketAlert[] = [];

  // Volume spike: current 24h volume vs baseline hourly average requires history;
  // with a snapshot we compare against the previous snapshot's 24h volume.
  if (prev && prev.volume24hUsd > 0) {
    const delta = pctDelta(stats.volume24hUsd, prev.volume24hUsd);
    if (delta >= (thresholds.spikeMultiple - 1) * 100) {
      alerts.push({
        kind: "volume_spike",
        text: [
          "🔥 VOLUME SPIKE",
          `$${stats.symbol}`,
          `Volume: ${fmtUsd(stats.volume24hUsd)} (was ${fmtUsd(prev.volume24hUsd)})`,
          `Increase: ${fmtPct(delta)}`,
          "Possible reasons: social activity · large buyers · campaign activity · market-wide movement",
        ].join("\n"),
      });
    }
  }

  // Liquidity change / drain
  if (prev && prev.liquidityUsd > 0) {
    const delta = pctDelta(stats.liquidityUsd, prev.liquidityUsd);
    if (delta <= thresholds.drainPct) {
      alerts.push({
        kind: "liquidity_drain",
        text: ["🚨 LIQUIDITY DRAIN", `$${stats.symbol}`, `Liquidity: ${fmtUsd(stats.liquidityUsd)} (was ${fmtUsd(prev.liquidityUsd)})`, `Change: ${fmtPct(delta)}`].join("\n"),
      });
    } else if (Math.abs(delta) >= thresholds.liquidityDeltaPct) {
      alerts.push({
        kind: "liquidity_change",
        text: ["💧 LIQUIDITY CHANGE", `$${stats.symbol}`, `Liquidity: ${fmtUsd(stats.liquidityUsd)} (was ${fmtUsd(prev.liquidityUsd)})`, `Change: ${fmtPct(delta)}`].join("\n"),
      });
    }
  }

  // Price move (1h)
  if (stats.change1hPct !== null) {
    if (stats.change1hPct >= thresholds.priceMove1hPct) {
      alerts.push({
        kind: "price_breakout",
        text: ["📈 PRICE BREAKOUT", `$${stats.symbol}`, `Price: ${fmtPrice(stats.priceUsd)}`, `1H Change: ${fmtPct(stats.change1hPct)}`].join("\n"),
      });
    } else if (stats.change1hPct <= -thresholds.priceMove1hPct) {
      alerts.push({
        kind: "price_drop",
        text: ["📉 PRICE DROP", `$${stats.symbol}`, `Price: ${fmtPrice(stats.priceUsd)}`, `1H Change: ${fmtPct(stats.change1hPct)}`].join("\n"),
      });
    }
  }

  return alerts;
}

/** Whale check for a single trade. Size in USD; returns an alert or null. */
export function whaleAlert(
  stats: TokenStats,
  trade: { side: "buy" | "sell"; usd: number; wallet: string },
  thresholds: VolumeAlertThresholds = DEFAULT_ALERT_THRESHOLDS
): MarketAlert | null {
  if (stats.liquidityUsd <= 0) return null;
  const share = trade.usd / stats.liquidityUsd;
  if (share < thresholds.whaleLiquidityShare) return null;
  const emoji = trade.side === "buy" ? "🐋" : "🐋";
  return {
    kind: trade.side === "buy" ? "whale_buy" : "whale_sell",
    text: [
      `${emoji} WHALE ${trade.side.toUpperCase()}`,
      `$${stats.symbol}`,
      `${trade.side === "buy" ? "BUY" : "SELL"} ${fmtUsd(trade.usd)}`,
      `Wallet: \`${abbreviateWallet(trade.wallet)}\``,
      `Liquidity: ${fmtUsd(stats.liquidityUsd)}`,
      `Trade size: ${(share * 100).toFixed(1)}% of liquidity`,
    ].join("\n"),
  };
}

/** Baseline hourly volume (24h/24) used for spike math in pollers. */
export function baselineHourlyVolume(stats: TokenStats): number {
  return stats.volume24hUsd / 24;
}
