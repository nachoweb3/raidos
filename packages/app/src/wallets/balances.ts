/**
 * 💰 BALANCE SCANNER — read-only on-chain balances for user wallets.
 *
 * Keyless by design: nothing here ever touches the encrypted private keys.
 * Scans use public RPCs only —
 *   • Solana: getBalance (native SOL) + getTokenAccountsByOwner (SPL tokens,
 *     parsed) against the chain's public RPC.
 *   • EVM: eth_getBalance (native) + ERC20 balanceOf for USDC via ethers'
 *     JsonRpcProvider.
 *
 * Every wallet scan is independent: one chain being down never fails the
 * whole response (honest per-wallet `error` field instead).
 */

import { getChain } from "../chains/config.js";

/** SPL Token program (classic) — covers USDC and virtually all launch tokens. */
const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/** Minimal ERC20 surface for balanceOf reads. */
const ERC20_ABI = ["function balanceOf(address owner) view returns (uint256)"];

export interface TokenBalance {
  /** Mint address (Solana) or contract address (EVM). */
  address: string;
  amount: number;
  decimals: number;
  /** USDC flag so the UI can pin price = $1 without extra lookups. */
  isUsdc?: boolean;
}

export interface WalletBalance {
  chain: string;
  address: string;
  label: string;
  nativeSymbol: string;
  nativeAmount: number;
  /** USDC balance (the trading base pair on every chain). */
  usdcAmount: number;
  /** Other SPL/EVM tokens with meaningful balances. */
  tokens: TokenBalance[];
  error?: string;
}

const RPC_TIMEOUT_MS = 8_000;

async function fetchJson(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`RPC ${res.status}`);
  const json: any = await res.json();
  if (json?.error) throw new Error(String(json.error.message ?? "RPC error"));
  return json;
}

/** Solana scan: native SOL + all SPL token accounts (parsed). */
async function scanSolana(address: string): Promise<Omit<WalletBalance, "chain" | "address" | "label">> {
  const config = getChain("solana");
  if (!config) throw new Error("solana chain config missing");

  const [native, tokenAccounts] = await Promise.all([
    fetchJson(config.rpcUrl, { jsonrpc: "2.0", id: 1, method: "getBalance", params: [address] }),
    fetchJson(config.rpcUrl, {
      jsonrpc: "2.0",
      id: 2,
      method: "getTokenAccountsByOwner",
      params: [address, { programId: SPL_TOKEN_PROGRAM }, { encoding: "jsonParsed" }],
    }),
  ]);

  const lamports = Number(native?.result?.value ?? 0);
  const tokens: TokenBalance[] = [];
  let usdcAmount = 0;

  for (const acc of tokenAccounts?.result?.value ?? []) {
    try {
      const info = acc?.account?.data?.parsed?.info;
      const mint = String(info?.mint ?? "");
      const amt = info?.tokenAmount;
      if (!mint || !amt) continue;
      const uiAmount = Number(amt.uiAmount ?? 0);
      if (uiAmount <= 0) continue;
      const isUsdc = mint === config.usdcAddress;
      if (isUsdc) usdcAmount += uiAmount;
      tokens.push({ address: mint, amount: uiAmount, decimals: Number(amt.decimals ?? 0), isUsdc });
    } catch {
      // malformed account — skip it, never fail the scan
    }
  }

  return {
    nativeSymbol: config.nativeCurrency,
    nativeAmount: lamports / 1e9,
    usdcAmount,
    // Non-USDC tokens only — USDC is reported in its dedicated field.
    tokens: tokens.filter((t) => !t.isUsdc).slice(0, 50),
  };
}

/** EVM scan: native gas token + USDC ERC20 balance. */
async function scanEvm(chain: string, address: string): Promise<Omit<WalletBalance, "chain" | "address" | "label">> {
  const config = getChain(chain);
  if (!config) throw new Error(`chain config missing: ${chain}`);
  const { ethers } = await import("ethers");
  const provider = new ethers.JsonRpcProvider(config.rpcUrl, undefined, { staticNetwork: true });

  const nativeWei = await provider.getBalance(address);
  let usdcAmount = 0;
  try {
    const usdc = new ethers.Contract(config.usdcAddress, ERC20_ABI, provider) as any;
    const bal: unknown = await usdc.balanceOf(address);
    usdcAmount = Number(ethers.formatUnits(bal as bigint, config.usdcDecimals));
  } catch {
    // USDC read failed (RPC quirk) — report native, leave usdc at 0
  }

  return {
    nativeSymbol: config.nativeCurrency,
    nativeAmount: Number(ethers.formatEther(nativeWei)),
    usdcAmount,
    tokens: [],
  };
}

export class BalanceScanner {
  /**
   * Scan every wallet a user owns. Chain failures degrade per wallet —
   * the response always resolves.
   */
  async scanWallets(wallets: { chain: string; address: string; label: string }[]): Promise<WalletBalance[]> {
    const out = await Promise.all(
      wallets.map(async (w): Promise<WalletBalance> => {
        const base = { chain: w.chain, address: w.address, label: w.label };
        try {
          const scanned = w.chain === "solana"
            ? await scanSolana(w.address)
            : await scanEvm(w.chain, w.address);
          return { ...base, ...scanned };
        } catch (err) {
          return {
            ...base,
            nativeSymbol: getChain(w.chain)?.nativeCurrency ?? "?",
            nativeAmount: 0,
            usdcAmount: 0,
            tokens: [],
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
    return out;
  }
}
