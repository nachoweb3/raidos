# fomo.family — Informe de análisis técnico (2026-09-05)

Target: `https://fomo.family/tokens/robinhood/0xc2362aff2a2a4cc1f48cf3dab2c4e2605eb94ba3`
**Token identificado:** GME "GameStop" (ERC-20, Robinhood Chain, 18 decimals, 17,482 holders — vía Blockscout API pública).

Método: solo superficie pública — headers HTTP, CSP, sitemap/robots, route manifest de la SPA,
bundles JS públicos (fingerprinting de strings), contenido de marketing/blog y APIs on-chain públicas.
Sin cookies, tokens, claves ni endpoints privados. Cada afirmación lleva su nivel:
**[CONFIRMADO]** (evidencia directa) · **[PROBABLE]** (inferencia fuerte) · **[NO DETERMINADO]**.

---

## 1. Stack tecnológico detectado

| Capa | Tecnología | Nivel |
|---|---|---|
| Framework | **React Router v7.18.1** en modo **SPA** (`isSpaMode:true`, `ssr:false`, `HydratedRouter`) con routes estáticas prerenderizadas para SEO | CONFIRMADO |
| Hosting/CDN | **Cloudflare** (`server: cloudflare`, `worker-handled: cf`, `CF-Cache-Status: HIT`) + workers propios `*.fomo-labs.workers.dev` en CSP | CONFIRMADO |
| Estilos | **Tailwind CSS** (`text-text-primary`, `flex items-center gap-2`, `opacity-100` en bundles) con tokens semánticos `text-primary/secondary/tertiary` | CONFIRMADO |
| Iconos | **Lucide** (`createLucideIcon` bundle) | CONFIRMADO |
| Charting | **TradingView charting_library** self-hosted (`/charting_library/charting_library.standalone.js`; opciones `hide_left_toolbar_by_default`, `series_properties_changed`) | CONFIRMADO |
| Wallet/Auth | **Privy** (`auth.privy.io/api/v1/apps/cm6h485o300n3zj9yl6vpedq7`, embedded wallets) | CONFIRMADO |
| State global | **Zustand** + persistencia localStorage (`{name:"token-holders-friends-only-storage"}`) + **React Compiler** (memoización automática `compiler-runtime`) | CONFIRMADO |
| Data-fetching | **TanStack Query** (`refetchInterval`, `staleTime`, `mutationKey`, `useQuery` chunk) | CONFIRMADO |
| Feature flags | **Statsig** (`featureassets.org`, `prodregistryv2.org`, `statsigapi.net`, bundle `statsig-v2`) | CONFIRMADO |
| Analytics | **PostHog** self-hosted en `app-actions.fomo.family` (surveys, web-vitals, dead-clicks, exception-autocapture) + GTM/GA4 + Meta Pixel | CONFIRMADO |
| RUM/errores | **Datadog Browser SDK** (`datad0g-browser-agent.com`, RUM + replay) | CONFIRMADO |
| i18n | React Router `i18n` bundle + `intl` (plural/ordinal/select) — `language_changed` evento; soporte multi-idioma [PROBABLE] | PROBABLE |
| PWA/SW | No detectado service worker ni manifest PWA | NO DETERMINADO (probablemente no) |
|API base| **`https://prod-api.fomo.family`** (REST; función `fomoFetch` central con timing Datadog) | CONFIRMADO |
| Realtime | **Sin WebSocket ni SSE en el cliente** — polling con TanStack Query: `refetchInterval` de **3s, 10s, 1min**; `staleTime` 1s/5s/6s/30s | CONFIRMADO |

Infra observable vía **CSP** (goldmine — lista los orígenes que el backend usa):

- `wss://*.fomo.family` — WebSocket propio permitido (no visto en uso en cliente logged-out) [PROBABLE uso interno/notificaciones]
- `https://mainnet.block-engine.jito.wtf` + `hudson.jito.wtf` — **Jito block engine** (envío de txs Solana con MEV protection)
- `https://api.relay.link` + `wss://ws.relay.link` — **Relay** (bridging + fiat onramp)
- `https://api.hyperliquid.xyz` + `wss://api.hyperliquid.xyz` — **Hyperliquid** (perps)
- `https://token-media.defined.fi` — **Defined.fi** (datos de tokens/media)
- `*.mobula.io` — **Mobula** (market data)
- `*.coingecko.com` — CoinGecko (market data)
- `*.rpc.privy.systems` — RPC proxy de Privy
- `prod-fomo-profile-pics.s3.amazonaws.com` — avatares en S3
- `media.thegrid.id`, `crypto-exchange-logos-production.s3...` — media de tokens/logos

---

## 2. Arquitectura probable

```
[Cloudflare CDN/WAF] → [React Router v7 SPA (assets estáticos)] ─┐
                                                                 │ REST (JSON, auth Privy JWT)
                      ┌──────────────────────────────────────────┘
                      ▼
          prod-api.fomo.family (API propia, REST /v2/*)
                      │
        ┌─────────────┼───────────────┬──────────────────┐
        ▼             ▼               ▼                  ▼
   DB própria    Indexadores     Servicios 3º       Infra Solana
   (users,swaps, (trades/holders  Defined.fi/Mobula/ Jito (tx),
   positions,    on-chain),      CoinGecko, Relay    Privy RPC,
   theses,clans) whale alerts     (swap/bridge),      Relay WS
        │                              Hyperliquid (perps)
        ▼
   Push notifications (Expo/FCM/APNs) [PROBABLE — blog confirma push]
```

- El API es **REST propia con versionado `/v2/`** [CONFIRMADO por paths en bundles]; GraphQL no se usa en cliente (solo menciones del SDK Datadog) [CONFIRMADO ausencia].
- Datos de mercado tercerizados (Defined/Mobula/CoinGecko), datos sociales propios (swaps, holders-en-app, tesis, clans) [PROBABLE — coherente con endpoints y CSP].

---

## 3. Mapa de rutas (route manifest real)

**Públicas (prerenderizadas, SEO):**
`/` · `/privacy-policy` · `/terms` · `/uk-risk-summary` · `/verify-token` · `/clans` · `/affiliates` · `/prices` · `/prices/:tickerSlug` · `/blog` (+ ~40 posts: recaps mensuales, guías "learn", casos de traders) · `/answers` (+ ~60 Q&A estilo FAQ-SEO: "are-memecoins-a-scam", "how-does-copy-trading-work"…) · `/download` · `/careers`

**App (SPA, tras `layouts/authenticated`):**
| Ruta | Función |
|---|---|
| `tokens/:chain/:tokenAddress` | **Token page** (la analizada) |
| `profile/:handle` | Perfil de trader (PnL, positions, followers) |
| `clans/:clanId` | Página de clan |
| `perp` | Perpetuos → redirige a `/download` (web aún no, mobile-first) [CONFIRMADO: el módulo perp solo redirige] |
| `export-key` / `delete-account` | Self-custody / RGPD |
| `user` · `u/:handle` · `token` · `coin` | Redirects: `coin?address=X&chainId=N` → `/tokens/:chain/:address` [CONFIRMADO en código del redirect] |
| `ref/:code` · `r/:code` | Referrals (robots.txt los excluye del index) |

**robots.txt:** bloquea `/export-key`, `/download`, `/verify-token`, `/r/`, `/ref/`, `/uk-risk-summary`.
**sitemap.xml:** generado dinámicamente (lastmod = fecha de build, `daily`).

---

## 4. Component tree de la token page

Del bundle `token-v2-D0iuhL5x.js` (77KB, lazy-loaded por la ruta):

```
TokenPage
├── PriceHeader (price, price change; polling 3–10s [PROBABLE])
├── StatsBar (market_cap ×4 refs, circulatingSupply, displayMode) 
├── ChartPanel
│   └── TradingView charting_library (iframe; config: hide_left_toolbar_by_default)
├── CoinFeed / SubTabs: const fn = ["holders","swaps","thesis"]  [CONFIRMADO]
│   ├── HoldersTab (tokenHoldersFriendsOnly / tokenHoldersThesisOnly toggles,
│   │               contador de holders, "dev-holdings" badge)
│   ├── SwapsTab  (umbral por tamaño: threshold + onChange → filtra trades por monto)
│   └── ThesisTab (coinFeedThesisOnly toggle, thesisThreshold, altura por bucket:
│                  thesisMarks/thesisSegments = tesis dibujadas SOBRE el chart)
├── TradePanel (Buy/Sell; almacén swap in/out NetworkId+amount+address)
└── SharePosition (share_position_shared/copied → win/fumble cards)
```

**Datos que consume cada componente:** price/mcap/liquidity → proveedor market-data; holders/swaps/thesis → API propia `/v2/*` [PROBABLE]; chart OHLCV → TradingView datafeed hacia su backend [PROBABLE].
**Interacción:** cambio de subtab dispara `coin_subtab_selected` (PostHog) [CONFIRMADO string]; toggles persisten en localStorage (Zustand persist) [CONFIRMADO].
**Estados:** `animate-pulse` skeletons (loading), empty states por tab [CONFIRMADO strings].

> Nota: la página completa exige login (`layouts/authenticated` guarda las rutas); lo documentado
> viene del bundle + módulo de datos `token-v2-BxvaAvyp.js` (335KB) que ya descargué.

---

## 5. APIs/endpoints públicos observados

Base: `https://prod-api.fomo.family` [CONFIRMADO]. Paths extraídos de bundles:

| Endpoint | Método | Uso / componente |
|---|---|---|
| `/swaps/usdc` | POST | Swap USDC↔token; body `{inNetworkId, outNetworkId, amount, inAddress/outAddress}` — el backend orquesta la ejecución (usuario no firma rutas DEX) [CONFIRMADO strings] |
| `/swaps/v2/authorize` | POST | Autorización de allowance para swap vía Relay [CONFIRMADO string] |
| `/swaps/v2/status?relaySwapId=` | GET | Estado de swap Relay (polling) [CONFIRMADO] |
| `/transfers` | POST | Retiro/transferencia on-chain [CONFIRMADO] |
| `/v2/transfers/with/:handle` | GET | Historial de transfers con otro usuario (perfil) [CONFIRMADO] |
| `/v2/users/${id}/balances` | GET | Balances multi-chain del usuario [CONFIRMADO] |
| `/v2/users/${id}/leaderboard` | GET | Posición del usuario en leaderboard [CONFIRMADO] |
| `/v2/users/${id}/referrals?limit=&lastReferralId=` | GET | Lista paginada de referidos [CONFIRMADO] |
| `/v2/users/${id}/rewards?cursor=` | GET | Rewards paginados [CONFIRMADO] |
| `/v2/users/${id}/withdrawals?networkId=` | GET | Historial de retiros por red [CONFIRMADO] |
| `/v2/users?${query}` · `/v2/users/fuzzy-search?searchTerm=` | GET | Búsqueda de usuarios [CONFIRMADO] |
| `/v2/clans/search?searchTerm=` | GET | Búsqueda de clanes [CONFIRMADO] |
| `/v2/leaderboard/${period}` | GET | Leaderboard por periodo (24h/7D/30D/all [PROBABLE del blog]) [CONFIRMADO path] |
| `/v2/users/pushToken/preferences` | GET/PUT | Preferencias de push (tipos de notificación) [CONFIRMADO] |
| `/v2/users/exportedKeys` | POST | Auditoría de exportación de claves [CONFIRMADO] |
| `/proxy/filterTokensSearch` | POST | Búsqueda de tokens (proxy a proveedor) [CONFIRMADO] |
| `/v2/users` | POST | Registro/onboarding [PROBABLE] |

Home filters (del bundle `authenticated`): `trending` · `graduated` · `pre-graduated` · `most-held` · `pto-tokens` [CONFIRMADO strings].
Otros términos del feed: `profit`/`fumble` (win/fumble cards), `passkey` (login con passkeys además de email/Apple) [CONFIRMADO strings].

Eventos PostHog observados (fingerprint de producto): `clan_request_clicked`, `clans_section_toggled`,
`discovery_panel_{tab,leaderboard_mode,token_list}_selected`, `deposit_modal_{shown,dismissed,option_selected}`,
`withdraw_evm_tx_complete`, `withdraw_sol_tx_complete`, `share_position_{shared,copied}`, `share_referral_code`,
`export_key_click`, `delete_account_*`, `session_mfa_challenge_failed`, `language_changed` [CONFIRMADO].

**NO accedí ni llamaré a estos endpoints** (requieren sesión; documentación solo arquitectónica).

---

## 6. Realtime

- **Cliente web: polling**, no WebSockets: intervalos de 3s (precio/ejecuciones en vivo [PROBABLE]), 10s (listas), 1min (secondary); staleTime 1–30s [CONFIRMADO en token-data.js].
- CSP permite `wss://*.fomo.family` y `wss://ws.relay.link` → WebSocket propio probablemente para **mobile (push/notificaciones)** o features aún no activas en web [PROBABLE]; Hyperliquid WS para perps cuando se activen [CONFIRMADO en CSP].
- Eventos que would necesita un equivalente: trade ejecutado, price update, posición cerrada (PnL realizado), nueva tesis, holder notable compró, clan activity [PROBABLE — derivado del modelo de datos].

**Implementación original equivalente (recomendada para RaidOS):**
1. **SSE** (`/api/stream`) por token/feed — unidireccional, sobrevive proxies, trivial en Node.
2. Eventos: `price`, `swap`, `position_closed`, `thesis`, `holder_alert`; payload mínimo + seq id.
3. Fallback: el cliente ya usa TanStack Query → `refetchInterval` como degradación elegante.
4. Fan-out con Redis Pub/Sub cuando haya >1 nodo (no necesario en fase 1).

---

## 7. Blockchain

| Aspecto | Hallazgo | Nivel |
|---|---|---|
| Chains soportadas | Solana, Base, BNB Chain, Ethereum, Monad, **Robinhood Chain (4663)**, Hyperliquid | CONFIRMADO (`chains.js` + swaps map) |
| Token analizado | GME en Robinhood Chain — EVM, ERC-20, 18 dec; explorador **Blockscout** (`robinhoodchain.blockscout.com`) | CONFIRMADO |
| Stablecoins por chain | USDC nativo + **USDG en Robinhood Chain** (`0x5fc536...` — coincide con nuestro `chains/config.ts`), WETH `0x0Bd7D3...` | CONFIRMADO |
| Ejecución de trades | **Backend-executed**: el cliente POSTea `/swaps/usdc` con networkId+amount; firma el backend/custodio Privy (Shamir+TEE, confirmado por blog "key sharding… TEE") | CONFIRMADO (arquitectura) |
| Solana | Envío de txs vía **Jito block engine** (CSP) | CONFIRMADO |
| Bridge/fiat | **Relay** (CSP `api.relay.link` + `/swaps/v2/authorize` con `relay...` en body) | CONFIRMADO |
| Perps | **Hyperliquid** (`api.hyperliquid.xyz/exchange` hardcoded en authenticated bundle) | CONFIRMADO |
| Balances/holders | Balances de usuario → API propia (indexadores propios o proxy); holders on-chain visibles en UI; datos de mercado → Defined/Mobula/CoinGecko | PROBABLE |
| Formato txs | EVM: estándar ERC-20 approve+swap; Solana: versioned tx a Jito | PROBABLE |

---

## 8. UI/UX breakdown (Fase 8)

**Paleta exacta** (del módulo `colors.js` — design tokens reales):

| Hex | Rol inferido |
|---|---|
| `#060510` | Fondo principal (casi negro azulado) |
| `#12111A` / `#161522` | Superficies/cards (bg1/bg2) |
| `#F7F7F7` | Texto primario |
| `#9899A3` / `#474B52` | Texto secundario/terciario (grises) |
| `#21C95E` / `#45FE82` | Verde profit/CTA |
| `#FF4E51` | Rojo loss/fumble |
| `#4356FF` / `#516AF6` | Azul primario (brand/links) |
| `#73CCFF` | Celeste (info/agua) |
| `#F9E45B` | Amarillo (warnings/rank) |
| `#FD5DD3` / `#FF6FE9` / `#FF622E` / `#FF8649` / `#048F5C` | Acentos (clans/badges/gradientes) |

**Tipografía:** Inter (`inter-events-none`, .woff2) + `font-mono` para cifras [CONFIRMADO clases].
**Escala:** `text-xs` (12px) para metadatos, `text-sm` (14) base UI, `text-lg` títulos; spacing Tailwind estándar, `gap-1/2/3` [CONFIRMADO clases].
**Componentes:** shadcn-style con `data-slot` + Radix (`dialog` primitives, `data-state`) [CONFIRMADO].
**Patrones UX que funcionan:**
1. **Jerarquía de 3 niveles** — fondo casi negro → cards `#12111A` → hover `#161522`: la jerarquía se lee por luminancia, no por bordes.
2. **Texto semántico** (`text-text-secondary/tertiary`) — degradación de importancia consistente; los números en mono alinean y "cantan".
3. **Skeletons `animate-pulse`** en loading — nunca spinners bloqueantes.
4. **Filtros como toggle-chips persistidos** (localStorage) — la app recuerda cómo filtras tú.
5. **Feed unificado con umbrales** (min size en swaps) — anti-noise sin configurar nada.
6. **Win/Fumble cards compartibles** — el PnL como contenido social (viral loop).
7. Mobile-first con bottom nav de 5 (Home/Search/Feed/Friends+LB/Profile [CONFIRMADO en blog]); web = mismo modelo con discovery panel lateral.

---

## 9. Arquitectura ORIGINAL recomendada (Fase 9)

**Frontend** — mantener el actual `site/*.html` + añadir SPA ligera solo si se necesita app-state complejo; si se reconstruye: Next.js (App Router, SSG para SEO-funnel + rutas app client-side) + Tailwind con los mismos tokens semánticos + lightweight-charts (ya en uso; TradingView licensing es caro). Zustand + TanStack Query.

**Backend** — lo ya construido en `packages/app` (Node native http + better-sqlite3) encaja: REST `/v2/*` versionada, cache en-memory LRU para market-data (TTL 3–10s), job de indexación de swaps por chain.

**Blockchain** — wallet connection: existing custodial keys + opción read-only address watching; RPC público por chain detrás de `MarketDataProvider` (ya existe en core: DexScreener/GeckoTerminal/Birdeye); holders vía Blockscout API v2 (gratis, Robinhood Chain ya soportado — verificado en este análisis); trades: indexar logs del router/USDC Transfer.

**Realtime** — SSE (sección 6) + polling TanStack como fallback.

**Auth** — API keys ya implementadas; opción: SIWE (Sign-In with Ethereum) cuando haya wallet connect.

**DB (modelo mínimo equivalente, SQL):**
```
users(id, handle, api_key_hash, referrer_id, created_at)
wallets(id, user_id, chain, address, encrypted_key, is_primary)
positions(id, user_id, chain, token, state open/closed, avg_entry_usdc,
          amount, opened_at, closed_at, realized_pnl_usdc, thesis_id?)
swaps(id, position_id, side buy/sell, amount_in, amount_out, price_usdc,
      fee_usdc, tx_hash, ts)          -- alimenta positions por trigger/agregador
token_stats(token, chain, price_usdc, mcap, liquidity, holders, ts)  -- cache
holders(token, chain, address, balance, first_seen_ts, is_dev)
theses(id, user_id, token, chain, text, price_at_post, marks_json, ts)
follows(follower_id, target_id, created_at)
clans(id, name, owner_id) / clan_members(clan_id, user_id, role)
feed_events(id, type swap/position_closed/thesis/holder, actor_id, payload_json, ts)
notifications(id, user_id, type, payload_json, read_at, ts)  -- tipos: price, friends, trending, top_traders, announcements, followers
referrals(referrer_id, referee_id, code, ts)
leaderboard_snapshots(period 24h/7d/30d/all, user_id, pnl_usdc, ts)  -- materializada
```

---

## 10–14. Resultado final

**(10) Base de datos necesaria:** la de arriba — 14 tablas; `positions` + `feed_events` son las dos críticas que hoy no tenemos.

**(11) Arquitectura original recomendada:** resumida en la sección 9; detalle de fases abajo.

**(12) Qué mejorar respecto a fomo (oportunidades reales):**
1. **Feed comunitario con contexto Telegram** — fomo no tiene raids/comunidad organizada: nuestro raid engine + brain alimenta el feed con señales que ellos no tienen.
2. **Bonding-curve launchpad nativo** — fomo lista tokens, no los lanza; nuestro launchpad graduado crea el token *y* el feed.
3. **Honest labels** — PnL on-chain verificado + etiquetado SELF-REPORTED donde aplique (diferenciador de marca ya definido en RaidOS).
4. **Self-hosted / privacidad** — fomo es 100% cloud custodial-lite; nosotros podemos ofrecer modo self-host.
5. **SEO funnel** — copiar el patrón `/answers/*` + `/blog/learn/*` (100 páginas, long-tail) que es su máquina de adquisición — trivialmente replicable.
6. **Polling → SSE real** — su web usa polling; un feed SSE es UX superior y barato.

**(13) Plan de implementación por fases:**
- **Fase A — Position engine + leaderboard temporal** (1–2 días): agregar `positions` al schema existente, agregador swap→position, `/v2/leaderboard/:period` con snapshots.
- **Fase B — Feed social** (2–3 días): `feed_events`, SSE endpoint, panel Feed en trading.html con tabs holders/swaps/thesis (mapeo 1:1 de fomo, implementación original).
- **Fase C — Perfil + Win/Fumble cards** (1–2 días): `profile/:handle` server-rendered en site/, canvas→PNG share card.
- **Fase D — Discovery** (2 días): `/proxy/filterTokensSearch` equivalente (fuzzy search SQLite), filtros trending/graduated/pre-graduated/most-held sobre launches + market data.
- **Fase E — Referrals + notificaciones** (2 días): `ref/:code`, tabla referrals, notifications in-app + Telegram push (ventaja vs fomo).
- **Fase F — SEO funnel** (continuo): `/answers/*` estáticas con el mismo patrón.

**(14) Lista exacta de componentes a construir:**
1. `positions.ts` — agregador swap→position (buy promedia, sell reduce, close calcula PnL) 
2. `feed.ts` — escritura de eventos + lectura paginada + filtros (friends-only, min-size, thesis-only)
3. `sse.ts` — stream `/api/stream` con heartbeat
4. `leaderboard.ts` — snapshots por periodo + query `getTopTraders(period)`
5. `share-card.ts` — render canvas win/fumble → PNG dataURL
6. `search.ts` — fuzzy tokens + users (LIKE/FTS5)
7. `discovery.ts` — listas trending/graduated/pre-graduated/most-held
8. `referrals.ts` — código por usuario, atribución en registro
9. `notifications.ts` — generador por reglas (price, friends-activity con min-size, trending, top-traders) 
10. `profile-page` — HTML server-rendered `/u/:handle`
11. `holders.ts` — provider Blockscout (Robinhood Chain ya verificado) + fallback Birdeye
12. UI panels en trading.html: FeedPanel (tabs), HoldersPanel, ThesisPanel (marks sobre chart), ShareCardModal, SearchBar, FilterChips

---

## Notas de honestidad

- No se ejecutaron llamadas autenticadas, no se modificaron datos, no se accedió a contenido privado.
- Los endpoints listados se extrajeron de bundles públicos estáticos; no se probaron en caliente.
- Todo el análisis es para **implementación original**: la arquitectura propuesta reutiliza el stack propio (packages/app) sin copiar código ni assets de fomo.
