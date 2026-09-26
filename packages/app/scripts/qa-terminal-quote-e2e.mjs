/**
 * E2E real del FORMULARIO del terminal (cotización, no ejecución — no toca dinero):
 * wallet efímera ed25519 → login self-serve → /api/wallets/balances (saldo real,
 * vacío honesto) → GET /api/market/token-info (decimales on-chain de USDC) →
 * POST /api/trades/quote BUY USDC→SOL y SELL SOL→USDC con slippage del form.
 * Ejecutar: QA_BASE=http://localhost:8930 node scripts/qa-terminal-quote-e2e.mjs
 */
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import bs58 from "bs58";

const BASE = process.env.QA_BASE || "http://localhost:8930";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL = "So11111111111111111111111111111111111111112";

function makeWallet() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPub = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const address = bs58.encode(rawPub);
  const sign = (message) => cryptoSign(null, Buffer.from(message, "utf8"), privateKey).toString("hex");
  return { address, sign };
}

const kp = makeWallet();
const ch = await (await fetch(BASE + "/api/auth/challenge", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ chain: "solana" }),
})).json();
const login = await fetch(BASE + "/api/auth/wallet", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ chain: "solana", address: kp.address, message: ch.message, signature: kp.sign(ch.message), nonce: ch.nonce }),
});
if (!login.ok) throw new Error("login failed: " + login.status + " " + await login.text());
const { apiKey } = await login.json();
const authed = { "Content-Type": "application/json", Authorization: "Bearer " + apiKey };

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); }
};
console.log("\n── E2E quote flow (ephemeral wallet, no funds moved) ──");

// 1) Real balance scan for the fresh wallet: honest zero/empty, no invention.
const balances = await (await fetch(BASE + "/api/wallets/balances", { headers: authed })).json();
const mine = (balances.balances ?? []).find((w) => w.address?.toLowerCase() === kp.address.toLowerCase());
check("balance scan includes the linked wallet", Boolean(mine), JSON.stringify(balances).slice(0, 120));
check("fresh wallet reports honest zero SOL", mine?.nativeAmount === 0, String(mine?.nativeAmount));

// 2) On-chain decimals for USDC (real RPC, not a constant).
const info = await (await fetch(BASE + `/api/market/token-info?chain=solana&address=${USDC}`)).json();
check("token-info decimals=6 for USDC", info.decimals === 6, JSON.stringify(info).slice(0, 120));

// 3) BUY quote 0.5 USDC → SOL with form slippage 50bps (real Jupiter route).
const buyQuote = await (await fetch(BASE + "/api/trades/quote", {
  method: "POST", headers: authed,
  body: JSON.stringify({ fromChain: "solana", toChain: "solana", sellToken: USDC, buyToken: WSOL, amount: "500000", type: "swap", slippageBps: 50 }),
})).json();
check("BUY quote returns buyAmount", BigInt(buyQuote?.quote?.buyAmount ?? 0) > 0n, JSON.stringify(buyQuote).slice(0, 140));
const solOut = Number(BigInt(buyQuote.quote.buyAmount)) / 1e9;
check("BUY ~0.5 USDC → sane SOL amount", solOut > 0.001 && solOut < 1, String(solOut));

// 4) SELL quote uses TOKEN smallest units (9 for wSOL), NOT micro-USDC.
const sellQuote = await (await fetch(BASE + "/api/trades/quote", {
  method: "POST", headers: authed,
  body: JSON.stringify({ fromChain: "solana", toChain: "solana", sellToken: WSOL, buyToken: USDC, amount: "100000000", type: "swap", slippageBps: 100 }),
})).json();
const usdcOut = Number(BigInt(sellQuote?.quote?.buyAmount ?? 0)) / 1e6;
check("SELL 0.1 wSOL (1e8 base units) → sane USDC", usdcOut > 1 && usdcOut < 100, String(usdcOut));

// 5) Slippage is validated server-side (form cannot send garbage).
const badSlip = await fetch(BASE + "/api/trades/quote", {
  method: "POST", headers: authed,
  body: JSON.stringify({ fromChain: "solana", toChain: "solana", sellToken: USDC, buyToken: WSOL, amount: "500000", type: "swap", slippageBps: 9999 }),
});
check("slippageBps 9999 rejected 400", badSlip.status === 400, String(badSlip.status));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
