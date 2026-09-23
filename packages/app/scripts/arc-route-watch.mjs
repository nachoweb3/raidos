#!/usr/bin/env node
/**
 * 🔭 ARC ROUTE WATCH — probes whether any EVM aggregator has real swap
 * routes on Arc (chainId 5042) yet.
 *
 * Honesty contract: this script INVENTS NOTHING. It takes the top pools on
 * Arc from GeckoTerminal (live, indexed), picks a real token pair, and asks
 * real aggregators for a quote:
 *   1. 0x Swap API v2  (what our engine uses — the flip target)
 *   2. Li.Fi           (public API, second opinion + future alternative)
 *
 * Exit codes:
 *   0 = at least one aggregator returned a routable quote  → time to flip
 *       SELF_CUSTODY_CHAINS in src/api/server.ts to include "arc".
 *   1 = no routes anywhere (expected until Arc DEX liquidity matures).
 *   2 = probe infrastructure failure (network/GeckoTerminal down) — retry later.
 *
 * Usage:
 *   node scripts/arc-route-watch.mjs            # one-shot probe
 *   node scripts/arc-route-watch.mjs --loop     # poll every 6h until routes
 *
 * Requires ZERO_X_API_KEY for the 0x probe (already in fly secrets); Li.Fi
 * needs no key. Read-only GETs — never moves funds, never needs keys of value.
 */

const ARC_CHAIN_ID = 5042;
const GT_NETWORK = "arc";
const ZERO_X_API_KEY = process.env.ZERO_X_API_KEY || "";
const LOOP_MS = 6 * 60 * 60 * 1000;
const UA = "trenches-arc-watch/1.0 (+https://inusaur.online)";

const j = async (url, opts = {}) => {
  const res = await fetch(url, {
    ...opts,
    headers: { accept: "application/json", "user-agent": UA, ...(opts.headers || {}) },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* non-JSON error body */ }
  return { status: res.status, body, text: text.slice(0, 400) };
};

/** Top Arc pools from GeckoTerminal → pick a real non-USDC token with liquidity. */
async function pickRealPair() {
  const gt = await j(
    `https://api.geckoterminal.com/api/v2/networks/${GT_NETWORK}/pools?sort=h24_volume_usd_desc&pool_creation_hour_threshold=6`
  );
  if (gt.status === 429) { console.error("⚠️  GeckoTerminal 429 (cuota IP) — reintenta más tarde."); return null; }
  if (gt.status !== 200 || !Array.isArray(gt.body?.data) || gt.body.data.length === 0) {
    console.error(`⚠️  GeckoTerminal ${gt.status} sin pools para arc — ¿sigue indexando la red?`);
    return null;
  }
  for (const pool of gt.body.data) {
    const attrs = pool.attributes ?? {};
    const vol = Number(attrs.volume_usd?.h24 ?? 0);
    const addr = attrs.address ?? "";
    if (vol <= 0 || !addr) continue;
    // relation[0] = pool tokens; take the first non-native, non-USDC token
    const tokens = pool.relationships?.base_token?.data ?? [];
    for (const t of tokens) {
      const tokenAddr = t.id.split("_")[1] ?? "";
      const native = attrs.address && tokenAddr.toLowerCase() === addr.toLowerCase();
      const isUsdc = tokenAddr.toLowerCase() === "0x3600000000000000000000000000000000000000";
      if (tokenAddr && !native && !isUsdc) {
        return { token: tokenAddr, pool: addr, poolName: attrs.name ?? "?", vol24h: vol };
      }
    }
  }
  console.error("⚠️  Pools de Arc sin token ejecutable distinto de USDC todavía.");
  return null;
}

/** 0x Swap API v2 quote — same endpoint+auth our trading engine uses. */
async function probe0x(token) {
  const url = new URL("https://api.0x.org/swap/permit2/quote");
  url.searchParams.set("chainId", String(ARC_CHAIN_ID));
  url.searchParams.set("sellToken", "0x3600000000000000000000000000000000000000"); // native USDC
  url.searchParams.set("buyToken", token);
  url.searchParams.set("sellAmount", "1000000"); // 1 USDC (6 dec) — la menor apuesta honesta
  url.searchParams.set("taker", "0x000000000000000000000000000000000000dead"); // quote-only, sin fondos
  const r = await j(url, { headers: { "0x-version": "v2", ...(ZERO_X_API_KEY ? { "0x-api-key": ZERO_X_API_KEY } : {}) } });
  if (r.status === 200 && r.body?.buyAmount) {
    return { ok: true, detail: `buyAmount=${r.body.buyAmount} route=${r.body.route?.blocks ? "con bloques" : "sí"}` };
  }
  if (r.status === 404) return { ok: false, detail: "404 no route (0x no tiene liquidez en Arc)" };
  if (r.status === 400) return { ok: false, detail: `400 ${r.body?.reason ?? r.body?.validationErrors?.[0]?.reason ?? "bad request"} (chain soportada, sin ruta)` };
  if (r.status === 401 || r.status === 403) return { ok: false, detail: `${r.status} auth — revisa ZERO_X_API_KEY` };
  return { ok: false, detail: `${r.status} ${r.text.slice(0, 120)}` };
}

/** Li.Fi public chain list — binary check: is Arc routable at all? */
async function probeLiFi() {
  const r = await j("https://li.quest/v1/chains");
  if (r.status !== 200 || !Array.isArray(r.body)) return { ok: false, detail: `${r.status} — no pude listar cadenas` };
  const arc = r.body.find((c) => c.id === ARC_CHAIN_ID || String(c.key ?? "").toLowerCase() === "arc" || c.metamask?.chainId === `0x${ARC_CHAIN_ID.toString(16)}`);
  return arc
    ? { ok: true, detail: `Li.Fi la lista como "${arc.name}" (chainId ${arc.id})` }
    : { ok: false, detail: "no listada en Li.Fi" };
}

async function probe() {
  console.log(`\n🔭 ${new Date().toISOString()} — vigilancia de rutas Arc (chainId ${ARC_CHAIN_ID})`);
  const pair = await pickRealPair();
  if (!pair) {
    console.log("   Sin par ejecutable hoy. Estado: NO ROUTES (esperado).");
    return 2;
  }
  console.log(`   Par real: USDC → ${pair.token}`);
  console.log(`   Pool: ${pair.poolName} · vol24h $${Math.round(pair.vol24h).toLocaleString("en-US")}`);

  const zx = await probe0x(pair.token);
  console.log(`   0x    : ${zx.ok ? "✅ RUTA" : "—"} ${zx.detail}`);
  const lifi = await probeLiFi();
  console.log(`   Li.Fi : ${lifi.ok ? "✅ LISTADA" : "—"} ${lifi.detail}`);

  if (zx.ok) {
    console.log("\n🟢 ¡0x tiene rutas en Arc! TOCA EL FLIP:");
    console.log('   1. Añade "arc" a SELF_CUSTODY_CHAINS en packages/app/src/api/server.ts');
    console.log("   2. pnpm test && deploy en Fly");
    return 0;
  }
  console.log("\n⚪ Sin rutas aún (0x). Datos de mercado de Arc siguen vivos; swaps siguen honestamente OFF.");
  return 1;
}

const loop = process.argv.includes("--loop");
const code = await probe();
if (loop) {
  console.log(`\n🔁 --loop: repito cada ${LOOP_MS / 3_600_000}h hasta que haya rutas (Ctrl+C para parar).`);
  setInterval(async () => {
    const c = await probe();
    if (c === 0) process.exit(0);
  }, LOOP_MS);
} else {
  process.exit(code);
}
