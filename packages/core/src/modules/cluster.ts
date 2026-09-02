/**
 * 🧲 CLUSTERING (pure functions — no I/O, fully unit-testable)
 * A question joins the most similar open cluster when cosine >= threshold;
 * otherwise it founds a new one. Centroids are running means, re-normalized.
 */

export interface ClusterState {
  id: number;
  centroid: number[];
  count: number;
  firstSeen: number;
  lastSeen: number;
  labeled: boolean;
}

/**
 * Best matching cluster index for an embedding, or -1 when nothing is close.
 */
export function classifyQuestion(
  embedding: number[],
  clusters: ClusterState[],
  similarityThreshold: number
): number {
  let best = -1;
  let bestScore = similarityThreshold;
  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i];
    if (!c) continue;
    const score = cosine(embedding, c.centroid);
    if (score >= bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** Running-mean centroid: (centroid * count + embedding) / (count + 1), normalized. */
export function updateClusterCentroid(
  centroid: number[],
  embedding: number[],
  count: number
): number[] {
  if (embedding.length !== centroid.length) return centroid;
  const total = count + 1;
  const out = centroid.map((c, i) => (c * count + (embedding[i] ?? 0)) / total);
  const norm = Math.sqrt(out.reduce((s, x) => s + x * x, 0));
  if (norm === 0) return centroid;
  return out.map((x) => x / norm);
}

/**
 * Promotion rule: the cluster crossed `threshold` messages inside `windowHours`
 * (burst of confusion), is still unlabeled, and the burst is recent.
 */
export function clusterIsPromotable(
  cluster: Pick<ClusterState, "count" | "firstSeen" | "lastSeen" | "labeled">,
  threshold: number,
  windowHours: number,
  now: number
): boolean {
  if (cluster.labeled) return false;
  if (cluster.count < threshold) return false;
  const windowSec = windowHours * 3600;
  const burstWithinWindow = cluster.lastSeen - cluster.firstSeen <= windowSec;
  const burstIsRecent = now - cluster.lastSeen <= windowSec;
  return burstWithinWindow && burstIsRecent;
}
