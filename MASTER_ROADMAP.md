# Trenches: roadmap maestro

## Entrega actual

- Búsqueda de contratos y símbolos sin catálogo fijo; identidad por cadena y contrato.
- Discover/scanner con pools nuevos y trending, paginación y métricas reales.
- Agregación DEX Screener + GeckoTerminal + referencia CoinGecko con caché compartida, cuotas y datos degradados explícitos.
- Velas reales por pool; ningún historial sintético.
- PnL de fills liquidados, ventas parciales exactas, USDC normalizado, rankings separados por cadena/período/modo.
- Login ligado al desafío firmado; endpoints financieros incompletos deshabilitados.
- Configuración privada para RPC Helius/Alchemy, sin afirmar que sus credenciales estén instaladas.
- Publicación del mercado en inusaur.online.

## Prioridad 1: ejecución verificable

Antes de habilitar cada cadena: credenciales/RPC de la red correcta; cotización y simulación; intención durable e idempotente; wallet autenticada; transaction binding (signer, chain, tokens, importe, min-out, destino/fees); expiración y antirreplay; hash único global; confirmación con timeout y reorg; parser de fills reales; recuperación tras reinicios y caídas; prueba integral y revisión independiente. No se habilita una cadena por tener tests unitarios verdes.

## Prioridad 2: posiciones y wallets

Reconstruir legacy con recibos comprobables. Incluir Token-2022, transferencias, múltiples wallets, EVM token inventory completo, decimales verificados y reconciliación de balances. Calcular unrealized PnL, coste unitario, equity, drawdown y ATH en el backend. EVM actualmente escanea principalmente nativo y USDC; el inventario mundial de wallets no está terminado.

## Prioridad 3: descubrimiento exhaustivo

Añadir indexadores por red/DEX, cobertura de launchpads y bonding curves, ingesta persistente de tokens, checkpoints y backfill. Las APIs públicas solo cubren sus índices. Pasar a PostgreSQL + Redis cuando haya múltiples instancias, con cuotas distribuidas y workers de actualización; medir latencias y definir presupuestos de API antes de prometer SLA.

## Prioridad 4: reputación y graph

Trenches Score con definición versionada; métricas de consistencia/riesgo; antisybil/wash trading; identidades de traders; wallet labels con evidencia; grafo wallet-token-trader-KOL-social con procedencia. Las categorías smart money/KOL/whales requieren datos verificables, no puntuaciones inventadas.

## Prioridad 5: automatización y crecimiento

Feed de operaciones verificadas, notificaciones, perfiles públicos, seguimiento. Copy Safety Engine y límites de riesgo antes de copy trading real. Rewards/referrals sujetos a fees efectivamente cobradas y claims on-chain; separar misiones sociales de resultados de trading. TP/SL/limit/trailing requieren ejecución e infraestructura, no solo controles visuales.

## Operación mundial pendiente

Auditoría de seguridad, pruebas adversarias, backups restaurables, monitoreo/alertas, rate limits por cuenta/IP, políticas de privacidad, observabilidad y pruebas de carga. Esta entrega es una base de mercado utilizable; no certifica el producto completo para dinero real.
