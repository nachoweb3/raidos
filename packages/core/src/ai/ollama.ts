import type { AiMessage, AiProvider } from "./provider.js";

/**
 * 🦙 OLLAMA PROVIDER
 * Chat completions via /api/chat, embeddings via /api/embed.
 * All local — message text never leaves the host machine.
 */
export class OllamaProvider implements AiProvider {
  readonly name: string;

  constructor(
    private model: string,
    private embedModel: string,
    private baseUrl = "http://127.0.0.1:11434"
  ) {
    this.name = `ollama:${model}`;
  }

  async available(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(2000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async complete(
    messages: AiMessage[],
    opts?: { temperature?: number; maxTokens?: number; timeoutMs?: number }
  ): Promise<string> {
    const timeoutMs = opts?.timeoutMs ?? 60_000;
    try {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          options: {
            temperature: opts?.temperature ?? 0.7,
            num_predict: opts?.maxTokens ?? 400,
          },
          messages,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return "";
      const json: any = await res.json();
      let text: string = json?.message?.content ?? "";
      // Strip <think>...</think> blocks that reasoning models emit.
      text = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      if (!text && json?.thinking) {
        const t: string = String(json.thinking);
        const tail = t.split(/\n/).filter(Boolean).pop() ?? "";
        text = tail.trim();
      }
      return text;
    } catch {
      return "";
    }
  }

  async embed(text: string, timeoutMs = 20_000): Promise<number[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.embedModel, input: text }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return [];
      const json: any = await res.json();
      const arr: unknown = json?.embeddings?.[0] ?? json?.embedding;
      return Array.isArray(arr) ? (arr as number[]) : [];
    } catch {
      return [];
    }
  }
}
