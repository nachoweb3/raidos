/**
 * E2E real en PRODUCCIÓN: ciclo completo del grafo de follows.
 * Dos identidades wallet efímeras (ed25519 nativo de node:crypto, gratis, sin gas)
 * → login self-serve → A sigue a B → estado, listados, "me", unfollow, guards.
 * No toca dinero ni trading.
 */
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import bs58 from "bs58";

const BASE = process.env.QA_BASE || "https://raidos-api.fly.dev";

function makeWallet() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPub = publicKey.export({ type: "spki", format: "der" }).subarray(-32); // last 32 bytes = raw ed25519
  const address = bs58.encode(rawPub);
  // Server expects raw ed25519 signature as hex (verify-login.ts: Buffer.from(sig, "hex"))
  const sign = (message) => cryptoSign(null, Buffer.from(message, "utf8"), privateKey).toString("hex");
  return { address, sign };
}

async function walletLogin(label) {
  const kp = makeWallet();
  const ch = await (await fetch(BASE + "/api/auth/challenge", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chain: "solana" }),
  })).json();
  const signature = kp.sign(ch.message);
  const res = await fetch(BASE + "/api/auth/wallet", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chain: "solana", address: kp.address, message: ch.message, signature, nonce: ch.nonce }),
  });
  if (!res.ok) throw new Error(`wallet login ${label} failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { userId: data.userId, apiKey: data.apiKey, address: kp.address };
}

const authed = (key) => ({ "Content-Type": "application/json", Authorization: "Bearer " + key });

const out = { steps: [] };
const step = (name, detail) => { out.steps.push({ name, ...detail }); console.error(name, JSON.stringify(detail)); };

const a = await walletLogin("A");
const b = await walletLogin("B");
step("two-wallet-logins", { a: a.userId, b: b.userId, distinct: a.userId !== b.userId });

// A follows B
const fol = await (await fetch(`${BASE}/api/users/${b.userId}/follow`, { method: "POST", headers: authed(a.apiKey) })).json();
step("follow", fol);

// State + idempotency
const st = await (await fetch(`${BASE}/api/users/${b.userId}/follow`, { headers: authed(a.apiKey) })).json();
const again = await (await fetch(`${BASE}/api/users/${b.userId}/follow`, { method: "POST", headers: authed(a.apiKey) })).json();
step("state-and-idempotent", { state: st, again });

// "me" listing
const mine = await (await fetch(`${BASE}/api/users/me/following`, { headers: authed(a.apiKey) })).json();
step("me-following", { count: mine.following.length, first: mine.following[0] ?? null });

// Public followers of B sees A
const folwers = await (await fetch(`${BASE}/api/users/${b.userId}/followers`)).json();
step("b-followers", { count: folwers.followers.length, first: folwers.followers[0] ?? null });

// B's following list (empty) — canonical shape regardless
const bFollowing = await (await fetch(`${BASE}/api/users/${b.userId}/following`)).json();
step("b-following-empty", { count: bFollowing.following.length });

// Unfollow cycle
const unf = await (await fetch(`${BASE}/api/users/${b.userId}/follow`, { method: "DELETE", headers: authed(a.apiKey) })).json();
const stAfter = await (await fetch(`${BASE}/api/users/${b.userId}/follow`, { headers: authed(a.apiKey) })).json();
step("unfollow", { unf, stateAfter: stAfter });

// Self-follow guard + unknown user guard
const selfF = await fetch(`${BASE}/api/users/${a.userId}/follow`, { method: "POST", headers: authed(a.apiKey) });
const ghost = await fetch(`${BASE}/api/users/424242/follow`, { method: "POST", headers: authed(a.apiKey) });
step("guards", { selfFollow: selfF.status, unknownUser: ghost.status });

const ok =
  a.userId !== b.userId &&
  fol.following === true && fol.created === true && fol.followersCount === 1 &&
  st.following === true && again.created === false &&
  mine.following.length === 1 && mine.following[0].userId === b.userId &&
  folwers.followers.length === 1 && folwers.followers[0].userId === a.userId &&
  bFollowing.following.length === 0 &&
  unf.removed === true && stAfter.following === false &&
  selfF.status === 400 && ghost.status === 404;

console.log("E2E-FOLLOWS-RESULT " + (ok ? "PASS" : "FAIL"));
console.log(JSON.stringify(out, null, 1));
process.exit(ok ? 0 : 1);
