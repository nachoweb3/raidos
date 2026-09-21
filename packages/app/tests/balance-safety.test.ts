import { afterEach, describe, expect, it, vi } from "vitest";
import { BalanceScanner } from "../src/wallets/balances.js";
afterEach(() => vi.unstubAllGlobals());

describe("read-only balance failures", () => {
  it("returns unknown balances, not zero, when an RPC fails", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("secret RPC URL must not escape"); });
    const [wallet] = await new BalanceScanner().scanWallets([{ chain: "solana", address: "wallet", label: "test" }]);
    expect(wallet.nativeAmount).toBeNull();
    expect(wallet.usdcAmount).toBeNull();
    expect(wallet.error).not.toContain("secret");
  });
  it("rejects malformed RPC data instead of returning a successful empty wallet", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ result: {} })));
    const [wallet] = await new BalanceScanner().scanWallets([{ chain: "solana", address: "wallet", label: "test" }]);
    expect(wallet.error).toBeTruthy();
    expect(wallet.usdcAmount).toBeNull();
  });
});
