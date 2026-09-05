/**
 * ⛓ CHAIN CONFIGS — Multi-chain USDC trading
 * Every chain is configured with RPC, USDC contract, DEX router, and bridge info.
 * All trading uses USDC as the base pair — no token-to-token direct swaps.
 */

export interface ChainConfig {
  /** Unique chain identifier */
  id: string;
  /** Display name */
  name: string;
  /** EVM chain ID (Solana uses 0) */
  chainId: number;
  /** Native gas token symbol */
  nativeCurrency: string;
  /** RPC endpoint */
  rpcUrl: string;
  /** Block explorer URL */
  explorerUrl: string;
  /** Whether this is an EVM chain */
  evm: boolean;
  /** USDC contract address (or equivalent stablecoin) */
  usdcAddress: string;
  /** USDC decimals */
  usdcDecimals: number;
  /** WETH/Wrapped native address for swaps */
  wrappedNative: string;
  /** Default DEX aggregator for swaps */
  dexAggregator: string;
  /** DEX API URL for swaps */
  dexApiUrl: string;
  /** Bridge provider */
  bridgeProvider: string;
  /** Whether chain supports token launches */
  supportsLaunches: boolean;
  /** Token launch factory contract (if EVM) */
  launchFactory?: string;
  /** Bonding curve contract for launches */
  bondingCurve?: string;
}

// ── SOLANA ──────────────────────────────────────────────────────────────

const SOLANA: ChainConfig = {
  id: "solana",
  name: "Solana",
  chainId: 0,
  nativeCurrency: "SOL",
  rpcUrl: "https://api.mainnet-beta.solana.com",
  explorerUrl: "https://solscan.io",
  evm: false,
  usdcAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  usdcDecimals: 6,
  wrappedNative: "So11111111111111111111111111111111111111112",
  dexAggregator: "jupiter",
  dexApiUrl: "https://api.jup.ag/swap/v1",
  bridgeProvider: "lifi",
  supportsLaunches: true,
};

// ── ETHEREUM ────────────────────────────────────────────────────────────

const ETHEREUM: ChainConfig = {
  id: "ethereum",
  name: "Ethereum",
  chainId: 1,
  nativeCurrency: "ETH",
  rpcUrl: "https://eth.llamarpc.com",
  explorerUrl: "https://etherscan.io",
  evm: true,
  usdcAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  usdcDecimals: 6,
  wrappedNative: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  dexAggregator: "0x",
  dexApiUrl: "https://api.0x.org",
  bridgeProvider: "lifi",
  supportsLaunches: true,
};

// ── BASE ────────────────────────────────────────────────────────────────

const BASE: ChainConfig = {
  id: "base",
  name: "Base",
  chainId: 8453,
  nativeCurrency: "ETH",
  rpcUrl: "https://mainnet.base.org",
  explorerUrl: "https://basescan.org",
  evm: true,
  usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  usdcDecimals: 6,
  wrappedNative: "0x4200000000000000000000000000000000000006",
  dexAggregator: "0x",
  dexApiUrl: "https://base.api.0x.org",
  bridgeProvider: "lifi",
  supportsLaunches: true,
};

// ── BSC ─────────────────────────────────────────────────────────────────

const BSC: ChainConfig = {
  id: "bsc",
  name: "BNB Chain",
  chainId: 56,
  nativeCurrency: "BNB",
  rpcUrl: "https://bsc-dataseed.binance.org",
  explorerUrl: "https://bscscan.com",
  evm: true,
  usdcAddress: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
  usdcDecimals: 18,
  wrappedNative: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
  dexAggregator: "1inch",
  dexApiUrl: "https://api.1inch.dev/swap/v6.0",
  bridgeProvider: "lifi",
  supportsLaunches: true,
};

// ── ARBITRUM ────────────────────────────────────────────────────────────

const ARBITRUM: ChainConfig = {
  id: "arbitrum",
  name: "Arbitrum",
  chainId: 42161,
  nativeCurrency: "ETH",
  rpcUrl: "https://arb1.arbitrum.io/rpc",
  explorerUrl: "https://arbiscan.io",
  evm: true,
  usdcAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  usdcDecimals: 6,
  wrappedNative: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  dexAggregator: "0x",
  dexApiUrl: "https://arbitrum.api.0x.org",
  bridgeProvider: "lifi",
  supportsLaunches: true,
};

// ── POLYGON ─────────────────────────────────────────────────────────────

const POLYGON: ChainConfig = {
  id: "polygon",
  name: "Polygon",
  chainId: 137,
  nativeCurrency: "MATIC",
  rpcUrl: "https://polygon-rpc.com",
  explorerUrl: "https://polygonscan.com",
  evm: true,
  usdcAddress: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  usdcDecimals: 6,
  wrappedNative: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  dexAggregator: "0x",
  dexApiUrl: "https://polygon.api.0x.org",
  bridgeProvider: "lifi",
  supportsLaunches: true,
};

// ── ROBINHOOD CHAIN ─────────────────────────────────────────────────────

const ROBINHOOD: ChainConfig = {
  id: "robinhood",
  name: "Robinhood Chain",
  chainId: 4663,
  nativeCurrency: "ETH",
  rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
  explorerUrl: "https://robinhoodchain.blockscout.com",
  evm: true,
  usdcAddress: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", // USDG (Paxos)
  usdcDecimals: 18,
  wrappedNative: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  dexAggregator: "uniswap",
  dexApiUrl: "https://api.uniswap.org/v2",
  bridgeProvider: "layerzero",
  supportsLaunches: true,
};

// ── REGISTRY ────────────────────────────────────────────────────────────

export const CHAINS: Record<string, ChainConfig> = {
  solana: SOLANA,
  ethereum: ETHEREUM,
  base: BASE,
  bsc: BSC,
  arbitrum: ARBITRUM,
  polygon: POLYGON,
  robinhood: ROBINHOOD,
};

export const CHAIN_IDS = Object.keys(CHAINS) as (keyof typeof CHAINS)[];
export const EVM_CHAINS = CHAIN_IDS.filter((k) => CHAINS[k]?.evm);
export const ALL_CHAIN_IDS = CHAIN_IDS.map((k) => CHAINS[k]!.chainId);

/** Get chain config by chain ID number or string id */
export function getChain(chainIdOrName: string | number): ChainConfig | undefined {
  if (typeof chainIdOrName === "number") {
    return Object.values(CHAINS).find((c) => c.chainId === chainIdOrName) as ChainConfig | undefined;
  }
  return CHAINS[chainIdOrName.toLowerCase()] as ChainConfig | undefined;
}
