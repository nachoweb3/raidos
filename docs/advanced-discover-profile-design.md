# Design: Advanced Discover Filtering + Advanced User Profile

Date: 2026-09-10
Status: Approved by user (build both)

## A. Advanced Discover

### Data layer
- New `site/js/dexfeed.js` — `DexFeed`: DexScreener public API client (no key).
  - Per-symbol fetch of `/latest/dex/search?q={symbol}`; picks the best pair (highest liquidity).
  - Extracts: price, mcap/fdv, volume 24h, liquidity, txns 24h (buys/sells), h1/h6/h24 change, socials (twitter/telegram/website), logo, pairAddress/tokenAddress.
  - 5-minute localStorage cache (`raidos_dex_cache_v1`), same pattern as PriceFeed.
  - Honest fallback: no pair found → fields stay null → UI shows "—". Nothing invented.
  - `enrichAll(tokens)` batches enrich of the token universe (launchpad rows use their `tokenAddress` directly).

### Launchpad socials
- DB migration: add `twitter_url`, `telegram_url`, `website_url` TEXT DEFAULT '' to `launches`.
- `CreateLaunchParams` + `formatLaunch` extended; `POST /api/launches` accepts the 3 fields (http-validated strings).
- Launch creation form gets 3 optional social inputs; market cards show social icons when present.

### Filter UI (Discover)
- Quick chips: ALL · 🚀 LAUNCHPAD · 🎓 GRADUATED · 🐋 MOST HOLDED · 🔥 HOT NARRATIVES (+ existing category tabs).
- "Filters" toggle opens advanced panel: MCap min/max, Volume min, Txns 24h min, Liquidity min, Holders min, "Has socials" checkbox, sector select.
- Sort select: Elite Score · MCap · Volume · Txns · Liquidity · 24h change.
- MOST HOLDED: buyers_count for launchpad tokens, holders API where a chain provider exists, else excluded.
- HOT NARRATIVES: sectors ranked by (avg |h6 change| weighted by volume) computed from DexFeed data; tokens grouped by their sector.
- Rows gain: liquidity + txns columns (desktop), social icons, holders count when known.

## B. Advanced User Profile

### Schema
- `profiles.social_links` TEXT DEFAULT '{}' — JSON {twitter, telegram, website, discord}.

### API (Router has no PATCH → use POST)
- `GET /api/me/profile` → profile + social_links parsed + trading stats (from getUserPnl summary fields).
- `POST /api/me/profile` → updates display_name, bio, avatar_url, x_handle, social_links. Validation: lengths (name ≤ 40, bio ≤ 280, URLs must be http(s), handle ≤ 30). Profile row auto-created if missing.
- `AppDb.updateProfile` colMap extended (bio, socialLinks).

### UI (Portfolio tab)
- Header becomes the user's profile: avatar (photo or deterministic initials), editable display name, bio, social icon links, joined date, follower stats.
- "Edit profile" button → modal (name, bio, avatar URL, X handle, twitter/telegram/website/discord) with live preview; saves via ApiClient.
- `ApiClient.getMyProfile()` / `ApiClient.updateMyProfile(patch)`.

## Verification
- Vitest: profile GET/POST roundtrip incl. validation errors; launch socials persisted and returned; updateProfile colMap.
- tsc --noEmit; full suite; ES-module parse of new site/js files.
