/**
 * 🤖 AI PROVIDER ARCHITECTURE
 *
 * AI Provider → AI Service → Prompt Engine → Feature
 *
 * Any backend (Ollama, OpenAI, Anthropic, a mock) implements `AiProvider`
 * and registers itself. Features never import a concrete provider, so new
 * backends can be added without touching feature code.
 */

export interface AiMessage {
  role: "system" | "user";
  content: string;
}

export interface AiProvider {
  /** Human-readable name shown in logs and the admin panel. */
  readonly name: string;
  /** True if the backend can answer right now. */
  available(): Promise<boolean>;
  /** Generate a completion. Returns "" on failure/timeout — callers fall back. */
  complete(messages: AiMessage[], opts?: { temperature?: number; maxTokens?: number; timeoutMs?: number }): Promise<string>;
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
