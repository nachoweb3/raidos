# Ejecución real self-custody — 17 septiembre 2026

## Actualización posterior (mismo día): hardening operativo y fee on-chain

Tras el primer despliegue se implementaron tres frentes adicionales autorizados por el usuario:

1. **Kill switch de ejecución**: bandera durable `app_settings.execution_enabled` con `POST/GET /api/admin/execution` (secreto admin, comparación constant-time). Un 503 explícito alcanza a `prepare` y `submit` en cada request. `EXECUTION_ENABLED=0` por entorno permite armarlo antes de la primera request tras un despliegue limpio.
2. **Límite de exposición diaria por usuario**: cada sesión self-custody persiste su pata USDC resuelta (`usdcLegMicro`: amount en compras; `quote.buyAmount` resuelto en ventas, tras la cita). `assertDailyExposure` suma las sesiones de las últimas 24 h (1 por swap, incluidas las no firmadas, para que los reintentos no multipliquen exposición) y devuelve 429 al superarla. Por defecto 1.000 USDC/día; `EXECUTION_DAILY_LIMIT_USDC=0` lo desactiva. Visible en `/api/admin/execution`.
3. **Vinculación de wallet a cuenta existente**: `POST /api/wallet/link` (autenticado) añade una wallet verificada por firma al usuario actual sin rotar la API key ni cambiar identidad — necesario para usuarios Google/X. UI: botón "Vincular otra wallet a esta cuenta" en el modal, visible solo con sesión iniciada. `409` si la wallet pertenece a otra cuenta.
4. **Fee on-chain EVM (0x v2)**: parámetros verificados en docs de 0x (`swapFeeRecipient`, `swapFeeBps` 0–1000, `swapFeeToken` = sell o buy token). Implementado en `getEvmQuote`, desactivado por defecto: se activa con `EVM_SWAP_FEE_RECIPIENT` (y opcional `EVM_SWAP_FEE_BPS`, por defecto 30 = 0,3 %). El fee se cobra dentro del swap, así que el delta de venta sigue siendo `sellAmount` y el parser de recibos sigue siendo válido. Jupiter en Solana requiere integración propia (pendiente, no simulada).

**Bug corregido gracias al E2E en vivo**: repetir el mismo `Idempotency-Key` en `prepare` devolvía 500 (constraint UNIQUE sin manejar). Ahora resuelve idempotente: misma clave + mismo payload → respuesta original; payload distinto → 409. También queda persistido `result_json` del prepare para reintentos.

**E2E real contra producción (sin fondos, sin broadcast)**: wallets efímeras generadas en el proceso de test; challenge → firma ed25519/EIP-191 real → `wallet/link` OK en ambas cadenas; `prepare` devolvió transacción sin firmar real (Solana: Jupiter, 1.039 bytes; Base: 0x, 1.928 bytes de calldata); `submit` con hash inventado quedó `pending` en el ciclo de vida y el replay devolvió 409. Script reproducible: `packages/app/tests/e2e-self-custody-live.mjs` (requiere `BOOTSTRAP_SECRET`).

Suite: 246 tests app (22 archivos), 101 core, typecheck/build limpios. Web gh-pages `bf5c75e` con versión de módulos `20260917-3`; API rede-splegada dos veces (hardening + fix de idempotencia).

**Límites nuevos**: el límite de exposición es por cadena y por ventana de 24 h deslizante (no calendario); sesiones antiguas caen solas del cómputo. El fee EVM está apagado (sin `EVM_SWAP_FEE_RECIPIENt` no se añaden parámetros y las cotizaciones no cambian). No hay fee en Solana todavía: los rewards de trading siguen sin acumular fee real en esa red.

---

Autorización: el usuario pidió poner inusaur.online "en modo real" para que los usuarios puedan usarlo pronto. Decisiones tomadas con el usuario: redes Solana + Ethereum + Base; despliegue autorizado al terminar la verificación local; el acceso beta con códigos (ACCESS_CODES) se mantiene.

## Qué se activó

Ejecución spot real **no custodial**. El servidor nunca recibe ni deriva claves privadas:

1. `POST /api/trades/prepare` — cita en vivo (Jupiter en Solana, 0x v2 en Ethereum/Base), construye la transacción **sin firmar** y guarda una sesión durable (`self_custody_sessions`) consumible exactamente una vez. Exige que la wallet que firma esté vinculada al usuario autenticado mediante identidad firmada (reto ed25519/EIP-191 ya existente en `/api/auth/wallet`). Sin vínculo → 403 antes de contactar proveedores. Redes sin adaptador → 403.
2. El usuario firma en su wallet (Phantom `signAndSendTransaction` / MetaMask `eth_sendTransaction`). La UI solo pide la firma si `/api/chains` reporta `liveExecution: true` y `status: "LIVE"` para esa red.
3. `POST /api/trades/submit` — registra el hash enviado (consumo atómico de la sesión; replay → 409), crea intent + transacción + trade pendiente y reconcilia inline contra el RPC: **solo un recibo verificado con deltas exactos de tokens produce fill, posición y PnL**. Nada se liquida por la cantidad que dice el cliente.
4. Reconciliador periódico en vivo (cada 15 s en modo live) para pendientes que no confirmaron inline; se limpia en `stop()`.

## Cambios por archivo

- `packages/app/src/trading/reconciler.ts`: `parseEvmTransferFill` (deltas de logs `Transfer` por propietario, malformaciones rechazadas, net-zero rechazado) y uso del parser tanto en recibos Solana (deltas SPL) como EVM (`eth_getTransactionReceipt` + logs). `reconcilePending(userId?)` filtra por usuario para la reconciliación inline.
- `packages/app/src/database/app-db.ts`: tabla `self_custody_sessions` (migración aditiva `IF NOT EXISTS`) y métodos `createSelfCustodySession` / `getSelfCustodySession` / `consumeSelfCustodySession` (transacción SQLite, exactly-once).
- `packages/app/src/api/server.ts`: endpoints reales `prepare`/`submit` (antes 503), capacidades `/api/chains` con `liveExecution`/`selfCustody`/`status` por red (gate por credenciales de proveedor + `SELF_CUSTODY_CHAINS`), `reconcileExecutionTransactions` con proveedor de recibos inyectable (`receiptProvider` para tests), temporizador de reconciliación en `start()`/`stop()`.
- `site/js/trading.js`: caché de capacidades (`refreshCapabilities`), botón de orden habilitado solo en redes LIVE con dirección real resuelta, gate antes de pedir firma, parseo exacto de micro-USDC (sin aritmética float), venta bloqueada honestamente (requiere venta on-chain; el cierre no borra posiciones no liquidadas).
- `site/app.html`: estado del terminal y bump del grafo de módulos a `v=20260917-2`.
- Tests: nueva suite `tests/self-custody.test.ts` (12 tests) y actualizados `production-guards` / `accounting-safety` al nuevo contrato de capacidades.

## Verificación local

- `packages/app`: 239 tests / 22 archivos, 3 ejecuciones consecutivas verdes (se observó un flake aislado de tinypool "Worker exited unexpectedly" en Windows, no reproducible de forma estable y sin correspondencia con fallos de código).
- `packages/core`: 101 tests, typecheck limpio.
- `packages/app`: typecheck y build limpios. Lint sigue sin existir (deuda conocida).

## Despliegue (autorizado por el usuario)

- Secretos Fly añadidos antes del despliegue: `JUPITER_API_KEY` (provista por el usuario, jamás impresa en logs) y `ADMIN_SECRET` (generado aleatoriamente). Secretos previos conservados: APP_MODE, BOOTSTRAP_SECRET, DB_PATH, X_CLIENT_ID/SECRET, ACCESS_CODES, ZERO_X_API_KEY.
- API: `flyctl deploy --app raidos-api --remote-only --now` — máquina 84ed23ea636178 en estado started con health checks aprobados.
- Web: `nachoweb3/inusaur` rama `gh-pages`, commit `4f137441f0d0c763616b69f90f0fb1fb7719a536` sobre `654c5fd`, conservando CNAME y .nojekyll. La copia de publicación se resincronizó contra el remoto antes de reemplazar el contenido (retirado el flujo custodial legacy de predicciones y JS sin escapar que habían quedado pendientes en esa copia).

## Verificación pública

- `GET /api/health` → `{ok:true, mode:"live"}`.
- `GET /api/chains` → solana/ethereum/base `LIVE` con `liveExecution:true`; bsc/robinhood/arc `UNAVAILABLE`; Polygon/Arbitrum/Monad ausentes.
- Cita real Solana (USDC→BONK, ruta Jupiter "Meteora DLMM | Whirlpool | Whirlpool") y Base (USDC→WETH, ruta 0x) con cuenta de prueba; sin envío de transacciones.
- Smoke Playwright sobre https://inusaur.online/app.html (read-only, sin login): versión `20260917-2` servida, capacidades LIVE visibles desde el navegador, botón de orden deshabilitado sin sesión autenticada (desktop y móvil 390×844), cero errores de página. Capturas: `output/playwright/inusaur-selfcustody-{desktop,mobile}.png`.

## Límites explícitos (no certificados por esta entrega)

- Fee de plataforma on-chain en self-custody: implementado y activado en producción (30 bps = 0,3%). EVM: 0x v2 `swapFeeRecipient/swapFeeBps/swapFeeToken` con `EVM_SWAP_FEE_RECIPIENT` configurado. Solana: Jupiter `platformFeeBps` + `feeAccount` = ATA del fee owner (`SOLANA_PLATFORM_FEE_OWNER`) para el mint de salida, derivada en runtime; la cuenta debe existir on-chain (check RPC con caché 5 min) o el fee se omite para ese mint y el swap sigue funcionando — Jupiter rechaza /swap con 400 si el quote lleva fee sin feeAccount, por eso la resolución ocurre antes de cotizar. El bps efectivo por swap se persiste en la sesión y la reconciliación usa ese valor, no el env vivo. `SOLANA_PLATFORM_FEE_ACCOUNT` se conserva como override estático. Fees tomados fuera de USDC se reportan en unidades crudas, sin conversiones estimadas.
- Pre-creación de ATAs de fee Solana: `packages/app/scripts/solana-fee-atas.mjs`. `--check` (solo lectura) auditó el top-60 del catálogo real + USDC/wSOL: 1 ATA existe, 60 faltan, costo ~0.09 SOL (renta recuperable). `--create` (idempotente, lotes de 5) lo ejecuta el operador en SU máquina con `SOLANA_FEE_SECRET` (export de Phantom, nunca impresa ni persistida por el script); valida que la clave sea exactamente el fee owner y que el balance cubra la renta. Tras crearlas, el fee Solana fluye sin redeploy (la caché del motor expira en 5 min). Estado al 2026-09-17: tesorería con 0.0009 SOL — pendiente fondear ~0.15 SOL y ejecutar `--create`.
- Venta (SELL) exige tener posición liquidada previa; la UI lo comunica sin simular cierres.
- Cobertura de proveedores: cuotas y disponibilidad de Jupiter/0x/RPC públicos no tienen SLA; una cita fallida devuelve 503 explícito.
- Sin límites de exposición por usuario, sin kill switch, sin auditoría externa. El riesgo permanece en la wallet del usuario por diseño.
- Histórico: trades previos mock no se reinterpretan como settled.
