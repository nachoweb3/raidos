import type { AiProvider, AiMessage } from "./provider.js";

/**
 * 🎭 DEMO PROVIDER
 * Simulated AI for DEMO_MODE: no model, no API key, no Ollama needed.
 * Produces plausible, clearly-simulated outputs so every feature can be
 * tested before connecting a real token or a real model.
 */
export class DemoProvider implements AiProvider {
  readonly name = "demo";

  async available(): Promise<boolean> {
    return true;
  }

  async complete(
    messages: AiMessage[],
    _opts?: { temperature?: number; maxTokens?: number; timeoutMs?: number }
  ): Promise<string> {
    const user = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const ticker = /\$([A-Z0-9]{2,10})/i.exec(user)?.[1] ?? "TOKEN";
    const bank = [
      `🚀 [DEMO] ${ticker} community energy is off the charts today. Being early is a strategy. 👀`,
      `💎 [DEMO] Strong hands stay patient. The ${ticker} story is just getting started.`,
      `🔥 [DEMO] The timeline hasn't noticed ${ticker} yet. It will.`,
      `🧠 [DEMO] Every legend starts in silence. ${ticker} is writing its origin story right now.`,
      `⚡ [DEMO] Community first, hype follows. ${ticker} fam is the compounding. 🚀`,
    ];
    return bank[Math.floor(Math.random() * bank.length)];
  }
}
