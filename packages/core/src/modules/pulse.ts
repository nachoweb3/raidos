import type { BrainDb } from "../database/db.js";
import type { AiProvider } from "../ai/provider.js";
import { communityMemory } from "./memory.js";

/**
 * 💓 COMMUNITY PULSE
 * Deterministic metrics from SQL + exactly one LLM narrative line.
 * The bot never invents metrics — the model only narrates real numbers.
 */

export interface PulseMetrics {
  windowDays: number;
  activeUsers: number;
  messages: number;
  questions: number;
  openClusters: number;
  answeredClusters: number;
  topQuestion: string | null;
}

export function pulseMetrics(db: BrainDb, chatId: number, windowDays = 7): PulseMetrics {
  const since = Math.floor(Date.now() / 1000) - windowDays * 86400;
  const clusters = db.listClusters(chatId);
  const open = clusters.filter((c) => c.status === "open").length;
  const answered = clusters.filter((c) => c.status === "answered").length;
  const top = communityMemory(db, chatId, 1)[0];
  return {
    windowDays,
    activeUsers: db.activeUsers(chatId, since),
    messages: db.messageCount(chatId, since),
    questions: db.questionCount(chatId, since),
    openClusters: open,
    answeredClusters: answered,
    topQuestion: top?.question ?? null,
  };
}

export function pulseBar(value: number, max: number): string {
  const ratio = max > 0 ? Math.min(1, value / max) : 0;
  return "█".repeat(Math.round(ratio * 10)).padEnd(10, "░");
}

export function pulseText(metrics: PulseMetrics, narrative: string): string {
  const perUser = metrics.activeUsers > 0 ? (metrics.messages / metrics.activeUsers).toFixed(1) : "0";
  const answeredRate =
    metrics.openClusters + metrics.answeredClusters > 0
      ? Math.round((metrics.answeredClusters / (metrics.openClusters + metrics.answeredClusters)) * 100)
      : 0;
  return [
    "💓 COMMUNITY PULSE",
    "━━━━━━━━━━━━━━━━━━",
    `👥 Active members: ${metrics.activeUsers}`,
    `💬 Messages (${metrics.windowDays}d): ${metrics.messages} (~${perUser}/member)`,
    `❓ Questions asked: ${metrics.questions}`,
    `🧠 Questions answered: ${pulseBar(metrics.answeredClusters, Math.max(1, metrics.answeredClusters + metrics.openClusters))} ${answeredRate}%`,
    metrics.topQuestion ? `🔥 Top question: ${metrics.topQuestion}` : "",
    "",
    `🧠 ${narrative}`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** One LLM call that turns real metrics into a single narrative sentence. */
export async function pulseNarrative(ai: AiProvider, m: PulseMetrics): Promise<string> {
  const out = await ai.complete(
    [
      {
        role: "system",
        content:
          "You are the Community Brain. Write ONE sentence (max 25 words) describing the community's health from the metrics. Warm, direct, no hype, no invented numbers. Use only the numbers provided.",
      },
      {
        role: "user",
        content: [
          `active users (${m.windowDays}d): ${m.activeUsers}`,
          `messages: ${m.messages}`,
          `questions asked: ${m.questions}`,
          `recurring question clusters open: ${m.openClusters}, answered: ${m.answeredClusters}`,
          m.topQuestion ? `most asked: ${m.topQuestion}` : "no recurring questions yet",
        ].join("\n"),
      },
    ],
    { temperature: 0.4, maxTokens: 80 }
  );
  const line = out.split("\n").filter(Boolean).pop() ?? "";
  return line.trim() || "The community is steady — keep showing up.";
}
