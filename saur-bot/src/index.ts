import "dotenv/config";
import { Bot, InlineKeyboard } from "grammy";
import { AccessCodeClient, MintRateLimiter } from "./access.js";

/**
 * 🦖 SAUR BOT — gestor de acceso al dashboard TRENCHES.
 *
 * ÚNICA función: emitir el código de 24h que desbloquea la pestaña
 * 📡 Señales TG (membresía Academia Elite). Flujo: /code en DM →
 * verificación de membresía en el grupo oficial → mint vía la API de
 * TRENCHES → respuesta con el código copiable de un clic.
 */

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error("❌ BOT_TOKEN missing. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

// Grupo oficial de la Academia Elite: quien no pertenece, no recibe código.
const GROUP_ID = process.env.GROUP_ID ?? "";
// Dashboard donde se canjea el código.
const APP_URL = process.env.TRENCHES_APP_URL ?? "https://inusaur.online/app.html";

const bot = new Bot(TOKEN);

const accessCodes = new AccessCodeClient({
  apiBase: process.env.TRENCHES_API_BASE ?? "https://raidos-api.fly.dev",
  adminSecret: process.env.ADMIN_SECRET ?? "",
});
// Anti-spam: un /code por minuto por usuario.
const mintLimiter = new MintRateLimiter(60_000);

function appKeyboard(): InlineKeyboard {
  return new InlineKeyboard().url("🌐 Abrir TRENCHES", APP_URL);
}

function helpText(): string {
  return [
    "🦖 SAUR BOT — acceso al dashboard TRENCHES",
    "",
    "Qué hago:",
    "• /code — genero tu código de 24h para la pestaña 📡 Señales TG (solo DM, miembros de la Academia Elite)",
    "",
    `Dashboard: ${APP_URL}`,
    "",
    "Comandos: /code · /help",
  ].join("\n");
}

bot.command("start", (ctx) => ctx.reply(helpText(), { reply_markup: appKeyboard() }));

bot.command("help", (ctx) => ctx.reply(helpText(), { reply_markup: appKeyboard() }));

// ── 🔐 /code — pase de 24h para la pestaña Señales TG de la web ──────────

bot.command("code", async (ctx) => {
  if (!ctx.from) return;
  if (!accessCodes.configured) {
    return ctx.reply("🔐 Access codes are not configured yet. Ask an admin.");
  }
  if (!mintLimiter.allow(String(ctx.from.id))) {
    return ctx.reply("⏳ Ya pediste un código hace poco. Reintenta en un minuto.");
  }
  // Solo DM: en grupo se polluciona y el código quedaría expuesto.
  if (ctx.chat.type !== "private") {
    const me = await ctx.api.getMe();
    return ctx.reply(`🔐 Escríbeme por DM para darte tu código: t.me/${me.username}?start=code`);
  }
  if (!GROUP_ID) {
    return ctx.reply("⚙️ Grupo de miembros no configurado (GROUP_ID). Avisa a un admin.");
  }
  // Verificación de membresía: hay que estar en el grupo oficial.
  try {
    const member = await ctx.api.getChatMember(GROUP_ID, ctx.from.id);
    const status = member.status;
    if (status === "left" || status === "kicked") {
      return ctx.reply("🚫 Este código es para miembros de la Academia Elite.\nÚnete al grupo oficial y vuelve.");
    }
  } catch {
    return ctx.reply("⚠️ No pude verificar tu membresía ahora mismo. Reintenta en un minuto.");
  }
  // Minta vía la API de TRENCHES (rota el código anterior del usuario).
  await ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});
  try {
    const minted = await accessCodes.mint(
      String(ctx.from.id),
      ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name ?? "",
      GROUP_ID,
    );
    const exp = new Date(minted.expiresAt * 1000);
    // 📋 Copiable con UN clic: el cliente de Telegram copia el texto al
    // portapapeles sin seleccionar nada (Bot API 9.0). Fallback honesto en
    // clientes viejos: el código también queda visible como <code>.
    const kb = new InlineKeyboard()
      .copyText("📋 Copiar código", minted.code)
      .row()
      .url("🌐 Ir al dashboard", APP_URL);
    return ctx.reply(
      [
        "🔐 TU CÓDIGO DE ACCESO — Señales TG (24h)",
        "",
        `Código: <code>${minted.code}</code>`,
        "",
        "1. Toca «📋 Copiar código» — se copia solo",
        "2. Entra al dashboard → pestaña 📡 Señales TG",
        "3. Pega el código y pulsa «Desbloquear 24h»",
        "",
        "⚠️ Un solo uso. Si lo gastas o caduca, vuelve y pide otro con /code.",
        `⏱️ Caduca sin usar el: ${exp.toUTCString()}`,
      ].join("\n"),
      { reply_markup: kb, parse_mode: "HTML" },
    );
  } catch (err) {
    console.error("/code mint failed:", err instanceof Error ? err.message : err);
    return ctx.reply("❌ No se pudo generar tu código ahora mismo. Reintenta en unos minutos.");
  }
});

// Cualquier otra cosa: respuesta honesta (este bot solo gestiona acceso).
// grammY encadena handlers: los comandos reales (start/help/code) NO deben
// caer aquí o el usuario recibiría doble respuesta.
const KNOWN_COMMAND = /^\/(code|help|start)(@\S+)?(\s|$)/;
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();
  if (!KNOWN_COMMAND.test(text) && text.startsWith("/")) {
    return ctx.reply(
      "🤖 Este bot solo gestiona el acceso al dashboard:\n/code — tu código de 24h para 📡 Señales TG",
      { reply_markup: appKeyboard() },
    );
  }
  if (ctx.chat.type === "private" && !text.startsWith("/")) {
    return ctx.reply("👋 Escribe /code para recibir tu código de acceso de 24h.", {
      reply_markup: appKeyboard(),
    });
  }
});

bot.catch((err) => {
  console.error("Bot error:", err.error);
});

async function main(): Promise<void> {
  await bot.init();
  console.log(`🦖 SAUR BOT online as @${bot.botInfo.username} (modo acceso: solo /code)`);
  console.log(`   Dashboard: ${APP_URL}`);
  console.log(`   Grupo miembros: ${GROUP_ID || "(sin configurar)"}`);
  void bot.start();
}

main();
