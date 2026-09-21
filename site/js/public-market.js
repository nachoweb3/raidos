// Read-only public provider fallback when the shared server exhausts its quota.
// No application credentials are sent to the provider. Respect 429 cooldowns.
const networks = { solana: "solana", ethereum: "eth", base: "base", bsc: "bsc" };
const cache = new Map(), pending = new Map();
let retryAfter = 0;
const keyFor = (chain, address) => chain === "solana" ? address : address.toLowerCase();
export function normalizePoolTrades(body, chain, pool, token) {
  if (!Array.isArray(body?.data)) throw Error("Actividad no disponible");
  const seen = new Set();
  return body.data.slice(0, 300).flatMap(row => {
    const a = row?.attributes;
    if (!a || typeof row.id !== "string" || seen.has(row.id)) return [];
    const matches = value => typeof value === "string" && keyFor(chain, value) === keyFor(chain, token);
    const buy = matches(a.to_token_address), sell = matches(a.from_token_address);
    const priceUsd = Number(buy ? a.price_to_in_usd : a.price_from_in_usd);
    const volumeUsd = Number(a.volume_in_usd), time = Math.floor(Date.parse(a.block_timestamp) / 1000);
    const amount = buy ? a.to_token_amount : a.from_token_amount;
    if (buy === sell || !Number.isFinite(time) || time <= 0 || !Number.isFinite(priceUsd) || priceUsd <= 0 ||
        a.volume_in_usd == null || !Number.isFinite(volumeUsd) || volumeUsd < 0 ||
        typeof amount !== "string" || !/^\d+(\.\d+)?$/.test(amount) ||
        typeof a.tx_hash !== "string" || !/^[A-Za-z0-9]{32,160}$/.test(a.tx_hash) ||
        typeof a.tx_from_address !== "string" || !/^[A-Za-z0-9]{20,100}$/.test(a.tx_from_address)) return [];
    seen.add(row.id);
    return [{ id: row.id, chain, pool, token, time, side: buy ? "buy" : "sell", priceUsd, volumeUsd, amount, wallet: a.tx_from_address, txHash: a.tx_hash }];
  }).sort((a, b) => b.time - a.time);
}
export function normalizePoolCandles(body) {
  const rows = body?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(rows)) throw Error("Historial no disponible");
  const candles = new Map();
  for (const row of rows.slice(0, 100)) {
    if (!Array.isArray(row) || row.length < 6 || !row.slice(0, 6).every(v => typeof v === "number" && Number.isFinite(v))) continue;
    const [time, open, high, low, close, volume] = row;
    if (!Number.isInteger(time) || time <= 0 || low < 0 || high < Math.max(open, close) || low > Math.min(open, close) || volume < 0) continue;
    candles.set(time, { time, open, high, low, close, volume });
  }
  return [...candles.values()].sort((a, b) => a.time - b.time);
}
export async function publicPoolData(kind, chain, pool, token, aggregate = 5) {
  if (!networks[chain] || ![pool, token].every(value => typeof value === "string" && /^[A-Za-z0-9:_-]{20,160}$/.test(value)) ||
      !["trades", "candles"].includes(kind) || ![1, 5, 15].includes(aggregate)) throw Error("Pool no compatible");
  const path = `/networks/${networks[chain]}/pools/${encodeURIComponent(pool)}/` + (kind === "trades" ? "trades" :
    `ohlcv/minute?aggregate=${aggregate}&limit=100&currency=usd&token=${encodeURIComponent(token)}`);
  const key = path + ":" + token, cached = cache.get(key), ttl = kind === "trades" ? 30000 : 60000;
  if (cached && Date.now() - cached.asOf < ttl) return cached;
  if (pending.has(key)) return pending.get(key);
  const task = (async () => {
    try {
      if (Date.now() < retryAfter) throw Error("Proveedor en pausa por cuota");
      const response = await fetch("https://api.geckoterminal.com/api/v2" + path,
        { credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(8000), headers: { Accept: "application/json" } });
      if (response.status === 429) { retryAfter = Date.now() + 60000; throw Error("Cuota del proveedor agotada"); }
      if (!response.ok) throw Error("Proveedor no disponible");
      const body = await response.json();
      const result = { [kind]: kind === "trades" ? normalizePoolTrades(body, chain, pool, token) : normalizePoolCandles(body),
        source: "geckoterminal", status: "LIVE", asOf: Date.now(), transport: "public-browser", completeHistory: false };
      if (cache.size >= 30) cache.delete(cache.keys().next().value);
      cache.set(key, result); return result;
    } catch (error) {
      if (cached && Date.now() - cached.asOf <= 300000) return { ...cached, status: "DEGRADED" };
      throw error;
    }
  })();
  pending.set(key, task);
  try { return await task; } finally { pending.delete(key); }
}
