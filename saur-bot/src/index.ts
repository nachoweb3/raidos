import "dotenv/config";
import { Bot, type Filter } from "grammy";
import { SaurDb, type PhraseRow } from "./db.js";
import { seedIfEmpty } from "./seed.js";
import { Config } from "./config.js";
import { HypeEngine } from "./hype.js";
import { PriceWatcher } from "./price.js";
import { AiEngine, chainContextFor } from "./ai.js";
import { SmartReplies } from "./replies.js";
import { AdminPanel } from "./admin.js";

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error("❌ BOT_TOKEN missing. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const ADMIN_IDS = (process.env.ADMIN_IDS ?? "")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n !== 0);
const GROUP_ID = process.env.GROUP_ID ? Number(process.env.GROUP_ID) : undefined;

const db = new SaurDb(process.env.DB_PATH ?? "./saur.db");
seedIfEmpty(db);
const config = new Config(db, ADMIN_IDS, GROUP_ID);

// 📈 The token CA drives everything: ticker in hype posts, /price, periodic updates.
const CONTRACT = process.env.SAUR_CONTRACT ?? "BX2JAgGZJ4HjEHwVdPjna7hYseoVL3djfFMKRLy8pump";
const price = new PriceWatcher(CONTRACT, 60);
const ai = new AiEngine(process.env.AI_OLLAMA_MODEL ?? "llama3.2:3b");
// Keep the engine's model in sync with the admin panel selection.
let lastAiModel = ai.getModel();
setInterval(() => {
  const m = config.get().aiModel;
  if (m !== lastAiModel) {
    ai.setModel(m);
    lastAiModel = m;
    console.log(`🧠 AI model switched to ${m}`);
  }
}, 5000).unref?.();

const bot = new Bot(TOKEN);

// ── Message plumbing ──────────────────────────────────────────────────────

async function postToGroup(text: string): Promise<void> {
  const gid = config.get().groupId;
  if (!gid) {
    console.log("📢 (no GROUP_ID set) would post:", text.split("\n")[0]);
    return;
  }
  await bot.api.sendMessage(gid, text);
}

const hype = new HypeEngine(db, config, postToGroup, price, ai);

const replies = new SmartReplies(db, config, async (chatId: number, text: string) => {
  await bot.api.sendMessage(chatId, text).catch(() => {});
});

const admin = new AdminPanel(db, config, {
  sendMessage: (chatId: number, text: string, kb?: any) =>
    bot.api.sendMessage(chatId, text, kb ? { reply_markup: kb } : undefined),
  editMessage: (chatId: number, messageId: number, text: string, kb?: any) =>
    bot.api.editMessageText(chatId, messageId, text, kb ? { reply_markup: kb } : undefined),
  answerCallback: async (id: string) => {
    await bot.api.answerCallbackQuery(id);
  },
});

// ── Commands ──────────────────────────────────────────────────────────────

const LINKS = {
  contract: CONTRACT,
  website: process.env.SAUR_WEBSITE ?? "https://inusaur.example",
  twitter: process.env.SAUR_TWITTER ?? "https://x.com/inusaur_saur",
  chart: process.env.SAUR_CHART ?? "Chart link coming with launch",
};

bot.command("start", (ctx) => {
  db.trackCommand("/start", ctx.from?.id);
  return ctx.reply(
    [
      "🦖 Welcome to the SAUR community!",
      "",
      "$SAUR is the dinosaur-powered Inu meme. Early is a strategy.",
      "",
      "Commands:",
      "/saur — what is $SAUR",
      "/price — live on-chain stats",
      "/ath — session all-time high",
      "/trend — 2h trend direction",
      "/pressure — buy/sell pressure",
      "/mooning — 24h move summary",
      "/graph — ASCII price sparkline (last ~2h)",
      "/predict — the AI oracle calls the move",
      "/contract — contract address",
      "/chart — price chart",
      "/website — official site",
      "/twitter — X / Twitter",
      "/community — how to get involved",
      "/lore — the origin story",
      "/roadmap — what's next",
      "/ai — ask the local AI anything about $SAUR",
    ].join("\n")
  );
});

bot.command("price", async (ctx) => {
  db.trackCommand("/price", ctx.from?.id);
  await ctx.reply(await price.reportLine());
});

bot.command("ath", async (ctx) => {
  db.trackCommand("/ath", ctx.from?.id);
  const ath = price.getAth();
  if (ath.price === 0) return ctx.reply("🏆 Session ATH not recorded yet — give me a few minutes of data.");
  const ago = Math.round((Date.now() - ath.at) / 60000);
  return ctx.reply(
    `🏆 Session ATH: ${ath.price < 0.01 ? "$" + ath.price.toFixed(8) : PriceWatcher.fmtUsd(ath.price)}\n⏱️ ${ago < 60 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`}\n\n🦖 They cloned the dog. They never cloned the SAUR.`
  );
});

bot.command("trend", async (ctx) => {
  db.trackCommand("/trend", ctx.from?.id);
  const t = price.trend();
  const icon = t === "pumping" ? "🚀" : t === "dumping" ? "📉" : "➡️";
  const boot = price.changeSinceBoot();
  const lines = [
    `🧭 $SAUR trend (last ~2h): ${icon} ${t.toUpperCase()}`,
  ];
  if (boot !== null) lines.push(`🤖 Since bot boot: ${PriceWatcher.fmtPct(boot)}`);
  lines.push(t === "pumping" ? "🦖 The roar is building. Stay close." : t === "dumping" ? "💎 The SAUR doesn't chase. It waits." : "👀 Quiet phases build loud stories.");
  return ctx.reply(lines.join("\n"));
});

bot.command("pressure", async (ctx) => {
  db.trackCommand("/pressure", ctx.from?.id);
  const p = price.buyPressure();
  const bar = "█".repeat(Math.round(p * 10)).padEnd(10, "░");
  const verdict = p >= 0.65 ? "🟢 Bulls in control" : p <= 0.35 ? "🔴 Bears pressing — accumulation zone?" : "⚪ Even fight";
  return ctx.reply(`⚔️ 1h buy pressure\n🟢${bar}🔴 ${(p * 100).toFixed(0)}% buys\n\n${verdict}`);
});

bot.command("mooning", async (ctx) => {
  db.trackCommand("/mooning", ctx.from?.id);
  const s = await price.getStats();
  if (!s) return ctx.reply("📊 No data right now.");
  const e = s.priceChange24h >= 0 ? "🚀" : "🩸";
  return ctx.reply(
    `${e} $SAUR 24h: ${PriceWatcher.fmtPct(s.priceChange24h)}\n1h: ${PriceWatcher.fmtPct(s.priceChange1h)} · 5m: ${PriceWatcher.fmtPct(s.priceChange5m)}\n💎 ${PriceWatcher.fmtUsd(s.marketCap)} MC · Vol ${PriceWatcher.fmtUsd(s.volume24h)}`
  );
});

bot.command(["graph", "grafico"], async (ctx) => {
  db.trackCommand("/graph", ctx.from?.id);
  await price.getStats(); // ensure a fresh datapoint lands in history
  const line = price.sparkline();
  if (!line) return ctx.reply("📈 Not enough data yet — give me a few minutes of history.");
  const t = price.trend();
  const icon = t === "pumping" ? "🚀" : t === "dumping" ? "📉" : "➡️";
  return ctx.reply(`📈 $SAUR (last ~2h) ${icon}\n▔▔▔▔▔▔▔▔▔▔▔▔▔\n${line}`);
});

bot.command(["predict", "predice"], async (ctx) => {
  db.trackCommand("/predict", ctx.from?.id);
  await ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});
  const ctxData = await chainContextFor(price);
  const trend = price.trend();
  const pressure = price.buyPressure();
  const extra = [
    `2h trend: ${trend}`,
    `1h buy pressure: ${(pressure * 100).toFixed(0)}% buys`,
  ].join("\n");
  const out = await ai.reply(
    [
      "Act as the SAUR ORACLE: using the data below, playfully predict what might happen in the next few hours.",
      "Rules: 2-3 lines, in English, mystical but funny style 🦖🔮, quote numbers ONLY from the real data,",
      "end with a one-word verdict: 🚀 LIFTOFF / ➡️ SIDEWAYS / 🩸 CORRECTION.",
      "Make clear with humor that this is a meme oracle, not financial advice.",
      "",
      extra,
    ].join("\n"),
    ctxData
  );
  if (!out) return ctx.reply("🔮 The oracle is asleep (Ollama not responding). Try again later.");
  return ctx.reply(out);
});

bot.command("ai", async (ctx) => {
  db.trackCommand("/ai", ctx.from?.id);
  const q = ctx.message?.text.replace(/^\/ai(@\S+)?\s*/, "").trim();
  if (!q) {
    return ctx.reply("🤖 Usage: /ai <question>\nAsk me anything about $SAUR — I answer with live on-chain data.");
  }
  await ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});
  const out = await ai.reply(q, await chainContextFor(price));
  if (!out) return ctx.reply("🤖 Local AI is asleep (Ollama unreachable or model busy). Try again in a moment.");
  return ctx.reply(out);
});

bot.command("saur", (ctx) => {
  db.trackCommand("/saur", ctx.from?.id);
  return ctx.reply(
    "🦖 $SAUR is the dinosaur-powered Inu meme.\nINU + SAUR. One meme. One community. One mission.\nIf you're early, you're early. 👀"
  );
});

bot.command("contract", (ctx) => {
  db.trackCommand("/contract", ctx.from?.id);
  return ctx.reply(`📜 Contract:\n${LINKS.contract}\n\nAlways verify links — admins never DM first.`);
});

bot.command("chart", (ctx) => {
  db.trackCommand("/chart", ctx.from?.id);
  return ctx.reply(`📈 Chart: ${LINKS.chart}`);
});

bot.command("website", (ctx) => {
  db.trackCommand("/website", ctx.from?.id);
  return ctx.reply(`🌐 Website: ${LINKS.website}`);
});

bot.command("twitter", (ctx) => {
  db.trackCommand("/twitter", ctx.from?.id);
  return ctx.reply(`🐦 Follow the official account: ${LINKS.twitter}`);
});

bot.command("community", (ctx) => {
  db.trackCommand("/community", ctx.from?.id);
  return ctx.reply(
    "🦖 Get involved:\n• Meme it, share it, tag it\n• Bring friends who like dinosaurs\n• Stay loud on X\n\nStrong communities aren't built overnight. Neither are legends. 💎"
  );
});

bot.command("lore", (ctx) => {
  db.trackCommand("/lore", ctx.from?.id);
  return ctx.reply(
    "🧠 THE LORE\nLong before the chart, there was the roar.\nA dinosaur and a dog walked into the metaverse. Only one left a legend.\nThey cloned the dog. They never cloned the SAUR."
  );
});

bot.command("roadmap", (ctx) => {
  db.trackCommand("/roadmap", ctx.from?.id);
  return ctx.reply(
    [
      "🗺️ $SAUR ROADMAP",
      "",
      "Phase 1 — PRE-LAUNCH: community forms, lore spreads 👀",
      "Phase 2 — LAUNCH: the SAUR arrives 🚨",
      "Phase 3 — COMMUNITY: memes, raids, engagement 🔥",
      "Phase 4 — BEYOND: the story writes itself 🚀",
    ].join("\n")
  );
});

// ── Admin commands ────────────────────────────────────────────────────────

bot.command("admin", async (ctx) => {
  db.trackCommand("/admin", ctx.from?.id);
  if (!ctx.from || !config.isAdmin(ctx.from.id)) {
    return ctx.reply("👑 Admins only.");
  }
  await admin.open(ctx.chat.id);
});

bot.callbackQuery(/^adm:/, async (ctx) => {
  const cb = ctx.callbackQuery;
  if (!cb.message || !cb.from) return;
  await admin.handleCallback(
    cb.message.chat.id,
    cb.message.message_id,
    cb.from.id,
    cb.data ?? "",
    async (text) => {
      await bot.api.answerCallbackQuery(cb.id, text ? { text } : undefined);
    }
  );
});

bot.command("addphrase", async (ctx) => {
  db.trackCommand("/addphrase", ctx.from?.id);
  if (!ctx.from || !config.isAdmin(ctx.from.id)) return ctx.reply("👑 Admins only.");
  // /addphrase [category] text...
  const parts = (ctx.match ?? "").trim().split(/\s+/);
  const categories = ["bullish", "community", "fomo", "momentum", "lore", "hold"];
  let category = "community";
  let text = ctx.match ?? "";
  if (parts.length >= 2 && categories.includes(parts[0].toLowerCase())) {
    category = parts[0].toLowerCase();
    text = parts.slice(1).join(" ");
  }
  if (!text) {
    return ctx.reply("Usage: /addphrase [bullish|community|fomo|momentum|lore|hold] <text>");
  }
  const id = db.addPhrase(text, category);
  return ctx.reply(`✅ Phrase #${id} added to "${category}".`);
});

bot.command("phrases", async (ctx) => {
  db.trackCommand("/phrases", ctx.from?.id);
  if (!ctx.from || !config.isAdmin(ctx.from.id)) return ctx.reply("👑 Admins only.");
  const category = (ctx.match ?? "").trim() || undefined;
  const list = category ? db.listPhrases(category) : db.listAllPhrases();
  if (list.length === 0) return ctx.reply("No phrases found.");
  const lines = list.slice(0, 30).map(
    (p: PhraseRow) => `#${p.id} [${p.category}]${p.enabled ? "" : " (off)"} ${p.text.slice(0, 60)}`
  );
  return ctx.reply(lines.join("\n"));
});

bot.command("togglephrase", async (ctx) => {
  if (!ctx.from || !config.isAdmin(ctx.from.id)) return ctx.reply("👑 Admins only.");
  const id = Number((ctx.match ?? "").trim());
  if (!Number.isFinite(id) || id <= 0) return ctx.reply("Usage: /togglephrase <id>");
  return ctx.reply(db.togglePhrase(id) ? "✅ Toggled." : "❌ Not found.");
});

bot.command("delphrase", async (ctx) => {
  if (!ctx.from || !config.isAdmin(ctx.from.id)) return ctx.reply("👑 Admins only.");
  const id = Number((ctx.match ?? "").trim());
  if (!Number.isFinite(id) || id <= 0) return ctx.reply("Usage: /delphrase <id>");
  return ctx.reply(db.deletePhrase(id) ? "🗑️ Deleted." : "❌ Not found.");
});

bot.command("reseed", async (ctx) => {
  db.trackCommand("/reseed", ctx.from?.id);
  if (!ctx.from || !config.isAdmin(ctx.from.id)) return ctx.reply("👑 Admins only.");
  const list = db.listAllPhrases();
  for (const p of list) db.deletePhrase(p.id);
  seedIfEmpty(db);
  const { total, byCategory } = db.phraseStats();
  const cats = Object.entries(byCategory).map(([k, v]) => `${k}:${v}`).join(" ");
  return ctx.reply(`✅ Reseeded ${total} phrases. ${cats}`);
});

bot.command("hype", async (ctx) => {
  if (!ctx.from || !config.isAdmin(ctx.from.id)) return ctx.reply("👑 Admins only.");
  await hype.tick();
  return ctx.reply("🔥 Hype post sent.");
});
bot.command("stats", async (ctx) => {
  db.trackCommand("/stats", ctx.from?.id);
  if (!ctx.from || !config.isAdmin(ctx.from.id)) return ctx.reply("👑 Admins only.");
  return ctx.reply(admin.analyticsText());
});

// ── Group listeners ───────────────────────────────────────────────────────

bot.on("message:new_chat_members", async (ctx) => {
  db.trackJoin();
  const members = ctx.message?.new_chat_members ?? [];
  for (const member of members) {
    if (member.id === bot.botInfo.id) continue;
    await ctx.reply(`🦖 Welcome to the pack, ${member.first_name}! /start to begin.`);
  }
});

bot.on("message:text", async (ctx) => {
  db.trackMessage();
  if (!ctx.from) return;
  const text = ctx.message.text;

  // 🤖 AI-first replies: local Ollama model grounded with live on-chain data.
  const cfg = config.get();
  if (cfg.aiEnabled && cfg.repliesEnabled && replies.matches(text)) {
    const aiOut = await ai.reply(text, await chainContextFor(price));
    if (aiOut) {
      await ctx.reply(aiOut).catch(() => {});
      db.trackBotInteraction(ctx.from.id, "ai_reply");
      return;
    }
  }
  // Fallback: canned smart replies (probability-gated).
  await replies.maybeReply(ctx.from.id, ctx.chat.id, text);
});

// ── Boot ──────────────────────────────────────────────────────────────────

bot.catch((err) => {
  console.error("Bot error:", err.error);
});

async function main(): Promise<void> {
  await bot.init();
  hype.start();

  // 📈 Periodic on-chain price updates to the group.
  let lastPriceDay = "";
  setInterval(async () => {
    const cfg = config.get();
    if (!cfg.priceEnabled || !cfg.groupId) return;
    const report = await price.tickerLine();
    if (!report) return;
    // Skip if the hype engine just posted (avoid double-ticker within 2 min).
    await postToGroup(report).catch(() => {});
    void lastPriceDay;
  }, config.get().priceIntervalMinutes * 60 * 1000).unref?.();

  // 🚨 BRUTAL ALERT ENGINE: pump / dump / ATH detection every 2 minutes.
  setInterval(async () => {
    const cfg = config.get();
    if (!cfg.priceEnabled || !cfg.groupId) return;
    const alert = await price.checkAlerts();
    if (alert) {
      await postToGroup(alert).catch(() => {});
      console.log("🚨 alert posted:", alert.split("\n")[0]);
    }
  }, 2 * 60 * 1000).unref?.();
  console.log(`🦖 SAUR BOT online as @${bot.botInfo.username}`);
  console.log(`   Admins: ${ADMIN_IDS.join(", ") || "(none set!)"}`);
  console.log(`   Hype: ${config.get().hypeEnabled ? "ON" : "OFF"} every ${config.get().hypeIntervalMinutes}m · Campaign: ${config.get().campaign}`);
  console.log(`   Price: ${config.get().priceEnabled ? "ON" : "OFF"} every ${config.get().priceIntervalMinutes}m · CA: ${CONTRACT.slice(0, 8)}…`);
  const aiOk = await ai.available();
  console.log(`   AI: ${config.get().aiEnabled ? (aiOk ? `ON · ${ai.getModel()} (Ollama ready)` : "ON but Ollama unreachable — canned replies only") : "OFF"}`);
  // Daily report to group at 20:00 UTC
  let lastReportDay = "";
  setInterval(async () => {
    const day = new Date().toISOString().slice(0, 10);
    const hourUtc = new Date().getUTCHours();
    if (hourUtc === 20 && lastReportDay !== day) {
      lastReportDay = day;
      const gid = config.get().groupId;
      if (gid) await postToGroup(admin.analyticsText()).catch(() => {});
    }
  }, 10 * 60 * 1000).unref?.();
  void bot.start();
}

main();
