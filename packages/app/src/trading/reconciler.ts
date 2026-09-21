import type { AppDb } from "../database/app-db.js";
import { assertTransition, type ExecutionStatus } from "./lifecycle.js";
import { getEvmAffiliateFeeBps, getSolanaPlatformFeeBps } from "./engine.js";

export interface ReceiptFill {
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
  /** Platform fee taken inside the swap, in raw units of the fee token. */
  feeAmount: string;
  /** Which swap leg carried the fee (Jupiter: buy; 0x swapFeeToken: sell). */
  feeToken: "sell" | "buy";
}

export interface ReceiptParseContext {
  walletAddress: string;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  /** Platform fee bps configured for the chain (0 = none). Used to account
   * for the fee taken inside the swap; positions always use measured deltas. */
  expectedFeeBps?: number;
}

export interface ReceiptResult {
  status: "pending" | "confirmed" | "failed";
  receipt?: unknown;
  /** Exact fill parsed and verified by the chain adapter, never client input. */
  fill?: ReceiptFill;
  error?: string;
}

export interface ReceiptProvider {
  getReceipt(chain: string, txHash: string, context?: ReceiptParseContext): Promise<ReceiptResult>;
}

type SolanaTokenBalance = {
  accountIndex?: number;
  mint?: string;
  owner?: string;
  uiTokenAmount?: { amount?: string };
};

type SolanaTransaction = {
  meta?: {
    err?: unknown;
    fee?: number;
    preTokenBalances?: SolanaTokenBalance[] | null;
    postTokenBalances?: SolanaTokenBalance[] | null;
  } | null;
};

function balanceDelta(
  receipt: SolanaTransaction,
  walletAddress: string,
  mint: string,
): bigint | undefined {
  const pre = receipt.meta?.preTokenBalances;
  const post = receipt.meta?.postTokenBalances;
  if (!pre || !post) return undefined;

  const balances = new Map<number, { pre?: bigint; post?: bigint }>();
  const read = (entries: SolanaTokenBalance[], side: "pre" | "post"): boolean => {
    for (const entry of entries) {
      if (entry.mint !== mint) continue;
      // Every matching balance must identify its owner. Ignoring an ownerless
      // entry could make an unrelated token account look like the user's fill.
      if (typeof entry.owner !== "string") return false;
      if (entry.owner !== walletAddress) continue;
      if (!Number.isInteger(entry.accountIndex) || entry.accountIndex! < 0) return false;
      const raw = entry.uiTokenAmount?.amount;
      if (typeof raw !== "string" || !/^\d+$/.test(raw)) return false;
      const account = balances.get(entry.accountIndex!) ?? {};
      account[side] = BigInt(raw);
      balances.set(entry.accountIndex!, account);
    }
    return true;
  };

  if (!read(pre, "pre") || !read(post, "post") || balances.size === 0) return undefined;
  let delta = 0n;
  for (const value of balances.values()) {
    // A changed wallet-owned account must be represented on both sides. If the
    // RPC omits one side, the aggregate cannot safely distinguish a transfer
    // from an account creation/close, so refuse to settle it.
    if (value.pre === undefined || value.post === undefined) return undefined;
    delta += value.post - value.pre;
  }
  return delta;
}

/**
 * Parse a Jupiter/Solana transaction from owner-scoped SPL token balance
 * deltas. This intentionally does not parse arbitrary instructions: Jupiter
 * routes can contain many intermediate transfers, while the wallet-owned
 * aggregate is the stable accounting boundary.
 *
 * When a platform fee is configured (see engine.ts), Jupiter deducts it from
 * the output mint before delivery, so the wallet's received delta is already
 * net: positions stay exact while the fee is reconstructed arithmetically.
 * Network lamports are not trading fees and are not part of USDC accounting.
 */
export function parseSolanaJupiterFill(
  receipt: unknown,
  context: ReceiptParseContext,
): ReceiptFill | undefined {
  const transaction = receipt as SolanaTransaction;
  if (transaction.meta?.err) return undefined;
  if (!context.walletAddress || !context.sellToken || !context.buyToken || !/^\d+$/.test(context.sellAmount)) return undefined;
  if (context.sellToken === context.buyToken) return undefined;

  const sellDelta = balanceDelta(transaction, context.walletAddress, context.sellToken);
  const buyDelta = balanceDelta(transaction, context.walletAddress, context.buyToken);
  if (sellDelta === undefined || buyDelta === undefined || sellDelta >= 0n || buyDelta <= 0n) return undefined;

  const sellAmount = -sellDelta;
  if (sellAmount.toString() !== context.sellAmount) return undefined;
  return {
    sellToken: context.sellToken,
    buyToken: context.buyToken,
    sellAmount: sellAmount.toString(),
    buyAmount: buyDelta.toString(),
    feeAmount: jupiterPlatformFee(buyDelta, context),
    feeToken: "buy",
  };
}

/**
 * Jupiter takes the configured platform fee out of the output mint before
 * delivery, so the wallet's measured delta is net. Reconstruct the fee from
 * the measured net amount: fee = net * bps / (10000 - bps). Positions use
 * measured deltas and stay exact regardless; only this fee accounting
 * assumes the aggregator applied the configured bps.
 */
function jupiterPlatformFee(netBuyDelta: bigint, context: ReceiptParseContext): string {
  const bps = context.expectedFeeBps ?? 0;
  if (bps <= 0 || bps >= 10000) return "0";
  return (netBuyDelta * BigInt(bps) / BigInt(10000 - bps)).toString();
}

type EvmLog = { address?: string; topics?: string[]; data?: string };
type EvmReceipt = { status?: string; logs?: EvmLog[] | null };

/** Keccak256("Transfer(address,address,uint256)") — the ERC-20 transfer event. */
const EVM_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4dfbff2e9";

function addressFromTopic(hex: string): string | undefined {
  if (typeof hex !== "string" || !/^0x[0-9a-f]{64}$/i.test(hex)) return undefined;
  return "0x" + hex.slice(26).toLowerCase();
}

/**
 * Parse an ERC-20 swap fill from an EVM receipt using owner-scoped Transfer
 * log deltas. Aggregator routes can touch many intermediate pools, so the
 * wallet's net balance change per token is the stable accounting boundary —
 * the same principle as the Solana parser above.
 *
 * When an affiliate fee is configured (see engine.ts), 0x takes it from the
 * taker's sellAmount (the swapFeeToken leg we set), so the verified sell
 * delta still equals the requested amount and the fee is deterministic.
 * Gas is paid in the native token and is not part of USDC accounting.
 */
export function parseEvmTransferFill(
  receipt: unknown,
  context: ReceiptParseContext,
): ReceiptFill | undefined {
  const parsed = receipt as EvmReceipt;
  if (parsed?.status !== "0x1" || !Array.isArray(parsed.logs)) return undefined;
  if (!context.walletAddress || !/^0x[0-9a-f]{40}$/.test(context.walletAddress)) return undefined;
  if (!/^0x[0-9a-f]{40}$/i.test(context.sellToken) || !/^0x[0-9a-f]{40}$/i.test(context.buyToken)) return undefined;
  if (context.sellToken.toLowerCase() === context.buyToken.toLowerCase()) return undefined;
  if (!/^\d+$/.test(context.sellAmount)) return undefined;

  const owner = context.walletAddress.toLowerCase();
  const deltas = new Map<string, bigint>();
  let sawOwnedTransfer = false;
  for (const log of parsed.logs) {
    const topics = log?.topics ?? [];
    if (topics.length < 3 || String(topics[0]).toLowerCase() !== EVM_TRANSFER_TOPIC) continue;
    const token = typeof log.address === "string" ? log.address.toLowerCase() : "";
    if (token !== context.sellToken.toLowerCase() && token !== context.buyToken.toLowerCase()) continue;
    const from = addressFromTopic(String(topics[1]));
    const to = addressFromTopic(String(topics[2]));
    // ERC-20 Transfer carries the value in the log data (32 bytes). Anything
    // malformed or oversized is refused rather than silently truncated.
    const raw = log.data;
    if (typeof raw !== "string" || !/^0x[0-9a-f]{1,64}$/i.test(raw)) return undefined;
    const value = BigInt(raw);
    if (from === undefined && to === undefined) continue;
    sawOwnedTransfer = true;
    if (from === owner) deltas.set(token, (deltas.get(token) ?? 0n) - value);
    if (to === owner) deltas.set(token, (deltas.get(token) ?? 0n) + value);
  }
  if (!sawOwnedTransfer) return undefined;

  const sellDelta = deltas.get(context.sellToken.toLowerCase());
  const buyDelta = deltas.get(context.buyToken.toLowerCase());
  if (sellDelta === undefined || buyDelta === undefined || sellDelta >= 0n || buyDelta <= 0n) return undefined;
  const sellAmount = -sellDelta;
  if (sellAmount.toString() !== context.sellAmount) return undefined;
  return {
    sellToken: context.sellToken,
    buyToken: context.buyToken,
    sellAmount: sellAmount.toString(),
    buyAmount: buyDelta.toString(),
    feeAmount: evmAffiliateFee(sellAmount, context),
    feeToken: "sell",
  };
}

/** 0x swapFeeBps applies to the sell leg: fee = sellAmount * bps / 10000. */
function evmAffiliateFee(sellAmount: bigint, context: ReceiptParseContext): string {
  const bps = context.expectedFeeBps ?? 0;
  if (bps <= 0 || bps >= 10000) return "0";
  return (sellAmount * BigInt(bps) / 10000n).toString();
}

export class RpcReceiptProvider implements ReceiptProvider {
  constructor(private readonly rpcUrls: Record<string, string>) {}

  async getReceipt(chain: string, txHash: string, context?: ReceiptParseContext): Promise<ReceiptResult> {
    const rpcUrl = this.rpcUrls[chain];
    if (!rpcUrl) return { status: "pending", error: `no RPC configured for ${chain}` };
    if (chain === "solana") {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSignatureStatuses", params: [[txHash], { searchTransactionHistory: true }] }),
      });
      if (!response.ok) return { status: "pending", error: `RPC HTTP ${response.status}` };
      const body = await response.json() as { result?: { value?: Array<{ confirmationStatus?: string; err?: unknown } | null> } };
      const value = body.result?.value?.[0];
      if (!value) return { status: "pending" };
      if (value.err) return { status: "failed", receipt: value, error: "Solana transaction failed" };
      if (value.confirmationStatus !== "confirmed" && value.confirmationStatus !== "finalized") {
        return { status: "pending", receipt: value };
      }

      // A status entry proves confirmation, not the actual token amounts. Fetch
      // the full transaction before allowing accounting settlement.
      const transactionResponse = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 2, method: "getTransaction", params: [txHash, {
            encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0,
          }],
        }),
      });
      if (!transactionResponse.ok) {
        return { status: "confirmed", receipt: value, error: `transaction details HTTP ${transactionResponse.status}` };
      }
      const transactionBody = await transactionResponse.json() as { result?: SolanaTransaction | null; error?: unknown };
      if (transactionBody.error || !transactionBody.result) {
        return { status: "confirmed", receipt: value, error: "Solana transaction details unavailable" };
      }
      const receipt = transactionBody.result;
      if (receipt.meta?.err) return { status: "failed", receipt, error: "Solana transaction failed" };
      const fill = context ? parseSolanaJupiterFill(receipt, context) : undefined;
      return {
        status: "confirmed",
        receipt,
        fill,
        ...(fill ? {} : { error: "Solana receipt fill could not be verified" }),
      };
    }

    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [txHash] }),
    });
    if (!response.ok) return { status: "pending", error: `RPC HTTP ${response.status}` };
    const body = await response.json() as { result?: { status?: string } | null; error?: unknown };
    if (body.error) return { status: "pending", error: "EVM receipt lookup unavailable" };
    if (!body.result) return { status: "pending" };
    if (body.result.status === "0x1") {
      // A success status proves execution, not the exact token amounts. Parse
      // the Transfer deltas before allowing accounting settlement.
      const fill = context ? parseEvmTransferFill(body.result, context) : undefined;
      return {
        status: "confirmed",
        receipt: body.result,
        fill,
        ...(fill ? {} : { error: "EVM receipt fill could not be verified" }),
      };
    }
    if (body.result.status === "0x0") return { status: "failed", receipt: body.result, error: "EVM transaction reverted" };
    return { status: "pending", error: "EVM receipt status unavailable" };
  }
}

/**
 * Reconciles durable submitted/pending transactions. This class deliberately
 * does not project positions: settlement remains an explicit application step
 * once a receipt is verified and a fill can be inserted exactly once.
 */
export type SettlementHandler = (transaction: any, receipt: unknown, fill?: ReceiptFill) => Promise<void> | void;

/** Effective on-chain platform fee bps configured for a chain (0 = none). */
function expectedFeeBpsFor(chain: string): number {
  return chain === "solana" ? getSolanaPlatformFeeBps() : getEvmAffiliateFeeBps();
}

function receiptContext(tx: any): ReceiptParseContext | undefined {
  if (typeof tx.request_json !== "string") return undefined;
  try {
    const request = JSON.parse(tx.request_json) as { params?: Partial<ReceiptParseContext> & { amount?: string }; walletAddress?: string; platformFeeBps?: number };
    const params = request.params;
    if (!params || typeof request.walletAddress !== "string" || typeof params.sellToken !== "string" ||
      typeof params.buyToken !== "string" || typeof params.amount !== "string") return undefined;
    // Prefer the bps persisted with the session at prepare time: the fee can
    // legitimately differ from current env per swap (missing fee ATA on
    // Solana), and accounted history must not shift with config changes.
    const sessionBps = typeof request.platformFeeBps === "number" && Number.isInteger(request.platformFeeBps) && request.platformFeeBps >= 0 && request.platformFeeBps <= 1000
      ? request.platformFeeBps
      : undefined;
    return {
      walletAddress: request.walletAddress,
      sellToken: params.sellToken,
      buyToken: params.buyToken,
      sellAmount: params.amount,
      expectedFeeBps: sessionBps ?? expectedFeeBpsFor(tx.chain),
    };
  } catch {
    return undefined;
  }
}

export class ExecutionReconciler {
  constructor(
    private readonly db: AppDb,
    private readonly provider: ReceiptProvider,
    private readonly onSettled?: SettlementHandler,
  ) {}

  async reconcilePending(userId?: number): Promise<{ pending: number; confirmed: number; failed: number }> {
    const summary = { pending: 0, confirmed: 0, failed: 0 };
    for (const tx of this.db.getPendingExecutionTransactions(userId, Boolean(this.onSettled))) {
      if (tx.mode !== "live") continue;
      let result: ReceiptResult;
      try {
        result = await this.provider.getReceipt(tx.chain, tx.tx_hash, receiptContext(tx));
      } catch {
        summary.pending++;
        this.db.updateExecutionTransaction(tx.id, { errorMessage: "receipt provider unavailable; retry required" });
        continue;
      }
      // Another reconciliation may have settled this transaction during I/O.
      const latest = this.db.getExecutionTransaction(tx.intent_id);
      if (!latest || latest.status === "settled" || latest.status === "failed") continue;
      const current = latest.status as ExecutionStatus;
      if (result.status === "pending") {
        summary.pending++;
        if (current === "submitted") {
          assertTransition(current, "pending");
          this.db.updateExecutionTransaction(tx.id, { status: "pending" });
          this.db.updateExecutionIntent(tx.intent_id, { status: "pending" });
        }
        continue;
      }

      if (result.status === "failed") {
        summary.failed++;
        if (current !== "failed") assertTransition(current, "failed");
        this.db.updateExecutionTransaction(tx.id, {
          status: "failed",
          receiptJson: result.receipt === undefined ? null : JSON.stringify(result.receipt),
          errorMessage: result.error ?? "transaction failed",
        });
        this.db.updateExecutionIntent(tx.intent_id, { status: "failed", errorMessage: result.error ?? "transaction failed" });
        if (tx.trade_id) this.db.updateTradeStatus(tx.trade_id, "failed");
        continue;
      }

      if (result.status === "confirmed") {
        summary.confirmed++;
        if (current !== "confirmed") assertTransition(current, "confirmed");
        this.db.updateExecutionTransaction(tx.id, {
          status: "confirmed",
          receiptJson: result.receipt === undefined ? null : JSON.stringify(result.receipt),
          errorMessage: result.error ?? null,
        });
        this.db.updateExecutionIntent(tx.intent_id, { status: "confirmed", errorMessage: result.error ?? null });
        if (tx.trade_id) this.db.updateTradeStatus(tx.trade_id, "confirmed");
        // Settlement may fail independently of receipt confirmation (for
        // example, a malformed fill payload). Keeping the transaction in
        // confirmed + unfilled makes the next reconciliation retry safely.
        if (this.onSettled && result.fill) await this.onSettled(tx, result.receipt, result.fill);
        continue;
      }

      throw new Error(`unsupported receipt status: ${String(result.status)}`);
    }
    return summary;
  }
}
