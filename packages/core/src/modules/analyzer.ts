import type { BrainDb, ClusterRow } from "../database/db.js";
import type { AiProvider } from "../ai/provider.js";
import { unpackEmbedding, packEmbedding } from "./embeddings.js";
import { classifyQuestion, updateClusterCentroid, clusterIsPromotable, type ClusterState } from "./cluster.js";

/**
 * ⚙️ THE ANALYZER
 * Runs every cycle per active chat: embeds new questions, folds them into
 * clusters, promotes bursting clusters with one LLM call, fires confusion
 * alerts. Zero AI on the capture hot path; all cost is batched here.
 */

export interface AnalyzerOptions {
  cycleMs: number; // analyzer tick interval (default 15 min)
  similarityThreshold: number; // cosine threshold to join a cluster (default 0.82)
  alertThreshold: number; // count that promotes a cluster (default 5)
  alertWindowHours: number; // burst window for promotion (default 48)
}

export const DEFAULT_ANALYZER_OPTIONS: AnalyzerOptions = {
  cycleMs: 15 * 60 * 1000,
  similarityThreshold: 0.82,
  alertThreshold: 5,
  alertWindowHours: 48,
};

export interface AnalyzerDeps {
  db: BrainDb;
  ai: AiProvider;
  /** Where alerts go; returns false if delivery failed. */
  postAlert: (chatId: number, text: string) => Promise<boolean>;
  getSetting: (chatId: number, key: string) => string;
  isActive: (chatId: number) => boolean;
}

const PROMPT_SYSTEM = [
  "You label clusters of repeated questions from a Telegram community.",
  "Given a list of similar member questions, reply with exactly three lines:",
  "CANONICAL: <the single clearest question they all ask, in the community's language>",
  "ACTION: <one concrete action an admin should take, max 15 words>",
  "SEVERITY: <confusion|info>",
].join("\n");

interface PromotionResult {
  canonical: string;
  action: string;
  severity: "confusion" | "info";
}

async function promote(
  ai: AiProvider,
  samples: string[]
): Promise<PromotionResult | null> {
  const user = samples.map((s) => `- ${s}`).join("\n");
  const out = await ai.complete(
    [
      { role: "system", content: PROMPT_SYSTEM },
      { role: "user", content: user },
    ],
    { temperature: 0.2, maxTokens: 120 }
  );
  if (!out) return null;
  const canonical = /^CANONICAL:\s*(.+)$/im.exec(out)?.[1]?.trim() ?? "";
  const action = /^ACTION:\s*(.+)$/im.exec(out)?.[1]?.trim() ?? "";
  const severity = /SEVERITY:\s*confusion/i.test(out) ? "confusion" : "info";
  if (!canonical) return null;
  return { canonical, action, severity };
}

export function clusterAlertText(cluster: ClusterRow): string {
  return [
    `⚠️ COMMUNITY CONFUSION`,
    ``,
    `${cluster.count} members are asking:`,
    `❓ ${cluster.canonical_question ?? cluster.label}`,
    ``,
    cluster.suggested_action ? `💡 Suggested action: ${cluster.suggested_action}` : `💡 Suggested action: publish a clarification.`,
  ].join("\n");
}

/**
 * One analyzer cycle for one chat. Returns what happened, for tests and logs.
 */
export async function analyzeChat(deps: AnalyzerDeps, chatId: number, opts: AnalyzerOptions): Promise<{ embedded: number; promoted: number; alerts: number }> {
  const result = { embedded: 0, promoted: 0, alerts: 0 };

  const pending = deps.db.unanalyzedQuestions(chatId, 200);
  if (pending.length === 0) return result;

  // Snapshot open clusters once; classify against this, mutate after.
  const open = deps.db.openClusters(chatId);
  let states: ClusterState[] = open.map((c) => ({
    id: c.id,
    centroid: unpackEmbedding(c.centroid),
    count: c.count,
    firstSeen: c.first_seen,
    lastSeen: c.last_seen,
    labeled: c.canonical_question !== null,
  }));

  const analyzedNow: number[] = [];
  for (const msg of pending) {
    const emb = await deps.ai.embed(msg.text);
    if (emb.length === 0) continue; // embedder down — leave unanalyzed, retry next cycle
    analyzedNow.push(msg.id);
    result.embedded++;

    const idx = classifyQuestion(emb, states, opts.similarityThreshold);
    if (idx >= 0) {
      const st = states[idx];
      if (!st) continue;
      const centroid = updateClusterCentroid(st.centroid, emb, st.count);
      deps.db.updateCluster(st.id, packEmbedding(centroid), msg.ts);
      st.centroid = centroid;
      st.count += 1;
      st.lastSeen = msg.ts;
    } else {
      const id = deps.db.addCluster(chatId, msg.text.slice(0, 120), packEmbedding(emb), msg.ts);
      states.push({
        id,
        centroid: emb,
        count: 1,
        firstSeen: msg.ts,
        lastSeen: msg.ts,
        labeled: false,
      });
    }
  }
  deps.db.markAnalyzed(analyzedNow);

  // Promotion pass over open clusters.
  const now = Math.floor(Date.now() / 1000);
  for (const st of states) {
    if (!clusterIsPromotable(st, opts.alertThreshold, opts.alertWindowHours, now)) continue;
    const cluster = deps.db.getCluster(st.id);
    if (!cluster) continue;
    const samples = pending
      .filter((m) => m.text.length > 0)
      .slice(-8)
      .map((m) => m.text);
    const res = await promote(deps.ai, samples.length > 0 ? samples : [cluster.label]);
    if (res) {
      deps.db.setClusterResolved(st.id, res.canonical, res.action);
      st.labeled = true;
      result.promoted++;
      if (res.severity === "confusion") {
        const dest = deps.getSetting(chatId, "alertDestination") || "group";
        if (dest !== "off") {
          const ok = await deps.postAlert(chatId, clusterAlertText({ ...cluster, canonical_question: res.canonical, suggested_action: res.action }));
          if (ok) result.alerts++;
        }
      }
    }
    // LLM failed → leave unlabeled; it will retry next cycle.
  }

  return result;
}
