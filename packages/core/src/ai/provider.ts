/**
 * 🤖 AI PROVIDER ARCHITECTURE
 * Features ask the service; the service asks the active provider.
 * Ollama-only in production; a deterministic mock is registered for tests.
 */

export interface AiMessage {
  role: "system" | "user";
  content: string;
}

export interface AiProvider {
  /** Human-readable name shown in logs. */
  readonly name: string;
  /** True if the backend can answer right now. */
  available(): Promise<boolean>;
  /** Generate a chat completion. Returns "" on failure/timeout — callers fall back. */
  complete(messages: AiMessage[], opts?: { temperature?: number; maxTokens?: number; timeoutMs?: number }): Promise<string>;
  /** Embed a text. Returns [] on failure. */
  embed(text: string, timeoutMs?: number): Promise<number[]>;
}

/** Registry — features ask the service, the service asks the active provider. */
const registry = new Map<string, AiProvider>();

export function registerProvider(p: AiProvider): void {
  registry.set(p.name, p);
}

export function getProvider(name: string): AiProvider | undefined {
  return registry.get(name);
}

export function listProviders(): string[] {
  return [...registry.keys()];
}
