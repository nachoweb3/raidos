# Self-Custody-First P0/P1 Sprint Design

**Fecha:** 2026-09-14  
**Estado:** Propuesta para revisión del usuario  
**Relacionado:** `AUDIT.md`

## 1. Objetivo

Cerrar los bloqueadores que pueden causar pérdida de fondos, actividad social falsa, operaciones duplicadas o PnL incorrecto antes de añadir nuevas superficies de producto.

El resultado del sprint debe ser un sistema que:

- nunca ejecute una quote simulada como si fuera live;
- no permita mutaciones sin autorización;
- pueda repetir requests de forma segura mediante idempotencia;
- distinga `submitted`, `pending`, `confirmed` y `failed`;
- derive posiciones y realized PnL únicamente de operaciones settled;
- no descifre ni firme claves privadas de usuarios en el proceso API cuando el modo sea live;
- tenga una única terminal de trading activa.

## 2. Decisiones aprobadas

### 2.1 Custody: self-custody first

La producción no utilizará wallets custodiales gestionadas por el backend.

- El usuario firma localmente con Phantom, MetaMask u otro wallet compatible.
- El backend prepara y valida quotes/transactions, registra intents y reconcilia receipts.
- Las rutas de creación, importación, exportación y firma custodial quedan bloqueadas para `live` con `403` y un error explícito.
- Las rutas custodiales pueden mantenerse únicamente para `mock`/sandbox y tests deterministas, siempre con respuesta etiquetada como simulada.
- No se realizará una migración destructiva de las tablas o métodos custodiales durante este sprint.
- Una futura custody opcional requerirá un servicio separado, signer aislado/KMS/HSM, límites de gasto, kill switch y auditoría independiente.

### 2.2 Modos de ejecución

Se mantienen los modos existentes para no romper el contrato actual, pero se aplica una política estricta:

- `mock`: únicamente simulación; hashes, fills y rewards deben estar etiquetados como simulados.
- `live`: solo proveedores y transacciones reales; cualquier fallo de quote devuelve `502`/`503`, nunca una quote mock.
- La UI solo habilita ejecución cuando la quote indica modo live, está vigente y coincide con chain, tokens y cantidades solicitadas.

Durante este sprint no se habilitan nuevas chains ni nuevas modalidades como perps, leverage o bridge execution.

## 3. Alcance

### Incluido

1. Política live/mock y eliminación del fallback mock en live.
2. Autorización obligatoria para `POST /api/feed/post` y eliminación de actor implícito.
3. Validación estricta de inputs financieros y límites de slippage.
4. Idempotencia para ejecución de trades y operaciones sensibles seleccionadas.
5. Modelo persistente de execution intent/transaction/fill, compatible con SQLite actual.
6. Lifecycle de transacción y reconciliación mínima para una chain inicial.
7. Settlement de posiciones y realized PnL basado en fills settled.
8. Bloqueo de custody live.
9. Congelación o redirección del terminal legacy.
10. Tests, typecheck, lint y build reproducibles de `packages/app`.

### Fuera de alcance

- Migración inmediata de SQLite a PostgreSQL.
- Copy trading.
- Perps, short, leverage, limit orders o TP/SL.
- Bridge execution.
- Launchpad on-chain.
- Rewards payout on-chain.
- Nuevas integraciones multichain.
- Reescritura completa del servidor en otro framework.
- Rediseño visual general de la aplicación.

## 4. Arquitectura propuesta

### 4.1 Flujo de trade

```text
Client wallet
   │ request quote
   ▼
Quote service/provider
   │ validated quote + expiry + mode
   ▼
Execution intent (idempotency key)
   │ self-custody: unsigned/serialized transaction for client signing
   │ mock: deterministic simulated submission
   ▼
Submitted transaction
   │ tx hash / simulation id
   ▼
Pending
   │ receipt reconciler
   ├── confirmed/settled → fill → position projection → feed/rewards
   └── failed/reverted    → failure state; no settled position/reward
```

La implementación debe conservar una frontera clara entre:

- **Intent:** lo que el usuario solicitó.
- **Transaction:** lo enviado a una chain o simulador.
- **Fill:** resultado settled usado por accounting.
- **Projection:** posición, portfolio, feed y rewards derivados.

### 4.2 Self-custody durante el sprint

El diseño debe permitir que un cliente envíe una transacción firmada o un resultado de wallet externo sin que el servidor reciba una private key. Si el proveedor actual no permite separar todavía la construcción de la transacción del broadcast custodial, el endpoint live se mantendrá deshabilitado en lugar de introducir una falsa garantía de self-custody.

El endpoint custodial existente no se reutilizará silenciosamente como fallback. En `live` devolverá `403 custodial signing is disabled; use a connected wallet`.

### 4.3 Persistencia

Se añadirán tablas o estructuras equivalentes, con migración compatible con SQLite:

- `execution_intents`: user, idempotency key, request hash, requested trade params, mode, status y timestamps.
- `transactions`: intent, chain, tx hash/simulation id, submitted/pending/confirmed/failed timestamps, receipt/error metadata.
- `fills`: transaction, asset identities, exact integer amounts, fee, settlement timestamp y source.

La migración debe ser idempotente y no borrar datos existentes. Los trades históricos se tratarán como legacy hasta ser migrados o excluidos explícitamente de métricas settled; no se deben reinterpretar silenciosamente como fills confirmados.

## 5. Contratos y reglas de negocio

### 5.1 Quote

Una quote live debe incluir como mínimo:

- `mode: "live"`;
- provider/aggregator real;
- chain de origen y destino;
- sell token, buy token y cantidades exactas;
- `expiresAt` o equivalente;
- slippage aplicado y límites;
- route/quote identifier cuando el proveedor lo soporte.

Si falla el proveedor live, la respuesta será no-2xx y no contendrá una quote ejecutable. `buildMockQuote` solo se invoca cuando `appMode === "mock"`.

### 5.2 Validación financiera

- Amounts se validan como strings decimales no negativos y se normalizan a integer base units antes de llegar al provider.
- No se usa `Number()` para cantidades contables en backend.
- Slippage debe estar dentro de un rango server-side definido; valores ausentes o fuera de rango se rechazan.
- Chain y tokens deben coincidir con una capability configurada.
- Un swap spot debe tener exactamente una pata USDC para el flujo soportado.
- Requests con body inválido, excesivo o con campos incompatibles reciben `400`.

### 5.3 Idempotencia

`POST /api/trades/execute` requiere header `Idempotency-Key` no vacío.

- La key se limita por usuario y endpoint.
- Se guarda un hash canónico del payload relevante.
- Misma key + mismo payload devuelve el resultado original.
- Misma key + payload distinto devuelve `409`.
- Requests concurrentes con la misma key esperan/reutilizan el mismo intent; no crean otra fee, tx, fill o reward.
- Si el primer intento queda pending, los reintentos devuelven el intent pendiente.

La misma infraestructura se deja preparada para claim/order, pero no se amplía el contrato de todos los endpoints si no es necesario para este sprint.

### 5.4 Lifecycle

Estados permitidos:

```text
created → submitted → pending → confirmed → settled
                         └──────→ failed
```

Reglas:

- `submitted` significa que el provider aceptó el envío, no que la operación tuvo éxito.
- `pending` es visible después de broadcast y sobrevive a un restart.
- Solo `confirmed` con receipt válido puede producir `settled`.
- Revert, receipt fallido, timeout definitivo o transacción descartada producen `failed`.
- Una operación `failed` nunca actualiza una posición settled ni acumula rewards de trading.
- Callbacks/reconciliaciones duplicados son idempotentes.
- Los estados terminales no pueden retroceder salvo una transición explícita de reorg definida por el adapter.

### 5.5 Positions y PnL

El motor adoptará **average cost** como política inicial, documentada y determinista:

- Buy: aumenta quantity y cost basis con el coste y fee definido.
- Buy adicional: recalcula average entry usando integer/base-unit math.
- Partial sell: realiza PnL sobre la cantidad vendida y reduce quantity/cost basis proporcionalmente.
- Full sell: cierra la posición; no deja cantidades negativas.
- Sell por encima de la cantidad disponible se rechaza.
- Un fill no settled no modifica posiciones ni realized PnL.
- Realized PnL se persiste en el fill/settlement y se agrega desde esa fuente.
- Unrealized PnL no se presenta como settled; requiere precio actual con source/freshness y puede aparecer como unavailable.
- La identidad del activo incluye `chain + address`; symbol y decimals son metadata, no claves contables.

El sprint debe corregir la divergencia actual donde la posición calcula realized PnL pero el trade puede conservar `realized_pnl_usdc: null` y `getUserPnl` usa otra fuente.

## 6. Cambios por área

### Backend

- `packages/app/src/api/server.ts`: aplicar policy, auth, validation, idempotency y orquestación del nuevo lifecycle.
- `packages/app/src/api/router.ts`: soportar lectura segura de headers y, si es necesario, respuestas de headers de seguridad.
- `packages/app/src/api/executors.ts`: dejar de afirmar `confirmed` después de broadcast; separar submission de confirmation.
- `packages/app/src/database/app-db.ts`: migración y operaciones atómicas para intents, transactions, fills y posición.
- `packages/app/src/trading/positions.ts`: reconstrucción basada en settled fills y average cost.
- `packages/app/src/trading/history.ts`: exponer lifecycle y fuente de settlement.
- Nuevo módulo acotado de reconciler/transaction lifecycle si la separación mejora las pruebas.

### Seguridad/API

- `POST /api/feed/post` pasa a ruta autenticada; actor siempre es `requireUserId(ctx)`.
- Custodial wallet create/import/delete/signing se bloquea en `live`.
- CORS deja de usar wildcard para requests autenticados; se define allowlist configurable y headers básicos.
- No se imprimen private keys, passwords, API keys ni bodies sensibles en logs.
- Las respuestas de error live no exponen detalles innecesarios de RPC/provider.

### Frontend

- `site/js/api.js`, `site/js/trading.js`, `site/js/feed.js` deben enviar idempotency key y mostrar lifecycle real.
- La UI distingue `mock`, `pending`, `confirmed`, `failed` y `unavailable`.
- No crea posiciones locales ni muestra éxito tras un error o antes de la respuesta correcta del backend.
- `site/trading.html` se redirige a `app.html` o queda explícitamente no operativo; no se mantiene un segundo flujo de trading.
- Las rutas de wallet muestran self-custody como método live y desactivan importación custodial en live.

## 7. Manejo de errores y recuperación

- Provider de quote caído: `503`, mensaje genérico, retry seguro.
- Quote expirada o modificada: `409`/`422`, se requiere nueva quote.
- Wallet desconectada o firma rechazada: estado cancelado/fallido sin settlement.
- Broadcast aceptado: respuesta `202` o equivalente con `intentId`, `txHash` y `pending`; nunca `confirmed` por anticipado.
- Receipt revertido: `failed`, razón normalizada, sin posición.
- Worker reiniciado: recupera intents `submitted/pending` desde DB.
- Reintento de cliente: se resuelve por idempotency key.
- Fallo de rewards/feed después de settlement: no revierte el fill; queda una tarea/retry registrable y no duplica accounting.

## 8. Testing requerido

### Unitarios

- Parsing de cantidades y slippage.
- Hash canónico de idempotency payload.
- Transiciones válidas/ inválidas del lifecycle.
- Average cost, partial sell, close, reopen, fees, oversell y decimals.
- Asset identity con misma dirección en dos chains.
- Policy que rechaza custody en live.

### API/integración

- Live quote provider failure nunca devuelve mock.
- Execute sin `Idempotency-Key` devuelve `400`.
- Duplicate concurrent execute produce un solo intent.
- Misma key con payload distinto devuelve `409`.
- Feed post sin auth devuelve `401` y no crea evento.
- Actor del feed coincide con el API key.
- Broadcast queda pending.
- Receipt confirmado crea un fill y posición.
- Receipt revertido no crea posición ni reward.
- Restart/reconcile recupera pending.
- Custodial wallet import/create en live devuelve `403`.

### Frontend/contrato

- Terminal legacy no ejecuta mutaciones.
- Error de execute no crea una posición local.
- Estado pending sobrevive recarga mediante API.
- Mock está etiquetado y no se muestra como live.
- Parse tests de módulos frontend.

### Verificación de entrega

En un checkout limpio y con el package manager documentado:

```text
pnpm install --frozen-lockfile
pnpm test
pnpm run typecheck
pnpm run lint       (si está configurado)
pnpm run build      (si está configurado)
```

También se debe conservar la verificación existente de `packages/core`: 101 tests y typecheck limpios, salvo que un cambio de contrato requiera actualizar tests justificadamente.

## 9. Criterios de aceptación del sprint

1. En `APP_MODE=live`, un fallo del provider de quote produce `502/503`; jamás una quote mock.
2. Ninguna ruta live descifra una private key de usuario ni firma en el API.
3. `POST /api/feed/post` sin autenticación recibe `401`; no existe actor fallback.
4. Execute requiere idempotency key y no duplica operaciones bajo retry/concurrencia.
5. Un broadcast aceptado aparece como `pending/submitted`, no `confirmed`.
6. Un receipt revertido aparece como `failed` y no afecta posiciones, PnL settled o rewards.
7. Buy → buy → partial sell → final sell produce cantidades, average entry, fees y realized PnL esperados según average cost.
8. Las cantidades financieras se manejan en integer/base units y la identidad incluye chain.
9. La terminal activa es única; `site/trading.html` no tiene ejecución optimista.
10. Tests, typecheck, lint y build de `packages/app` son reproducibles en un entorno limpio.
11. Cada trade pendiente puede investigarse mediante intent ID, transaction ID, tx hash y timestamps sin consultar logs manualmente.

## 10. Riesgos y límites explícitos

- El soporte self-custody live puede requerir cambiar el contrato actual de `execute`, porque los executors existentes reciben private keys. Si no se puede construir una transacción unsigned de forma segura en este sprint, live execution permanece bloqueado y se entrega primero el lifecycle en mock/testnet.
- SQLite seguirá siendo single-node durante este sprint; se implementarán transacciones y constraints locales, pero no se afirmará escalabilidad multi-instancia.
- Los trades históricos sin receipt verificable no se convertirán automáticamente en datos `ON-CHAIN SETTLED`.
- No se marcará una chain como live solo porque exista en `CHAINS`.

## 11. Definition of Done

El sprint está terminado cuando el código, los tests y la documentación demuestran los criterios anteriores y `AUDIT.md` se actualiza con evidencia concreta. Compilar no es suficiente: debe existir una ruta reproducible desde request hasta settlement o fallo, sin custody live y sin datos simulados presentados como reales.
