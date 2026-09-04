import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encrypt, decrypt, verifyPassword } from "../src/wallets/crypto.js";
import { CHAINS, CHAIN_IDS, EVM_CHAINS, getChain } from "../src/chains/config.js";
import { AppDb } from "../src/database/app-db.js";
import { PREMIUM_TIERS } from "../src/trading/revenue.js";

function newEnv() {
  const dir = mkdtempSync(join(tmpdir(), "raidos-app-"));
  const db = new AppDb(join(dir, "app.db"));
  const cleanup = () => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { db, cleanup };
}

describe("wallet crypto", () => {
  it("encrypts and decrypts a private key", () => {
    const key = "5Kd3N9rFhQ8Zj3K9wE2vLmN4pR7tY6uI1oA8sD5fG3hJ0kL2zX";
    const password = "secretpassword123";

    const encrypted = encrypt(key, password);
    expect(encrypted.version).toBe(1);
    expect(encrypted.data).not.toBe(key);

    const decrypted = decrypt(encrypted, password);
    expect(decrypted).toBe(key);
  });

  it("rejects wrong password", () => {
    const encrypted = encrypt("secret-key", "right-password");
    expect(verifyPassword(encrypted, "wrong-password")).toBe(false);
    expect(verifyPassword(encrypted, "right-password")).toBe(true);
  });

  it("produces different ciphertexts for the same plaintext (random salt+iv)", () => {
    const e1 = encrypt("same-key", "password");
    const e2 = encrypt("same-key", "password");
    expect(e1.data).not.toBe(e2.data);
    expect(e1.salt).not.toBe(e2.salt);
  });
});

describe("chain configs", () => {
  it("has all 7 chains configured", () => {
    expect(CHAIN_IDS.length).toBe(7);
    expect(CHAIN_IDS).toContain("solana");
    expect(CHAIN_IDS).toContain("ethereum");
    expect(CHAIN_IDS).toContain("base");
    expect(CHAIN_IDS).toContain("bsc");
    expect(CHAIN_IDS).toContain("arbitrum");
    expect(CHAIN_IDS).toContain("polygon");
    expect(CHAIN_IDS).toContain("robinhood");
  });

  it("all EVM chains have valid configs", () => {
    for (const id of EVM_CHAINS) {
      const chain = CHAINS[id];
      expect(chain.evm).toBe(true);
      expect(chain.chainId).toBeGreaterThan(0);
      expect(chain.usdcAddress).toMatch(/^0x/);
      expect(chain.rpcUrl).toContain("http");
    }
  });

  it("solana is not EVM", () => {
    expect(CHAINS.solana.evm).toBe(false);
    expect(CHAINS.solana.chainId).toBe(0);
  });

  it("robinhood chain is configured", () => {
    const rh = getChain("robinhood")!;
    expect(rh.chainId).toBe(4663);
    expect(rh.rpcUrl).toBe("https://rpc.mainnet.chain.robinhood.com");
    expect(rh.supportsLaunches).toBe(true);
    expect(rh.nativeCurrency).toBe("ETH");
  });

  it("getChain resolves by id and name", () => {
    expect(getChain("solana")?.name).toBe("Solana");
    expect(getChain(1)?.name).toBe("Ethereum");
    expect(getChain(4663)?.name).toBe("Robinhood Chain");
    expect(getChain("unknown")).toBeUndefined();
  });

  it("all chains have USDC addresses", () => {
    for (const id of CHAIN_IDS) {
      const chain = CHAINS[id];
      expect(chain.usdcAddress).toBeTruthy();
      expect(chain.usdcDecimals).toBeGreaterThan(0);
    }
  });
});

describe("database", () => {
  it("creates wallets and retrieves them", () => {
    const { db, cleanup } = newEnv();
    const walletId = db.createWallet(1, "solana", "ABC123", { data: "encrypted", salt: "", iv: "", tag: "", version: 1 }, "Primary", 1);
    expect(walletId).toBeGreaterThan(0);

    const wallets = db.getUserWallets(1);
    expect(wallets.length).toBe(1);
    expect(wallets[0].address).toBe("ABC123");

    cleanup();
  });

  it("creates launches and retrieves them", () => {
    const { db, cleanup } = newEnv();
    const id = db.createLaunch({
      creator_id: 1, chain: "solana", name: "Test Token", symbol: "TEST",
      description: "A test token", image_url: "", token_address: null,
      bonding_curve_address: null, total_supply: "1000000000000",
      current_price_usdc: "1000", market_cap_usdc: "1000000",
      raised_usdc: "0", graduate_threshold: "85000000000",
      fee_paid: "10000000", status: "created", buyers_count: 0,
      created_at: Math.floor(Date.now() / 1000), graduated_at: null,
    });
    expect(id).toBeGreaterThan(0);

    const launch = db.getLaunch(id);
    expect(launch.symbol).toBe("TEST");

    cleanup();
  });

  it("profiles and follows work correctly", () => {
    const { db, cleanup } = newEnv();
    db.updateProfile(1, { xHandle: "@alice", displayName: "Alice", bio: "trader" });
    db.updateProfile(2, { xHandle: "@bob", displayName: "Bob", bio: "degen" });

    const p1 = db.getProfile(1);
    expect(p1.x_handle).toBe("@alice");

    db.follow(2, 1); // Bob follows Alice
    expect(db.isFollowing(2, 1)).toBe(true);

    const p1after = db.getProfile(1);
    expect(p1after.followers_count).toBe(1);

    cleanup();
  });

  it("revenue events are recorded and retrievable", () => {
    const { db, cleanup } = newEnv();
    const now = Math.floor(Date.now() / 1000);
    db.addRevenueEvent({ stream: "trading_fee", userId: 1, amountUsdc: "3000", refType: "swap", refId: 1, meta: "{}", ts: now });

    const total = db.getTotalRevenue(now - 10);
    expect(Number(total)).toBe(3000);

    cleanup();
  });
});

describe("premium tiers", () => {
  it("has 4 tiers with increasing prices", () => {
    expect(PREMIUM_TIERS.length).toBe(4);
    const prices = PREMIUM_TIERS.map((t) => Number(t.priceUsdc));
    for (let i = 1; i < prices.length; i++) {
      expect(prices[i]).toBeGreaterThan(prices[i - 1]);
    }
  });

  it("free tier has zero price", () => {
    expect(PREMIUM_TIERS[0].priceUsdc).toBe("0");
    expect(PREMIUM_TIERS[0].id).toBe("free");
  });

  it("alpha tier includes API access", () => {
    const alpha = PREMIUM_TIERS.find((t) => t.id === "alpha")!;
    expect(alpha.features.some((f) => f.includes("API"))).toBe(true);
  });
});
