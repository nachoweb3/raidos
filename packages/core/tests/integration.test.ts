import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainDb } from "../src/database/db.js";
import { MockProvider } from "../src/ai/mock.js";
import { isQuestion } from "../src/modules/questions.js";
import { analyzeChat, DEFAULT_ANALYZER_OPTIONS, clusterAlertText } from "../src/modules/analyzer.js";
import { ask, FALLBACK_ANSWER } from "../src/modules/ask.js";
import { learnText } from "../src/modules/kb.js";
import { communityMemory, memoryText, matchOpenCluster } from "../src/modules/memory.js";

/**
 * Integration tests with a deterministic MockProvider: hash embeddings make
 * identical/paraphrase questions cluster together, unrelated ones apart.
 */

function newDb(): { db: BrainDb; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "brain-test-"));
  const db = new BrainDb(join(dir, "test.db"));
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function depsFor(db: BrainDb, ai: MockProvider, alerts: string[] = []) {
  return {
    db,
    ai,
    postAlert: async (chatId: number, text: string) => {
      alerts.push(text);
      return true;
    },
    getSetting: () => "group",
    isActive: () => true,
  };
}

describe("analyzer pipeline", () => {
  let env: { db: BrainDb; cleanup: () => void };
  let ai: MockProvider;
  let alerts: string[];
  beforeEach(() => {
    env = newDb();
    ai = new MockProvider();
    ai.script = () =>
      ["CANONICAL: when launch?", "ACTION: publish launch date announcement", "SEVERITY: confusion"].join("\n");
    alerts = [];
  });
  afterEach(() => env.cleanup());

  it("clusters identical questions and promotes the burst with an alert", async () => {
    const { db, cleanup } = env;
    const chatId = -100123;
    const texts = [
      "when launch?",
      "when launch?",
      "when launch?",
      "when launch?",
      "when launch?",
    ];
    for (const t of texts) db.addMessage(chatId, 1, t, isQuestion(t));

    const r1 = await analyzeChat(depsFor(db, ai, alerts), chatId, DEFAULT_ANALYZER_OPTIONS);
    expect(r1.embedded).toBe(5);

    const clusters = db.listClusters(chatId);
    expect(clusters.length).toBe(1);
    expect(clusters[0]!.count).toBe(5);
    expect(alerts.length).toBe(1);
    expect(alerts[0]).toContain("COMMUNITY CONFUSION");
    expect(clusterAlertText(clusters[0]!)).toContain("when launch?");
  });

  it("separates unrelated questions into distinct clusters", async () => {
    const { db, cleanup } = env;
    const chatId = -100123;
    const texts = ["when launch?", "how do rewards work?", "where is the roadmap?", "who built this?"];
    for (const t of texts) db.addMessage(chatId, 1, t, isQuestion(t));
    await analyzeChat(depsFor(db, ai), chatId, DEFAULT_ANALYZER_OPTIONS);
    expect(db.listClusters(chatId).length).toBe(4);
  });

  it("does not re-alert on later cycles (labeled once)", async () => {
    const { db, cleanup } = env;
    const chatId = -100123;
    for (let i = 0; i < 5; i++) db.addMessage(chatId, 1, "when launch?", isQuestion("when launch?"));
    await analyzeChat(depsFor(db, ai, alerts), chatId, DEFAULT_ANALYZER_OPTIONS);
    db.addMessage(chatId, 2, "when launch?", true);
    await analyzeChat(depsFor(db, ai, alerts), chatId, DEFAULT_ANALYZER_OPTIONS);
    expect(alerts.length).toBe(1);
  });

  it("survives a down embedder (nothing marked analyzed, nothing crashes)", async () => {
    const { db, cleanup } = env;
    const chatId = -100123;
    db.addMessage(chatId, 1, "when launch?", true);
    // Simulate Ollama down: embed returns [].
    const broken = Object.create(ai) as MockProvider;
    broken.embed = async () => [];
    const r = await analyzeChat(depsFor(db, broken), chatId, DEFAULT_ANALYZER_OPTIONS);
    expect(r.embedded).toBe(0);
    expect(db.unanalyzedQuestions(chatId).length).toBe(1);
    expect(db.listClusters(chatId).length).toBe(0);
  });

  it("purges old message text but keeps the rows", () => {
    const { db, cleanup } = env;
    const chatId = -100123;
    db.addMessage(chatId, 1, "secret text", false);
    const n = db.purgeExpiredMessages(chatId, 0); // retention 0 → everything expires
    expect(n).toBe(1);
    expect(db.messageCount(chatId, 0)).toBe(1); // row kept for analytics
    cleanup();
  });
});

describe("community memory", () => {
  it("lists recurring questions sorted by count", async () => {
    const memoryEnv = newDb();
    const { db, cleanup } = memoryEnv;
    const ai = new MockProvider();
    const chatId = -100123;
    for (let i = 0; i < 4; i++) db.addMessage(chatId, 1, "when launch?", true);
    for (let i = 0; i < 2; i++) db.addMessage(chatId, 1, "how do rewards work?", true);
    await analyzeChat(depsFor(db, ai), chatId, DEFAULT_ANALYZER_OPTIONS);
    const memory = communityMemory(db, chatId);
    expect(memory[0]!.question).toContain("when launch?");
    expect(memoryText(memory)).toContain("×4");
    cleanup();
  });
});

describe("/ask grounding", () => {
  let env: { db: BrainDb; cleanup: () => void };
  let ai: MockProvider;
  beforeEach(() => {
    env = newDb();
    ai = new MockProvider();
  });

  it("answers from the KB when relevant", async () => {
    const { db, cleanup } = env;
    const chatId = -100123;
    await learnText(db, ai, chatId, "The rewards pool distributes 5% of every buy to holders weekly.", "manual", null);
    const res = await ask(db, ai, chatId, "how do the rewards work?");
    expect(res.grounded).toBe(true);
    expect(res.answer).toBe("mock answer");
  });

  it("refuses to answer without official info", async () => {
    const { db, cleanup } = env;
    const res = await ask(db, ai, -100123, "who is the ceo of polyphony digital?");
    expect(res.grounded).toBe(false);
    expect(res.answer).toBe(FALLBACK_ANSWER);
  });

  it("falls back honestly when the AI is down", async () => {
    const { db, cleanup } = env;
    const chatId = -100123;
    await learnText(db, ai, chatId, "Official website is https://example.com", "manual", null);
    ai.failComplete = true;
    const res = await ask(db, ai, chatId, "what is the official website?");
    expect(res.grounded).toBe(false);
    expect(res.answer).toBe(FALLBACK_ANSWER);
  });
});

describe("matchOpenCluster", () => {
  it("finds the open cluster for a similar question", async () => {
    const matchEnv = newDb();
    const { db, cleanup } = matchEnv;
    const ai = new MockProvider();
    const chatId = -100123;
    for (let i = 0; i < 3; i++) db.addMessage(chatId, 1, "when launch?", true);
    await analyzeChat(depsFor(db, ai), chatId, DEFAULT_ANALYZER_OPTIONS);
    const qEmb = await ai.embed("when launch?");
    const hit = matchOpenCluster(db, chatId, qEmb);
    expect(hit).not.toBeNull();
    expect(hit!.question).toContain("when launch?");
    cleanup();
  });
});
