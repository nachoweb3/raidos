# Herramientas de gráfico — plan de implementación

**Objetivo:** primera ampliación verificable de fase 6: tipos de serie, indicadores y preferencias sobre OHLCV real.

**Arquitectura:** conservar Lightweight Charts 4.1 y la instancia existente. `chart-indicators.js` contiene cálculos puros; `chart-tools.js` gestiona series, panel RSI, controles y almacenamiento local. TradingEngine conserva adquisición con identificación red/contrato y descarta respuestas obsoletas. Sin dependencias nuevas, cambios de fondos ni promesas de indicadores propietarios.

**Decisión:** ampliar librería existente evita migración de API; Charting Library requeriría licencia/acceso no acreditados. Otra librería introduciría coste y riesgo innecesarios. Alcance inicial: SMA/EMA/Bollinger/RSI/volumen; MACD/VWAP/ATR/StochRSI/OBV y dibujos siguen pendientes.

**Metodología:** cierre para SMA/EMA, EMA sembrada con SMA inicial; Bollinger con desviación poblacional y multiplicador 2; RSI con promedio Wilder y período configurable (plano=50, solo ganancias=100, solo pérdidas=0). No rellenar warmup con cero. No inventar volumen para velas de referencia. Cálculos limitados al lote recibido (actualmente 100 velas); no es un pipeline para millones de puntos.

## Pasos

- [ ] Pruebas numéricas independientes, inputs inválidos, warmup y ausencia de volumen en `tests/chart-indicators.test.ts`.
- [ ] Implementar motor puro `site/js/chart-indicators.js`.
- [ ] Implementar controles/series/persistencia en `site/js/chart-tools.js`; estilos en catalog.css; integrar trading.js y HTML.
- [ ] Invalidar solicitudes y limpiar todas las series al cambiar token o fallar el proveedor. Pruebas de carrera en trading-ui-safety.
- [ ] Verificar typecheck, suite y build; navegador local desktop/móvil con datos reales. Actualizar versión de módulos.
- [ ] Publicar web dentro de la autorización vigente y verificar dominio público. Actualizar estado y límites.

Referencia de API: https://tradingview.github.io/lightweight-charts/docs/4.1/series-types . Conservar avisos de licencia/atribución de la librería. No activar intervalos que el backend aún no soporta (solo 1/5/15m).
