# TRENCHES — Guía completa del proyecto

> **Red social para mercados financieros + terminal de trading on-chain + comunidad de señales.**
> Documento informativo y hoja de ruta. Última actualización: 2026-09-30.

---

## Índice

1. [Qué es TRENCHES](#1-qué-es-trenches)
2. [Arquitectura general](#2-arquitectura-general)
3. [El mercado: datos y terminal](#3-el-mercado-datos-y-terminal)
4. [Trading: cómo se opera de verdad](#4-trading-cómo-se-opera-de-verdad)
5. [La capa social](#5-la-capa-social)
6. [📡 Señales TG y el nuevo gate de acceso 24h](#6-señales-tg-y-el-nuevo-gate-de-acceso-24h)
7. [El bot de comunidad (saur-bot)](#7-el-bot-de-comunidad-saur-bot)
8. [Modelo de seguridad y «reglas de honestidad»](#8-modelo-de-seguridad-y-reglas-de-honestidad)
9. [Despliegue y operación](#9-despliegue-y-operación)
10. [🚀 Llevarlo al siguiente nivel](#10-llevarlo-al-siguiente-nivel)
11. [Riesgos, límites y cumplimiento](#11-riesgos-límites-y-cumplimiento)

---

## 1. Qué es TRENCHES

TRENCHES es **tres productos en uno**:

| Capa | Qué es | Dónde vive |
|---|---|---|
| **Terminal social de trading** | Descubrir tokens (Solana, Base, Ethereum, BSC…), ver gráficos en vivo, operar **self-custody** (tú firmas cada operación con tu wallet) | `site/` → `inusaur.online` |
| **Red social de mercados** | Feed de tesis, traders verificados por PnL real, seguir/copy-trade, leaderboard, rewards en USDC | Mismo frontend + API |
| **Comunidad de señales** | Las llamadas del canal VIP de Telegram (contratos + autor + precio de entrada) convertidas en un log consultable con ROI en vivo | Pestaña 📡 Señales TG (con acceso Elite) |

**Principio rector del proyecto:** la honestidad estructural. Si un dato no existe, la API responde "UNAVAILABLE"; si una operación no está verificada on-chain, no se contabiliza; si una función no está certificada, está deshabilitada — nunca se simula éxito.

---

## 2. Arquitectura general

```
┌─────────────────────────┐         ┌──────────────────────────────┐
│  site/ (GitHub Pages)   │  HTTPS  │  packages/app (Fly.io)       │
│  inusaur.online         │────────▶│  raidos-api.fly.dev          │
│  ES modules, sin build  │         │  Node 22 + TypeScript nativo │
│  ES modules, sin build  │         │  zero-dependency http server │
└─────────────────────────┘         └──────────────┬───────────────┘
        │            ▲                             │
        │            │ long-poll (getUpdates)      │ SQLite (WAL)
        ▼            │                             ▼
┌─────────────────────┴──┐          ┌──────────────────────────────┐
│  Telegram              │          │  raidos.db (volumen Fly)     │
│  - Canal VIP de calls  │          │  users, trades, tg_signals,  │
│  - saur-bot (comunidad)│          │  market_catalog, grants…     │
└────────────────────────┘          └──────────────────────────────┘
```

### Componentes

**`site/` — Frontend (estático, sin framework)**
- `app.html` + `js/*.js` como ES modules nativos con importmap versionado (`?v=YYYYMMDD-N`) para invalidar caché en cada despliegue.
- Módulos clave: `app.js` (shell/navegación), `terminal-view.js` (gráficos lightweight-charts), `trading.js` (compra/venta), `trenches.js` + `gmgn-board.js` (pantalla estilo FOMO/GMGN), `feed.js`/`social.js` (red social), `tg-signals.js` (señales), `dexfeed.js` (stream de precios), `api.js` (cliente HTTP).
- Publicado en GitHub Pages (`nachoweb3/inusaur`, rama `gh-pages`) con dominio `inusaur.online`.

**`packages/app/` — API (Fly.io, `raidos-api`)**
- `api/server.ts`: servidor HTTP node-native (cero dependencias de framework). Router propio con rutas públicas y autenticadas (Bearer API-key), CORS restringido por `ALLOWED_ORIGINS`.
- `database/app-db.ts`: schema SQLite (better-sqlite3) — usuarios, wallets cifradas, trades, launchpad, feed social, `tg_signals`, y desde hoy `tg_access_codes` + `tg_access_grants`.
- `market/`: servicio de datos (DexScreener/GeckoTerminal/CoinGecko con caché y presupuestos por minuto), catálogo indexado (`MarketCatalog` + worker `market_jobs`), métricas de riesgo, GMGN, Helius.
- `trading/`: motor de trading self-custody (quote → prepare → firmar → submit → reconciliar), contabilidad en micro-USDC, launchpad (curva de bonding → AMM Raydium), PnL, rewards.
- `telegram/source.ts`: scraper read-only del canal VIP vía `getUpdates` long-poll (un pase encadenado cada 90 s, con backoff ante errores).
- `social/`, `profiles/`: motor social, ratings de traders, fuentes.

**`saur-bot/` — Bot de comunidad (Telegram, grammY)**
- Comandos de precio ($SAUR): `/price`, `/ath`, `/trend`, `/pressure`, `/graph`, `/predict` (oráculo IA local vía Ollama)…
- Motor de hype, respuestas inteligentes, panel de administración (`/admin`), analíticas diarias.
- **Nuevo:** `/code` — mintea códigos de acceso de 24h a la pestaña de señales (ver §6).

---

## 3. El mercado: datos y terminal

### Proveedores y presupuestos

| API pública | Uso | Caché |
|---|---|---|
| DEX Screener | Búsqueda, lotes de tokens (30/llamada) | 30 s |
| GeckoTerminal | Pools nuevos/trending, velas OHLC 1/5/15 min | 60 s |
| CoinGecko | Precios de referencia (BTC/ETH/SOL) | 300 s |

- Cada respuesta lleva `source`, `status` (LIVE/DEGRADED/UNAVAILABLE), `asOf` y `cacheAgeMs`.
- Límites internos: máx. 500 entradas, timeout 8 s, presupuestos por proceso (DEX 240/min, Gecko 10/min, CoinGecko 8/min).
- Datos con más de 5 min se marcan **DEGRADED**; sin datos, **UNAVAILABLE**. Nunca se inventan velas.

### Catálogo e indexador

`MarketDataService` → `MarketCatalog` (SQLite) → `/api/market/catalog` → UI virtualizada (páginas de 40). El `MarketIndexer` corre en un **worker separado** con el mismo DB_PATH: descubrimiento paginado del proveedor y actualización de activos observados; leases y checkpoints atómicos. Migraciones aditivas y versionadas.

### El terminal

- `TerminalView` (estilo GMGN): columnas de pares + panel lateral persistente, URL con red+contrato compartible, back/Escape restaura contexto, gráfico reutilizable.
- `TRENCHES` (estilo FOMO): grid de tres columnas (nuevos / trending / finales), ticker inferior en vivo, chips de cadena.
- Sparklines por señal: velas 15m reales del pool con marcador 📍 en la entrada y multiple-x calculado (precio actual ÷ precio de entrada registrado).

---

## 4. Trading: cómo se opera de verdad

### La regla de oro

> **Datos de mercado ≠ contabilidad.** El camino contable es
> intención → transacción → fill liquidado → posición/PnL/feed/rewards.
> Nada existe contablemente hasta que el recibo on-chain lo confirma.

### Flujo self-custody (el único activo hoy)

```
1. QUOTE      /api/trades/quote          (precio del proveedor, fees visibles)
2. PREPARE    /api/trades/prepare        (servidor construye TX SIN firmar; requiere
                                          modo live + execution_enabled + wallet vinculada
                                          por challenge de firma + exposición diaria OK)
3. FIRMAR     el usuario en Phantom/MetaMask (la clave NUNCA toca el servidor)
4. SUBMIT     /api/trades/submit         (TX firmada + co-sign solo si el pool lo exige)
5. RECONCILIAR  ExecutionReconciler      (recibo RPC → montos EXACTOS → fill liquidado
                                          atómico e idempotente en SQLite)
```

- Modo `mock` (default): simula fills determinísticos **siempre etiquetados**. Modo `live`: requiere certificación de adaptador; el kill-switch `/api/admin/execution` pausa todo.
- Exposición diaria por usuario (`EXECUTION_DAILY_LIMIT_USDC`, default 1000 USDC), idempotencia por `Idempotency-Key`, sesiones de ejecución persistidas (recuperables si el RPC falla a mitad).

### Contabilidad

- Cantidades en unidades base del activo; USDC contable en **micro-USDC** (1e-6) con conversión explícita para cadenas de 18 decimales.
- Cada venta realiza su delta de PnL; las compras nunca cuentan como victorias.
- Rankings agregados server-side desde fills liquidados, filtrables por modo/cadena/período.
- Posiciones anteriores a la migración están etiquetadas `legacy`: conservadas, nunca presentadas como saldo verificado.

### Launchpad

- Curva de bonding propia (compra/venta contra curva) → graduación → **pool AMM Raydium real** (LaunchLab + CPMM) con swaps self-custody preparados por el servidor y firmados por el usuario.
- Claims registrados con firma (mismo challenge de login) para el momento de migración on-chain.

---

## 5. La capa social

- **Feed**: tesis de trading, posts con activo adjunto, filtros (Para ti / Tesis / Smart Money / Siguiendo).
- **Identidad verificada por PnL**: el rating de trader se calcula desde fills liquidados (no desde opiniones). Sin historial no hay score.
- **Follow graph** server-side (`/api/users/:id/follow`), copy-trade settings (preferencias; ejecución automática NO activa en beta).
- **Leaderboard y rewards**: programa de rewards en USDC (10% de fees propios + 10% de la red), config administrable (`/api/rewards/config` con `ADMIN_SECRET`), flags antifraude (NORMAL/REVIEW/BLOCKED).
- **Wallets de plataforma**: dirección generada por red al registrarse, clave cifrada con `WALLET_ENC_SECRET`; exportación de clave una sola vez vía TLS; importación deshabilitada en live (self-custody primero).
- **Login**: wallet (challenge de firma por cadena), Google OAuth (`GOOGLE_CLIENT_ID`), X. Todos producen una API-key Bearer hasheada en la DB.

---

## 6. 📡 Señales TG y el nuevo gate de acceso 24h

> **Qué cambió hoy:** la pestaña de señales ya no es pública. Es accesible solo con un **código temporal de 24 horas** que el bot entrega por DM a los miembros verificados del grupo.

### El flujo completo

```
        ┌────────────────────────────────────────────────────────────┐
        │ 1. El usuario se une a la Academia Elite (Whop)            │
        │    https://whop.com/checkout/plan_bqfdlqSaIzb7B            │
        │    → acceso al grupo privado de Telegram                   │
        └────────────────────────┬───────────────────────────────────┘
                                 ▼
        ┌────────────────────────────────────────────────────────────┐
        │ 2. En DM con el bot:  /code                                │
        │    • Verifica membresía real (getChatMember del grupo)     │
        │    • Solo funciona en DM (el código nunca queda expuesto)  │
        │    • Rate-limit 1/min por usuario                          │
        │    • POST /api/admin/tg/mint-code (header x-admin-secret)  │
        └────────────────────────┬───────────────────────────────────┘
                                 ▼
        ┌────────────────────────────────────────────────────────────┐
        │ 3. El bot responde con el código personal (ej. K7m2Qx9P)   │
        └────────────────────────┬───────────────────────────────────┘
                                 ▼
        ┌────────────────────────────────────────────────────────────┐
        │ 4. Web → pestaña 📡 Señales TG → formulario de bloqueo     │
        │    POST /api/tg/redeem { code }                            │
        │    • Código de UN SOLO USO                                 │
        │    • Concede 24h exactas desde el canje                    │
        │    • Devuelve pase firmado (fp.HMAC) + cookie httpOnly     │
        └────────────────────────┬───────────────────────────────────┘
                                 ▼
        ┌────────────────────────────────────────────────────────────┐
        │ 5. 24 horas de señales con ROI en vivo                     │
        │    Cada llamada a /api/tg/* valida el pase:                │
        │    header x-tg-pass (cross-origin) o cookie tgp (same-orig)│
        │    Caducado → pantalla de bloqueo otra vez → /code         │
        └────────────────────────────────────────────────────────────┘
```

### Detalles técnicos (para mantenimiento)

**Base de datos** (`packages/app/src/database/app-db.ts`)
- `tg_access_codes`: un código por fila; `mintTgAccessCode` **rota** (revoca el anterior del mismo `telegram_user_id`, así cada miembro tiene exactamente un código vivo). Alfabeto sin ambigüedades (sin `0/O/1/l/I`), 8 caracteres = 62⁸ sin colisiones prácticas.
- `tg_access_grants`: ventana de acceso por **fingerprint** (hash SHA-256, con sal `TG_GATE_SECRET`). Nunca se guardan IPs en crudo. `upsert` mantiene la ventana más larga.

**API** (`packages/app/src/api/server.ts`)
- `POST /api/tg/redeem` — canjea el código (403 si inválido/usado/expirado). Concede y devuelve `{ ok, until, hours, pass }`.
- `GET /api/tg/access` — estado del pase (la web lo consulta al abrir la pestaña; alimenta el countdown).
- `POST /api/admin/tg/mint-code` — mintea códigos; auth server-to-server con `x-admin-secret` (comparación en tiempo constante). **Es la llamada que hace el bot.**
- Gate en `GET /api/tg/signals`, `/api/tg/callers` y `/api/tg/avatar/:id` (los avatares filtran identidad de miembros: detrás del mismo candado).
- El pase firmado es `fingerprint.HMAC-SHA256(fingerprint, TG_GATE_SECRET)`; sin firma válida no hay grant. La cookie `tgp` es canal secundario (same-origin).
- CORS: `x-tg-pass` añadido a `Access-Control-Allow-Headers` (imprescindible porque el sitio y la API son orígenes distintos).
- Housekeeping: `purgeTgAccess()` cada 6 h borra códigos de más de 7 días y grants caducados.

**Frontend** (`site/js/tg-signals.js` + CSS en `app.html`)
- Pantalla de bloqueo con: explicación del acceso (Academia Elite), los 3 pasos, formulario de código, mensaje de error/éxito y **CTA al checkout de Whop** (`Únete al Alpha`).
- Estado en `localStorage` (`trenches_tg_gate` = ventana, `trenches_tg_pass` = pase firmado). El backend es la fuente de verdad; el cache solo evita un round-trip cuando ya sabemos que caducó.
- Si a mitad de sesión el API responde `TG_ACCESS_REQUIRED` (24h cumplidas), la vista vuelve sola a la pantalla de bloqueo.

**Bot** (`saur-bot/src/access.ts` + comando `/code` en `index.ts`)
- `AccessCodeClient`: cliente HTTP hacia la API con el secreto admin. `MintRateLimiter`: anti-spam en memoria.
- Variables nuevas en `saur-bot/.env`: `TRENCHES_API_BASE` (default `https://raidos-api.fly.dev`) y `ADMIN_SECRET` (el MISMO valor que el secreto de la API).

**Variables nuevas (API, Fly secrets):** `TG_GATE_SECRET`, `ADMIN_SECRET`.

### Sinergia con el scraper

El scraper de llamadas no cambia: sigue leyendo el canal VIP (todo chat visible para el bot) y guardando solo lo verificable. Lo que cambió es **quién puede leer el log**: de público a miembros Elite con pase vigente.

---

## 7. El bot de comunidad (saur-bot)

GrammY + SQLite propio (`saur.db`). Funciones:

- **Precio y hype de $SAUR**: ticker periódico al grupo, alertas de pump/dump/ATH cada 2 min, sparkline ASCII.
- **Oráculo IA** (`/predict`, `/ai`): Ollama local (llama3.2:3b por defecto) con datos on-chain reales como contexto; si Ollama no responde, responde honestamente que no.
- **Respuestas inteligentes**: detección de frases, probabilidad y cooldown configurables desde `/admin`.
- **Analíticas**: joins, mensajes, comandos, interacciones; reporte diario a las 20:00 UTC.
- **Panel de admin** (`/admin`): phrases, hype on/off, modelo IA, intervalos.
- **`/code`** (nuevo): el puente entre la comunidad y el producto web (ver §6).

**Por qué importa:** el bot es el **punto de entrada de la comunidad al producto**. Cada miembro que pide `/code` pasa por la web, ve el terminal y potencialmente opera — el bot deja de ser un juguete y se convierte en canal de adquisición y autenticación.

---

## 8. Modelo de seguridad y «reglas de honestidad»

1. **Nunca claves en el navegador.** Self-custody = el usuario firma; el servidor solo prepara TX. Claves de plataforma cifradas con `WALLET_ENC_SECRET`; exportación única.
2. **Secretos solo server-side**: `TG_BOT_TOKEN`, `ADMIN_SECRET`, `TG_GATE_SECRET`, Bearer de X, etc. El navegador recibe datos, nunca credenciales.
3. **Auth en dos planos**: usuarios (challenge de firma / OAuth → API-key hasheada) y server-to-server (header `x-admin-secret` en tiempo constante).
4. **Honestidad estructural**: sin configuración → 503; sin datos → UNAVAILABLE; sin certificación → endpoint deshabilitado; código de acceso usado → rechazo explícito.
5. **Privacidad del gate**: fingerprints con sal, sin IPs en crudo, avatares de miembros también detrás del candado, códigos solo por DM.
6. **CORS mínimo** (`ALLOWED_ORIGINS`), `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, `frame-ancestors 'none'`.
7. **Rate limits y presupuestos** en todo el pipeline de mercado; idempotencia en mutaciones.

---

## 9. Despliegue y operación

| Pieza | Dónde | Cómo |
|---|---|---|
| Web | GitHub Pages `nachoweb3/inusaur` → `inusaur.online` | Copia de publicación `trenches-deploy` (conservar `CNAME` y `.nojekyll`); bump de `?v=` en `app.html` |
| API | Fly.io `raidos-api` (Dockerfile + `fly.toml`) | `fly deploy`; secrets: `TG_BOT_TOKEN`, `TG_GATE_SECRET`, `ADMIN_SECRET`, `WALLET_ENC_SECRET`, `GOOGLE_CLIENT_ID`, `ALLOWED_ORIGINS`, `APP_MODE`, `EXECUTION_DAILY_LIMIT_USDC`… |
| DB | Volumen Fly `raidos_data` → `/data/raidos.db` | SQLite WAL; migraciones aditivas al arranque |
| Worker mercado | `pnpm worker:market` (mismo volumen) | Proceso separado, leases atómicos |
| Bot | `saur-bot/` (local/Windows con `start-bot.bat` + `watchdog.bat`) | `npm run build && npm start`; `.env` con `BOT_TOKEN`, `ADMIN_IDS`, `GROUP_ID`, `TRENCHES_API_BASE`, `ADMIN_SECRET` |

**Checklist post-despliegue del gate:**
1. Fly: `fly secrets set TG_GATE_SECRET=… ADMIN_SECRET=…`
2. Bot `.env`: `ADMIN_SECRET` idéntico → `npm run build` → reiniciar.
3. Probar: `/code` en DM → canjear en la web → señales visibles → a las 24h vuelve el bloqueo.
4. Sin `TG_GATE_SECRET` la API funciona (pase sin firmar, solo dev); **en producción es obligatorio**.

---

## 10. 🚀 Llevarlo al siguiente nivel

> **📌 Roadmap V2**: tras el análisis técnico de Fomo existe un plan de producto completo en **[docs/ROADMAP_V2.md](./ROADMAP_V2.md)** — 9 pilares (Position Engine V2 + Wallet Ingestion como P0, Event Engine, Realtime, Token Workspace con overlays, Wallet DNA, TRENCHES Graph...). Esta sección conserva el plan original centrado en el bot; el roadmap V2 lo engloba y ordena por dependencias.

### 10.1 El bot como trader multichain (la gran apuesta)

La idea: que el bot no solo informo, sino que **opere** — recaude fondos, tenga referidos y conecte con el perfil de Google del usuario en TRENCHES.

**Fase A — Identidad unificada (2-3 días, riesgo bajo)**
1. **Vinculación web ↔ Telegram** sin contraseñas por DM:
   - En la web (Perfil → Conexiones): "Generar código de vinculación" → 6-8 caracteres, 10 min de validez, un solo uso.
   - En Telegram: `/link ABC123` → el bot llama `POST /api/users/link-telegram { code, telegramUserId, telegramUsername }` (con `ADMIN_SECRET`).
   - La DB añade una identidad `provider: "telegram"` al usuario existente (mismo modelo que las identidades solana/evm ya existentes).
   - Resultado: leaderboard, rewards, copy-trade y señales saben **quién es quién** entre web y Telegram.
2. **Comandos de portfolio en el bot**: `/pnl`, `/positions`, `/rewards` → leen la API con la identidad ya vinculada.

**Fase B — Trading desde Telegram (1-2 semanas, riesgo medio)**
- `/buy 0.5 SOL <CA>` y `/sell <CA>` con el MISMO pipeline self-custody de la web:
  - El bot llama `POST /api/trades/prepare` (server-side) y devuelve una **URL de firma** (`t.me/bot?start=sign_<sessionId>`) que abre la web → la web pide la firma a Phantom/MetaMask (Telegram Desktop soporta enlaces profundos; en móvil se abre el navegador).
  - La sesión de ejecución ya existe (`createSelfCustodySession`) — reutilizarla completa, con su reconciliación.
- **No** guardar claves privadas en el bot. La custodia rompe el modelo de confianza, la legalidad y la seguridad del proyecto (ver §11).

**Fase C — Recaudación y referidos (paralelo a B)**
- **Referidos**: el `ref_code` ya existe en la DB y en el registro. Añadir `/ref` al bot → devuelve el enlace `inusaur.online/join?ref=CODE` y las estadísticas del usuario (`/api/me/referrals`). Los rewards del programa (10%+10%) ya están calculados server-side.
- **Recaudación / tesorería de comunidad**:
  - Opción honesta: **vaults de estrategia** read-only — el bot muestra el PnL agregado de una wallet de tesorería que administra el operador, con proofs on-chain.
  - Opción self-custody grupal: pools donde cada participante firma su depósito (contrato simple en Solana con autoridad de retiro del operador + timelock). Requiere auditoría del contrato antes de mover un dólar.
- **Whop API**: al confirmarse un pago, webhook → `POST /api/admin/tg/mint-code` automático + invitación al grupo. Elimina el paso manual de membership.

**Fase D — Señales accionables**
- Botones en la card de señal: "Operar esta llamada" (abre el terminal con CA + cadena precargados — ya existe `openTerminal`).
- Alertas del bot a los miembros con pase activo: "nueva llamada de @caller que sigues".

### 10.2 Producto

- **Notificaciones**: web push para watchlists y alerts de smart money (hoy el social engine ya detecta el pulso).
- **Copy-trade real**: las preferencias ya persisten; falta certificar la ejecución atómica de la réplica (el reconciliador es la base).
- **Backtesting de señales**: con el histórico de `tg_signals` + velas, calcular ROI de cada caller a 1h/24h/7d — ranking de veracidad que ya puede salir en la pestaña de callers.
- **Página pública de transparencia**: conteo de llamadas, % que llegaron a 2x, deuda de rewards — refuerza la marca honesta.

### 10.3 Infraestructura

- **Caché compartida** (Redis) cuando un solo proceso no dé abasto; hoy el presupuesto es por proceso.
- **Postgres** solo si el volumen de escritura social lo exige; SQLite + WAL aguanta mucho más de lo que la intuición sugiere con este patrón de acceso.
- **CDN delante del API** para los endpoints públicos de solo lectura (`/api/market/*`) con TTL corto.
- **Observabilidad**: structured logs con request-id, métricas de latencia por proveedor y alerta cuando `DEGRADED` > umbral.

### 10.4 Monetización

| Vía | Estado | Siguiente paso |
|---|---|---|
| Whop (Academia Elite) | Checkout activo, gate manual `/code` | Webhook de Whop → mint automático |
| Fees de trading | Ya cobrados en cada swap (`platformFeeBps`) | Dashboard de revenue (`revenue_events` existe) |
| Rewards | Motor completo con flags antifraude | Activar payouts cuando el volumen lo justifique |
| Suscripciones | `subscription` + tiers en DB | Exponer en la web + perks (pase de señales permanente para tiers altos) |

---

## 11. Riesgos, límites y cumplimiento

- **Custodia**: el proyecto se construye sobre self-custody. Cualquier feature que exija custodiar claves de terceros (bot con wallets de usuarios, vaults con depósitos) entra en territorio de custodio — con obligaciones legales según jurisdicción. La Fase B/C de §10 está diseñada para crecer sin cruzar esa línea.
- **Telegram ToS**: el scraping se limita a chats donde el bot es miembro legítimo y solo almacena mensajes con contratos (nunca conversación general).
- **Datos de terceros**: DexScreener/GeckoTerminal/CoinGecko tienen términos de uso y rate limits; los presupuestos internos existen también para respetarlos.
- **Privacidad**: el gate guarda fingerprints con sal, no IPs; los avatares son proxy con caché de 24 h; los códigos caducan y se purgan.
- **Expectativas financieras**: señales ≠ asesoramiento. El oráculo, las analíticas y el ROI en vivo son herramientas de información; la UI ya lo comunica y conviene mantenerlo en toda pieza nueva.

---

## Anexo A — Comandos rápidos

```bash
# API
cd packages/app && pnpm install && pnpm typecheck && pnpm test
pnpm build && pnpm start            # servidor local (APP_MODE=mock)

# Web (servir estático)
cd site && python -m http.server 8931

# Bot
cd saur-bot && npm install && npm run build && npm start
```

## Anexo B — Endpoints nuevos del gate

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| POST | `/api/tg/redeem` | pública | Canjea código de un solo uso → 24h de acceso |
| GET | `/api/tg/access` | pública | Estado del pase (`{ enabled, until }`) |
| POST | `/api/admin/tg/mint-code` | `x-admin-secret` | Mintea/rota el código de un miembro (lo usa el bot) |
| GET | `/api/tg/signals` · `/callers` · `/avatar/:id` | pase 24h | Datos de señales (401 `TG_ACCESS_REQUIRED` sin pase) |
