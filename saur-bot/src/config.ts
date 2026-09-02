import { SaurDb } from "./db.js";

/** Runtime settings persisted in the DB so /admin changes survive restarts. */
export interface BotConfig {
  hypeEnabled: boolean;
  hypeIntervalMinutes: 15 | 30 | 60 | 120;
  priceEnabled: boolean;
  priceIntervalMinutes: 15 | 30 | 60 | 120;
  aiEnabled: boolean;
  aiModel: string;
  repliesEnabled: boolean;
  replyProbability: number; // percent 0-100
  replyCooldownMinutes: number;
  maxRepliesPerHour: number;
  campaign: string;
  adminIds: number[];
  groupId?: number;
}

const DEFAULTS = {
  hypeEnabled: "1",
  hypeInterval: "30",
  priceEnabled: "1",
  priceInterval: "30",
  aiEnabled: "1",
  aiModel: "llama3.2:3b",
  repliesEnabled: "1",
  replyProbability: "15",
  replyCooldown: "10",
  maxRepliesPerHour: "3",
  campaign: "COMMUNITY",
};

export class Config {
  constructor(private db: SaurDb, envAdminIds: number[], envGroupId?: number) {
    // Seed defaults on first run
    for (const [k, v] of Object.entries(DEFAULTS)) {
      if (db.getSetting(k, "") === "") db.setSetting(k, v);
    }
    this._adminIds = envAdminIds;
    this._groupId = envGroupId;
  }

  private _adminIds: number[];
  private _groupId?: number;

  get(): BotConfig {
    return {
      hypeEnabled: this.db.getSetting("hypeEnabled", DEFAULTS.hypeEnabled) === "1",
      hypeIntervalMinutes: Number(
        this.db.getSetting("hypeInterval", DEFAULTS.hypeInterval)
      ) as BotConfig["hypeIntervalMinutes"],
      priceEnabled: this.db.getSetting("priceEnabled", DEFAULTS.priceEnabled) === "1",
      priceIntervalMinutes: Number(
        this.db.getSetting("priceInterval", DEFAULTS.priceInterval)
      ) as BotConfig["priceIntervalMinutes"],
      aiEnabled: this.db.getSetting("aiEnabled", DEFAULTS.aiEnabled) === "1",
      aiModel: this.db.getSetting("aiModel", DEFAULTS.aiModel),
      repliesEnabled: this.db.getSetting("repliesEnabled", DEFAULTS.repliesEnabled) === "1",
      replyProbability: Number(this.db.getSetting("replyProbability", DEFAULTS.replyProbability)),
      replyCooldownMinutes: Number(this.db.getSetting("replyCooldown", DEFAULTS.replyCooldown)),
      maxRepliesPerHour: Number(this.db.getSetting("maxRepliesPerHour", DEFAULTS.maxRepliesPerHour)),
      campaign: this.db.getSetting("campaign", DEFAULTS.campaign),
      adminIds: this._adminIds,
      groupId: this._groupId,
    };
  }

  set(key: keyof typeof DEFAULTS, value: string): void {
    this.db.setSetting(key, value);
  }

  isAdmin(userId: number): boolean {
    return this._adminIds.includes(userId);
  }
}
