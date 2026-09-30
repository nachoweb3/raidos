import { describe, expect, it } from "vitest";
import { AppDb } from "../src/database/app-db.js";
import { HeliusWalletActivityProvider, MockWalletActivityProvider } from "../src/market/wallet-activity.js";
import { ApiServer } from "../src/api/server.js";

const WALLET = "7XaBcDeFgHiJkLmNoPqRsTuVwXyZ123456789AbCdEf"; // valid base58 (no 0/O/I/l)
const TOKEN = "MoMuVWx5cYCGXcDjQ5M6Z6Bs6c3T7eTTC6PxC1gVaaa";

describe("wallet ingestion db", () => {
  it("upserts tracked wallets, orders the poll list by priority and edits in place", () => {
    const db = new AppDb(":memory:");
    db.upsertTrackedWallet({ chain: "solana", address: WALLET, label: "Nacho", category: "smart", priority: 2 });
    db.upsertTrackedWallet({ chain: "solana", address: "9xFake1111111111111111111111111111111111111", label: "Dev", category: "dev", priority: 1 });
    // Edit: same wallet, new priority (no duplicate row).
    db.upsertTrackedWallet({ chain: "solana", address: WALLET, label: "Nacho", category: "smart", priority: 3 });
    const wallets = db.listTrackedWallets({ chain: "solana" });
    expect(wallets).toHaveLength(2);
    expect(wallets.map((w: any) => w.priority)).toEqual([1, 3]);

    // Poll cursor: due ordering respects priority and staleness.
    const due = db.walletsDueForPoll(Date.now() / 1000, 300, 10);
    expect(due.map((w: any) => w.address)).toEqual(["9xFake1111111111111111111111111111111111111", WALLET]);
    db.touchWalletPolled("solana", "9xFake1111111111111111111111111111111111111", Date.now() / 1000);
    const dueAfter = db.walletsDueForPoll(Date.now() / 1000, 300, 10);
    expect(dueAfter.map((w: any) => w.address)).toEqual([WALLET]);
    expect(db.removeTrackedWallet("solana", WALLET)).toBe(true);
    expect(db.removeTrackedWallet("solana", WALLET)).toBe(false);
    db.close();
  });

  it("dedupes swaps by signature inside one tx and keeps the token index queryable", () => {
    const db = new AppDb(":memory:");
    const row = (sig: string, over: Partial<Record<string, unknown>> = {}) => ({
      signature: sig, chain: "solana", token: TOKEN, wallet: WALLET, side: "buy" as const,
      amountToken: "1000", amountUsd: 120.5, priceUsd: 0.00012, ts: 1727700000, ...over,
    });
    expect(db.insertOnchainSwaps([row("sig-1"), row("sig-1"), row("sig-2", { side: "sell", ts: 1727700005 })])).toBe(2);
    // Cross-chain same token address is a different market: both kept.
    db.insertOnchainSwaps([row("sig-3", { chain: "base" })]);
    expect(db.listOnchainSwapsByToken("solana", TOKEN)).toHaveLength(2);
    expect(db.listOnchainSwapsByToken("solana", TOKEN)[0]).toMatchObject({ side: "sell", walletCategory: null }); // newest first (sig-2 has the later ts)
    expect(db.listOnchainSwapsByToken("base", TOKEN)).toHaveLength(1);
    // since cursor filters.
    expect(db.listOnchainSwapsByToken("solana", TOKEN, { since: 1727700006 })).toHaveLength(0);
    db.close();
  });
});

describe("helius wallet activity provider", () => {
  it("translates SWAP token transfers into buy/sell observations and skips noise", async () => {
    const heliusTx = [
      { signature: "sigA", timestamp: 1727700100, type: "SWAP", token_transfers: [
        { mint: TOKEN, to_user_account: WALLET, token_amount: 500 }, // buy leg
        { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", from_user_account: WALLET, token_amount: 10 },
      ] },
      { signature: "sigB", timestamp: 1727700200, type: "SWAP", token_transfers: [
        { mint: TOKEN, from_user_account: WALLET, token_amount: 250 }, // sell leg
        { mint: "So11111111111111111111111111111111111111112", to_user_account: WALLET, token_amount: 1.5 },
      ] },
      { signature: "sigC", timestamp: 1727700300, type: "SWAP", token_transfers: [
        { mint: TOKEN, to_user_account: WALLET, token_amount: 10 },
        { mint: "OtherMint1111111111111111111111111111111111", from_user_account: WALLET, token_amount: 5 }, // two non-quote legs → ambiguous
      ] },
      { signature: "sigD", timestamp: 1727700400, type: "TRANSFER", token_transfers: [
        { mint: TOKEN, to_user_account: WALLET, token_amount: 10 }, // non-swap → not counted
      ] },
    ];
    const provider = new HeliusWalletActivityProvider("test-key", async () => new Response(JSON.stringify(heliusTx), { status: 200 }));
    const result = await provider.getWalletActivity("solana", WALLET, 10);
    expect(result.source).toBe("helius");
    expect(result.swaps).toHaveLength(2);
    expect(result.swaps[0]).toMatchObject({ signature: "sigA", token: TOKEN, wallet: WALLET, side: "buy" });
    expect(result.swaps[1]).toMatchObject({ signature: "sigB", side: "sell" });
    expect(provider.supportsChain("base")).toBe(false);
  });

  it("propagates upstream failures (never fabricates swaps)", async () => {
    const provider = new HeliusWalletActivityProvider("test-key", async () => new Response("nope", { status: 500 }));
    await expect(provider.getWalletActivity("solana", WALLET)).rejects.toThrow("500");
  });
});

describe("wallet ingestion API + poll loop", () => {
  it("admins manage tracked wallets and the public gated endpoint serves observed swaps", async () => {
    const fixture = [
      { signature: "fx-1", token: TOKEN, wallet: WALLET, side: "buy" as const, amountToken: "777", amountUsd: 90, priceUsd: 0.001, ts: Math.floor(Date.now() / 1000) - 60, source: "mock" },
    ];
    const server = new ApiServer({ dbPath: ":memory:", siteDir: null, port: 0, appMode: "mock", walletActivity: new MockWalletActivityProvider(fixture) });
    const port = await server.start();
    const base = `http://127.0.0.1:${port}`;
    try {
      process.env.ADMIN_SECRET = "ingest-admin-secret";
      const admin = { "content-type": "application/json", "x-admin-secret": "ingest-admin-secret" };

      // Auth guards: wrong/missing secret is 403 (requireAdminSecret semantics), valid one is 201.
      const denied = await fetch(base + "/api/admin/wallets", { method: "POST", body: JSON.stringify({ chain: "solana", address: WALLET }) });
      expect(denied.status).toBe(403);
      const created = await fetch(base + "/api/admin/wallets", {
        method: "POST", headers: admin,
        body: JSON.stringify({ chain: "solana", address: WALLET, label: "Nacho", category: "smart", priority: 1 }),
      });
      expect(created.status).toBe(201);
      const listed = await (await fetch(base + "/api/admin/wallets", { headers: admin })).json() as any;
      expect(listed.ingestionEnabled).toBe(true);
      expect(listed.wallets[0]).toMatchObject({ address: WALLET, category: "smart" });

      // Public gated read: 503 without TG source, 401 without pass, 200 after redeeming a real code.
      const noSource = await fetch(base + `/api/tokens/solana/${TOKEN}/onchain-activity`);
      expect(noSource.status).toBe(503);
      const src = server.telegramSource as unknown as { token: string; chatId: string };
      src.token = "test-token"; // enable the TG source (same trick as tg-signals tests)
      src.chatId = "-100";
      const noPass = await fetch(base + `/api/tokens/solana/${TOKEN}/onchain-activity`);
      expect(noPass.status).toBe(401);
      const mintRes = await fetch(base + "/api/admin/tg/mint-code", { method: "POST", headers: admin, body: JSON.stringify({ telegramUserId: "ingest" }) });
      const { code } = (await mintRes.json()) as any;
      const redeem = await fetch(base + "/api/tg/redeem", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
      const cookie = redeem.headers.get("set-cookie") ?? "";
      // First poll pass fires 2s after start(); retry the gated read until the mock swap lands.
      let activity: any = null;
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 500));
        activity = await (await fetch(base + `/api/tokens/solana/${TOKEN}/onchain-activity`, { headers: { cookie } })).json() as any;
        if (activity.swaps?.length > 0) break;
      }
      expect(activity.status).toBe("LIVE");
      expect(activity.swaps).toHaveLength(1);
      expect(activity.swaps[0]).toMatchObject({ token: TOKEN, wallet: WALLET, side: "buy", source: "mock" });

      // Delete.
      const removed = await fetch(base + `/api/admin/wallets/solana/${WALLET}`, { method: "DELETE", headers: admin });
      expect(removed.status).toBe(200);
      delete process.env.ADMIN_SECRET;
    } finally {
      await server.stop();
    }
  });
});
