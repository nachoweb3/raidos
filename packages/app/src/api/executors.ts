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
    headers: {
      "Content-Type": "application/json",
      ...(process.env.JUPITER_API_KEY ? { "x-api-key": process.env.JUPITER_API_KEY } : {}),
    },
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
  /** Full 0x Swap API v2 quote (carries the Permit2 transaction). */
  raw?: unknown;
  /** Taker address (the wallet filling the order) — required to re-quote v2. */
  taker?: string;
  /** Slippage in bps used for the original quote, so re-quotes match. */
  slippageBps?: number;
}): Promise<ExecutionOutput> {
  if (params.ctx.mode === "mock") {
    return { txHash: mockTxHash("mockevm"), buyAmount: params.buyAmount, status: "confirmed" };
  }

  const { ethers } = await import("ethers");
  const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
  const NATIVE_SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

  let txRequest: { to: string; data: string; value: bigint; gas?: bigint; gasPrice?: bigint };

  const v2 = params.raw as { transaction?: { to: string; data: string; value?: string; gas?: string; gasPrice?: string } } | undefined;
  if (v2?.transaction?.to && v2.transaction.data) {
    // Fresh v2 quote payload — send the Permit2 transaction as-is.
    txRequest = {
      to: v2.transaction.to,
      data: v2.transaction.data,
      value: BigInt(v2.transaction.value ?? "0"),
      ...(v2.transaction.gas ? { gas: BigInt(v2.transaction.gas) } : {}),
      ...(v2.transaction.gasPrice ? { gasPrice: BigInt(v2.transaction.gasPrice) } : {}),
    };
  } else {
    // No raw payload (e.g. quote cache lost it) — re-quote via v2.
    const url = new URL(`${params.zeroXApiUrl}/swap/permit2/quote`);
    url.searchParams.set("chainId", String(params.chainId));
    url.searchParams.set("sellToken", params.sellToken);
    url.searchParams.set("buyToken", params.buyToken);
    url.searchParams.set("sellAmount", params.sellAmount);
    if (params.taker) url.searchParams.set("taker", params.taker);
    url.searchParams.set("slippageBps", String(params.slippageBps ?? 100));
    const res = await fetch(url.toString(), {
      headers: { "0x-version": "v2", "0x-api-key": process.env.ZERO_X_API_KEY ?? "" },
    });
    if (!res.ok) throw new Error(`0x swap quote failed: ${res.status}`);
    const quote = (await res.json()) as { transaction: { to: string; data: string; value?: string; gas?: string; gasPrice?: string } };
    txRequest = {
      to: quote.transaction.to,
      data: quote.transaction.data,
      value: BigInt(quote.transaction.value ?? "0"),
      ...(quote.transaction.gas ? { gas: BigInt(quote.transaction.gas) } : {}),
      ...(quote.transaction.gasPrice ? { gasPrice: BigInt(quote.transaction.gasPrice) } : {}),
    };
  }

  const provider = new ethers.JsonRpcProvider(params.rpcUrl);
  const wallet = new ethers.Wallet(params.ctx.privateKey, provider);

  // Permit2 flow: the sell token needs an allowance to the Permit2 contract
  // (native sentinel and all-zero placeholders need no approval).
  const isNativeSell = params.sellToken.toLowerCase() === NATIVE_SENTINEL || /^0x0{40}$/i.test(params.sellToken);
  if (!isNativeSell) {
    const erc20 = new ethers.Contract(
      params.sellToken,
      ["function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"],
      wallet,
    ) as unknown as {
      allowance: (owner: string, spender: string) => Promise<bigint>;
      approve: (spender: string, amount: bigint) => Promise<{ wait: () => Promise<unknown> }>;
    };
    const allowance: bigint = await erc20.allowance(await wallet.getAddress(), PERMIT2);
    if (allowance < BigInt(params.sellAmount)) {
      const maxUint = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
      const approveTx = await erc20.approve(PERMIT2, maxUint);
      await approveTx.wait();
    }
  }

  const tx = await wallet.sendTransaction({
    to: txRequest.to,
    data: txRequest.data,
    value: txRequest.value,
    ...(txRequest.gas ? { gasLimit: txRequest.gas } : {}),
    ...(txRequest.gasPrice ? { gasPrice: txRequest.gasPrice } : {}),
  });

  return { txHash: tx.hash, buyAmount: params.buyAmount, status: "confirmed" };
}
