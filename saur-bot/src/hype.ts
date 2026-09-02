import type { SaurDb, PhraseRow } from "./db.js";
import type { Config } from "./config.js";
import type { PriceWatcher } from "./price.js";
import type { AiEngine } from "./ai.js";

/**
 * 🔥 HYPE ENGINE
 * Posts every N minutes (configurable via /admin). AI-first: the local model
 * writes the post grounded in live on-chain data; falls back to DB phrases.
 */
export class HypeEngine {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private db: SaurDb,
    private config: Config,
    private post: (text: string) => Promise<void>,
    private price?: PriceWatcher,
    private ai?: AiEngine
  ) {}

  start(): void {
    this.stop();
    if (!this.config.get().hypeEnabled) return;
    const minutes = this.config.get().hypeIntervalMinutes;
    this.running = true;
    // Small initial delay so the bot doesn't fire the moment it boots.
    this.timer = setInterval(() => void this.tick(), minutes * 60 * 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  restart(): void {
    this.start();
  }

  async tick(): Promise<void> {
    if (!this.config.get().hypeEnabled) return;
    // 🤖 AI-first: generate the post from live on-chain data (English).
    const aiBody = await this.aiPost();
    if (aiBody) {
      await this.post(aiBody);
      this.db.trackHypePost("ai");
      return;
    }
    // Fallback: canned phrase + live ticker.
    const phrase = this.pickForCampaign();
    if (!phrase) return;
    const ticker = this.price ? await this.price.tickerLine() : null;
    const body = ticker ? `${phrase.text}\n\n${ticker}` : phrase.text;
    await this.post(body);
    this.db.trackHypePost(phrase.category);
  }

  /** AI-generated hype post grounded in live on-chain stats. Empty on failure. */
  private async aiPost(): Promise<string | null> {
    if (!this.ai || !this.price) return null;
    const cfg = this.config.get();
    if (!cfg.aiEnabled) return null;
    const s = await this.price.getStats();
    if (!s) return null;
    const ctx = await this.price.reportLine();
    const prompt = [
      "Write a hype post for the $SAUR Telegram group.",
      "Rules: 2-4 lines, in English, with emojis 🦖🚀💎, use ONLY the real data below (never invent numbers),",
      "don't say 'buy' as an instruction, don't promise profits, don't mention you are an AI.",
      "End the post with a blank line and then the data block exactly as given.",
      "",
      `Live on-chain data:\n${ctx}`,
    ].join("\n");
    const out = await this.ai.reply(prompt, "");
    if (!out) return null;
    // Ensure the live ticker rides along even if the model skipped it.
    if (out.includes("$SAUR LIVE")) return out;
    const ticker = await this.price.tickerLine();
    return ticker ? `${out}\n\n${ticker}` : out;
  }

  /** Campaign → preferred categories, with fallbacks so the engine never starves. */
  private pickForCampaign(): PhraseRow | undefined {
    const campaign = this.config.get().campaign;
    const preferences: Record<string, string[]> = {
      "PRE-LAUNCH": ["fomo", "lore", "community"],
      LAUNCH: ["momentum", "bullish", "community"],
      COMMUNITY: ["community", "lore", "hold"],
      "ATH/MOMENTUM": ["momentum", "bullish", "fomo"],
    };
    const categories = preferences[campaign] ?? ["community", "lore", "hold"];
    // 80% campaign tone, 20% any enabled phrase for variety.
    if (Math.random() < 0.8) {
      for (const cat of categories) {
        const phrase = this.db.pickPhrase(cat);
        if (phrase) return phrase;
      }
    }
    return this.db.pickPhrase();
  }
}
