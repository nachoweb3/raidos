import type { BrainDb } from "../database/db.js";
import type { AiProvider } from "../ai/provider.js";
import { communityMemory } from "./memory.js";
import { pulseMetrics } from "./pulse.js";

/**
 * 📋 ADMIN BRIEFING (/brain)
 * Memory + confusion + pulse + one LLM call for recommended actions.
 */

const SYSTEM = [
  "You are the Community Brain advising the admins of a Telegram community.",
  "Given real stats below, reply with 3 to 5 numbered recommended actions.",
  "Each action: one line, concrete, max 15 words. No invented facts or numbers.",
  "Priority: unanswered recurring questions first, then engagement ideas.",
].join("\n");

export async function recommendedActions(
  db: BrainDb,
  ai: AiProvider,
  chatId: number
): Promise<string[]> {
  const memory = communityMemory(db, chatId, 6);
  const m = pulseMetrics(db, chatId, 1);
  const context = [
    `last 24h: ${m.messages} messages, ${m.activeUsers} active users, ${m.questions} questions`,
    `open recurring questions:`,
    ...(memory.length > 0
      ? memory.map((x) => `- (${x.status}) ${x.question} ×${x.count}`)
      : ["- none yet"]),
  ].join("\n");

  const out = await ai.complete(
    [
      { role: "system", content: SYSTEM },
      { role: "user", content: context },
    ],
    { temperature: 0.4, maxTokens: 200 }
  );
  if (!out) return [];
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\d+[.)]/.test(l))
    .slice(0, 5);
}

export async function briefingText(
  db: BrainDb,
  ai: AiProvider,
  chatId: number
): Promise<string> {
  const m = pulseMetrics(db, chatId, 1);
  const memory = communityMemory(db, chatId, 5);
  const actions = await recommendedActions(db, ai, chatId);

  const lines: string[] = [
    "📋 ADMIN BRIEFING — last 24h",
    "━━━━━━━━━━━━━━━━━━━━━━━━",
    `👥 Active: ${m.activeUsers} · 💬 Messages: ${m.messages} · ❓ Questions: ${m.questions}`,
    "",
    "🧠 Community memory:",
    ...(memory.length > 0
      ? memory.map((x) => `${x.status === "answered" ? "✅" : "•"} ${x.question} ×${x.count}`)
      : ["• Nothing recurring yet"]),
    "",
  ];

  if (actions.length > 0) {
    lines.push("💡 Recommended actions:", ...actions, "");
  } else {
    lines.push("💡 (AI offline — no recommendations this time)", "");
  }

  return lines.join("\n").trimEnd();
}
