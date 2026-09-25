import { describe, expect, it } from "vitest";
import { FRACTIONAL_ASSETS, fractionalDnaFields, hasVerifiedVault, verifiedFractional } from "../src/pairs/pair-fractional.js";
import { buildDNA } from "../src/pairs/pair-engine.js";
import { TeleportEngine } from "../src/pairs/teleport.js";
import type { PairAsset } from "../src/pairs/pair-engine.js";

const MAD_LAD: PairAsset = { kind: "token", id: "wrapped-sol", chain: "solana", symbol: "SOL", name: "Solana" };
const FAKE_FRAC: PairAsset = {
  kind: "fractional_nft", id: "mad-fractional", chain: "solana", symbol: "fMAD", name: "Mad Lads (fractional)",
  underlyingCollection: "mad_lads",
};

describe("Fractionalization (honest, registry empty)", () => {
  it("registry is empty — the truthful 2026-09 state after the protocol probe", () => {
    expect(FRACTIONAL_ASSETS).toHaveLength(0);
    expect(hasVerifiedVault(FAKE_FRAC)).toBe(false);
    expect(verifiedFractional("mad-fractional")).toBeNull();
  });

  it("fractional DNA fields: null vault, none protocol, named restriction", () => {
    const fields = fractionalDnaFields(FAKE_FRAC);
    expect(fields.vault).toBeNull();
    expect(fields.fractionalization).toBe("none");
    expect(fields.restrictions[0]).toContain("sin protocolo verificado en vivo");
  });

  it("non-fractional legs keep DNA clean (vault null, fractionalization none)", () => {
    const fields = fractionalDnaFields(MAD_LAD);
    expect(fields).toEqual({ vault: null, fractionalization: "none", restrictions: [] });
    const dna = buildDNA(MAD_LAD, FAKE_FRAC, { pairMode: "synthetic", oracle: "coingecko:synthetic" });
    expect(dna.vault).toBeNull();
    expect(dna.fractionalization).toBe("none");
  });

  it("Teleport refuses fractional legs with a named reason (no crash, no fake route)", async () => {
    const engine = new TeleportEngine();
    const asBase = await engine.findRoute(FAKE_FRAC, MAD_LAD, "1");
    expect(asBase.status).toBe("NO_ROUTE");
    expect(asBase.reason).toContain("fractionalization sin protocolo verificado");

    const asQuote = await engine.findRoute(MAD_LAD, FAKE_FRAC, "1000000000");
    expect(asQuote.status).toBe("NO_ROUTE");
    expect(asQuote.reason).toContain("fractionalization sin protocolo verificado");
  });
});
