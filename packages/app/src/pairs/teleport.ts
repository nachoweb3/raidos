/**
 * UNIVERSAL PAIRS — Liquidity Teleport (routing abstraction).
 *
 * Job: find the best EXECUTABLE path between pair assets and say honestly when
 * none exists. The pair layer derives analytics for ANY asset combination;
 * Teleport answers the separate question "can this actually be traded, and
 * through which real legs?".
 *
 * Graph edges (real liquidity only):
 *  - token→token on the same chain: quoted live via the existing TradingEngine
 *    (Jupiter on Solana, 0x v2 on Ethereum/Base, Li.Fi on Arc).
 *  - NFT collections: the floor leg is OBSERVED via real Magic Eden listings
 *    (FloorLiquidityService, with a rarity guard) and reported as FLOOR_READY —
 *    an honest middle state. Buying the floor requires signing Magic Eden's
 *    on-chain program (gated by their API key), so a FLOOR_READY route is never
 *    presented as executable.
 *
 * Every leg carries its own price impact; totals and fees are computed, never
 * guessed. When a hop cannot be quoted the path is reported as NOT_ROUTABLE
 * with the failing leg named — no synthetic legs, no invented outputs.
 */
import { TradingEngine } from "../trading/engine.js";
import { CHAINS } from "../chains/config.js";
import { FloorLiquidityService, DEFAULT_MAX_RANK, type FloorSnapshot } from "./floor-liquidity.js";
import { hasVerifiedVault } from "./pair-fractional.js";
import type { PairAsset } from "./pair-engine.js";

/** Canonical on-chain token per pair-asset id that is actually executable. */
export const EXECUTABLE_TOKENS: Record<string, { chain: string; mint: string; decimals: number }> = {
  "wrapped-sol": { chain: "solana", mint: "So11111111111111111111111111111111111111112", decimals: 9 },
  "usd-coin": { chain: "solana", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
  // CoinGecko "ethereum" asset maps to WETH on the ethereum chain (0x quotes
  // the wrapped address; native ETH is addressed via the sentinel).
  ethereum: { chain: "ethereum", mint: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18 },
  // Bitcoin has no direct Solana/EVM token in this phase — it is analytics-only.
};

export const INTERMEDIATE_HUBS = ["usd-coin", "wrapped-sol", "ethereum"];

export type LegExecutability = "executable" | "floor_ready" | "route_pending";

export interface TeleportLeg {
  from: string; // pair-asset id
  to: string;
  kind: LegExecutability;
  chain?: string;
  sellToken?: string;
  buyToken?: string;
  amountIn?: string;
  amountOut?: string;
  priceImpactPct?: number | null;
  venue?: string;
  error?: string;
}

export interface TeleportRoute {
  status: "ROUTABLE" | "FLOOR_READY" | "NO_ROUTE";
  hops: number;
  legs: TeleportLeg[];
  totalImpactPct: number | null;
  feeUsdc: string | null;
  minOutAmount?: string;
  reason?: string;
  /** FLOOR_READY: the real observed floor listing (mint/price/rarity). */
  floor?: FloorSnapshot | null;
}

export interface TeleportDeps {
  trading?: TradingEngine;
  /** Wallet that anchors price-only quotes (0x taker). Optional. */
  taker?: string;
  /** Real Magic Eden listings provider (floor liquidity). Optional for tests. */
  floors?: Pick<FloorLiquidityService, "floorFor">;
  /** Rarity guard cap used when the API request omits maxRank. */
  defaultMaxRank?: number;
}

/** Pair asset → executable chain token, or null when not yet tradable. */
export function executableTokenFor(asset: PairAsset): { chain: string; mint: string; decimals: number } | null {
  return EXECUTABLE_TOKENS[asset.id] ?? null;
}

/** Accepts 1..1,000,000; anything else falls back to the configured default. */
export function clampMaxRank(raw: string | null | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 1_000_000 ? n : fallback;
}
// ^ maxRank = the top-N rarest pieces excluded from floor attribution.

/** Honest reason when the floor leg exists but no listing passed the guard. */
export function floorUnavailableReason(snap: FloorSnapshot, maxRank: number): string {
  if (snap.listingsObserved === 0) return `${snap.collection}: sin listados vivos en Magic Eden ahora mismo`;
  if (snap.excludedByRarity > 0) {
    return `${snap.collection}: ${snap.excludedByRarity} de ${snap.listingsObserved} listados son piezas del top-${maxRank} más raras (guard de rareza) — ese "floor" no representa la salida líquida de la colección`;
  }
  return `${snap.collection}: ningún listado superó el guard de rareza (top ${maxRank} más raras excluidas)`;
}

export class TeleportEngine {
  private readonly trading: TradingEngine;
  private readonly taker?: string;
  private readonly floors: Pick<FloorLiquidityService, "floorFor"> | null;
  private readonly defaultMaxRank: number;

  constructor(deps: TeleportDeps = {}) {
    this.trading = deps.trading ?? new TradingEngine();
    this.taker = deps.taker;
    this.floors = deps.floors ?? null;
    this.defaultMaxRank = deps.defaultMaxRank ?? DEFAULT_MAX_RANK;
  }

  /** Quote one token→token leg live through the existing trading stack. */
  private async quoteLeg(fromId: string, toId: string, amount: string): Promise<TeleportLeg> {
    const a = EXECUTABLE_TOKENS[fromId];
    const b = EXECUTABLE_TOKENS[toId];
    if (!a || !b || a.chain !== b.chain) {
      return { from: fromId, to: toId, kind: "route_pending", error: "no executable market for this leg" };
    }
    try {
      const quote = await this.trading.getQuote({
        userId: 0, // price-only quote; execution always re-quotes with the real user
        type: "swap",
        fromChain: a.chain,
        toChain: b.chain,
        sellToken: a.mint,
        buyToken: b.mint,
        amount,
        taker: this.taker,
      });
      return {
        from: fromId,
        to: toId,
        kind: "executable",
        chain: a.chain,
        sellToken: a.mint,
        buyToken: b.mint,
        amountIn: quote.sellAmount,
        amountOut: quote.buyAmount,
        priceImpactPct: quote.priceImpact != null && quote.priceImpact !== "" ? Number(quote.priceImpact) * 100 : null,
        venue: quote.aggregator,
      };
    } catch (e) {
      return { from: fromId, to: toId, kind: "route_pending", chain: a.chain, error: String((e as Error).message).slice(0, 160) };
    }
  }

  /**
   * Find the best path base→quote: direct leg first, then one hub
   * (base→hub→quote). Depth is capped at 2 hops — deeper paths multiply
   * slippage and fee opacity without adding real reach here.
   *
   * `maxRankRaw` (raw query param) feeds the NFT rarity guard for floor legs.
   */
  async findRoute(base: PairAsset, quote: PairAsset, amountIn: string, maxRankRaw?: string | null): Promise<TeleportRoute> {
    const a = executableTokenFor(base);
    const b = executableTokenFor(quote);

    if (!a || !b) {
      // NFT collections get an honest middle state: the floor leg EXISTS
      // (verified against real Magic Eden listings) and the rarity guard is
      // enforced — but buying the floor requires signing Magic Eden's on-chain
      // program (gated by their API key), so execution stays disabled and the
      // route can never be presented as executable.
      if (!a && base.kind === "nft_collection") {
        const maxRank = clampMaxRank(maxRankRaw, this.defaultMaxRank);
        if (!this.floors) {
          return {
            status: "NO_ROUTE", hops: 0, legs: [], totalImpactPct: null, feeUsdc: null,
            reason: `${base.symbol}: proveedor de floor no configurado`,
          };
        }
        const snap = await this.floors.floorFor(base.id, maxRank);
        return this.floorReadyRoute(base, quote, maxRank, snap);
      }
      // Fractional legs without a verified vault never route — the reason says
      // exactly what is missing (registry in pair-fractional.ts is the truth).
      if (!a && base.kind === "fractional_nft" && !hasVerifiedVault(base)) {
        return {
          status: "NO_ROUTE", hops: 0, legs: [], totalImpactPct: null, feeUsdc: null,
          reason: `${base.symbol}: fractionalization sin protocolo verificado en vivo — no hay vault ni backing real`,
        };
      }
      if (!b && quote.kind === "fractional_nft" && !hasVerifiedVault(quote)) {
        return {
          status: "NO_ROUTE", hops: 0, legs: [], totalImpactPct: null, feeUsdc: null,
          reason: `${quote.symbol}: fractionalization sin protocolo verificado en vivo — no hay vault ni backing real`,
        };
      }
      // Quote-side NFT (e.g. SOL/MAD): selling the floor also requires signing
      // Magic Eden's program — name that instead of a generic "no market".
      return {
        status: "NO_ROUTE",
        hops: 0,
        legs: [],
        totalImpactPct: null,
        feeUsdc: null,
        reason: !a && !b ? "ninguna pata es ejecutable todavía (floor liquidity y fractionalization en fases siguientes)"
          : !a ? `${base.symbol}: sin mercado ejecutable conocido`
          : !b && quote.kind === "nft_collection"
            ? `${quote.symbol}: venta de NFT no habilitada todavía (comprar/vender el floor exige firmar el programa on-chain de Magic Eden)`
            : `${quote.symbol}: sin mercado ejecutable conocido`,
      };
    }

    // 1) Direct leg.
    if (a.chain === b.chain) {
      const direct = await this.quoteLeg(base.id, quote.id, amountIn);
      if (direct.kind === "executable") {
        return this.finish([direct]);
      }
    }

    // 2) One hub (same chain on both sides of the hub).
    for (const hubId of INTERMEDIATE_HUBS) {
      if (hubId === base.id || hubId === quote.id) continue;
      const h1 = EXECUTABLE_TOKENS[hubId];
      if (!h1 || h1.chain !== a.chain || h1.chain !== b.chain) continue;
      const leg1 = await this.quoteLeg(base.id, hubId, amountIn);
      if (leg1.kind !== "executable") continue;
      const leg2 = await this.quoteLeg(hubId, quote.id, leg1.amountOut!);
      if (leg2.kind !== "executable") continue;
      return this.finish([leg1, leg2]);
    }

    return {
      status: "NO_ROUTE",
      hops: 0,
      legs: [],
      totalImpactPct: null,
      feeUsdc: null,
      reason: `sin liquidez encadenable ${base.symbol}→${quote.symbol} en ${a.chain} (se intentaron hubs ${INTERMEDIATE_HUBS.join(", ")})`,
    };
  }

  /**
   * FLOOR_READY only when a real listing passed the rarity guard; otherwise
   * NO_ROUTE with the named reason and the observed snapshot attached — never
   * a "ready" label without a real floor behind it.
   */
  private floorReadyRoute(base: PairAsset, quote: PairAsset, maxRank: number, snap: FloorSnapshot): TeleportRoute {
    const floor = snap.floor;
    if (!floor) {
      return {
        status: "NO_ROUTE",
        hops: 0,
        legs: [],
        totalImpactPct: null,
        feeUsdc: null,
        floor: snap,
        reason: floorUnavailableReason(snap, maxRank),
      };
    }
    return {
      status: "FLOOR_READY",
      hops: 1,
      legs: [{
        from: base.id,
        to: quote.id,
        kind: "floor_ready",
        chain: base.chain ?? "solana",
        error: "ejecución de compra NFT no habilitada: requiere firmar el programa on-chain de Magic Eden (API key pendiente)",
      }],
      floor: snap,
      totalImpactPct: null,
      feeUsdc: null,
    };
  }

  private finish(legs: TeleportLeg[]): TeleportRoute {
    const totalImpactPct = legs.every((l) => l.priceImpactPct != null)
      ? legs.reduce((s, l) => s + (l.priceImpactPct ?? 0), 0)
      : null;
    const last = legs[legs.length - 1]!;
    return {
      status: "ROUTABLE",
      hops: legs.length,
      legs,
      totalImpactPct,
      // Fee reporting stays at the legs' venue level here; the execution flow
      // (self-custody sessions) accounts platform fees per settled fill.
      feeUsdc: null,
      minOutAmount: last.amountOut,
    };
  }
}

// FloorLiquidityService is re-exported for API wiring convenience.
export { FloorLiquidityService };
