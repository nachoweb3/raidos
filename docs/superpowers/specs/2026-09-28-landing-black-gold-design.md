# Landing Page "Black Gold" — Design Doc

**Date:** 2026-09-28
**Scope:** `site/index.html` only. `design-system.css` untouched. No app pages affected.

## Goal

Rebuild the TRENCHES landing page so it reads as premium wealth-management-grade:
black canvas + fine gold accents, luxury serif display type, an abstract rotating
metallic relic replacing the T-Rex mascot, and a structure that leads with money
(numbers, rewards program) instead of features.

## Aesthetic Direction

- **Palette:** deep black `#050505` canvas; gold only as hairlines, numerals and
  micro-accents (`--gold: #d4af6a` family, several opacities). Never large fills.
- **Type:** headings in a luxury serif (Instrument Serif via Google Fonts, weight
  400, tight tracking); body stays in the existing sans/mono stack from the
  design system.
- **Texture:** subtle film grain (SVG noise, ~3% opacity) + one gold radial halo
  behind the hero.
- **Relic (replaces mascot):** concentric rings with metallic conic-gradient
  rings, counter-rotating at different speeds, dashed orbit ellipses. Pure CSS
  animation; paused under `prefers-reduced-motion`.

## Page Structure

1. **Nav** — sticky, black glass, gold hairline bottom border, brand in serif,
   gold LIVE badge.
2. **Hero** — rotating metallic relic; serif headline; one gold CTA + ghost
   "Instalar la app" (PWA install button, `data-install-app` kept); rewards
   microcopy line.
3. **Numbers band** — new horizontal metrics strip (chains, fee share %, routing
   latency, USDC rewards) in mono gold.
4. **Terminal mockup** — kept with real CoinGecko data (feed/discover/price);
   restyled gold: gold chart line, gold hairlines, gold accent details.
5. **Rewards section** — new: program explainer with flow diagram 10% + 10%
   USDC + levels cards.
6. **Pillars** — 6 cards, gold hairline icons.
7. **Comparison** — "casino crypto vs TRENCHES", sharper copy, gold vs muted.
8. **Final CTA** — gold gradient border banner, serif headline.
9. **Footer** — minimal, gold hairlines, keeps @nacho_web3_ credit.

## Preserved Behavior

- CoinGecko real-data script (`landingFeed`, `landingDiscover`, demo token
  selection) with same element IDs.
- Referral forwarding script (`?ref=` propagation to `app.html` links).
- PWA install script (`js/install.js`, `data-install-app` button).
- manifest/OG/meta tags kept and refreshed for the new positioning.
- All links to `app.html` preserved.

## Non-Goals

- No backend changes, no new routes, no JS framework.
- No changes to `css/design-system.css` or app pages.
- No fake numbers: metrics shown are product facts (10% fee share, 3 chains,
  Jupiter V6 routing), not invented stats.
