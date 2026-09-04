/**
 * 🚀 RaidOS Trading App — multi-chain USDC trading + social + launchpad
 *
 * Chains: Solana, Ethereum, Base, BSC, Arbitrum, Polygon, Robinhood Chain
 * Features:
 * - Multi-chain wallet management (encrypted, exportable)
 * - USDC-native swaps (Jupiter + 0x + Li.Fi bridging)
 * - Token launchpad (bonding curve → DEX migration)
 * - Social trading (profiles, calls, follow, copy-trade)
 * - Public leaderboards (PnL, win rate, followers)
 * - Revenue: trading fees, launch fees, premium, ads, API
 */

export { CHAINS, CHAIN_IDS, EVM_CHAINS, getChain } from "./chains/config.js";
export type { ChainConfig } from "./chains/config.js";

export { encrypt, decrypt, verifyPassword } from "./wallets/crypto.js";
export type { EncryptedPayload } from "./wallets/crypto.js";
export { WalletManager } from "./wallets/manager.js";
export type { WalletRow, PublicWallet } from "./wallets/manager.js";

export { TradingEngine } from "./trading/engine.js";
export type { TradeParams, TradeQuote, TradeResult, TradingFeeConfig } from "./trading/engine.js";

export { TokenLaunchpad } from "./trading/launchpad.js";
export type { LaunchRow, PublicLaunch, CurveResult, CreateLaunchParams } from "./trading/launchpad.js";

export { SocialTrading } from "./profiles/social.js";
export type { UserProfile, TradeCall, CopyTradeSettings, LeaderboardEntry } from "./profiles/social.js";

export { RevenueEngine, PREMIUM_TIERS } from "./trading/revenue.js";
export type { RevenueEvent, RevenueStream, PremiumTier, AdCampaign } from "./trading/revenue.js";

export { TradeHistory } from "./trading/history.js";
export type { TradeRow, PnlSummary, ActivityEntry } from "./trading/history.js";

export { AppDb } from "./database/app-db.js";
