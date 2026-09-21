# Production work, 2026-09-20

Scope: verified blockchain functionality, premium terminal, observed wallet trades and chart markers. Preserve existing launchpad work.

Delivered: midnight terminal, decorative particles with reduced-motion/visibility handling, revised landing page, public pool trade endpoint, wallet filter, transaction links, grouped chart markers, microprice precision, chart refresh and polling cleanup. App suite: 295 tests; build and typecheck passed. Real local browser journey: 100 candles and 300 swaps; wallet filtering, marker toggle, 390px layout and close cleanup passed. Web published commits 18b80e7 and 2fcab5e; API image deployment-01M303H6D8BCCB2R5KMG5ZZZT2.

Final public verification: Pages build 2fcab5e built; production HTML includes release 20260920-2, radar and theme. E2E repeated on https://inusaur.online with real BONK data passed desktop/mobile wallet filtering, markers, reduced motion and close cleanup. API health reports live. Expected server-provider 503 responses were recovered through public browser requests; do not report zero network errors.

Production discovery: GeckoTerminal returns HTTP 429 from Fly egress. Public browser access returned HTTP 200/300 trades. Added read-only browser fallback with bounded cache, request coalescing, no credentials, timeout and 429 cooldown. This improves availability but does not provide a provider SLA. Canonical schema reference: https://docs.coingecko.com/demo/reference/pool-trades-contract-address .

Remaining: full on-chain launch curve, audited liquidity migration, funded liquidity, durable pool swap sessions, reserve concurrency, mixed SPL programs, receipt reconciliation and factory partial-failure recovery. Factory additionally derives claim ATAs with mint/owner swapped; this needs correction and tests before enabling its operator signer. Existing production has no factory/pool signer configured. No real-money transaction was performed in this release. Pool prepare/submit now fail closed; standard spot self-custody remains separate.

Design: midnight #080e1b, titanium #15243a, ice #87dded, amber #eac184, paper #edf4fc, sell #f38c9a. Existing system typography, tabular numbers, left aligned data. Chart and wallet tape on the left, execution on the right; stacked on mobile. Restrained particles, reduced-motion support and hidden-page suspension.

Review: the distinctive element is real pool activity mapped to candles. Do not invent trader counts, complete positions or presence. Activity is a bounded provider sample with transaction links.

Audit: launch curve remains simulated. Pool liquidity is operator-custodied, not an autonomous AMM. Submission trusts client output amounts, lacks durable prepared sessions, accepts extra instructions, uses one token program for both assets and ignores confirmation errors. Gate unsafe execution pending durable lifecycle, reserve concurrency and exact-message verification. Spot self-custody is separate.
