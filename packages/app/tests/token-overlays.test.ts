import { readFileSync } from "node:fs";
import { SourceTextModule, SyntheticModule, createContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { AppDb } from "../src/database/app-db.js";
import { ApiServer } from "../src/api/server.js";

const USDC_SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // real USDC mint (the required leg)
const MOON = "MoMuVWx5cYCGXcDjQ5M6Z6Bs6c3T7eTTC6PxC1gVaaa"; // fake token mint under test
const EVM_ADDR = "0x" + "a".repeat(40);

describe("token overlays (chart timeline)", () => {
  it("snaps events into their containing candle and never invents markers", async () => {
    const module = new SourceTextModule(readFileSync(new URL("../../../site/js/overlays.js", import.meta.url), "utf8"));
    await module.link(async (specifier) => {
      const values = specifier.startsWith("./gate-state")
        ? { gateHeaders: () => ({}) }
        : { ApiClient: {} };
      return new SyntheticModule(Object.keys(values), function () {
        for (const [name, value] of Object.entries(values)) this.setExport(name, value);
      });
    });
    await module.evaluate();
    const { overlayInterval, overlayMarkers } = module.namespace as any;

    // Candle interval snapping: picks the largest loaded interval <= seconds.
    expect(overlayInterval(301)).toBe(300);
    expect(overlayInterval(60)).toBe(60);
    expect(overlayInterval(7200)).toBe(3600);
    expect(overlayInterval(30)).toBe(60);

    const candles = [{ time: 300 }, { time: 600 }, { time: 900 }];
    const events = [
      { kind: "signal", time: 305, author: "@nacho" },
      { kind: "buy", time: 312 },           // same candle + different kind → own marker
      { kind: "sell", time: 640 },
      { kind: "buy", time: 200 },           // outside loaded candles → dropped
    ];
    const markers = overlayMarkers(events, candles.map((c) => c.time), 300);
    expect(markers).toHaveLength(3);
    // Same-candle kinds sort alphabetically (buy < signal); shapes stay disjoint from the pool's arrows.
    expect(markers[0]).toMatchObject({ time: 300, position: "belowBar", shape: "square", text: "C", color: "#87dded" });
    expect(markers[1]).toMatchObject({ time: 300, position: "belowBar", shape: "circle", text: "📡", color: "#bba3e9" });
    expect(markers[2]).toMatchObject({ time: 600, position: "aboveBar", shape: "square", text: "V", color: "#f38c9a" });
    // Pool markers use arrows; overlays use square/circle — shapes stay disjoint.
    expect(markers.filter((m: any) => m.shape.startsWith("arrow"))).toHaveLength(0);
  });

  it("builds the timeline end-to-end: gated TG calls + user fills feed the same chart", async () => {
    const db = new AppDb(":memory:");
    const server = new ApiServer({ dbPath: ":memory:", siteDir: null, port: 0, appMode: "mock", db });
    const port = await server.start();
    const base = `http://127.0.0.1:${port}`;
    try {
      // Enable the TG source (same trick as tg-signals.test.ts) so the gate lets redeem through.
      const src = server.telegramSource as unknown as { token: string; chatId: string };
      src.token = "test-token";
      src.chatId = "-100";

      // 1) Real gate: mint code (as the bot does) + redeem → fingerprint grant.
      process.env.ADMIN_SECRET = "test-overlays-secret";
      const mintRes = await fetch(base + "/api/admin/tg/mint-code", {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-secret": "test-overlays-secret" },
        body: JSON.stringify({ telegramUserId: "ovl" }),
      });
      expect(mintRes.status).toBe(200);
      const { code } = (await mintRes.json()) as any;
      const redeem = await fetch(base + "/api/tg/redeem", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }),
      });
      expect(redeem.status).toBe(200);
      const cookie = redeem.headers.get("set-cookie") ?? "";
      expect(cookie).toContain("tgp=");
      // The REAL signed pass the web would store (tg-signals gate flow).
      const { pass } = (await redeem.json()) as any;
      expect(pass).toMatch(/^[A-Za-z0-9_-]{43,64}(\.[A-Za-z0-9_-]{43,100})?$/);

      // 2) Signals anchored to the 5m bucket boundary-cross-proof: ts = now5+30
      //    always lands on a candle the module later loads (same or previous bucket).
      const now = Math.floor(Date.now() / 1000);
      const now5 = Math.floor(now / 300) * 300;
      server.db.insertTgSignals([
        { chat_id: "-100", message_id: 71, update_id: 71, token: MOON, chain: "solana", symbol: "MOON",
          author_id: "7", author_name: "@nacho", text: `CA ${MOON}`, ts: now5 + 30, fetched_at: now5 + 31,
          entry_price: 0.0012, entry_mcap: 82000 },
        { chat_id: "-100", message_id: 72, update_id: 72, token: EVM_ADDR, chain: "base", symbol: "OTH",
          author_id: "8", author_name: "@other", text: `CA ${EVM_ADDR}`, ts: now5 + 60, fetched_at: now5 + 61 },
      ]);

      // 3) Real user fills (mock execution is 1:1 USDC): buy 10, sell 4 → /api/trades rows.
      //    (the position guard forbids selling more than the open position)
      const reg = await fetch(base + "/api/auth/register", { method: "POST", body: "{}" });
      const { apiKey } = (await reg.json()) as any;
      // Platform wallet (WALLET_ENC_SECRET comes from vitest.config.ts env).
      const walletRes = await fetch(base + "/api/wallets", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer " + apiKey },
        body: JSON.stringify({ chain: "solana" }),
      });
      expect(walletRes.status).toBe(201);
      const post = (body: any, key: string) => fetch(base + "/api/trades/execute", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer " + apiKey, "Idempotency-Key": key },
        body: JSON.stringify(body),
      });
      const t1 = await post({ fromChain: "solana", sellToken: USDC_SOL, buyToken: MOON, amount: "10000000", password: "pw123456" }, "ovl-trade-1");
      expect(t1.status).toBe(200);
      const t2 = await post({ fromChain: "solana", sellToken: MOON, buyToken: USDC_SOL, amount: "4000000", password: "pw123456" }, "ovl-trade-2");
      expect(t2.status).toBe(200);
      const history = await (await fetch(base + "/api/trades?limit=10", { headers: { Authorization: "Bearer " + apiKey } })).json() as any;
      expect(history.trades.length).toBe(2);

      // 4) Evaluate the REAL frontend module: authenticated, with the pass header
      //    (mirrors gateHeaders()), over a live trading engine and 5m candles
      //    spanning the fills' settlement time (now).
      const evalNow5 = Math.floor(Date.now() / 1000 / 300) * 300;
      const candleData = [{ time: evalNow5 - 600 }, { time: evalNow5 - 300 }, { time: evalNow5 }, { time: evalNow5 + 300 }];
      let mergedWith: any = null;
      const engine = {
        chartInterval: 300,
        chartTools: { data: candleData, setMarkers: (markers: any) => { mergedWith = markers; } },
      };
      const context = createContext({
        window: { TradingEngine: engine },
        localStorage: { getItem: () => "pass-1", setItem: () => {}, removeItem: () => {} },
        fetch: (input: any, init: any) => globalThis.fetch(input, init),
        AbortController,
        document: { hidden: false, getElementById: () => null },
        setTimeout,
        clearTimeout,
      });
      const module = new SourceTextModule(readFileSync(new URL("../../../site/js/overlays.js", import.meta.url), "utf8"), { context });
      await module.link(async (specifier) => {
        const values = specifier.startsWith("./gate-state")
          ? { gateHeaders: () => ({ "x-tg-pass": pass }) }
          : { ApiClient: { isAuthenticated: () => true, request: async (path: string) => {
              const res = await fetch(base + path, { headers: path.startsWith("/api/tg/") ? { "x-tg-pass": pass } : { Authorization: "Bearer " + apiKey } });
              if (!res.ok) throw Error("HTTP " + res.status);
              return res.json();
            } } };
        return new SyntheticModule(Object.keys(values), function () {
          for (const [name, value] of Object.entries(values)) this.setExport(name, value);
        }, { context });
      });
      await module.evaluate();
      const { TokenOverlaysEngine } = module.namespace as any;

      engine.setMarkers = (markers: any) => { mergedWith = markers; };
      await TokenOverlaysEngine.setToken("solana", MOON);

      // 1 solana signal (ts now5+30 → candle now5) + 2 own fills (settled now → candle now5) = 3 events.
      // Pool-style markers come first (stable sort) when they share the candle with the signal.
      expect(TokenOverlaysEngine.events).toHaveLength(3);
      expect(mergedWith.map((m: any) => m.text)).toEqual(["C", "V", "📡"]);
      expect(mergedWith[0]).toMatchObject({ shape: "square", color: "#87dded" });
      expect(mergedWith[1]).toMatchObject({ shape: "square", color: "#f38c9a" });
      expect(mergedWith[2]).toMatchObject({ time: now5, shape: "circle", color: "#bba3e9" });

      // 5) Same token on another chain must contribute nothing.
      TokenOverlaysEngine.setToken("base", MOON);
      await new Promise((r) => setTimeout(r, 10));
      expect(TokenOverlaysEngine.events.filter((e: any) => e.kind === "signal")).toHaveLength(0);
      TokenOverlaysEngine.stop();
      expect(TokenOverlaysEngine.events).toHaveLength(0);
      delete process.env.ADMIN_SECRET;
    } finally {
      await server.stop();
      db.close();
    }
  });
});
