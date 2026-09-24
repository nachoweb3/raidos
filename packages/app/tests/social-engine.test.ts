import { afterEach, describe, expect, it, vi } from "vitest";
import { SocialEngine } from "../src/social/engine.js";
import { ApiServer } from "../src/api/server.js";
import { generateApiKey } from "../src/api/auth.js";

// ── Fakes ──
function fakeMarketDataService(tradesByPool: Record<string, any[]>) {
  return { trades: async (chain: string, pool: string) => ({ data: tradesByPool[`${chain}:${pool}`] ?? [], status: "LIVE", source: "test", asOf: Date.now() }) } as any;
}
function fakeCatalog() {
  return {
    trackedAssets: () => [
      { id: 1, chain: "solana", address: "TokenAAA111111111111111111111111111111111", symbol: "AAA", pool: "PoolA1111111111111111111111111111111111111" },
      { id: 2, chain: "base", address: "0x" + "b".repeat(40), symbol: "BBB", pool: "0x" + "c".repeat(40) },
    ],
    findAsset: () => undefined,
    bestPool: () => undefined,
  } as any;
}

const NOW = Math.floor(Date.now() / 1000);
const WALLET_A = "WALLETAAAA111111111111111111111111111111111"; // base58-safe (no 0OIl)
const TRADE_A = {
  id: "sol:gt-1", chain: "solana", pool: "PoolA1111111111111111111111111111111111111",
  token: "TokenAAA111111111111111111111111111111111", tokenSymbol: "AAA",
  wallet: WALLET_A, side: "buy" as const, priceUsd: 0.001, volumeUsd: 5000,
  amount: "5000000", time: NOW - 60, txHash: "txhashAAA1111111111111111111111111111111111",
};

describe("social engine pass", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("harvests trades from tracked pools and stores them idempotently", async () => {
    const server = new ApiServer({ dbPath: ":memory:", siteDir: null, port: 0, appMode: "live" });
    const market = fakeMarketDataService({ "solana:PoolA1111111111111111111111111111111111111": [TRADE_A, TRADE_A] }); // duplicate id
    const engine = new SocialEngine(server.db, fakeCatalog(), market);
    const result = await engine.runPass();
    expect(result.harvested).toBe(1); // duplicate deduped by PK
    const rows = server.db.getObservedTrades("solana", WALLET_A);
    expect(rows).toHaveLength(1);
    expect(rows[0].side).toBe("buy");
    await server.stop();
  });

  it("fans out a signal to an enabled subscriber respecting caps and sells policy", async () => {
    const server = new ApiServer({ dbPath: ":memory:", siteDir: null, port: 0, appMode: "live" });
    server.db.createCopySubscription(1, "solana", WALLET_A, "10000000", true); // 10 USDC cap
    const sellTrade = { ...TRADE_A, id: "sol:gt-2", side: "sell" as const, time: NOW - 30 };
    const market = fakeMarketDataService({ "solana:PoolA1111111111111111111111111111111111111": [sellTrade] });
    const engine = new SocialEngine(server.db, fakeCatalog(), market);
    const result = await engine.runPass();
    expect(result.signalsFanned).toBe(1);
    const signals = server.db.listCopySignals(1);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ source: "wallet", side: "sell", token: TRADE_A.token, user_id: 1 });
    await server.stop();
  });

  it("does NOT fan out sells when the subscription disables mirror_sells", async () => {
    const server = new ApiServer({ dbPath: ":memory:", siteDir: null, port: 0, appMode: "live" });
    server.db.createCopySubscription(1, "solana", WALLET_A, "10000000", false);
    const sellTrade = { ...TRADE_A, id: "sol:gt-3", side: "sell" as const, time: NOW - 30 };
    const market = fakeMarketDataService({ "solana:PoolA1111111111111111111111111111111111111": [sellTrade] });
    const engine = new SocialEngine(server.db, fakeCatalog(), market);
    const result = await engine.runPass();
    expect(result.signalsFanned).toBe(0);
    expect(server.db.listCopySignals(1)).toHaveLength(0);
    await server.stop();
  });

  it("rates a harvested wallet from self-observed trades only", async () => {
    const server = new ApiServer({ dbPath: ":memory:", siteDir: null, port: 0, appMode: "live" });
    // One profitable round-trip + buys only is not enough for a score, so build 12.
    const trades: any[] = [];
    for (let i = 0; i < 12; i++) {
      trades.push({ ...TRADE_A, id: `sol:gt-b${i}`, side: "buy", time: NOW - 400_000 + i * 21_600, volumeUsd: 1000, amount: "1000000" });
      trades.push({ ...TRADE_A, id: `sol:gt-s${i}`, side: "sell", time: NOW - 400_000 + i * 21_600 + 21_600, volumeUsd: 1500, amount: "1000000" });
    }
    const market = fakeMarketDataService({ "solana:PoolA1111111111111111111111111111111111111": trades });
    const engine = new SocialEngine(server.db, fakeCatalog(), market);
    await engine.runPass();
    const rating = engine.rateWallet("solana", WALLET_A);
    expect(rating).not.toBeNull();
    expect(rating!.metrics.trades).toBe(24);
    expect(rating!.metrics.realizedPnlUsd).toBeGreaterThan(0);
    await server.stop();
  });

  it("never creates CT calls without TWITTERAPI_IO_KEY (honest degradation)", async () => {
    const server = new ApiServer({ dbPath: ":memory:", siteDir: null, port: 0, appMode: "live" });
    vi.stubEnv("TWITTERAPI_IO_KEY", "");
    const engine = new SocialEngine(server.db, fakeCatalog(), fakeMarketDataService({}));
    const result = await engine.runPass();
    expect(result.ctCallsNew).toBe(0);
    expect(server.db.listCtCalls()).toHaveLength(0);
    await server.stop();
  });
});

describe("copy trading API", () => {
  it("rejects subscription with malformed wallet", async () => {
    const server = new ApiServer({ dbPath: ":memory:", siteDir: null, port: 0, appMode: "live" });
    const port = await server.start();
    const base = `http://127.0.0.1:${port}`;
    const reg = await (await fetch(base + "/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json() as { apiKey: string };
    const res = await fetch(base + "/api/copy/subscriptions", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + reg.apiKey },
      body: JSON.stringify({ chain: "solana", wallet: "not-a-wallet" }),
    });
    expect(res.status).toBe(400);
    await server.stop();
  });

  it("creates, lists and deletes a subscription", async () => {
    const server = new ApiServer({ dbPath: ":memory:", siteDir: null, port: 0, appMode: "live" });
    const port = await server.start();
    const base = `http://127.0.0.1:${port}`;
    const reg = await (await fetch(base + "/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json() as { apiKey: string };
    const auth = { "Content-Type": "application/json", Authorization: "Bearer " + reg.apiKey };
    const create = await (await fetch(base + "/api/copy/subscriptions", { method: "POST", headers: auth, body: JSON.stringify({ chain: "solana", wallet: WALLET_A, maxPerTradeUsdc: "5000000" }) })).json();
    expect(create.subscription).toMatchObject({ chain: "solana", wallet: WALLET_A, max_per_trade_usdc: "5000000" });
    const list = await (await fetch(base + "/api/copy/subscriptions", { headers: auth })).json();
    expect(list.subscriptions).toHaveLength(1);
    const id = list.subscriptions[0].id;
    const del = await fetch(base + `/api/copy/subscriptions/${id}`, { method: "DELETE", headers: auth });
    expect(del.status).toBe(200);
    const list2 = await (await fetch(base + "/api/copy/subscriptions", { headers: auth })).json();
    expect(list2.subscriptions).toHaveLength(0);
    await server.stop();
  });

  it("leaderboard is public and exposes the formula", async () => {
    const server = new ApiServer({ dbPath: ":memory:", siteDir: null, port: 0, appMode: "live" });
    const port = await server.start();
    const res = await fetch(`http://127.0.0.1:${port}/api/copy/leaderboard`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.formula).toBe("wallet-rating-v1");
    expect(Array.isArray(body.wallets)).toBe(true);
    await server.stop();
  });

  it("signals endpoint requires auth", async () => {
    const server = new ApiServer({ dbPath: ":memory:", siteDir: null, port: 0, appMode: "live" });
    const port = await server.start();
    const res = await fetch(`http://127.0.0.1:${port}/api/copy/signals`);
    expect(res.status).toBe(401);
    await server.stop();
  });
});

describe("copy signal lifecycle", () => {
  interface Server { port: number; apiKey: string; stop(): Promise<void>; createUser2(userId: number, keyHash: string): void; }
  async function startWithSignal(): Promise<Server> {
    const server = new ApiServer({ dbPath: ":memory:", siteDir: null, port: 0, appMode: "live" });
    const port = await server.start();
    // Create the user directly in the DB — the signal must belong to the user
    // that the API key maps to, and HTTP register isn't needed for that.
    const { apiKey, keyHash } = generateApiKey();
    const userId = Math.floor(Date.now() / 1000) * 1000 + Math.floor(Math.random() * 1000);
    server.db.createUser(userId, keyHash);
    server.db.createCopySubscription(userId, "solana", WALLET_A, "10000000", true);
    server.db.insertCopySignals([{
      subscription_id: 1, user_id: userId, source: "wallet", chain: "solana",
      wallet: WALLET_A, handle: "", token: TRADE_A.token, token_symbol: "AAA",
      side: "buy", ref_price_usd: 0.001, max_per_trade_usdc: "10000000", ts: NOW - 10,
    }]);
    return { port, apiKey, stop: () => server.stop(), createUser2: (userId: number, keyHash: string) => server.db.createUser(userId, keyHash) };
  }
  const authHeaders = (apiKey: string) => ({ "Content-Type": "application/json", Authorization: "Bearer " + apiKey });

  it("queue defaults to pending; done leaves the queue and shows in history", async () => {
    const s = await startWithSignal();
    try {
      const base = `http://127.0.0.1:${s.port}`;
      const list0 = await (await fetch(base + "/api/copy/signals", { headers: authHeaders(s.apiKey) })).json() as any;
      expect(list0.signals).toHaveLength(1);
      expect(list0.signals[0]).toMatchObject({ status: "pending", resolvedAt: null });

      const patch = await fetch(base + `/api/copy/signals/${list0.signals[0].id}`, {
        method: "PATCH", headers: authHeaders(s.apiKey), body: JSON.stringify({ status: "done" }),
      });
      expect(patch.status).toBe(200);

      const list1 = await (await fetch(base + "/api/copy/signals", { headers: authHeaders(s.apiKey) })).json() as any;
      expect(list1.signals).toHaveLength(0); // actionable queue is empty
      const all = await (await fetch(base + "/api/copy/signals?status=all", { headers: authHeaders(s.apiKey) })).json() as any;
      expect(all.signals).toHaveLength(1);
      expect(all.signals[0].status).toBe("done");
      expect(all.signals[0].resolvedAt).toBeGreaterThan(0);
      const done = await (await fetch(base + "/api/copy/signals?status=done", { headers: authHeaders(s.apiKey) })).json() as any;
      expect(done.signals).toHaveLength(1);
      const dismissed = await (await fetch(base + "/api/copy/signals?status=dismissed", { headers: authHeaders(s.apiKey) })).json() as any;
      expect(dismissed.signals).toHaveLength(0);
    } finally { await s.stop(); }
  });

  it("terminal states never flip: replay or re-decide returns 409", async () => {
    const s = await startWithSignal();
    try {
      const base = `http://127.0.0.1:${s.port}`;
      const id = (await (await fetch(base + "/api/copy/signals", { headers: authHeaders(s.apiKey) })).json() as any).signals[0].id;
      await fetch(base + `/api/copy/signals/${id}`, { method: "PATCH", headers: authHeaders(s.apiKey), body: JSON.stringify({ status: "dismissed" }) });
      for (const status of ["dismissed", "done"]) {
        const res = await fetch(base + `/api/copy/signals/${id}`, { method: "PATCH", headers: authHeaders(s.apiKey), body: JSON.stringify({ status }) });
        expect(res.status).toBe(409);
      }
    } finally { await s.stop(); }
  });

  it("rejects invalid status (400), invalid id (400) and foreign signals (409)", async () => {
    const s = await startWithSignal();
    try {
      const base = `http://127.0.0.1:${s.port}`;
      const bad = await fetch(base + "/api/copy/signals/1", { method: "PATCH", headers: authHeaders(s.apiKey), body: JSON.stringify({ status: "pending" }) });
      expect(bad.status).toBe(400); // pending is not a resolution
      const badId = await fetch(base + "/api/copy/signals/0", { method: "PATCH", headers: authHeaders(s.apiKey), body: JSON.stringify({ status: "done" }) });
      expect(badId.status).toBe(400);
      // Another user's signal (this fresh user owns nothing): 409, never 500/leak.
      const foreign = await fetch(base + "/api/copy/signals/999", { method: "PATCH", headers: authHeaders(s.apiKey), body: JSON.stringify({ status: "done" }) });
      expect(foreign.status).toBe(409);
    } finally { await s.stop(); }
  });

  it("signals scoped to their owner: user 2 cannot see or resolve user 1's signal", async () => {
    const s = await startWithSignal();
    try {
      const base = `http://127.0.0.1:${s.port}`;
      const list = await (await fetch(base + "/api/copy/signals?status=all", { headers: authHeaders(s.apiKey) })).json() as any;
      expect(list.signals).toHaveLength(1);
      const id = list.signals[0].id;
      // User 2 created directly in DB (HTTP register can rate-limit / share ids).
      const { apiKey: apiKey2, keyHash: keyHash2 } = generateApiKey();
      const userId2 = Math.floor(Date.now() / 1000) * 1000 + Math.floor(Math.random() * 1000);
      s.createUser2(userId2, keyHash2);
      const other = await (await fetch(base + "/api/copy/signals", { headers: authHeaders(apiKey2) })).json() as any;
      expect(other.signals).toHaveLength(0);
      const res = await fetch(base + `/api/copy/signals/${id}`, { method: "PATCH", headers: authHeaders(apiKey2), body: JSON.stringify({ status: "done" }) });
      expect(res.status).toBe(409);
      // The real owner can still resolve it — nothing was touched.
      const owner = await fetch(base + `/api/copy/signals/${id}`, { method: "PATCH", headers: authHeaders(s.apiKey), body: JSON.stringify({ status: "done" }) });
      expect(owner.status).toBe(200);
    } finally { await s.stop(); }
  });
});
