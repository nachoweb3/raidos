import type { BrainDb } from "./database/db.js";

/**
 * ⚙️ PER-CHAT SETTINGS
 * Persisted in SQLite so /config changes survive restarts. All defaults live here.
 */

export interface ChatSettingsShape {
  brainEnabled: boolean;
  alertThreshold: number;
  alertWindowHours: number;
  alertDestination: "group" | "owner" | "off";
  clusterSimilarity: number;
  pulseEnabled: boolean;
  pulseDay: number; // 0=Sun … 6=Sat (UTC)
  pulseHour: number; // UTC hour
  retentionDays: number;
  tone: string;
  botName: string;
  botEmoji: string;
  // ── RaidOS: volume intelligence ──
  marketProvider: string;
  tokenAddress: string;
  tokenSymbol: string;
  marketAlerts: boolean;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const DEFAULTS: ChatSettingsShape = {
  brainEnabled: false,
  alertThreshold: 5,
  alertWindowHours: 48,
  alertDestination: "group",
  clusterSimilarity: 0.82,
  pulseEnabled: true,
  pulseDay: 1, // Monday
  pulseHour: 18,
  retentionDays: 14,
  tone: "",
  botName: "Community Brain",
  botEmoji: "🧠",
  marketProvider: "dexscreener",
  tokenAddress: "",
  tokenSymbol: "SAUR",
  marketAlerts: false,
};

export class ChatSettings {
  constructor(private db: BrainDb) {}

  get(chatId: number): ChatSettingsShape {
    const g = (k: keyof ChatSettingsShape, fb: string) => this.db.getSetting(chatId, k, fb);
    return {
      brainEnabled: g("brainEnabled", DEFAULTS.brainEnabled ? "1" : "0") === "1",
      alertThreshold: Number(g("alertThreshold", String(DEFAULTS.alertThreshold))),
      alertWindowHours: Number(g("alertWindowHours", String(DEFAULTS.alertWindowHours))),
      alertDestination: g("alertDestination", DEFAULTS.alertDestination) as ChatSettingsShape["alertDestination"],
      clusterSimilarity: Number(g("clusterSimilarity", String(DEFAULTS.clusterSimilarity))),
      pulseEnabled: g("pulseEnabled", DEFAULTS.pulseEnabled ? "1" : "0") === "1",
      pulseDay: Number(g("pulseDay", String(DEFAULTS.pulseDay))),
      pulseHour: Number(g("pulseHour", String(DEFAULTS.pulseHour))),
      retentionDays: Number(g("retentionDays", String(DEFAULTS.retentionDays))),
      tone: g("tone", DEFAULTS.tone),
      botName: g("botName", DEFAULTS.botName),
      botEmoji: g("botEmoji", DEFAULTS.botEmoji),
      marketProvider: g("marketProvider", DEFAULTS.marketProvider),
      tokenAddress: g("tokenAddress", DEFAULTS.tokenAddress),
      tokenSymbol: g("tokenSymbol", DEFAULTS.tokenSymbol),
      marketAlerts: g("marketAlerts", DEFAULTS.marketAlerts ? "1" : "0") === "1",
    };
  }

  set(chatId: number, key: keyof ChatSettingsShape, value: string): void {
    this.db.setSetting(chatId, key, value);
  }

  static dayName(day: number): string {
    return DAYS[day] ?? "?";
  }
}
