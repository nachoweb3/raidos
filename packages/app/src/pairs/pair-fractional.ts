/**
 * UNIVERSAL PAIRS — fractionalization registry (HONEST, currently empty).
 *
 * Probe of 2026-09-25: no live NFT fractionalization protocol exists on Solana
 * with a public API. The historical options are gone (Solvent discontinued;
 * Droplets freeze/mint closed) and the rest are custom builds without public
 * vaults. Per the project's honesty rule NO fractional asset is registered:
 * an empty registry is the truthful state — never a synthetic stand-in.
 *
 * Wiring for the day a protocol verifies (all four steps required):
 *   1. Verify the program on-chain (IDL + vault accounts derivable).
 *   2. Confirm a public data endpoint (keyless or keyed) for vault state:
 *      underlying mint, total shares, per-vault backing, buyout state.
 *   3. Register the asset here:
 *        { kind: "fractional_nft", id, chain: "solana", symbol, name,
 *          underlyingCollection: "<ME symbol>", protocol: "<id>",
 *          vault: "<vault address>", sharesMint: "<mint>",
 *          oracle: "protocol:<id>" }
 *      and add the vault reader to this file.
 *   4. Only then does the DNA carry `vault` + `fractionalization` non-null and
 *      Teleport upgrade the leg from NO_ROUTE to the protocol's real capability.
 */
import type { PairAsset } from "./pair-engine.js";

/** Extra fields a fractional asset must carry (vault identity is mandatory). */
export interface FractionalAsset extends PairAsset {
  kind: "fractional_nft";
  /** Magic Eden collection symbol whose floor the fractions represent. */
  underlyingCollection: string;
  /** Verified live protocol id (e.g. "solvent", "custom:<name>"). */
  protocol: string;
  /** On-chain vault address backing the shares (verified, not inferred). */
  vault: string;
  /** Fungible shares mint. */
  sharesMint: string;
}

/** Registry of VERIFIED fractional assets. Empty = the honest 2026-09 state. */
export const FRACTIONAL_ASSETS: FractionalAsset[] = [];

/** True when a fractional asset has a verified, addressable vault behind it. */
export function hasVerifiedVault(asset: PairAsset): boolean {
  return asset.kind === "fractional_nft" && FRACTIONAL_ASSETS.some((f) => f.id === asset.id);
}

/** The verified fractional asset for a pair-asset id, or null. */
export function verifiedFractional(id: string): FractionalAsset | null {
  return FRACTIONAL_ASSETS.find((f) => f.id === id) ?? null;
}

/** DNA fields for a fractional leg, honest by construction. */
export function fractionalDnaFields(asset: PairAsset): { vault: string | null; fractionalization: string; restrictions: string[] } {
  const verified = verifiedFractional(asset.id);
  if (asset.kind === "fractional_nft" && verified) {
    return {
      vault: verified.vault,
      fractionalization: `protocol:${verified.protocol}`,
      restrictions: [],
    };
  }
  if (asset.kind === "fractional_nft") {
    return {
      vault: null,
      fractionalization: "none",
      restrictions: [
        "FRACTIONAL: sin protocolo verificado en vivo — sin vault, sin backing, sin ejecución",
      ],
    };
  }
  return { vault: null, fractionalization: "none", restrictions: [] };
}
