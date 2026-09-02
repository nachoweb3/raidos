import type { BrainDb, KbRow } from "../database/db.js";
import type { AiProvider } from "../ai/provider.js";
import { packEmbedding, unpackEmbedding, cosineSimilarity } from "./embeddings.js";

/**
 * 📚 KNOWLEDGE BASE
 * Curated (/learn) + auto-captured (pinned messages, admin announcements).
 * Everything is chunked, embedded once, and retrieved by cosine similarity.
 */

/** Admin messages shorter than this are chatter, not announcements. */
export const MIN_ADMIN_POST_LEN = 120;
/** Max KB chunks per chat (keeps retrieval and DB tiny at V1 scale). */
export const MAX_KB_ENTRIES = 300;

/** Split long texts into overlapping ~400-char chunks on sentence boundaries. */
export function chunkText(text: string, maxLen = 400): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean ? [clean] : [];
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length && chunks.length < 20) {
    let end = Math.min(start + maxLen, clean.length);
    if (end < clean.length) {
      const slice = clean.slice(start, end);
      const cut = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("! "), slice.lastIndexOf("? "));
      if (cut > maxLen / 2) end = start + cut + 1;
    }
    chunks.push(clean.slice(start, end).trim());
    start = end;
  }
  return chunks.filter(Boolean);
}

/** Learn a text: chunk → embed → store. Returns number of chunks stored. */
export async function learnText(
  db: BrainDb,
  ai: AiProvider,
  chatId: number,
  text: string,
  source: KbRow["source"],
  addedBy: number | null
): Promise<number> {
  const chunks = chunkText(text);
  let stored = 0;
  for (const chunk of chunks) {
    const emb = await ai.embed(chunk);
    if (emb.length === 0) continue; // embedder down — skip, don't store unusable rows
    db.addKbEntry(chatId, source, chunk, packEmbedding(emb), addedBy);
    stored++;
  }
  trimKb(db, chatId);
  return stored;
}

/** Keep the KB bounded: drop oldest entries beyond the cap. */
function trimKb(db: BrainDb, chatId: number): void {
  const all = db.listKbEntries(chatId, true);
  const excess = all.length - MAX_KB_ENTRIES;
  if (excess > 0) {
    // all is ts DESC; the last `excess` are oldest.
    for (const entry of all.slice(-excess)) db.deleteKbEntry(entry.id);
  }
}

export interface RetrievedChunk {
  id: number;
  source: string;
  content: string;
  score: number;
}

/** Retrieve the top-k most relevant KB chunks for a question. */
export function retrieve(
  db: BrainDb,
  chatId: number,
  questionEmbedding: number[],
  k = 3
): RetrievedChunk[] {
  const entries = db.listKbEntries(chatId);
  const scored = entries.map((e) => ({
    id: e.id,
    source: e.source as string,
    content: e.content,
    score: cosineSimilarity(questionEmbedding, unpackEmbedding(e.embedding)),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}
