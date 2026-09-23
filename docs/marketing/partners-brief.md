# 🤝 TRENCHES (inusaur.online) — Brief para socios

> Documento de conversación — actualizado el **23 de septiembre de 2026**.
> Todo lo que sigue está **verificado en producción ese mismo día** — nada es promesa ni maqueta.

---

## Qué es

Un **terminal de trading y lanzamiento de tokens on-chain** (Solana + EVM), mobile-first, PWA instalable, **no custodial**: los usuarios operan desde sus propias wallets (Phantom/MetaMask) y la plataforma jamás toca sus claves. Monetiza con **0.3% por operación**.

---

## Lo que ya funciona en producción

| Componente | Estado verificado |
|---|---|
| **Web + API en la nube** | ✅ inusaur.online live, API `mode: live`, registro **abierto al público** |
| **Trading Solana** | ✅ Real vía Jupiter (agregador #1), self-custody |
| **Trading Ethereum + Base + BSC** | ✅ Real vía 0x/Li.Fi, **fee 0.3% ya cobrándose** en EVM |
| **Launchpad curvas reales** | ✅ Raydium LaunchLab on-chain, certificado con compras+ventas ejecutadas de verdad |
| **Factory de tokens** | ✅ Acuñación real Token-2022, oferta fija, autoridad revocada (nadie puede inflar) |
| **Post-graduación (AMM)** | ✅ Sesiones exactly-once con kill-switch, listo para activar |
| **Rewards on-chain** | ✅ Motor acumulando (cashback 10% + referidos 10%); el claim paga **USDC real** — falta solo fondear tesorería (~$30) |
| **Market data 5 cadenas** | ✅ Solana, ETH, Base, BSC y **Arc** — 20 pares reales cada una, LIVE |

---

## 🆕 Noticias del 23-sep (fuertes para la conversación)

1. **Datos de mercado de las 5 cadenas al 100%** — activamos la key de CoinGecko y murieron los cortes: las 5 cadenas responden 200 con precios reales.
2. **Arc (la L1 de Circle, gas en USDC) con rutas de swap reales vía Li.Fi** — verificado con quote ejecutable (tool `fly`, transactionRequest completo). Somos de los primeros terminales con datos de Arc; los swaps caen en cuanto se integre el ejecutor (días, no meses).
3. **Vigilancia automática** (`arc-route-watch.mjs`): sondea 0x y Li.Fi contra pools reales y avisa el día exacto que hay liquidez nueva aprovechable.

---

## El modelo económico

- Take rate **0.3%** sobre todo el volumen; rewards devuelven máx. 20% → **margen ~80%**.
- **Cero capital en riesgo**: la liquidez es de los usuarios (LaunchLab / pools on-chain). No hacemos market-making con fondos propios.
- Todos los parámetros (rates, topes, mínimos) se ajustan desde la base de datos **sin redeploy**.
- Coste fijo: **~$5/mes** (Fly) + free tiers. Coste único pendiente: **~0.2 SOL (~$30)** para tesorería.

---

## Lo que NO es (honestidad = ventaja)

- No hay usuarios con volumen aún → ingresos ≈ $0.
- **El reto es distribución, no tecnología** — eso ya está resuelto y auditado: **373+ tests automatizados**, sesiones *exactly-once* (imposible el doble gasto), reconciliación on-chain cada 15s, kill switches y estados honestos en la UI.

---

## Qué aporta cada socio

| Socio | Aporta |
|---|---|
| **Fundador técnico** | Producto, tecnología, seguridad, despliegues — todo construido |
| **Socio capital/distribución** | Capital de activación (mínimo, <$100 técnico) y sobre todo **distribución**: comunidad, marketing, traders |

**Estructuras posibles** (no es asesoría legal):
1. Sociedad (SL/LLC/Corp) con pacto de socios: vesting para ambos, multi-sig en la tesorería, gastos >$X decididos en conjunto.
2. Revenue share on-chain: splitter programable que reparte el 50% de los fees — transparente y verificable por ambos.

---

## Demo de 2 minutos para la reunión

Abrir **inusaur.online** en el móvil → buscar un token → mostrar precio live → explicar que cada swap genera fee para la caja común. El T-rex ayuda. 🦖

---

## Riesgos conocidos (decirlos antes de que pregunten)

- **Competencia** (Fomo y similares): tienen usuarios; nosotros infraestructura completa, fees activos y coste marginal cero. Gancho: 20% de cashback desde el día uno.
- **Regulatorio**: estructura societaria y jurisdicción a resolver antes de escalar.
- **Dependencia de terceros**: Jupiter, Raydium, 0x/Li.Fi — mitigado porque son protocolos establecidos y hay múltiples proveedores integrados.
- **Volatilidad cripto**: los fees llegan in-kind; se convierten a USDC con disciplina (conversión manual hoy, automatizable).
