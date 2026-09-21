// Live E2E against https://raidos-api.fly.dev (production API).
// Ephemeral wallets are generated in-process and discarded. No broadcast of
// any transaction: prepare returns an unsigned payload; submit is only probed
// with an invented hash that must be rejected. No funds involved.
import { generateKeyPairSync, createSign, createHash, randomBytes } from "node:crypto";
import { ethers } from "ethers";
import bs58 from "bs58";

const API = "https://raidos-api.fly.dev";
const BOOTSTRAP_SECRET = process.env.BOOTSTRAP_SECRET;
if (!BOOTSTRAP_SECRET) throw new Error("BOOTSTRAP_SECRET env required");
const results = {};

// ── Ephemeral Solana keypair (ed25519) ──
function solanaKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ type: "spki", format: "der" }).subarray(-32); // last 32 bytes
  const priv = privateKey.export({ type: "pkcs8", format: "der" });
  const address = bs58.encode(pub);
  return {
    address,
    sign(message) {
      const signer = createSign("sha256"); // unused for ed25519; node signs raw
      return signEd25519(priv, Buffer.from(message, "utf8"));
    },
  };
}
import { sign as ed25519Sign, createPrivateKey } from "node:crypto";
function signEd25519(pkcs8Der, message) {
  const key = createPrivateKey({ key: pkcs8Der, format: "der", type: "pkcs8" });
  return ed25519Sign(null, message, key);
}

// ── Ephemeral EVM wallet ──
function evmWallet() {
  return ethers.Wallet.createRandom();
}

const sol = solanaKeypair();
const evm = evmWallet();
results.ephemeralSolana = sol.address.slice(0, 6) + "…";
results.ephemeralEvm = evm.address.slice(0, 8) + "…";

// ── Register a throwaway beta account (ACCESS_CODES gated) ──
const reg = await fetch(API + "/api/auth/register", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ bootstrapSecret: BOOTSTRAP_SECRET }),
});
if (!reg.ok) throw new Error("register failed: " + reg.status);
const { apiKey, userId } = await reg.json();
const auth = { "Content-Type": "application/json", Authorization: "Bearer " + apiKey };
const idem = () => ({ "Idempotency-Key": "e2e-" + randomBytes(9).toString("hex") });
results.registered = true;

async function call(path, body, extra = {}) {
  const headers = { ...auth, ...extra };
  if (body !== undefined && !headers["Idempotency-Key"]) Object.assign(headers, idem());
  return fetch(API + path, {
    method: body === undefined ? "GET" : "POST",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

// ── Link Solana wallet via real signed challenge ──
{
  const ch = await (await call("/api/auth/challenge", { chain: "solana" })).json();
  const sig = sol.sign(ch.message);
  const link = await call("/api/wallet/link", {
    chain: "solana", address: sol.address, message: ch.message,
    signature: Buffer.from(sig).toString("hex"), nonce: ch.nonce,
  });
  if (!link.ok) throw new Error("solana link failed: " + link.status + " " + await link.text());
  results.solanaLink = "ok";
}

// ── Link EVM wallet via real signed challenge ──
{
  const ch = await (await call("/api/auth/challenge", { chain: "evm" })).json();
  const sig = await evm.signMessage(ch.message);
  const link = await call("/api/wallet/link", {
    chain: "evm", address: evm.address, message: ch.message, signature: sig, nonce: ch.nonce,
  });
  if (!link.ok) throw new Error("evm link failed: " + link.status + " " + await link.text());
  results.evmLink = "ok";
}

// ── Prepare a real Solana swap (USDC → BONK). Returns unsigned tx. ──
{
  const res = await call("/api/trades/prepare", {
    fromChain: "solana", toChain: "solana",
    sellToken: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    buyToken: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    amount: "100000", // 0.1 USDC
    walletAddress: sol.address,
  });
  const body = await res.json();
  if (res.status !== 200) throw new Error("solana prepare failed: " + res.status + " " + JSON.stringify(body).slice(0, 300));
  if (body.unsignedTransaction?.kind !== "solana" || !body.unsignedTransaction.serialized) {
    throw new Error("no unsigned Solana transaction returned");
  }
  results.solanaPrepare = { quoteAggregator: body.quote?.aggregator, route: body.quote?.route?.slice(0, 40), unsignedTxBytes: atob(body.unsignedTransaction.serialized).length };
}

// ── Prepare a real Base swap (USDC → WETH). Returns unsigned calldata. ──
{
  const res = await call("/api/trades/prepare", {
    fromChain: "base", toChain: "base",
    sellToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    buyToken: "0x4200000000000000000000000000000000000006",
    amount: "100000",
    walletAddress: evm.address,
  });
  const body = await res.json();
  if (res.status !== 200) throw new Error("base prepare failed: " + res.status + " " + JSON.stringify(body).slice(0, 300));
  if (body.unsignedTransaction?.kind !== "evm" || !body.unsignedTransaction.data) {
    throw new Error("no unsigned EVM transaction returned");
  }
  results.basePrepare = { aggregator: body.quote?.aggregator, to: body.unsignedTransaction.to, calldataBytes: (body.unsignedTransaction.data.length - 2) / 2 };
}

// ── Submit with an invented hash must be accepted into lifecycle but stay
// pending (receipt will never verify) — and a replay must be 409. ──
{
  const sessionId = (await (await call("/api/trades/prepare", {
    fromChain: "solana", toChain: "solana",
    sellToken: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    buyToken: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    amount: "100000", walletAddress: sol.address,
  })).json()).sessionId;
  const fakeHash = "5Fake" + randomBytes(16).toString("hex") + "aaaa";
  const sub = await call("/api/trades/submit", { sessionId, txHash: fakeHash });
  const subBody = await sub.json();
  if (sub.status !== 202 || !subBody.transactionId) throw new Error("submit should register a transaction: " + sub.status);
  results.submitLifecycle = { status: subBody.status, intentId: subBody.intentId };
  const replay = await call("/api/trades/submit", { sessionId, txHash: fakeHash });
  if (replay.status !== 409) throw new Error("replay must be 409, got " + replay.status);
  results.replayRejected = true;
}

results.noBroadcast = "no transaction was signed or sent on-chain";
console.log(JSON.stringify(results, null, 2));
