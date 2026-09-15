import { afterEach, describe, expect, it, vi } from "vitest";
import { getChain } from "../src/chains/config.js";

afterEach(() => vi.unstubAllEnvs());
describe("private RPC configuration", () => {
  it("uses a configured Helius endpoint without mutating the registry", () => {
    vi.stubEnv("HELIUS_RPC_URL", "https://mainnet.helius-rpc.com/?api-key=test");
    expect(getChain("solana")?.rpcUrl).toContain("helius");
    vi.stubEnv("HELIUS_RPC_URL", "");
    expect(getChain("solana")?.rpcUrl).not.toContain("api-key");
  });
  it("supports Alchemy per EVM chain and an explicit override", () => {
    vi.stubEnv("ALCHEMY_BASE_RPC_URL", "https://base-mainnet.g.alchemy.com/v2/test");
    expect(getChain(8453)?.rpcUrl).toContain("alchemy");
    vi.stubEnv("BASE_RPC_URL", "https://rpc.example.com/");
    expect(getChain("base")?.rpcUrl).toBe("https://rpc.example.com/");
  });
  it("rejects an insecure remote endpoint without disclosing its credential", () => {
    vi.stubEnv("BASE_RPC_URL", "http://remote.example.com/private-key");
    expect(() => getChain("base")).toThrow("requires HTTPS");
    try { getChain("base"); } catch (e) { expect(String(e)).not.toContain("private-key"); }
  });
});
