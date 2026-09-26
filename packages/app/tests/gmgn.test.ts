import { describe, expect, it } from "vitest";
import { GmgnService, GmgnUnavailableError, mapTrenchRow, GMGN_CHAINS } from "../src/market/gmgn.js";

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const TRENCH_ROW = {
  address: "BzRstV3WCBrsJVtdNK3ssAhcyB6qHUQMUxqNxYh2pump",
  symbol: "RESTOCK",
  name: "Restock Markets",
  logo: "https://gmgn.ai/external-res/x.webp",
  price: 0.0000503682,
  price_change_percent: 1135.69,
  price_change_percent5m: 72.79,
  price_change_percent1h: 1135.69,
  volume: 602448,
  liquidity: 20686.5,
  usd_market_cap: 48759.1,
  holder_count: 608,
  swaps_24h: 12097,
  buys_24h: 5900,
  sells_24h: 6197,
  smart_degen_count: 37,
  renowned_count: 6,
  sniper_count: 37,
  bundler_trader_amount_rate: 0.2541,
  rat_trader_amount_rate: 0.0193,
  fresh_wallet_rate: 0.0473,
  rug_ratio: 0.12,
  is_honeypot: 0,
  dev_team_hold_rate: 0.0141,
  top_10_holder_rate: 0.2503,
  launchpad: "pump",
  launchpad_platform: "Pump.fun",
  is_on_curve: 0,
  created_timestamp: 1790376182,
  twitter_username: "RestockMarkets",
  telegram: "",
  website: "https://restockmarkets.com/",
};

const serviceWith = (fetcher: (url: string, init?: RequestInit) => Promise<Response>, apiKey = "demo") =>
  new GmgnService({ fetcher, apiKey, ttlMs: 60_000, limit: 5 });

describe("GmgnService", () => {
  it("GMGN_CHAINS cubre las cadenas del board", () => {
    expect(GMGN_CHAINS).toContain("solana");
    expect(GMGN_CHAINS).toContain("bsc");
    expect(GMGN_CHAINS).toContain("arc");
  });

  it("sin GMGN_API_KEY → GmgnUnavailableError nombrado (degradación honesta)", async () => {
    const svc = new GmgnService({ fetcher: async () => jsonRes({}), apiKey: "" });
    expect(svc.enabled).toBe(false);
    await expect(svc.trenches("solana")).rejects.toThrow(/GMGN_API_KEY not configured/);
    await expect(svc.trenches("solana")).rejects.toBeInstanceOf(GmgnUnavailableError);
  });

  it("trenches mapea las tres secciones con analítica real", async () => {
    const captured: { url: string; init?: RequestInit }[] = [];
    const svc = serviceWith(async (url, init) => {
      captured.push({ url, init });
      return jsonRes({ code: 0, data: { new_creation: [TRENCH_ROW], near_completion: [], completed: [TRENCH_ROW] } });
    });
    const result = await svc.trenches("solana");
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toContain("https://openapi.gmgn.ai/v1/trenches?chain=sol&");
    const body = JSON.parse(String(captured[0].init?.body));
    expect(body.version).toBe("v2");
    expect(body.new_creation.limit).toBe(5);
    expect(Object.keys(body)).toEqual(expect.arrayContaining(["new_creation", "near_completion", "completed"]));
    expect(result.sections.new_creation.tokens).toHaveLength(1);
    const t = result.sections.new_creation.tokens[0];
    expect(t.symbol).toBe("RESTOCK");
    expect(t.address).toBe("BzRstV3WCBrsJVtdNK3ssAhcyB6qHUQMUxqNxYh2pump");
    expect(t.smartMoneyCount).toBe(37);
    expect(t.kolCount).toBe(6);
    expect(t.sniperCount).toBe(37);
    expect(t.bundlerRate).toBeCloseTo(25.41);
    expect(t.insiderRate).toBeCloseTo(1.93);
    expect(t.rugRatio).toBeCloseTo(0.12);
    expect(t.honeypot).toBe(false);
    expect(t.change5m).toBeCloseTo(72.79);
    expect(t.marketCapUsd).toBeCloseTo(48759.1);
    expect(t.twitter).toBe("https://x.com/RestockMarkets");
    expect(t.website).toBe("https://restockmarkets.com/");
    expect(t.telegram).toBeNull();
    expect(result.sections.completed.tokens).toHaveLength(1);
    expect(result.sections.near_completion.tokens).toHaveLength(0);
  });

  it("segunda llamada dentro del TTL usa caché", async () => {
    let calls = 0;
    const svc = serviceWith(async () => {
      calls++;
      return jsonRes({ code: 0, data: { new_creation: [TRENCH_ROW], near_completion: [], completed: [] } });
    });
    await svc.trenches("solana");
    await svc.trenches("solana");
    expect(calls).toBe(1);
  });

  it("provider falla con caché previa → sirve caché degradada", async () => {
    let calls = 0;
    const svc = new GmgnService({
      fetcher: async () => {
        calls++;
        if (calls === 1) return jsonRes({ code: 0, data: { new_creation: [TRENCH_ROW], near_completion: [], completed: [] } });
        return jsonRes({ code: 1, message: "rate limited" }, 429);
      },
      apiKey: "demo",
      ttlMs: 10,
    });
    const first = await svc.trenches("solana");
    expect(first.sections.new_creation.status).toBe("LIVE");
    await new Promise((r) => setTimeout(r, 25));
    const second = await svc.trenches("solana");
    expect(second.sections.new_creation.tokens).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it("provider fallo sin caché → 503 honesto (GmgnUnavailableError)", async () => {
    const svc = serviceWith(async () => jsonRes({ code: 1, message: "boom" }, 500));
    await expect(svc.trenches("solana")).rejects.toThrow(/GMGN error HTTP 500/);
  });

  it("cadena inválida → error nombrado, nunca fetch", async () => {
    let fetched = 0;
    const svc = serviceWith(async () => { fetched++; return jsonRes({}); });
    await expect(svc.trenches("bitcoin")).rejects.toBeInstanceOf(GmgnUnavailableError);
    expect(fetched).toBe(0);
  });

  it("tokenSecurity mapea rug ratio + honeypot y valida dirección", async () => {
    const svc = serviceWith(async () => jsonRes({ code: 0, data: { rug_ratio: 0.05, is_honeypot: 0, is_open_source: 1, is_renounced: 1, buy_tax: 0, sell_tax: 0 } }));
    const sec = await svc.tokenSecurity("solana", "BzRstV3WCBrsJVtdNK3ssAhcyB6qHUQMUxqNxYh2pump");
    expect(sec.rugRatio).toBeCloseTo(0.05);
    expect(sec.honeypot).toBe(false);
    expect(sec.source).toBe("gmgn");
    await expect(svc.tokenSecurity("solana", "corta")).rejects.toBeInstanceOf(GmgnUnavailableError);
  });
});

describe("mapTrenchRow — honestidad de campos", () => {
  it("campos ausentes → null (nunca inventados)", () => {
    const t = mapTrenchRow({ address: "abc", symbol: "X" }, "sol");
    expect(t.smartMoneyCount).toBeNull();
    expect(t.rugRatio).toBeNull();
    expect(t.logo).toBeNull();
    expect(t.honeypot).toBeNull();
    expect(t.priceUsd).toBeNull();
  });

  it("logo no-http y socials raros → null o normalizado", () => {
    const t = mapTrenchRow({ address: "a", symbol: "X", logo: "javascript:alert(1)", twitter_username: "@foo" }, "sol");
    expect(t.logo).toBeNull();
    expect(t.twitter).toBe("https://x.com/foo");
  });
});
