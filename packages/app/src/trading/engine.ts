/**
 * 🔄 TRADING ENGINE — USDC-native multi-chain swaps
 * Routes: Jupiter (Solana), 0x/1inch (EVM), Li.Fi (cross-chain)
 * All trades go through USDC as the base pair.
 * Trading fee: 0.3% per swap, deducted in USDC.
 */

import { CHAINS, type ChainConfig, getChain } from "../chains/config.js";

/** Supported trade types */
export type TradeType = "swap" | "bridge" | "limit";

/** Direction of a trade */
export interface TradeParams {
  /** User ID */
  userId: number;
  /** Source chain */
  fromChain: string;
  /** Destination chain (same chain for swap, different for bridge) */
  toChain: string;
  /** Token to sell (USDC or any token address) */
  sellToken: string;
  /** Token to buy */
  buyToken: string;
  /** Amount in smallest unit (wei/lamports) */
  amount: string;
  /** Slippage tolerance in bps (e.g. 50 = 0.5%) */
  slippageBps?: number;
  /** Trade type */
  type: TradeType;
  /** Limit price (for limit orders) */
  limitPrice?: string;
}

/** Quote response from DEX aggregator */
export interface TradeQuote {
  /** Source chain */
  fromChain: string;
  /** Dest chain */
  toChain: string;
  /** Token being sold */
  sellToken: string;
  /** Token being bought */
  buyToken: string;
  /** Amount to sell */
  sellAmount: string;
  /** Amount to buy (estimated) */
  buyAmount: string;
  /** Price impact % */
  priceImpact: string;
  /** Trading fee in USDC */
  feeUsdc: string;
  /** Gas estimate */
  gasEstimate: string;
  /** Route description */
  route: string;
  /** DEX aggregator used */
  aggregator: string;
  /** Quote expiry (ms) */
  expiresAt: number;
  /** Raw provider payload (needed by executors, e.g. Jupiter quoteResponse) */
  raw?: unknown;
}

/** Execution result */
export interface TradeResult {
  success: boolean;
  /** Transaction hash */
  txHash?: string;
  /** Source chain */
  fromChain: string;
  /** Dest chain */
  toChain: string;
  /** Amount sold */
  sellAmount: string;
  /** Amount bought */
  buyAmount: string;
  /** Fee charged */
  feeUsdc: string;
  /** Error message if failed */
  error?: string;
}

/** Trading fee config */
export interface TradingFeeConfig {
  /** Swap fee in basis points (default 30 = 0.3%) */
  swapFeeBps: number;
  /** Bridge fee in basis points (default 50 = 0.5%) */
  bridgeFeeBps: number;
  /** Minimum fee in USDC (6 decimals) */
  minFeeUsdc: string;
  /** Fee recipient address */
  feeRecipient: string;
}

const DEFAULT_FEES: TradingFeeConfig = {
  swapFeeBps: 30,      // 0.3%
  bridgeFeeBps: 50,    // 0.5%
  minFeeUsdc: "1000",  // 0.001 USDC (6 decimals)
  feeRecipient: "",    // set in env
};

export class TradingEngine {
  private fees: TradingFeeConfig;

  constructor(fees: Partial<TradingFeeConfig> = {}) {
    this.fees = { ...DEFAULT_FEES, ...fees };
  }

  /** Calculate trading fee for a given amount */
  calculateFee(amountUsdc: string, isBridge: boolean): string {
    const amount = BigInt(amountUsdc);
    const bps = isBridge ? this.fees.bridgeFeeBps : this.fees.swapFeeBps;
    const fee = (amount * BigInt(bps)) / 10000n;
    const minFee = BigInt(this.fees.minFeeUsdc);
    return fee < minFee ? minFee.toString() : fee.toString();
  }

  /** Get a swap quote from the appropriate DEX aggregator */
  async getQuote(params: TradeParams): Promise<TradeQuote> {
    const fromConfig = getChain(params.fromChain);
    const toConfig = getChain(params.toChain);
    if (!fromConfig) throw new Error(`Unknown chain: ${params.fromChain}`);
    if (!toConfig) throw new Error(`Unknown chain: ${params.toChain}`);

    const isBridge = params.fromChain !== params.toChain;
    const fee = this.calculateFee(params.amount, isBridge);

    if (isBridge) {
      return this.getBridgeQuote(params, fromConfig, toConfig, fee);
    }

    if (params.fromChain === "solana") {
      return this.getJupiterQuote(params, fromConfig, fee);
    }

    return this.getEvmQuote(params, fromConfig, fee);
  }

  /** Jupiter quote for Solana swaps (Swap API v1 — v6 was sunset Oct 2025) */
  private async getJupiterQuote(params: TradeParams, config: ChainConfig, fee: string): Promise<TradeQuote> {
    const url = new URL(`${config.dexApiUrl}/quote`);
    url.searchParams.set("inputMint", params.sellToken);
    url.searchParams.set("outputMint", params.buyToken);
    url.searchParams.set("amount", params.amount);
    url.searchParams.set("slippageBps", String(params.slippageBps ?? 50));

    const res = await fetch(url.toString(), {
      headers: process.env.JUPITER_API_KEY ? { "x-api-key": process.env.JUPITER_API_KEY } : undefined,
    });
    if (!res.ok) throw new Error(`Jupiter quote failed: ${res.status}`);
    const data = await res.json() as {
      inAmount: string; outAmount: string; priceImpactPct: string;
      routePlan: { swapInfo: { label: string } }[];
    };

    return {
      fromChain: params.fromChain,
      toChain: params.toChain,
      sellToken: params.sellToken,
      buyToken: params.buyToken,
      sellAmount: params.amount,
      buyAmount: data.outAmount,
      priceImpact: data.priceImpactPct,
      feeUsdc: fee,
      gasEstimate: "5000", // Solana tx fee ~5000 lamports
      route: data.routePlan.map((r) => r.swapInfo.label).join(" | "),
      aggregator: "jupiter",
      expiresAt: Date.now() + 30_000,
    };
  }

  /** 0x/1inch quote for EVM chains */
  private async getEvmQuote(params: TradeParams, config: ChainConfig, fee: string): Promise<TradeQuote> {
    const url = new URL(`${config.dexApiUrl}/swap/quote`);
    url.searchParams.set("chainId", String(config.chainId));
    url.searchParams.set("sellToken", params.sellToken);
    url.searchParams.set("buyToken", params.buyToken);
    url.searchParams.set("sellAmount", params.amount);

    const res = await fetch(url.toString(), {
      headers: { "0x-version": "v2", "0x-api-key": process.env.ZERO_X_API_KEY ?? "" },
    });
    if (!res.ok) throw new Error(`0x quote failed: ${res.status}`);
    const data = await res.json() as {
      buyAmount: string; priceImpactPercentage: string;
      gas: string; sources: { name: string }[];
    };

    return {
      fromChain: params.fromChain,
      toChain: params.toChain,
      sellToken: params.sellToken,
      buyToken: params.buyToken,
      sellAmount: params.amount,
      buyAmount: data.buyAmount,
      priceImpact: data.priceImpactPercentage ?? "0",
      feeUsdc: fee,
      gasEstimate: data.gas,
      route: data.sources?.map((s) => s.name).join(" → ") ?? config.dexAggregator,
      aggregator: config.dexAggregator,
      expiresAt: Date.now() + 60_000,
    };
  }

  /** Li.Fi bridge quote for cross-chain */
  private async getBridgeQuote(params: TradeParams, from: ChainConfig, to: ChainConfig, fee: string): Promise<TradeQuote> {
    const res = await fetch("https://api.li.fi/v2/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fromChain: from.chainId === 0 ? "SOL" : String(from.chainId),
        toChain: to.chainId === 0 ? "SOL" : String(to.chainId),
        fromToken: params.sellToken,
        toToken: params.buyToken,
        fromAmount: params.amount,
        slippage: (params.slippageBps ?? 100) / 100,
      }),
    });
    if (!res.ok) throw new Error(`Li.Fi bridge quote failed: ${res.status}`);
    const data = await res.json() as { quote: { toAmount: string; gasCosts: { amount: string }[]; steps: { tool: { name: string } }[] } };

    return {
      fromChain: params.fromChain,
      toChain: params.toChain,
      sellToken: params.sellToken,
      buyToken: params.buyToken,
      sellAmount: params.amount,
      buyAmount: data.quote.toAmount,
      priceImpact: "0",
      feeUsdc: fee,
      gasEstimate: data.quote.gasCosts?.[0]?.amount ?? "0",
      route: data.quote.steps?.map((s) => s.tool.name).join(" → ") ?? "bridge",
      aggregator: "lifi",
      expiresAt: Date.now() + 60_000,
    };
  }
}
