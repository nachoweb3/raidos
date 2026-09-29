import { afterEach, describe, expect, it, vi } from "vitest";
import { MarketDiscoveryLoop } from "../src/market/discovery-loop.js";
afterEach(() => vi.useRealTimers());
describe("continuous market discovery", () => {
  it("never overlaps jobs and waits for active work on shutdown", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const runOnce = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const loop = new MarketDiscoveryLoop({ runOnce: runOnce as any }, 10);
    loop.start(); loop.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(runOnce).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stopping = loop.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish(); await stopping;
    await vi.advanceTimersByTimeAsync(100);
    expect(runOnce).toHaveBeenCalledTimes(1);
  });
  it("continues after an upstream failure without overlapping retries", async () => {
    vi.useFakeTimers();
    const runOnce = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ status: "idle" });
    const loop = new MarketDiscoveryLoop({ runOnce }, 10);
    loop.start();
    await vi.advanceTimersByTimeAsync(11);
    expect(runOnce).toHaveBeenCalledTimes(2);
    await loop.stop();
  });
});
