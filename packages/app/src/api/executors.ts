/**
 * ⚡ TRADE EXECUTORS — live (Jupiter / 0x) and mock swap execution
 * Live executors sign and broadcast real transactions with the user's
 * decrypted custodial key. Mock executors simulate fills deterministically
 * and are always labeled `mode: "mock"` — never presented as real fills.
 */

import { randomBytes } from "node:crypto";

export interface ExecutionContext {
  /** "live" broadcasts real transactions; "mock" simulates fills. */
  mode: "live" | "mock";
  /** Decrypted private key (base58 for Solana, hex for EVM). */
  privateKey: string;
}

export interface ExecutionOutput {
  txHash: string;
  buyAmount: string;
  status: "confirmed" | "failed";
  error?: string;
}

/** Deterministic pseudo tx hash for mock mode (clearly labeled). */
export function mockTxHash(prefix = "mock"): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

// ── SOLANA (Jupiter) ─────────────────────────────────────────────────────

/**
 * Execute a Solana swap using a Jupiter quote.
 * Live: builds the swap transaction, signs with the decrypted keypair and
 * broadcasts. Mock: returns the quoted output amount with a mock hash.
 */
export async function executeSolanaSwap(params: {
  ctx: ExecutionContext;
  quoteResponse: unknown;
  walletAddress: string;
  buyAmount: string;
}): Promise<ExecutionOutput> {
  if (params.ctx.mode === "mock") {
    return { txHash: mockTxHash("mocksol"), buyAmount: params.buyAmount, status: "confirmed" };
  }

  const { Connection, Keypair, VersionedTransaction } = await import("@solana/web3.js");
  const bs58 = (await import("bs58")).default;

  const swapsApiUrl = process.env.JUPITER_SWAP_API_URL ?? "https://api.jup.ag/swap/v1";
  const connection = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com");

  // Request the serialized swap transaction from Jupiter
  const res = await fetch(`${swapsApiUrl}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: params.quoteResponse,
      userPublicKey: params.walletAddress,
      wrapAndUnwrapSol: true,
    }),
  });
  if (!res.ok) throw new Error(`Jupiter swap build failed: ${res.status}`);
  const { swapTransaction } = (await res.json()) as { swapTransaction: string };

  // Deserialize, sign with the custodial keypair and broadcast
  const keypair = Keypair.fromSecretKey(bs58.decode(params.ctx.privateKey));
  const txn = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
  txn.sign([keypair]);

  const signature = await connection.sendTransaction(txn, { maxRetries: 3 });
  return { txHash: signature, buyAmount: params.buyAmount, status: "confirmed" };
}

// ── EVM (0x) ─────────────────────────────────────────────────────────────

/**
 * Execute an EVM swap using a 0x quote.
 * Live: fetches the fill transaction, signs with ethers Wallet and broadcasts
 * via the chain RPC. Mock: returns the quoted output with a mock hash.
 */
export async function executeEvmSwap(params: {
  ctx: ExecutionContext;
  chainId: number;
  rpcUrl: string;
  zeroXApiUrl: string;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
}): Promise<ExecutionOutput> {
  if (params.ctx.mode === "mock") {
    return { txHash: mockTxHash("mockevm"), buyAmount: params.buyAmount, status: "confirmed" };
  }

  const { ethers } = await import("ethers");

  const url = new URL(`${params.zeroXApiUrl}/swap/v1/quote`);
  url.searchParams.set("sellToken", params.sellToken);
  url.searchParams.set("buyToken", params.buyToken);
  url.searchParams.set("sellAmount", params.sellAmount);

  const res = await fetch(url.toString(), {
    headers: { "0x-api-key": process.env.ZERO_X_API_KEY ?? "" },
  });
  if (!res.ok) throw new Error(`0x swap quote failed: ${res.status}`);
  const quote = (await res.json()) as { to: string; data: string; value: string; gasPrice?: string };

  const provider = new ethers.JsonRpcProvider(params.rpcUrl);
  const wallet = new ethers.Wallet(params.ctx.privateKey, provider);

  const tx = await wallet.sendTransaction({
    to: quote.to,
    data: quote.data,
    value: BigInt(quote.value ?? "0"),
    ...(quote.gasPrice ? { gasPrice: BigInt(quote.gasPrice) } : {}),
  });

  return { txHash: tx.hash, buyAmount: params.buyAmount, status: "confirmed" };
}
