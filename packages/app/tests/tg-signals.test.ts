/**
 * 📡 TELEGRAM SIGNALS — parser, source poll, DB dedup and API routes.
 * Honesty rules under test: no token = disabled (503, never fabricated data);
 * messages without a recognizable contract address are NOT signals.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chainFromUrl,
  extractTicker,
  extractUrlsFromText,
  guessChain,
  isEvmChain,
  looksLikeEvmAddress,
  looksLikeSolanaAddress,
  parseMessage,
  TelegramSignalSource,
  updateToInputs,
} from "../src/telegram/source.js";
import { AppDb } from "../src/database/app-db.js";
import { ApiServer } from "../src/api/server.js";
const SOL_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const EVM_ADDR = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("address parsing", () => {
  it("recognizes real solana and evm addresses", () => {
    expect(looksLikeSolanaAddress(SOL_MINT)).toBe(true);
    expect(looksLikeEvmAddress(EVM_ADDR)).toBe(true);
    expect(guessChain(SOL_MINT)).toBe("solana");
    expect(guessChain(EVM_ADDR)).toBe("evm");
  });

  it("rejects ordinary words and malformed strings", () => {
    expect(looksLikeSolanaAddress("hello world how are you today friend")).toBe(false);
    expect(looksLikeSolanaAddress("0OIl")).toBe(false);
    expect(guessChain("not an address")).toBe("unknown");
    expect(guessChain("0x123")).toBe("unknown");
  });

  it("does not treat a plain message without any address as a signal", () => {
    expect(parseMessage({ text: "la que se viene con $PEPE chicos 🚀", ts: 1, chatId: "-100" })).toEqual([]);
  });
});

describe("ticker extraction", () => {
  it("prefers the ticker nearest to the address", () => {
    const text = `$BONK ca: ${SOL_MINT} y luego hablamos de $WIF y $PEPE`;
    expect(extractTicker(text, SOL_MINT)).toBe("BONK");
  });

  it("falls back to the first ticker and returns empty without one", () => {
    expect(extractTicker("$WIF al moon", SOL_MINT)).toBe("WIF");
    expect(extractTicker("sin ticker aqui", SOL_MINT)).toBe("");
  });
});

describe("message → candidates", () => {
  it("extracts one candidate per address with chain and ticker", () => {
    const cands = parseMessage({
      text: `ENTRADA $BONK ${SOL_MINT}\nCA: ${EVM_ADDR}`,
      authorId: "42",
      authorName: "@caller",
      ts: 1700,
      chatId: "-1003686690861",
      messageId: 8469,
    });
    expect(cands).toHaveLength(2);
    expect(cands[0]).toMatchObject({
      token: SOL_MINT, chain: "solana", symbol: "BONK",
      chatId: "-1003686690861", messageId: 8469, authorName: "@caller",
    });
    expect(cands[1]).toMatchObject({ token: EVM_ADDR.toLowerCase(), chain: "evm" });
  });

  it("dedups repeated addresses inside one message", () => {
    const cands = parseMessage({ text: `${SOL_MINT} otra vez ${SOL_MINT}`, ts: 1, chatId: "-1" });
    expect(cands).toHaveLength(1);
  });

  it("truncates oversized text", () => {
    const long = "x".repeat(5000) + ` ${SOL_MINT}`;
    const cands = parseMessage({ text: long, ts: 1, chatId: "-1" });
    expect(cands).toHaveLength(1);
    expect(cands[0].text.length).toBeLessThanOrEqual(1200);
  });
});

describe("CA extraction from links (fomo/dexscreener/pump/gmgn)", () => {
  it("extracts the CA from a plain dexscreener link with chain hint", () => {
    const text = `entra aqui https://dexscreener.com/solana/${SOL_MINT} pronto`;
    const cands = parseMessage({ text, ts: 1, chatId: "-1" });
    expect(cands).toHaveLength(1);
    expect(cands[0]).toMatchObject({ token: SOL_MINT, chain: "solana" });
  });

  it("keeps the SPECIFIC EVM chain from the URL (bsc/base) for hex addresses", () => {
    const url = `https://dexscreener.com/base/${EVM_ADDR}`;
    expect(chainFromUrl(url)).toBe("base");
    const cands = parseMessage({ text: `check ${url}`, ts: 1, chatId: "-1" });
    expect(cands[0]).toMatchObject({ token: EVM_ADDR.toLowerCase(), chain: "base" });
  });

  it("reads chain from query params and site scope (four.meme → bsc)", () => {
    expect(chainFromUrl(`https://four.meme/token/${EVM_ADDR}`)).toBe("bsc");
    expect(chainFromUrl(`https://gmgn.ai/?chain=bsc`)).toBe("bsc");
    expect(chainFromUrl(`https://dexscreener.com/ethereum/${EVM_ADDR}`)).toBe("ethereum");
    expect(chainFromUrl(`https://pump.fun/coin/${SOL_MINT}`)).toBe("solana");
    expect(chainFromUrl("https://example.com/something")).toBeNull();
    expect(isEvmChain("bsc")).toBe(true);
    expect(isEvmChain("base")).toBe(true);
    expect(isEvmChain("evm")).toBe(true);
    expect(isEvmChain("solana")).toBe(false);
  });

  it("hex in a non-EVM-hint URL stays generic evm", () => {
    const cands = parseMessage({
      text: "mirad este chart 🔥",
      urls: [`https://dexscreener.com/solana/${SOL_MINT}?maker=${EVM_ADDR}`],
      ts: 1, chatId: "-1",
    });
    expect(cands[1]).toMatchObject({ token: EVM_ADDR.toLowerCase(), chain: "evm" });
  });

  it("captures hyperlinked-entity URLs that never appear in plain text", () => {
    // Telegram strips the URL from text when it is the href of a text_link entity.
    const cands = parseMessage({
      text: "mirad este chart 🔥",
      urls: [`https://dexscreener.com/solana/${SOL_MINT}?maker=${EVM_ADDR}`],
      ts: 1, chatId: "-1",
    });
    expect(cands).toHaveLength(2);
    expect(cands[0]).toMatchObject({ token: SOL_MINT, chain: "solana" });
    expect(cands[1]).toMatchObject({ token: EVM_ADDR.toLowerCase(), chain: "evm" });
  });

  it("updateToInputs collects url and text_link entities", () => {
    const flat = updateToInputs({
      update_id: 50,
      message: {
        message_id: 9, date: 1705, text: "CA aquí y link",
        chat: { id: -1003686690861 },
        entities: [
          { type: "url", url: `https://dexscreener.com/solana/${SOL_MINT}` },
          { type: "text_link", url: `https://fomo.example/${EVM_ADDR}` },
          { type: "bold" },
        ],
        from: { id: 3, first_name: "L" },
      },
    });
    expect(flat?.input.urls).toHaveLength(2);
    const cands = parseMessage(flat!.input);
    expect(cands.map((c) => c.token)).toContain(SOL_MINT);
  });

  it("does not double-report an address present both in URL and plain text", () => {
    const cands = parseMessage({
      text: `https://pump.fun/coin/${SOL_MINT} ca: ${SOL_MINT}`,
      urls: [`https://pump.fun/coin/${SOL_MINT}`],
      ts: 1, chatId: "-1",
    });
    expect(cands).toHaveLength(1);
  });

  it("extractUrlsFromText finds bare URLs and stops at delimiters", () => {
    const urls = extractUrlsFromText(`mira https://dexscreener.com/solana/abc y (https://pump.fun/x) fin`);
    expect(urls).toEqual(["https://dexscreener.com/solana/abc", "https://pump.fun/x"]);
  });

  it("a message with only hyperlinked URLs still yields signals", () => {
    expect(parseMessage({ text: "", urls: [`https://pump.fun/coin/${SOL_MINT}`], ts: 1, chatId: "-1" })).toHaveLength(1);
  });
});

describe("update flattening", () => {
  it("handles channel_post and message shapes, skips non-text updates", () => {
    const channel = updateToInputs({
      update_id: 10,
      channel_post: {
        message_id: 23803, date: 1701, text: `ca ${SOL_MINT}`,
        chat: { id: -1003686690861, title: "VIP calls" },
        sender_chat: { id: -1003686690861, title: "VIP calls" },
      },
    });
    expect(channel?.updateId).toBe(10);
    expect(channel?.input.authorName).toBe("VIP calls");

    const private_ = updateToInputs({
      update_id: 11,
      message: {
        message_id: 5, date: 1702, text: `ca ${SOL_MINT}`,
        chat: { id: -1003686690861 },
        from: { id: 77, username: "degen", first_name: "Deg" },
      },
    });
    expect(private_?.input.authorId).toBe("77");
    expect(private_?.input.authorName).toBe("@degen");

    expect(updateToInputs({ update_id: 12, message: { chat: { id: 1 }, photo: true } })).toBeNull();
  });
});

describe("TelegramSignalSource.poll", () => {
  function mkSource(updates: any[], opts: { chatId?: string } = {}) {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, result: updates }), { status: 200 }));
    const source = new TelegramSignalSource({
      token: "test-token", chatId: opts.chatId ?? "-1003686690861", pollSeconds: 0, fetchImpl,
    });
    return { source, fetchImpl };
  }

  it("parses, filters by chat and advances the offset", async () => {
    const { source, fetchImpl } = mkSource([
      { update_id: 100, channel_post: { message_id: 1, date: 1701, text: `CA ${SOL_MINT}`, chat: { id: -1003686690861 } } },
      { update_id: 101, channel_post: { message_id: 2, date: 1702, text: `CA ${EVM_ADDR}`, chat: { id: -999 } } }, // other chat
      { update_id: 102, message: { message_id: 3, date: 1703, text: "sin address", chat: { id: -1003686690861 }, from: { id: 5, first_name: "A" } } },
    ]);
    const inserted: string[] = [];
    const res = await source.poll(
      (cands) => { inserted.push(...cands.map((c) => c.token)); return cands.length; },
      () => false,
    );
    expect(res.ok).toBe(true);
    expect(res.offset).toBe(103); // highest update_id + 1
    expect(inserted).toEqual([SOL_MINT]); // only the configured chat, only addresses
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(source.lastError).toBeNull();
  });

  it("captures every chat when no chatId filter is set (all-chats mode)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, result: [
      { update_id: 300, channel_post: { message_id: 1, date: 1701, text: `vip ${SOL_MINT}`, chat: { id: -1003686690861 } } },
      { update_id: 301, message: { message_id: 2, date: 1702, text: `otro grupo ${EVM_ADDR}`, chat: { id: -42 }, from: { id: 8, first_name: "X" } } },
    ] }), { status: 200 }));
    const source = new TelegramSignalSource({ token: "t", pollSeconds: 0, fetchImpl }); // NO chatId
    const inserted: string[] = [];
    const res = await source.poll(
      (cands) => { inserted.push(...cands.map((c) => c.token)); return cands.length; },
      () => false,
    );
    expect(res.ok).toBe(true);
    expect(inserted).toEqual([SOL_MINT, EVM_ADDR.toLowerCase()]); // both chats
    expect(res.offset).toBe(302);
  });

  it("filters by forum topic when configured (t.me/c/<chat>/<topic>/...)", async () => {
    const mk = (updateId: number, threadId: number | undefined, text: string) => ({
      update_id: updateId,
      message: { message_id: updateId, date: 1701 + updateId, text, chat: { id: -1003686690861 }, message_thread_id: threadId, from: { id: 9, first_name: "T" } },
    });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, result: [
      mk(200, 8469, `en el topic ${SOL_MINT}`),
      mk(201, 777, `otro topic ${EVM_ADDR}`),
      mk(202, undefined, `general ${SOL_MINT}`),
    ] }), { status: 200 }));
    const source = new TelegramSignalSource({ token: "t", chatId: "-1003686690861", topicId: 8469, pollSeconds: 0, fetchImpl });
    const inserted: string[] = [];
    const res = await source.poll(
      (cands) => { inserted.push(...cands.map((c) => c.token)); return cands.length; },
      () => false,
    );
    expect(res.ok).toBe(true);
    expect(inserted).toEqual([SOL_MINT]); // only topic 8469
    expect(res.offset).toBe(203); // offset advances for ALL updates, even filtered ones
  });

  it("respects the isDuplicate gate", async () => {
    const { source } = mkSource([
      { update_id: 5, channel_post: { message_id: 1, date: 1701, text: SOL_MINT, chat: { id: -1003686690861 } } },
    ]);
    const res = await source.poll(() => 0, () => true);
    expect(res.ok).toBe(true);
    expect(res.inserted).toBe(0);
  });

  it("reports API errors honestly and does not advance the offset", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), { status: 401 }));
    const source = new TelegramSignalSource({ token: "bad", chatId: "-1", pollSeconds: 0, fetchImpl });
    const res = await source.poll(() => 0, () => false);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Unauthorized");
    expect(source.getOffset()).toBe(0);
    expect(source.lastError).toContain("Unauthorized");
  });

  it("is disabled without token and never fetches", async () => {
    const { source, fetchImpl } = mkSource([], { chatId: "" });
    (source as unknown as { token: string }).token = "";
    const res = await source.poll(() => 0, () => false);
    expect(res).toEqual({ ok: false, inserted: 0, error: "disabled" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("AppDb tg_signals", () => {
  let db: AppDb;
  beforeEach(() => { db = new AppDb(":memory:"); });
  afterEach(() => { db.close(); });

  const row = (over: Partial<Parameters<AppDb["insertTgSignals"]>[0][number]> = {}) => ({
    chat_id: "-1003686690861", message_id: 8469, update_id: 100, token: SOL_MINT,
    chain: "solana", symbol: "BONK", author_id: "7", author_name: "@vip",
    text: "CA en el canal", ts: 1700, fetched_at: 1701, ...over,
  });

  it("inserts, dedups by (chat,message,token) and lists newest first with chain filter", () => {
    expect(db.insertTgSignals([row()])).toBe(1);
    expect(db.insertTgSignals([row()])).toBe(0); // exact dup
    expect(db.insertTgSignals([row({ message_id: 8470 })])).toBe(1); // new message, same token
    expect(db.hasTgSignal(SOL_MINT, "-1003686690861", 8469)).toBe(true);
    expect(db.hasTgSignal(SOL_MINT, "-1003686690861", 9999)).toBe(false);

    db.insertTgSignals([row({ token: EVM_ADDR, chain: "evm", ts: 1800, message_id: 8471 })]);
    const all = db.listTgSignals(10);
    expect(all).toHaveLength(3);
    expect(all[0].token).toBe(EVM_ADDR); // ts 1800 newest
    const onlySol = db.listTgSignals(10, "solana");
    expect(onlySol).toHaveLength(2);
    expect(onlySol.every((s: any) => s.chain === "solana")).toBe(true);
    expect(db.countTgSignals()).toBe(3);
  });

  it("records entry price and mcap, allows updating entry, and filters by caller", () => {
    db.insertTgSignals([
      row({ message_id: 9001, token: SOL_MINT, author_name: "@alpha_king", author_id: "101", entry_price: 0.05, entry_mcap: 50000 }),
      row({ message_id: 9002, token: EVM_ADDR, author_name: "@beta_trader", author_id: "102", entry_price: 1.25, entry_mcap: 1250000 }),
    ]);

    const alphaCalls = db.listTgSignals(10, undefined, "@alpha_king");
    expect(alphaCalls).toHaveLength(1);
    expect(alphaCalls[0].entry_price).toBe(0.05);
    expect(alphaCalls[0].entry_mcap).toBe(50000);

    // Matching without @ prefix
    const alphaCallsNoAt = db.listTgSignals(10, undefined, "alpha_king");
    expect(alphaCallsNoAt).toHaveLength(1);

    // Update entry price
    expect(db.updateTgSignalEntry("-1003686690861", 9001, SOL_MINT, 0.08, 80000)).toBe(true);
    const updated = db.listTgSignals(10, undefined, "101");
    expect(updated[0].entry_price).toBe(0.08);
    expect(updated[0].entry_mcap).toBe(80000);
  });

  it("aggregates caller statistics with getTgCallerStats", () => {
    db.insertTgSignals([
      row({ message_id: 9101, token: SOL_MINT, author_name: "@whale", author_id: "200", chain: "solana", entry_price: 0.1 }),
      row({ message_id: 9102, token: EVM_ADDR, author_name: "@whale", author_id: "200", chain: "base", entry_price: 0.2 }),
    ]);

    const callers = db.getTgCallerStats(10);
    expect(callers.length).toBeGreaterThanOrEqual(1);
    const whale = callers.find((c) => c.authorName === "@whale");
    expect(whale).toBeDefined();
    expect(whale?.totalCalls).toBe(2);
    expect(whale?.callsWithEntryPrice).toBe(2);
    expect(whale?.chains).toEqual(expect.arrayContaining(["solana", "base"]));
  });

  it("persists and reloads the poll offset", () => {
    expect(db.getTgOffset()).toBe(0);
    db.setTgOffset(1234);
    expect(db.getTgOffset()).toBe(1234);
    expect(db.getTgOffset()).toBe(1234); // idempotent read
  });
});

describe("AppDb tg_access_codes (24h gate)", () => {
  let db: AppDb;
  beforeEach(() => { db = new AppDb(":memory:"); });
  afterEach(() => { db.close(); });

  it("mints, rotates (revoking the previous code) and redeems exactly once for 24h", () => {
    const first = db.mintTgAccessCode({ telegramUserId: "777", telegramUsername: "@vip", chatId: "-100" });
    expect(first.code).toMatch(/^[A-HJ-NP-Za-km-z2-9]{8}$/);
    expect(db.redeemTgAccessCode(first.code, "ip-a")).toBeGreaterThan(0); // grant until ~now+24h
    expect(db.redeemTgAccessCode(first.code, "ip-b")).toBeNull(); // single use

    // Rotation: a fresh mint revokes the old row but the used one stays consumed.
    const second = db.mintTgAccessCode({ telegramUserId: "777" });
    expect(second.code).not.toBe(first.code);
    expect(db.redeemTgAccessCode(first.code, "ip-c")).toBeNull();
    expect(db.redeemTgAccessCode(second.code, "ip-c")).toBeGreaterThan(0);
  });

  it("rejects unknown, revoked and expired codes", () => {
    expect(db.redeemTgAccessCode("NOPE1234", null)).toBeNull();
    const fresh = db.mintTgAccessCode({ telegramUserId: "42", now: Math.floor(Date.now() / 1000) - 86_400 * 2 });
    expect(db.redeemTgAccessCode(fresh.code, null)).toBeNull(); // minted 2 days ago → expired
    const revoked = db.mintTgAccessCode({ telegramUserId: "43" });
    db.mintTgAccessCode({ telegramUserId: "43" }); // rotation revokes the first
    expect(db.redeemTgAccessCode(revoked.code, null)).toBeNull();
  });

  it("stores and reads per-fingerprint grants with the longest window", () => {
    const now = Math.floor(Date.now() / 1000);
    db.upsertTgAccessGrant("fp-1", now + 3600);
    expect(db.getTgAccessGrant("fp-1")).toBe(now + 3600);
    db.upsertTgAccessGrant("fp-1", now + 7200);
    expect(db.getTgAccessGrant("fp-1")).toBe(now + 7200); // extended
    db.upsertTgAccessGrant("fp-1", now + 60);
    expect(db.getTgAccessGrant("fp-1")).toBe(now + 7200); // never shortened
    expect(db.getTgAccessGrant("fp-2")).toBeNull();
  });
});

describe("API routes /api/tg/*", () => {
  let server: ApiServer;
  let base = "";

  beforeAll(async () => {
    server = new ApiServer({ dbPath: ":memory:", siteDir: null, port: 0, appMode: "mock" });
    const port = await server.start();
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await server.stop();
  });

  it("answers 503 TG_NOT_CONFIGURED without env token (never fabricated)", async () => {
    const res = await fetch(base + "/api/tg/signals");
    expect(res.status).toBe(503);
    const body = await res.json() as any;
    expect(body.error).toBe("TG_NOT_CONFIGURED");
    const callersRes = await fetch(base + "/api/tg/callers");
    expect(callersRes.status).toBe(503);
    const status = await (await fetch(base + "/api/tg/status")).json() as any;
    expect(status.enabled).toBe(false);
    expect(status.signals).toBe(0);
  });

  it("/api/health exposes cheap saturation telemetry (load, rss, db size, ingest state)", async () => {
    const res = await fetch(base + "/api/health");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.mode).toBe("mock");
    expect(typeof body.load1).toBe("number");
    expect(body.cores).toBeGreaterThan(0);
    expect(body.loadNorm).toBeCloseTo(body.load1 / body.cores, 2);
    expect(body.rssMb).toBeGreaterThan(0);
    expect(body.heapUsedMb).toBeGreaterThan(0);
    // :memory: en tests → tamaño de DB no aplicable, se omite en vez de mentir.
    expect(body.dbSizeMb).toBeUndefined();
    expect(body.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(body.ingest).toEqual({ walletActivity: false, lastPassAt: null, lastInserted: 0 });
    expect(typeof body.ts).toBe("number");
  });

  it("gates signals behind the 24h code (401 without pass, 200 after redeem)", async () => {
    const src = server.telegramSource as unknown as { token: string; chatId: string };
    src.token = "test-token";
    src.chatId = "-1003686690861";
    void src;

    // Seeded signal but NO pass → 401 TG_ACCESS_REQUIRED.
    server.db.insertTgSignals([{
      chat_id: "-1003686690861", message_id: 9901, update_id: 1, token: SOL_MINT,
      chain: "solana", symbol: "BONK", author_id: "7", author_name: "@vip",
      text: `CA ${SOL_MINT}`, ts: 1700, fetched_at: 1701,
    }]);
    const denied = await fetch(base + "/api/tg/signals?limit=10");
    expect(denied.status).toBe(401);
    expect(((await denied.json()) as any).error).toBe("TG_ACCESS_REQUIRED");

    // Bad code → 403.
    const bad = await fetch(base + "/api/tg/redeem", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "XXXXXXXX" }),
    });
    expect(bad.status).toBe(403);

    // Mint via admin endpoint (same call the bot makes) and redeem.
    process.env.ADMIN_SECRET = "test-admin-secret";
    const mintRes = await fetch(base + "/api/admin/tg/mint-code", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-secret": "test-admin-secret" },
      body: JSON.stringify({ telegramUserId: "u1", telegramUsername: "@u1" }),
    });
    expect(mintRes.status).toBe(200);
    const { code } = (await mintRes.json()) as any;
    expect(code).toMatch(/^[A-HJ-NP-Za-km-z2-9]{8}$/);

    const redeemRes = await fetch(base + "/api/tg/redeem", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }),
    });
    expect(redeemRes.status).toBe(200);
    const cookie = redeemRes.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("tgp=");

    // With the grant cookie the signals flow; the cookie works on callers too.
    const ok = await fetch(base + "/api/tg/signals?limit=10", { headers: { cookie } });
    expect(ok.status).toBe(200);
    const okBody = await ok.json() as any;
    expect(okBody.status).toBe("LIVE");
    expect(okBody.signals.length).toBeGreaterThan(0);
    const callersOk = await fetch(base + "/api/tg/callers", { headers: { cookie } });
    expect(callersOk.status).toBe(200);

    // /api/tg/access reports the live window for the cookie bearer.
    const access = await (await fetch(base + "/api/tg/access", { headers: { cookie } })).json() as any;
    expect(access.enabled).toBe(true);
    expect(access.until).toBeGreaterThan(Math.floor(Date.now() / 1000));

    // The same code cannot be redeemed twice.
    const again = await fetch(base + "/api/tg/redeem", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }),
    });
    expect(again.status).toBe(403);
    delete process.env.ADMIN_SECRET;
  });

  it("serves ingested rows once the source is enabled, seeded and the gate is passed", async () => {
    const src = server.telegramSource as unknown as { token: string; chatId: string };
    src.token = "test-token";
    src.chatId = "-1003686690861";
    void src;

    server.db.insertTgSignals([{
      chat_id: "-1003686690861", message_id: 8469, update_id: 1, token: SOL_MINT,
      chain: "solana", symbol: "BONK", author_id: "7", author_name: "@vip",
      text: `CA ${SOL_MINT}`, ts: 1700, fetched_at: 1701,
      entry_price: 0.00042, entry_mcap: 420000,
    }]);

    // Mint + redeem to get a valid pass cookie for this suite.
    process.env.ADMIN_SECRET = "test-admin-secret";
    const mintRes = await fetch(base + "/api/admin/tg/mint-code", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-secret": "test-admin-secret" },
      body: JSON.stringify({ telegramUserId: "u-suite" }),
    });
    const { code } = (await mintRes.json()) as any;
    const redeem = await fetch(base + "/api/tg/redeem", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }),
    });
    const cookie = redeem.headers.get("set-cookie") ?? "";
    const auth = { headers: { cookie } };

    const res = await fetch(base + "/api/tg/signals?limit=10", auth);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.status).toBe("LIVE");
    expect(body.signals.length).toBeGreaterThanOrEqual(1); // este suite + filas del suite anterior (DB compartida)
    expect(body.signals).toEqual(
      expect.arrayContaining([expect.objectContaining({
        token: SOL_MINT, symbol: "BONK", chain: "solana", messageId: 8469,
        entryPrice: 0.00042, entryMcap: 420000,
      })]),
    );

    // Caller filter (ambas filas insertadas son de @vip)
    const callerRes = await (await fetch(base + "/api/tg/signals?caller=@vip", auth)).json() as any;
    expect(callerRes.signals.length).toBeGreaterThanOrEqual(1);
    const callerMismatch = await (await fetch(base + "/api/tg/signals?caller=nobody", auth)).json() as any;
    expect(callerMismatch.signals).toHaveLength(0);

    // Callers endpoint
    const callersData = await (await fetch(base + "/api/tg/callers", auth)).json() as any;
    expect(callersData.status).toBe("LIVE");
    expect(callersData.callers).toHaveLength(1);
    expect(callersData.callers[0]).toMatchObject({ authorName: "@vip", callsWithEntryPrice: 1 });
    expect(callersData.callers[0].totalCalls).toBeGreaterThanOrEqual(1);

    const filtered = await (await fetch(base + "/api/tg/signals?chain=evm", auth)).json() as any;
    expect(filtered.signals).toHaveLength(0);
    const badLimit = await fetch(base + "/api/tg/signals?limit=99999", auth);
    expect(badLimit.status).toBe(200); // clamped, never 500
    const status = await (await fetch(base + "/api/tg/status")).json() as any;
    expect(status.enabled).toBe(true);
    expect(status.signals).toBeGreaterThanOrEqual(1); // DB compartida entre suites
    delete process.env.ADMIN_SECRET;
  });
});

describe("entry backfill — signals without entry snapshot", () => {
  let db: AppDb;
  beforeEach(() => { db = new AppDb(":memory:"); });
  afterEach(() => { db.close(); });

  const row = (over: Partial<Parameters<AppDb["insertTgSignals"]>[0][number]> = {}) => ({
    chat_id: "-1003686690861", message_id: 1, update_id: 100, token: SOL_MINT,
    chain: "solana", symbol: "BONK", author_id: "7", author_name: "@vip",
    text: "CA en el canal", ts: 1700, fetched_at: 1701, ...over,
  });

  it("lists only signals without entry price, newest first, bounded by limit and dedupable by token", () => {
    db.insertTgSignals([
      row({ message_id: 1, ts: 100, entry_price: 0.1 }), // has snapshot
      row({ message_id: 2, ts: 200 }),
      row({ message_id: 3, ts: 300, token: EVM_ADDR, chain: "base" }),
      row({ message_id: 4, ts: 400 }), // same token+chain as message 2 → backfill dedups it
    ]);
    const missing = db.listTgSignalsMissingEntry(10);
    expect(missing.map((m) => m.message_id)).toEqual([4, 3, 2]); // newest first
    expect(db.listTgSignalsMissingEntry(2)).toHaveLength(2);
    // Server-side batch selection: first occurrence per chain:token wins
    const seen = new Set<string>();
    const batch: typeof missing = [];
    for (const m of missing) {
      const key = (m.chain || "") + ":" + m.token.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key); batch.push(m);
    }
    expect(batch.map((m) => m.message_id)).toEqual([4, 3]);
  });

  it("writes the candle open as entry and clears the signal from the missing list", () => {
    db.insertTgSignals([row({ message_id: 5, ts: 500 })]);
    const [m] = db.listTgSignalsMissingEntry(5);
    expect(db.updateTgSignalEntry(m.chat_id, m.message_id, m.token, 0.0123, null)).toBe(true);
    expect(db.listTgSignalsMissingEntry(5)).toHaveLength(0);
    const [sig] = db.listTgSignals(5);
    expect(sig.entry_price).toBe(0.0123);
  });
});

// ─── Frontend UI safety (tg-signals.js) ─────────────────────────────────────

/**
 * The gated 📡 tab must never leak the source channel: the backend stores
 * chat_id/message_id so the ingest can dedupe, but the rendered page must not
 * link out to t.me (the gate 24h would otherwise be bypassable via the
 * message link). These tests run the REAL frontend module in a VM context.
 */
describe("tg-signals frontend (privacy + performance UI)", () => {
  async function loadTgSignals(rootOverride?: unknown) {
    const { readFileSync } = await import("node:fs");
    const { SourceTextModule, SyntheticModule, createContext } = await import("node:vm");
    const { fileURLToPath } = await import("node:url");
    const context = createContext({
      document: { getElementById: () => rootOverride ?? null, querySelector: () => null, querySelectorAll: () => [] },
      window: {},
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      navigator: { clipboard: { writeText: async () => {} } },
      queueMicrotask,
      requestAnimationFrame: (fn: FrameRequestCallback) => 0,
      CSS: { escape: (s: string) => s },
    });
    const module = new SourceTextModule(
      readFileSync(fileURLToPath(new URL("../../../site/js/tg-signals.js", import.meta.url)), "utf8"),
      { context },
    );
    const market = { priceUsd: 0.02, mcap: 500_000, pairAddress: "pool1" };
    const exports: Record<string, Record<string, unknown>> = {
      "./api.js": { ApiClient: { request: async () => ({ signals: [] }), isAuthenticated: () => false } },
      "./dexfeed.js": { DexFeed: { get: () => market, cache: {}, _key: (c: string, t: string) => c + ":" + t, ensureTokens: async () => {} } },
      "./public-market.js": { publicPoolData: async () => ({ candles: [] }) },
      "./gate-state.js": {
        gateStorage: () => null, gateSetState: () => {}, gateHeaders: () => ({}), gateCountdown: () => "00:00:00",
      },
    };
    await module.link(async (specifier) => {
      const values = exports[specifier.replace(/\?v=\d{8}-\d+$/, "")];
      if (!values) throw new Error(`unexpected import: ${specifier}`);
      return new SyntheticModule(Object.keys(values), function () {
        for (const [name, value] of Object.entries(values)) this.setExport(name, value);
      }, { context });
    });
    await module.evaluate();
    return { engine: (module.namespace as any).TgSignalsEngine, namespace: module.namespace as any };
  }

  it("never renders a link to the source Telegram message (channel privacy)", async () => {
    const { engine } = await loadTgSignals();
    const html = engine._renderCard({
      token: "MoMuVWx5cYCGXcDjQ5M6Z6Bs6c3T7eTTC6PxC1gVaaa", symbol: "TEST", chain: "solana",
      ts: Math.floor(Date.now() / 1000) - 60, chatId: "-1003686690861", messageId: 42,
      authorName: "nacho", text: "call de prueba", entryPrice: 0.001, entryMcap: null,
    });
    expect(html).not.toContain("t.me");
    expect(html).not.toContain("<a ");
    expect(html).toContain("tg-call-meta"); // moment shown as plain text instead
  });

  it("computes honest call performance: only priced+live rows count, unpriced never dilute", async () => {
    const { namespace } = await loadTgSignals();
    const mk = (over: Record<string, unknown>) => ({
      token: "MoMuVWx5cYCGXcDjQ5M6Z6Bs6c3T7eTTC6PxC1gVaaa", chain: "solana", ts: 100,
      entryPrice: 0.001, authorName: "nacho", ...over,
    });
    // The DexFeed stub returns priceUsd 0.02 for every mint it is asked about.
    const perf = namespace.computeCallPerformance([
      mk({ token: "TokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", symbol: "WIN", entryPrice: 0.001 }), // 0.02/0.001 = 20x
      mk({ token: "TokenBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", symbol: "LOSE", entryPrice: 0.05 }), // 0.02/0.05 = 0.4x
      mk({ token: "TokenCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC", symbol: "NOPRICE", entryPrice: null }), // no entry → excluded
      mk({ token: "TokenDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD", symbol: "NOENTRY", entryPrice: 0 }), // zero entry → excluded
    ]);
    expect(perf.evaluated).toBe(2);
    expect(perf.unpriced).toBe(2);
    expect(perf.winners).toBe(1);
    expect(perf.winRate).toBeCloseTo(50, 6);
    expect(perf.best?.symbol).toBe("WIN");
    expect(perf.best?.mult).toBeCloseTo(20, 6);
    expect(perf.avgWinnerX).toBeCloseTo(20, 6);
    expect(perf.avgPct).toBeCloseTo((1900 + (-60)) / 2, 6);
  });

  it("ranks callers with achievements derived only from visible metrics", async () => {
    const { namespace } = await loadTgSignals();
    const call = (author: string, entry: number | null) => ({
      token: "TokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", chain: "solana", ts: 100,
      entryPrice: entry, authorName: author,
    });
    const perf = namespace.computeCallPerformance([
      call("alpha", 0.001), // 20x winner
      call("alpha", 0.01),  // 2x winner
      call("beta", 0.05),   // 0.4x loser
      call("beta", null),   // excluded
    ]);
    expect(perf.callerStats[0]?.author).toBe("alpha");
    const alpha = perf.callerStats[0];
    expect(alpha.calls).toBe(2);
    expect(alpha.winners).toBe(2);
    expect(alpha.winRate).toBe(100);
    expect(alpha.bestMult).toBeCloseTo(20, 6);
    expect(alpha.achievements.map((a: any) => a.icon)).toContain("🚀"); // best 20x ≥ 10
    expect(alpha.achievements.map((a: any) => a.icon)).toContain("💎"); // 100% acierto
    const beta = perf.callerStats.find((c: any) => c.author === "beta");
    expect(beta.calls).toBe(1); // the unpriced call never counts
    expect(beta.winners).toBe(0);
    expect(beta.achievements).toEqual([]); // nothing invented for a losing caller
  });

  it("perf modal: period chips switch the real period via load, same-period re-render keeps scroll", async () => {
    const modalEl: any = { scrollTop: 120 };
    const inserted: string[] = [];
    const rootStub = {
      querySelector: (sel: string) => (sel === ".tg-perf-modal" ? modalEl : null),
      insertAdjacentHTML: (_pos: string, html: string) => inserted.push(html),
    };
    const { engine, namespace } = await loadTgSignals(rootStub);
    const perf = namespace.computeCallPerformance([]); // período sin calls evaluables → vacío honesto
    engine._lastPerf = perf;
    engine.timeFilter = "all";
    const loadCalls: string[] = [];
    engine.load = function () { loadCalls.push(this.timeFilter); return Promise.resolve(); };

    // Período desconocido → ignorado sin tocar estado ni recargar.
    engine.showPerformance("5h");
    expect(engine.timeFilter).toBe("all");
    expect(loadCalls).toEqual([]);

    // Chip de otro período → cambia el período REAL y recarga la lista (fuente de verdad = servidor).
    engine.showPerformance("24h");
    expect(engine.timeFilter).toBe("24h");
    expect(loadCalls).toEqual(["24h"]);
    await new Promise((resolve) => setTimeout(resolve, 0)); // drena la reapertura post-load (sin .tg-count-bar → no re-abre)

    // Chip del período activo / botón 📈 → re-render del mismo período sin recargar, conserva el scroll.
    engine.showPerformance();
    expect(loadCalls).toEqual(["24h"]);
    expect(inserted).toHaveLength(1);
    const html = inserted[0];
    expect(html).toContain("tg-perf-overlay");
    for (const key of ["all", "1h", "6h", "12h", "24h", "7d", "30d"]) {
      expect(html).toContain(`showPerformance('${key}')`);
    }
    expect(html).toMatch(/tg-perf-period active[^>]*'24h'/);
    expect(html).not.toContain("Performance & Ranking ·"); // el período vive en los chips, no duplicado en el título
    expect(html).toContain("Sin calls evaluables en este período"); // vacío honesto, sin podio inventado
    expect(modalEl.scrollTop).toBe(120); // re-render no te tira arriba
  });
});
