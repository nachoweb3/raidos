import type { AiProvider, AiMessage } from "./provider.js";

/**
 * 🦙 OLLAMA PROVIDER
 * Local models via Ollama's /api/chat. No API keys, runs on the host machine.
 * Handles "thinking" models that emit <think> blocks or a `thinking` field.
 */
export class OllamaProvider implements AiProvider {
  readonly name = "ollama";
  constructor(
    private model: string,
    private baseUrl = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434"
  ) {}

  setModel(model: string): void {
    this.model = model;
  }
  getModel(): string {
    return this.model;
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
    try {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          options: { temperature: opts?.temperature ?? 0.9, num_predict: opts?.maxTokens ?? 300 },
          messages,
        }),
        signal: AbortSignal.timeout(opts?.timeoutMs ?? 60_000),
      });
      if (!res.ok) return "";
      const json: any = await res.json();
      let text: string = json?.message?.content ?? "";
      // Strip <think>...</think> blocks that reasoning models emit.
      text = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      if (!text && json?.thinking) {
        // Some models put everything in "thinking"; salvage the last line.
        const t: string = String(json.thinking);
        const tail = t.split("\n").filter(Boolean).pop() ?? "";
        text = tail.trim();
      }
      return text;
    } catch {
      return "";
    }
  }
}
