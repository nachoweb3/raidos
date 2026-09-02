import type { BrainDb } from "../database/db.js";
import { unpackEmbedding, cosineSimilarity } from "./embeddings.js";

/**
 * 🧠 COMMUNITY MEMORY
 * The recurring questions a community keeps asking, ranked by frequency
 * and recency. Pure SQL + cluster data — no LLM needed to list them.
 */

export interface MemoryItem {
  id: number;
  question: string;
  count: number;
  status: "open" | "answered" | "ignored";
  lastSeen: number;
}

export function communityMemory(db: BrainDb, chatId: number, limit = 8): MemoryItem[] {
  return db
    .listClusters(chatId)
    .filter((c) => c.status !== "ignored" && c.count >= 2)
    .slice(0, limit)
    .map((c) => ({
      id: c.id,
      question: c.canonical_question ?? c.label,
      count: c.count,
      status: c.status as MemoryItem["status"],
      lastSeen: c.last_seen,
    }));
}

export function memoryText(memory: MemoryItem[], title = "🧠 COMMUNITY MEMORY"): string {
  if (memory.length === 0) {
    return `${title}\n\nNo recurring questions detected yet. Give me a few days of chat.`;
  }
  const lines = memory.map((m, i) => {
    const mark = m.status === "answered" ? "✅" : m.count >= 5 ? "⚠️" : "•";
    const ago = Math.round((Date.now() / 1000 - m.lastSeen) / 3600);
    const when = ago < 1 ? "just now" : ago < 48 ? `${ago}h ago` : `${Math.round(ago / 24)}d ago`;
    return `${i + 1}. ${mark} ${m.question} ×${m.count} (${when})`;
  });
  return [title, "", ...lines].join("\n");
}

/** Best matching open cluster for a question embedding, or null. */
export function matchOpenCluster(
  db: BrainDb,
  chatId: number,
  embedding: number[],
  minScore = 0.6
): { id: number; question: string; score: number } | null {
  let best: { id: number; question: string; score: number } | null = null;
  for (const c of db.openClusters(chatId)) {
    const score = cosineSimilarity(embedding, unpackEmbedding(c.centroid));
    if (score >= minScore && (!best || score > best.score)) {
      best = { id: c.id, question: c.canonical_question ?? c.label, score };
    }
  }
  return best;
}
