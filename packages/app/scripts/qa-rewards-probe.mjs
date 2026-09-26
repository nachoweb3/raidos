/**
 * Sonda read-only del programa de rewards (no reclama, no mueve fondos):
 * wallet efímera ed25519 → login self-serve → GET /api/rewards (config REAL:
 * tasas de trading/referral, cap diario, modo) → leaderboard público →
 * /api/referrals/link (forma del link). Sirve para auditar que el copy de la
 * UI (landing "cashback del 20%") coincide con la configuración del backend.
 * Ejecutar: QA_BASE=https://raidos-api.fly.dev node scripts/qa-rewards-probe.mjs
 */
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import bs58 from "bs58";

const BASE = process.env.QA_BASE || "http://localhost:8930";

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
console.log(`\n── Rewards probe (${BASE}, read-only, no claim) ──`);

// 1) /api/rewards — config real expuesta al usuario
const rewards = await (await fetch(BASE + "/api/rewards", { headers: authed })).json();
const cfg = rewards?.stats?.config ?? null;
console.log("  mode:", rewards?.mode, "| flag:", rewards?.flag, "| refCode:", rewards?.refCode ?? "(null)");
console.log("  config:", JSON.stringify(cfg));
check("/api/rewards responde con balance + stats", Boolean(rewards?.balance) && Boolean(rewards?.stats));
check("stats.config expone tradingRewardRate + referralRewardRate numéricos",
  cfg && Number.isFinite(Number(cfg.tradingRewardRate)) && Number.isFinite(Number(cfg.referralRewardRate)), JSON.stringify(cfg));
check("maxDailyRewardUsdc numérico", cfg && Number.isFinite(Number(cfg.maxDailyRewardUsdc)), JSON.stringify(cfg));
const tRate = Number(cfg?.tradingRewardRate), rRate = Number(cfg?.referralRewardRate);
console.log(`  ⇒ tasas efectivas: trading ${(tRate * 100).toFixed(1)}% · referral ${(rRate * 100).toFixed(1)}% · cap diario $${Number(cfg?.maxDailyRewardUsdc)}`);
check("suma de tasas <= 100% del fee", tRate + rRate <= 1, String(tRate + rRate));
check("balance nuevo es 0 honesto", Number(rewards?.balance?.availableUsdc ?? -1) === 0, JSON.stringify(rewards?.balance));

// 2) Leaderboard público
const lb = await (await fetch(BASE + "/api/rewards/leaderboard?period=all&limit=5")).json();
check("leaderboard público 200 con leaders[]", Array.isArray(lb?.leaders), JSON.stringify(lb).slice(0, 100));

// 3) Link de referidos (forma servida por el backend)
const link = await (await fetch(BASE + "/api/referrals/link", { headers: authed })).json();
console.log("  referrals/link:", JSON.stringify(link));
check("refCode + link presentes", Boolean(link?.refCode) && typeof link?.link === "string", JSON.stringify(link));

console.log(`\n${pass}/${pass + fail} checks`);
process.exit(fail ? 1 : 0);
