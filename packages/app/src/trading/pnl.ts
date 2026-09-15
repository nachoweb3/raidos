import { getChain } from "../chains/config.js";

/** Accounting reports use micro-USDC; asset quantities remain base-unit strings. */
export function toMicroUsdc(amount: string, chain: string): bigint {
  const decimals = getChain(chain)?.usdcDecimals;
  if (decimals === undefined) throw new Error("unknown accounting chain");
  const units = BigInt(amount);
  return decimals >= 6 ? units / (10n ** BigInt(decimals - 6)) : units * (10n ** BigInt(6 - decimals));
}

export function isUsdc(token: string, chain: string): boolean {
  const config = getChain(chain);
  return token.toUpperCase() === "USDC" || Boolean(config && (config.evm
    ? token.toLowerCase() === config.usdcAddress.toLowerCase()
    : token === config.usdcAddress));
}

export function summarizeSettledTrades(userId: number, trades: any[]) {
  let totalPnl = 0n, volume = 0n, fees = 0n;
  let wins = 0, losses = 0, realizedTrades = 0;
  let best: bigint | undefined, worst: bigint | undefined;
  const byChain: Record<string, bigint> = {};
  const tokens: Record<string, { balance: bigint; realized: bigint }> = {};
  for (const trade of trades) {
    const chain = trade.from_chain;
    const isBuy = isUsdc(trade.sell_token, chain);
    const token = isBuy ? trade.buy_token : trade.sell_token;
    const assetKey = chain + ":" + (getChain(chain)?.evm ? token.toLowerCase() : token);
    const asset = tokens[assetKey] ??= { balance: 0n, realized: 0n };
    asset.balance += isBuy ? BigInt(trade.buy_amount) : -BigInt(trade.sell_amount);
    // Buys do not realize PnL, including buys after a partial sale.
    const raw = isBuy ? null : trade.realized_pnl_usdc;
    const pnl = raw == null || raw === "null" ? 0n : BigInt(raw);
    if (raw != null && raw !== "null") {
      realizedTrades++;
      if (pnl > 0n) wins++;
      if (pnl < 0n) losses++;
      if (best === undefined || pnl > best) best = pnl;
      if (worst === undefined || pnl < worst) worst = pnl;
    }
    totalPnl += pnl;
    asset.realized += pnl;
    byChain[chain] = (byChain[chain] ?? 0n) + pnl;
    volume += toMicroUsdc(isBuy ? trade.sell_amount : trade.buy_amount, chain);
    fees += BigInt(trade.fee_usdc);
  }
  return {
    userId,
    totalPnlUsdc: totalPnl.toString(),
    pnlByChain: Object.fromEntries(Object.entries(byChain).map(([chain, pnl]) => [chain, pnl.toString()])),
    winRate: realizedTrades ? wins / realizedTrades * 100 : 0,
    totalTrades: trades.length,
    realizedTrades,
    winningTrades: wins,
    losingTrades: losses,
    bestTradePnlUsdc: (best ?? 0n).toString(),
    worstTradePnlUsdc: (worst ?? 0n).toString(),
    totalFeesUsdc: fees.toString(),
    volumeUsdc: volume.toString(),
    avgTradeSizeUsdc: trades.length ? (volume / BigInt(trades.length)).toString() : "0",
    pnlByToken: Object.fromEntries(Object.entries(tokens).map(([key, asset]) => [
      key, { balance: asset.balance.toString(), realizedPnlUsdc: asset.realized.toString() },
    ])),
  };
}
