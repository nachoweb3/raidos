/**
 * 🔄 TRADING ENGINE — USDC-native multi-chain swaps
 * Routes: Jupiter (Solana), 0x/1inch (EVM), Li.Fi (cross-chain)
 * All trades go through USDC as the base pair.
 * Trading fee: 0.3% per swap, deducted in USDC.
 */

import { CHAINS, type ChainConfig, getChain } from "../chains/config.js";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

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
  /** Wallet address that would fill the order (required by 0x v2 quotes) */
  taker?: string;
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
  /** Provider-guaranteed minimum buy amount (slippage-applied), when known. */
  buyAmountMin?: string;
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

function sellTokenOf(url: URL): string {
  return url.searchParams.get("sellToken") ?? "";
}

function buyTokenOf(url: URL): string {
  return url.searchParams.get("buyToken") ?? "";
}

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
    // Jupiter rejects /swap with 400 when the quote carries platformFeeBps
    // but the swap omits feeAccount. Resolve the fee account FIRST and only
    // request a fee in the quote when the account exists (same cached
    // resolution reused by the /swap call), keeping quote and swap always
    // consistent — and swaps working when the treasury ATA is missing.
    const feeAccount = await resolveJupiterFeeAccount(params.buyToken, config.rpcUrl);
    if (feeAccount) url.searchParams.set("platformFeeBps", String(getSolanaPlatformFeeBps()));

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
      raw: data, // full quoteResponse payload needed by the swap executor
    };
  }

  /** 0x Swap API v2 quote for EVM chains (Permit2 flow) */
  /** Placeholder taker for quotes without a user wallet (0x v2 requires one;
   * quotes are price-only in that case — execution always re-quotes with the
   * real wallet address). */
  static DEFAULT_TAKER = "0x0000000000000000000000000000000000012345";

  private async getEvmQuote(params: TradeParams, config: ChainConfig, fee: string): Promise<TradeQuote> {
    // Arc has no 0x presence, but Li.Fi routes it (verified on-chain shape:
    // kyberswap tool, full transactionRequest, Diamond approvalAddress). The
    // Li.Fi integrator fee comes off the fromToken — the same sell-leg
    // accounting parseEvmTransferFill already validates for 0x.
    if (params.fromChain === "arc") {
      return this.getLiFiArcQuote(params, config, fee);
    }
    const NATIVE_SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const DEFAULT_TAKER = TradingEngine.DEFAULT_TAKER;
    // Symbols that map to the chain's native gas token even when named
    // differently from nativeCurrency (e.g. POL replaced MATIC on Polygon).
    const NATIVE_ALIASES: Record<string, string> = { POL: "MATIC", ETHER: "ETH" };
    const resolveToken = (raw: string) => {
      const t = raw.toUpperCase();
      const normalized = NATIVE_ALIASES[t] ?? t;
      if (normalized === "USDC") return config.usdcAddress;
      // Native gas token: accept the symbol or the all-zero placeholder and
      // use 0x's native sentinel address.
      if (normalized === config.nativeCurrency.toUpperCase() || /^0x0{40}$/i.test(raw)) return NATIVE_SENTINEL;
      return raw;
    };
    const url = new URL(`${config.dexApiUrl}/swap/permit2/quote`);
    url.searchParams.set("chainId", String(config.chainId));
    url.searchParams.set("sellToken", resolveToken(params.sellToken));
    url.searchParams.set("buyToken", resolveToken(params.buyToken));
    url.searchParams.set("sellAmount", params.amount);
    url.searchParams.set("taker", params.taker || DEFAULT_TAKER);
    url.searchParams.set("slippageBps", String(params.slippageBps ?? 100));
    this.applyEvmAffiliateFee(url, resolveToken);

    const res = await fetch(url.toString(), {
      headers: { "0x-version": "v2", "0x-api-key": process.env.ZERO_X_API_KEY ?? "" },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`0x quote failed: ${res.status} ${body.slice(0, 200)}`);
    }
    const data = await res.json() as {
      buyAmount: string; minBuyAmount?: string;
      issues?: { priceImpact?: unknown };
      transaction?: { to: string; data: string; value: string; gas?: string; gasPrice?: string };
      route?: { fills: { tool: { name: string } }[] };
    };

    return {
      fromChain: params.fromChain,
      toChain: params.toChain,
      sellToken: params.sellToken,
      buyToken: params.buyToken,
      sellAmount: params.amount,
      buyAmount: data.buyAmount,
      priceImpact: "0",
      feeUsdc: fee,
      gasEstimate: data.transaction?.gas ?? "0",
      route: data.route?.fills?.map((f) => f.tool?.name).filter(Boolean).join(" → ") || config.dexAggregator,
      aggregator: config.dexAggregator,
      expiresAt: Date.now() + 60_000,
      raw: data, // full v2 quote — carries the Permit2 transaction for execution
    };
  }

  /**
   * Build an unsigned transaction for a connected browser wallet. This method
   * never accepts or derives a private key; signing remains the wallet's job.
   */
  async prepareSelfCustodyTransaction(params: TradeParams, walletAddress: string): Promise<{
    quote: TradeQuote;
    /** Effective on-chain fee bps applied to THIS swap (0 = none). */
    platformFeeBps?: number;
    unsignedTransaction: {
      kind: "solana" | "evm";
      serialized?: string;
      to?: string;
      data?: string;
      value?: string;
      gas?: string;
      gasPrice?: string;
      chainId: number;
      /** Exact ERC-20 approve to sign BEFORE the swap (Li.Fi Diamond flow).
       * Omitted when no prior allowance is required. */
      approveTx?: { to: string; data: string };
    };
  }> {
    const quote = await this.getQuote({ ...params, taker: walletAddress });
    if (params.fromChain === "solana") {
      const config = getChain(params.fromChain);
      if (!config || !quote.raw) throw new Error("quote is missing a Solana transaction payload");
      const swapFeeAccount = await resolveJupiterFeeAccount(params.buyToken, config.rpcUrl);
      const response = await fetch(`${config.dexApiUrl}/swap`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(process.env.JUPITER_API_KEY ? { "x-api-key": process.env.JUPITER_API_KEY } : {}),
        },
        body: JSON.stringify({
          quoteResponse: quote.raw,
          userPublicKey: walletAddress,
          wrapAndUnwrapSol: true,
          ...(swapFeeAccount ? { feeAccount: swapFeeAccount } : {}),
        }),
      });
      if (!response.ok) throw new Error(`swap transaction preparation failed: ${response.status}`);
      const body = await response.json() as { swapTransaction?: string };
      if (!body.swapTransaction) throw new Error("provider returned no Solana transaction");
      return {
        quote,
        platformFeeBps: swapFeeAccount ? getSolanaPlatformFeeBps() : 0,
        unsignedTransaction: {
          kind: "solana",
          serialized: body.swapTransaction,
          chainId: 0,
        },
      };
    }

    const config = getChain(params.fromChain);
    if (params.fromChain === "arc") {
      const raw = quote.raw as {
        estimate?: { approvalAddress?: string };
        transactionRequest?: { to?: string; data?: string; value?: string; gasLimit?: string; gasPrice?: string };
      } | undefined;
      const tx = raw?.transactionRequest;
      if (!config || !tx?.to || !tx.data) throw new Error("quote is missing an EVM transaction payload");
      // On Arc every token — including the native-USDC gas token — is an
      // ERC-20 that Li.Fi spends via its Diamond. Emit the exact approve the
      // wallet must sign first (amount = sellAmount, no guessed allowances);
      // sequential nonces complete the approve→swap pair atomically from the
      // user's perspective.
      const approvalAddress = raw?.estimate?.approvalAddress;
      const sellIsAddress = /^0x[0-9a-fA-F]{40}$/.test(params.sellToken);
      const approveTx = approvalAddress && /^0x[0-9a-fA-F]{40}$/.test(approvalAddress) && sellIsAddress
        ? { to: params.sellToken, data: erc20ApproveCalldata(approvalAddress, BigInt(params.amount)) }
        : undefined;
      return {
        quote,
        platformFeeBps: 0, // fee travels inside the Li.Fi route via LIFI_FEE_PCT
        unsignedTransaction: {
          kind: "evm",
          to: tx.to,
          data: tx.data,
          value: tx.value ?? "0",
          gas: tx.gasLimit,
          gasPrice: tx.gasPrice,
          chainId: config.chainId,
          approveTx,
        },
      };
    }
    const raw = quote.raw as { transaction?: { to?: string; data?: string; value?: string; gas?: string; gasPrice?: string } } | undefined;
    const transaction = raw?.transaction;
    if (!config || !transaction?.to || !transaction.data) {
      throw new Error("quote is missing an EVM transaction payload");
    }
    return {
      quote,
      platformFeeBps: getEvmAffiliateFeeBps(),
      unsignedTransaction: {
        kind: "evm",
        to: transaction.to,
        data: transaction.data,
        value: transaction.value ?? "0",
        gas: transaction.gas,
        gasPrice: transaction.gasPrice,
        chainId: config.chainId,
      },
    };
  }

  /**
   * On-chain affiliate fee (0x v2): taken inside the swap by the aggregator,
   * so the taker's sell delta still equals sellAmount and receipt parsing
   * remains valid. Off by default — set EVM_SWAP_FEE_RECIPIENT (0x address)
   * and optionally EVM_SWAP_FEE_BPS (0-1000, default 30 = 0.3%) to enable.
   * The fee token is the sell token (USDC when buying), falling back to the
   * buy token when selling a native-adjacent route.
   */
  private applyEvmAffiliateFee(url: URL, resolveToken: (raw: string) => string): void {
    const bps = getEvmAffiliateFeeBps();
    if (bps <= 0) return;
    const recipient = process.env.EVM_SWAP_FEE_RECIPIENT!;
    const NATIVE_SENTINEL = "0xeeee";
    const sell = resolveToken(sellTokenOf(url));
    const feeToken = !sell.toLowerCase().startsWith(NATIVE_SENTINEL)
      ? sell
      : (() => {
          const buy = resolveToken(buyTokenOf(url));
          return buy.toLowerCase().startsWith(NATIVE_SENTINEL) ? null : buy;
        })();
    if (!feeToken) return;
    url.searchParams.set("swapFeeRecipient", recipient);
    url.searchParams.set("swapFeeBps", String(bps));
    url.searchParams.set("swapFeeToken", feeToken);
  }

  /**
   * Li.Fi intra-Arc quote (GET /v1/quote). Verified live 2026-09-24 on the
   * WETH/USDC pool (~$30M daily volume): returns estimate.toAmountMin and a
   * full transactionRequest (to = Li.Fi Diamond, data, gasLimit, gasPrice,
   * value). Arc's native gas token IS USDC, but Li.Fi treats it as a regular
   * ERC-20: tx value is always "0x0" and the Diamond needs a separate ERC-20
   * approve when selling — prepareSelfCustodyTransaction emits the exact
   * unsigned approve so the wallet signs approve→swap with sequential nonces.
   * The integrator fee (our 0.3%) is deducted from the fromToken (sell leg),
   * keeping receipt parsing identical to the 0x path. Requires no API key.
   */
  private async getLiFiArcQuote(params: TradeParams, config: ChainConfig, fee: string): Promise<TradeQuote> {
    const ARC_USDC = config.usdcAddress;
    const NATIVE_SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const resolveToken = (raw: string) => {
      if (/^0x[0-9a-fA-F]{40}$/.test(raw)) return raw;
      if (raw.toUpperCase() === "USDC" || /^0x0{40}$/i.test(raw)) return ARC_USDC;
      return raw;
    };
    const sellToken = resolveToken(params.sellToken);
    const buyToken = resolveToken(params.buyToken);
    const url = new URL("https://li.quest/v1/quote");
    url.searchParams.set("fromChain", String(config.chainId));
    url.searchParams.set("toChain", String(config.chainId));
    url.searchParams.set("fromToken", sellToken);
    url.searchParams.set("toToken", buyToken);
    url.searchParams.set("fromAmount", params.amount);
    // Li.Fi requires fromAddress even for price-only quotes (verified 400
    // "required property 'fromAddress'" without it). Use the taker when the
    // caller knows the wallet; the placeholder mirrors the 0x DEFAULT_TAKER
    // pattern for anonymous quotes.
    url.searchParams.set("fromAddress", params.taker || TradingEngine.DEFAULT_TAKER);
    // Li.Fi expects a fraction (0.005 = 0.5%); our params carry bps (50).
    url.searchParams.set("slippage", String((params.slippageBps ?? 100) / 10_000));
    const integrator = process.env.LIFI_INTEGRATOR;
    if (integrator) url.searchParams.set("integrator", integrator);
    const feePct = process.env.LIFI_FEE_PCT;
    if (feePct && /^\d+(\.\d+)?$/.test(feePct) && Number(feePct) > 0 && Number(feePct) < 100) {
      url.searchParams.set("fee", feePct);
    }
    const res = await fetch(url.toString(), { headers: { accept: "application/json" } });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`lifi quote failed: ${res.status} ${body.slice(0, 200)}`);
    }
    const data = await res.json() as {
      tool?: string;
      toolDetails?: { name?: string };
      estimate?: { toAmount?: string; toAmountMin?: string; approvalAddress?: string };
      transactionRequest?: { to?: string; data?: string; value?: string; gasLimit?: string; gasPrice?: string; chainId?: number };
    };
    if (!data.estimate?.toAmount || !data.transactionRequest?.to || !data.transactionRequest.data) {
      throw new Error("lifi quote is missing an executable transaction request");
    }
    return {
      fromChain: params.fromChain,
      toChain: params.toChain,
      sellToken: params.sellToken,
      buyToken: params.buyToken,
      sellAmount: params.amount,
      buyAmount: data.estimate.toAmount,
      buyAmountMin: data.estimate.toAmountMin,
      priceImpact: "0",
      feeUsdc: fee,
      gasEstimate: data.transactionRequest.gasLimit ?? "0",
      route: data.toolDetails?.name ?? data.tool ?? "lifi",
      aggregator: "lifi",
      expiresAt: Date.now() + 60_000,
      raw: data,
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

/** ERC-20 approve(address,uint256) calldata — 4-byte selector + 32-byte words. */
export function erc20ApproveCalldata(spender: string, amount: bigint): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(spender)) throw new Error("approve spender must be a 20-byte address");
  const selector = "0x095ea7b3";
  const paddedSpender = spender.toLowerCase().slice(2).padStart(64, "0");
  const amountHex = amount.toString(16).padStart(64, "0");
  return selector + paddedSpender + amountHex;
}

/**
 * EVM affiliate fee env parsing. Returns 0 when disabled or misconfigured —
 * never a half-applied fee. Shared by the engine (quote params) and the
 * reconciler (expected-fee accounting) so both sides always agree.
 */
export function getEvmAffiliateFeeBps(): number {
  const recipient = process.env.EVM_SWAP_FEE_RECIPIENT;
  if (!recipient || !/^0x[0-9a-fA-F]{40}$/.test(recipient)) return 0;
  const bpsRaw = process.env.EVM_SWAP_FEE_BPS ?? "30";
  if (!/^\d{1,4}$/.test(bpsRaw) || Number(bpsRaw) > 1000) return 0;
  return Number(bpsRaw);
}

/**
 * Solana platform fee env parsing (shared by quote and swap-build). Returns
 * 0 when disabled or misconfigured — never a half-applied fee.
 */
export function getSolanaPlatformFeeBps(): number {
  if (!getSolanaPlatformFeeAccount() && !getSolanaPlatformFeeOwner()) return 0;
  const bpsRaw = process.env.SOLANA_PLATFORM_FEE_BPS ?? "30";
  if (!/^\d{1,4}$/.test(bpsRaw) || Number(bpsRaw) > 1000) return 0;
  return Number(bpsRaw);
}

function getSolanaPlatformFeeAccount(): string | undefined {
  const account = process.env.SOLANA_PLATFORM_FEE_ACCOUNT;
  if (!account || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(account)) return undefined;
  return account;
}

function getSolanaPlatformFeeOwner(): string | undefined {
  const owner = process.env.SOLANA_PLATFORM_FEE_OWNER;
  if (!owner || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(owner)) return undefined;
  return owner;
}

/**
 * Jupiter's swap-level feeAccount must be a token account owned by the fee
 * recipient for the OUTPUT mint of each swap. With SOLANA_PLATFORM_FEE_OWNER
 * set, derive the owner's Associated Token Account per output mint.
 * SOLANA_PLATFORM_FEE_ACCOUNT (static) takes precedence as an override —
 * it only works when every traded output mint shares one account, so the
 * owner-based derivation is the preferred configuration. Returns undefined
 * when the fee is disabled or the config is invalid — never a guessed
 * account.
 */
export function getSolanaPlatformFeeAccountForMint(outputMint: string): string | undefined {
  const staticAccount = getSolanaPlatformFeeAccount();
  if (staticAccount) return staticAccount;
  const owner = getSolanaPlatformFeeOwner();
  if (!owner) return undefined;
  try {
    return getAssociatedTokenAddressSync(new PublicKey(outputMint), new PublicKey(owner), true).toBase58();
  } catch {
    return undefined;
  }
}

/** Fee-account existence cache: true = fee applies, false = skip fee. Exported for test isolation. */
export const feeAccountExistsCache = new Map<string, { exists: boolean; checkedAt: number }>();
const FEE_ACCOUNT_CACHE_TTL_MS = 5 * 60_000;

/**
 * Jupiter debits the platform fee by transferring output tokens to the
 * configured feeAccount, which must ALREADY EXIST or the whole swap fails
 * on-chain (SPL transfers to a non-existent account abort). With a fresh
 * treasury most fee ATAs do not exist yet, so the fee is applied per output
 * mint only when the derived account exists (RPC check with a short-TTL
 * cache); otherwise the swap proceeds fee-free — a slightly missed fee is
 * always preferable to breaking user swaps. RPC trouble also degrades to
 * fee-off, never to a broken swap.
 */
export async function resolveJupiterFeeAccount(outputMint: string, rpcUrl: string): Promise<string | undefined> {
  const bps = getSolanaPlatformFeeBps();
  if (bps <= 0) return undefined;
  const feeAccount = getSolanaPlatformFeeAccountForMint(outputMint);
  if (!feeAccount) return undefined;
  const cached = feeAccountExistsCache.get(feeAccount);
  if (cached && Date.now() - cached.checkedAt < FEE_ACCOUNT_CACHE_TTL_MS) {
    return cached.exists ? feeAccount : undefined;
  }
  let exists = false;
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [feeAccount, { encoding: "base64" }] }),
    });
    const data = await res.json() as { result?: { value?: unknown } };
    exists = Boolean(data.result?.value);
  } catch {
    exists = false;
  }
  if (feeAccountExistsCache.size > 500) feeAccountExistsCache.clear();
  feeAccountExistsCache.set(feeAccount, { exists, checkedAt: Date.now() });
  return exists ? feeAccount : undefined;
}
