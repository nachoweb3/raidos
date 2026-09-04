import type { BrainDb } from "../database/db.js";
import type { TokenStats } from "../market/providers.js";
import { gatherSignals, filterByCooldown, DEFAULT_SIGNAL_OPTIONS, type ContentSignal, type SignalOptions } from "./signals.js";
import { renderFromSignal, type RenderedSuggestion } from "./templates.js";

/**
 * 💡 CONTENT SUGGESTER — turns measured signals into 0–3 ranked proposals.
 * Rule-based ranking first (signal strength × priority), LLM-assisted narrative
 * lines can layer on later without changing this surface. Every proposal keeps
 * the signal that produced it, so published posts stay traceable.
 */

export interface SuggestionProposal extends RenderedSuggestion {
  signalKind: string;
  signalDetail: string;
  strength: number;
}

/** Priority per signal kind (higher = proposed first when strengths tie). */
const PRIORITY: Record<string, number> = {
  kb_gap: 0.3, // admin nudge, cheap and high-value
  market_alert: 0.2,
  raid_completed: 0.1,
  confusion_cluster: 0.1,
  pulse_recap: 0,
  quest_milestone: 0,
  join_spike: -0.1,
};

export const MAX_SUGGESTIONS = 3;

/**
 * Rank signals into at most 3 proposals. Signals whose template cannot be
 * rendered honestly are dropped; signals on cooldown never reach here.
 */
export function rankSignals(signals: ContentSignal[]): SuggestionProposal[] {
  const proposals: SuggestionProposal[] = [];
  for (const signal of signals) {
    const rendered = renderFromSignal(signal);
    if (!rendered) continue;
    proposals.push({
      kind: rendered.kind,
      text: rendered.text,
      signalKind: signal.kind,
      signalDetail: signal.detail,
      strength: signal.strength,
    });
  }
  return proposals
    .map((p) => ({ p, score: p.strength + (PRIORITY[p.signalKind] ?? 0) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SUGGESTIONS)
    .map((x) => x.p);
}

/**
 * One suggestion pass for a chat: gather → cooldown-filter → render → rank →
 * persist as `proposed`. Returns the stored proposals (with ids) for the
 * command layer to present.
 */
export function suggestForChat(
  db: BrainDb,
  chatId: number,
  marketKinds: string[] = [],
  marketStats: TokenStats | null = null,
  opts: SignalOptions = DEFAULT_SIGNAL_OPTIONS,
  now = Math.floor(Date.now() / 1000)
): { proposals: (SuggestionProposal & { id: number })[]; cooled: string[] } {
  const signals = gatherSignals(db, chatId, marketKinds, marketStats, opts, now);
  const { ready, cooled } = filterByCooldown(db, chatId, signals, opts, now);
  const ranked = rankSignals(ready);

  const proposals: (SuggestionProposal & { id: number })[] = [];
  for (const p of ranked) {
    const signalBlob = JSON.stringify({ kind: p.signalKind, detail: p.signalDetail });
    const id = db.addContentSuggestion(chatId, p.kind, p.signalKind, signalBlob, p.text, now);
    proposals.push({ ...p, id });
  }
  return { proposals, cooled };
}
