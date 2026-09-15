# Trenches: arquitectura real

Estado de esta entrega: mercado público integrado; ejecución con dinero real deshabilitada. Las capacidades se publican en `GET /api/chains`. Tener un proveedor de precios o una cotización no acredita una ejecución.

## Repositorios y despliegue

- Código: `C:/Users/Usuario/Desktop/trenches`, repositorio `nachoweb3/raidos`.
- Web: `site/`, módulos ES y CSS, publicada en GitHub Pages `nachoweb3/inusaur`, rama `gh-pages`, dominio `inusaur.online`.
- Copia de publicación: `C:/Users/Usuario/Desktop/trenches-deploy`. Conservar `CNAME` y `.nojekyll`.
- API: Node 22 + TypeScript, `packages/app`, Fly.io `raidos-api`.
- Persistencia: SQLite sobre volumen Fly `raidos_data`, `/data/raidos.db`.
- Caché de mercado: memoria del proceso, compartida entre clientes. No hay Redis/PostgreSQL/Timescale instalados en esta entrega.

## Mercado

`MarketDataService` fija los hosts externos y valida/escapa parámetros. No acepta URLs arbitrarias ni claves desde el navegador.

| API pública | Función |
| --- | --- |
| /api/market/search?q=...&chain=... | Búsqueda arbitraria de contratos o texto; DEX Screener, respaldo GeckoTerminal |
| /api/market/tokens/:chain/:addresses | Lotes de hasta 30 contratos; el cliente procesa todos los lotes |
| /api/market/pools?kind=new\|trending&page=1&chain=all | Pools de GeckoTerminal, páginas 1–10 |
| /api/market/candles?chain=...&pool=...&token=...&aggregate=5 | OHLCV real de pool; intervalos 1/5/15 minutos |
| /api/market/reference?ids=solana,ethereum | Referencia CoinGecko, hasta 30 IDs |
| /api/market/reference-candles?coin=solana | OHLC de referencia CoinGecko |

Cada respuesta tiene `source`, `status`, `asOf` y `cacheAgeMs`. Caché: 30 s para búsquedas/lotes, 60 s para pools/velas y 300 s para referencias. Solicitudes simultáneas idénticas comparten trabajo. Máximo 500 entradas; timeout 8 s; presupuestos internos conservadores por minuto: DEX 240, Gecko 10, CoinGecko 8. No son una afirmación de los planes comerciales actuales. Datos antiguos de hasta 5 minutos se identifican como DEGRADED; sin datos utilizables se responde UNAVAILABLE. La caché se pierde al reiniciar y los presupuestos son por proceso.

Discover y Trenches usan pools reales, no un catálogo fijo ni boosts como universo. La identidad es cadena + contrato; EVM ignora checksum de mayúsculas, Solana conserva mayúsculas. La búsqueda no promete enumerar todos los tokens existentes: depende de la indexación del proveedor. Tokens sin pool/historial muestran ausencia de datos; nunca se generan velas.

## Verdad de cadena y contabilidad

Los datos de mercado no crean balances, fills ni PnL. El camino contable es intención → transacción → fill liquidado → posición/PnL/feed/rewards. La liquidación y efectos contables se realizan de forma atómica e idempotente en SQLite.

PnL y volumen se agregan en el servidor desde fills liquidados. Cantidades de activos permanecen en unidades base; contabilidad USDC usa micro-USDC con conversión explícita para cadenas de 18 decimales. Cada venta realiza únicamente su delta de PnL. Compras no cuentan como victorias. Los rankings filtran modo, cadena y período.

La migración etiqueta posiciones previas como `legacy`: conserva los datos y evita mezclarlos con contabilidad live/mock. Su reconstrucción requiere recibos verificables; no se borran ni se presentan como saldo verificado.

El adaptador de recibos conserva pendientes ante problemas de RPC. No existe todavía una certificación completa del firmante, transacción, min-out, confirmaciones y reorganizaciones. Por eso preparar/enviar/ejecutar live y las mutaciones financieras simuladas están deshabilitados. Un hash o recibo confirmado sin fill no basta para contabilizar una operación.

## RPC y autenticación

Se puede configurar `SOLANA_RPC_URL`, `BASE_RPC_URL`, `ETHEREUM_RPC_URL`, etc. Alternativas: `HELIUS_RPC_URL` para Solana y `ALCHEMY_BASE_RPC_URL`, `ALCHEMY_ETHEREUM_RPC_URL`, etc. Son URLs HTTPS completas en secretos del servidor; no se devuelven al navegador. Sin configuración permanece el RPC existente, cuya red debe verificarse antes de habilitar operaciones. Monad/Arc conservan configuraciones de testnet y no deben anunciarse como ejecución mainnet.

El login exige que nonce, mensaje exacto, cadena, firma y caducidad correspondan al desafío emitido. Las claves API se almacenan como hash. CORS se limita a los dominios declarados en Fly; el navegador solo envía credenciales al backend conocido.

## Referencias oficiales

[DEX Screener](https://docs.dexscreener.com/api/reference), [GeckoTerminal](https://api.geckoterminal.com/docs/index.html), [CoinGecko OHLC](https://docs.coingecko.com/reference/coins-id-ohlc), [Helius RPC](https://www.helius.dev/docs/api-reference/endpoints), [Alchemy](https://www.alchemy.com/docs/get-started).
