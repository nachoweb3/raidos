import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 🪪 PROJECT IDENTITY LOADER
 * Everything a community customizes lives in /config/*.json.
 * The code never hardcodes a token name, ticker, CA or brand — it reads them
 * from here. Missing values fall back to neutral placeholders.
 */

export interface TokenIdentity {
  projectName: string;
  tokenName: string;
  ticker: string;
  emoji: string;
  description: string;
  lore: string;
  character: string;
  tone: "hype" | "chill" | "degen" | "serious";
  contract: string;
  chain: string;
  chartUrl: string;
  roadmap: string[];
  socials: { website: string; twitter: string; telegram: string; discord: string };
  branding: { primaryColor: string; secondaryColor: string; vibe: string };
}

export interface KeywordConfig {
  triggers: string[];
  categories: Record<string, string[]>;
  hashtags: string[];
}

export interface PromptConfig {
  personality: string;
  rules: string[];
  tones: Record<string, string>;
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return { ...fallback, ...JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8")) };
  } catch {
    console.warn(`⚠️  Could not read ${path} — using defaults. (Is this a fork without config?)`);
    return fallback;
  }
}

const DEFAULT_TOKEN: TokenIdentity = {
  projectName: "MemeCoin Community Hype Bot",
  tokenName: "YOUR TOKEN",
  ticker: "TOKEN",
  emoji: "🚀",
  description: "A community-driven memecoin.",
  lore: "Every great meme has an origin story.",
  character: "mascot",
  tone: "hype",
  contract: "",
  chain: "solana",
  chartUrl: "",
  roadmap: ["Phase 1 — LAUNCH", "Phase 2 — GROWTH", "Phase 3 — EXPANSION", "Phase 4 — BEYOND"],
  socials: { website: "", twitter: "", telegram: "", discord: "" },
  branding: { primaryColor: "#8B5CF6", secondaryColor: "#22D3EE", vibe: "web3, memes, AI" },
};

const DEFAULT_KEYWORDS: KeywordConfig = {
  triggers: ["wagmi", "gm", "moon", "pump", "hodl", "alpha"],
  categories: {},
  hashtags: ["#memecoin", "#community"],
};

const DEFAULT_PROMPTS: PromptConfig = {
  personality: "You are {botName}, the hype mascot of the {ticker} community on Telegram.",
  rules: [],
  tones: {},
};

let cached: {
  token: TokenIdentity;
  keywords: KeywordConfig;
  prompts: PromptConfig;
} | null = null;

export function loadProjectConfig(): {
  token: TokenIdentity;
  keywords: KeywordConfig;
  prompts: PromptConfig;
} {
  if (!cached) {
    cached = {
      token: readJson<TokenIdentity>("config/token.json", DEFAULT_TOKEN),
      keywords: readJson<KeywordConfig>("config/keywords.json", DEFAULT_KEYWORDS),
      prompts: readJson<PromptConfig>("config/prompts.json", DEFAULT_PROMPTS),
    };
  }
  return cached;
}

/** Reload config from disk (used after onboarding writes token.json). */
export function reloadProjectConfig(): void {
  cached = null;
  loadProjectConfig();
}

/** Fill {ticker}, {emoji}, {botName} placeholders in prompt templates. */
export function interpolate(template: string, t: TokenIdentity): string {
  return template
    .replaceAll("{ticker}", t.ticker)
    .replaceAll("{tokenName}", t.tokenName)
    .replaceAll("{emoji}", t.emoji)
    .replaceAll("{character}", t.character)
    .replaceAll("{botName}", t.projectName);
}
