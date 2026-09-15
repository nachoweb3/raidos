# Checklist de producción

## Verificado antes del despliegue

- [x] Compilación TypeScript y pruebas de app; resultados finales registrados abajo.
- [x] Consultas reales de pools nuevos/trending y contratos Solana/Ethereum.
- [x] Velas reales GeckoTerminal para EAGLEF; no se usan velas inventadas.
- [x] Snapshot del volumen Fly antes de la migración: `vs_Xly3q89zxjohxeXxAlL`, volumen `vol_4y8xg0oglyzxp69r`.
- [x] Posiciones anteriores conservadas como legacy; contabilidad separada por modo.
- [x] Firma de login vinculada a nonce y mensaje exacto.
- [x] CORS configurado para inusaur.online; credenciales fuera del frontend.
- [x] Contexto Docker excluye secretos, bases de datos y artefactos.
- [x] Despliegue Fly y GitHub Pages verificado públicamente.
- [x] Revisión final móvil/escritorio en el dominio público.

## Requisitos para habilitar dinero real

- [ ] Firmas, transacciones y fills vinculados durablemente a wallet autenticada e intención.
- [ ] Simulación, min-out, caducidad, comisiones y balance exactos.
- [ ] Recibos Solana/EVM, reorganizaciones, reinicios, RPC duplicado y fallos parciales probados.
- [ ] Workers/reconciliación continua y métricas de pendientes.
- [ ] Indexación completa y decimales verificados para PnL no realizado y transferencias.
- [ ] Validar red y contratos de cada cadena; configuraciones testnet no cuentan como mainnet.
- [ ] Instalar y verificar credenciales Helius/Alchemy/Jupiter donde correspondan.
- [ ] Antifraude y auditoría de seguridad independiente.
- [ ] Restauración de backups y pruebas de carga.
- [ ] Claims/rebates/copy/launches con ejecución on-chain verificable.

Mantener ejecución en UNAVAILABLE hasta cumplir las comprobaciones. No enviar fondos para validar la interfaz.

## Comandos

Desde `packages/app`: `pnpm test`, `pnpm run typecheck`, `pnpm run build`.

API local con una base temporal separada. Publicación API: `flyctl deploy --app raidos-api --remote-only`. Publicación web: copiar únicamente `site/` a la rama gh-pages de `nachoweb3/inusaur`, conservando CNAME y .nojekyll. Verificar HTTP 200, endpoints, CORS y hashes de los ficheros.

Rollback: imagen previa de Fly `raidos-api:deployment-01M223804R7DNFSR0K739ZVACD`; frontend previo `3df2b00`. La imagen anterior tenía funciones financieras no certificadas; revisar antes de restaurar acceso. La migración es aditiva y los datos legacy están conservados. Usar la copia del volumen para una recuperación controlada si fuera necesario.

## Resultado de publicación

2026-09-15:

- Fly v22, imagen `raidos-api:deployment-01M2HJQPNTH9YYNV7BSAK4BBCN`; smoke y machine checks correctos.
- GitHub Pages commit `aadf03c028242d771bffbb9d6d1c7e1eba671cfc`; workflow `34926356518` completado con success.
- HTTP 200 y contenido coincidente con los ficheros locales: index.html, app.html, js/dexfeed.js, js/trading.js.
- API health/chains/pools/search: HTTP 200; CORS admite https://inusaur.online.
- Navegador público: PEPE/Ethereum resuelve el contrato exacto y OHLC GeckoTerminal; ejecución disabled.
- Móvil 390 px: scrollWidth 390 y buscador visible; escritorio 1440 px sin desbordamiento horizontal.
- Pruebas app: 175; typecheck y build correctos. Core sin modificaciones: 101 pruebas correctas en la comprobación inicial.
- Evidencia local en output/playwright/. Algunos análisis RugCheck individuales fallan por CORS del proveedor: se muestran sin evaluación, no como seguros. Pendiente mover estos chequeos a una caché de servidor.

