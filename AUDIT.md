# TRENCHES / RaidOS — Full Project Audit

**Fecha:** 2026-09-14  
**Alcance:** auditoría estática completa del repositorio + ejecución de tests y typecheck disponibles  
**Estado:** auditoría completada; Sprint P0 inicial implementado parcialmente; live custody sigue bloqueada hasta completar self-custody signing y reconciler  
**Benchmark:** análisis documentado de `fomo.family` en `docs/research/fomo-full-technical-analysis.md` y `docs/research/fomo-family-feature-analysis.md`

> Este documento distingue entre lo que existe en el código y lo que está validado end-to-end. La presencia de una pantalla, ruta, comentario o configuración no se considera evidencia suficiente de una funcionalidad terminada.

---

## 0.1 Sprint P0 implementation update

Implementado después de la aprobación del diseño self-custody-first:

- El fallback de quote mock en `APP_MODE=live` fue eliminado; el proveedor fallido devuelve `503`.
- `POST /api/feed/post` ahora requiere autenticación y ya no usa actor implícito `1`.
- `POST /api/trades/execute` requiere `Idempotency-Key` y persiste intents, transactions y fills en SQLite.
- Las rutas custodiales de creación/importación/borrado de wallets y la ejecución live quedan bloqueadas con `403`.
- Se añadieron estados persistentes de ejecución y hashing canónico del request.
- El frontend principal ya no crea posiciones optimistas tras errores de API; se refresca desde backend.
- `site/trading.html` fue congelado y redirige a `app.html`.

Pendiente antes de marcar el sprint como DONE:

- Implementar receipt reconciler real y settlement transaccional completo para una chain.
- Migrar toda la proyección de portfolio/PnL a fills settled; el trade compatible ya recibe realized PnL al cerrar una posición.
- Incorporar identity `{chain,address}` en todas las consultas de holdings.
- Parsear fills y ejecutar settlement posterior al receipt para self-custody; el endpoint de reconcile confirma receipts, pero no proyecta todavía una operación sin payload de fill asociado.
- Completar approvals/allowances self-custody EVM y adaptar providers a cada wallet.
- Verificar E2E manual en Phantom/MetaMask y testnet antes de habilitar producción financiera.

## 0. Executive summary

El repositorio contiene **tres productos parcialmente relacionados**:

1. **`packages/app`**: API y dominio de una aplicación de trading custodial multi-chain con wallets cifradas, swaps, launchpad, posiciones, feed, perfil, rewards y mercados de predicción.
2. **`site/`**: frontend web estático de TRENCHES, con una aplicación principal (`app.html`) y un terminal legacy/alternativo (`trading.html`).
3. **`packages/core`** y **`saur-bot`**: dos productos de bot/comunidad de Telegram con inteligencia, gamificación, raids, market intelligence y contenido.

La base actual es valiosa para un **MVP técnico**, pero no debe considerarse todavía una plataforma de trading de producción. El mayor riesgo no es la ausencia de UI: es que existen caminos donde la interfaz aparenta una operación real aunque el sistema de ejecución, balance, confirmación, posición y PnL no estén completamente conectados.

### Veredicto por dominio

| Dominio | Estado global | Motivo |
|---|---|---|
| Landing/waitlist | **REAL / PARTIAL** | Captura persistida y datos de mercado públicos; access code estático por defecto y fallback de red ambiguo |
| API base | **REAL para MVP / TECHNICAL DEBT** | HTTP funcional, SQLite y tests; sin rate limiting, observabilidad ni contratos robustos |
| Auth por API key | **PARTIAL** | Hashes y Bearer funcionan; generación de IDs, rotación y modelo de sesión necesitan endurecimiento |
| Wallet custody | **PARTIAL / P0 SECURITY BLOCKER** | AES-GCM + scrypt existe, pero claves privadas se descifran en el servidor y se guardan en memoria durante firma |
| Login por wallet | **PARTIAL** | Verificación de firma y nonce single-use; challenge no está ligado explícitamente a address/origen/sesión |
| Quotes | **PARTIAL** | Jupiter/0x/Li.Fi implementados, pero fallback silencioso a mock en modo live y validación de parámetros es insuficiente |
| Swap execution | **PARTIAL / P0** | Broadcast live existe, pero se marca confirmado sin esperar confirmación on-chain robusta y el estado de transacción es incompleto |
| Bridge | **PLACEHOLDER** | Solo quotes; ejecución devuelve 501 |
| Posiciones | **PARTIAL / P0 accounting** | Agregador buy/sell existe, pero el modelo y los trades/PnL no son una fuente contable coherente |
| Portfolio | **PARTIAL / BROKEN en casos importantes** | Holdings derivados de swaps; no hay valuación multiactivo completa ni PnL unrealized persistido |
| Discovery | **PARTIAL** | CoinGecko/DexScreener y filtros reales; universo principal es curado, smart money no existe realmente |
| Smart money | **PLACEHOLDER** | No hay indexador de wallets rentables/clusters; se eliminó código falso, correctamente |
| Feed | **PARTIAL** | Feed events y SSE existen; follows, likes, perfiles y filtros no están conectados de forma completa |
| Social trading | **PARTIAL** | Leaderboard y preferencias de copy-trade existen; follow/copy execution/actividad por trader faltan |
| Copy trading | **PLACEHOLDER / PARTIAL** | Se guardan settings; la ejecución automática está explícitamente desactivada |
| Launchpad | **MOCK / PARTIAL** | Bonding curve en SQLite simula economía; no despliega token ni liquidez DEX |
| Prediction markets | **PARTIAL / REAL data** | Datos públicos y CLOB order placement intentado; requiere validación real de integración y riesgo operacional |
| Rewards | **PARTIAL** | Ledger, límites e idempotencia diseñados; claim es interno, no transferencia on-chain |
| Multichain | **PARTIAL** | 9 configuraciones declaradas; operación real solo es plausible en una parte del conjunto |
| Mobile | **PARTIAL** | PWA/Capacitor y CSS responsive existen; no hay evidencia de QA móvil real ni build nativo en repo |
| Telegram brain | **REAL para su propio producto** | 101 tests y typecheck pasan; está separado del producto de trading |

### Bloqueadores antes de producción

1. **No permitir que `APP_MODE=live` haga fallback a una quote mock.** Un fallo del proveedor nunca debe convertirse en una quote operable.
2. **No marcar una transacción como confirmada solo porque el RPC aceptó el broadcast.** Hace falta lifecycle `created → submitted → pending → confirmed/failed/reorged`.
3. **Corregir contabilidad de posiciones/PnL y usar una única fuente de verdad.** Actualmente `trades`, `positions` y `computePnlByToken` pueden divergir.
4. **Eliminar o aislar el terminal legacy `site/trading.html`**, que contiene caminos optimistas y datos inconsistentes con `app.html`.
5. **Añadir autorización, rate limiting, CSRF/origin policy, idempotency keys y auditoría de acciones sensibles.**
6. **No activar custody/copy trading/launchpad on-chain hasta una revisión de seguridad específica.**

---

# 1. CURRENT STATE

## 1.1 Repository map

```text
packages/app/        API + domain logic del trading app
packages/core/       Telegram Community Brain, gamification, market/content intelligence
saur-bot/            Bot legacy/alternativo específico de una comunidad/token
site/                Frontend estático: landing, app principal y terminal legacy
  app.html           Shell mobile-first que importa site/js/*.js
  trading.html       Terminal independiente con JS inline y modelo propio
  js/                api, app, feed, discover, trading, portfolio, social, rewards...
docs/                specs, research benchmark, marketing, sales y planes anteriores
Dockerfile            Imagen de packages/app
fly.toml              despliegue Fly.io con APP_MODE=live y volumen SQLite
railway.json          alternativa de despliegue Railway
```

## 1.2 Entry points

| Entry point | Función | Observación |
|---|---|---|
| `packages/app/src/api/main.ts` | Arranca API HTTP | No carga explícitamente `dotenv`; depende del entorno de ejecución |
| `packages/app/src/api/server.ts` | API + static server | 1.269 líneas; concentra routing, dominio, auth y orchestration |
| `packages/core/src/index.ts` | Bot Community Brain | Wiring de comandos y jobs de fondo |
| `saur-bot/src/index.ts` | Bot legacy | Producto separado, configuración específica y algunos defaults placeholder |
| `site/app.html` | App principal | HTML grande con shell y modales; importa módulos ES |
| `site/trading.html` | Terminal alternativo | Código inline duplicado y comportamiento divergente |
| `site/index.html` | Landing | Waitlist, access gate y mockup de producto |

## 1.3 Persistence

`packages/app/src/database/app-db.ts` usa SQLite con WAL y migraciones automáticas. El esquema incluye:

- `users`, `identities`, `wallets`
- `trades`, `positions`, `feed_events`
- `launches`, `launch_buyers`
- `profiles`, `follows`, `calls`, `copy_settings`
- `subscriptions`, `revenue_events`, `ad_campaigns`
- `leaderboard_snapshots`
- `rewards_config`, `rewards_ledger`, `rewards_flags`

`packages/core/src/database/db.ts` implementa otra base SQLite multi-tenant por `chat_id`, con brain, mensajes, KB, XP, quests, raids, contenido y market snapshots.

No hay Prisma, Drizzle, migraciones versionadas ni PostgreSQL en el repositorio. Las migraciones son `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE` condicionales ejecutadas al arrancar.

## 1.4 Verification performed

### Sprint P0 verification update

Verificación ejecutada después de reinstalar desde el lockfile:

| Comando | Resultado |
|---|---|
| `packages/app: pnpm run typecheck` | **Pasa** |
| `packages/app: pnpm test` | **122 tests pasan / 8 archivos** |
| `packages/app: pnpm run build` | **Pasa** |
| `packages/core: npm test` | **101 tests pasan / 6 archivos** |
| `packages/core: npm run typecheck` | **Pasa** |

Los warnings restantes son únicamente avisos de Node sobre VM modules experimental y `punycode`; no hay fallos de tests, typecheck o build.

La API ahora expone `GET /api/trades/pending`, `POST /api/trades/prepare` y `POST /api/trades/submit`. El backend prepara transacciones sin recibir private keys; Phantom/MetaMask firman en el cliente y el hash enviado queda `pending`. El reconciler provider-neutral está cubierto por `tests/reconciler.test.ts`.

Limitación explícita: todavía no se habilita producción financiera. El reconciler ya consulta RPCs reales mediante `POST /api/admin/reconcile` protegido por `ADMIN_SECRET` y mueve operaciones a `confirmed`/`failed`; aún falta parsear fills y proyectar posiciones después del receipt para self-custody. El flujo mock sigue siendo el único que liquida automáticamente.

## 1.4 Verification performed

| Comando | Resultado |
|---|---|
| `packages/core: npm test` | **101 tests pasan** |
| `packages/core: npm run typecheck` | **Pasa** |
| `packages/app: pnpm test` | **No ejecutable en el checkout actual**: faltan binarios de `node_modules/vitest` |
| `packages/app: pnpm run typecheck` | **No ejecutable en el checkout actual**: faltan `node_modules/typescript/bin/tsc` |
| `packages/app: pnpm exec tsc --noEmit` | **Mismo bloqueo de dependencias locales** |
| Parse tests de frontend | Están definidos en `packages/app/tests/site-modules.test.ts`, pero no pudieron ejecutarse por el bloqueo de dependencias |

Esto significa que **no se debe afirmar que `packages/app` está verde**. Los tests existen y son amplios, pero su ejecución no fue verificable en este checkout.

---

# 2. WHAT WORKS

## 2.1 Backend/API con evidencia de implementación

### REAL o cercano a REAL

- Servidor HTTP nativo con rutas declarativas y aislamiento de errores por request.
- CORS y respuestas JSON uniformes básicas.
- Static serving con protección contra path traversal básica.
- SQLite WAL y auto-migraciones.
- API-key auth con hash SHA-256 almacenado, nunca la clave plaintext.
- Registro inicial protegido por `BOOTSTRAP_SECRET` después del primer usuario.
- Login EVM con recuperación de dirección mediante `ethers.verifyMessage`.
- Login Solana con verificación ed25519.
- Nonces de challenge single-use con TTL en memoria.
- Creación/importación de wallets EVM y Solana.
- Cifrado AES-256-GCM derivado con scrypt.
- Scanner de balances read-only con degradación por wallet.
- Providers de holders Blockscout y mock etiquetado.
- Providers de prediction markets públicos y cache de detalle.
- Rewards ledger con `UNIQUE(trade_id, reward_type, user_id)` e intención de idempotencia.
- SSE básico del feed con `id`, tipo de evento, payload y heartbeat.
- Tests de API que cubren auth, wallets, mock execution, launchpad, perfiles, feed, referrals, holders y login wallet.

### Parcial

- Live quotes mediante Jupiter y 0x: el código existe, pero el contrato de parámetros, los límites y la política de errores no son suficientemente estrictos.
- Live execution mediante Jupiter y 0x: existe la firma y el broadcast, pero el lifecycle on-chain no está completo.
- Period leaderboards: snapshots lazy en SQLite; no hay job/materialización robusta ni todas las métricas son consistentes.
- API profiles: validación básica de URLs y longitudes; no hay perfiles públicos por handle ni permisos de edición más allá del usuario autenticado.
- Rewards: ledger y cálculo existen; claim no mueve fondos reales.

## 2.2 Frontend con evidencia de implementación

- `app.html` tiene navegación desktop y bottom navigation mobile.
- Feed, Discover, Trade, Markets, Leaderboard, Rewards y Portfolio tienen módulos separados.
- `api.js` centraliza gran parte del cliente de `app.html`.
- Feed consume `/api/feed` y abre EventSource contra `/api/feed/stream`.
- Discover consume CoinGecko, DexScreener, RugCheck/GoPlus y launchpad.
- Portfolio consume `/api/portfolio`, `/api/trades`, `/api/wallets` y profile.
- Wallet login Phantom/MetaMask está implementado en el frontend.
- Launchpad UI permite crear, comprar y vender en la curva simulada.
- Prediction UI muestra mercados y permite iniciar una orden CLOB.
- Profile edit, social links y avatar URL están implementados.
- Design system oscuro y responsive con tokens CSS.
- Manifest PWA y configuración Capacitor están presentes.

## 2.3 Community Brain

`packages/core` es el área más madura según la verificación local:

- Brain/KB y respuestas acotadas a información disponible.
- Clustering y análisis de preguntas.
- XP, streaks, badges y quests.
- Raids con seguimiento etiquetado `SELF-REPORTED`.
- Market providers DexScreener, GeckoTerminal y Birdeye.
- Content Engine con propuestas, aprobación, scheduling y trail.
- Background cycles para analyzer, pulse, market y content.
- **101 tests pasan y typecheck pasa.**

Este producto no está conectado de forma estructural a la cuenta, identidad, posición o feed del trading app. Esa integración debe tratarse como un producto de plataforma, no como una suposición existente.

---

# 3. WHAT DOESN'T WORK / FALSE POSITIVES

## 3.1 Clasificación por feature

### Auth y acceso

| Feature | Estado | Evidencia / problema |
|---|---|---|
| API-key registration | **PARTIAL** | Funciona, pero IDs generados como `timestamp*1000 + random(0..999)` no son un ID durable ideal ni hay transacción/sequence explícita |
| API-key storage | **REAL con deuda** | Hash SHA-256, pero no hay expiración, scopes, revocación granular, rotation endpoint expuesto ni sesiones separadas |
| Beta access code | **MOCK / SECURITY DEBT** | Defaults hardcodeados (`ALPHA2027`, `TRENCHES`, etc.) si `ACCESS_CODES` no está configurado |
| Wallet login challenge | **PARTIAL** | Nonce single-use; challenge no vincula address, chain, origin ni sesión de intento |
| Google login | **PARTIAL** | Verifica token mediante `tokeninfo`; no hay rate limit, state propio ni política de privacidad/documentación de identidad |
| X login | **PARTIAL** | OAuth exchange existe; depende de env y callback; falta robustez anti-abuso y manejo de estado server-side |
| Auth gate frontend | **PARTIAL** | Access code desbloquea UI sin crear una identidad autenticada; la app puede mostrar superficies que luego fallan por 401 |

### Wallets y custody

| Feature | Estado | Evidencia / problema |
|---|---|---|
| Generate wallet | **REAL técnicamente** | EVM y Solana generan claves |
| Import wallet | **REAL técnicamente / P0** | Recibe private key por HTTP y la cifra; falta política de memoria, audit trail y warning operacional fuerte |
| AES-GCM encryption | **REAL / TECHNICAL DEBT** | Correcto como primitive; scrypt `N=16384` es configurable solo en código, sin KMS/envelope encryption |
| Export private key | **PARTIAL** | El método existe, pero no hay endpoint/UI equivalente claro en API actual para export seguro, y la arquitectura sigue siendo custodial |
| Wallet ownership | **PARTIAL** | Login firma un mensaje, pero no se enlaza automáticamente una wallet autenticada con wallet custodial ni se valida red en todos los caminos |
| Balance scanner | **PARTIAL** | Native + USDC; EVM no escanea tokens generales y `Number()` puede perder precisión |

### Trading

| Feature | Estado | Evidencia / problema |
|---|---|---|
| Quote Solana | **PARTIAL** | Jupiter fetch real; en modo live, `server.ts` captura el error y retorna `buildMockQuote`, lo cual es inaceptable para ejecución real |
| Quote EVM | **PARTIAL** | 0x v2; no todos los aggregators declarados están implementados de forma coherente |
| Quote bridge | **PARTIAL** | Li.Fi quote; no hay ejecución |
| Swap live Solana | **PARTIAL / P0** | Firma y `sendTransaction`; devuelve `confirmed` inmediatamente sin `confirmTransaction` ni verificación de balances |
| Swap live EVM | **PARTIAL / P0** | Envía tx y devuelve `confirmed` inmediatamente; approve y swap son dos operaciones con lifecycle incompleto |
| Failed tx | **PARTIAL** | Se registra como `failed` si la llamada lanza; no hay reconciler para una tx aceptada pero posteriormente fallida |
| Pending tx | **PLACEHOLDER** | El schema tiene `pending`, pero el flujo execute live registra confirmed directamente |
| Slippage | **PARTIAL** | Se pasa a providers, pero no hay política server-side de límites mínimos/máximos ni validación completa |
| Fees | **PARTIAL** | Se registra evento contable antes de confirmar ejecución y no necesariamente existe cobro on-chain de la fee |
| Balance sufficiency | **BROKEN / MISSING** | No se valida balance USDC/native antes de quote/submit; se depende del rechazo del router/RPC |
| Idempotent execution | **MISSING** | No hay idempotency key; reintentos pueden crear múltiples operaciones y múltiples fees |
| Limit orders | **PLACEHOLDER** | El tipo existe en tipos, pero no hay motor/order book/worker de limit orders |
| Perps/shorts/leverage | **MOCK UI / PLACEHOLDER** | UI expone Long/Short, leverage y TP/SL, pero el backend solo hace swaps spot USDC-native |
| Cross-chain trade | **PLACEHOLDER** | 501 explícito para bridge execution |

### Positions, PnL y portfolio

| Feature | Estado | Evidencia / problema |
|---|---|---|
| Position creation | **PARTIAL** | `applySwapToPosition` crea/actualiza posición open |
| Average entry | **PARTIAL** | Fórmula existe, pero trabaja con unidades que asumen una escala común; no hay decimals metadata por token |
| Partial close | **PARTIAL** | Reduce amount; no hay tests suficientes para múltiples ciclos, oversell, dust y tokens con decimals distintos |
| Realized PnL | **BROKEN / P0** | En `applySwapToPosition`, al cerrar se calcula contra `base.net_invested_usdc`, pero el trade row se guarda con `realized_pnl_usdc: null`; `getUserPnl` depende de trades y no de posiciones |
| Unrealized PnL | **PLACEHOLDER / CLIENT ONLY** | Se calcula en frontend con CoinGecko/DexFeed para una representación local; no es snapshot contable del backend |
| ROI | **MISSING** | Hay display de porcentajes en UI, pero no una métrica server-side durable basada en capital/time-weighted returns |
| Holdings | **PARTIAL / BROKEN edge cases** | `computePnlByToken` suma tokens por trades y usa `sell_amount`/`buy_amount` sin decimals ni distinción de chain en la key |
| Multi-chain holdings | **BROKEN design** | `pnlByToken` usa solo token como clave; el mismo address/símbolo en distintas chains puede colisionar |
| Portfolio cash balance | **MISSING** | No hay ledger de cash/deposits/withdrawals integrado al portfolio |
| History | **PARTIAL** | Historial de rows, no lifecycle completo ni reconciliación blockchain |

### Discovery y datos de mercado

| Feature | Estado | Evidencia / problema |
|---|---|---|
| CoinGecko prices | **REAL / PARTIAL** | API pública con cache; universo principal curado y limitado |
| DexScreener pairs | **REAL / PARTIAL** | Enrichment best-effort y cache localStorage; el cliente consulta directamente proveedores desde browser |
| Liquidity/txns/socials | **REAL cuando provider responde** | Si no hay pair muestra `—`, buena regla de honestidad |
| Security badges | **PARTIAL** | RugCheck/GoPlus públicos; no hay garantía de freshness ni un risk policy server-side |
| Elite Score | **PARTIAL** | Fórmula existe; faltan smart-money real y holder concentration para la mayoría |
| Smart Money Radar | **PLACEHOLDER** | El código indica explícitamente que se eliminó el radar falso; no existe indexación de wallets |
| Trending | **PARTIAL** | DexScreener boosts + volumen no equivalen a momentum orgánico ni a smart money |
| Token discovery universal | **PARTIAL** | Universal search prueba Solana/BSC y ticker; no resuelve de forma general nueve chains |
| Token metadata | **PARTIAL** | Launchpad/server metadata + mapas curados; no hay token registry/indexer general |

### Social trading

| Feature | Estado | Evidencia / problema |
|---|---|---|
| Feed events | **REAL / PARTIAL** | Se escriben swaps, tesis y closes |
| Public feed authorization | **SECURITY / PRODUCT DEBT** | `/api/feed` y `/api/feed/post` son públicos; `actorId = ctx.userId ?? 1` permite postear como usuario 1 sin autenticación |
| SSE | **PARTIAL** | Funciona como polling DB cada 3 s por conexión; no autentica, filtra followers ni escala multi-nodo |
| Follows | **PARTIAL** | DB methods existen; frontend guarda follows en localStorage y no llama API de follow/unfollow |
| Likes/reposts | **MOCK UI** | Frontend incrementa números en DOM; no persiste ni valida interacción |
| Theses | **PARTIAL** | Persisten como feed events; no hay entidad thesis completa ni outcome tracking |
| Profiles | **PARTIAL** | Perfil propio editable; no perfil público por handle con actividad completa |
| Leaderboard all-time | **PARTIAL** | Query sobre profiles; perfiles no se actualizan automáticamente desde trades |
| Leaderboard periods | **PARTIAL** | Snapshots lazy; no scheduler, no consistency guarantee y win-rate semantics divergentes |
| Copy settings | **REAL persistence / PLACEHOLDER execution** | Se guardan límites/chains; no se ejecuta ninguna copia |
| Copy trade | **PLACEHOLDER** | UI lo presenta como entry point y avisa que llegará próximamente |
| Notifications | **PLACEHOLDER** | No existe tabla `notifications`, endpoints ni delivery push en `packages/app` |
| Alerts | **PLACEHOLDER** | Discovery tiene señales/filters, pero no reglas persistidas ni alert delivery |
| Clans/community trading | **PLACEHOLDER en app** | Existe en benchmark/docs y en el bot, no en trading app |

### Launchpad y monetización

| Feature | Estado | Evidencia / problema |
|---|---|---|
| Create launch | **MOCK / PARTIAL** | Inserta fila SQLite y registra fee contable |
| Bonding curve buy/sell | **MOCK** | Matemática local; no transacción USDC real, no token contract real |
| Graduation | **PLACEHOLDER** | Solo cambia status y genera `graduated_<id>_<chain>`; no deploy/migration/LP lock |
| Launch fee | **ACCOUNTING ONLY** | Revenue event no prueba que el usuario haya pagado on-chain |
| Premium subscription | **ACCOUNTING ONLY** | Cambia tier y registra revenue; no hay payment authorization/expiry enforcement robusto |
| Rewards claim | **MOCK / INTERNAL LEDGER** | `claim_<user>_<timestamp>` no es tx hash; no transfiere USDC |
| Ad campaigns | **PARTIAL / ACCOUNTING** | Counters y revenue rows, sin serving system ni control de presupuesto atómico |

### Terminal legacy (`site/trading.html`)

Clasificación: **TECHNICAL DEBT crítico**.

- Mantiene API client, auth, chain map, chart, feed, portfolio, wallet y launchpad en un script inline independiente.
- `renderOrderBook()` muestra explícitamente que no hay CLOB real.
- `renderDepthChart()` dibuja una profundidad sintética.
- El chart usa series de CoinGecko con `open = high = low = close`; no son OHLC reales.
- `executeTrade()` maneja errores del backend y continúa con estado local optimista.
- `renderLaunches()` y portfolio usan un modelo diferente al de `app.html`.
- Hay inconsistencias de direcciones y unidades entre ambos frontends.

Debe congelarse, redirigirse o eliminarse antes de añadir nuevas features.

---

## 0.3 Solana/Jupiter receipt parser update

Implementado y verificado en esta iteración:

- `RpcReceiptProvider` consulta `getSignatureStatuses` para lifecycle y `getTransaction` con `encoding: "jsonParsed"` para datos contables.
- `parseSolanaJupiterFill` deriva el fill únicamente de los deltas agregados de balances SPL cuyo `owner` coincide con la wallet del intent.
- El `sellAmount` observado debe coincidir exactamente con el importe solicitado; el `buyAmount` se obtiene del delta post/pre real, nunca de la quote.
- Una transacción confirmada con receipt incompleto, mint inesperado, owner ausente, delta ambiguo o cantidades incompatibles permanece `confirmed` sin fill, posición, feed settled ni reward.
- Una transacción con `meta.err` permanece `failed` y no entra en accounting.
- Los swaps self-custody Solana no atribuyen el coste de red en lamports como fee de trading; el fill verificado usa `feeUsdc: "0"` porque la fee de plataforma no se cobra on-chain en este flujo.
- Se añadieron tests unitarios para delta SPL válido, owner/amount mismatch y receipt fallido.

Verificación ejecutada:

| Comando | Resultado |
|---|---|
| `packages/app: pnpm test` | **126 tests pasan / 8 archivos** |
| `packages/app: pnpm run typecheck` | **Pasa** |
| `packages/app: pnpm run build` | **Pendiente de repetir tras el último ajuste de tipos** |

Límites explícitos: el parser actual cubre únicamente swaps Solana/Jupiter con balances SPL verificables. No liquida todavía SOL nativo, EVM, bridges, rutas con datos de balance incompletos ni una fee de plataforma on-chain; esos casos requieren adapters específicos y quedan sin settlement automático.


- Executors que reportan `submitted`/`pending` tras broadcast; ya no afirman `confirmed` por la mera aceptación del RPC.
- Validación de que los swaps contienen una pata USDC antes de cobrar/ejecutar.
- Reglas de posición que rechazan oversell, cantidades no enteras y ventas sin posición abierta.
- Average-cost con cost basis restante y realized PnL acumulado para partial close/reopen.
- El trade compatible se marca `confirmed` y recibe el realized PnL de la posición al settlement mock.
- Tests de lifecycle/idempotency y nuevas pruebas de feed no autenticado.

La verificación del checkout ya está completada tras reinstalar dependencias con `pnpm install --frozen-lockfile --force`.

# 4. ARCHITECTURE REVIEW

## 4.1 Fortalezas

- El dominio está relativamente bien separado en módulos de wallets, trading, positions, history, rewards, launchpad y market providers.
- Interfaces provider-based para holders, AI y market data facilitan sustitución.
- SQLite WAL es razonable para prototipo/single-node.
- Hay preocupación explícita por honestidad de datos, etiquetado de mock y ausencia de métricas inventadas.
- Las APIs tienen test harness con servidor efímero y DB temporal.
- El frontend principal evita depender de un framework pesado y carga módulos independientes.
- `packages/core` demuestra una base de testing útil.

## 4.2 Problemas de diseño

### A. Boundary demasiado grande en `server.ts`

`packages/app/src/api/server.ts` mezcla:

- HTTP parsing y static serving.
- Auth y provider login.
- Validación de inputs.
- Orquestación de quotes.
- Firma y broadcast.
- Revenue.
- Rewards.
- Position aggregation.
- Feed writes.
- Profile, referrals y subscription.

Esto hace que sea difícil aplicar transacciones, idempotencia, permisos y pruebas aisladas. Recomendación: separar en `routes`, `application services`, `repositories`, `execution adapters`, `accounting` y `event publishing`.

### B. No existe un ledger canónico

`trades`, `positions`, `revenue_events` y `rewards_ledger` guardan aspectos contables distintos sin una secuencia/event model común. Para una app de trading, el estado derivado debe reconstruirse a partir de fills/ledger inmutables, no de una combinación de filas mutables y cálculos frontend.

### C. El modelo de cantidades no es seguro

El sistema usa strings de enteros, lo cual es correcto como intención, pero:

- No se guarda decimals/symbol/name como metadata canónica por fill.
- Hay conversiones a `Number()` en balances y UI.
- `pnlByToken` no incluye chain en la clave.
- BSC, Robinhood y Arc usan decimals/stablecoins especiales.
- El precio `avg_entry_usdc` no está claramente normalizado para tokens con decimals distintos.

### D. Read-after-write y concurrencia

La curva de launchpad hace read → calcula → varios writes sin una transacción SQLite. Dos compras concurrentes pueden calcular sobre el mismo estado. Lo mismo aplica a buyers_count, raised y graduation.

La agregación de posiciones también necesita una transacción que englobe:

1. inserción de fill/trade;
2. actualización de posición;
3. creación de feed event;
4. reward accrual.

### E. Realtime no escala todavía

SSE consulta SQLite cada 3 s por conexión. No hay broker, fan-out, backpressure, límites de conexiones, cleanup de errores detallado ni replay durable. Para single-node beta puede servir; para múltiples instancias se necesita outbox + Redis/NATS o un servicio equivalente.

### F. Dos frontends compiten

`app.html` es la dirección moderna; `trading.html` es una implementación separada. Mantener ambos permite que un bug sea corregido en uno y permanezca en el otro. Debe haber un único contrato de frontend y una única superficie de trading.

### G. Datos públicos consultados desde el browser

CoinGecko, DexScreener, RugCheck y GoPlus se consultan directamente desde cliente. Esto expone rate limits por usuario, complica caching global, hace variables los resultados y puede romper CORS/privacidad. El backend debería normalizar datos de mercado con cache server-side.

## 4.3 Recomendación de arquitectura objetivo

```text
[Web/PWA]
   │ HTTPS, versioned API, SSE
   ▼
[API edge / auth / rate limit]
   │
   ├── Identity + account service
   ├── Wallet/custody service (prefer external signer or self-custody)
   ├── Quote service ── provider adapters
   ├── Execution service ── chain adapters
   ├── Transaction reconciler / workers
   ├── Accounting service ── immutable fills + ledger
   ├── Portfolio projection service
   ├── Discovery/indexing service
   ├── Social/feed/notification service
   └── Admin/risk service
          │
          ├── PostgreSQL (source of truth)
          ├── Redis (cache, rate limits, pub/sub)
          ├── Durable queue/outbox
          └── Object storage (avatars/share cards)
```

**REBUILD recomendado:** no hace falta reescribir todo el producto, pero sí reconstruir el núcleo de ejecución + accounting antes de añadir copy trading, perps o launchpad on-chain.

---

# 5. SECURITY REVIEW

## 5.1 P0 findings

### P0-S1 — Live quote fallback to mock

En `POST /api/trades/quote`, cuando `APP_MODE` no es `mock` y el provider real falla, el servidor retorna `buildMockQuote`. Aunque la respuesta incluye `mode`/comentarios de honestidad, un consumidor que ejecute después puede tratar esa quote como operable.

**Riesgo:** ejecución a precio ficticio, pérdida de fondos y confusión crítica.  
**Acción:** en live devolver error 502/503; solo permitir fallback mock cuando el request declare explícitamente `simulation=true` y el servidor esté en modo sandbox.

### P0-S2 — Transaction accepted != confirmed

Los executors devuelven `status: "confirmed"` después de `sendTransaction`/`sendTransaction` EVM. Esto no prueba inclusión, éxito del contrato, finality ni ausencia de revert.

**Riesgo:** trades, posiciones, rewards y feed pueden registrar una operación que falló on-chain.  
**Acción:** lifecycle durable, receipt polling, confirmations por chain, reconciler y reorg handling.

### P0-S3 — Custodial private keys

Las claves privadas se reciben/desencriptan en el proceso API y se usan para firmar. AES-GCM protege storage, pero no resuelve compromiso del host, logs, dumps, heap inspection o abuso interno.

**Riesgo:** compromiso total de fondos.  
**Acción mínima:** external signer/KMS/HSM o modelo self-custody; si se mantiene custody beta, aislamiento del signer, no almacenar claves en memoria más tiempo del necesario, red separada, rotation, audit logs, spending limits y kill switch.

### P0-S4 — Public feed post impersonation

`POST /api/feed/post` está registrado como `publicRoute`; si no hay user, usa `ctx.userId ?? 1`. Esto permite crear posts/theses como actor 1 y contaminar la reputación/feed.

**Acción:** hacer la ruta autenticada, eliminar fallback a actor 1, verificar ownership de `launchId`, añadir rate limit y audit trail.

### P0-S5 — No idempotency en ejecución

El usuario puede repetir el request después de timeout o pérdida de conexión. No existe `Idempotency-Key` ni constraint de operación única.

**Acción:** requerir key en execute, persistir intent con hash de request, devolver mismo resultado, y separar intent/fill/settlement.

## 5.2 P1 findings

- CORS `*` en API financiera y SSE.
- Authorization solo por API key global; no scopes, expiración, device/session model ni key rotation endpoint.
- Challenge wallet no está ligado a una origin o address esperada; conviene SIWE-like typed message con domain, URI, chain, address, nonce y expiration.
- `BOOTSTRAP_SECRET` y `ADMIN_SECRET` son secretos compartidos, sin rotación ni audit de admin actions.
- API carece de rate limiting por IP/user/route.
- No hay CSRF/origin policy para mutaciones cuando se use cookie/sesión futura.
- Error responses pueden incluir mensajes de provider/RPC más detallados de lo deseado.
- `site/index.html` usa access codes por defecto hardcodeados si no hay configuración.
- `site/app.html` y `site/trading.html` guardan API keys en `localStorage`, expuestas a cualquier XSS futuro.
- URLs de imagen/socials se insertan en HTML; hay escaping en varios puntos, pero la política debería centralizarse y no confiar en interpolación inline handlers.
- No hay CSP, HSTS, security headers, frame-ancestors, referrer policy ni SRI para scripts CDN.
- Frontend carga `lightweight-charts` desde `unpkg.com` sin SRI.
- Admin rewards routes requieren `x-admin-secret`, pero no hay autorización por rol de usuario ni logging de cambios.
- Import wallet recibe claves privadas vía JSON request body; no hay límites específicos ni redacción de logs garantizada a nivel middleware.
- Prediction CLOB credentials se cachean en memoria por address; se requiere revisar persistencia, lifecycle y el contrato exacto de headers/protocolo.

## 5.3 Required security gates

No activar producción financiera hasta cumplir:

- Threat model documentado.
- Security tests de auth, ownership, replay, rate limit, injection y idempotencia.
- External review del signer/custody.
- Transaction state machine probada.
- No mock fallback en live.
- CORS/origin/CSP definidos.
- Secret management externo y rotation.
- Audit log inmutable para acciones sensibles.

---

# 6. BENCHMARK GAP ANALYSIS

El benchmark documentado es `fomo.family`. La comparación es funcional/arquitectónica, no una instrucción de copiar producto, código o assets.

| Área | Nuestro estado | Benchmark observado | Gap | Cómo superarlo sin copiar |
|---|---|---|---|---|
| Onboarding | Access code + API key/wallet login | Email/Apple + embedded wallet y onboarding rápido | Alto | Onboarding progresivo: wallet self-custody primero, custody opcional, risk disclosure y seed/export claro |
| Wallets | Custodial encrypted keys + Phantom/MetaMask | Embedded wallet con key sharding/TEE | Alto | Preferir self-custody; si custody, signer aislado y límites por cuenta |
| Trading | Spot swaps Jupiter/0x parcial | Backend-orchestrated swaps, gasless UX, multi-chain | Medio/alto | Intent-based execution, simulación previa, receipt tracking y transparencia de route/fees |
| Token discovery | Universo curado + DexScreener/CoinGecko | Feed de tokens, trending, verified, most-held | Medio | Indexación propia, score explicable, señales on-chain + comunidad Telegram |
| Charts | CoinGecko price series; OHLC artificial en un camino | TradingView datafeed y charting profesional | Alto | OHLCV real por provider server-side, lightweight-charts y overlays de fills/theses |
| Terminal | Dos terminales divergentes; order book no real | Token page + trade panel integrado | Alto | Un único terminal, quote freshness, slippage simulation, fills y lifecycle visible |
| Portfolio | Holdings/trades/positions parcial | Balances, positions, PnL, history | Alto | Ledger canónico, decimals por asset, valuation timestamped y realized/unrealized consistente |
| PnL | Fórmula de posición aislada; trades no guardan realized | Performance/portfolio charts y positions | Crítico | FIFO/average-cost definido, fills inmutables, reconciliación on-chain y tests invariantes |
| Social feed | Feed events + SSE básico | Swaps/positions/thesis/followers | Medio/alto | Feed con entidades públicas, privacy controls, actor profiles, filters persistidos y moderation |
| Copy trading | Solo settings | Social copy loop y follow | Alto | Solo tras ledger sólido; consent, limits, kill switch, slippage guard y per-trader risk profile |
| Leaderboards | All + lazy periods | 24h/7D/30D/all | Medio | Snapshots/returns correctos, risk-adjusted ranking, verified vs self-reported labels |
| Alerts | No notification domain en app | Price/friends/trending/top traders/push | Alto | Rules engine + notification preferences + SSE/push/Telegram channel |
| Notifications | Placeholder | Push preferences y activity alerts | Alto | In-app inbox, delivery status, dedupe y user-configurable thresholds |
| Multichain | 9 configs declaradas; operación desigual | Solana/Base/BNB/Monad y más | Alto | Capability matrix real por chain; no listar una chain como live hasta E2E validado |
| Mobile | Responsive/PWA/Capacitor config | Mobile-first app con bottom nav | Medio | QA real iOS/Android, deep links, wallet adapters y offline-safe states |
| Community | Brain/raids en producto separado | Clans/community | Diferenciador | Integrar Telegram Brain con feed de señales verificadas y contexto comunitario |
| Analytics | Elite Score y stats básicas | Portfolio/trader analytics | Medio/alto | cohortes, drawdown, volatility, exposure, attribution y explainability |
| UX | Dark premium, data-dense; alerts/optimistic states inconsistentes | Jerarquía oscura, skeletons, filters persistidos | Medio | Unificar design system y errores; cada dato con freshness/source/label |
| Performance | Browser calls, polling DB por SSE, SQLite | CDN + API + polling optimizado | Alto | API aggregation, cache server-side, outbox/realtime broker, pagination/cursors |
| Security | Básica, varios P0/P1 | Custody and auth mature by inference | Crítico | Security-first architecture, signer isolation, origin controls y auditability |
| Differentiator | Telegram Brain, raids, honest labels, self-host, launchpad vision | No ofrece esa combinación | Oportunidad | Community intelligence + verified on-chain reputation + explainable discovery |

---

# 7. PRODUCT VISION RECOMMENDED

TRENCHES debería ser una **red social de inteligencia y ejecución de mercados**, no simplemente otro swap frontend.

## 7.1 Product pillars

1. **Verified execution**: cada trade tiene quote, intent, transaction, receipt y settlement visibles.
2. **Explainable discovery**: cada score indica qué datos lo producen, su timestamp y qué está desconocido.
3. **Reputation based on fills**: el PnL solo cuenta fills settled; tesis y self-reported content están separados y etiquetados.
4. **Community intelligence**: Telegram Brain, raids, quests y social signals agregan contexto que un terminal puro no tiene.
5. **Unified portfolio**: chains diferentes, una vista; internamente cada asset conserva chain, decimals, source y valuation timestamp.
6. **Safety as product**: slippage, liquidity, honeypot/tax, holder concentration, approvals, spending limits y simulation antes de firmar.
7. **Self-custody first**: no construir crecimiento sobre custody opaca. Custody solo como opción explícita y limitada.

## 7.2 Differentiators

- Señales combinadas de mercado + conversación real de comunidades, sin afirmar causalidad no demostrada.
- Reputación con prueba de fills settlement, no screenshots.
- Modo self-host/privacy para comunidades y operadores.
- Feed de oportunidades con explicación del score y etiqueta de freshness.
- Integración nativa con Telegram Brain, raids y quests.
- PnL share cards verificables que distinguen `ON-CHAIN SETTLED`, `SELF-REPORTED` y `SIMULATED`.
- Capability matrix multichain honesta: una chain no se marca live solo por tener RPC configurado.

---

# 8. NEW ROADMAP

## Orden de fases

```text
P0 Security & contracts
        ↓
P1 Accounting + transaction lifecycle
        ↓
P2 Single-chain production trading
        ↓
P3 Portfolio / PnL / history projections
        ↓
P4 Discovery + market data service
        ↓
P5 Social graph + feed + notifications
        ↓
P6 Multichain expansion
        ↓
P7 Copy trading / advanced products
        ↓
P8 Community convergence + mobile production
```

No se recomienda implementar copy trading, perps, rewards on-chain o launchpad on-chain antes de completar P0–P3.

---

## PHASE P0 — Security, contracts and freeze of false positives

### P0-01 — Freeze live trading until lifecycle is safe

- **Descripción:** Desactivar live execution por defecto y bloquear fallback mock en `APP_MODE=live`.
- **Estado actual:** `PARTIAL / BLOCKER`; live está configurado en `fly.toml` y quote puede caer a mock.
- **Prioridad:** P0
- **Dependencias:** Ninguna
- **Archivos/servicios afectados:** `packages/app/src/api/server.ts`, `trading/engine.ts`, `api/executors.ts`, `fly.toml`, `site/app.html`, `site/trading.html`
- **Implementación esperada:** Política explícita `production|sandbox|mock`; live provider failure devuelve 503; UI bloquea ejecución si quote no es live/fresh.
- **Acceptance Criteria:** Ningún response live contiene `aggregator=mock`; ningún trade live se ejecuta con quote fallback; smoke test cubre provider failure.
- **Tests necesarios:** quote provider timeout; live execution with mock quote; UI mode mismatch.
- **Definition of Done:** deploy de staging con live disabled y evidencia de rechazo correcto.

### P0-02 — Secure feed and mutation authorization

- **Descripción:** Eliminar rutas públicas de mutación y actor fallback.
- **Estado actual:** `BROKEN / SECURITY`; `/api/feed/post` usa actor 1 si no hay auth.
- **Prioridad:** P0
- **Dependencias:** P0-01
- **Archivos/servicios afectados:** `server.ts`, `router.ts`, `site/js/feed.js`, tests API
- **Implementación esperada:** Auth obligatoria, ownership de launch/profile, límites de longitud/frecuencia, scopes.
- **Acceptance Criteria:** request sin Bearer recibe 401; actor siempre coincide con token; launch de otro usuario no se puede usar para falsificar tesis.
- **Tests necesarios:** unauthorized post, actor spoofing, cross-user launch, rate limit.
- **Definition of Done:** no quedan `ctx.userId ?? 1` en mutaciones.

### P0-03 — Idempotency and request validation

- **Descripción:** Añadir idempotency key, schemas y límites numéricos para quotes/execute/wallets.
- **Estado actual:** `MISSING`; validación manual incompleta.
- **Prioridad:** P0
- **Dependencias:** P0-01
- **Archivos/servicios afectados:** `router.ts`, `server.ts`, DB schema, frontend API client
- **Implementación esperada:** `Idempotency-Key` obligatorio en execute/claim/order; hash de payload; decimal integer validation; slippage bounds; chain/token validation.
- **Acceptance Criteria:** reintentos devuelven mismo resultado; payload mutado con misma key se rechaza; cantidades inválidas nunca llegan al provider.
- **Tests necesarios:** duplicate request, concurrent duplicate request, malformed bigint, overflow, slippage limits.
- **Definition of Done:** pruebas concurrentes pasan en SQLite y API documenta contrato.

### P0-04 — Security headers and origin policy

- **Descripción:** Cerrar CORS wildcard y añadir headers web.
- **Estado actual:** `TECHNICAL DEBT / P1 security`, CORS `*`, sin CSP/HSTS visible.
- **Prioridad:** P0
- **Dependencias:** P0-02
- **Archivos/servicios afectados:** `server.ts`, static serving, hosting config, `site/*.html`
- **Implementación esperada:** allowlist de origins, CSP compatible, HSTS en proxy, frame-ancestors none, Referrer-Policy, nosniff.
- **Acceptance Criteria:** origin no permitido no puede mutar/leer API; scripts CDN están allowlisted o self-hosted con integrity.
- **Tests necesarios:** CORS preflight, origin matrix, CSP smoke.
- **Definition of Done:** security header scan de staging sin hallazgos críticos.

### P0-05 — Custody/signing threat model

- **Descripción:** Decidir self-custody-first vs custody aislada antes de seguir con fondos reales.
- **Estado actual:** `P0 SECURITY BLOCKER`; private keys decrypted inside API.
- **Prioridad:** P0
- **Dependencias:** P0-01
- **Archivos/servicios afectados:** `wallets/crypto.ts`, `wallets/manager.ts`, `api/executors.ts`, deployment
- **Implementación esperada:** ADR con amenaza, trust boundaries, signer service/KMS o decisión explícita de no custody en producción.
- **Acceptance Criteria:** no hay private key en logs; límites por cuenta; kill switch; audit events; proceso signer aislado o custody deshabilitada.
- **Tests necesarios:** memory/log redaction, wrong password, signer authorization, spend limits.
- **Definition of Done:** revisión manual de seguridad aprobada antes de producción.

---

## PHASE P1 — Canonical trading accounting and transaction lifecycle

### P1-01 — Immutable execution intents and fills

- **Descripción:** Crear modelo canónico `trade_intents`, `transactions` y `fills`.
- **Estado actual:** `PARTIAL`; `trades` mezcla intent, execution y outcome.
- **Prioridad:** P0
- **Dependencias:** P0-03, P0-05
- **Archivos/servicios afectados:** `app-db.ts`, `history.ts`, `server.ts`, executor adapters
- **Implementación esperada:** status state machine y IDs externos; un fill settled es la entrada de accounting.
- **Acceptance Criteria:** cada ejecución tiene idempotency key, provider quote id, tx hash, submittedAt, confirmedAt, failure reason y final status.
- **Tests necesarios:** pending, confirmed, reverted, timeout, reorg, duplicate callback.
- **Definition of Done:** una operación se puede reconstruir solo desde DB + receipt.

### P1-02 — Receipt confirmation and reconciler worker

- **Descripción:** Esperar receipts y reconciliar operaciones aceptadas por RPC.
- **Estado actual:** `BROKEN`; broadcast se marca confirmed inmediatamente.
- **Prioridad:** P0
- **Dependencias:** P1-01
- **Archivos/servicios afectados:** `api/executors.ts`, new worker/reconciler, chain adapters
- **Implementación esperada:** confirmations por chain, retry/backoff, receipt parsing, failed/reverted/reorg states.
- **Acceptance Criteria:** tx RPC accepted pero reverted nunca aparece como settled; pending permanece visible; worker recupera tras restart.
- **Tests necesarios:** mocked RPC receipts, timeout, revert, duplicate reconciliation.
- **Definition of Done:** staging test con transaction lifecycle completo.

### P1-03 — Rebuild position engine around settled fills

- **Descripción:** Posiciones y realized PnL derivan únicamente de fills settled.
- **Estado actual:** `PARTIAL/BROKEN`; position result no se escribe en trade row.
- **Prioridad:** P0
- **Dependencias:** P1-01
- **Archivos/servicios afectados:** `positions.ts`, `app-db.ts`, `server.ts`, `history.ts`
- **Implementación esperada:** definir average-cost o FIFO; soportar partial closes, reopen cycles, fees, dust y oversell.
- **Acceptance Criteria:** buy/buy/sell partial/sell close produce expected remaining, average entry, realized PnL y fees.
- **Tests necesarios:** todos los casos de trading indicados por el prompt, múltiples decimals y chains.
- **Definition of Done:** invariants de posición pasan: no negative balance, close at zero, realized PnL equals proceeds-cost-fees.

### P1-04 — Canonical asset identity and amount math

- **Descripción:** Asset key debe ser `{chain, address}` con decimals/symbol metadata.
- **Estado actual:** `BROKEN design`; token-only keys y conversiones Number.
- **Prioridad:** P0
- **Dependencias:** P1-03
- **Archivos/servicios afectados:** DB, `chains/config.ts`, portfolio, frontend TokenMeta
- **Implementación esperada:** integer math end-to-end; decimal formatting solo en presentation; asset registry.
- **Acceptance Criteria:** mismo address en dos chains no colisiona; BSC/Arc/Robinhood stablecoin decimals correctos.
- **Tests necesarios:** precision, large values, zero/dust, cross-chain same address.
- **Definition of Done:** no hay `Number()` para cantidades contables en backend.

---

## PHASE P2 — One-chain production trading

### P2-01 — Declare capability matrix

- **Descripción:** Separar `configured`, `read_only`, `quotes`, `sandbox`, `live_execution` por chain.
- **Estado actual:** 9 chains aparecen configuradas como si fueran equivalentes.
- **Prioridad:** P0
- **Dependencias:** P1-02
- **Archivos/servicios afectados:** `chains/config.ts`, `/api/chains`, UI
- **Implementación esperada:** capabilities verificadas por chain y provider.
- **Acceptance Criteria:** UI nunca muestra live si no existe E2E validation; Solana y una EVM soportada son las primeras live.
- **Tests necesarios:** capability serialization and UI gating.
- **Definition of Done:** runbook de validación por chain.

### P2-02 — Production-ready Solana spot swap

- **Descripción:** Completar quote freshness, simulation, signing, broadcast, confirm y portfolio settlement.
- **Estado actual:** `PARTIAL`.
- **Prioridad:** P0
- **Dependencias:** P1-01, P1-02, P1-03
- **Archivos/servicios afectados:** Jupiter adapter, Solana executor, transaction worker, Trade UI
- **Implementación esperada:** one canonical buy/sell flow; no optimistic positions.
- **Acceptance Criteria:** buy, sell, partial sell, insufficient balance, slippage exceeded, pending, confirmed y failed funcionan con wallet de staging.
- **Tests necesarios:** mocked integration + testnet/manual staging checklist.
- **Definition of Done:** runbook reproducible y receipts almacenados.

### P2-03 — Production-ready Base or Ethereum EVM swap

- **Descripción:** Implementar un único EVM con approval/Permit2 y receipt lifecycle.
- **Estado actual:** `PARTIAL`.
- **Prioridad:** P0
- **Dependencias:** P2-02
- **Archivos/servicios afectados:** 0x adapter, EVM executor, chain config
- **Implementación esperada:** address normalization, allowance policy, gas/nonce handling, replacement tx.
- **Acceptance Criteria:** buy/sell live staging con reverted/approval failure covered.
- **Tests necesarios:** allowance, native token, ERC20, wrong chain, nonce conflict.
- **Definition of Done:** una EVM declarada `live` con evidencia.

### P2-04 — Remove/freeze legacy terminal

- **Descripción:** Redirigir `trading.html` a `app.html` o mantenerlo como demo estático sin mutaciones.
- **Estado actual:** `TECHNICAL DEBT CRÍTICO`.
- **Prioridad:** P0
- **Dependencias:** P2-02
- **Archivos/servicios afectados:** `site/trading.html`, deployment/static routes
- **Implementación esperada:** una única terminal y un único API client.
- **Acceptance Criteria:** no existe camino optimista que invente positions; no hay chart/depth falsos presentados como live.
- **Tests necesarios:** route redirect, frontend module parse, smoke navigation.
- **Definition of Done:** usuarios no pueden operar desde dos implementaciones distintas.

---

## PHASE P3 — Portfolio, PnL and history

### P3-01 — Portfolio projection service

- **Descripción:** Proyectar holdings, open positions, cash, exposure y valuations desde ledger settled.
- **Estado actual:** `PARTIAL`.
- **Prioridad:** P0
- **Dependencias:** P1-03, P1-04
- **Archivos/servicios afectados:** new portfolio service, `app-db.ts`, `/api/portfolio`, `portfolio.js`
- **Implementación esperada:** chain-aware assets, price source/freshness, realized/unrealized separation.
- **Acceptance Criteria:** multiple assets/chains, deposits/withdrawals, price changes y unavailable prices se representan correctamente.
- **Tests necesarios:** portfolio matrix del prompt.
- **Definition of Done:** snapshot reproducible y timestamps/source visible en UI.

### P3-02 — Performance metrics

- **Descripción:** Añadir ROI, drawdown, exposure, win rate por closed positions, volume y fees.
- **Estado actual:** `MISSING/PARTIAL`.
- **Prioridad:** P1
- **Dependencias:** P3-01
- **Archivos/servicios afectados:** history, portfolio, leaderboard
- **Implementación esperada:** definiciones documentadas y métricas server-side.
- **Acceptance Criteria:** mismo resultado para API y UI; open positions no cuentan como realized wins.
- **Tests necesarios:** zero trades, open-only, loss-only, mixed chains.
- **Definition of Done:** metric glossary in docs.

### P3-03 — Public verified profiles and share cards

- **Descripción:** Perfil público por handle con fills, positions settled, thesis y labels de verificación.
- **Estado actual:** `PARTIAL`; share cards existen como canvas client-side.
- **Prioridad:** P1
- **Dependencias:** P3-01
- **Archivos/servicios afectados:** profiles API, feed, `portfolio.js`, `tokens.js`
- **Implementación esperada:** public profile route, privacy controls, generated cards from server data.
- **Acceptance Criteria:** card no puede mostrar `VERIFIED ON-CHAIN` para datos mock/self-reported.
- **Tests necesarios:** labels, privacy, profile ownership, card snapshot.
- **Definition of Done:** share card evidence points to settled trade/position.

---

## PHASE P4 — Discovery and market data platform

### P4-01 — Server-side market data aggregation

- **Descripción:** Mover CoinGecko/DexScreener/security providers detrás de un service con cache, source, timestamp y retry policy.
- **Estado actual:** `PARTIAL`; browser calls direct.
- **Prioridad:** P1
- **Dependencias:** P2-02, P3-01
- **Archivos/servicios afectados:** new market service, `dexfeed.js`, `discover.js`, API
- **Implementación esperada:** normalized token/pair schema y per-provider health.
- **Acceptance Criteria:** UI no depende de 15 requests secuenciales por browser; stale data se etiqueta.
- **Tests necesarios:** provider failure, cache expiry, source mismatch, rate limit.
- **Definition of Done:** dashboard de provider health y cache hit rate.

### P4-02 — Real OHLCV and chart data

- **Descripción:** Sustituir series close-only/synthetic por OHLCV real.
- **Estado actual:** `PARTIAL / MOCK in fallback`.
- **Prioridad:** P1
- **Dependencias:** P4-01
- **Archivos/servicios afectados:** market service, `trading.js`, chart adapter
- **Implementación esperada:** timeframe/asset source contract, no synthetic fallback in live terminal.
- **Acceptance Criteria:** missing OHLCV muestra empty/unavailable, nunca velas fabricadas.
- **Tests necesarios:** malformed candles, gaps, timestamps, no-data state.
- **Definition of Done:** chart displays source and last update.

### P4-03 — Discovery score and risk explainability

- **Descripción:** Score con dimensions present/unknown, security source, liquidity age y data freshness.
- **Estado actual:** `PARTIAL`.
- **Prioridad:** P1
- **Dependencias:** P4-01
- **Archivos/servicios afectados:** `intelligence.js`, discovery API/UI
- **Implementación esperada:** smart-money permanece unknown hasta existir indexer real.
- **Acceptance Criteria:** score no rellena unknown con apariencia de medición; explanation visible.
- **Tests necesarios:** missing fields, risk levels, stale values.
- **Definition of Done:** product copy matches actual data provenance.

### P4-04 — Wallet activity indexer

- **Descripción:** Indexar wallets opt-in/known, swaps, holdings, profitability y clusters con privacidad/legal controls.
- **Estado actual:** `PLACEHOLDER`.
- **Prioridad:** P1
- **Dependencias:** P1-01, P3-01, P4-01
- **Archivos/servicios afectados:** new indexer/worker/schema/discovery
- **Implementación esperada:** no inferir “smart money” de DexScreener boosts.
- **Acceptance Criteria:** wallet signal tiene source, block range, freshness y confidence.
- **Tests necesarios:** dedupe, reorg, out-of-order, PnL attribution.
- **Definition of Done:** pilot with a bounded wallet set and documented privacy model.

---

## PHASE P5 — Social graph, feed and notifications

### P5-01 — Persisted follow graph and authorization

- **Descripción:** Conectar follow/unfollow frontend con API autenticada.
- **Estado actual:** `PARTIAL`; localStorage-only UI.
- **Prioridad:** P1
- **Dependencias:** P0-02, P3-03
- **Archivos/servicios afectados:** API routes, DB, `social.js`, `feed.js`
- **Implementación esperada:** follow graph server-side, privacy and block/mute primitives.
- **Acceptance Criteria:** follow visible en cualquier device; no se puede seguir self; counts transactionally correct.
- **Tests necesarios:** cross-user, duplicate, unfollow, blocked user.
- **Definition of Done:** feed following filter uses server graph.

### P5-02 — Feed entity model and moderation

- **Descripción:** Separar thesis/post/swap/position events y añadir moderation/status.
- **Estado actual:** `PARTIAL`; JSON payload genérico.
- **Prioridad:** P1
- **Dependencias:** P3-03, P5-01
- **Archivos/servicios afectados:** feed schema/service/UI
- **Implementación esperada:** cursor pagination, actor profile join, event versioning, report/hide.
- **Acceptance Criteria:** duplicate/out-of-order events no duplican UI; deleted/hidden content respeta policy.
- **Tests necesarios:** SSE reconnect, duplicate events, ordering, moderation.
- **Definition of Done:** feed contract versionado.

### P5-03 — Notifications and alerts engine

- **Descripción:** Añadir price/follow/trader/activity/trending alerts con preferences y dedupe.
- **Estado actual:** `PLACEHOLDER`.
- **Prioridad:** P1
- **Dependencias:** P5-01, P5-02, P4-01
- **Archivos/servicios afectados:** DB, worker, SSE, frontend, optional Telegram bridge
- **Implementación esperada:** notification table, delivery state, cooldown, user controls.
- **Acceptance Criteria:** disconnect/reconnect no pierde durable notifications ni duplica entrega.
- **Tests necesarios:** reconnect, duplicate, cooldown, unsubscribe, provider failure.
- **Definition of Done:** in-app inbox operativo y push/Telegram separado como adapter.

### P5-04 — Realtime fan-out

- **Descripción:** Cambiar SSE DB polling por outbox + pub/sub cuando haya más de una instancia.
- **Estado actual:** `PARTIAL` single-node.
- **Prioridad:** P1
- **Dependencias:** P5-02
- **Archivos/servicios afectados:** SSE, DB outbox, Redis/pubsub, deployment
- **Implementación esperada:** sequence IDs, heartbeat, backpressure, replay from cursor.
- **Acceptance Criteria:** reconnect resumes from cursor; no event loss/duplication under test.
- **Definition of Done:** load test con target de conexiones acordado.

---

## PHASE P6 — Multichain expansion

### P6-01 — Solana + one EVM capability certification

- **Descripción:** Certificar solo dos chains antes de abrir más.
- **Estado actual:** `PARTIAL`.
- **Prioridad:** P1
- **Dependencias:** P2-02, P2-03
- **Archivos/servicios afectados:** chain adapters, runbooks, UI
- **Implementación esperada:** test matrix para quote, gas, token decimals, receipt, balances, explorer.
- **Acceptance Criteria:** 20+ E2E scenarios per chain pass in staging.
- **Tests necesarios:** wallet, quote, execute, receipt, failed/pending/reorg.
- **Definition of Done:** chain status changes from configured to live with evidence.

### P6-02 — Add Base, Arbitrum, Polygon, BSC

- **Descripción:** Expandir una por una usando adapters/capabilities.
- **Estado actual:** configs exist, operation unverified.
- **Prioridad:** P1
- **Dependencias:** P6-01
- **Archivos/servicios afectados:** `chains/config.ts`, adapters, indexer, UI
- **Implementación esperada:** no shared assumptions about USDC decimals/native gas.
- **Acceptance Criteria:** each chain has its own certification record.
- **Tests necesarios:** decimals, native sentinel, approvals, RPC fallback.
- **Definition of Done:** public capability matrix updated.

### P6-03 — Robinhood/Monad/Arc evaluation

- **Descripción:** Evaluar network maturity, provider support, testnet/mainnet and liquidity before enabling.
- **Estado actual:** `CONFIGURED / UNVERIFIED`; Monad/Arc configs indicate testnet in comments/URLs.
- **Prioridad:** P2 until certified
- **Dependencias:** P6-02
- **Archivos/servicios afectados:** chain config, product copy, providers
- **Implementación esperada:** labels `testnet`, `read-only`, `experimental` where appropriate.
- **Acceptance Criteria:** no claim of live trading without provider/liquidity/receipt certification.
- **Tests necesarios:** health/capability tests and manual smoke.
- **Definition of Done:** go/no-go decision per chain documented.

---

## PHASE P7 — Advanced trading and monetization

### P7-01 — Copy trading with hard risk controls

- **Descripción:** Implementar execution worker solo después del ledger.
- **Estado actual:** `PLACEHOLDER`; settings only.
- **Prioridad:** P1
- **Dependencias:** P1–P3, P5-01, P6-01
- **Archivos/servicios afectados:** copy settings, worker, execution, notifications
- **Implementación esperada:** explicit opt-in, max per trade/day, slippage, allowed assets/chains, kill switch, pause on source uncertainty.
- **Acceptance Criteria:** no copy without source settled event; limits are atomic; failures visible.
- **Tests necesarios:** burst trades, insufficient balance, source duplicate/out-of-order, limit enforcement.
- **Definition of Done:** beta with capped notional and manual emergency control.

### P7-02 — Real rewards settlement

- **Descripción:** Separar accounting rewards de actual payout transfer.
- **Estado actual:** `PARTIAL / INTERNAL LEDGER`.
- **Prioridad:** P1
- **Dependencias:** P1-01, P0-05, P3-01
- **Archivos/servicios afectados:** rewards, signer, claim API, compliance/risk
- **Implementación esperada:** claim intent, payout tx, receipt, retry/idempotency, minimum and sanctions/risk policy.
- **Acceptance Criteria:** txRef solo se muestra como tx hash si existe receipt settled.
- **Tests necesarios:** double claim, failed payout, pending payout, blocked account.
- **Definition of Done:** staging payout with auditable ledger reconciliation.

### P7-03 — Launchpad decision: rebuild or remove

- **Descripción:** Decidir si se reconstruye como on-chain product o se mantiene como clearly simulated sandbox.
- **Estado actual:** `MOCK` local curve.
- **Prioridad:** P1 decision / P2 implementation
- **Dependencias:** P1 accounting, P6 chain certification, security review
- **Archivos/servicios afectados:** launchpad domain/API/UI
- **Implementación esperada:** si live, deploy factory/curve/LP lock, indexer and audit; si no, rename UI to Simulation and isolate from balances/reputation.
- **Acceptance Criteria:** no simulated raised/holders/tx hash se presenta como on-chain.
- **Tests necesarios:** curve invariants or contract integration, concurrency, oversell.
- **Definition of Done:** product copy and API mode unambiguous.

### P7-04 — Prediction market hardening

- **Descripción:** Validar CLOB order construction and isolate Polygon wallet/order lifecycle.
- **Estado actual:** `PARTIAL`, unverified against live protocol in this audit.
- **Prioridad:** P1
- **Dependencias:** P0 security, signer model
- **Archivos/servicios afectados:** `market/clob.ts`, prediction UI/API
- **Implementación esperada:** market constraints, credentials lifecycle, order status/cancel/fill and Polygon receipts.
- **Acceptance Criteria:** no “order placed” until CLOB response status is parsed and persisted.
- **Tests necesarios:** tick size, min size, BUY/SELL, auth failures, cancel/fill.
- **Definition of Done:** staging order with documented live protocol verification.

---

## PHASE P8 — Community convergence, mobile and production operations

### P8-01 — Community Brain integration

- **Descripción:** Integrar `packages/core` signals con discovery/feed/notifications sin mezclar DBs accidentalmente.
- **Estado actual:** `PARTIAL at repository level`; products are separate.
- **Prioridad:** P1
- **Dependencias:** P5-02, P5-03, P4-03
- **Archivos/servicios afectados:** core/app boundary, events, Telegram adapter
- **Implementación esperada:** versioned events: community signal, market signal, raid signal; labels and tenant isolation.
- **Acceptance Criteria:** community signal never claims trade/price fact unless sourced; tenant data isolated.
- **Tests necesarios:** event contract, tenant isolation, provider failures.
- **Definition of Done:** one pilot community with end-to-end signal attribution.

### P8-02 — Mobile production QA

- **Descripción:** Validar PWA/Capacitor, wallets, deep links, safe-area, keyboard and error states.
- **Estado actual:** `PARTIAL`; CSS/config exists, no evidence of device QA.
- **Prioridad:** P1
- **Dependencias:** P2–P5
- **Archivos/servicios afectados:** `site/app.html`, CSS, Capacitor config, wallet adapters
- **Implementación esperada:** device matrix iOS/Android, no optimistic financial states, reconnect handling.
- **Acceptance Criteria:** key flows pass on real devices: login, quote, sign, pending, failure, portfolio.
- **Tests necesarios:** manual device checklist + automated browser smoke.
- **Definition of Done:** release candidate signed off.

### P8-03 — Observability and operations

- **Descripción:** Añadir structured logs, metrics, traces, provider health, alerts, backups and restore.
- **Estado actual:** `MISSING / P1`.
- **Prioridad:** P0 for production
- **Dependencias:** P1-02, P5-04
- **Archivos/servicios afectados:** API, workers, deployment, DB
- **Implementación esperada:** request IDs, trade IDs, no secrets in logs, SLOs, SQLite backup/restore or PostgreSQL migration.
- **Acceptance Criteria:** incident can answer what happened to a trade without querying raw host logs manually.
- **Tests necesarios:** backup restore, worker restart, alert firing, log redaction.
- **Definition of Done:** runbook for outage, provider outage and stuck transaction.

### P8-04 — Database scale migration

- **Descripción:** Evaluar PostgreSQL + Redis + queue before multi-instance/multi-tenant scale.
- **Estado actual:** SQLite single-node.
- **Prioridad:** P1 at scale, P2 for closed beta
- **Dependencias:** P1 ledger, P5-04, P8-03
- **Archivos/servicios afectados:** repository layer, migrations, deployment
- **Implementación esperada:** repository interfaces preserve domain; no direct SQL scattered in routes.
- **Acceptance Criteria:** concurrent writes, cursor pagination and worker locking behave correctly.
- **Tests necesarios:** load/concurrency and migration tests.
- **Definition of Done:** measured decision based on target users/throughput, not premature preference.

---

# 9. DEPENDENCY GRAPH

```text
P0-01 live/mock safety ─────┐
P0-02 mutation auth ────────┼──> P1-01 intents/fills ──> P1-02 reconciler
P0-03 idempotency/schema ───┘             │                    │
P0-05 signer threat model ────────────────┘                    │
                                                              ▼
                                                   P1-03 positions/PnL
                                                              │
                                                   P1-04 asset math
                                                              │
                    ┌─────────────────────────────────────────┼───────────────────────┐
                    ▼                                         ▼                       ▼
              P2-02 Solana live                         P3-01 portfolio          P4-01 market service
                    │                                         │                       │
                    ▼                                         ▼                       ▼
              P2-03 EVM live                            P3-02 metrics          P4-03 explainable score
                    │                                         │                       │
                    └───────────────> P5-01 follow graph <────┘                       │
                                                   │                                   ▼
                                                   ▼                            P4-04 wallet indexer
                                             P5-02 feed                              │
                                                   │                                   │
                                                   ▼                                   ▼
                                             P5-03 alerts <──────────────────── P5-04 realtime fanout
                                                   │
                                                   ▼
                                           P7-01 copy trading

P6-01/P6-02 multichain depende de P2 + P1-04.
P7-02 rewards payout depende de signer + settled ledger + portfolio.
P7-03 launchpad live depende de chain certification + security + accounting.
P8-01 Community Brain depende de feed/events/market contracts.
P8-02 Mobile depende de un único frontend y lifecycle real.
P8-03 Operations es requisito transversal para producción.
```

---

# 10. ESTIMATED COMPLETION / LOGICAL ORDER

Las estimaciones son de esfuerzo relativo de ingeniería para un equipo pequeño, no promesas de calendario.

| Milestone | Resultado | Esfuerzo relativo |
|---|---|---|
| M0 | P0 security freeze + contracts | 1 sprint |
| M1 | Canonical intents/fills + reconciler | 1–2 sprints |
| M2 | One-chain spot trading truly settled | 1–2 sprints |
| M3 | Portfolio/PnL/history correctos | 1–2 sprints |
| M4 | One EVM + market data service | 1–2 sprints |
| M5 | Unified frontend + feed/social graph | 1–2 sprints |
| M6 | Alerts/realtime/observability | 1–2 sprints |
| M7 | Additional chains | 1 sprint per chain initially |
| M8 | Copy trading/rewards payout/launchpad decision | 2+ sprints each, security dependent |
| M9 | Community convergence/mobile production | 1–2 sprints after core stability |

No se recomienda estimar “completion total” antes de definir custody, accounting policy y chain capability matrix.

---

# 11. FIRST SPRINT

El primer sprint no debe construir nuevas superficies de producto. Debe cerrar riesgos que pueden producir pérdida de fondos o reputación falsa.

## Sprint goal

> Que ningún request pueda presentar una simulación como trade live, crear actividad social falsa, duplicar una operación por retry o marcar como confirmado un broadcast no settlement.

## Tasks

1. **P0-01:** quitar fallback mock en live y añadir política sandbox/mock explícita.
2. **P0-02:** proteger `/api/feed/post`; eliminar actor fallback.
3. **P0-03:** añadir idempotency key al execute y validación estricta de amount/slippage/chain/token.
4. **P0-04:** definir CORS allowlist y security headers mínimos.
5. **P0-05:** redactar ADR de custody/signer y bloquear live deploy hasta su aprobación.
6. **P1-01:** diseñar y migrar lifecycle `intent → submitted → pending → confirmed/failed`.
7. **P1-02:** crear reconciler mínimo para una chain, aunque sea con provider mock determinista en tests.
8. **P1-03:** corregir la conexión entre posición cerrada, fill settled y realized PnL.
9. **Legacy freeze:** redirigir/congelar `site/trading.html` para que no ejecute estado optimista.
10. **Verification:** restaurar dependencias reproducibles de `packages/app` y ejecutar test, typecheck, parse y build en CI.

## Sprint acceptance criteria

- `APP_MODE=live` devuelve error si el proveedor de quote falla; no genera una quote mock.
- No se puede postear en el feed sin autenticación.
- Dos requests iguales con la misma idempotency key producen una sola operación/fill/fee.
- Un broadcast aceptado aparece como `pending`, no `confirmed`.
- Un receipt revertido aparece como `failed` y no crea posición/reward settled.
- Realized PnL de buy → partial sell → final sell coincide con la política documentada.
- `site/trading.html` no puede añadir una posición local después de un error de API.
- `packages/core` continúa con 101 tests pasando y typecheck limpio.
- `packages/app` test/typecheck/build pasan en entorno limpio reproducible.

---

# 12. TEST STRATEGY

## Trading

- Buy/sell spot con cantidades enteras y decimals diferentes.
- Partial sell y oversell.
- Slippage exceeded.
- Insufficient USDC/native gas.
- Quote expired.
- Provider timeout.
- Approval failed.
- Broadcast accepted, pending, confirmed, reverted, dropped and replaced.
- Retry same idempotency key.
- Duplicate/out-of-order receipt callback.

## Positions/PnL

- Entry único.
- Multiple buys and average entry.
- Partial close.
- Full close.
- Reopen after close.
- Fees in buy and sell.
- Realized vs unrealized separation.
- ROI and drawdown.
- Multiple assets and chains.
- Same token address on two chains.

## Portfolio

- Native balances, USDC and arbitrary ERC20/SPL.
- Deposits/withdrawals once implemented.
- Price unavailable/stale.
- Large balances beyond JS safe integer.
- Concurrent settlement and projection rebuild.

## Realtime

- SSE disconnect/reconnect.
- Last event ID resume.
- Duplicate events.
- Out-of-order events.
- Slow consumer/backpressure.
- Worker restart and outbox replay.

## Security

- Missing/invalid/expired API key.
- API key rotation/revocation.
- Wallet signature tampering.
- Nonce replay and wrong address.
- Cross-user resource access.
- Feed actor spoofing.
- Admin endpoint abuse.
- Rate limit and body size.
- Origin/CORS/CSP.
- XSS/unsafe URLs/inline handler injection.
- Secret/log redaction.
- Double claim/double execution.

## Frontend/UX

- Loading, empty, stale, error and retry states.
- No-data vs zero-data distinctions.
- Live/mock/simulated labels.
- Mobile keyboard and safe areas.
- Wallet disconnect/account switch/network switch.
- Price freshness and quote expiry visible.
- Pending transaction screen survives page reload.
- Accessible focus/modal/keyboard behavior.

---

# 13. DEFINITION OF DONE — PRODUCT LEVEL

The platform is not done when TypeScript compiles. A feature is done only when:

1. Its source of truth and data provenance are documented.
2. Its API contract and authorization rules are explicit.
3. Its failure and recovery states are implemented.
4. Its amounts use precise integer math where financial.
5. Its live/mock/simulated state is impossible to confuse.
6. Its concurrency/idempotency behavior is tested.
7. Its frontend has loading, empty, error, stale and pending states.
8. Its metrics are consistent between backend, UI and exports.
9. Its security impact has been reviewed.
10. Tests, typecheck, lint, build and integration verification pass.
11. Operations has logs, metrics, rollback and recovery instructions.
12. The roadmap task is updated with evidence, not just marked complete.

---

# 14. FINAL AUDIT CONCLUSION

La dirección correcta no es añadir más tabs ni replicar el benchmark. El repositorio ya contiene suficientes superficies para parecer un producto grande, pero el siguiente salto debe centrarse en **veracidad operativa**:

- una única terminal;
- un único modelo de ejecución;
- fills settled como fuente de verdad;
- portfolio/PnL reconstruible;
- capabilities multichain verificadas;
- social graph real y autorizado;
- discovery explainable;
- custody y seguridad decididas antes del crecimiento.

El producto tiene una oportunidad clara frente al benchmark: unir ejecución y reputación verificables con inteligencia de comunidades Telegram, raids, quests y señales sociales honestamente etiquetadas. Esa ventaja solo será sostenible si el sistema nunca convierte una UI convincente en una afirmación financiera no respaldada por datos settled.

**Recomendación final:** aprobar únicamente el **First Sprint P0/P1** de este documento. No implementar copy trading, perps, launchpad on-chain, rewards payout ni expansión multichain hasta completar el lifecycle de transacciones, accounting y security gates.
