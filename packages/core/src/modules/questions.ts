/**
 * ❓ QUESTION DETECTION (heuristic, no AI)
 * Runs on the capture hot path, so it must be instant and allocation-free.
 * Conservative on purpose: a false positive costs one embedding later;
 * a missed question never becomes memory.
 */

const EN_STARTERS = new Set([
  "what",
  "when",
  "where",
  "how",
  "why",
  "who",
  "which",
  "whose",
]);

const ES_STARTERS = new Set([
  "que",
  "qué",
  "como",
  "cómo",
  "cuando",
  "cuándo",
  "donde",
  "dónde",
  "quien",
  "quién",
  "cual",
  "cuál",
]);

export function isQuestion(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 400) return false;
  if (t.endsWith("?")) return true;
  const first = t.toLowerCase().split(/\s+/)[0]?.replace(/[^\p{L}]/gu, "") ?? "";
  return EN_STARTERS.has(first) || ES_STARTERS.has(first);
}
