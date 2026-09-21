/**
 * 🚀 TOKEN LAUNCHPAD — create and launch tokens on any supported chain
 * Flow: Create token → bonding curve → when threshold hit → migrate to DEX
 * All launches priced in USDC. Anti-rug: liquidity locked, contract verified.
 *
 * CURRENT LIMITATION (honest): the curve is a SQLite simulation. It does NOT
 * deploy an SPL/ERC-20 token, holds no custody of user funds and emits no
 * on-chain transaction. Graduation is a status change recorded with
 * graduation_simulated = 1, not a DEX migration. Until the on-chain factory
 * lands, `txHash` is never returned and UIs must label this clearly.
 */

import bs58 from "bs58";
import { CHAINS, type ChainConfig, getChain } from "../chains/config.js";
import { verifyEvmSignature, verifySolanaSignature } from "../api/verify-login.js";

/** Token launch status */
export type LaunchStatus = "created" | "funding" | "graduated" | "failed";

/** Stored launch row */
export interface LaunchRow {
  id: number;
  /** User who created the launch */
  creator_id: number;
  /** Chain where the token is deployed */
  chain: string;
  /** Token name */
  name: string;
  /** Token symbol */
  symbol: string;
  /** Token description */
  description: string;
  /** Token image URL */
  image_url: string;
  /** Deployed token contract address */
  token_address: string | null;
  /** Bonding curve contract address */
  bonding_curve_address: string | null;
  /** Total supply */
  total_supply: string;
  /** Current price in 1e6-USDC units per whole token */
  current_price_usdc: string;
  /** Market cap in micro-USDC */
  market_cap_usdc: string;
  /** Total USDC raised (micro-USDC) — the real curve accounting ledger */
  raised_usdc: string;
  /** Graduation threshold (micro-USDC) — when to migrate to DEX */
  graduate_threshold: string;
  /** Launch fee paid */
  fee_paid: string;
  /** Status */
  status: LaunchStatus;
  /** Number of distinct buyers */
  buyers_count: number;
  /** Token created timestamp */
  created_at: number;
  /** Graduation timestamp */
  graduated_at: number | null;
  /** Social links (optional on legacy rows) */
  twitter_url?: string;
  telegram_url?: string;
  website_url?: string;
  /** Mock/simulated graduation flag (honest labeling in UI). */
  graduation_simulated?: number;
  /** On-chain graduation factory state (set by the factory). */
  mint_address?: string | null;
  factory_status?: string | null;
  graduated_on_chain?: number;
  /** Last curve fill timestamp. */
  last_trade_at?: number | null;
}

/** Public launch info (no internal IDs) */
export interface PublicLaunch {
  id: number;
  chain: string;
  name: string;
  symbol: string;
  description: string;
  imageUrl: string;
  tokenAddress: string | null;
  currentPriceUsdc: string;
  marketCapUsdc: string;
  raisedUsdc: string;
  graduateThreshold: string;
  status: LaunchStatus;
  buyersCount: number;
  progressPct: number;
  createdAt: number;
  twitterUrl: string;
  telegramUrl: string;
  websiteUrl: string;
  /** True when the token really graduated: real mint, supply fixed on-chain. */
  graduatedOnChain: boolean;
  /** SPL mint address once the factory has graduated the launch (null before). */
  mintAddress: string | null;
  issuanceStatus: string;
  distributionLocked: boolean;
  /** Last curve fill timestamp, if any. */
  lastTradeAt: number | null;
}

/** Bonding curve buy/sell result */
export interface CurveResult {
  success: boolean;
  tokenAmount?: string;
  usdcAmount?: string;
  priceAfter?: string;
  newMarketCap?: string;
  /**
   * Never fabricated: on-chain execution does not exist yet, so txHash stays
   * undefined until the curve is a real contract.
   */
  txHash?: string;
  graduated?: boolean;
  error?: string;
}

/** Launch creation params */
export interface CreateLaunchParams {
  chain: string;
  name: string;
  symbol: string;
  description: string;
  imageUrl: string;
  totalSupply: string;
  twitterUrl?: string;
  telegramUrl?: string;
  websiteUrl?: string;
}

/** User position on a launch, derived from the durable trades ledger. */
export interface LaunchPosition {
  tokens: string;
  costUsdc: string;
  realizedUsdc: string;
  avgCostUsdc: string;
  valueUsdc: string;
  unrealizedUsdc: string;
}

/** A registered on-chain claim wallet (post-migration payout target). */
export interface ClaimWallet {
  chain: "solana" | "evm";
  /** Canonical address (EVM: checksummed lowercase-derived; Solana: base58 as given). */
  address: string;
}

/** The caller's claim registration state on one launch. */
export interface ClaimStatus {
  launchId: number;
  /** Net curve holdings this claim would pay out (whole tokens). */
  tokens: string;
  /** Registered wallet, when the user has signed for one. */
  wallet: ClaimWallet | null;
  registeredAt: number | null;
  updatedAt: number | null;
}

/** One entry of the post-graduation token distribution snapshot. */
export interface LaunchDistributionEntry {
  userId: number;
  chain: string;
  walletAddress: string;
  /** Net tokens owed (gross buys − gross sells, whole tokens). */
  tokens: string;
  /** Net USDC in (gross buys − gross sells, micro-USDC). */
  netUsdc: string;
  registeredAt: number;
}

/** Public activity feed entry. */
export interface LaunchActivity {
  id: number;
  launchId: number;
  symbol: string;
  name: string;
  traderName: string;
  side: "buy" | "sell";
  tokenAmount: string;
  usdcAmount: string;
  ts: number;
}

/** Fields a creator can pass through the API. */
export interface LaunchDraftInput {
  chain: string;
  name: string;
  symbol: string;
  description: string;
  imageUrl: string;
  totalSupply: string;
}

export interface ValidatedDraft {
  config: ChainConfig;
  name: string;
  symbol: string;
  description: string;
  imageUrl: string;
  totalSupply: string;
}

export class TokenLaunchpad {
  /** Launch fee per token creation (in USDC, 6 decimals) */
  static LAUNCH_FEE_USDC = "10000000"; // 10 USDC

  /** Default graduation threshold */
  static GRADUATE_THRESHOLD = "85000000000"; // 85,000 USDC

  /** Smallest curve fill (micro-USDC). Prevents dust spam on the ledger. */
  static MIN_TRADE_USDC = "100000"; // 0.1 USDC

  /** A quote stops being trustworthy after this long (ms). */
  static QUOTE_TTL_MS = 60_000;

  constructor(
    private db: {
      createLaunch(input: Omit<LaunchRow, "id">): number;
      getLaunch(id: number): LaunchRow | undefined;
      listLaunches(chain: string, status?: LaunchStatus, limit?: number): LaunchRow[];
      listLaunchesByUser(userId: number, limit?: number): LaunchRow[];
      updateLaunch(id: number, updates: Partial<LaunchRow>): void;
      addLaunchBuyer(launchId: number, userId: number, usdcAmount: string, tokenAmount: string): void;
      launchTransaction<T>(fn: () => T): T;
      getLaunchBuyTotals(launchId: number, userId: number): { tokens: bigint; usdc: bigint };
      getLaunchSellTotals(launchId: number, userId: number): { tokens: bigint; usdc: bigint };
      addLaunchTrade(launchId: number, userId: number, side: "buy" | "sell", tokenAmount: string, usdcAmount: string, ts?: number): void;
      listRecentLaunchTrades(limit?: number): any[];
      upsertLaunchClaim(launchId: number, userId: number, chain: string, walletAddress: string, message: string): { created: boolean };
      getLaunchClaim(launchId: number, userId: number): any;
      listLaunchClaims(launchId: number): any[];
    }
  ) {}

  // ── Creation validation ───────────────────────────────────────────────

  /** Validate creator-provided fields before anything is persisted. */
  validateDraft(params: LaunchDraftInput): ValidatedDraft {
    const config = CHAIN_IDS.includes(params.chain) ? getChain(params.chain) : undefined;
    if (!config) throw new Error(`Unsupported chain: ${params.chain}`);
    if (!config.supportsLaunches) throw new Error(`Chain "${params.chain}" does not support token launches`);

    const name = params.name.trim();
    if (name.length < 2 || name.length > 64) throw new Error("Token name must be 2-64 characters");

    const symbol = params.symbol.trim().toUpperCase();
    if (!/^[A-Z0-9]{2,10}$/.test(symbol)) {
      throw new Error("Token symbol must be 2-10 letters or digits (A-Z, 0-9)");
    }

    const description = (params.description ?? "").trim().slice(0, 500);
    const imageUrl = (params.imageUrl ?? "").trim().slice(0, 300);

    const totalSupply = params.totalSupply.trim();
    if (!/^\d{1,30}$/.test(totalSupply)) throw new Error("Total supply must be a decimal integer string");
    if (totalSupply.length > 15) throw new Error("Total supply must be at most 1 quadrillion tokens");
    const supply = BigInt(totalSupply);
    if (supply <= 0n) throw new Error("Total supply must be positive");

    return { config, name, symbol, description, imageUrl, totalSupply };
  }

  /** Create a new token launch */
  async createLaunch(userId: number, params: CreateLaunchParams): Promise<PublicLaunch> {
    const draft = this.validateDraft({
      chain: params.chain,
      name: params.name,
      symbol: params.symbol,
      description: params.description ?? "",
      imageUrl: params.imageUrl ?? "",
      totalSupply: params.totalSupply,
    });

    const launch = this.db.createLaunch({
      creator_id: userId,
      chain: draft.config.id,
      name: draft.name,
      symbol: draft.symbol,
      description: draft.description,
      image_url: draft.imageUrl,
      token_address: null,
      bonding_curve_address: null,
      total_supply: draft.totalSupply,
      current_price_usdc: "1000", // initial price: 0.001 USDC
      market_cap_usdc: "1000000", // 1 USDC initial mcap
      raised_usdc: "0",
      graduate_threshold: TokenLaunchpad.GRADUATE_THRESHOLD,
      fee_paid: TokenLaunchpad.LAUNCH_FEE_USDC,
      status: "created",
      buyers_count: 0,
      created_at: Math.floor(Date.now() / 1000),
      graduated_at: null,
      twitter_url: params.twitterUrl ?? "",
      telegram_url: params.telegramUrl ?? "",
      website_url: params.websiteUrl ?? "",
    });

    return this.formatLaunch(this.db.getLaunch(launch)!);
  }

  /** Quote tokens out for a given micro-USDC in, without mutating state. */
  quoteBuy(launch: LaunchRow, usdcAmount: bigint): bigint {
    const curve = curveFrom(launch);
    if (usdcAmount < BigInt(TokenLaunchpad.MIN_TRADE_USDC)) return 0n;
    const newReserveUsdc = curve.reserveUsdc + usdcAmount;
    const newReserveTokens = curve.k / newReserveUsdc;
    return curve.reserveTokens - newReserveTokens;
  }

  /** Quote micro-USDC out for a given token amount in, without mutating state. */
  quoteSell(launch: LaunchRow, tokenAmount: bigint): bigint {
    const curve = curveFrom(launch);
    if (tokenAmount <= 0n) return 0n;
    const newReserveTokens = curve.reserveTokens + tokenAmount;
    const newReserveUsdc = curve.k / newReserveTokens;
    return curve.reserveUsdc - newReserveUsdc;
  }

  /** Buy tokens from the bonding curve */
  async buyTokens(userId: number, launchId: number, usdcAmount: string): Promise<CurveResult> {
    if (!/^\d{1,20}$/.test(usdcAmount)) return { success: false, error: "Invalid USDC amount" };
    const amount = BigInt(usdcAmount);
    if (amount < BigInt(TokenLaunchpad.MIN_TRADE_USDC)) return { success: false, error: "Minimum trade is 0.1 USDC" };

    // Whole tx: read launch, compute curve, write launch row and ledger atomically.
    return this.db.launchTransaction(() => {
      const launch = this.db.getLaunch(launchId);
      if (!launch) return { success: false, error: "Launch not found" };
      if (launch.status === "graduated") return { success: false, error: "Token already graduated to DEX" };
      if (launch.graduated_on_chain === 1 || ["executing", "recovery_required", "failed", "completed"].includes(launch.factory_status ?? "")) return { success: false, error: "Distribution locked for on-chain graduation" };
      if (launch.status === "failed") return { success: false, error: "Launch has failed" };

      // Constant-product curve from price-implied virtual reserves.
      // reserveTokens = total_supply; reserveUsdcUnits = price_p * supply
      // (price_p = current_price_usdc, i.e. 1e6-USDC units per whole token).
      // `raised` stays the real USDC accounting ledger.
      const supply = BigInt(launch.total_supply);
      const priceP = BigInt(launch.current_price_usdc) > 0n ? BigInt(launch.current_price_usdc) : 1n;
      const reserveUsdc = priceP * supply;
      const reserveTokens = supply;
      const k = reserveUsdc * reserveTokens;

      const newReserveUsdc = reserveUsdc + amount;
      const newReserveTokens = k / newReserveUsdc;
      const tokensBought = reserveTokens - newReserveTokens;

      if (tokensBought <= 0n) return { success: false, error: "Amount too small" };
      if (tokensBought > supply) return { success: false, error: "Amount exceeds available supply" };

      const newRaised = BigInt(launch.raised_usdc) + amount;
      const newPrice = newReserveUsdc / newReserveTokens;
      const newMcap = (newPrice * supply) / 1000000n; // micro-USDC

      this.db.updateLaunch(launchId, {
        raised_usdc: newRaised.toString(),
        current_price_usdc: newPrice.toString(),
        market_cap_usdc: newMcap.toString(),
        buyers_count: launch.buyers_count + 1,
        status: "funding",
        last_trade_at: Math.floor(Date.now() / 1000),
      });
      this.db.addLaunchBuyer(launchId, userId, usdcAmount, tokensBought.toString());
      this.db.addLaunchTrade(launchId, userId, "buy", tokensBought.toString(), usdcAmount);

      // Check graduation
      if (newRaised >= BigInt(launch.graduate_threshold)) {
        return this.graduateLaunch(launchId);
      }

      return {
        success: true,
        tokenAmount: tokensBought.toString(),
        usdcAmount,
        priceAfter: newPrice.toString(),
        newMarketCap: newMcap.toString(),
      };
    });
  }

  /** Sell tokens back to the bonding curve */
  async sellTokens(userId: number, launchId: number, tokenAmount: string): Promise<CurveResult> {
    if (!/^\d{1,30}$/.test(tokenAmount)) return { success: false, error: "Invalid token amount" };
    const amount = BigInt(tokenAmount);
    if (amount <= 0n) return { success: false, error: "Invalid token amount" };

    // Whole tx: holdings check, curve math and both writes commit or roll back
    // together, so concurrent sellers can never spend the same state twice.
    return this.db.launchTransaction(() => {
      const launch = this.db.getLaunch(launchId);
      if (!launch) return { success: false, error: "Launch not found" };
      if (launch.status !== "funding") return { success: false, error: "Cannot sell at this stage" };
      if (launch.graduated_on_chain === 1 || ["executing", "recovery_required", "failed", "completed"].includes(launch.factory_status ?? "")) return { success: false, error: "Distribution locked for on-chain graduation" };

      const bought = this.db.getLaunchBuyTotals(launchId, userId);
      const sold = this.db.getLaunchSellTotals(launchId, userId);
      const held = bought.tokens - sold.tokens;
      if (amount > held) {
        return { success: false, error: "Insufficient holdings" };
      }

      const priceP = BigInt(launch.current_price_usdc) > 0n ? BigInt(launch.current_price_usdc) : 1n;
      const supply = BigInt(launch.total_supply);
      const reserveUsdc = priceP * supply;
      const reserveTokens = supply;
      const k = reserveUsdc * reserveTokens;

      const newReserveTokens = reserveTokens + amount;
      const newReserveUsdc = k / newReserveTokens;
      const usdcOut = reserveUsdc - newReserveUsdc;

      if (usdcOut <= 0n) return { success: false, error: "Amount too small" };

      const newRaised = BigInt(launch.raised_usdc) - usdcOut;
      if (newRaised < 0n) {
        // the curve can only pay out real USDC that was actually raised
        return { success: false, error: "Amount too large" };
      }

      const newPrice = newReserveUsdc / newReserveTokens;

      this.db.updateLaunch(launchId, {
        raised_usdc: newRaised.toString(),
        current_price_usdc: newPrice.toString(),
        market_cap_usdc: (newPrice * supply) / 1000000n + "",
        last_trade_at: Math.floor(Date.now() / 1000),
      });
      this.db.addLaunchTrade(launchId, userId, "sell", amount.toString(), usdcOut.toString());

      return {
        success: true,
        tokenAmount: amount.toString(),
        usdcAmount: usdcOut.toString(),
        priceAfter: newPrice.toString(),
      };
    });
  }

  /** Graduate a token from bonding curve to DEX liquidity */
  private graduateLaunch(launchId: number): CurveResult {
    // SIMULATED GRADUATION: no token contract exists and no DEX pool is
    // created. The flag keeps the UI honest; on-chain migration arrives with
    // the launch factory (see docs/superpowers/specs).
    this.db.updateLaunch(launchId, {
      status: "graduated",
      graduated_at: Math.floor(Date.now() / 1000),
      graduation_simulated: 1,
    });

    return {
      success: true,
      graduated: true,
    };
  }

  /** List launches on a chain */
  listLaunches(chain: string, status?: LaunchStatus, limit = 20): PublicLaunch[] {
    return this.db.listLaunches(chain, status, limit).map((l) => this.formatLaunch(l));
  }

  /** List user's launches */
  listUserLaunches(userId: number, limit = 20): PublicLaunch[] {
    return this.db.listLaunchesByUser(userId, limit).map((l) => this.formatLaunch(l));
  }

  /** Get one launch with its derived progress; null when missing. */
  getLaunchPublic(launchId: number): PublicLaunch | null {
    const l = this.db.getLaunch(launchId);
    return l ? this.formatLaunch(l) : null;
  }

  /** User's position on a launch, computed from the durable trades ledger. */
  getLaunchPosition(userId: number, launchId: number): LaunchPosition | null {
    const launch = this.db.getLaunch(launchId);
    if (!launch) return null;
    const bought = this.db.getLaunchBuyTotals(launchId, userId);
    const sold = this.db.getLaunchSellTotals(launchId, userId);
    const tokens = bought.tokens - sold.tokens;
    const costUsdc = bought.usdc;
    const realizedUsdc = sold.usdc;
    const avgCostUsdc = tokens > 0n ? bought.usdc / bought.tokens : 0n;
    const valueUsdc = this.quoteSell(launch, tokens);
    return {
      tokens: tokens.toString(),
      costUsdc: costUsdc.toString(),
      realizedUsdc: realizedUsdc.toString(),
      avgCostUsdc: avgCostUsdc.toString(),
      valueUsdc: valueUsdc.toString(),
      unrealizedUsdc: (valueUsdc - (costUsdc - realizedUsdc)).toString(),
    };
  }

  // ── Claims: register the wallet that will receive curve holdings ─────

  /**
   * Register (or replace) the on-chain wallet that will receive this user's
   * net curve holdings if/when the launch migrates to a real token.
   * Ownership is proven with a fresh signature — the same challenge flow as
   * wallet linking — so a claim can never be attached to someone else's key.
   */
  async registerClaim(
    userId: number,
    launchId: number,
    input: { chain: string; address: string; message: string; signature: string },
  ): Promise<ClaimWallet> {
    const launch = this.db.getLaunch(launchId);
    if (!launch) throw new Error("NOT_FOUND");

    const chain = input.chain === "evm" ? "evm" : "solana";
    const address = input.address.trim();
    if (chain === "evm") {
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("INVALID_ADDRESS");
    } else {
      // Base58 decoded length must be 32 bytes (ed25519 pubkey).
      let raw: Uint8Array;
      try { raw = bs58.decode(address); } catch { throw new Error("INVALID_ADDRESS"); }
      if (raw.length !== 32) throw new Error("INVALID_ADDRESS");
    }
    if (!input.message || input.message.length > 1000) throw new Error("INVALID_MESSAGE");
    if (!input.signature || input.signature.length > 1024) throw new Error("INVALID_SIGNATURE");

    if (chain === "solana") {
      if (!verifySolanaSignature(address, input.message, input.signature)) throw new Error("BAD_SIGNATURE");
    } else {
      const recovered = await verifyEvmSignature(input.message, input.signature);
      if (!recovered || recovered !== address.toLowerCase()) throw new Error("BAD_SIGNATURE");
    }

    try {
      this.db.launchTransaction(() => {
        const current = this.db.getLaunch(launchId);
        if (!current || current.graduated_on_chain === 1 || ["executing", "recovery_required", "failed", "completed"].includes(current.factory_status ?? "")) throw new Error("DISTRIBUTION_LOCKED");
        this.db.upsertLaunchClaim(launchId, userId, chain, address, input.message);
      });
    } catch (err) {
      if (err instanceof Error && err.message === "WALLET_IN_USE") throw new Error("WALLET_IN_USE");
      throw err;
    }
    return { chain, address };
  }

  /** The caller's claim state on one launch: net tokens + registered wallet. */
  getClaimStatus(userId: number, launchId: number): ClaimStatus | null {
    const launch = this.db.getLaunch(launchId);
    if (!launch) return null;
    const bought = this.db.getLaunchBuyTotals(launchId, userId);
    const sold = this.db.getLaunchSellTotals(launchId, userId);
    const claim = this.db.getLaunchClaim(launchId, userId);
    return {
      launchId,
      tokens: (bought.tokens - sold.tokens).toString(),
      wallet: claim ? { chain: claim.chain, address: claim.wallet_address } : null,
      registeredAt: claim?.created_at ?? null,
      updatedAt: claim?.updated_at ?? null,
    };
  }

  /**
   * Post-graduation distribution snapshot: each registered wallet's net
   * holdings. Curve-only simulation would be recoverable from launch_trades,
   * but the payout TARGET is opt-in — wallets absent from launch_claims have
   * no destination and are excluded until their owner registers.
   */
  getLaunchDistribution(launchId: number): LaunchDistributionEntry[] {
    return this.db.listLaunchClaims(launchId).map((c) => {
      const bought = this.db.getLaunchBuyTotals(launchId, c.user_id);
      const sold = this.db.getLaunchSellTotals(launchId, c.user_id);
      return {
        userId: c.user_id,
        chain: c.chain,
        walletAddress: c.wallet_address,
        tokens: (bought.tokens - sold.tokens).toString(),
        netUsdc: (bought.usdc - sold.usdc).toString(),
        registeredAt: c.created_at,
      };
    });
  }

  /** Public activity feed across all launches (real ledger rows only). */
  listActivity(limit = 20): LaunchActivity[] {
    return this.db.listRecentLaunchTrades(limit).map((t) => ({
      id: t.id,
      launchId: t.launchId,
      symbol: t.symbol,
      name: t.name,
      traderName: t.traderName ?? "",
      side: t.side === "sell" ? "sell" : "buy",
      tokenAmount: t.tokenAmount,
      usdcAmount: t.usdcAmount,
      ts: t.ts,
    }));
  }

  /** Format a raw launch row (also used by API search results). */
  formatLaunchPublic(l: LaunchRow): PublicLaunch {
    return this.formatLaunch(l);
  }

  private formatLaunch(l: LaunchRow): PublicLaunch {
    const threshold = BigInt(l.graduate_threshold);
    const raised = BigInt(l.raised_usdc);
    const progressPct = threshold > 0n
      ? Number((raised * 10000n) / threshold) / 100
      : 0;
    return {
      id: l.id,
      chain: l.chain,
      name: l.name,
      symbol: l.symbol,
      description: l.description,
      imageUrl: l.image_url,
      tokenAddress: l.token_address,
      currentPriceUsdc: l.current_price_usdc,
      marketCapUsdc: l.market_cap_usdc,
      raisedUsdc: l.raised_usdc,
      graduateThreshold: l.graduate_threshold,
      status: l.status,
      buyersCount: l.buyers_count,
      progressPct,
      createdAt: l.created_at,
      twitterUrl: (l as any).twitter_url ?? "",
      telegramUrl: (l as any).telegram_url ?? "",
      websiteUrl: (l as any).website_url ?? "",
      graduatedOnChain: l.graduated_on_chain === 1, // real flag from the factory
      mintAddress: l.mint_address ?? null,
      issuanceStatus: l.factory_status ?? "not_planned",
      distributionLocked: l.graduated_on_chain === 1 || ["executing", "recovery_required", "failed", "completed"].includes(l.factory_status ?? ""),
      lastTradeAt: l.last_trade_at ?? null,
    };
  }
}

/** Curve inputs derived from a stored launch row. */
function curveFrom(launch: LaunchRow) {
  const supply = BigInt(launch.total_supply);
  const priceP = BigInt(launch.current_price_usdc) > 0n ? BigInt(launch.current_price_usdc) : 1n;
  const reserveUsdc = priceP * supply;
  return { supply, reserveUsdc, reserveTokens: supply, k: reserveUsdc * supply };
}

const CHAIN_IDS = Object.keys(CHAINS);
