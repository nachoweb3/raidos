# Community Brain — V1 Design Spec

**Date:** 2026-09-02
**Status:** Approved (pending implementation plan)
**Origin:** Evolution of the `saur-bot` concept into a multi-tenant product.

---

## 1. Product definition

**Community Brain** is a multi-tenant Telegram bot that gives any Telegram community
memory, intelligence, and automation. Instead of another `/price`-style command bot,
it passively understands what happens inside the group and turns conversation into
insight and answers.

**Pitch:** *Your community talks. We turn the conversation into intelligence and action.*

**Selling points:**
- Message text never leaves the host machine (Ollama-only AI).
- Communities get answers and insight without admins repeating themselves.
- Zero per-message AI cost; analysis runs in batches.

### V1 scope

**In scope:**
1. Message capture (all group text into SQLite, no AI on the hot path)
2. Community Memory — recurring-question detection and clustering
3. `/ask` — grounded Q&A against the community's knowledge base
4. Confusion alerts — auto-detected when a question spikes
5. Community Pulse — deterministic health metrics with an LLM narrative line
6. `/brain` — admin briefing: memory + confusion + pulse + recommended actions

**Explicitly out of scope (V2+):** content engine ("you should post this"),
missions/XP/gamification, contributor recognition, onboarding autopilot,
scam/impersonation detection. The schema leaves room for these.

### Key decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Product shape | New multi-tenant project, `community-brain/`, sibling of `saur-bot/` |
| V1 scope | Core + Insights (no content engine) |
| AI backend | Ollama only (privacy pitch preserved) |
| Architecture | Capture cheaply, analyze in batches; embeddings for clustering |
| Deployment | One shared Telegram bot, many groups; tenancy keyed by `chat_id` |
| Knowledge base | Curated (`/learn`) + auto-capture (pinned messages, admin posts) |

---

## 2. Architecture

```
Telegram → index.ts (grammY)
   ├─ capture.ts      every group text → messages table (pure insert, no AI on hot path)
   ├─ kb.ts           /learn, pinned-message + admin-post auto-capture, retrieval
   ├─ analyzer.ts     every 15 min per active chat: embed new questions (nomic-embed-text),
   │                  cluster by cosine sim, label promoted clusters (chat model)
   ├─ memory.ts       top recurring questions per window (SQL + cluster data)
   ├─ pulse.ts        deterministic metrics + one LLM narrative line, weekly post
   ├─ briefing.ts     /brain = memory + confusion + pulse + LLM recommended actions
   ├─ admin.ts        /setup + /config inline panel (per chat, generalizes saur-bot's)
   └─ ai/             saur-bot's provider pattern, Ollama-only, two roles: chat + embed
```

Components follow saur-bot's isolation patterns: features receive a typed API surface
(sendMessage/editMessage/answerCallback) and never import the Bot instance directly.

### Tenancy & permissions

- One DB, all rows keyed by `chat_id`. `chats` table registers known communities.
- A community activates the bot with `/setup` in its group. Chats are "active"
  for the analyzer when `brainEnabled` and they have unanalyzed questions.
- Per-chat admins = Telegram group administrators (fetched via `getChatAdministrators`)
  plus a global `OWNER_ID` env (bot operator).
- Bot must be a group admin, or the group must disable privacy mode, for message
  capture to work. `/setup` checks and reports this.

### AI providers

Reuses saur-bot's `AiProvider` abstraction (registry + `available()` + `complete()`)
with two roles:
- **Embed role:** `EMBED_MODEL` (default `nomic-embed-text`) — fast, ~50ms per call.
- **Chat role:** `CHAT_MODEL` (default `llama3.2:3b`) — labels, narratives, /ask answers.

Both talk to `OLLAMA_BASE_URL` (default `http://127.0.0.1:11434`).

---

## 3. Data model (SQLite, WAL)

| Table | Columns | Notes |
|---|---|---|
| `chats` | chat_id PK, title, added_at | one row per community |
| `settings` | chat_id, key, value | per-chat runtime settings |
| `messages` | id, chat_id, user_id, ts, text, is_question, analyzed | hot-path insert; **text purged after retentionDays (default 14); aggregates survive** |
| `question_clusters` | id, chat_id, label, canonical_question, count, first_seen, last_seen, status(open\|answered\|ignored), centroid BLOB | centroid = Float32 BLOB embedding |
| `kb_entries` | id, chat_id, source(manual\|pinned\|admin_post), content, embedding BLOB, added_by, ts, enabled | retrieval for /ask |
| `insights` | id, chat_id, ts, kind(confusion\|pulse\|briefing), payload JSON | generated reports, audit trail |

Embeddings are Float32 arrays serialized as BLOBs. Similarity is computed in JS —
V1 scale (hundreds of questions per chat) makes this fine; no vector DB needed.

**Auto-capture rule (explicit):** every message posted by a Telegram group admin
is auto-added to `kb_entries` with source `admin_post`; pinned messages are added
with source `pinned` (re-pinning replaces the previous pinned entry). Admins can
list and delete any entry via `/kb`, so noisy admin chatter is correctable.

### Per-chat settings (defaults in parentheses)

- `brainEnabled` (off until `/setup`)
- `alertThreshold` — cluster count in window to trigger confusion alert (5)
- `alertWindowHours` (48)
- `alertDestination` (`group` | `owner` | `off`)
- `clusterSimilarity` — cosine threshold for joining a cluster (0.82)
- `pulseDay`/`pulseHour` (weekly post schedule, default Monday 18:00 UTC)
- `retentionDays` (14) — message text retention
- `tone` — community personality hint injected into LLM prompts (neutral)
- `botName`/`botEmoji` — branding shown in bot messages

---

## 4. Clustering (core algorithm)

1. **Question detection (heuristic):** message ends with `?` or starts with an
   interrogative word (what/when/where/how/why/who/which/cuándo/dónde/cómo/...).
   Detected on the hot path at capture time, stored in `messages.is_question`.
2. **Embedding:** analyzer (every 15 min, per active chat) embeds unanalyzed questions.
3. **Clustering:** cosine similarity ≥ **0.82** against an open cluster's centroid →
   join (running-mean centroid update); otherwise create a new cluster.
4. **Promotion:** cluster reaching `alertThreshold` (default 5) messages within
   `alertWindowHours` (default 48) triggers one chat-model call that writes
   `canonical_question` + a suggested action.
5. **Confusion alert:** if the promoted cluster is growing and unanswered, post an
   alert (per `alertDestination`).

Failure modes: LLM down → label falls back to the most common literal text in the
cluster; analyzer skips the cycle; nothing crashes.

Thresholds (0.82, 5, 48h) live in config, not hardcoded.

---

## 5. /ask grounding

1. Embed the question.
2. Retrieve top-3 KB entries (cosine) + best matching answered clusters.
3. One chat-model call, grounded strictly on that retrieved context, with the
   explicit rule: *if the context does not contain the answer, respond exactly with
   "⚠️ I couldn't find an official answer to this."* plus a pointer to ask admins.
4. Never free-invent. If Ollama is down, /ask answers from pure KB-match or the
   honest fallback line.

---

## 6. Pulse & briefing

**Pulse** (weekly, scheduled per chat): deterministic metrics from SQL — active
users, messages, questions answered vs. open, top clusters, best hour — plus exactly
one LLM narrative line. No invented metrics.

**`/brain`** (admin command, on demand): composes memory + confusion + pulse +
LLM-generated recommended actions (one call). Renders like saur-bot's daily report.

---

## 7. Errors, privacy, ops

- Ollama unavailable → analyzer skips, /ask degrades to KB-match or honest fallback,
  bot still captures messages (analysis catches up later; `analyzed` flag).
- Single Node process. `docker compose` with an Ollama sidecar documented in README.
- Models via env (`CHAT_MODEL`, `EMBED_MODEL`, `OLLAMA_BASE_URL`).
- Message text purged after `retentionDays`; aggregates and clusters survive.
- Privacy pitch: message text never leaves the host machine.

---

## 8. Testing

Vitest (new for this repo):
- Unit: cosine similarity, clustering (join/create/promote), question heuristic,
  KB retrieval ranking, retention purge, migrations.
- Integration: analyzer pipeline and /ask against a **mocked Ollama provider**
  (registered via the provider abstraction).
- Manual: smoke test in a real Telegram test group.

---

## 9. Non-goals (recap)

No blockchain, no per-message LLM calls, no cloud API dependency, no Discord/X
integration in V1. Content engine, gamification, recognition, onboarding autopilot,
and scam detection are V2 candidates.
