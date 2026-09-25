/**
 * UNIVERSAL PAIRS — pair service.
 *
 * Resolves pair identifiers ("mad_lads/wrapped-sol", "pudgy-penguins/bitcoin"…),
 * builds Pair DNA, computes the synthetic/DIRECT analytics from snapshot
 * series, and lists curated pairs for discovery (trending/relative movers…).
 *
 * Honesty rules baked in:
 *  - A pair without two live price legs reports unavailable legs, not zeros.
 *  - Synthetic pairs are analytics-only (restrictions say so in the DNA).
 *  - Relative history needs >= 2 aligned snapshots per leg; otherwise null.
 *  - NFT floors are the OBSERVED Magic Eden floor in SOL; no invented depth.
 */
import {
  buildDNA, currentRatio, pairIntelligence, pairMomentum, ratioSeries, relativeSeries,
  type AssetSeries, type PairAsset, type PairDNA, type QuoteLeg,
} from "./pair-engine.js";
import { NFT_COLLECTIONS, QUOTE_TOKENS, PairPriceService, type NftStats } from "./pair-prices.js";

const SOL_ASSET: PairAsset = { kind: "token", id: "wrapped-sol", chain: "solana", symbol: "SOL", name: "Solana" };

const BENCHMARK_IDS = ["wrapped-sol", "ethereum", "bitcoin", "nvidia-xstock", "usd-coin"];
/** CoinGecko id per pair-asset id ("wrapped-sol" → "solana" after CG retired the slug). */
const CG_ID_BY_PAIR_ID = new Map(QUOTE_TOKENS.map((t) => [t.id, t.coingeckoId]));

export const ALL_ASSETS: PairAsset[] = [
  ...NFT_COLLECTIONS,
  ...QUOTE_TOKENS.map(({ coingeckoId, ...rest }) => rest),
];

const byId = new Map(ALL_ASSETS.map((a) => [a.id, a]));

export function findAsset(id: string): PairAsset | undefined {
  return byId.get(id);
}

/** Accept "mad_lads/wrapped-sol", "MAD / SOL", "claynosaurz/eth". */
export function parsePairId(raw: string): { baseId: string; quoteId: string } | null {
  const parts = raw.split("/").map((s) => s.trim().toLowerCase());
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { baseId: parts[0], quoteId: parts[1] };
}

/** Resolve an asset by id or by (case-insensitive) symbol — for "MAD/SOL" style input. */
export function resolveAsset(token: string): PairAsset | undefined {
  const t = token.trim().toLowerCase();
  return byId.get(t) ?? ALL_ASSETS.find((a) => a.symbol.toLowerCase() === t);
}

export interface PairSummary {
  id: string;
  baseAsset: PairAsset;
  quoteAsset: PairAsset;
  pairMode: "synthetic" | "direct";
  oracle: string;
  ratio: number | null;
  ratioChange24hPct: number | null;
  relativePerf24hPct: number | null;
  relativeBreakout: boolean;
  basePriceUsd: number | null;
  quotePriceUsd: number | null;
  /** DIRECT pairs: observed floor in quote units; synthetic: null. */
  directPrice: number | null;
  seriesPoints: number;
}

export interface PairDetail extends PairSummary {
  dna: PairDNA;
  relative: { time: number; base: number; quote: number; relative: number }[] | null;
  ratioSeries: { time: number; ratio: number | null }[] | null;
  legs: {
    base: { asset: PairAsset; priceUsd: number | null; priceSol: number | null; change24hPct: number | null; source: string };
    quote: { asset: PairAsset; priceUsd: number | null; priceSol: number | null; change24hPct: number | null; source: string };
  };
  nft: { floorSol: number | null; listedCount: number | null; avgPrice24hrSol: number | null; volume7dSol: number | null } | null;
  intelligence: ReturnType<typeof pairIntelligence> | null;
}

export class PairService {
  constructor(
    private readonly prices: PairPriceService,
    private readonly getAssetChange24h: (coingeckoId: string) => number | null,
  ) {}

  /**
   * USD series for a leg. Collections are observed in SOL (floor) → converted
   * to USD by aligning each snapshot with the SOL/USD snapshot at the same ts;
   * timestamps without a SOL/USD price become null (never guessed).
   */
  private usdSeries(asset: PairAsset, sinceTs: number): AssetSeries {
    const raw = this.prices.seriesFor(asset, sinceTs);
    if (asset.kind !== "nft_collection") return raw;
    const sol = this.prices.seriesFor(SOL_ASSET, sinceTs);
    const solByTs = new Map(sol.map((p) => [p.time, p.priceUsd]));
    return raw.map((p) => {
      const solUsd = solByTs.get(p.time);
      return { time: p.time, priceUsd: p.priceUsd != null && solUsd != null ? p.priceUsd * solUsd : null };
    });
  }

  /** Current quotes for every tracked asset (one batched CG call + cached ME floors). */
  async quotes(): Promise<Map<string, { priceUsd: number | null; priceSol: number | null; change24hPct: number | null }>> {
    const out = new Map<string, { priceUsd: number | null; priceSol: number | null; change24hPct: number | null }>();
    let cg: Map<string, { priceUsd: number | null; change24hPct: number | null }> = new Map();
    try { cg = await this.prices.tokenPrices(QUOTE_TOKENS.map((t) => t.coingeckoId)); } catch { /* errors surface per-pair */ }
    for (const t of QUOTE_TOKENS) {
      const row = cg.get(t.coingeckoId);
      out.set(t.id, { priceUsd: row?.priceUsd ?? null, priceSol: null, change24hPct: row?.change24hPct ?? null });
    }
    // NFT collections: latest persisted snapshot (SOL floor). The refresh loop
    // keeps them fresh; the API never blocks on 5 ME calls per request.
    for (const c of NFT_COLLECTIONS) {
      const last = this.prices.latestFor(c);
      out.set(c.id, { priceUsd: last?.priceUsd ?? null, priceSol: last?.priceSol ?? null, change24hPct: null });
    }
    return out;
  }

  async buildSummary(base: PairAsset, quote: PairAsset, windowTs: number): Promise<PairSummary> {
    const [baseSeries, quoteSeries] = [this.usdSeries(base, windowTs), this.usdSeries(quote, windowTs)];
    const ratio = currentRatio(baseSeries, quoteSeries);
    const momentum = pairMomentum(baseSeries, quoteSeries);
    const quoteQ = (await this.quotes()).get(quote.id);
    const isDirect = base.kind === "nft_collection" && quote.id === "wrapped-sol";
    // Direct NFT/SOL price = the observed floor itself (SOL per 1 NFT).
    const direct = isDirect ? this.prices.latestFor(base)?.priceSol ?? null : null;
    return {
      id: `${base.id}/${quote.id}`,
      baseAsset: base,
      quoteAsset: quote,
      pairMode: isDirect ? "direct" : "synthetic",
      oracle: isDirect ? "magiceden+coingecko" : "coingecko:synthetic",
      ratio,
      ratioChange24hPct: momentum.ratioChangePct,
      relativePerf24hPct: momentum.relativePerfPct,
      relativeBreakout: momentum.relativeBreakout,
      basePriceUsd: basePriceUsdOf(base, ratio, quoteQ?.priceUsd ?? null),
      quotePriceUsd: quoteQ?.priceUsd ?? null,
      directPrice: direct,
      seriesPoints: Math.min(baseSeries.length, quoteSeries.length),
    };
  }

  /** Detail for the pair terminal: series, DNA, legs, NFT stats, intelligence. */
  async detail(pairId: string, sinceTs: number): Promise<PairDetail> {
    const parsed = parsePairId(pairId);
    if (!parsed) throw new Error("invalid pair id (expected base/quote)");
    const base = resolveAsset(parsed.baseId);
    const quote = resolveAsset(parsed.quoteId);
    if (!base || !quote) throw new Error("unknown asset in pair");
    if (base.id === quote.id) throw new Error("base and quote must differ");

    const [baseSeries, quoteSeries] = [this.usdSeries(base, sinceTs), this.usdSeries(quote, sinceTs)];
    const rel = relativeSeries(baseSeries, quoteSeries);
    const ratios = ratioSeries(baseSeries, quoteSeries);
    const momentum = pairMomentum(baseSeries, quoteSeries);
    const quotes = await this.quotes();
    const isDirect = base.kind === "nft_collection" && quote.id === "wrapped-sol";

    // Pair intelligence: base USD change vs benchmark legs (same CG batch).
    const benchLegs: QuoteLeg[] = [];
    let cg: Map<string, { priceUsd: number | null; change24hPct: number | null }> = new Map();
    try { cg = await this.prices.tokenPrices(QUOTE_TOKENS.map((t) => t.coingeckoId)); } catch { /* unavailable stays unavailable */ }
    const baseChangePct = base.kind === "nft_collection" ? null
      : cg.get(CG_ID_BY_PAIR_ID.get(base.id) ?? base.id)?.change24hPct ?? null;
    for (const id of BENCHMARK_IDS) {
      if (id === base.id) continue; // never compare an asset against itself
      const asset = QUOTE_TOKENS.find((t) => t.id === id);
      if (!asset) continue;
      benchLegs.push({ id, symbol: asset.symbol, changePct: cg.get(asset.coingeckoId)?.change24hPct ?? null });
    }

    let nft: PairDetail["nft"] = null;
    if (base.kind === "nft_collection") {
      try {
        const stats: NftStats = await this.prices.nftStats(base.id);
        nft = { floorSol: stats.floorSol, listedCount: stats.listedCount, avgPrice24hrSol: stats.avgPrice24hrSol, volume7dSol: stats.volume7dSol };
      } catch { /* stats unavailable stays unavailable */ }
    }

    const dna = buildDNA(base, quote, {
      pairMode: isDirect ? "direct" : "synthetic",
      oracle: isDirect ? "magiceden+coingecko" : "coingecko:synthetic",
      liquidityModel: isDirect ? "floor_liquidity" : "none",
    });

    const summary = await this.buildSummary(base, quote, sinceTs);
    return {
      ...summary,
      dna,
      relative: rel,
      // Expose the ratio series only when it carries real data (≥2 non-null
      // ratios); all-null arrays would render an empty chart pretending to be
      // a market.
      ratioSeries: ratios.filter((r) => r.ratio != null).length >= 2 ? ratios : null,
      legs: {
        base: { asset: base, priceUsd: quotes.get(base.id)?.priceUsd ?? null, priceSol: quotes.get(base.id)?.priceSol ?? null, change24hPct: baseChangePct, source: isDirect ? "magiceden" : "coingecko" },
        quote: { asset: quote, priceUsd: quotes.get(quote.id)?.priceUsd ?? null, priceSol: quotes.get(quote.id)?.priceSol ?? null, change24hPct: cg.get(CG_ID_BY_PAIR_ID.get(quote.id) ?? quote.id)?.change24hPct ?? null, source: "coingecko" },
      },
      nft,
      intelligence: pairIntelligence(baseChangePct, benchLegs),
    };
  }

  /** Discovery list: curated pairs + honest availability + relative movers first. */
  async list(kind: string, limit: number): Promise<{ pairs: PairSummary[]; kind: string }> {
    const sinceTs = Math.floor(Date.now() / 1000) - 86400;
    const combos: [PairAsset, PairAsset][] = [];
    for (const c of NFT_COLLECTIONS) {
      for (const q of QUOTE_TOKENS) {
        if (q.id === "usd-coin") continue; // USD view exists everywhere; keep the matrix meaningful
        combos.push([c, q]);
      }
    }
    const pairs: PairSummary[] = [];
    for (const [b, q] of combos.slice(0, limit * 3)) {
      try { pairs.push(await this.buildSummary(b, q, sinceTs)); }
      catch { /* a pair with unavailable legs is skipped from discovery */ }
    }
    let filtered = pairs;
    if (kind === "nft-token") filtered = pairs.filter((p) => p.pairMode === "direct");
    if (kind === "synthetic") filtered = pairs.filter((p) => p.pairMode === "synthetic");
    if (kind === "relative-movers") {
      filtered = pairs.filter((p) => p.relativePerf24hPct != null).sort(
        (x, y) => Math.abs(y.relativePerf24hPct!) - Math.abs(x.relativePerf24hPct!),
      );
    }
    if (kind === "relative-breakout") filtered = pairs.filter((p) => p.relativeBreakout);
    return { pairs: filtered.slice(0, limit), kind };
  }
}

function basePriceUsdOf(base: PairAsset, ratio: number | null, quoteUsd: number | null): number | null {
  if (ratio != null && quoteUsd != null) return ratio * quoteUsd;
  return null;
}
