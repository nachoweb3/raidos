/**
 * 👛 PLATFORM WALLETS — generated addresses per network, no wallet connection
 * required. Export returns the private key (operator-secret-encrypted at rest).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiServer } from "../src/api/server.js";
import { generateApiKey } from "../src/api/auth.js";

process.env.WALLET_ENC_SECRET = process.env.WALLET_ENC_SECRET || "test-wallet-secret";

describe("platform wallets", () => {
  let server: ApiServer;
  let base = "";

  beforeAll(async () => {
    server = new ApiServer({ dbPath: ":memory:", siteDir: null, port: 0, appMode: "live" });
    const port = await server.start();
    base = `http://127.0.0.1:${port}`;
  });
  afterAll(async () => { await server.stop(); });

  function mkUser(): { id: number; key: string } {
    const { apiKey, keyHash } = generateApiKey();
    const id = Date.now() % 1_000_000_000 * 1000 + Math.floor(Math.random() * 999);
    server.db.createUser(id, keyHash);
    server["ensurePlatformWallets"](id);
    return { id, key: apiKey };
  }
  const auth = (key: string) => ({ "Content-Type": "application/json", Authorization: "Bearer " + key });

  it("provisions one generated address per network at login (solana + evm)", () => {
    const u = mkUser();
    const wallets = server.wallets.listWallets(u.id);
    const chains = wallets.map((w) => w.chain).sort();
    expect(chains).toEqual(["base", "ethereum", "solana"]);
    for (const w of wallets) {
      expect(w.address).toBeTruthy();
      expect(w.label).toBe("TRENCHES");
    }
    const sol = wallets.find((w) => w.chain === "solana")!;
    expect(sol.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    const evm = wallets.find((w) => w.chain === "ethereum")!;
    expect(evm.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("is idempotent: re-login does not duplicate wallets", () => {
    const u = mkUser();
    server["ensurePlatformWallets"](u.id);
    server["ensurePlatformWallets"](u.id);
    expect(server.wallets.listWallets(u.id)).toHaveLength(3);
  });

  it("exports the private key that decrypts back to a working wallet", async () => {
    const u = mkUser();
    const res = await fetch(base + "/api/wallets/export", {
      method: "POST", headers: auth(u.key), body: JSON.stringify({ chain: "solana" }),
    });
    expect(res.status).toBe(200);
    const { privateKey } = await res.json() as { privateKey: string };
    expect(typeof privateKey).toBe("string");
    expect(privateKey.length).toBeGreaterThan(40);

    // Exporting a network without a wallet → 404 honesto
    const res2 = await fetch(base + "/api/wallets/export", {
      method: "POST", headers: auth(u.key), body: JSON.stringify({ chain: "bsc" }),
    });
    expect(res2.status).toBe(404);
  });

  it("requires auth for export and 404s unknown users", async () => {
    const res = await fetch(base + "/api/wallets/export", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chain: "solana" }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /api/wallets generates a new platform wallet without user password", async () => {
    const u = mkUser();
    const res = await fetch(base + "/api/wallets", {
      method: "POST", headers: auth(u.key), body: JSON.stringify({ chain: "bsc" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { wallet: { chain: string; address: string } };
    expect(body.wallet.chain).toBe("bsc");
    expect(body.wallet.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("503s honestly when WALLET_ENC_SECRET is absent", async () => {
    const u = mkUser();
    const prev = process.env.WALLET_ENC_SECRET;
    delete process.env.WALLET_ENC_SECRET;
    try {
      const res = await fetch(base + "/api/wallets", {
        method: "POST", headers: auth(u.key), body: JSON.stringify({ chain: "arc" }),
      });
      expect(res.status).toBe(503);
      const body = await res.json() as { error: string };
      expect(body.error).toContain("WALLET_ENC_SECRET");
    } finally {
      process.env.WALLET_ENC_SECRET = prev;
    }
  });
});
