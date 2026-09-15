# Capa de datos de mercado — plan de implementación

Fecha: 2026-09-14. Arquitectura solicitada por el usuario; ejecución autónoma autorizada.

## Diseño

Un servicio `packages/app/src/market/data.ts` consulta hosts fijos de DEX Screener, GeckoTerminal y CoinGecko. No hay lista cerrada de contratos: identidad por cadena + dirección, conservando mayúsculas en Solana. DEX Screener resuelve búsqueda y lotes de hasta 30 contratos; GeckoTerminal aporta fallback por pools, pools nuevos/tendencias paginados y OHLCV del contrato elegido. CoinGecko se limita a referencias de activos conocidos. Sin datos, error explícito; caché vencida utilizable durante cinco minutos solo como DEGRADED, con asOf original.

Caché acotada de 500 entradas por proceso, coalescencia de requests simultáneos y presupuesto por proveedor. Esta instancia Fly usa un proceso: Redis y PostgreSQL quedan como evolución para múltiples instancias, sin migración destructiva ahora. Configuración de RPC mediante URLs de entorno para Helius/Alchemy; ninguna clave en frontend.

## Secuencia

1. Tests de contratos arbitrarios, cadenas, mayúsculas, concurrencia, fallback, límites, stale y OHLCV en `tests/market-data.test.ts`. Ejecutar `pnpm exec vitest run tests/market-data.test.ts` y comprobar el fallo previo.
2. Implementar servicio y rutas GET públicas `/api/market/search`, `/api/market/tokens/:chain/:addresses`, `/api/market/pools`, `/api/market/candles`. Validar límites, contratos y chain antes de llamar al proveedor. Respuestas incluyen fuente, estado y fecha de observación.
3. Conectar `site/js/dexfeed.js`, búsqueda universal y scanner al backend. Caché de activos por cadena/dirección. Pools nuevos y tendencias con datos reales; boosts no equivalen a tendencias orgánicas.
4. Eliminar velas sintéticas en `site/js/trading.js`. Usar pool/contrato para OHLCV y CoinGecko OHLC como referencia solo cuando corresponda.
5. Ejecutar tests, typecheck y build; comprobaciones HTTP con proveedores reales; desplegar backend Fly y frontend gh-pages de inusaur. Comprobar CORS y recursos publicados.
6. Actualizar MASTER_ROADMAP, PRODUCTION_CHECKLIST, ARCHITECTURE y memoria local con evidencia y bloqueadores.

## Límites explícitos

Cobertura de todos los contratos indexados por estos proveedores, no promesa de indexación universal ni de tiempo real por WebSocket. No convertir precios de mercado en evidencia de ejecución, saldo, PnL realizado o seguridad. Firmas y liquidación de fondos continúan bloqueadas hasta certificación end-to-end.
