# TRENCHES — plan maestro

Fecha: 2026-09-16. Documento rector de esta evolución. No certifica producción.

## Estado y decisiones

La aplicación es una terminal de consulta con dominio contable parcialmente probado. La ejecución spot está bloqueada. Tener pools, una cotización o un parser de recibos no demuestra trading completo. La auditoría de esta sesión está en `docs/audit/2026-09-16-baseline.md`; el estado por función está en `IMPLEMENTATION_STATUS.md`. Los planes y auditorías anteriores son históricos, y sus cifras no sustituyen esta línea base.

Se conserva el trabajo local previo en 11 archivos y las especificaciones de self-custody. No se borran datos, documentos históricos ni módulos para simplificar la entrega. La memoria del proyecto se conserva en `PROJECT_MEMORY.md`.

## Arquitectura actual y objetivo

Inicial: frontend ES modules estático; API Node HTTP/TypeScript; SQLite WAL; proveedores públicos con caché en memoria; módulos independientes de comunidad y bot. No existía catálogo persistente ni worker de descubrimiento. La web dependía de muestras paginadas que se perdían al refrescar.

Actual local: catálogo SQLite de activos/pools, cursor y filtros SQL, importación, worker separado con leases/checkpoints/backoff; tres columnas virtualizadas con filtros/presets y estado en URL. Terminal en diálogo adaptable con historial y restauración de contexto. Evidencia y límites en `docs/audit/2026-09-16-progress.md`. No desplegado.

Objetivo incremental: catálogo de activos y pools con clave `(chain, address)`, metadatos y timestamps; lecturas SQL con filtros y cursor; cola persistente con lease, backoff y checkpoints; importación por contrato; UI paginada con filtros por columna y contexto navegable; terminal interna adaptable; tesis persistidas; contabilidad basada exclusivamente en fills verificados. Mantener SQLite para una instancia, medir antes de migrar a PostgreSQL y una cola distribuida. No prometer millones de activos con el despliegue actual.

Alternativas evaluadas: aumentar `limit` no crea un índice y agrava memoria/cuotas; migrar ahora toda la infraestructura añade riesgo y requiere aprobación externa; ampliar aditivamente el backend actual permite verificar cada contrato y preparar la migración. Se elige la tercera opción.

## Fases y aceptación

| Fase | Entrega | Criterio verificable / dependencia |
|---|---|---|
| 1 | Auditoría y baseline | Mapa de módulos, fallos, comandos y resultados antes de editar código |
| 2 | Veracidad y seguridad | Ningún endpoint demo transmite órdenes; fallos no se convierten en balances/precios; HTML externo escapado |
| 3 | Catálogo e ingestión | Más de 100 activos persistentes, deduplicación, reinicio, importación exacta, paginación sin duplicados, backoff; cobertura del proveedor explícita |
| 4 | Tres columnas | Filtros SQL independientes, presets locales, URL/restauración, estados de error, carga acotada |
| 5 | Navegación adaptable | Modal amplio/escritorio y pantalla móvil; atrás/Escape/foco/scroll/contexto verificados |
| 6 | Terminal y gráficos | OHLCV de pool, preferencias, indicadores probados matemáticamente; funcionalidades no disponibles desactivadas |
| 7 | Tesis universales | Identidad contractual, drafts/edición/versiones/permisos; snapshot de publicación y metodología |
| 8 | Cotización y simulación | Proveedores y decimales certificados, timeout/expiry/min-out/ruta; evidencia externa de solo lectura |
| 9 | Ejecución | Firma explícita no custodial, envío autorizado, confirmación y fill; bloqueada hasta autorización para dinero real |
| 10 | Posiciones | Coste medio, fees, transferencias diferenciadas y reconciliación; no confundir saldo con PnL |
| 11 | Social | Privado por defecto; consentimiento, seguimiento persistido, operaciones auditables y marcadores |
| 12 | Ranking | Fills verificados, metodología, filtros/periodos, podio, controles antifraude |
| 13 | Perfil y wallet | Sesiones, privacidad, saldos exactos y gráficos basados en series disponibles |
| 14 | UX móvil/escritorio | QA a 390 y 1440 px, teclado/foco/safe areas y recorridos completos |
| 15 | Operación | Lint, E2E, carga, métricas, alertas, backups restaurados y runbook |

## Próximas tareas concretas

- [x] Ejecutar baseline app/core/bot y revisar arquitectura, datos, trading, frontend y despliegue.
- [x] Reproducir con tests el bypass de predicciones y degradación financiera; corregir antes de ampliar capacidades.
- [x] Crear `packages/app/src/market/catalog.ts` con migraciones aditivas y consultas parametrizadas; probar 251 activos, chains homónimas, valores ausentes y cursores.
- [x] Crear `packages/app/src/market/indexer.ts` y worker: checkpoints durables, trabajo limitado, reintentos y exclusión mutua; no enviar transacciones.
- [x] Integrar `/api/market/catalog`, importación y estadísticas sin romper endpoints actuales.
- [x] Conectar columnas a catálogo y filtros reales; añadir navegación interna y pruebas de estados.
- [ ] Ejecutar `pnpm test`, `pnpm run typecheck`, `pnpm run lint`, `pnpm run build`; documentar qué comandos existen y qué prueban.
- [x] Verificar juntos API y frontend en móvil/escritorio y guardar evidencia reproducible.
- [ ] Ampliar pruebas de carga/cuotas/cursores con precios cambiantes y observabilidad de workers antes de habilitar servicio continuo.
- [ ] Completar gráficos, tesis contractuales/versionadas y simulación: fases 6–8. No desbloquear ejecución por tener una cotización.

## Riesgos y límites

Cuotas y cobertura de APIs públicas no equivalen a indexación exhaustiva blockchain. No inventar cursores upstream si el proveedor solo usa páginas. Usar cursor real sobre el catálogo y checkpoints de página sobre esa fuente. Los valores de mercado son estimaciones del proveedor, nunca cantidades aptas para firmar. Los decimales desconocidos siguen siendo desconocidos. Las redes sin adaptador certificado permanecen de consulta. La migración del catálogo no reconstruye posiciones ni altera wallets.

El parser Solana actual no certifica firmante, instrucciones, min-out, reorgs ni account creation; EVM no extrae fills. Los controles antifraude del ranking y la reconciliación de transferencias están pendientes. No habilitar dinero real para demostrar la interfaz.

## Proveedores y variables

`APP_MODE`, `DB_PATH`, `PORT`, `SITE_DIR`, `ALLOWED_ORIGINS`, `BOOTSTRAP_SECRET`, `ADMIN_SECRET`; `JUPITER_API_KEY`, `ZERO_X_API_KEY`; `<CHAIN>_RPC_URL`, `HELIUS_RPC_URL`, `ALCHEMY_<CHAIN>_RPC_URL`. OAuth opcional: `GOOGLE_CLIENT_ID`, `X_CLIENT_ID`, `X_CLIENT_SECRET`. Acceso beta: `ACCESS_CODES`. El API no carga dotenv automáticamente: inyectar entorno o usar Node `--env-file`. No leer ni registrar valores secretos como evidencia.

DEX Screener/GeckoTerminal cubren descubrimiento; CoinGecko referencias; RugCheck/GoPlus señales de riesgo, sin garantía de seguridad. Comprobar planes, límites y disponibilidad antes de comprometer cobertura o SLA.

## Migración y operación

Cambios locales aditivos y compatibles; endpoints existentes conservados. Nuevas tablas con `IF NOT EXISTS`, índices por identidad/filtros/trabajo pendiente y schema version explícita. Probar reinicios sobre base temporal. El despliegue, snapshots externos y migraciones de producción requieren aprobación final sobre el diff y evidencia; no se realizan en esta sesión sin ella. No usar la base de producción en pruebas.
