/**
 * 📡 TELEGRAM SIGNAL SOURCE — read-only ingestion of meme calls from a
 * private Telegram channel/supergroup via the Bot API getUpdates long poll.
 *
 * Honesty rules (project-wide):
 *  - WITHOUT a configured token the source is simply DISABLED — it never
 *    fabricates signals and the API reports { enabled: false }.
 *  - Text is parsed for observed data only: token tickers/names and on-chain
 *    contract addresses (Solana base58, EVM hex). A message without a
 *    recognizable address is NOT a signal.
 *  - No execution, no scoring, no "risk" claims: this is a call log with the
 *    original author and timestamp, exactly as posted in the chat.
 */

export interface TelegramSignalCandidate {
  /** Contract address found in the message (dedup key together with chat). */
  token: string;
  /** Chain guessed from the address shape; "unknown" when ambiguous. */
  chain: string;
  /** $TICKER or token name as written in the message (may be empty). */
  symbol: string;
  /** Telegram user id of the poster ("0" for channel posts / anonymous). */
  authorId: string;
  /** Best-effort display name of the poster. */
  authorName: string;
  /** Full message text, unmodified (bounded). */
  text: string;
  /** Message timestamp (seconds, as Telegram reports it). */
  ts: number;
  /** Telegram chat id (negative for groups/channels). */
  chatId: string;
  /** Telegram message id within the chat (dedup + t.me jump link). */
  messageId: number;
  /** Forum topic id when the group has topics (0 = none/General). */
  threadId: number;
}

export interface TelegramPollResult {
  ok: boolean;
  /** Candidates that survived dedup (inserted rows). */
  inserted: number;
  /** getUpdates offset to persist (highest update_id + 1). */
  offset?: number;
  error?: string;
}

const TG_API = "https://api.telegram.org";

/** Bounded storage: signal text longer than this is truncated. */
const MAX_TEXT = 1200;

/** Solana base58, 32–44 chars, typically starting 1-9 or A-H,J-N,Z,a-k,m-z. */
const SOLANA_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
/** EVM hex address, 0x + 40 hex chars. */
const EVM_RE = /\b0x[0-9a-fA-F]{40}\b/g;
/** $TICKER (1-12 alphanumerics) or CA:/Contract: labels. */
const TICKER_RE = /\$([A-Za-z][A-Za-z0-9]{0,11})/;

/** Bare URLs in text (Telegram already strips nothing — links may also arrive
 *  separately via message entities, see updateToInputs). */
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

/** EVM-flavored chain names that appear in link paths/queries of dexscreener,
 *  gmgn, birdeye, fomo, etc. Anything else Solana-ish maps to "solana". */
const EVM_CHAIN_TOKENS = new Set([
  "ethereum", "eth", "bsc", "bnb", "base", "arbitrum", "arb", "optimism", "op",
  "polygon", "matic", "blast", "avalanche", "avax", "tron", "sui", "ronin",
  "abstract", "berachain", "hyperevm", "hyperliquid", "unichain", "zora",
]);

/** Sites that are Solana-only by design (used when the URL names no chain). */
const SOLANA_ONLY_SITES = /pump\.fun|letsbonk\.fun|photon-sol\.tinyastro|rugcheck\.xyz|raydium\.io/i;
/** Sites that are EVM-only by design. */
const EVM_ONLY_SITES = /four\.meme|pancakeswap\.finance/i;

/** Canonical chain ("solana" | "evm") inferred from a link URL — path segments
 *  like /solana/<addr> or /base/<addr>, query params like ?chain=sol, or the
 *  site's known chain scope. Returns null when the URL gives no hint. */
export function chainFromUrl(url: string): string | null {
  const queryChain = url.match(/[?&](?:chain|net|network)=([a-z0-9_-]+)/i)?.[1]?.toLowerCase();
  const segments = [...url.matchAll(/\/(?:[a-z]{2,4}\.)?[a-z0-9-]+\.[a-z]{2,}\/([a-z0-9_-]{2,16})(?:\/|$)/gi)].map((m) => (m[1] ?? "").toLowerCase());
  const plainSegments = [...url.matchAll(/[?&](?:chain|net|network)=([a-z0-9_-]+)/gi)].map((m) => (m[1] ?? "").toLowerCase());
  for (const seg of [queryChain, ...segments, ...plainSegments]) {
    if (!seg) continue;
    if (seg === "solana" || seg === "sol") return "solana";
    if (EVM_CHAIN_TOKENS.has(seg)) return "evm";
  }
  if (SOLANA_ONLY_SITES.test(url)) return "solana";
  if (EVM_ONLY_SITES.test(url)) return "evm";
  return null;
}

/** All bare URLs present in a text body. */
export function extractUrlsFromText(text: string): string[] {
  return [...text.matchAll(URL_RE)].map((m) => m[0]);
}

/** Well-known non-Solana base58 strings that would otherwise false-positive. */
const BASE58_FALSE_POSITIVES = new Set([
  "So11111111111111111111111111111111111111112", // wrapped SOL mint (it IS valid base58, but it's a quote mint, not a call)
]);

/** Base58 alphabet (no 0, O, I, l). */
const BASE58_OK = /^[1-9A-HJ-NP-Za-km-z]+$/;

export function looksLikeSolanaAddress(s: string): boolean {
  if (!BASE58_OK.test(s) || s.length < 32 || s.length > 44) return false;
  return !BASE58_FALSE_POSITIVES.has(s);
}

export function looksLikeEvmAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}

export function guessChain(address: string): string {
  if (looksLikeEvmAddress(address)) return "evm";
  if (looksLikeSolanaAddress(address)) return "solana";
  return "unknown";
}

/** Extract the first $TICKER from a message, preferring one near the address. */
export function extractTicker(text: string, address: string): string {
  const tickers = [...text.matchAll(/\$([A-Za-z][A-Za-z0-9]{0,11})/g)].map((m) => m[1] ?? "").filter(Boolean);
  if (!tickers.length) return "";
  const at = text.indexOf(address);
  if (at >= 0) {
    const windowText = text.slice(Math.max(0, at - 120), at + 120 + address.length);
    const near = windowText.match(TICKER_RE);
    if (near?.[1]) return near[1];
  }
  return tickers[0] ?? "";
}

/** Parse one message into signal candidates (may be empty — that's honest).
 *  Addresses are scanned over the FULL text; only the stored copy is truncated. */
export function parseMessage(input: {
  text: string;
  /** URLs carried by Telegram entities (hyperlinked words) — they never
   *  appear in the plain text, so they must be scanned separately. */
  urls?: string[];
  authorId?: string;
  authorName?: string;
  ts: number;
  chatId: string | number;
  messageId?: number;
  threadId?: number;
}): TelegramSignalCandidate[] {
  const full = input.text ?? "";
  if (!full.trim() && !input.urls?.length) return [];
  const text = full.slice(0, MAX_TEXT);
  const seen = new Set<string>();
  const out: TelegramSignalCandidate[] = [];
  // 1) Links first: dexscreener/fomo/gmgn/pump URLs carry the CA plus a chain
  //    hint (path segment or ?chain=). Entity URLs are scanned too.
  const urls = [...extractUrlsFromText(full), ...(input.urls ?? [])];
  for (const url of urls) {
    const hint = chainFromUrl(url);
    // Hex addresses are unambiguous (always EVM); the link's chain hint only
    // disambiguates base58-shaped addresses found in the same URL.
    const addrChain = (address: string) =>
      looksLikeEvmAddress(address) ? "evm" : (hint ?? guessChain(address));
    for (const m of url.matchAll(SOLANA_RE)) {
      if (!looksLikeSolanaAddress(m[0]) || seen.has(m[0])) continue;
      seen.add(m[0]);
      out.push(mk(m[0], addrChain(m[0])));
    }
    for (const m of url.matchAll(EVM_RE)) {
      const key = m[0].toLowerCase(); // EVM addresses are case-insensitive: normalize
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(mk(key, addrChain(key)));
    }
  }
  // 2) Plain-text scan (covers bare CAs and CAs already inside scanned URLs —
  //    the seen set dedups those).
  for (const m of full.matchAll(SOLANA_RE)) {
    if (!looksLikeSolanaAddress(m[0]) || seen.has(m[0])) continue;
    seen.add(m[0]);
    out.push(mk(m[0]));
  }
  for (const m of full.matchAll(EVM_RE)) {
    const key = m[0].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(mk(key));
  }
  return out;

  function mk(address: string, chainOverride?: string): TelegramSignalCandidate {
    return {
      token: address,
      chain: chainOverride ?? guessChain(address),
      symbol: extractTicker(text, address),
      authorId: input.authorId ?? "0",
      authorName: input.authorName ?? "",
      text,
      ts: input.ts,
      chatId: String(input.chatId),
      messageId: Number.isFinite(input.messageId) ? Number(input.messageId) : 0,
      threadId: Number.isFinite(input.threadId) ? Number(input.threadId) : 0,
    };
  }
}

/** Flatten a Telegram update into message inputs (channel posts included).
 *  Hyperlinked words carry their URL in entities — those URLs are collected
 *  so the CA inside a dexscreener/fomo/pump link is never missed. */
export function updateToInputs(update: any): { input: Parameters<typeof parseMessage>[0]; updateId: number } | null {
  const msg = update.channel_post ?? update.message;
  if (!msg) return null;
  const text = msg.text ?? msg.caption ?? "";
  const entityUrls: string[] = [...(msg.entities ?? []), ...(msg.caption_entities ?? [])]
    .filter((e: any) => (e?.type === "url" || e?.type === "text_link") && e?.url)
    .map((e: any) => String(e.url));
  if (!text && !entityUrls.length) return null;
  const from = msg.from ?? null;
  const senderChat = msg.sender_chat ?? null;
  const authorId = from?.id != null ? String(from.id) : senderChat?.id != null ? String(senderChat.id) : "0";
  const authorName =
    from?.username ? `@${from.username}`
    : from?.first_name ? String(from.first_name)
    : senderChat?.title ? String(senderChat.title)
    : senderChat?.username ? `@${senderChat.username}`
    : "";
  const ts = Number(msg.date ?? Math.floor(Date.now() / 1000));
  const chatId = msg.chat?.id != null ? String(msg.chat.id) : "";
  if (!chatId) return null;
  const messageId = Number(msg.message_id ?? 0);
  const threadId = Number(msg.message_thread_id ?? 0);
  return {
    updateId: Number(update.update_id),
    input: { text, urls: entityUrls, authorId, authorName, ts, chatId, messageId, threadId },
  };
}

export interface TelegramSourceOptions {
  /** Bot token from BotFather. Empty/undefined = disabled (never fabricated). */
  token?: string;
  /** Optional chat filter. UNSET = ALL CHATS the bot can see (operator
   *  request: capture every call from every channel where the bot is a
   *  member, present or future). */
  chatId?: string;
  /** Optional forum topic filter. 0/absent = all topics. */
  topicId?: number;
  /** Long-poll seconds. Default 25 (Telegram max ~50). */
  pollSeconds?: number;
  /** Injected fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Injected clock (ms) for tests. */
  now?: () => number;
}

export class TelegramSignalSource {
  private readonly token: string;
  private readonly chatId: string;
  private readonly topicId: number;
  private readonly pollSeconds: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  /** getUpdates offset (highest update_id + 1); caller persists and re-seeds. */
  private offset = 0;
  /** Consecutive failures for honest status reporting. */
  lastError: string | null = null;
  lastSuccessAt = 0;

  constructor(options: TelegramSourceOptions) {
    this.token = (options.token ?? "").trim();
    this.chatId = (options.chatId ?? "").trim();
    this.topicId = Number(options.topicId ?? 0) || 0;
    this.pollSeconds = Math.min(Math.max(options.pollSeconds ?? 25, 0), 50);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.token.length > 0;
  }

  /** Re-seed the offset after restart (persisted in app_settings). */
  setOffset(value: number): void {
    if (Number.isFinite(value) && value > 0) this.offset = Math.floor(value);
  }

  getOffset(): number {
    return this.offset;
  }

  private async call(method: string, body: Record<string, unknown>): Promise<any> {
    const res = await this.fetchImpl(`${TG_API}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const json = (await res.json().catch(() => null)) as any;
    if (!res.ok || !json || json.ok !== true) {
      const desc = json?.description ?? `HTTP ${res.status}`;
      throw new Error(`telegram ${method}: ${desc}`);
    }
    return json.result;
  }

  /**
   * One long-poll pass: pull updates, parse candidates, advance the offset.
   * Returns parsed candidates + insertion count decided by the caller (db).
   */
  async poll(
    insert: (candidates: TelegramSignalCandidate[]) => number,
    isDuplicate: (token: string, chatId: string, messageId: number) => boolean,
  ): Promise<TelegramPollResult> {
    if (!this.enabled) return { ok: false, inserted: 0, error: "disabled" };
    try {
      // All-chats mode: no allowed_updates filtering needed beyond message shapes.
      const allowed = { allowed_updates: ["message", "channel_post"] };
      const updates: any[] = (await this.call("getUpdates", {
        offset: this.offset || undefined,
        timeout: this.pollSeconds,
        limit: 100,
        ...allowed,
      })) ?? [];
      let highest = this.offset ? this.offset - 1 : 0;
      const candidates: TelegramSignalCandidate[] = [];
      for (const update of updates) {
        const parsed = updateToInputs(update);
        if (!parsed) continue;
        if (parsed.updateId > highest) highest = parsed.updateId;
        // Filters are OPTIONAL now: with no TG_CHAT_ID/TG_TOPIC_ID everything
        // the bot can see is captured (operator: "mira todos los canales").
        if (this.chatId && parsed.input.chatId !== this.chatId) continue;
        if (this.topicId && Number(parsed.input.threadId ?? 0) !== this.topicId) continue;
        for (const c of parseMessage(parsed.input)) {
          if (isDuplicate(c.token, c.chatId, c.messageId)) continue;
          candidates.push(c);
        }
      }
      if (highest > 0) this.offset = highest + 1;
      const inserted = candidates.length ? insert(candidates) : 0;
      this.lastError = null;
      this.lastSuccessAt = this.now();
      return { ok: true, inserted, offset: this.offset };
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return { ok: false, inserted: 0, error: this.lastError };
    }
  }
}
