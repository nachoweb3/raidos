/**
 * UNIVERSAL PAIRS — pair engine (pure domain model + synthetic relative math).
 *
 * Core insight: "ANY ASSET CAN BE THE NUMERAIRE FOR ANY OTHER ASSET". The pair
 * primitive is asset-agnostic (TOKEN / NFT collection / INDEX / VAULT…) and
 * pricing can be DIRECT (observed floor vs SOL via Magic Eden) or SYNTHETIC
 * (derived from two USD reference prices). Synthetic pairs are analytics-only
 * by definition: they are never presented as executable unless a real route
 * exists (the ROUTABLE flag is set by the routing layer, never here).
 *
 * NO fake data: every number flows from a named provider snapshot; missing
 * data stays missing (nulls propagate as "unavailable" upstream).
 */

// ── Asset & pair identity ────────────────────────────────────────────────

export type PairAssetKind =
  | "token"
  | "nft_collection"
  | "fractional_nft"
  | "index"
  | "vault"
  | "tokenized_asset";

export type PairMode = "synthetic" | "direct" | "routed";
export type PairLiquidityModel = "none" | "floor_liquidity" | "amm" | "vault";
export type PairBackingModel = "none" | "partial" | "full" | "overcollateralized" | "unknown";

export interface PairAsset {
  kind: PairAssetKind;
  /** Chain-scoped identity: CoinGecko coin id for tokens, ME symbol for collections. */
  id: string;
  chain?: string;
  symbol: string;
  name: string;
  image?: string | null;
  /** fractional_nft only: collection symbol the fractions claim to represent. */
  underlyingCollection?: string;
}

export interface PairDNA {
  base: PairAsset;
  quote: PairAsset;
  pairMode: PairMode;
  liquidityModel: PairLiquidityModel;
  backingModel: PairBackingModel;
  /** Real vault identity ONLY when a fractional protocol is verified; null otherwise. */
  vault: string | null;
  /** Named oracle sources, e.g. "magiceden+coingecko" or "coingecko". */
  oracle: string;
  /** "none" until a fractionalization protocol is verified live; else "protocol:<id>". */
  fractionalization: string;
  routing: "none" | "teleport";
  fees: { platformBps: number };
  restrictions: string[];
}

export function buildDNA(
  base: PairAsset,
  quote: PairAsset,
  opts: { pairMode: PairMode; oracle: string; liquidityModel?: PairLiquidityModel } ,
): PairDNA {
  return {
    base,
    quote,
    pairMode: opts.pairMode,
    liquidityModel: opts.liquidityModel ?? "none",
    backingModel: "none",
    vault: null,
    oracle: opts.oracle,
    fractionalization: "none",
    routing: "none",
    fees: { platformBps: 0 },
    restrictions:
      opts.pairMode === "synthetic"
        ? ["SYNTHETIC: analytics-only, derived from USD reference prices", "NO DIRECT LIQUIDITY"]
        : ["analytics; execution not enabled for this pair yet"],
  };
}

// ── Series primitives ────────────────────────────────────────────────────

export interface AssetSeriesPoint { time: number; priceUsd: number | null }
export type AssetSeries = AssetSeriesPoint[];

const finitePos = (x: unknown): x is number =>
  typeof x === "number" && Number.isFinite(x) && x > 0;

/** base/quote ratio at each aligned timestamp; null when either leg is missing. */
export function ratioSeries(base: AssetSeries, quote: AssetSeries): { time: number; ratio: number | null }[] {
  const qByTime = new Map<number, number | null>();
  for (const p of quote) qByTime.set(p.time, finitePos(p.priceUsd) ? p.priceUsd : null);
  return base.map((p) => {
    const q = qByTime.get(p.time);
    const ratio = finitePos(p.priceUsd) && q != null && finitePos(q) ? p.priceUsd / q : null;
    return { time: p.time, ratio };
  });
}

export interface RelativePoint { time: number; base: number; quote: number; relative: number }

/**
 * Normalize both legs to 100 at the start of the window; `relative` is
 * base/quote rebased the same way (100 = parity of performance). Returns null
 * when either leg lacks a valid starting price — never substitute fake 100s.
 */
export function relativeSeries(base: AssetSeries, quote: AssetSeries): RelativePoint[] | null {
  const qByTime = new Map<number, number | null>();
  for (const p of quote) qByTime.set(p.time, finitePos(p.priceUsd) ? p.priceUsd : null);
  let b0: number | null = null;
  let q0: number | null = null;
  for (const p of base) {
    const q = qByTime.get(p.time);
    if (finitePos(p.priceUsd) && q != null && finitePos(q)) { b0 = p.priceUsd; q0 = q; break; }
  }
  if (b0 == null || q0 == null) return null;
  const out: RelativePoint[] = [];
  for (const p of base) {
    const q = qByTime.get(p.time);
    if (!finitePos(p.priceUsd) || q == null || !finitePos(q)) continue;
    out.push({
      time: p.time,
      base: (p.priceUsd / b0) * 100,
      quote: (q / q0) * 100,
      relative: ((p.priceUsd / b0) / (q / q0)) * 100,
    });
  }
  return out.length >= 2 ? out : null;
}

// ── Stats & momentum ─────────────────────────────────────────────────────

/** % change of the first→last finite value over the series. */
export function changePct(values: (number | null)[]): number | null {
  let first: number | null = null;
  let last: number | null = null;
  for (const v of values) {
    if (!finitePos(v)) continue;
    if (first == null) first = v;
    last = v;
  }
  if (first == null || last == null) return null;
  return ((last - first) / first) * 100;
}

/** Latest ratio of the series, or null. */
export function currentRatio(base: AssetSeries, quote: AssetSeries): number | null {
  const qByTime = new Map<number, number | null>();
  for (const p of quote) qByTime.set(p.time, finitePos(p.priceUsd) ? p.priceUsd : null);
  for (let i = base.length - 1; i >= 0; i--) {
    const p = base[i]!;
    const q = qByTime.get(p.time);
    if (finitePos(p.priceUsd) && q != null && finitePos(q)) return p.priceUsd / q;
  }
  return null;
}

export interface PairMomentum {
  /** Relative performance (base minus quote, in percentage points) over the window. */
  relativePerfPct: number | null;
  /** Ratio change over the window (synthetic "pair price" change). */
  ratioChangePct: number | null;
  relativeBreakout: boolean;
}

/**
 * Momentum with visible conditions — never a mysterious score. A relative
 * breakout means the base outperformed the quote by >= 5 points AND the ratio
 * rose >= 3% over the window (raw thresholds, shown to the user upstream).
 */
export function pairMomentum(base: AssetSeries, quote: AssetSeries): PairMomentum {
  const rel = relativeSeries(base, quote);
  const relativePerfPct = rel ? (rel[rel.length - 1]!.base - rel[rel.length - 1]!.quote) : null;
  const ratios = ratioSeries(base, quote).map((r) => r.ratio);
  const ratioChangePct = changePct(ratios);
  return {
    relativePerfPct,
    ratioChangePct,
    relativeBreakout:
      relativePerfPct != null && ratioChangePct != null && relativePerfPct >= 5 && ratioChangePct >= 3,
  };
}

// ── Pair intelligence ────────────────────────────────────────────────────

export interface QuoteLeg { id: string; symbol: string; changePct: number | null }
export interface PairIntelligence {
  baseSymbol: string;
  baseChangePct: number | null;
  outperforming: { id: string; symbol: string; diffPp: number }[];
  underperforming: { id: string; symbol: string; diffPp: number }[];
}

/**
 * "What is this asset actually outperforming?" — compares the base's USD
 * change against every benchmark leg's USD change over the same window.
 * Legs with unknown change are skipped (never counted as 0).
 */
export function pairIntelligence(baseChangePct: number | null, benchmarks: QuoteLeg[]): PairIntelligence | null {
  if (baseChangePct == null || !Number.isFinite(baseChangePct)) return null;
  const outperforming: PairIntelligence["outperforming"] = [];
  const underperforming: PairIntelligence["underperforming"] = [];
  for (const b of benchmarks) {
    if (b.changePct == null || !Number.isFinite(b.changePct) || !b.symbol) continue;
    const diff = baseChangePct - b.changePct;
    const entry = { id: b.id, symbol: b.symbol, diffPp: Math.round(diff * 100) / 100 };
    (diff >= 0 ? outperforming : underperforming).push(entry);
  }
  return { baseSymbol: "", baseChangePct, outperforming, underperforming };
}
