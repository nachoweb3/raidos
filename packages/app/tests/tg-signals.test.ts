/**
 * 📡 TELEGRAM SIGNALS — parser, source poll, DB dedup and API routes.
 * Honesty rules under test: no token = disabled (503, never fabricated data);
 * messages without a recognizable contract address are NOT signals.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractTicker,
  guessChain,
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
    expect(cands[1]).toMatchObject({ token: EVM_ADDR, chain: "evm" });
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

  it("persists and reloads the poll offset", () => {
    expect(db.getTgOffset()).toBe(0);
    db.setTgOffset(1234);
    expect(db.getTgOffset()).toBe(1234);
    expect(db.getTgOffset()).toBe(1234); // idempotent read
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
    expect(body.signals).toEqual([]);
    const status = await (await fetch(base + "/api/tg/status")).json() as any;
    expect(status.enabled).toBe(false);
    expect(status.signals).toBe(0);
  });

  it("serves ingested rows once the source is enabled and seeded", async () => {
    const src = server.telegramSource as unknown as { token: string; chatId: string };
    src.token = "test-token";
    src.chatId = "-1003686690861";
    void src;

    server.db.insertTgSignals([{
      chat_id: "-1003686690861", message_id: 8469, update_id: 1, token: SOL_MINT,
      chain: "solana", symbol: "BONK", author_id: "7", author_name: "@vip",
      text: `CA ${SOL_MINT}`, ts: 1700, fetched_at: 1701,
    }]);

    const res = await fetch(base + "/api/tg/signals?limit=10");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.status).toBe("LIVE");
    expect(body.signals).toHaveLength(1);
    expect(body.signals[0]).toMatchObject({ token: SOL_MINT, symbol: "BONK", chain: "solana", messageId: 8469 });

    const filtered = await (await fetch(base + "/api/tg/signals?chain=evm")).json() as any;
    expect(filtered.signals).toHaveLength(0);
    const badLimit = await fetch(base + "/api/tg/signals?limit=99999");
    expect(badLimit.status).toBe(200); // clamped, never 500
    const status = await (await fetch(base + "/api/tg/status")).json() as any;
    expect(status.enabled).toBe(true);
    expect(status.signals).toBe(1);
  });
});
