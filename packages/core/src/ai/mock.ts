import type { AiMessage, AiProvider } from "./provider.js";

/**
 * 🧪 MOCK PROVIDER (tests / offline dev)
 * Deterministic: hash-based embeddings, scripted chat replies via `script`.
 */
export class MockProvider implements AiProvider {
  readonly name = "mock";
  /** When set, complete() returns script(messages); otherwise a canned line. */
  public script: ((messages: AiMessage[]) => string) | null = null;
  public embedDim = 16;
  public failComplete = false;

  async available(): Promise<boolean> {
    return true;
  }

  async complete(messages: AiMessage[]): Promise<string> {
    if (this.failComplete) return "";
    if (this.script) return this.script(messages);
    return "mock answer";
  }

  async embed(text: string): Promise<number[]> {
    const v = new Array<number>(this.embedDim).fill(0);
    const tokens = text.toLowerCase().split(/[^a-z0-9áéíóúñü]+/i).filter(Boolean);
    for (const tok of tokens) {
      let h = 2166136261;
      for (let i = 0; i < tok.length; i++) {
        h ^= tok.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      v[Math.abs(h) % this.embedDim] = (v[Math.abs(h) % this.embedDim] ?? 0) + 1;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
}
