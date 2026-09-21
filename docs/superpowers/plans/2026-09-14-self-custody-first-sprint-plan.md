# Self-Custody-First P0/P1 Sprint Implementation Plan

**Spec:** `docs/superpowers/specs/2026-09-14-self-custody-first-sprint-design.md`  
**Audit:** `AUDIT.md`  
**Execution policy:** implement incrementally; after each milestone run tests/typecheck and do not enable live custody.

## Constraints and delivery strategy

- Preserve the existing zero-dependency `node:http` API and SQLite implementation during this sprint.
- Keep `mock` mode working for deterministic development/tests.
- Do not expose live signing through the current private-key-based executor. Until unsigned self-custody transaction preparation and client-side signing are implemented and verified, live trade execution returns `403`.
- Do not reinterpret historical `trades` rows as settled fills without a verifiable receipt.
- Keep the existing public market/read routes available unless they directly violate a security acceptance criterion.
- Use one active terminal: redirect `site/trading.html` to `app.html` and remove its ability to execute mutations.

## Milestone 0 — Baseline and test harness

### 0.1 Establish package commands

- Verify the repository package manager and lockfile.
- Restore/install dependencies only with the repository's documented package manager if the checkout is missing them.
- Run `pnpm test`, `pnpm run typecheck`, and `pnpm run build` from `packages/app` where configured.
- Record baseline failures separately from implementation failures.

### 0.2 Add focused test helpers

- Extend the API test helper to accept arbitrary request headers, including `Idempotency-Key` and `Origin`.
- Add isolated server fixtures for `mock` and `live` modes.
- Add deterministic DB-level fixtures for lifecycle and position tests.

**Verification:** existing tests remain unchanged in behavior; baseline output is documented in the final audit update.

## Milestone 1 — Security policy and input validation

### 1.1 Define server policy helpers

**Files:** `packages/app/src/api/server.ts`, optionally new `packages/app/src/api/policy.ts`

- Add an explicit `isLive`/`requireMockOrBlocked` policy.
- In `live`, reject custodial wallet creation/import/deletion/signing paths with `403`.
- In `live`, reject `/api/trades/execute` until a self-custody transaction flow exists.
- Ensure `buildMockQuote` is called only when `appMode === "mock"`.
- On live quote provider errors, return a generic `503`/`502` response without a mock quote or provider internals.

### 1.2 Harden request validation

**Files:** `server.ts`, `router.ts`, tests

- Add bounded header access and `Idempotency-Key` extraction.
- Validate supported trade type (`swap` only in this sprint).
- Validate chain existence and same-chain requirement for spot swaps.
- Validate token fields and positive integer amount strings.
- Validate slippage as an integer bps value within a server-defined bound.
- Reject malformed numeric query limits instead of allowing `NaN` into queries.
- Make body size rejection terminate cleanly without a second response.

### 1.3 Secure feed mutations

**Files:** `server.ts`, tests

- Change `POST /api/feed/post` from `publicRoute` to authenticated `route`.
- Replace `ctx.userId ?? 1` with `requireUserId(ctx)`.
- Validate that an optional `launchId` belongs to a resource visible/usable by the caller.
- Keep GET feed public, but never infer an actor for mutation.

### 1.4 Origin and security headers

**Files:** `server.ts`, `router.ts`, hosting config only if necessary

- Add configurable `ALLOWED_ORIGINS`; use same-origin/default local behavior when unset rather than `*` for authenticated responses.
- Handle CORS preflight using the allowlist.
- Add `X-Content-Type-Options`, `Referrer-Policy`, `Content-Security-Policy` baseline, and `Cache-Control` for sensitive API responses.
- Do not claim HSTS from the Node server unless deployment terminates HTTPS; document proxy responsibility.
- Preserve static asset behavior while preventing unsafe framing.

**Tests:** live quote failure, feed auth/actor spoofing, input boundaries, CORS allow/deny, custody live blocking, security headers.

## Milestone 2 — Durable intent/transaction/fill lifecycle

### 2.1 Add SQLite schema

**File:** `packages/app/src/database/app-db.ts`

Add idempotent tables and indexes:

- `execution_intents`: `id`, `user_id`, `endpoint`, `idempotency_key`, `request_hash`, canonical params, `mode`, lifecycle status, timestamps, result/error metadata.
- `execution_transactions`: `id`, `intent_id`, `chain`, `tx_hash`, `status`, receipt metadata, timestamps, error metadata.
- `execution_fills`: `id`, `transaction_id`, `user_id`, `chain`, sell/buy assets and exact amounts, fee, settlement source, settlement timestamp.

Add unique constraint on `(user_id, endpoint, idempotency_key)` and indexes for user/status/tx hash.

### 2.2 Add typed lifecycle module

**New file:** `packages/app/src/trading/lifecycle.ts`

- Define `created`, `submitted`, `pending`, `confirmed`, `settled`, and `failed` types.
- Define allowed transitions and reject invalid transitions.
- Provide canonical request serialization/hash helper with stable key ordering.
- Keep transition writes atomic through DB methods.

### 2.3 Add DB operations

**File:** `app-db.ts`

Implement methods to:

- create or fetch an intent by user/endpoint/key;
- detect hash mismatch and return conflict data;
- atomically claim a new intent;
- create/update transaction rows;
- create a fill exactly once;
- list pending intents for reconciliation;
- expose lifecycle details by intent/trade.

### 2.4 Integrate mock execution first

**Files:** `server.ts`, `executors.ts`

- Require `Idempotency-Key` for execute.
- In mock mode, create intent → submitted/pending → confirmed/settled deterministically through the lifecycle service.
- Create a settled fill before updating positions, feed, and rewards.
- Return `202` for pending live-like flows and a clear mock result for deterministic mock completion, preserving current tests only where the new contract explicitly supports it.
- Ensure duplicate requests return the existing result and never create duplicate fees/rewards/positions.

**Tests:** lifecycle transition unit tests, duplicate same key, same key with changed payload (`409`), concurrent duplicate requests, restart-safe pending query, mock settled fill.

## Milestone 3 — Remove custody from live execution path

### 3.1 Block existing custodial endpoints in live

**Files:** `server.ts`, `wallets/manager.ts` only if needed

- Add an explicit live-mode guard before reading passwords or encrypted keys.
- Ensure live requests do not call `decrypt`, `verifyPassword`, or executor methods that accept `privateKey`.
- Return a stable error directing the client to a connected-wallet/self-custody flow.

### 3.2 Refactor executor contract

**File:** `packages/app/src/api/executors.ts`

- Separate `submit` output from confirmation.
- Replace `status: "confirmed"` after broadcast with `submitted`/`pending`.
- Keep old private-key executor functions unavailable to the live API; retain only for explicit mock/test compatibility if necessary.
- Add a provider-neutral receipt status type.

### 3.3 Define future self-custody boundary

**Files:** new `packages/app/src/trading/self-custody.ts` or interface-only module, API contract docs

- Define request/response interfaces for unsigned transaction preparation and externally signed submission.
- Do not advertise the interface as live until a chain adapter and frontend wallet adapter are implemented.
- If no safe unsigned transaction path is available for the current provider, return `501`/`403` and keep live disabled.

**Tests:** live wallet create/import/execute never decrypts or signs; executor returns pending after submission; private key/password absence in live path.

## Milestone 4 — Canonical settled accounting and position engine

### 4.1 Decide exact unit contract

**Files:** `packages/app/src/trading/positions.ts`, new `amounts.ts`/`assets.ts`, `chains/config.ts`

- Define all stored financial amounts as integer base units.
- Define asset identity as `{ chain, address }` and a serialization function.
- Store decimals metadata with fills/asset references where available.
- Use `bigint` for arithmetic and strings at persistence/API boundaries.

### 4.2 Rework average-cost calculations

**File:** `positions.ts`

- Fix average entry/cost basis semantics so price units are not mixed with token base units.
- Reject sell amounts greater than remaining quantity.
- Handle partial close, complete close, reopen, fees, dust and zero values.
- Return realized PnL for each settled sell fill and preserve cumulative closed-position history.
- Make the function pure and independently testable.

### 4.3 Settle positions atomically

**Files:** `app-db.ts`, `server.ts`, lifecycle/accounting module

For a settled fill, use one DB transaction for:

1. fill insert/idempotency check;
2. position projection;
3. trade compatibility row/update;
4. feed event;
5. reward accrual or durable retry marker.

Failed/pending transactions must not affect positions, realized PnL, feed-as-settled, or trading rewards.

### 4.4 Make PnL source canonical

**File:** `app-db.ts`, `history.ts`

- Aggregate realized PnL from settled fills/settlement-linked records.
- Exclude pending/failed and legacy rows without receipt evidence from verified metrics.
- Populate `realized_pnl_usdc` consistently for compatibility rows.
- Calculate `pnlByChain` and asset holdings using chain-aware identity.
- Keep unrealized PnL separate and label it as a valuation, not settled PnL.

**Tests:** buy/buy/partial sell/final sell, loss/profit, fees, oversell, reopen, same token address across chains, large integers, pending/reverted exclusion, atomic rollback.

## Milestone 5 — Frontend truthfulness and single terminal

### 5.1 API client idempotency and lifecycle

**Files:** `site/js/api.js`, `site/js/trading.js`, `site/js/portfolio.js`

- Generate one idempotency key per user-intended execute action and reuse it on retry.
- Do not send custodial password for live mode; use the server mode/capability response.
- Render pending/failed/settled states from API responses.
- Refresh positions/portfolio after settlement instead of constructing local positions.
- Show explicit mock/simulated labels.

### 5.2 Remove optimistic execution

**File:** `site/js/trading.js`

- Delete the catch branch that treats backend failure as success.
- Do not append a position after a failed or missing execute response.
- Disable unsupported long/short/leverage/limit controls or label them unavailable rather than sending spot requests under those names.
- Replace the custodial password prompt on live path with connected-wallet gating.

### 5.3 Freeze legacy terminal

**File:** `site/trading.html`

- Redirect to `app.html` before any inline app code runs, or make the page a static non-operational notice.
- Ensure no legacy `executeTrade` path can mutate state.
- Remove misleading synthetic order-book/depth and `VERIFIED ON-CHAIN` claims from any reachable screen.

### 5.4 Pending reload behavior

- Add an API endpoint or query for the user's pending intents/transactions.
- On app initialization, fetch pending operations and render retry/status state.
- Never show a confirmed position until API reports settlement.

**Tests:** frontend module parse, no optimistic position after error, idempotency header, legacy redirect, pending reload, mock labels.

## Milestone 6 — Reconciler and operational evidence

### 6.1 Reconciler abstraction

**New file:** `packages/app/src/trading/reconciler.ts`

- Define a chain adapter interface for fetching transaction receipts.
- Implement deterministic fake adapter for tests.
- Process submitted/pending transactions with retry/backoff metadata.
- Transition to confirmed/settled only after a successful receipt.
- Transition failed on reverted/failed receipt; never create a fill in that path.
- Make processing idempotent and safe after restart.

### 6.2 Initial runtime strategy

- Keep a callable reconciliation method and a controlled worker entrypoint; do not add an unbounded interval inside the API server without shutdown handling.
- Document how staging invokes reconciliation.
- Add request IDs/intent IDs/transaction IDs to structured logs without secrets.

### 6.3 Capability reporting

**Files:** `chains/config.ts`, `/api/chains`, UI

- Add capability fields such as `quotes`, `liveExecution`, `selfCustody`, and `status`.
- Report all current chains as configured/read-only/unverified unless the adapter has evidence.
- UI disables live execution when the capability is false.

**Tests:** receipt pending/confirmed/reverted, duplicate callback, restart recovery, capability gating, log redaction.

## Milestone 7 — Verification and documentation

### 7.1 Run verification

From `packages/app`:

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm run typecheck
pnpm run build
```

Run configured lint if introduced or available. Run `packages/core` tests/typecheck to ensure unrelated product remains green.

### 7.2 Update documentation

- Update `AUDIT.md` with implemented evidence, remaining blockers, and any acceptance criteria intentionally deferred.
- Add API contract notes for idempotency, lifecycle, live custody blocking, and mock labels.
- Add a staging runbook for pending/reverted transactions and recovery.
- Do not mark live trading or self-custody as complete unless a wallet-adapter E2E flow exists.

### 7.3 Final acceptance checklist

- No live mock fallback.
- No public feed mutation.
- No live private-key decryption/signing.
- No duplicate execute effects.
- Broadcast is not confirmed.
- Failed receipt has no settled accounting.
- PnL derives from settled accounting and chain-aware assets.
- No optimistic frontend positions.
- Legacy terminal cannot trade.
- Tests/typecheck/build pass reproducibly or documented dependency blockers remain.
