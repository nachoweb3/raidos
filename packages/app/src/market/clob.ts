/**
 * ⚡ POLYMARKET CLOB EXECUTION — place real YES/NO orders on Polymarket.
 *
 * V2 flow (2026):
 *   1. L1: sign ClobAuth EIP-712 with the user's Polygon wallet → credentials
 *   2. L2: HMAC-SHA256 signed private requests (order book, order placement)
 *   3. Order: sign the Polymarket CTF Exchange EIP-712 Order with the wallet
 *
 * Our users' Polygon wallets are EOAs → signatureType 0, no proxy wallet.
 * The wallet must hold USDC (Polygon) + a little POL for the one-time
 * USDC approval of the exchange contract.
 */

import { ethers } from "ethers";

const CLOB = "https://clob.polymarket.com";

/** Standard (non-negative-risk) CTF Exchange on Polygon. */
export const CTF_EXCHANGE = "0xE111180000d2663C0091e4f400237545B87B996B";
const CTF_DOMAIN = { name: "Polymarket CTF Exchange", version: "2", chainId: 137, verifyingContract: CTF_EXCHANGE };

export interface ClobCredentials {
  apiKey: string;
  secret: string;       // base64 — decodes to the HMAC key
  passphrase: string;
}

export interface ClobOrderBook {
  bids: { price: string; size: string }[];
  asks: { price: string; size: string }[];
  minOrderSize: string;
  tickSize: string;
  negRisk: boolean;
}

/** ═══ L1 → credentials ═══ */

async function clobL1Signature(wallet: ethers.Wallet): Promise<{ address: string; timestamp: string; nonce: string; signature: string }> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = "0";
  const domain = { name: "ClobAuthDomain", version: "1", chainId: 137 };
  const types = {
    ClobAuth: [
      { name: "address", type: "address" },
      { name: "timestamp", type: "string" },
      { name: "nonce", type: "uint256" },
      { name: "message", type: "string" },
    ],
  };
  const value = {
    address: wallet.address,
    timestamp,
    nonce,
    message: "This message attests that I control the given wallet",
  };
  const signature = await wallet.signTypedData(domain, types, value);
  return { address: wallet.address, timestamp, nonce, signature };
}

/** Create (or derive) CLOB L2 credentials for a wallet. Cached per address. */
const credCache = new Map<string, { at: number; creds: ClobCredentials }>();

export async function getClobCredentials(wallet: ethers.Wallet): Promise<ClobCredentials> {
  const hit = credCache.get(wallet.address.toLowerCase());
  if (hit && Date.now() - hit.at < 15 * 60_000) return hit.creds;

  const auth = await clobL1Signature(wallet);
  const res = await fetch(`${CLOB}/auth/api-key`, {
    method: "POST",
    headers: {
      POLY_ADDRESS: auth.address,
      POLY_SIGNATURE: auth.signature,
      POLY_TIMESTAMP: auth.timestamp,
      POLY_NONCE: auth.nonce,
    },
  });
  if (!res.ok) throw new Error(`Polymarket credential creation failed (${res.status})`);
  const creds = (await res.json()) as ClobCredentials;
  if (!creds.apiKey || !creds.secret || !creds.passphrase) throw new Error("Polymarket returned incomplete credentials");
  credCache.set(wallet.address.toLowerCase(), { at: Date.now(), creds });
  return creds;
}

/** ═══ L2 request signing ═══ */

/** urlsafe base64 with padding, per Polymarket spec. */
function urlsafeB64WithPadding(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

/** Sign a CLOB request: HMAC-SHA256(base64decode(secret), ts + method + path + body). */
async function l2Signature(creds: ClobCredentials, method: string, path: string, body?: string): Promise<string> {
  const key = Buffer.from(creds.secret, "base64");
  const { createHmac } = await import("node:crypto");
  const message = Math.floor(Date.now() / 1000) + method.toUpperCase() + path + (body ?? "");
  return urlsafeB64WithPadding(createHmac("sha256", key).update(message).digest());
}

/** Authenticated CLOB fetch with the five POLY_ headers. */
async function clobFetch(
  creds: ClobCredentials,
  method: string,
  path: string,
  body?: unknown,
): Promise<any> {
  const bodyStr = body === undefined ? "" : JSON.stringify(body);
  const signature = await l2Signature(creds, method, path, bodyStr);
  const res = await fetch(`${CLOB}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      POLY_ADDRESS: creds.apiKey, // owner = api key for EOA trading
      POLY_SIGNATURE: signature,
      POLY_TIMESTAMP: String(Math.floor(Date.now() / 1000)),
      POLY_API_KEY: creds.apiKey,
      POLY_PASSPHRASE: creds.passphrase,
      ...(body !== undefined ? { "Content-Length": String(Buffer.byteLength(bodyStr)) } : {}),
    },
    body: bodyStr || undefined,
  });
  const text = await res.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    throw new Error(`Polymarket request failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return json;
}

/** ═══ Order book ═══ */

/** Public order book for a token id (no auth needed). */
export async function getClobOrderBook(tokenId: string): Promise<ClobOrderBook> {
  const res = await fetch(`${CLOB}/book?token_id=${encodeURIComponent(tokenId)}`);
  if (!res.ok) throw new Error(`Polymarket order book failed (${res.status})`);
  const data = (await res.json()) as any;
  return {
    bids: Array.isArray(data.bids) ? data.bids : [],
    asks: Array.isArray(data.asks) ? data.asks : [],
    minOrderSize: String(data.min_order_size ?? "5"),
    tickSize: String(data.tick_size ?? "0.01"),
    negRisk: Boolean(data.neg_risk),
  };
}

/** ═══ Order placement ═══ */

export interface PlaceOrderInput {
  tokenId: string;
  side: "BUY" | "SELL";
  /** USD price per share, e.g. "0.52" (must conform to tick size). */
  price: string;
  /** Number of shares, e.g. "10" (must meet min order size). */
  size: string;
  /** Optional GTD expiration (unix seconds); default GTC. */
  expiration?: number;
}

const ORDER_TYPES = {
  Order: [
    { name: "salt", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "signer", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "makerAmount", type: "uint256" },
    { name: "takerAmount", type: "uint256" },
    { name: "side", type: "uint8" },
    { name: "signatureType", type: "uint8" },
    { name: "timestamp", type: "uint256" },
    { name: "metadata", type: "bytes32" },
    { name: "builder", type: "bytes32" },
  ],
};

const ZERO32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

/** Decimal string → 6-decimal integer ("10" → 10000000n, "0.52" → 520000n). */
function toSixDecimals(v: string): bigint {
  const [ip, fp = ""] = v.split(".");
  const frac = fp.padEnd(6, "0").slice(0, 6);
  return BigInt(ip + frac);
}

/** Price → 6-decimal integer USD amount, rounded per Polymarket's rule. */
function toAmount6(price: string, size: string): bigint {
  // USD amount = price × size, 6 decimals
  const amount = (toSixDecimals(price) * toSixDecimals(size)) / 10n ** 6n;
  return amount;
}

/** Build + sign an order and submit it to the CLOB. Returns the CLOB response. */
export async function placeClobOrder(wallet: ethers.Wallet, input: PlaceOrderInput): Promise<any> {
  const creds = await getClobCredentials(wallet);
  await getClobOrderBook(input.tokenId); // validates market + reads constraints

  // BUY: maker = USD amount, taker = shares. SELL: reversed.
  const usdAmount = toAmount6(input.price, input.size);
  const shares6 = toSixDecimals(input.size);
  const makerAmount = input.side === "BUY" ? usdAmount : shares6;
  const takerAmount = input.side === "BUY" ? shares6 : usdAmount;

  const salt = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
  const timestamp = BigInt(Date.now());

  const value = {
    salt,
    maker: wallet.address,
    signer: wallet.address,
    tokenId: input.tokenId,
    makerAmount,
    takerAmount,
    side: input.side === "BUY" ? 0 : 1,
    signatureType: 0, // EOA
    timestamp,
    metadata: ZERO32,
    builder: ZERO32,
  };

  const signature = await wallet.signTypedData(CTF_DOMAIN, ORDER_TYPES, value);

  const expiration = input.expiration ? String(input.expiration) : "0";
  const orderBody = {
    deferExec: false,
    order: {
      builder: ZERO32,
      expiration,
      maker: wallet.address,
      makerAmount: makerAmount.toString(),
      metadata: ZERO32,
      salt: Number(salt),
      side: input.side,
      signature,
      signatureType: 0,
      signer: wallet.address,
      takerAmount: takerAmount.toString(),
      timestamp: timestamp.toString(),
      tokenId: input.tokenId,
    },
    orderType: input.expiration ? "GTD" : "GTC",
    owner: creds.apiKey,
  };

  return clobFetch(creds, "POST", "/order", orderBody);
}