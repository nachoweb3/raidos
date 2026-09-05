# Trading App API — Design Spec (2026-09-05)

## Goal

Connect the trading dashboard (`site/trading.html`, currently 100% mock data) to the
real domain logic in `packages/app` (wallets, swap engine, launchpad, social,
revenue) through an HTTP API server. Full production loop: auth, trade execution,
dashboard wiring.

## Decisions (user-approved)

- **Scope:** full loop — API with auth + trade execution + dashboard wiring.
- **Framework:** Node native `http`, zero new dependencies.
- **Location:** inside `packages/app/src/api/` (approach A — reuses AppDb and
  engines directly, no new workspace package).
- **Modes:** `APP_MODE=live|mock` (env). Mock mode simulates execution
  deterministically and is *labeled* — consistent with RaidOS honesty rules.
  Default: `mock` (safe), set `APP_MODE=live` for real broadcasting.

## Architecture

```
site/trading.html  ──HTTP──▶  src/api/server.ts (node:http)
                                ├── router.ts (routes, JSON, CORS)
                                ├── auth.ts (API keys: SHA-256 hashed, Bearer)
                                ├── executors.ts (Jupiter/0x live + mock sim)
                                └── AppDb + WalletManager + TradingEngine +
                                    TokenLaunchpad + SocialTrading + RevenueEngine
```

One process serves both the static dashboard (`SITE_DIR` env, defaults
`../../site`) and `/api/*`.

## Data model changes (app-db.ts)

- New table `users`: `user_id INTEGER PRIMARY KEY`, `api_key_hash TEXT`,
  `created_at INTEGER`. Auto-migrates alongside existing tables.
- New methods: `createUser`, `getUserByApiKeyHash`, `countUsers`.

## Auth flow

- `POST /api/auth/register` `{ password }` → creates a user + random 32-byte
  API key. **Requires `BOOTSTRAP_SECRET`** to match env when any user already
  exists (first user after fresh DB can self-register). Response returns the
  plaintext key **once**; DB stores only its SHA-256 hash.
- All other `/api/*` routes require `Authorization: Bearer <key>`.
- The dashboard keeps the key in `localStorage`; without one it runs in demo
  mode: a visible **"DEMO DATA"** banner is shown and mock data is served
  client-side (never claiming to be real).

## Endpoints

| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/register` | bootstrap-guarded, returns API key once |
| GET | `/api/me` | auth check, returns user id |
| GET | `/api/chains` | chain configs (public: no keys) |
| GET | `/api/wallets` | list wallets (public info) |
| POST | `/api/wallets` | create `{ chain, password, label? }` |
| POST | `/api/wallets/import` | import private key |
| DELETE | `/api/wallets/:id` | delete `{ password }` |
| GET | `/api/trades` | history (paginated) |
| POST | `/api/trades/quote` | TradingEngine quote |
| POST | `/api/trades/execute` | full execution loop |
| GET | `/api/trades/pnl` | PnL summary |
| GET | `/api/launches` | list (query: chain, status) |
| POST | `/api/launches` | create launch |
| POST | `/api/launches/:id/buy` | bonding-curve buy |
| POST | `/api/launches/:id/sell` | bonding-curve sell |
| GET | `/api/leaderboard` | top traders |
| GET | `/api/portfolio` | holdings derived from confirmed trades + PnL |
| GET | `/api/subscription` | current tier |
| POST | `/api/subscription` | subscribe `{ tierId }` |

## Trade execution loop (`POST /api/trades/execute`)

1. Validate chain + tokens; resolve user's primary wallet for `fromChain`
   (404 if none).
2. Get quote via `TradingEngine.getQuote` (Jupiter for Solana, 0x for EVM).
3. Compute fee via `RevenueEngine.recordTradingFee` (0.3% swap / 0.5% bridge,
   min fee) — recorded as a revenue event.
4. Execute:
   - **Solana (live):** build swap transaction from Jupiter quote, sign with
     decrypted custodial key, broadcast via `@solana/web3.js`.
   - **EVM (live):** 0x `/swap/v1/quote` → tx signed with `ethers.Wallet`
     (decrypted key), broadcast via the chain's RPC.
   - **Mock mode:** deterministic simulated fill (quote buyAmount, pseudo-tx
     hash `mock_<hex>`), result labeled `mode: "mock"`.
   - **Bridge:** v1 returns `501 not implemented` honestly (quotes only).
5. Record trade row (`pending` → `confirmed` on success) with fee + prices.
6. Return `TradeResult` + recorded trade id.

Failures mark the trade `failed` and return a JSON error envelope; nothing is
left half-recorded.

## Dashboard wiring (site/trading.html)

- Thin `api.js`-style inline client: `apiFetch()` adds Bearer key from
  `localStorage`; on 401 clears the key and falls back to demo mode.
- Launchpad cards, leaderboard, portfolio and trade quotes render from the API
  when a key exists; order book / candle feed stay mock in demo mode (no public
  market-data endpoints yet — honest, labeled).
- Demo banner element added; hidden when authenticated.

## Error handling

- Uniform JSON envelope: `{ error: string }` with proper status codes
  (400 validation, 401 auth, 404 missing, 501 unimplemented).
- Unhandled exceptions → 500 `{ error }` + stderr log; server never crashes on
  a bad request.

## Testing

- New `tests/api.test.ts`: starts the server on an ephemeral port with a temp
  SQLite DB in mock mode. Covers: register/auth (bootstrap guard, wrong key
  401), wallet create/import/delete, launch create → buy → sell → graduation,
  quote + execute (mock executor) + trade recording + fee revenue event,
  portfolio aggregation, subscription upgrade, leaderboard.
- All existing tests keep passing; `npm run typecheck` stays clean.

## Out of scope (follow-ups)

- Rate limiting, per-IP quotas, key rotation endpoints.
- Real market data endpoints (order book, candles) — needs a provider first.
- WebSocket live feeds; production launchpad on-chain deployment.
