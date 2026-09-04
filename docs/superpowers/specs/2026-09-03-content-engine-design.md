# Content Engine — V2 Design Spec

**Date:** 2026-09-03
**Status:** Implemented (V2 — signals, templates, suggest/approve/schedule/publish, performance trail)
**Origin:** V2 extension of the Community Brain, built on top of the shipped RaidOS
        intelligence + market + engagement layers.

---

## 1. Product definition

**Content Engine** is the layer that turns the Community Brain's passive intelligence
into **active, scheduled, data-grounded posts** the community admin can review, tweak,
and publish — or let the bot post on a schedule.

It answers one question the brain already knows the ingredients for:

> *"Given what this community is asking, what the token is doing, and what just
>  happened in a raid — what should be posted next, and when?"*

**Pitch:** *Your community's brain doesn't just answer — it tells you what to post.*

**Selling points:**
- Recommendations are grounded in measured signals (confusion clusters, pulse metrics,
  market alerts, raid completion), not invented engagement.
- Admins stay in the loop: the engine proposes, the admin approves, edits, or schedules —
  or enables auto-publish per channel.
- Honesty rules carry over: every suggested post is traceable to a real signal; no
  fabricated momentum, no fake FOMO lines.

### V2 scope

**In scope:**
1. Signal aggregation — one place where brain signals, market signals, and raid/quest
   signals converge per chat.
2. Post templates — parameterized templates (announcement, recap, reminder, spotlight,
   market update, raid wrap) that render from real data.
3. Recommendation surface — `/content suggest` (admin) and a scheduled digest that proposes
   1–3 posts with the signal each one is based on.
4. Approval & scheduling — admin approves/edits/schedules; optional auto-publish to group
   or linked X account (X integration is a V2+ integration point, gated behind config).
5. Performance trail — which suggestions were published, engagement after publish (measured,
   labeled SELF-REPORTED), so the engine can learn which template/signal combos work.

**Explicitly out of scope (V3+):** autonomous multi-channel posting without admin approval,
paid placement / sponsored content injection (that belongs in the trending engine's
SPONSORED lane, not here), image generation for memes (separate capability), and
scam/impersonation detection.

### Relationship to other layers

- **Community Brain (V1):** provides the signal source — confusion clusters, pulse,
  `/brain` insights, knowledge base gaps.
- **Volume Intelligence (shipped):** provides market context for market-update and
  momentum posts.
- **Raid Engine + XP (shipped):** provides engagement events to turn into recaps and
  spotlights.
- **Trending engine (planned):** when it ships, sponsored placements are a separate lane.
  The content engine can *reference* trending placements as a signal ("someone paid to
  be featured"), but does not invent or amplify them on its own.

---

## 2. Architecture

```
Telegram → index.ts (grammY)
   ├─ content/
   │   ├─ signals.ts      gather per-chat signals from brain + market + raids
   │   ├─ templates.ts    post templates + render functions (pure functions, testable)
   │   ├─ suggest.ts      from signals → ranked suggestions (rule-based first, LLM-assisted later)
   │   ├─ scheduler.ts    per-chat schedule; publish or notify admin
   │   ├─ approval.ts     /content approve|edit|schedule|publish|skip
   │   └─ trail.ts        published suggestions + measured post-publish engagement
   ├─ admin.ts            /content panel (generalizes /config panel pattern)
   └─ ai/                 optional LLM assist for narrative lines in templates (same provider abstraction)
```

The content engine does **not** sit on the hot message path. It runs on the same analyzer
schedule the brain already has (or a gentler cadence), reads already-captured aggregates,
and writes suggestions into a new `content_suggestions` table.

Components follow the existing isolation pattern: features receive a typed API surface
(sendMessage/editMessage/answerCallback) and never import the Bot instance directly.

### Tenancy

Same `chat_id` tenancy as the rest of the product. Each community has its own signal
profile, its own template defaults, and its own approval preference. One bot, many
independent content engines.

---

## 3. Data model (SQLite, extends existing)

New tables only. Existing tables are untouched.

| Table | Columns | Notes |
|---|---|---|
| `content_templates` | id, chat_id, kind, template, enabled, params JSON | per-chat template overrides; kind = announcement\|recap\|reminder\|spotlight\|market_update\|raid_wrap |
| `content_suggestions` | id, chat_id, ts, template_id, signal JSON, text, status(proposed\|approved\|edited\|scheduled\|published\|skipped), published_at, published_text | audit trail of what was suggested and what happened to it |
| `content_schedule` | id, chat_id, suggestion_id, scheduled_at, channel(group\|x), status(pending\|done\|missed) | when auto-publish is enabled |
| `content_performance` | id, chat_id, suggestion_id, measured JSON, label SELF-REPORTED, ts | measured engagement after publish (messages in window, reactions, new asks) |

Signal JSON and measured JSON are opaque blobs the engine can evolve without migrations.
For V2 they carry the specific signal that triggered the suggestion plus a small measured
window after publish.

---

## 4. Signals (the input side)

The engine only recommends posts when there is a real signal to ground them in. V2 signal
sources, all already captured or computable from shipped layers:

- **Confusion cluster just promoted** → "people keep asking X" announcement or FAQ draft.
- **Knowledge base gap** → "we keep getting asked things we don't have an official answer for"
  nudge to the admin, not a post to the group.
- **Pulse weekly summary** → "here's what your community did this week" recap template.
- **Market alert fired** → market update post (price/volume/liquidity card), gated so it
  doesn't spam on every tick — cooldown per signal type.
- **Raid completed** → raid wrap: what was accomplished, measured participation (SELF-REPORTED),
  winner spotlight if applicable.
- **Quest milestone** → reminder or celebration post when a quest is close to finishing or
  just finished.
- **New member join spike** → welcome nudge template (deterministic, not LLM-invented).

Signals have a cooldown per chat per kind, so the engine doesn't recommend the same thing
twice in a short window. Cooldowns are configurable per template kind.

---

## 5. Templates (the output side)

Templates are parameterized strings rendered from real data. V2 ships deterministic
templates first; LLM-assisted narrative lines are optional and only used where the signal
already supports a narrative (e.g., pulse narrative line that already exists).

Rules that apply to every template:
- No invented numbers. If a template needs a number, it comes from a measured signal.
- No fabricated momentum phrases. "🔥 accelerating" only appears when the market card
  already says so.
- Every published post is traceable to the suggestion + signal that produced it.
- If a template cannot be rendered honestly from available signals, it is not suggested.

Example template kinds (render functions are pure and testable):

- **announcement** — "Hey community — quick update:" + reason + fact from KB.
- **recap** — pulse-derived: activity this week, questions answered vs. open, top cluster.
- **market_update** — market card text, same data as `/volume`, cooldown-per-signal.
- **raid_wrap** — raid report data + measured participation (SELF-REPORTED) + optional
  winner spotlight.
- **reminder** — quest or raid starting soon, deterministic from schedule.
- **spotlight** — member or contributor highlight, only when there is a real reason
  (quest completion, top raid contribution, badge earned).

---

## 6. Suggestion → approval → publish

**Admin flow (V2 default):**
1. `/content suggest` → engine returns 0–3 proposed posts, each with:
   - the rendered text,
   - the signal it's based on (short, readable),
   - the template kind.
2. Admin can:
   - approve as-is,
   - edit the text before approving,
   - schedule it (immediate or later),
   - skip it.
3. If scheduled/auto-publish is enabled for that chat+channel, the engine posts on schedule.
   Otherwise the admin posts manually or asks the bot to post the approved text.

**Auto-publish (optional, per chat+channel):**
- Opt-in setting, not default.
- Cooldown + admin override still apply.
- Every auto-published post still writes to `content_suggestions` with `published_at` and
  the published text, so there is a full trail.

**X integration (V2+):**
- Posted to a linked X account only when configured and only for templates/signal combos
  the admin enabled.
- Same honesty rules: no invented traction numbers.

---

## 7. Performance trail

After a post is published, the engine records a small measured window of what happened next
(messages in the group, new questions, reactions if available, new members if available).
All of it is labeled SELF-REPORTED and stored in `content_performance`.

This is not a vanity metric system. It is a feedback loop: which template × signal combos
actually get a community to respond. Over time that lets the engine rank suggestions better
and gives admins a real "what works" view in `/content stats`.

---

## 8. Monetization angle

Content engine is the **V2 upsell** that sits on top of managed hosting:

- Communities on hosting already have the brain, market, raids, and gamification.
- Content engine adds "your brain tells you what to post" — a concrete, recurring-value
  feature that is easy to describe in a pitch and easy to charge for as a higher hosting tier
  or add-on.
- It does not require trending to ship. It can ship as a standalone V2 feature and still
  be sellable.
- When trending ships, sponsored placements are a separate lane. Content engine can reference
  them but does not depend on them.

Suggested tier language (to align with the existing pricing story, not to lock prices yet):
- Current hosting tiers → brain + market + raids + gamification.
- Next tier / add-on → content engine (suggest + approve + schedule + performance trail).

---

## 9. Testing

Vitest:
- Unit: template render functions (pure), signal → suggestion ranking rules, cooldown logic,
  schedule resolution.
- Integration: suggestion pipeline against mocked signal sources and mocked bot API surface.
- Manual: `/content suggest` in a real test group with real brain + market data, admin
  approve/edit/schedule/publish loop.

---

## 10. Non-goals (recap)

No autonomous posting without admin approval in V2. No sponsored-content injection (that's
the trending engine's SPONSORED lane). No image generation. No scam detection. No
multi-channel blasting without explicit per-channel opt-in.

---

## 11. Implementation plan (rough)

Phase 1 — Signal gathering (`content/signals.ts`): one place that returns per-chat signals
from brain + market + raids, with cooldowns.

Phase 2 — Templates (`content/templates.ts`): template kinds + pure render functions,
testable without a bot.

Phase 3 — Suggestion + approval (`content/suggest.ts`, `content/approval.ts`, admin command
`/content suggest|approve|edit|schedule|publish|skip`).

Phase 4 — Scheduler + trail (`content/scheduler.ts`, `content/trail.ts`), optional
auto-publish per chat+channel.

Phase 5 — `/content stats` (performance trail view for admins).

Phase 6 — Tests + typecheck + build + manual smoke.

End of spec.
