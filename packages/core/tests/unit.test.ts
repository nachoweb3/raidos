import { describe, it, expect } from "vitest";
import { packEmbedding, unpackEmbedding, cosineSimilarity } from "../src/modules/embeddings.js";
import { isQuestion } from "../src/modules/questions.js";
import { classifyQuestion, updateClusterCentroid, clusterIsPromotable } from "../src/modules/cluster.js";
import { chunkText } from "../src/modules/kb.js";

describe("embeddings", () => {
  it("round-trips through Float32 BLOB", () => {
    const v = [0.1, -0.2, 0.3, 0.4, -0.5];
    const back = unpackEmbedding(packEmbedding(v));
    expect(back.length).toBe(v.length);
    back.forEach((x, i) => expect(x).toBeCloseTo(v[i]!, 5));
  });

  it("cosine of identical vectors is 1", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
  });

  it("cosine of orthogonal vectors is 0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });

  it("mismatched lengths are 0, not NaN", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe("question heuristic", () => {
  it("detects trailing ? in EN and ES", () => {
    expect(isQuestion("when launch?")).toBe(true);
    expect(isQuestion("¿cuándo sale?")).toBe(true);
  });

  it("detects interrogative starters without ?", () => {
    expect(isQuestion("how does the leaderboard work")).toBe(true);
    expect(isQuestion("cómo funciona el juego")).toBe(true);
  });

  it("rejects statements", () => {
    expect(isQuestion("gm frens, chart looking hot today")).toBe(false);
    expect(isQuestion("")).toBe(false);
    expect(isQuestion("ser moon")).toBe(false);
  });
});

describe("clustering", () => {
  const e1 = [1, 0, 0];
  const e1b = [0.95, 0.1, 0]; // near e1
  const e2 = [0, 1, 0]; // orthogonal

  it("classifies into the closest cluster above threshold", () => {
    const clusters = [
      { id: 1, centroid: e1, count: 1, firstSeen: 0, lastSeen: 0, labeled: false },
      { id: 2, centroid: e2, count: 1, firstSeen: 0, lastSeen: 0, labeled: false },
    ];
    expect(classifyQuestion([0.98, 0.05, 0], clusters, 0.82)).toBe(0);
    expect(classifyQuestion(e2, clusters, 0.82)).toBe(1);
  });

  it("creates a new cluster when nothing matches (-1)", () => {
    const clusters = [{ id: 1, centroid: e1, count: 1, firstSeen: 0, lastSeen: 0, labeled: false }];
    expect(classifyQuestion(e2, clusters, 0.82)).toBe(-1);
  });

  it("running-mean centroid stays normalized", () => {
    const c = updateClusterCentroid(e1, e1b, 1);
    const norm = Math.sqrt(c.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it("promotes only bursts inside the window that are unlabeled", () => {
    const now = 1_000_000;
    const ok = { count: 5, firstSeen: now - 3600, lastSeen: now - 60, labeled: false };
    expect(clusterIsPromotable(ok, 5, 48, now)).toBe(true);
    expect(clusterIsPromotable({ ...ok, count: 4 }, 5, 48, now)).toBe(false);
    expect(clusterIsPromotable({ ...ok, labeled: true }, 5, 48, now)).toBe(false);
    expect(clusterIsPromotable({ ...ok, firstSeen: now - 200 * 3600 }, 5, 48, now)).toBe(false);
  });
});

describe("kb chunking", () => {
  it("short text is a single chunk", () => {
    expect(chunkText("one simple fact")).toEqual(["one simple fact"]);
  });

  it("long text splits into bounded chunks", () => {
    const long = "A sentence about the token. ".repeat(60);
    const chunks = chunkText(long, 400);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(410);
  });
});
