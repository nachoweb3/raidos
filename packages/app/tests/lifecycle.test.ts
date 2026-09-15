import { describe, expect, it } from "vitest";
import { assertTransition, canTransition, canonicalJson, hashExecutionRequest } from "../src/trading/lifecycle.js";

describe("execution lifecycle", () => {
  it("allows the normal settlement path", () => {
    expect(canTransition("created", "submitted")).toBe(true);
    expect(canTransition("submitted", "pending")).toBe(true);
    expect(canTransition("pending", "confirmed")).toBe(true);
    expect(canTransition("confirmed", "settled")).toBe(true);
  });

  it("rejects skipping from created to settled", () => {
    expect(canTransition("created", "settled")).toBe(false);
    expect(() => assertTransition("created", "settled")).toThrow(/invalid execution transition/);
  });

  it("hashes objects independently of key order", () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
    expect(hashExecutionRequest({ b: 2, a: 1 })).toBe(hashExecutionRequest({ a: 1, b: 2 }));
    expect(hashExecutionRequest({ a: 1 })).not.toBe(hashExecutionRequest({ a: 2 }));
  });
});
