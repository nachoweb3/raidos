import type { AiMessage, AiProvider } from "./provider.js";

/**
 * ☁️ CLOUD PROVIDER (OpenAI-compatible)
 * Works with OpenAI, Groq, OpenRouter, DeepSeek, Together, Fireworks, or any
 * /v1/chat/completions + /v1/embeddings endpoint. This is what makes RaidOS
 * hostable: no local Ollama required, one server can serve many communities.
 *
 * Config via env (see .env.example):
 *   AI_PROVIDER=openai
 *   OPENAI_BASE_URL=https://api.openai.com/v1   (or Groq/OpenRouter/…)
 *   OPENAI_API_KEY=sk-...
 *   CHAT_MODEL=gpt-4o-mini
 *   EMBED_MODEL=text-embedding-3-small
 */
export class CloudProvider implements AiProvider {
  readonly name: string;

  constructor(
    private model: string,
    private embedModel: string,
    private baseUrl: string,
    private apiKey: string,
    /** Injectable for tests. */
    private fetchImpl: typeof fetch = fetch
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.name = `cloud:${model}`;
  }

  async available(): Promise<boolean> {
    if (!this.apiKey) return false;
    return true;
  }

  async complete(
    messages: AiMessage[],
    opts?: { temperature?: number; maxTokens?: number; timeoutMs?: number }
  ): Promise<string> {
    const timeoutMs = opts?.timeoutMs ?? 60_000;
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          temperature: opts?.temperature ?? 0.7,
          max_tokens: opts?.maxTokens ?? 400,
          messages,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return "";
      const json: any = await res.json();
      const text: string = json?.choices?.[0]?.message?.content ?? "";
      return text.trim();
    } catch {
      return "";
    }
  }

  async embed(text: string, timeoutMs = 20_000): Promise<number[]> {
    if (!this.apiKey) return [];
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.embedModel, input: text }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return [];
      const json: any = await res.json();
      const arr: unknown = json?.data?.[0]?.embedding;
      return Array.isArray(arr) ? (arr as number[]) : [];
    } catch {
      return [];
    }
  }
}
