# Community Brain V1 — Implementation Plan

**Spec:** `docs/superpowers/specs/2026-09-02-community-brain-design.md`
**Stack:** TypeScript (NodeNext ESM), grammY, better-sqlite3, Vitest
**Location:** `community-brain/`

## Phase 1 — Scaffold
- `community-brain/` with `package.json` (typecheck/build/test scripts), `tsconfig.json` (NodeNext, strict), `.env.example`, `.gitignore`, `README.md`
- Deps: grammY, better-sqlite3, dotenv; dev: typescript, vitest, @types/better-sqlite3, @types/node

## Phase 2 — Data layer (`src/brain.db.ts`)
- Tables: `chats`, `settings`, `messages`, `question_clusters`, `kb_entries`, `insights`
- Query methods per spec; embeddings as Float32 BLOB helpers; `purgeExpiredMessages()`
- Module-level singleton `getDb(path)` for tests

## Phase 3 — AI layer (`src/ai/`)
- `provider.ts`: `AiProvider` interface + registry (from saur-bot's pattern)
- `ollama.ts`: OllamaProvider (chat + embed calls to `/api/chat`, `/api/embed`)
- `mock.ts`: deterministic MockProvider for tests

## Phase 4 — Domain
- `src/domain/questions.ts` — question heuristic (EN + ES interrogatives)
- `src/domain/embeddings.ts` — Float32↔BLOB, cosineSimilarity
- `src/domain/cluster.ts` — pure functions: `classifyQuestion`, `updateClusterCentroid`, `clusterIsPromotable`
- `src/domain/kb.ts` — `learnText` (chunk → embed → store), `retrieve` (top-k KB + answered clusters)
- `src/domain/ask.ts` — grounded answer; honest fallback when unsupported
- `src/domain/analyzer.ts` — per-cycle: embed unanalyzed, classify, promote, alert
- `src/domain/memory.ts` — top clusters per window
- `src/domain/pulse.ts` — deterministic metrics + one LLM narrative
- `src/domain/briefing.ts` — /brain composition

## Phase 5 — Bot wiring (`src/index.ts`, `src/admin.ts`)
- `/setup`, `/config` inline panel (per-chat, generalized from saur-bot)
- `/ask`, `/brain`, `/learn`, `/kb`, `/memory`, `/stats`
- `message:text` → capture + question flag; `new_chat_members` → welcome
- Analyzer interval; weekly pulse scheduler; OWNER_ID env

## Phase 6 — Tests (`tests/`)
- Unit: cosine, clustering, question heuristic, retrieval ranking, purge, migrations
- Integration: analyzer pipeline + /ask with MockProvider

## Phase 7 — Verification
- `npm run typecheck && npm run build && npm test` all green; fix as needed
- Commit
