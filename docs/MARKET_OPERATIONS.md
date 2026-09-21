# Operación del catálogo de mercado

Estado: implementación local probada, sin habilitar en producción. No ejecuta swaps.

## LaunchLab on-chain (Raydium, self-custody)

Curva de bonding REAL en el programa LaunchLab `LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj`. El servidor **solo lee** (decoders del SDK `@raydium-io/raydium-sdk-v2` fijado) y construye transacciones sin firmar; el usuario firma en su wallet y la tx se envía a Solana con verificación byte a byte. El servidor nunca custodia fondos ni claves.

Variables de entorno:

- `SOLANA_RPC_URL` (obligatorio para LaunchLab): endpoint RPC de Solana. Sin él, `/api/launchlab/*` devuelve 503 `RPC_DISABLED`.
- `APP_MODE=live` y ejecución habilitada (kill switch): los endpoints prepare/submit/create/confirm exigen ambos.
- `EXECUTION_*`: ver `docs/audit/2026-09-17-self-custody.md` para el motor de ejecución compartido.

Endpoints (bajo `/api/launchlab`):

| Ruta | Auth | Efecto |
|---|---|---|
| `GET /list` | pública | Registro local de launches confirmados (estado real = on-chain) |
| `GET /:mintA/state?quote=sol` | pública | Estado vivo de la curva (lectura RPC, sin mutación) |
| `GET /:mintA/quote?side&amount&slippageBps` | pública | Quote de curva real (nunca muta) |
| `POST /:mintA/prepare` | wallet vinculada | Tx sin firmar de buy/sell + sesión durable exactly-once (id = hash del mensaje) |
| `POST /:mintA/submit` | wallet vinculada | Verificación exacta de la tx firmada contra el payload almacenado → broadcast → confirmación → registro |
| `POST /create-tx` | wallet vinculada | Tx de creación (mint keypair permanece en el navegador) |
| `POST /confirm-create` | wallet vinculada | Verificación de createAccount+initializeV2+metadata y firmas creator+mint → broadcast → registro |
| `GET /:mintA/activity` | cuenta | Fills propios del ledger local (la cadena es la verdad) |

Verificaciones de seguridad en submit (todas rechazan con 4xx): sesión consumida una sola vez; `serializeMessage()` de la tx firmada debe ser EXACTAMENTE el mensaje preparado (id de sesión); discriminador y 18 cuentas de `buyExactIn`/`sellExactIn` idénticas al payload almacenado; `minOut` re-verificado; firmante = wallet del usuario (firmas huérfanas rechazadas). En confirm-create: exactamente un `createAccount` del mint reclamado (space 82, SPL Token), un `initializeV2` con config canónica derivada, PDAs correctas, metadata decodificada igual a la confirmada y conjunto de firmantes exactamente creator+mint.

Quotas operativas: sesión TTL 10 min; mínimo de trade 0.01 SOL; slippage 0..5000 bps; la graduación a CPMM es automática (crank de Raydium) — no hay acción del operador. El smoke read-only contra mainnet (decoders + state + quote con pool real `4Asy4y8V…`, config `6s1xP3hp…` == derivación SDK) se ejecutó el 2026-09-21 con resultados coherentes (precio 0.7689 SOL/token, mínimo aplicado, venta neta correcta).

Nota de convención: `LaunchpadPool.decode(data)` del SDK consume los datos de cuenta **completos** (429 bytes; el `u64` sin nombre inicial cubre el discriminador anchor). Pasar `data.subarray(8)` produce campos corridos y estados falsos.

## Inicio local

En `packages/app`, instalar dependencias con el lockfile existente y ejecutar `pnpm run build`. API y worker deben apuntar al **mismo archivo SQLite local** mediante `DB_PATH`. No usar una copia productiva para probar. El proceso no carga `.env` automáticamente: inyectar variables o arrancar Node con `--env-file`.

```powershell
$env:DB_PATH = 'C:\tmp\trenches-local\market.db'
$env:MARKET_DISCOVERY_CHAINS = 'solana,base'
pnpm run worker:market --once
```

Sin `--once` procesa secuencialmente un trabajo cada 10 segundos. No habilitar múltiples réplicas como escalado sin medir cuotas y SQLite. Leases previenen doble confirmación de jobs, pero el presupuesto upstream sigue siendo por proceso.

`MARKET_DISCOVERY_CHAINS`: lista separada por comas; redes admitidas en `MARKET_CHAINS` de catalog.ts. Default solana/base. Las redes admitidas para observar pools no son una lista de redes habilitadas para trading.

## Datos y migración

Tablas aditivas: market_assets, market_pools, market_jobs, market_schema. La API ingiere resultados de mercado existentes y añade GET `/api/market/catalog`, GET `/api/market/catalog/stats`, POST `/api/market/import` con `{chain,address}`. La importación exige contrato válido y un pool observado; devuelve error si no hay datos, nunca una cotización falsa.

Versiones del catálogo inicializadas al abrir AppDb/worker; migración aditiva de created_at para filtros por edad. Producción requiere backup consistente/restauración probada y aprobación de despliegue. No ejecutar DDL destructivo ni borrar tablas para recuperar el worker.

## Fallos y recuperación

Jobs guardan due_at, attempts, lease_until, last_success y last_error genérico. Fallo: backoff desde 15 segundos, máximo una hora. Un lease expira a los 60 segundos; un proceso antiguo no confirma después de perderlo. SIGINT/SIGTERM termina después del trabajo actual. Reiniciar vuelve a recoger trabajos pendientes; no borrar su estado.

Los pools caducados permanecen buscables: después de 60 segundos se marcan degradados y después de cinco minutos no disponibles. No se declara negociable ningún resultado del catálogo. `/catalog/stats` y logs JSON del worker dan conteos y duración; no sustituyen métricas/alertas operativas.

Para pausar descubrimiento, detener el worker correspondiente. Quitar una red de MARKET_DISCOVERY_CHAINS **no elimina jobs existentes**: su desactivación operativa requiere un control adicional todavía pendiente. La ejecución financiera permanece bloqueada en los endpoints; APP_MODE=mock no debe utilizarse como interruptor de seguridad para fondos.

Para investigar un token: consultar red+contrato en catálogo, fuente/as_of/pool y jobs asociados; comparar proveedor y RPC sin registrar credenciales. No interpretar transferencias como fills.

## Verificación

En packages/app: `pnpm run typecheck`, `pnpm test`, `pnpm run build`. Lint aún no configurado. E2E desde raíz con navegador local abierto:

```powershell
npx --yes --package @playwright/cli playwright-cli --session trenches-audit run-code --filename packages/app/tests/e2e-market-terminal.js
```

El catálogo debe contener pools reales de prueba consultados con el botón de descubrimiento. El script nunca firma ni envía operaciones. Para CI futura, separar fixtures de proveedor del smoke remoto.
