# fomo.family — Reverse-Engineering Notes (2026-09-05)

Findings from browser analysis (route manifest, network capture, marketing/blog
content). Purpose: feature reference for the RaidOS trading app.

## Tech stack (observed)

| Layer | What fomo uses | RaidOS equivalent / gap |
|---|---|---|
| Framework | React Router v7 (SPA mode + prerendered static/SEO routes) | Static `site/*.html` — fine for now |
| Auth + wallet | **Privy** embedded wallets: email/Apple ID login, Shamir key sharding, TEE signing, key export | We have encrypted custodial keys + export (`export-key` route mirrors ours) |
| Charts | **TradingView charting_library** (licensed standalone build, self-hosted at `/charting_library/`) | lightweight-charts (OSS) — enough for now |
| Analytics | PostHog (`app-actions.fomo.family`), PostHog surveys, Facebook Pixel, GTM | none — optional |
| Infra signals | `status.fomo.family` status endpoint, feature flags API (`/flags/?v=2`) | none — optional |

## Route map (from `window.__reactRouterManifest`)

Public/static: `/` home, `/privacy-policy`, `/terms`, `/uk-risk-summary`,
`/verify-token`, `/clans`, `/affiliates`, `/prices`, `/prices/:tickerSlug`,
`/blog/*` (~40 SEO posts), `/answers/*` (~60 SEO Q&A pages),
`/download`, `/careers`.

Authenticated app (SPA, behind `layouts/authenticated`):
- `tokens/:chain/:tokenAddress` — **the token page** (what `/token` redirects to when logged out)
- `profile/:handle` — trader profiles
- `clans/:clanId` — clans (community groups)
- `user`, `u/:handle`, `token`, `coin` — redirect shorthands
- `ref/:refCode`, `r/:refCode` — referral links
- `perp` — perpetuals
- `export-key`, `delete-account` — self-custody & account control

> The token page requires login — the whole trading app is behind auth, so the
> public site is pure SEO funnel: every blog post and Q&A page funnels to
> "Start trading" / "Download app".

## Feature list (from manifest + blog/learn content)

### Discovery & token page
- Home feed of assets with filters: **verified / trending / most held**
- Token page: price, market cap, supply, **liquidity** (blog hammers "always check liquidity and slippage"), holders (top holders + earliest buyers), socials (X, Discord, Telegram, website), "About" section
- **Holder-based social layer**: see *who* holds, when they bought, their comments
- Search: tokens AND user profiles
- Chains: Solana, Base, BNB Chain, Monad (multichain, "gasless" — fees sponsored)

### Social trading (the core loop)
- **Social feed**: trades of followed/top traders — coin, buy/sell amounts, position open/close, price change since purchase, realized PnL on close
- Trade detail: full position build-up (all buys/sells), trader's **thesis comment**
- Follow system → personalized feed of alpha
- **Leaderboard**: top traders across **24h / 7D / 30D / All-time**
- Profiles: portfolio chart, open positions, cash balance, trade history, volume, followers
- **Win/Fumble share cards** — export gains/losses as social images (viral loop)
- **Thesis** write-ups: traders attach conviction narratives to positions
- **Clans**: community groups (clan pages, gamified?)

### Notifications (highly customizable)
- Price alerts on portfolio assets
- Friends' activity (filterable by trade size, per-trader toggles)
- Trending activity (coins gaining momentum)
- Top traders' large trades
- Announcements (news, research, features)
- New followers

### Perpetuals (new, June 2026) — powered by Hyperliquid & Trade[XYZ]
- Pre-IPO perps (SpaceX), equity perps (NVDA, GOOGL...), crypto (BTC, ETH, SOL, HYPE), indices (S&P500, Nasdaq100...), commodities (oil, gold...)
- One-click trading, isolated margin, TP/SL on advanced charts, unified portfolio view
- Social features extended to perps: direction, leverage, notional shown in feed

### Wallet & security model (Privy-based)
- Email / Apple ID signup, **no seed phrase** — embedded wallet in <30s onboarding
- Non-custodial: Shamir Secret Sharing key shards, reassembled in TEEs only at signing; user can always reconstruct/export
- FaceID/biometric required for: withdrawals, private key export
- Fiat on/off-ramp: **Apple Pay**, debit card, bank account, crypto
- Gas fees sponsored by fomo ("gasless" UX)

### Monetization (implied/observed)
- Trading fees (spread/fee on swaps), perp trading fees
- Affiliates/referral program (`ref/:code` — dedicated routes + landing page)
- App-store distribution + web platform

## Biggest gaps in RaidOS vs fomo (priority order)

1. **Social feed of trades** — we have trades + profiles + calls but no unified feed of buy/sell/position events with PnL. This is fomo's core loop.
2. **Leaderboard timeframes** — ours is all-time only; add 24h/7D/30D windows.
3. **Position model** — we record individual swaps; fomo groups them into *positions* (build-up, avg entry, open/close, realized PnL at close) — needed for feed + profiles + share cards.
4. **Win/Fumble share cards** — viral growth loop, cheap to build (canvas → image).
5. **Referral system** — `ref/:code` links; recurring growth, affiliates page.
6. **Holders view on token page** — top holders/earliest buyers with comments; needs on-chain holder data (Birdeye/Helius) pluggable behind our provider interface.
7. **Search (tokens + users)** — trivial on our stack once API exists.
8. **Filters on discovery: verified / trending / most held** — trending engine roadmap item aligns.
9. **SEO funnel** — they run ~100 static content pages driving acquisition; our `site/` could adopt the same pattern later (blog/answers).
10. **Gasless UX + fiat onramp** — Apple Pay onramp via privy/moonpay-style provider; bigger lift, later.

## What RaidOS already has that fomo doesn't (our edges)

- Telegram-native community brain (their community is Discord/X only)
- Raid engine + XP/quests/badges retention layer
- Honest self-reported metrics policy (their PnL is on-chain real, but no community-coordination tools)
- Self-hosted, privacy-first option
- Launchpad with bonding curve (fomo doesn't launch tokens)

## Recommended next build order (for the trading app)

1. Positions engine (group swaps → positions, realized/unrealized PnL) — foundation for feed
2. Social feed API + UI panel (trades, positions, closes, theses)
3. Leaderboard with timeframes (24h/7D/30D/all)
4. Share cards (win/fumble) — PNG via canvas, social metadata
5. Referral links (`?ref=` captured at register → `referrals` table)
6. Token discovery endpoint: trending/verified/most-held filters (needs market provider — reuse Volume Intelligence providers from core)
