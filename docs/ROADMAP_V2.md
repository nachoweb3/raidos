# TRENCHES — Roadmap V2
### De "otra terminal de memecoins" a red de inteligencia financiera on-chain

> **Origen**: análisis técnico de Fomo (`docs/research/fomo-full-technical-analysis.md`) + visión del operador (sep 2026).
> **Tesis**: no copiar Fomo. Robarle el modelado de producto (la posición como entidad central, todo genera eventos) y superarlos donde ellos hacen polling (realtime) y no llegan (grafo verificable señal↔trader↔wallet↔resultado).
>
> **Loop de producto**: `DISCOVER → UNDERSTAND → TRADE → VERIFY → FOLLOW → COPY → EARN`
> Cada vuelta del loop genera datos propietarios. Ese dataset + grafo es el moat, no el RPC.

---

## 0. Lo que Fomo nos enseñó (y qué hacemos distinto)

| Aprendizaje de Fomo | Decisión TRENCHES |
|---|---|
| La entidad central es la **posición**, no el trade | ✅ Adoptar como P0. Todo (feed, perfil, leaderboard, cards) sale del Position Engine |
| Todo genera eventos (`feed_events`) | ✅ Adoptar y **generalizar** a Event Engine universal (no solo social) |
| Web con polling 3s/10s/1min | ⚡ **Superar**: SSE (ya existe) → WebSocket por token. Que se *sienta* vivo |
| Comprar servicios commoditized (Jito, Relay, Privy, Hyperliquid, Defined) | ✅ Adoptar: el moat es el dataset/grafo, no el RPC |
| Embedded wallet: email/Apple → wallet → trade en <1 min | ✅ Adoptar conservando export key / connect external / withdraw |
| SIMPLE vs PRO en una sola plataforma | ✅ Adoptar: sirve a alumnos de la Academia y a degens a la vez |
| Holders list → holder intelligence | ✅ Adoptar y llevarlo a Wallet DNA (scores derivados de métricas visibles) |
| Win/Fumble cards compartibles | ✅ Adoptar: cada imagen publicada en X es publicidad de TRENCHES |
| Tesis dibujadas sobre el chart | ⚡ **Superar**: timeline del token con TODOS los overlays (smart money, callers, dev, ballenas, señales elite) |
| Miden todo (PostHog/Statsig/Datadog) | ✅ Adoptar: product analytics + feature flags desde ya |
| Perps | ❌ NO construir: Hyperliquid debajo, un día, si hace falta |
| — | 🆕 **Nuestro diferencial**: Signal Graph (reputación verificable de callers) — Fomo no tiene ingesta de Telegram |

---

## 1. Estado actual: qué ya existe (inventario verificado en código)

Este roadmap no parte de cero. Mucho del board ya está construido en versión v1:

| Pilar | Estado | Dónde |
|---|---|---|
| **Position Engine v1** | ✅ Existe | `positions` (app-db.ts:237): avg_entry, amount_remaining, realized/unrealized PnL, ciclo por token/user; agregador en reconciliador (server.ts:3462 emite `position_closed`) |
| **Event stream** | ✅ Existe (parcial) | `feed_events` (app-db.ts:257): `swap`, `position_closed`, `call`, `launch`, `raid`, `badge`, `thesis`; `addFeedEvent` + índices por ts/actor/token |
| **Realtime** | ✅ Existe (SSE) | `GET /api/feed/stream` (server.ts:2844): SSE con `sinceId`, ping cada 3s (re-lee la DB; no es push puro pero es push UX) |
| **Leaderboard temporal** | ✅ Existe | `GET /api/leaderboard?period=1h/24h/7d/30d/all&chain=` sobre settled fills |
| **Holders** | ✅ Existe | `GET /api/tokens/:chain/:address/holders` con providers en cascada (Blockscout live → mock etiquetado SIMULATED) |
| **Follow graph** | ✅ Existe | `/api/users/:id/follow` + followers/following |
| **Copy-trade** | ✅ Existe (base) | subscriptions + signals + rating + ct-calls; falta ejecución atómica certificada |
| **Trading self-custody** | ✅ Existe | prepare/submit con reconciliación durable; fees (`platformFeeBps`) |
| **Señales TG + gate 24h** | ✅ Existe | `tg_signals`, `/code` del bot, pase firmado 24h, CTA Whop |
| **Charts** | ✅ Existe | velas propias (`/api/market/candles`) + chart tools (docs/2026-09-17-chart-tools) |

**Lectura honesta**: el delta vs el board no es "empezar de cero", es **ingesta on-chain de wallets externas** (lo que no opera por TRENCHES no existe para el grafo) y **overlays/timeline**.

---

## 2. Los 9 pilares, ordenados por dependencia

```
                    ┌─────────────────────────────┐
                    │  1. Position Engine V2      │  ← P0 · dependencia de casi todo
                    │     + Wallet Ingestion      │
                    └──────────────┬──────────────┘
                                   │
                 ┌─────────────────┼─────────────────┐
                 ▼                 ▼                 ▼
   ┌────────────────────┐ ┌──────────────────┐ ┌─────────────────┐
   │ 2. Event Engine    │ │ 4. Token         │ │ 3. Realtime     │
   │    universal       │ │    Workspace V2  │ │    V2 (WS)      │
   └─────────┬──────────┘ └────────┬─────────┘ └────────┬────────┘
             │                     │                    │
             ▼                     ▼                    ▼
   ┌────────────────────┐ ┌──────────────────┐ ┌─────────────────┐
   │ 5. Social Alpha    │ │ 7. Wallet        │ │ 6. Perfiles +   │
   │    Feed            │ │    Intelligence  │ │    Leaderboard  │
   └─────────┬──────────┘ └────────┬─────────┘ └─────────────────┘
             │                     │
             └──────────┬──────────┘
                        ▼
              ┌──────────────────┐
              │ 8. TRENCHES Graph│  ← el moat
              └────────┬─────────┘
                       ▼
              └─ 9. Share Engine + AI/Command (consume el grafo)
```

---

## 3. Los pilares en detalle

### 1. Position Engine V2 + Wallet Ingestion — **P0**
La posición alimenta feed, perfil, leaderboard, cards sociales y copy. Es la dependencia de casi todo.

**Extiende lo que ya existe** (`positions` v1 solo cubre swaps propios):
1. Agregador swap→position **generalizado**: mismo motor para (a) fills propios (ya funciona), (b) **swaps on-chain de wallets trackeadas** (nuevo).
2. **Wallet Ingestion**: ingesta de swaps on-chain de wallets externas (whales, smart money, dev, early buyers) — hoy solo existen los fills propios. Sin esto, el grafo no tiene nodos.
3. Partial sells, average entry, realized/unrealized PnL, **MAX PnL (ATH x)** y **timeline** (ordenado) de fills de la posición.
4. Milestones automáticos: `POSITION_2X`, `POSITION_5X`, `POSITION_10X` (ya emitimos `position_closed`; añadir milestones).

**Esquema** (migración aditiva, patrón del repo):
```sql
CREATE TABLE IF NOT EXISTS tracked_wallets (
  address TEXT NOT NULL, chain TEXT NOT NULL,
  label TEXT, category TEXT CHECK(category IN ('smart','whale','dev','kol','internal','watch')),
  score REAL, added_by INTEGER, added_at INTEGER,
  PRIMARY KEY (chain, address)
);
CREATE TABLE IF NOT EXISTS onchain_swaps (
  signature TEXT PRIMARY KEY,          -- dedupe
  chain TEXT NOT NULL, token TEXT NOT NULL, wallet TEXT NOT NULL,
  side TEXT CHECK(side IN ('buy','sell')),
  amount_token TEXT, amount_sol TEXT, amount_usdc TEXT,
  mc_usd REAL, ts INTEGER NOT NULL
);
CREATE INDEX idx_onchain_swaps_wallet_ts ON onchain_swaps(wallet, ts DESC);
CREATE INDEX idx_onchain_swaps_token_ts  ON onchain_swaps(token, ts DESC);
-- positions v2: user_id puede ser 0/NULL para posiciones de wallets externas
-- (o tabla espejo wallet_positions con wallet en vez de user_id)
CREATE TABLE IF NOT EXISTS wallet_positions (
  wallet TEXT NOT NULL, chain TEXT NOT NULL, token TEXT NOT NULL, ...misma forma que positions...
  PRIMARY KEY (wallet, chain, token, opened_at)
);
```
**Eventos que emite**: `WALLET_BUY/SELL`, `SMART_MONEY_BUY/SELL`, `DEV_BUY/SELL`, `WHALE_ENTRY`, `POSITION_OPENED/INCREASED/REDUCED/CLOSED`, `POSITION_2X/5X/10X`.

**Nota sobre la fuente de datos**: las velas/trades ya llegan de DexScreener/GeckoTerminal (`/api/market/trades`); para swaps históricos por wallet la opción más barata es **Helius Enhanced Transactions API** (parsea swaps de un wallet, con webhook opcional) — decidir proveedor al implementar, con presupuesto de proveedores como el resto (`docs/MARKET_OPERATIONS.md`).

### 2. Universal Event Engine — depende de 1
`feed_events` ya es la tabla; lo que falta es **cobertura y taxonomía**:
- **Taxonomía** (prefijo dominio, extensible sin migrar nada):
  - Token: `TOKEN_CREATED`, `TOKEN_MIGRATING`, `TOKEN_MIGRATED`
  - Wallets: `WALLET_BUY/SELL`, `SMART_MONEY_BUY/SELL`, `DEV_BUY/DEV_SELL`, `WALLET_DNA_...`
  - Positions: `POSITION_OPENED/INCREASED/REDUCED/CLOSED`, `POSITION_2X/5X/10X`
  - Calls: `CALL_CREATED`, `CALL_2X`, `CALL_5X`, `CALL_FAILED`
  - Social: `THESIS_POSTED/UPDATED`, `SOCIAL_SPIKE`, `VOLUME_SPIKE`, `LIQUIDITY_CHANGE`, `HOLDER_SPIKE`
- **Regla**: cada emisor (`trade execute`, reconciliador, TG ingest, market poll, Whop webhook) emite al bus en vez de mutar UI directamente. Feed, bot, alertas, leaderboard y futuro AI **consumen el mismo flujo**.
- `type` es TEXT sin CHECK: la taxonomía crece sin migraciones. El repo ya hace esto (strings libres).

### 3. Realtime V2 (SSE → WebSocket) — independiente
SSE actual re-lee la DB cada 3s. Fases:
1. **Ahora**: in-memory event bus (Node EventEmitter) → SSE push real (0-latencia dentro del proceso, sin Redis).
2. **Después**: WebSocket por token (`/ws/token/:chain/:address`) para chart/trades/overlays; SSE queda para feed global.
3. Polling queda como fallback re-connect (ya lo maneja el frontend).

**Superior a Fomo**, que hace polling 3s/10s/1min.

### 4. Token Workspace V2 — depende de 1 y 2
La **timeline del token** como característica definitoria: el chart cuenta la historia completa.
- Chart central (ya existe) + tabs: `OVERVIEW · TRADES · HOLDERS · SMART · DEV · SIGNALS · THESIS · SOCIAL`.
- **Overlays sobre el gráfico** (una capa por tipo): 🟢 my buys · 🔵 smart money · 🟣 caller call (con hover: entry MC, current/ATH x, followers at call) · 🟡 dev sell · 🔴 top holder sell · 📡 elite signal · 💬 thesis.
- Holders con inteligencia: % supply + wallet age + 30D PnL + win rate + first purchase MC + **SELLING?** + FOLLOW.
- **Earliest Buyers** + botón "find wallets appearing repeatedly among early buyers" → **discovery de smart money** (alimenta tracked_wallets).
- SIMPLE vs PRO: card simple (+%, risk, smart money count, elite calls) para alumnos; PRO completo para degens.

### 5. Social Alpha Feed — depende de 1, 2
Nada de posts vacíos estilo Twitter. Solo eventos con información accionable:
- "NACHOWEB3 bought $ABC · 0.72 SOL · MC $81K · Position OPEN · 30D PNL +$18K · Win rate 61% · [VIEW CHART] [COPY TRADE]".
- Posiciones verificadas on-chain ("VERIFIED ONCHAIN"), cierres, tesis, llamadas, milestones.
- Feed hoy mezcla social y trading; separar por `type` (el bus del pilar 2 lo permite) + filtros por token.

### 6. Trader Profiles + Leaderboard — depende de 1, 2
- Ya hay leaderboard por periodos y follow graph. Falta: perfil completo con posiciones abiertas/cerradas, gráfico de PnL, calls del trader (Signal Graph, §8), gráficos por periodo.
- Win/Fumble compartibles (pilar 9).

### 7. Wallet Intelligence + Wallet DNA — depende de 1
- Reconstrucción de wallet: earliest buys, financiación, relaciones, comportamiento.
- **Earliest buyers** por token + detección de wallets recurrentes (→ tracked_wallets con category smart).
- **Wallet DNA** (huella visual): Early Entry / Momentum / Scalping / Conviction / Risk / distribución por categoría. **Regla honesta**: los números siempre derivados de métricas visibles (ratios calculables de onchain_swaps), nunca un score magnético de IA.
- Holder card: `#3 · 4.1% · wallet age 412d · 30D PNL +$81K · 829 tokens · win rate 64% · 12 conexiones conocidas · first purchase $82K MC · SELLING? NO · [FOLLOW]`.

### 8. TRENCHES Graph — depende de 1, 2, 7
El moat. Grafo verificable **señal ↔ trader ↔ wallet ↔ token ↔ deployer ↔ funding ↔ thesis**.
- **Signal Graph**: por token, todas las llamadas TG ordenadas con MC de entrada y resultado (Nacho 14:31 @$81K · Trader2 14:36 @$102K · Trader3 15:04 @$190K).
- **Caller reputation** derivada: median entry advantage, % calls before 2x, % reaching 2x/5x/10x — ya diseñado en GUIA §10.2 (backtesting de señales con `tg_signals` + velas).
- Storage: puede empezar como tablas SQLite (edges materializadas) sin grafo dedicado; migrar a grafo real (o queries recursivas) cuando las consultas lo pidan.

### 9. Share Engine + TRENCHES AI/Command — depende de todo lo anterior
- **Win/Fumble cards**: canvas→PNG ya validado como patrón en el repo (fomo research Fase C). Win: entry/ATH/x verificable + QR `trenches.trade/p/nacho/abc`. Fumble: "Sold at $130K · Current $2.1M · MISSED 16.1X". Cada imagen publicada en X = publicidad.
- **TRENCHES Command** (⌘K): `buy 0.5 sol pepe`, `show wallets profitable on bonk`, `find tokens below 200k with 3 smart wallets`, `what did nacho buy today` — lenguaje → filtros/query sobre **datos reales propios** (grafo + eventos). Construir SOLO después del grafo, o la IA genera análisis genérico.
- **Product analytics + feature flags** (transversal, empezar ya): eventos de producto (`token_opened`, `intel_expanded`, `buy_clicked/completed/failed`, `signal_traded`, `share_generated`...), flags (`smart_money_v2`, `wallet_dna`, `copy_trade`...) con rollout admins→beta→5%→100%. Ligero: tabla `product_events` + tabla `feature_flags` en la misma DB, sin SaaS externo al principio.

---

## 4. Orden de construcción recomendado

| # | Pilar | Effort | Riesgo | Por qué ahora |
|---|---|---|---|---|
| P0 | 1. Position Engine V2 + Wallet Ingestion | 1-2 sem | Proveedor de datos | Dependencia de casi todo |
| P1 | 2. Event Engine + 3. Realtime push real | 3-5 días | Bajo | Barato, transforma la sensación de "vivo" |
| P1 | 9-transversal. Product analytics + flags | 2-3 días | Bajo | Empezar a medir YA |
| P2 | 4. Token Workspace V2 (overlays) | 1-2 sem | Medio | Necesita 1+2 |
| P2 | 6. Perfiles + Win/Fumble | 1 sem | Bajo | Crecimiento (share cards) |
| P3 | 5. Social Alpha Feed V2 | 1 sem | Bajo | Necesita 1+2 |
| P3 | 7. Wallet Intelligence/DNA | 1-2 sem | Medio | Necesita ingesta rodando |
| P4 | 8. TRENCHES Graph + Signal Graph | 2-3 sem | Alto (modelo de datos) | El moat, cuando haya datos |
| P4 | 9. AI/Command | 1-2 sem | Medio | Solo con grafo+eventos |

---

## 5. Principios no negociables (heredados del repo)

1. **Self-custody siempre**: embedded wallet con export key; el backend jamás custodia claves de terceros (§11 de la guía).
2. **Honestidad de datos**: holders live vs SIMULATED etiquetados; Wallet DNA derivado de métricas visibles; señales ≠ asesoramiento.
3. **SQLite + WAL aguanta**: no saltar a Postgres/Redis hasta que un solo proceso no dé abasto.
4. **Proveedores con presupuesto**: el moat es el dataset/grafo, no el RPC. Comprar lo commoditized (Jito, Hyperliquid, auth, fiat), construir el grafo.
5. **Migraciones aditivas + versiones `?v=` en importmap**: patrón del repo para no romper nada.
6. **Anti-fraude en rewards**: los milestones y leaderboards verificables heredan los flags antifraude existentes.

---

## 6. Primer sprint (P0 — Position Engine V2 + Wallet Ingestion)

**✅ Entregado (2026-09-30) — Overlays v1 con datos existentes** (primera piedra del Token Workspace V2, sin esperar a la ingesta):
- `site/js/overlays.js` — `TokenOverlaysEngine`: llama de la pestaña Señales TG (📡) + fills propios settleados (C/V) como marcadores sobre el chart del terminal, fusionados con los del pool (formas disjuntas: flechas = pool, cuadrado = fills, círculo = señal).
- `site/js/gate-state.js` — estado del pase 24h extraído a módulo compartido (web y overlays reutilizan las mismas claves/headers).
- Leyenda con conteos + toggle persistente (`trenches_chart_overlays_v1`), CSS en terminal-premium.css.
- Fix crítico del gate descubiert por el test E2E: `TG_PASS_RE` rechazaba el pase firmado `fp.HMAC` (con punto) → el canal `x-tg-pass` no funcionaría en producción; corregido para aceptar ambas formas y verificar el HMAC sobre el fingerprint.
- Tests: `token-overlays.test.ts` (unit de marcadores + E2E real: mint→redeem→pase→señales gated + fills→marcadores fusionados).

**✅ Entregado también (2026-09-30) — Wallet Ingestion v1** (paso 1, 2 y 4 del P0):
- `tracked_wallets` + `onchain_swaps` en AppDb (migración aditiva, dedupe por signature, índices wallet/token).
- `market/wallet-activity.ts`: provider interface + `HeliusWalletActivityProvider` (Enhanced Transactions API, 100 créditos/llamada; traduce SWAP→buy/sell descartando legs ambiguos) + mock etiquetado.
- Poller budgetado en el server: top-down por prioridad, máx 10 wallets/pase, cursor 5 min por wallet, primer pase a los 2s, purga 30d; arranca solo con `HELIUS_API_KEY` (`WALLET_ACTIVITY=off` lo desactiva).
- API: `GET/POST/DELETE /api/admin/wallets` (ADMIN_SECRET) + `GET /api/tokens/:chain/:address/onchain-activity` (público tras el gate 24h de señales — wallet intel es valor Elite).
- Overlays v2 en el terminal: 🟢 S = smart money observado, 🟡 D = movimientos del dev, fusionados con llamadas TG y fills propios.

**✅ Entregado también (2026-10-01) — Agregador de posiciones (pasos 3 y 6 del P0): sprint P0 CERRADO**
- `trading/wallet-positions.ts` — `applySwapToWalletPosition`: el motor de coste promedio de `positions.ts` generalizado a wallets externas (clave wallet+chain+token en vez de user_id). Partial sells pro-rata, avg entry, realized PnL, MAX PnL (`max_multiple`) y milestones `POSITION_2X/5X/10X` derivadas del múltiplo precio/entrada-**promedio** (cruzar 2x+5x+10x en un solo swap emite los tres; `max_multiple` es monótono, sin duplicados).
- Honestidad: métricas USD (avg entry, basis, PnL, múltiplos) SOLO con precios observados — una compra sin precio envenena el basis a `null` (nunca se interpola); ventas huérfanas y sobreventas se saltan (el tracker nunca clampea ni inventa).
- AppDb: `wallet_positions` (tabla espejo de `positions`, PK wallet+chain+token) + `wallet_position_milestones` (idempotente por `signature:KIND`, `emitted` para exactly-once) + `rebuildWalletPositions()` (rebuild determinista completo desde `onchain_swaps`, mismo argumento que el motor de posiciones propio: un solo escritor, WAL-safe, sin merge logic) + listados por token/wallet.
- Server: tras cada pasada de ingesta con swaps nuevos → rebuild + emisión de milestones a `feed_events` (eventos de sistema, `actor_id` 0, payload con wallet/múltiplo/source; `markWalletMilestonesEmitted` garantiza exactly-once).
- API: `/api/tokens/:chain/:address/onchain-activity` ahora expone también `positions` (abiertas por defecto, `openOnly=false` para todas) y `milestones` del token — mismo gate 24h.
- Tests: `tests/wallet-positions.test.ts` (+6: unit de coste promedio/partial sells/milestones/honestidad-null/rechazos, rebuild idempotente con huérfanas y sobreventas, E2E ingest→agregación→feed) → suite 589/589.
- Pendiente menor del P0: 5b (enriquecer observaciones con precio/MC USD — Helius Enhanced hoy no aporta valor USD; el schema ya lo soporta vía `price_usd`).

*(Los siguientes sprints salen del orden de §4.)*
