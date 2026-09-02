import type { SaurDb } from "./db.js";
import type { Config } from "./config.js";

/**
 * 🤖 SMART REPLIES
 * Responds when someone mentions the bot/SAUR keywords — with probability,
 * per-user cooldown and an hourly cap so the group never looks bot-driven.
 */
export class SmartReplies {
  private lastReplyPerUser = new Map<number, number>();
  private replyTimestamps: number[] = [];

  constructor(
    private db: SaurDb,
    private config: Config,
    private reply: (chatId: number, text: string) => Promise<void>
  ) {}

  private static TRIGGERS = [
    "saur",
    "inusaur",
    "$saur",
    "dino",
    "dinosaur",
    "bot",
  ];

  private static RESPONSES = [
    "🦖 $SAUR is the dinosaur-powered Inu meme.\nIf you're early, you're early. 👀\nCheck the links in /start.",
    "🦖 The SAUR hears you. Stay loud, stay early. 👀",
    "🦖 INU + SAUR = one meme, one mission. /saur for the lore.",
    "🦖 Roar detected. The pack is listening. 🚀",
    "🦖 Questions? /saur has answers. The timeline has rumors.",
  ];

  matches(text: string): boolean {
    const lower = text.toLowerCase();
    return SmartReplies.TRIGGERS.some((t) => lower.includes(t));
  }

  async maybeReply(userId: number, chatId: number, text: string): Promise<boolean> {
    const cfg = this.config.get();
    if (!cfg.repliesEnabled) return false;
    if (!this.matches(text)) return false;

    const now = Date.now();
    // Hourly cap
    this.replyTimestamps = this.replyTimestamps.filter(
      (t) => now - t < 60 * 60 * 1000
    );
    if (this.replyTimestamps.length >= cfg.maxRepliesPerHour) return false;

    // Per-user cooldown
    const last = this.lastReplyPerUser.get(userId) ?? 0;
    if (now - last < cfg.replyCooldownMinutes * 60 * 1000) return false;

    // Probability gate
    if (Math.random() * 100 >= cfg.replyProbability) return false;

    const text2 =
      SmartReplies.RESPONSES[
        Math.floor(Math.random() * SmartReplies.RESPONSES.length)
      ];
    this.lastReplyPerUser.set(userId, now);
    this.replyTimestamps.push(now);
    await this.reply(chatId, text2);
    this.db.trackBotInteraction(userId, "smart_reply");
    return true;
  }
}
