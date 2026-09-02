import type { SaurDb } from "./db.js";
import type { Config } from "./config.js";

/**
 * 👑 ADMIN PANEL
 * /admin opens an inline-keyboard control room; callbacks flip settings live.
 */
export class AdminPanel {
  constructor(
    private db: SaurDb,
    private config: Config,
    private api: {
      sendMessage: (chatId: number, text: string, kb?: any) => Promise<any>;
      editMessage: (chatId: number, messageId: number, text: string, kb?: any) => Promise<any>;
      answerCallback: (id: string) => Promise<void>;
    }
  ) {}

  private static CAMPAIGNS = ["PRE-LAUNCH", "LAUNCH", "COMMUNITY", "ATH/MOMENTUM"];
  private static CAMPAIGN_LABELS: Record<string, string> = {
    "PRE-LAUNCH": "PRE-LAUNCH",
    "LAUNCH": "LAUNCH",
    "COMMUNITY": "COMMUNITY",
    "ATH/MOMENTUM": "MOMENTUM",
  };
  private static INTERVALS = [15, 30, 60, 120];
  private static AI_MODELS = [
    "llama3.2:3b",
    "gemma4:latest",
    "qwen3.5:latest",
    "glm-4.7-flash:latest",
    "qwen3.6:latest",
  ];

  dashboardText(): string {
    const c = this.config.get();
    const stats = this.db.phraseStats();
    const cats = Object.entries(stats.byCategory)
      .map(([k, v]) => `${k}: ${v}`)
      .join(" · ");
    return [
      "🦖 SAUR CONTROL PANEL",
      "",
      `Hype: ${c.hypeEnabled ? "🟢 ON" : "🔴 OFF"}`,
      `Interval: ${c.hypeIntervalMinutes} min`,
      `Replies: ${c.repliesEnabled ? "🟢 ON" : "🔴 OFF"} (${c.replyProbability}% · cap ${c.maxRepliesPerHour}/h)`,
      `AI: ${c.aiEnabled ? `🟢 ON (${c.aiModel})` : "🔴 OFF"}`,
      `Campaign: ${AdminPanel.CAMPAIGN_LABELS[c.campaign] ?? c.campaign}`,
      "",
      `Phrases: ${stats.enabled}/${stats.total} enabled (${cats})`,
    ].join("\n");
  }

  keyboard(): any {
    const c = this.config.get();
    const hypeRow = [
      { text: `🔥 ON`, callback_data: "adm:hype:1" },
      { text: `OFF`, callback_data: "adm:hype:0" },
    ];
    const intervalRow = AdminPanel.INTERVALS.map((m) => ({
      text: c.hypeIntervalMinutes === m ? `● ${m}m` : `${m}m`,
      callback_data: `adm:interval:${m}`,
    }));
    const repliesRow = [
      { text: `🤖 ON`, callback_data: "adm:replies:1" },
      { text: `OFF`, callback_data: "adm:replies:0" },
    ];
    const aiRow = [
      { text: `🧠 AI ON`, callback_data: "adm:ai:1" },
      { text: `OFF`, callback_data: "adm:ai:0" },
    ];
    const aiModelRow = AdminPanel.AI_MODELS.map((m) => ({
      text: c.aiModel === m ? `● ${m.split(":")[0]}` : m.split(":")[0],
      callback_data: `adm:aimodel:${m}`,
    }));
    const campaignRows = [
      AdminPanel.CAMPAIGNS.slice(0, 2).map((camp) => ({
        text: c.campaign === camp ? `● ${AdminPanel.CAMPAIGN_LABELS[camp]}` : AdminPanel.CAMPAIGN_LABELS[camp],
        callback_data: `adm:campaign:${camp}`,
      })),
      AdminPanel.CAMPAIGNS.slice(2).map((camp) => ({
        text: c.campaign === camp ? `● ${AdminPanel.CAMPAIGN_LABELS[camp]}` : AdminPanel.CAMPAIGN_LABELS[camp],
        callback_data: `adm:campaign:${camp}`,
      })),
    ];
    return {
      inline_keyboard: [
        hypeRow,
        intervalRow,
        repliesRow,
        aiRow,
        aiModelRow,
        ...campaignRows,
        [
          { text: "✏️ Phrases", callback_data: "adm:phrases" },
          { text: "📊 Analytics", callback_data: "adm:analytics" },
        ],
        [{ text: "🔄 Refresh", callback_data: "adm:refresh" }],
      ],
    };
  }

  analyticsText(): string {
    const t = this.db.todayStats();
    const best = this.db.bestHour(2);
    const active = this.db.activeUsers(1);
    const bestStr = best
      ? `${String(best.hour).padStart(2, "0")}:00–${String((best.hour + 1) % 24).padStart(2, "0")}:00 UTC (${best.count} eventos)`
      : "no data yet";
    const engagement = Math.min(
      100,
      Math.round((t.bot_interactions / Math.max(1, t.messages)) * 100)
    );
    const bar = "█".repeat(Math.round(engagement / 10)) + "░".repeat(10 - Math.round(engagement / 10));
    return [
      "🦖 SAUR DAILY REPORT",
      "",
      `👥 Active users (24h): ${active}`,
      `💬 Messages today: ${t.messages}`,
      `🔥 Bot interactions: ${t.bot_interactions}`,
      `⌨️ Commands used: ${t.commands_used}`,
      `🔥 Hype posts: ${t.hype_posts}`,
      "",
      `📈 Best activity window: ${bestStr}`,
      `Community health: ${bar} ${engagement}%`,
    ].join("\n");
  }

  phrasesText(): string {
    const stats = this.db.phraseStats();
    const lines = Object.entries(stats.byCategory).map(
      ([cat, n]) => `• ${cat}: ${n}`
    );
    return [
      "✏️ PHRASE MANAGER",
      "",
      `Enabled: ${stats.enabled} / ${stats.total}`,
      "",
      ...lines,
      "",
      "Add: /addphrase [category] <text>",
      "List: /phrases [category]",
      "Toggle: /togglephrase <id>",
      "Delete: /delphrase <id>",
    ].join("\n");
  }

  async open(chatId: number): Promise<void> {
    await this.api.sendMessage(chatId, this.dashboardText(), this.keyboard());
  }

  async handleCallback(
    chatId: number,
    messageId: number,
    userId: number,
    data: string,
    answerCb: (text?: string) => Promise<void>
  ): Promise<void> {
    if (!this.config.isAdmin(userId)) {
      await answerCb("👑 Admins only.");
      return;
    }
    const [, action, arg] = data.split(":");
    switch (action) {
      case "hype":
        this.config.set("hypeEnabled", arg === "1" ? "1" : "0");
        break;
      case "replies":
        this.config.set("repliesEnabled", arg === "1" ? "1" : "0");
        break;
      case "ai":
        this.config.set("aiEnabled", arg === "1" ? "1" : "0");
        break;
      case "aimodel":
        this.config.set("aiModel", arg);
        break;
      case "interval":
        this.config.set("hypeInterval", arg);
        break;
      case "campaign":
        this.config.set("campaign", arg);
        break;
      case "phrases":
        await this.api.editMessage(chatId, messageId, this.phrasesText(), {
          inline_keyboard: [[{ text: "⬅️ Back", callback_data: "adm:refresh" }]],
        });
        await answerCb();
        return;
      case "analytics":
        await this.api.editMessage(chatId, messageId, this.analyticsText(), {
          inline_keyboard: [[{ text: "⬅️ Back", callback_data: "adm:refresh" }]],
        });
        await answerCb();
        return;
      case "refresh":
      default:
        break;
    }
    await this.api.editMessage(chatId, messageId, this.dashboardText(), this.keyboard());
    await answerCb("✅ Updated");
  }
}
