import type { BrainDb } from "./database/db.js";
import { ChatSettings } from "./settings.js";
import type { InlineKeyboardMarkup } from "grammy/types";

/**
 * 👑 /config — per-chat inline control panel (generalized from saur-bot).
 */

export class ConfigPanel {
  constructor(
    private db: BrainDb,
    private settings: ChatSettings,
    private api: {
      sendMessage: (chatId: number, text: string, kb?: InlineKeyboardMarkup) => Promise<unknown>;
      editMessage: (chatId: number, messageId: number, text: string, kb?: InlineKeyboardMarkup) => Promise<unknown>;
    }
  ) {}

  private static DESTS = ["group", "owner", "off"] as const;

  dashboardText(chatId: number): string {
    const s = this.settings.get(chatId);
    const title = this.db.getChat(chatId)?.title ?? "this chat";
    return [
      `🧠 ${s.botName} — ${title}`,
      "",
      `Brain: ${s.brainEnabled ? "🟢 ON" : "🔴 OFF"}`,
      `Confusion alert at: ${s.alertThreshold} questions / ${s.alertWindowHours}h`,
      `Alert destination: ${s.alertDestination}`,
      `Pulse: ${s.pulseEnabled ? `🟢 weekly (${ChatSettings.dayName(s.pulseDay)} ${s.pulseHour}:00 UTC)` : "🔴 OFF"}`,
      `Message retention: ${s.retentionDays} days`,
      `Cluster similarity: ${s.clusterSimilarity}`,
      s.tone ? `Tone: ${s.tone}` : `Tone: (neutral)`,
      "",
      "Auto-captured knowledge: pinned messages + admin posts.",
      "Add facts with /learn, browse with /kb.",
    ].join("\n");
  }

  keyboard(chatId: number): InlineKeyboardMarkup {
    const s = this.settings.get(chatId);
    const destRow = ConfigPanel.DESTS.map((d) => ({
      text: s.alertDestination === d ? `● ${d}` : d,
      callback_data: `cfg:dest:${d}`,
    }));
    const thresholds = [3, 5, 8];
    const thrRow = thresholds.map((t) => ({
      text: s.alertThreshold === t ? `● ${t}` : `${t}`,
      callback_data: `cfg:threshold:${t}`,
    }));
    const retention = [7, 14, 30];
    const retRow = retention.map((d) => ({
      text: s.retentionDays === d ? `● ${d}d` : `${d}d`,
      callback_data: `cfg:retention:${d}`,
    }));
    return {
      inline_keyboard: [
        [
          { text: `🧠 Brain ${s.brainEnabled ? "ON" : "OFF"}`, callback_data: `cfg:brain:${s.brainEnabled ? "0" : "1"}` },
          { text: `💓 Pulse ${s.pulseEnabled ? "ON" : "OFF"}`, callback_data: `cfg:pulse:${s.pulseEnabled ? "0" : "1"}` },
        ],
        thrRow,
        destRow,
        retRow,
        [{ text: "🔄 Refresh", callback_data: "cfg:refresh" }],
      ],
    };
  }

  async open(chatId: number): Promise<unknown> {
    return this.api.sendMessage(chatId, this.dashboardText(chatId), this.keyboard(chatId));
  }

  async handleCallback(
    chatId: number,
    messageId: number,
    data: string
  ): Promise<void> {
    const [, action, arg] = data.split(":");
    switch (action) {
      case "brain":
        this.settings.set(chatId, "brainEnabled", arg === "1" ? "1" : "0");
        if (arg === "1") this.db.registerChat(chatId, this.db.getChat(chatId)?.title ?? "");
        break;
      case "pulse":
        this.settings.set(chatId, "pulseEnabled", arg === "1" ? "1" : "0");
        break;
      case "threshold":
        this.settings.set(chatId, "alertThreshold", arg ?? "5");
        break;
      case "dest":
        this.settings.set(chatId, "alertDestination", arg ?? "group");
        break;
      case "retention":
        this.settings.set(chatId, "retentionDays", arg ?? "14");
        break;
      case "refresh":
      default:
        break;
    }
    await this.api.editMessage(chatId, messageId, this.dashboardText(chatId), this.keyboard(chatId));
  }
}
