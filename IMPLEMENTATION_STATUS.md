# TRENCHES — estado verificable

Actualizado: 2026-09-17 (tarde). Ejecución real self-custody activada en solana/ethereum/base: preparación de transacción sin firmar, firma en la wallet del usuario y liquidación solo con recibo on-chain verificado (deltas exactos de balances/logs). 239 tests app ×3 ejecuciones, 101 core, typecheck y build pasan. Ver `docs/audit/2026-09-17-self-custody.md`. Estados permitidos: No iniciada, En desarrollo, Implementada, Probada, Bloqueada, Lista para producción.

| Función | Estado | Evidencia / límite |
|---|---|---|
| Auditoría inicial | Probada | `docs/audit/2026-09-16-baseline.md`; baseline 184 app + 101 core; regresión actual 213 app |
| Bloqueo ejecución spot | Probada | Tests de capabilities y contabilidad; prepare/submit/execute live no operan |
| Bloqueo órdenes de predicción | Probada | Endpoint devuelve 503 en live y mock; no descifra ni transmite |
| Datos mercado / búsqueda por contrato | Probada | Tests adaptadores; lectura remota no garantiza cobertura universal |
| Catálogo persistente, importación y cursor | Probada | 251 activos, deduplicación, reinicio, HTTP e importación; cobertura limitada a pools observados |
| Worker incremental / reintentos | Probada | Checkpoints/leases/backoff con tests; proceso separado, no habilitado en producción; sin carga sostenida |
| Filtros independientes por columna | Probada | Rangos SQL, seis órdenes, URL, presets locales, virtualización; faltan filtros sin datos fiables |
| Terminal interna con contexto | Probada | Diálogo desktop/fullscreen móvil; E2E atrás/Escape/scroll/foco/URL; docking/minimización pendientes |
| Gráfico de pool | Probada | OHLCV real con tests; Lightweight Charts 4.1, tres agregaciones |
| Indicadores / dibujos / marcadores | No iniciada | Sin motor ni pruebas matemáticas |
| Tesis universales | En desarrollo | Feed admite posts; símbolo aún aceptado, sin drafts/versiones/privacidad |
| Cotización USDC | Probada | Jupiter (Solana) y 0x v2 (Ethereum/Base) en vivo; fallo del proveedor devuelve 503 sin fallback mock |
| Ejecución self-custody real | Implementada | Prepare/submit con sesión consumible una sola vez; propiedad de wallet exigida por identidad firmada; el API nunca ve claves privadas. Solana, Ethereum y Base |
| Trading real integral | En desarrollo | Spot self-custody operativo en 3 redes; sin fee de plataforma on-chain (fee=0), sin límites de exposición, sin runway de auditoría externa |
| Simulación y firma vinculada | Implementada | La UI solo habilita el botón con capacidad LIVE por red; ninguna firma se solicita en redes no habilitadas |
| Coste medio / fills idempotentes | Probada | Tests de ventas parciales, grandes enteros, rollback y separación de modo |
| Launchpad (curva simulada) | En desarrollo | Exploit de venta sin holdings corregido (launch_trades + transacción atómica); validación de creación; posición/cotización/actividad; UI con modales. Claims por wallet con firma verificada (launch_claims) + snapshot de distribución neta. **Factory on-chain v1 lista**: plan inspeccionable + dry-run + ejecución con kill switch y tesorería opcional (servidor keyless por defecto); acuña el SPL real (Token-2022, 0 decimales) a las wallets con claim firmado, revoca la autoridad de mint (oferta fija) y expone mintAddress/graduatedOnChain en la ficha. **AMM post-graduación listo**: pool no custodial (usuario firma primero, pool co-firma su lado tras verificación exacta), reservas leídas de la cadena en cada quote, fee 0.3%, minOut obligatorio; creación de pool solo admin y solo para lanzamientos graduados |
| LaunchLab on-chain (Raydium, real) | Implementada | Curva REAL en el programa LaunchLab (`LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj`): estado leído del RPC con decoders del SDK v2, quotes con la matemática exacta de la curva (`Curve.buyExactIn/sellExactIn`), buy/sell self-custody (sesiones durables exactly-once, hash del mensaje sin firmar como id, verificación byte a byte de la instrucción firmada contra el payload almacenado, minOut re-verificado en submit) y creación de token sin custodia (mint keypair generada y firmada en el navegador, servidor verifica createAccount+initializeV2+metadata y la firma del creator+mint; confirmación on-chain antes de registrar). Graduación a CPMM automática por el crank de Raydium. UI: sub-pestaña "🧪 LaunchLab on-chain" con ficha en vivo (progreso, precio, estado), quote con debounce, buy/sell vía Phantom y flujo de creación (presets SOL). 17 tests offline con encoders reales del SDK; 316 app en total |
| Reconciliación on-chain | En desarrollo | Reconciliador periódico en vivo (15 s) + inline al enviar; parser de fills Solana (deltas SPL) y EVM (logs Transfer) verificados; reorgs y casos límite pendientes |
| Balances exactos / transferencias | En desarrollo | RPC inválido ahora devuelve desconocido; float UI y Token-2022 siguen pendientes |
| Posiciones públicas consentidas | No iniciada | Sin controles completos de privacidad |
| Seguimiento persistido | En desarrollo | Tabla follows sin rutas; UI localStorage |
| Leaderboard profesional | En desarrollo | Fills y periodos; sin ROI/drawdown/antifraude/consentimiento |
| Perfil y wallet | En desarrollo | Perfil editable, scanner parcial; controles de custody UI pendientes |
| Mobile-first / accesibilidad | En desarrollo | Capturas 390×844 y 1440×1000, E2E terminal/filtros; resto de pantallas pendiente |
| Lint | No iniciada | No existe script/configuración; no se declara aprobado |
| E2E | En desarrollo | Recorrido local reproducible de filtros/terminal; faltan journeys de tesis/trading/portfolio/social |
| Observabilidad y carga | No iniciada | Logs básicos; sin métricas/alertas/presupuesto probado |
| Despliegue de catálogo/filtros/terminal | Probada | Autorizado por usuario; GitHub Pages 654c5fd y Fly deployment-01M2NCMAAWZTAHVYMQ6W44KZ85; smoke público desktop/móvil aprobado |
| Retirada Polygon/Arbitrum/Monad | Probada | Excluidas de capacidades, consultas de mercado y selectores; históricos conservados |
| Despliegue self-custody | Probada | Fly (máquina 84ed23ea636178) + gh-pages 4f13744; smoke público desktop/móvil aprobado; evidencia en docs/audit/2026-09-17-self-custody.md |

## Entrega por fase

| Función | Estado anterior | Cambios realizados | Archivos | Fuente de datos | Proveedor | Tests | Evidencia | Riesgos | Próximo paso |
|---|---|---|---|---|---|---|---|---|---|
| Fase 1: auditoría | Documentación contradictoria | Baseline fechado, mapa y plan | MASTER_PLAN.md, IMPLEMENTATION_STATUS.md, ARCHITECTURE.md, PROJECT_MEMORY.md, docs/audit/* | Código local, comandos ejecutados | Node/TypeScript/Vitest | 184 + 101; build/typecheck en 3 paquetes | Baseline JSON y markdown | Sin lint, sin E2E; no certificación live | Corregir hallazgos P0/P1 |
| Fase 2: seguridad inicial | Orden de predicción podía transmitir; fallos convertidos en cero | Bloqueo de órdenes, balances desconocidos, escape social, capabilities conservadoras | api/server.ts, wallets/balances.ts, site/js/{markets,portfolio,social}.js, tests de seguridad | RPC/configuración/BD | Adaptadores existentes | production-guards, balance-safety, social-safety | Endpoints 503 antes de firmar, errores sin saldo inventado | Otros hallazgos financieros pendientes | Fees/unidades/simulación |
| Fase 3: catálogo inicial | Muestra volátil con límites de UI | Persistencia, cursor, importación, jobs y refresh incremental | src/market/{catalog,indexer,routes,worker}.ts, app-db.ts, server.ts, package.json | Pools observados | DEX Screener / GeckoTerminal | 11 catálogo + 4 indexer + 2 API | 251 activos recorridos, reinicio de SQLite temporal, HTTP local | Sin certificación de millones de activos ni cobertura exhaustiva | Carga, cuotas distribuidas, prioridad social |
| Fase 4: columnas | Filtros sobre muestra en navegador | SQL por columna, rangos, URL, presets locales, scroll virtual y refresh multipágina | site/js/{catalog-board,trenches}.js, site/css/catalog.css, site/app.html | Catálogo SQL | API local | 3 tests de estado + E2E navegador | Filtro persistido tras reload; capturas desktop/móvil | Filtros holders/riesgo/social aún no disponibles; presets no sincronizados | Ampliar fuentes fiables |
| Fase 5: terminal inicial | Sidebar estrecho, navegación sin historial | Diálogo/fullscreen, URL contractual, atrás/Escape/foco, gráfico reutilizado, compositor visible | site/js/{terminal-view,app,trading,trenches}.js, site/app.html, catalog.css | Pool seleccionado / importación | API local y mercado | E2E reproducible | Scroll 224→224, foco restaurado, móvil 390×844; reload/forward | Sin docking/minimización/tabs móviles; tesis aún parciales | Terminal profesional y tesis versionadas |
