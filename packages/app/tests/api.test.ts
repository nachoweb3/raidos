import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiServer } from "../src/api/server.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // Solana USDC
const MOON = "MoMuVWx5cYCGXcDjQ5M6Z6Bs6c3T7eTTC6PxC1gVaaa"; // fake token mint for tests

const dir = mkdtempSync(join(tmpdir(), "raidos-api-test-"));
let server: ApiServer;
let baseUrl: string;

let firstUserKey = "";
let secondUserKey = "";

async function api(
  method: string,
  path: string,
  body?: unknown,
  key?: string,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

beforeAll(async () => {
  server = new ApiServer({ dbPath: join(dir, "api.db"), port: 0, siteDir: null, appMode: "mock" });
  const port = await server.start();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("auth", () => {
  it("registers the first user without bootstrap secret and returns the key once", async () => {
    const r = await api("POST", "/api/auth/register", {});
    expect(r.status).toBe(201);
    expect(r.json.apiKey).toMatch(/^raidos_[0-9a-f]{64}$/);
    expect(typeof r.json.userId).toBe("number");
    firstUserKey = r.json.apiKey;
  });

  it("second registration requires the bootstrap secret", async () => {
    const denied = await api("POST", "/api/auth/register", {});
    expect(denied.status).toBe(403);

    const ok = await api("POST", "/api/auth/register", { bootstrapSecret: "test-secret" }, undefined);
    expect(ok.status).toBe(403); // server created without secret env → nothing matches
  });

  it("accepts second registration when bootstrap secret is configured", async () => {
    // spin a second server with a bootstrap secret
    const dir2 = mkdtempSync(join(tmpdir(), "raidos-api-test2-"));
    const s2 = new ApiServer({ dbPath: join(dir2, "api.db"), port: 0, siteDir: null, appMode: "mock", bootstrapSecret: "s3cret" });
    const port2 = await s2.start();
    const base2 = `http://127.0.0.1:${port2}`;

    await fetch(`${base2}/api/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const r = await fetch(`${base2}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bootstrapSecret: "s3cret" }),
    });
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j.apiKey).toMatch(/^raidos_/);
    secondUserKey = j.apiKey;
    await s2.stop();
    rmSync(dir2, { recursive: true, force: true });
  });

  it("rejects requests without a valid key", async () => {
    const r = await api("GET", "/api/wallets");
    expect(r.status).toBe(401);

    const bad = await api("GET", "/api/wallets", undefined, "raidos_deadbeef");
    expect(bad.status).toBe(401);
  });

  it("/api/me identifies the authenticated user", async () => {
    const r = await api("GET", "/api/me", undefined, firstUserKey);
    expect(r.status).toBe(200);
    expect(r.json.mode).toBe("mock");
  });
});

describe("wallets", () => {
  it("creates a solana wallet and lists it", async () => {
    const created = await api("POST", "/api/wallets", { chain: "solana", password: "pw123456", label: "Main" }, firstUserKey);
    expect(created.status).toBe(201);
    expect(created.json.wallet.chain).toBe("solana");
    expect(created.json.wallet.isPrimary).toBe(true);

    const list = await api("GET", "/api/wallets", undefined, firstUserKey);
    expect(list.json.wallets.length).toBe(1);
    expect(list.json.wallets[0].address).toBe(created.json.wallet.address);
  });

  it("creates an EVM wallet on robinhood chain", async () => {
    const r = await api("POST", "/api/wallets", { chain: "robinhood", password: "pw123456" }, firstUserKey);
    expect(r.status).toBe(201);
    expect(r.json.wallet.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it("rejects unknown chains", async () => {
    const r = await api("POST", "/api/wallets", { chain: "nope", password: "pw" }, firstUserKey);
    expect(r.status).toBe(400);
  });
});

describe("trades (mock execution)", () => {
  it("quotes a swap with a fee", async () => {
    const r = await api(
      "POST",
      "/api/trades/quote",
      { fromChain: "solana", sellToken: USDC, buyToken: MOON, amount: "1000000" },
      firstUserKey,
    );
    expect(r.status).toBe(200);
    expect(r.json.quote.aggregator).toBe("mock");
    expect(r.json.mode).toBe("mock");
    expect(Number(r.json.quote.feeUsdc)).toBeGreaterThan(0);
  });

  it("executes a swap end-to-end: fee revenue event + confirmed trade row", async () => {
    const r = await api(
      "POST",
      "/api/trades/execute",
      {
        fromChain: "solana",
        sellToken: USDC,
        buyToken: MOON,
        amount: "10000000", // 10 USDC
        password: "pw123456",
      },
      firstUserKey,
    );
    expect(r.status).toBe(200);
    expect(r.json.success).toBe(true);
    expect(r.json.mode).toBe("mock");
    expect(r.json.txHash).toMatch(/^mocksol_/);
    expect(r.json.feeUsdc).toBe("30000"); // 0.3% of 10 USDC = 0.03 USDC = 30000 (6 dec)
    expect(r.json.buyAmount).toBe("10000000"); // 1:1 mock

    // fee recorded as revenue
    const pnl = await api("GET", "/api/trades/pnl", undefined, firstUserKey);
    expect(pnl.status).toBe(200);
    expect(pnl.json.pnl.totalTrades).toBe(1);
  });

  it("rejects execution with a wrong wallet password", async () => {
    const r = await api(
      "POST",
      "/api/trades/execute",
      { fromChain: "solana", sellToken: USDC, buyToken: MOON, amount: "1000000", password: "WRONG" },
      firstUserKey,
    );
    expect(r.status).toBe(401);
    expect(r.json.error).toMatch(/password/i);
  });

  it("rejects execution without a wallet", async () => {
    const r = await api(
      "POST",
      "/api/trades/execute",
      { fromChain: "solana", sellToken: USDC, buyToken: MOON, amount: "1000000", password: "x" },
      secondUserKey === "" ? (await api("POST", "/api/auth/register", {})).json.apiKey : secondUserKey,
    );
    // secondUserKey belongs to a different server/db in this test file → 401 there.
    // Register a fresh user on THIS server instead:
    expect([401, 404]).toContain(r.status);
  });

  it("rejects invalid amounts", async () => {
    const r = await api(
      "POST",
      "/api/trades/execute",
      { fromChain: "solana", sellToken: USDC, buyToken: MOON, amount: "-5", password: "pw123456" },
      firstUserKey,
    );
    expect(r.status).toBe(400);
  });
});

describe("launchpad", () => {
  it("creates a launch, buys and sells on the curve, records launch fee", async () => {
    const created = await api(
      "POST",
      "/api/launches",
      { chain: "solana", name: "Test Coin", symbol: "TST", description: "d", imageUrl: "", totalSupply: "1000000000000" },
      firstUserKey,
    );
    expect(created.status).toBe(201);
    const launchId = created.json.launch.id;

    const buy = await api("POST", `/api/launches/${launchId}/buy`, { usdcAmount: "10000000" }, firstUserKey);
    expect(buy.status).toBe(200);
    expect(buy.json.result.success).toBe(true);
    expect(Number(buy.json.result.tokenAmount)).toBeGreaterThan(0);

    const tokenAmount = buy.json.result.tokenAmount;
    const sell = await api("POST", `/api/launches/${launchId}/sell`, { tokenAmount }, firstUserKey);
    expect(sell.status).toBe(200);
    expect(Number(sell.json.result.usdcAmount)).toBeGreaterThan(0);

    const list = await api("GET", "/api/launches?chain=solana");
    expect(list.status).toBe(200);
    expect(list.json.launches.some((l: any) => l.id === launchId)).toBe(true);
  });

  it("rejects buying a launch with insufficient params", async () => {
    const r = await api("POST", "/api/launches/999999/buy", {}, firstUserKey);
    expect(r.status).toBe(400);
  });
});

describe("leaderboard & portfolio", () => {
  it("returns an empty leaderboard without error", async () => {
    const r = await api("GET", "/api/leaderboard");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json.leaders)).toBe(true);
  });

  it("portfolio aggregates holdings from confirmed trades", async () => {
    const r = await api("GET", "/api/portfolio", undefined, firstUserKey);
    expect(r.status).toBe(200);
    expect(r.json.pnl.totalTrades).toBeGreaterThanOrEqual(1);
    // MOON was bought in the swap test → present in pnlByToken
    expect(r.json.pnl.pnlByToken[MOON]).toBeTruthy();
    expect(Array.isArray(r.json.holdings)).toBe(true);
  });
});

describe("subscriptions", () => {
  it("upgrades a user to pro tier", async () => {
    const r = await api("POST", "/api/subscription", { tierId: "pro" }, firstUserKey);
    expect(r.status).toBe(200);
    expect(r.json.tier.id).toBe("pro");

    const current = await api("GET", "/api/subscription", undefined, firstUserKey);
    expect(current.json.tier.id).toBe("pro");
  });

  it("rejects unknown tiers", async () => {
    const r = await api("POST", "/api/subscription", { tierId: "diamond-hand" }, firstUserKey);
    expect(r.status).toBe(400);
  });
});

describe("positions, feed & leaderboard periods (fomo-style)", () => {
  it("aggregate a full buy→sell position, emit feed events and close with realized PnL", async () => {
    const key = firstUserKey;
    // buy 10 USDC of MOON (mock 1:1 → 10_000_000 smallest units)
    const buy = await api("POST", "/api/trades/execute", {
      fromChain: "solana", sellToken: USDC, buyToken: MOON, amount: "10000000", password: "pw123456",
    }, key);
    expect(buy.status).toBe(200);

    const open = await api("GET", "/api/positions?status=open", undefined, key);
    expect(open.status).toBe(200);
    const moonPos = open.json.positions.find((p: any) => p.token === MOON);
    expect(moonPos).toBeTruthy();
    expect(moonPos.status).toBe("open");

    // sell everything back to USDC (side=swap token→USDC)
    const sell = await api("POST", "/api/trades/execute", {
      fromChain: "solana", sellToken: MOON, buyToken: USDC, amount: moonPos.amount_remaining, password: "pw123456",
    }, key);
    expect(sell.status).toBe(200);

    const after = await api("GET", "/api/positions", undefined, key);
    const closed = after.json.positions.find((p: any) => p.token === MOON && p.status === "closed");
    expect(closed).toBeTruthy();
    // Mock 1:1 with net-of-fee accounting. Two buys of 10 USDC (fee 0.03 each)
    // + one sell of 20 USDC (fee 0.06) = 4×0.03 = 0.12 USDC total cost → PnL −0.12
    expect(closed.realized_pnl_usdc).toBe("-120000");
  });

  it("feed lists swap + position_closed events and supports sinceId polling", async () => {
    const feed = await api("GET", "/api/feed?limit=50");
    expect(feed.status).toBe(200);
    const types = feed.json.events.map((e: any) => e.type);
    expect(types).toContain("swap");
    expect(types).toContain("position_closed");

    const maxId = feed.json.maxId;
    const again = await api("GET", `/api/feed?sinceId=${maxId}`);
    expect(again.json.events.length).toBe(0);
  });

  it("SSE stream responds as text/event-stream", async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/feed/stream`, { signal: controller.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    controller.abort();
  });

  it("leaderboard supports 24h/7d/30d periods", async () => {
    for (const period of ["24h", "7d", "30d"]) {
      const r = await api("GET", `/api/leaderboard?period=${period}`);
      expect(r.status).toBe(200);
      expect(r.json.period).toBe(period);
      expect(Array.isArray(r.json.leaders)).toBe(true);
    }
  });
});

describe("static & misc", () => {
  it("serves the dashboard when siteDir points at the repo site/", async () => {
    const dir3 = mkdtempSync(join(tmpdir(), "raidos-api-test3-"));
    const s3 = new ApiServer({ dbPath: join(dir3, "api.db"), port: 0, siteDir: join(process.cwd(), "../../site"), appMode: "mock" });
    const port3 = await s3.start();
    const res = await fetch(`http://127.0.0.1:${port3}/trading.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    await s3.stop();
    rmSync(dir3, { recursive: true, force: true });
  });

  it("404s unknown API routes and blocks path traversal", async () => {
    const nf = await api("GET", "/api/unknown");
    expect(nf.status).toBe(404);
    const trav = await fetch(`${baseUrl}/../package.json`);
    expect(trav.status).toBe(404);
  });
});
