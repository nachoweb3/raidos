import "dotenv/config";
import { Bot } from "grammy";
import { BrainDb } from "./database/db.js";
import { ChatSettings } from "./settings.js";
import { ConfigPanel } from "./config.panel.js";
import { OllamaProvider } from "./ai/ollama.js";
import { CloudProvider } from "./ai/cloud.js";
import type { AiProvider } from "./ai/provider.js";
import { MockProvider } from "./ai/mock.js";
import { isQuestion } from "./modules/questions.js";
import { learnText, MIN_ADMIN_POST_LEN } from "./modules/kb.js";
import { packEmbedding } from "./modules/embeddings.js";
import { ask, FALLBACK_ANSWER } from "./modules/ask.js";
import { analyzeChat, DEFAULT_ANALYZER_OPTIONS } from "./modules/analyzer.js";
import { communityMemory, memoryText } from "./modules/memory.js";
import { pulseMetrics, pulseText, pulseNarrative } from "./modules/pulse.js";
import { briefingText } from "./modules/briefing.js";
import { XpEngine, LEVEL_TITLES } from "./modules/xp.js";
import { BadgeEngine, BADGE_CODES, badgeByCode } from "./modules/badges.js";
import { RaidEngine, parseDuration, raidScoreText, RAID_PLATFORMS } from "./modules/raids.js";
import { raidAnalytics, raidAnalyticsText, raidAnalyticsNarrative } from "./modules/raid-analytics.js";
import { unifiedMomentumAlert } from "./modules/momentum.js";
import { volumeCard } from "./market/volume.js";
import { providerByName, PROVIDER_NAMES } from "./market/providers.js";
import type { MarketDataProvider, TokenStats } from "./market/providers.js";
import { QuestEngine } from "./modules/quests.js";
import type { QuestRequirement } from "./modules/quests.js";
import { MemeEngine } from "./modules/memes.js";
import { topUsers, leaderboardText } from "./modules/leaderboard.js";
import { suggestForChat } from "./content/suggest.js";
import { detectAlerts } from "./market/volume.js";
import { approveSuggestion, skipSuggestion, scheduleSuggestion, publishSuggestion } from "./content/approval.js";
import { runScheduler } from "./content/scheduler.js";
import { contentStatsText } from "./content/trail.js";
import { DEFAULT_SIGNAL_OPTIONS } from "./content/signals.js";
import type { ContentSuggestionRow } from "./database/db.js";

/**
 * 🧠 COMMUNITY BRAIN
 * Your community talks. We turn the conversation into intelligence and action.
 * AI_MODE=cloud: AI runs via an OpenAI-compatible API (OpenAI/Groq/OpenRouter/…).
 * AI_MODE=local (default): AI runs locally via Ollama — message text never leaves the host.
 */

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error("❌ BOT_TOKEN missing. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const OWNER_ID = Number(process.env.OWNER_ID ?? 0) || undefined;
const GROUP_ID = process.env.GROUP_ID ? Number(process.env.GROUP_ID) : undefined;
const CHAT_MODEL = process.env.CHAT_MODEL ?? "llama3.2:3b";
const EMBED_MODEL = process.env.EMBED_MODEL ?? "nomic-embed-text";
const DB_PATH = process.env.DB_PATH ?? "./brain.db";
const AI = process.env.AI_MOCK === "1" ? new MockProvider() : makeAi();

function makeAi(): AiProvider {
  if ((process.env.AI_MODE ?? "local").toLowerCase() === "cloud") {
    if (!process.env.OPENAI_API_KEY) {
      console.error("❌ AI_MODE=cloud but OPENAI_API_KEY is missing.");
      process.exit(1);
    }
    if (!process.env.CHAT_MODEL || !process.env.EMBED_MODEL) {
      console.error("❌ AI_MODE=cloud requires CHAT_MODEL and EMBED_MODEL (e.g. gpt-4o-mini / text-embedding-3-small).");
      process.exit(1);
    }
    return new CloudProvider(
      CHAT_MODEL,
      EMBED_MODEL,
      process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      process.env.OPENAI_API_KEY
    );
  }
  return new OllamaProvider(CHAT_MODEL, EMBED_MODEL, process.env.OLLAMA_BASE_URL);
}

const db = new BrainDb(DB_PATH);
const settings = new ChatSettings(db);
const panel = new ConfigPanel(db, settings, {
  sendMessage: (chatId, text, kb) => bot.api.sendMessage(chatId, text, kb ? { reply_markup: kb } : undefined),
  editMessage: (chatId, messageId, text, kb) => bot.api.editMessageText(chatId, messageId, text, kb ? { reply_markup: kb } : undefined),
});

const xpEngine = new XpEngine(db);
const questEngine = new QuestEngine(db, (chatId, userId, xp, reason) => xpEngine.grantXp(chatId, userId, xp, reason));
const memeEngine = new MemeEngine(db, (chatId, userId, xp, reason) => xpEngine.grantXp(chatId, userId, xp, reason));
const badgeEngine = new BadgeEngine(db);
const raidEngine = new RaidEngine(db);

const bot = new Bot(TOKEN);

/** Award any newly-earned milestone badges and announce them in the chat. */
function announceBadges(chatId: number, userId: number): void {
  try {
    const st = xpEngine.getStats(chatId, userId);
    const newly = badgeEngine.checkMilestones(chatId, userId, st);
    if (newly.length > 0) {
      void bot.api
        .sendMessage(chatId, `🏅 Badge${newly.length === 1 ? "" : "s"} unlocked: ${newly.map((b) => `${b.emoji} ${b.name}`).join(" · ")}`)
        .catch(() => {});
    }
  } catch {
    // badges are best-effort; never break the calling flow
  }
}

// ── Permissions (cached) ──────────────────────────────────────────────────

const adminCache = new Map<number, { ids: Set<number>; at: number }>();
const ADMIN_TTL_MS = 5 * 60 * 1000;

async function chatAdminIds(chatId: number): Promise<Set<number>> {
  const hit = adminCache.get(chatId);
  if (hit && Date.now() - hit.at < ADMIN_TTL_MS) return hit.ids;
  try {
    const members = await bot.api.getChatAdministrators(chatId);
    const ids = new Set(members.map((m) => m.user.id));
    adminCache.set(chatId, { ids, at: Date.now() });
    return ids;
  } catch {
    return hit?.ids ?? new Set();
  }
}

async function isAdmin(ctx: { chat?: { id: number }; from?: { id: number } }): Promise<boolean> {
  if (!ctx.from) return false;
  if (OWNER_ID && ctx.from.id === OWNER_ID) return true;
  if (!ctx.chat || ctx.chat.id > 0) return OWNER_ID !== undefined; // private chat: owner only
  const ids = await chatAdminIds(ctx.chat.id);
  return ids.has(ctx.from.id);
}

// ── Helpers ───────────────────────────────────────────────────────────────

function emoji(chatId: number): string {
  return settings.get(chatId).botEmoji;
}

async function maybeAutoCaptureKb(chatId: number, userId: number, text: string): Promise<void> {
  if (text.length < MIN_ADMIN_POST_LEN) return;
  const ids = await chatAdminIds(chatId);
  if (!ids.has(userId)) return;
  // Admins posting substantial text = announcements. Auto-learn, never block the chat.
  learnText(db, AI, chatId, text, "admin_post", userId).catch(() => {});
}

// ── Commands ──────────────────────────────────────────────────────────────

bot.command("start", (ctx) =>
  ctx.reply(
    [
      "🧠 Community Brain",
      "",
      "I give this community memory, intelligence and automation.",
      "",
      "Members:",
      "/ask <question> — ask, answered from official info only",
      "/memory — what the community keeps asking",
      "/rank — your XP, level and streak · /top — leaderboard",
      "/quests — active missions · /meme — meme contests",
      "/badges — your recognition badges · /top — leaderboard",
      "/volume — $token market intelligence · /raid — community raids",
      "",
      "Admins:",
      "/setup — activate the brain in this group",
      "/config — settings panel",
      "/learn <text> — add official info to the knowledge base",
      "/kb — knowledge base entries · /kbdel <id> — remove one",
      "/brain — admin briefing with recommended actions",
      "/stats — quick activity stats",
      "/quest add <name>|<kind>|<target>|<xp> — create a mission",
      "/meme open <title> — start a meme contest",
      "/content — what to post next, grounded in real signals",
      "",
      "I also learn pinned messages and admin announcements automatically.",
    ].join("\n")
  )
);

bot.command("setup", async (ctx) => {
  if (ctx.chat.type === "private") return ctx.reply("Run /setup inside your community group.");
  if (!(await isAdmin(ctx))) return ctx.reply("👑 Admins only.");
  db.registerChat(ctx.chat.id, ctx.chat.title ?? "");
  let note = "✅ Brain activated for this group.";
  try {
    const me = await bot.api.getChatMember(ctx.chat.id, bot.botInfo.id);
    if (me.status === "administrator") {
      note += "\n🛡️ I'm an admin here — message capture works.";
    } else {
      note += "\n⚠️ Promote me to admin (or disable privacy mode in @BotFather) so I can read messages.";
    }
  } catch {
    /* ignore */
  }
  note += "\nNext: /config to tune it, /learn to feed me official info.";
  return ctx.reply(note);
});

bot.command("config", async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply("👑 Admins only.");
  await panel.open(ctx.chat.id);
});

bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data ?? "";
  if (!data.startsWith("cfg:") && !data.startsWith("ct:")) return;
  if (!(await isAdmin(ctx))) {
    await ctx.answerCallbackQuery({ text: "👑 Admins only." });
    return;
  }
  const msg = ctx.callbackQuery.message;
  if (!msg) return;
  if (data.startsWith("ct:")) {
    await handleContentCallback(msg.chat.id, msg.message_id, data);
    await ctx.answerCallbackQuery({ text: "✅ Done" });
    return;
  }
  await panel.handleCallback(msg.chat.id, msg.message_id, data);
  await ctx.answerCallbackQuery({ text: "✅ Updated" });
});

bot.command("ask", async (ctx) => {
  const q = (ctx.match ?? "").trim();
  if (!q) return ctx.reply(`${emoji(ctx.chat.id)} Usage: /ask <question>`);
  const s = settings.get(ctx.chat.id);
  await ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});
  const res = await ask(db, AI, ctx.chat.id, q, s.tone);
  if (res.grounded) db.addInsight(ctx.chat.id, "briefing", JSON.stringify({ kind: "ask", q }));
  return ctx.reply(res.answer);
});

bot.command("reembed", async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply("👑 Admins only.");
  if (process.env.AI_MOCK === "1") return ctx.reply("Mock AI active — nothing to re-embed.");
  await ctx.reply("🔄 Re-embedding the knowledge base for the current AI model… this may take a minute.");
  const chatId = ctx.chat.id;
  const entries = db.listKbEntries(chatId);
  let ok = 0;
  for (const e of entries) {
    const emb = await AI.embed(e.content.slice(0, 4000));
    if (emb.length > 0) {
      db.updateKbEmbedding(e.id, packEmbedding(emb));
      ok++;
    }
  }
  return ctx.reply(`✅ Re-embedded ${ok}/${entries.length} knowledge base entries for “${AI.name}”.`);
});

bot.command("learn", async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply("👑 Admins only.");
  const text = (ctx.match ?? "").trim();
  if (!text) return ctx.reply("Usage: /learn <official info text>");
  const stored = await learnText(db, AI, ctx.chat.id, text, "manual", ctx.from?.id ?? null);
  return ctx.reply(stored > 0 ? `📚 Learned (${stored} chunk${stored === 1 ? "" : "s"}).` : "⚠️ Couldn't embed right now — try again when the AI is up.");
});

bot.command("kb", async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply("👑 Admins only.");
  const entries = db.listKbEntries(ctx.chat.id, true).slice(0, 20);
  if (entries.length === 0) return ctx.reply("📚 Knowledge base is empty. Use /learn or pin a message.");
  return ctx.reply(
    ["📚 KNOWLEDGE BASE", "", ...entries.map((e) => `#${e.id} [${e.source}]${e.enabled ? "" : " (off)"} ${e.content.slice(0, 70)}`)].join("\n")
  );
});

bot.command("kbdel", async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply("👑 Admins only.");
  const id = Number((ctx.match ?? "").trim());
  if (!Number.isFinite(id) || id <= 0) return ctx.reply("Usage: /kbdel <id>  (see /kb)");
  return ctx.reply(db.deleteKbEntry(id, ctx.chat.id) ? "🗑️ Deleted." : "❌ Not found.");
});

bot.command("memory", (ctx) => {
  const memory = communityMemory(db, ctx.chat.id);
  return ctx.reply(memoryText(memory));
});

bot.command("brain", async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply("👑 Admins only.");
  await ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});
  const text = await briefingText(db, AI, ctx.chat.id);
  db.addInsight(ctx.chat.id, "briefing", JSON.stringify({ kind: "brain" }));
  return ctx.reply(text);
});

bot.command("stats", (ctx) => {
  const m = pulseMetrics(db, ctx.chat.id, 1);
  const kb = db.listKbEntries(ctx.chat.id).length;
  return ctx.reply(
    [
      "📊 LAST 24H",
      `👥 Active: ${m.activeUsers}`,
      `💬 Messages: ${m.messages}`,
      `❓ Questions: ${m.questions}`,
      `🧠 Clusters: ${m.openClusters} open · ${m.answeredClusters} answered`,
      `📚 KB entries: ${kb}`,
    ].join("\n")
  );
});

// ── Gamification (XP · quests · memes) ───────────────────────────────────

bot.command("rank", (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  const st = xpEngine.getStats(ctx.chat.id, userId);
  const title = LEVEL_TITLES[Math.min(st.level - 1, LEVEL_TITLES.length - 1)] ?? "";
  return ctx.reply(
    [
      "⭐ YOUR STATS",
      `📊 Level ${st.level} ${title}`,
      `✨ ${st.xp} XP`,
      `🔥 ${st.streak}-day streak`,
      "",
      "Climb the board: /top",
    ].join("\n")
  );
});

bot.command("top", (ctx) => {
  const limit = Math.min(20, Math.max(5, Number((ctx.match ?? "").trim()) || 10));
  return ctx.reply(leaderboardText(topUsers(db, ctx.chat.id, limit)));
});

bot.command("badges", (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  return ctx.reply(badgeEngine.render(ctx.chat.id, userId));
});

bot.command("badge", async (ctx) => {
  const arg = (ctx.match ?? "").trim();
  const [sub, codeOrId, maybeCode] = arg.split(/\s+/);
  if (sub !== "grant")
    return ctx.reply("🏅 /badge grant <code> — reply to a member's message to honor them.\nCodes: " + BADGE_CODES.join(", "));
  const code = (maybeCode ?? codeOrId ?? "").toLowerCase();
  const def = badgeByCode(code);
  if (!def) return ctx.reply(`Unknown badge code. Codes: ${BADGE_CODES.join(", ")}`);

  // Target: replied-to user, or an explicit numeric user id.
  let targetId = ctx.msg?.reply_to_message?.from?.id;
  if (!targetId) {
    const n = Number(codeOrId);
    if (Number.isFinite(n) && n > 0 && maybeCode) targetId = n;
  }
  if (!targetId) return ctx.reply("Reply to a member's message with /badge grant <code> (or /badge grant <userId> <code>).");

  const granted = badgeEngine.grant(ctx.chat.id, targetId, code);
  if (!granted) return ctx.reply(`${def.emoji} ${def.name} is already held by that member.`);
  return ctx.reply(`🏅 Honored: ${granted.emoji} ${granted.name} awarded!`);
});

bot.command("quests", (ctx) => {
  const rows = db.listQuests(ctx.chat.id, "active");
  if (rows.length === 0) return ctx.reply("🎯 No active quests right now. Admins: /quest add");
  const userId = ctx.from?.id ?? 0;
  return ctx.reply(["🎯 ACTIVE QUESTS", "━━━━━━━━━━━━━━━━━━━", ...rows.map((q) => questEngine.progressLine(q, userId))].join("\n"));
});

const QUEST_KINDS: QuestRequirement["kind"][] = ["messages", "reactions", "invites", "meme_submissions", "poll_votes"];

bot.command("quest", async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply("👑 Admins only.");
  const parts = (ctx.match ?? "").split("|").map((p) => p.trim());
  const [name, kind, targetStr, xpStr, hoursStr] = parts;
  if (!name || !kind || !targetStr || !xpStr) {
    return ctx.reply(`Usage: /quest add <name>|<kind>|<target>|<xp> [hours]\nKinds: ${QUEST_KINDS.join(", ")}`);
  }
  if (!(QUEST_KINDS as readonly string[]).includes(kind)) return ctx.reply(`❌ Unknown kind. Kinds: ${QUEST_KINDS.join(", ")}`);
  const target = Number(targetStr);
  const xpReward = Number(xpStr);
  const hours = hoursStr ? Number(hoursStr) : undefined;
  if (!Number.isFinite(target) || target <= 0 || !Number.isFinite(xpReward) || xpReward <= 0) {
    return ctx.reply("❌ Target and XP reward must be positive numbers.");
  }
  if (hours !== undefined && (!Number.isFinite(hours) || hours <= 0)) {
    return ctx.reply("❌ Duration must be a positive number of hours.");
  }
  const id = questEngine.createQuest(
    ctx.chat.id,
    { name, requirement: { kind: kind as QuestRequirement["kind"], target }, xpReward, durationHours: hours },
    ctx.from?.id ?? 0
  );
  return ctx.reply(`🎯 Quest #${id} created: “${name}” — ${kind} ×${target} → ${xpReward} XP${hours ? ` (${hours}h)` : ""}`);
});

bot.command("meme", async (ctx) => {
  const rest = (ctx.match ?? "").trim();
  const [sub, ...restArr] = rest.split(/\s+/);
  const arg = restArr.join(" ").trim();
  const userId = ctx.from?.id;

  switch (sub) {
    case "open": {
      if (!(await isAdmin(ctx))) return ctx.reply("👑 Admins only.");
      const nums = arg.match(/(\d+)\s*$/);
      let title = arg;
      let hours: number | undefined;
      if (nums) {
        hours = Number(nums[1]);
        title = arg.slice(0, nums.index).trim();
      }
      if (!title) return ctx.reply("Usage: /meme open <title> [hours]");
      const id = memeEngine.openContest(ctx.chat.id, title, hours);
      return ctx.reply(`😹 Meme contest #${id} open: “${title}”. Submit with: /meme submit <text or link>`);
    }
    case "submit": {
      if (!arg) return ctx.reply("Usage: /meme submit <text or link>");
      if (!userId) return;
      const latest = db.listMemeContests(ctx.chat.id, "submissions")[0];
      if (!latest) return ctx.reply("No contest is accepting submissions right now.");
      const id = memeEngine.submit(latest.id, userId, ctx.from?.username ?? null, arg);
      if (id === null) return ctx.reply("Submissions are closed for this contest.");
      const done = questEngine.recordEvent(ctx.chat.id, userId, "meme_submissions");
      if (done.length > 0) void ctx.reply(`🎯 Quest complete: ${done.join(", ")}`).catch(() => {});
      announceBadges(ctx.chat.id, userId);
      return ctx.reply(`📤 Submission #${id} received.`);
    }
    case "voting": {
      if (!(await isAdmin(ctx))) return ctx.reply("👑 Admins only.");
      const latest = db.listMemeContests(ctx.chat.id, "submissions")[0];
      if (!latest) return ctx.reply("No contest is in submissions phase.");
      memeEngine.toVoting(latest.id);
      return ctx.reply("🗳️ Voting open — /meme vote <submissionId>");
    }
    case "vote": {
      const sid = Number(arg);
      if (!Number.isFinite(sid) || sid <= 0) return ctx.reply("Usage: /meme vote <submissionId>");
      if (!userId) return;
      const latest = db.listMemeContests(ctx.chat.id, "voting")[0];
      if (!latest) return ctx.reply("No contest is in voting phase.");
      const res = memeEngine.vote(latest.id, userId, sid);
      const msg =
        res === "ok"
          ? "🗳️ Vote counted."
          : res === "own_meme"
            ? "😅 You can't vote for your own meme."
            : res === "already"
              ? "Already voted in this contest."
              : res === "not_found"
                ? "Submission not found."
                : "Voting is not open right now.";
      return ctx.reply(msg);
    }
    case "finish": {
      if (!(await isAdmin(ctx))) return ctx.reply("👑 Admins only.");
      const latest = db.listMemeContests(ctx.chat.id)[0];
      if (!latest) return ctx.reply("No contest found.");
      const winner = memeEngine.finishContest(latest.id);
      if (!winner || winner.votes === 0) return ctx.reply("Contest finished — no submissions, no winner.");
      if (winner.userId) announceBadges(ctx.chat.id, winner.userId);
      return ctx.reply(`🏆 Contest finished! Winner: ${winner.username ?? `#${winner.submissionId}`} with ${winner.votes} vote${winner.votes === 1 ? "" : "s"}.`);
    }
    case "list":
    case "top": {
      const latest = db.listMemeContests(ctx.chat.id)[0];
      if (!latest) return ctx.reply("No contest yet. Admins: /meme open <title>");
      const subs = memeEngine.listSubmissions(latest.id);
      if (subs.length === 0) return ctx.reply(`😹 “${latest.title}” — ${latest.status} — no submissions yet.`);
      return ctx.reply(
        [`😹 “${latest.title}” — ${latest.status}`, "━━━━━━━━━━━━━━━━━━━", ...subs.map((s) => `#${s.id} ${s.username ?? `user${s.user_id}`} — ${s.votes} 🗳️\n${s.content}`)].join("\n")
      );
    }
    default:
      return ctx.reply(
        [
          "😹 MEME CONTESTS",
          "",
          "Admins:",
          "/meme open <title> [hours] — start submissions",
          "/meme voting — close submissions, open voting",
          "/meme finish — crown the winner",
          "",
          "Everyone:",
          "/meme submit <text or link> — enter the contest",
          "/meme vote <submissionId> — give a vote",
          "/meme list — current contest and scores",
        ].join("\n")
      );
  }
});

// ── RaidOS: Volume Intelligence ───────────────────────────────────────────

function marketProviderFor(chatId: number): MarketDataProvider | null {
  const s = settings.get(chatId);
  return providerByName(s.marketProvider) ?? null;
}

async function fetchAndStoreStats(chatId: number): Promise<{ stats: TokenStats; prev: TokenStats | undefined }> {
  const s = settings.get(chatId);
  const provider = marketProviderFor(chatId);
  if (!provider) throw new Error(`unknown provider: ${s.marketProvider}`);
  const stats = await provider.getTokenStats(s.tokenAddress);
  const prev = db.lastMarketSnapshot(chatId);
  const prevStats = prev ? (JSON.parse(prev.payload) as TokenStats) : undefined;
  db.addMarketSnapshot(chatId, JSON.stringify(stats));
  db.pruneMarketSnapshots(chatId, 500);
  return { stats, prev: prevStats };
}

bot.command("volume", async (ctx) => {
  const s = settings.get(ctx.chat.id);
  const parts = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
  const sub = parts[0];

  if (sub === "set") {
    if (!(await isAdmin(ctx))) return ctx.reply("👑 Admins only.");
    const addr = parts[1];
    if (!addr) return ctx.reply(`Usage: /volume set <token address> [symbol] [provider]\nProviders: ${PROVIDER_NAMES.join(", ")}`);
    const symbol = (parts[2] ?? s.tokenSymbol).toUpperCase();
    const provider = parts[3] ?? s.marketProvider;
    if (!providerByName(provider)) return ctx.reply(`❌ Unknown provider “${provider}”. Providers: ${PROVIDER_NAMES.join(", ")}`);
    settings.set(ctx.chat.id, "tokenAddress", addr);
    settings.set(ctx.chat.id, "tokenSymbol", symbol);
    settings.set(ctx.chat.id, "marketProvider", provider);
    return ctx.reply(`📊 Now tracking $${symbol} via ${provider}.\nCheck /volume — and /volume alerts to enable spike/whale alerts.`);
  }
  if (sub === "alerts") {
    if (!(await isAdmin(ctx))) return ctx.reply("👑 Admins only.");
    const on = !s.marketAlerts;
    settings.set(ctx.chat.id, "marketAlerts", on ? "1" : "0");
    return ctx.reply(on ? "🔔 Market alerts ON — volume spikes, price moves and liquidity changes." : "🔕 Market alerts OFF.");
  }

  if (!s.tokenAddress) {
    return ctx.reply("📊 No token tracked yet.\nAdmins: /volume set <token address> [symbol] [provider]");
  }
  try {
    const { stats, prev } = await fetchAndStoreStats(ctx.chat.id);
    return ctx.reply(volumeCard(stats, prev));
  } catch (e) {
    return ctx.reply(`⚠️ Market data unavailable: ${(e as Error).message}`);
  }
});

// ── RaidOS: Raid Engine ─────────────────────────────────────────────────

function raidCard(r: { id: number; title: string; platform: string; target_url: string; objective: number; duration_minutes: number; xp_reward: number; max_participants: number | null }): string {
  return [
    `🚨 RAID ACTIVE — #${r.id} ${r.title}`,
    "━━━━━━━━━━━━━━━━━━━",
    `🎯 Goal: ${r.objective > 0 ? `${r.objective} genuine interactions` : "maximum real engagement"}`,
    `⏱ Duration: ${r.duration_minutes}m`,
    `🎁 Reward: ${r.xp_reward > 0 ? `${r.xp_reward} XP per tracked action` : "glory"}`,
    `🌐 Platform: ${r.platform}`,
    r.target_url ? `🔗 Target: ${r.target_url}` : "",
    r.max_participants !== null ? `👥 Cap: ${r.max_participants} raiders` : "",
    "",
    "Actions: ❤️ Like · 🔁 Repost · 💬 Comment · 👀 Visit",
    "Participation is SELF-REPORTED — /raid in after each action.",
    `Join now: /raid join ${r.id}`,
  ].filter(Boolean).join("\n");
}

bot.command("raid", async (ctx) => {
  const arg = (ctx.match ?? "").trim();
  const [sub, ...restArr] = arg.split(/\s+/);
  const rest = restArr.join(" ").trim();
  const userId = ctx.from?.id;
  const chatId = ctx.chat.id;

  switch (sub) {
    case "create": {
      if (!(await isAdmin(ctx))) return ctx.reply("👑 Admins only.");
      const p = rest.split("|").map((x) => x.trim());
      if (p.length < 6)
        return ctx.reply('Usage: /raid create <title> | <platform> | <url> | <30m|2h> | <objective> | <100XP> [maxParticipants]');
      const [title, platform, url, durSpec, objSpec, xpSpec, maxSpec] = p as [string, string, string, string, string, string, string | undefined];
      const duration = parseDuration(durSpec ?? "");
      if (!duration) return ctx.reply("❌ Duration must look like 30m or 2h.");
      if (!RAID_PLATFORMS.includes((platform ?? "").toLowerCase() as never))
        return ctx.reply(`❌ Platform must be one of: ${RAID_PLATFORMS.join(", ")}`);
      const objective = Number(objSpec) || 0;
      const xpReward = Number((xpSpec ?? "").replace(/xp/i, "")) || 0;
      const max = maxSpec && Number(maxSpec) > 0 ? Number(maxSpec) : null;
      const id = raidEngine.createRaid({
        chatId,
        title,
        platform: platform.toLowerCase(),
        targetUrl: url,
        objective,
        durationMinutes: duration,
        xpReward,
        maxParticipants: max,
        createdBy: userId ?? null,
      });
      const r = db.getRaid(id)!;
      await ctx.reply(raidCard(r));
      // Auto-announce so the whole group sees it.
      return;
    }
    case "join": {
      const id = Number(restArr[0]);
      if (!userId || !Number.isFinite(id)) return ctx.reply("Usage: /raid join <id>");
      const res = raidEngine.join(id, userId, ctx.from?.username ?? null, chatId);
      if (res === "ok") {
        const r = db.getRaid(id);
        // Quest integration: each raid joined counts as a "raids" event.
        const done = questEngine.recordEvent(chatId, userId, "raids");
        if (done.length > 0) void ctx.reply(`🎯 Quest complete: ${done.join(", ")}`).catch(() => {});
        return ctx.reply(`⚡ You're in${r ? ` — raid #${id} “${r.title}”` : ""}! Do the actions, then /raid in ${id} after each one.`);
      }
      const msg = res === "already" ? "You already joined this raid." : res === "full" ? "Raid is full." : "That raid is closed.";
      return ctx.reply(msg);
    }
    case "in":
    case "checkin": {
      const id = Number(restArr[0]);
      if (!userId || !Number.isFinite(id)) return ctx.reply("Usage: /raid in <id>");
      const res = raidEngine.checkin(id, userId, chatId);
      if (res.status === "ok") {
        announceBadges(chatId, userId);
        return ctx.reply(`✅ Action tracked (SELF-REPORTED) — +${res.xp} XP · ${res.checkins} actions · ${res.totalXp} XP total in this raid.`);
      }
      const msg =
        res.status === "cooldown"
          ? `⏳ Too soon — next action counts in ${Math.ceil((res.waitSeconds ?? 0) / 60)}m.`
          : res.status === "checkin_cap"
            ? "You reached the action cap for this raid. 🙏"
            : res.status === "daily_cap"
              ? "You hit today's raid XP cap — come back tomorrow."
              : res.status === "raid_closed"
                ? "That raid is closed."
                : "Join the raid first: /raid join <id>";
      return ctx.reply(msg);
    }
    case "score": {
      const id = Number(restArr[0]);
      if (!Number.isFinite(id)) {
        const latest = db.listRaids(chatId, "active")[0] ?? db.listRaids(chatId)[0];
        if (!latest) return ctx.reply("No raids yet. Admins: /raid create");
        const sc = raidEngine.score(latest.id, chatId);
        return sc ? ctx.reply(raidScoreText(sc)) : ctx.reply("No score available.");
      }
      const sc = raidEngine.score(id, chatId);
      return sc ? ctx.reply(raidScoreText(sc)) : ctx.reply("Raid not found.");
    }
    case "end": {
      if (!(await isAdmin(ctx))) return ctx.reply("👑 Admins only.");
      const id = Number(restArr[0]) || db.listRaids(chatId, "active")[0]?.id;
      if (!id) return ctx.reply("No active raid to end.");
      const out = raidEngine.finish(id, chatId);
      if (!out) return ctx.reply("Raid not found or already finished.");
      const lines = ["🏁 RAID FINISHED", `#${id} ${db.getRaid(id)?.title ?? ""}`, "", raidScoreText(out.score)];
      if (out.top) lines.push("", `🥇 Top raider: ${out.top.username ? "@" + out.top.username : `user${out.top.user_id}`} — ${out.top.checkins} actions`);
      lines.push("", "All XP was granted live per action (SELF-REPORTED tracking).");
      await ctx.reply(lines.join("\n"));
      // Post-raid intelligence: measured window comparison + one AI narrative.
      try {
        const r = db.getRaid(id);
        if (r) {
          const analytics = raidAnalytics(db, r);
          const narrative = await raidAnalyticsNarrative(AI, analytics).catch(() => "");
          return ctx.reply(raidAnalyticsText(analytics) + (narrative ? `\n\n🧠 ${narrative}` : ""));
        }
      } catch {
        // analytics are best-effort; the finish report already went out
      }
      return;
    }
    case "top": {
      const rows = db.raidRanking(chatId, 10);
      if (rows.length === 0) return ctx.reply("🏆 No raiders yet. Join a raid with /raid join <id>!");
      const medals = ["🥇", "🥈", "🥉"];
      return ctx.reply([
        "🏆 RAIDERS",
        "━━━━━━━━━━━━━━━━━━━",
        ...rows.map((r, i) => `${medals[i] ?? `${i + 1}.`} ${r.username ? "@" + r.username : `user${r.user_id}`} — ${r.raids} raid${r.raids === 1 ? "" : "s"} · ${r.checkins} actions · ${r.xp ?? 0} XP`),
      ].join("\n"));
    }
    case "list": {
      const active = db.listRaids(chatId, "active");
      if (active.length === 0) return ctx.reply("No active raids. Admins: /raid create");
      return ctx.reply(["🚨 ACTIVE RAIDS", "━━━━━━━━━━━━━━━━━━━", ...active.map((r) => raidEngine.statusLine(r))].join("\n"));
    }
    default:
      return ctx.reply(
        [
          "⚡ RAID ENGINE",
          "",
          "Admins:",
          "/raid create <title> | <platform> | <url> | <30m|2h> | <objective> | <100XP> [max]",
          "/raid end [id] — close the raid and show the report",
          "/raid list — active raids",
          "",
          "Everyone:",
          "/raid join <id> — join the raid",
          "/raid in <id> — track one completed action (SELF-REPORTED)",
          "/raid score [id] — live raid score",
          "/raid top — community raider leaderboard",
        ].join("\n")
      );
  }
});

// ── RaidOS: Content Engine ────────────────────────────────────────────────

async function postContent(chatId: number, text: string): Promise<boolean> {
  try {
    await bot.api.sendMessage(chatId, text);
    return true;
  } catch {
    return false;
  }
}

function suggestionKeyboard(id: number): { inline_keyboard: { text: string; callback_data: string }[][] } {
  return {
    inline_keyboard: [
      [
        { text: "✅ Approve", callback_data: `ct:approve:${id}` },
        { text: "⏭ Skip", callback_data: `ct:skip:${id}` },
        { text: "🕐 Schedule 1h", callback_data: `ct:schedule:${id}:60` },
      ],
      [{ text: "📣 Publish now", callback_data: `ct:publish:${id}` }],
    ],
  };
}

async function handleContentCallback(chatId: number, messageId: number, data: string): Promise<void> {
  const [, action, idStr, arg] = data.split(":");
  const id = Number(idStr);
  if (!Number.isFinite(id)) return;
  switch (action) {
    case "approve": {
      const res = approveSuggestion(db, id, undefined, chatId);
      const note = res.ok ? `✅ Suggestion #${id} approved. /content publish ${id} to post it.` : `❌ Suggestion #${id}: ${res.reason}.`;
      await bot.api.editMessageText(chatId, messageId, note).catch(() => {});
      break;
    }
    case "skip": {
      const res = skipSuggestion(db, id, chatId);
      const note = res.ok ? `⏭ Suggestion #${id} skipped.` : `❌ Suggestion #${id}: ${res.reason}.`;
      await bot.api.editMessageText(chatId, messageId, note).catch(() => {});
      break;
    }
    case "schedule": {
      const minutes = Number(arg) || 60;
      const res = scheduleSuggestion(db, id, Math.floor(Date.now() / 1000) + minutes * 60, "group", chatId);
      const note = res.ok ? `🕐 Suggestion #${id} scheduled — publishing in ${minutes}m.` : `❌ Suggestion #${id}: ${res.reason}.`;
      await bot.api.editMessageText(chatId, messageId, note).catch(() => {});
      break;
    }
    case "publish": {
      const res = await publishSuggestion(db, id, postContent, undefined, chatId);
      const note = res.ok ? `📣 Suggestion #${id} published.` : `❌ Suggestion #${id}: ${res.reason}.`;
      await bot.api.editMessageText(chatId, messageId, note).catch(() => {});
      break;
    }
    default:
      break;
  }
}

bot.command("content", async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply("👑 Admins only.");
  const parts = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
  const sub = parts[0] ?? "";
  const chatId = ctx.chat.id;

  if (sub === "suggest") {
    const s = settings.get(chatId);
    if (!s.contentEnabled) return ctx.reply("🔕 Content engine is off for this chat. Enable it with /content on.");
    let marketKinds: string[] = [];
    let stats: TokenStats | null = null;
    try {
      const r = await fetchAndStoreStats(chatId);
      stats = r.stats;
      // Re-detect alerts from the fresh snapshot vs baseline — honest, same rules as the poller.
      marketKinds = r.prev ? detectAlerts(r.stats, r.prev).map((a) => a.kind) : [];
    } catch {
      stats = null; // market unavailable — suggestions continue without it
    }
    const { proposals } = suggestForChat(db, chatId, marketKinds, stats);
    if (proposals.length === 0) {
      return ctx.reply("💡 No grounded suggestions right now — the engine only proposes when there is a real signal.");
    }
    for (const p of proposals) {
      const text = [`💡 Based on: ${p.signalDetail}`, "", p.text].join("\n");
      await ctx.reply(text, { reply_markup: suggestionKeyboard(p.id) }).catch(() => {});
    }
    return;
  }

  if (sub === "on" || sub === "off") {
    const on = sub === "on";
    settings.set(chatId, "contentEnabled", on ? "1" : "0");
    return ctx.reply(on ? "💡 Content engine ON — /content suggest proposes data-grounded posts." : "🔕 Content engine OFF.");
  }

  if (sub === "autopublish" || sub === "auto") {
    const on = !settings.get(chatId).contentAutoPublish;
    settings.set(chatId, "contentAutoPublish", on ? "1" : "0");
    return ctx.reply(on ? "🤖 Auto-publish ON — approved signals post automatically (cooldowns still apply)." : "🤖 Auto-publish OFF — every post needs manual approval.");
  }

  if (sub === "publish") {
    const id = Number(parts[1]);
    if (!Number.isFinite(id)) return ctx.reply("Usage: /content publish <id>");
    const res = await publishSuggestion(db, id, postContent, undefined, chatId);
    if (res.ok) return ctx.reply("📣 Published.");
    return ctx.reply(res.reason === "not_found" ? `❌ Suggestion #${id} not found.` : res.reason === "send_failed" ? "⚠️ Couldn't send the message — check my permissions and try again." : `❌ Suggestion #${id}: ${res.reason}.`);
  }

  if (sub === "skip") {
    const id = Number(parts[1]);
    if (!Number.isFinite(id)) return ctx.reply("Usage: /content skip <id>");
    const res = skipSuggestion(db, id, chatId);
    return ctx.reply(res.ok ? "⏭ Skipped." : `❌ ${res.reason}.`);
  }

  if (sub === "stats") {
    return ctx.reply(contentStatsText(db, chatId));
  }

  return ctx.reply(
    [
      "📝 CONTENT ENGINE",
      "",
      "Your brain tells you what to post — grounded in measured signals only.",
      "",
      "/content suggest — propose 0–3 posts from live signals",
      "/content publish <id> — publish an approved suggestion",
      "/content skip <id> — dismiss a suggestion",
      "/content stats — what was published and how it performed",
      "/content on | off — enable the engine for this chat",
      "/content autopublish — toggle auto-publish (opt-in)",
      "",
      "Every post is traceable to the signal that produced it — no invented numbers, no fabricated hype.",
    ].join("\n")
  );
});

// ── Group listeners ───────────────────────────────────────────────────────

bot.on("message:new_chat_members", async (ctx) => {
  if (ctx.chat.type === "private") return;
  db.registerChat(ctx.chat.id, ctx.chat.title ?? "");
  const inviterId = ctx.from?.id;
  for (const member of ctx.message.new_chat_members) {
    if (member.id === bot.botInfo.id) {
      await ctx.reply("🧠 Community Brain reporting for duty. Run /setup to activate me.");
    } else {
      await ctx.reply(`👋 Welcome ${member.first_name}! Try /ask — I know the community's official answers.`).catch(() => {});
      // Someone actually brought this member in (not a self-join via link).
      if (inviterId && inviterId !== member.id && settings.get(ctx.chat.id).brainEnabled) {
        const done = questEngine.recordEvent(ctx.chat.id, inviterId, "invites");
        if (done.length > 0) await ctx.reply(`🎯 Quest complete: ${done.join(", ")}`).catch(() => {});
        announceBadges(ctx.chat.id, inviterId);
      }
    }
  }
});

bot.on("message:new_chat_members", (ctx) => {
  if (ctx.chat.type === "private") return;
  const added = ctx.message.new_chat_members?.length ?? 0;
  if (added > 0) db.addMemberJoins(ctx.chat.id, added);
});

bot.on("message_reaction", (ctx) => {
  if (ctx.chat.type === "private") return;
  if (!settings.get(ctx.chat.id).brainEnabled) return;
  const userId = ctx.messageReaction?.user?.id;
  if (!userId) return;
  const done = questEngine.recordEvent(ctx.chat.id, userId, "reactions");
  if (done.length > 0) void ctx.reply(`🎯 Quest complete: ${done.join(", ")}`).catch(() => {});
  announceBadges(ctx.chat.id, userId);
});

bot.on("message:pinned_message", async (ctx) => {
  if (ctx.chat.type === "private") return;
  if (!(await isAdmin(ctx))) return;
  const pinned = ctx.message.pinned_message as { text?: string; caption?: string } | undefined;
  const text = pinned?.text ?? pinned?.caption ?? "";
  if (!text) return;
  const emb = await AI.embed(text.slice(0, 800));
  if (emb.length === 0) return;
  db.replacePinnedEntry(ctx.chat.id, text.replace(/\s+/g, " ").slice(0, 1000), packEmbedding(emb));
  await ctx.reply("📌 Pinned message saved to the knowledge base.").catch(() => {});
});

bot.on("message:text", async (ctx) => {
  if (ctx.chat.type === "private") return;
  if (GROUP_ID && ctx.chat.id !== GROUP_ID) return;
  const text = ctx.message.text;
  if (text.startsWith("/")) return; // commands don't feed the memory
  const chatId = ctx.chat.id;
  const userId = ctx.from?.id ?? null;
  const q = isQuestion(text);

  // 1) Hot path: pure insert. No AI here, ever.
  db.addMessage(chatId, userId, text, q);
  if (db.getChat(chatId)) {
    void maybeAutoCaptureKb(chatId, userId ?? 0, text).catch(() => {});
  }

  // 2) Gamification: XP + quest progress. Cheap SQL only.
  if (userId && settings.get(chatId).brainEnabled) {
    if (ctx.from?.username) db.setXpUsername(chatId, userId, ctx.from.username);
    xpEngine.recordMessage(chatId, userId, text, q);
    const done = questEngine.recordEvent(chatId, userId, "messages");
    if (done.length > 0) void ctx.reply(`🎯 Quest complete: ${done.join(", ")}`).catch(() => {});
    announceBadges(chatId, userId);
  }
});

// ── Background jobs ───────────────────────────────────────────────────────

async function postAlert(chatId: number, text: string): Promise<boolean> {
  const dest = settings.get(chatId).alertDestination;
  const target = dest === "owner" ? OWNER_ID : chatId;
  if (!target) return false;
  try {
    await bot.api.sendMessage(target, text);
    db.addInsight(chatId, "confusion", JSON.stringify({ text }));
    return true;
  } catch {
    return false;
  }
}

function analyzerDeps() {
  return {
    db,
    ai: AI,
    postAlert,
    getSetting: (chatId: number, key: string) => {
      const s = settings.get(chatId) as unknown as Record<string, unknown>;
      return String(s[key] ?? "");
    },
    isActive: (chatId: number) => settings.get(chatId).brainEnabled,
  };
}

async function analyzerCycle(): Promise<void> {
  for (const chat of db.listChats()) {
    if (!settings.get(chat.chat_id).brainEnabled) continue;
    const s = settings.get(chat.chat_id);
    const opts = {
      ...DEFAULT_ANALYZER_OPTIONS,
      similarityThreshold: s.clusterSimilarity,
      alertThreshold: s.alertThreshold,
      alertWindowHours: s.alertWindowHours,
    };
    try {
      const r = await analyzeChat(analyzerDeps(), chat.chat_id, opts);
      if (r.embedded > 0 || r.promoted > 0) {
        console.log(`🧠 analyzer chat=${chat.chat_id} embedded=${r.embedded} promoted=${r.promoted} alerts=${r.alerts}`);
      }
      db.purgeExpiredMessages(chat.chat_id, s.retentionDays);
    } catch (err) {
      console.error("analyzer cycle failed:", err);
    }
  }
}

let lastPulseDay = "";
async function pulseCheck(): Promise<void> {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  for (const chat of db.listChats()) {
    const s = settings.get(chat.chat_id);
    if (!s.pulseEnabled || !s.brainEnabled) continue;
    if (now.getUTCDay() !== s.pulseDay || now.getUTCHours() !== s.pulseHour) continue;
    if (lastPulseDay === `${chat.chat_id}:${day}`) continue;
    lastPulseDay = `${chat.chat_id}:${day}`;
    const metrics = pulseMetrics(db, chat.chat_id, 7);
    const narrative = await pulseNarrative(AI, metrics);
    try {
      await bot.api.sendMessage(chat.chat_id, pulseText(metrics, narrative));
      db.addInsight(chat.chat_id, "pulse", JSON.stringify(metrics));
    } catch {
      /* group may be gone; ignore */
    }
  }
}

async function contentCycle(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  // Scheduling is database-wide; run it once even when no chat currently has
  // auto-publish enabled. The scheduler validates each job's owning chat.
  const run = await runScheduler({ db, post: postContent });
  if (run.published > 0 || run.failed > 0) console.log(`📝 scheduler published=${run.published} failed=${run.failed}`);

  for (const chat of db.listChats()) {
    const s = settings.get(chat.chat_id);
    if (!s.contentEnabled || !s.brainEnabled) continue;
    try {
      if (!s.contentAutoPublish) continue;
      let stats: TokenStats | null = null;
      try {
        stats = (await fetchAndStoreStats(chat.chat_id)).stats;
      } catch {
        stats = null;
      }
      const { proposals } = suggestForChat(db, chat.chat_id, [], stats, DEFAULT_SIGNAL_OPTIONS, now);
      // Auto-publish: approve + schedule immediately (cooldowns already filtered).
      for (const p of proposals) {
        approveSuggestion(db, p.id, undefined, chat.chat_id);
        scheduleSuggestion(db, p.id, now, "group", chat.chat_id);
      }
      if (proposals.length > 0) {
        console.log(`📝 auto-publish chat=${chat.chat_id} scheduled=${proposals.length}`);
      }
    } catch (err) {
      console.error("content cycle failed:", err);
    }
  }
}

async function marketCycle(): Promise<void> {
  for (const chat of db.listChats()) {
    const s = settings.get(chat.chat_id);
    if (!s.marketAlerts || !s.tokenAddress) continue;
    try {
      const { stats, prev } = await fetchAndStoreStats(chat.chat_id);
      if (!prev) continue; // need a baseline before alerting
      const alerts = detectAlerts(stats, prev);
      const kinds = alerts.map((a) => a.kind);
      // Unified momentum: when market AND measured social signals fire together,
      // one combined alert replaces the separate market-only one.
      const unified = unifiedMomentumAlert(db, chat.chat_id, stats, kinds);
      if (unified) {
        await bot.api.sendMessage(chat.chat_id, unified.text).catch(() => {});
        db.addInsight(chat.chat_id, "pulse", JSON.stringify({ market: kinds, momentum: unified.signals.map((x) => x.kind) }));
        continue;
      }
      for (const alert of alerts) {
        await bot.api.sendMessage(chat.chat_id, alert.text).catch(() => {});
        db.addInsight(chat.chat_id, "pulse", JSON.stringify({ market: alert.kind }));
      }
    } catch {
      // provider down or token gone; silently skip this cycle
    }
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────

bot.catch((err) => console.error("Bot error:", err.error));

async function main(): Promise<void> {
  await bot.init();
  console.log(`🧠 Community Brain online as @${bot.botInfo.username}`);
  console.log(`   AI: ${AI.name} (embed: ${EMBED_MODEL}) · mode=${process.env.AI_MOCK === "1" ? "mock" : (process.env.AI_MODE ?? "local")}`);
  console.log(`   Owner: ${OWNER_ID ?? "(not set)"} · DB: ${DB_PATH}`);

  setInterval(() => void analyzerCycle(), DEFAULT_ANALYZER_OPTIONS.cycleMs).unref?.();
  setInterval(() => void pulseCheck(), 10 * 60 * 1000).unref?.();
  setInterval(() => void marketCycle(), 5 * 60 * 1000).unref?.();
  setInterval(() => void contentCycle(), 5 * 60 * 1000).unref?.();

  void bot.start();
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`\n${sig} — shutting down.`);
    void bot.stop().then(() => {
      db.close();
      process.exit(0);
    });
  });
}

main();
