<p align="center">
  <img src="docs/assets/raidos-banner.png" alt="RaidOS — The Operating System for Web3 Communities" width="100%">
</p>

<h1 align="center">RaidOS</h1>

<p align="center">
  <strong>El sistema operativo para comunidades Web3.</strong><br>
  Nativo de Telegram · Auto-alojado · Privacidad primero · IA vía Ollama<br>
  <a href="README.md">🇬🇧 English</a> · <a href="README.es.md">🇪🇸 Español</a> · <a href="https://inusaur.online">🌐 Web oficial</a>
</p>

---

RaidOS no es "otro bot de raids para Telegram". Es un sistema operativo completo
para comunidades de tokens, construido sobre cinco capas que se alimentan entre sí:

| Capa | Módulo | Qué hace |
|---|---|---|
| 🧠 **Inteligencia** | Community Brain | Lee el grupo (localmente, en privado), agrupa preguntas recurrentes, responde a los miembros solo con info oficial, informa a los admins |
| 📊 **Mercado** | Volume Intelligence | Convierte la actividad on-chain real en tarjetas legibles y alertas — nunca inventadas |
| ⚡ **Activación** | Raid Engine | Coordina engagement real y medible de la comunidad con seguimiento honesto y auto-declarado |
| 🎮 **Retención** | XP · Misiones · Insignias | Premia la contribución genuina con XP, niveles, rachas, misiones e insignias |
| 🔥 **Descubrimiento** | Trending *(planificado)* | Ranura lo que gana momentum real, orgánico vs. patrocinado |

Todo alimenta a la capa de inteligencia — el bucle del producto:

```
COMUNIDAD → CONVERSACIÓN → BRAIN → INTELIGENCIA → CONTENIDO / RAID
    ↑                                                    ↓
  PRÓXIMA ACCIÓN ← ACTIVIDAD DE MERCADO ← VOLUME ← ENGAGEMENT
```

> **Reglas de honestidad integradas en el código:** la participación siempre se
> etiqueta **SELF-REPORTED** (auto-declarada), las alertas solo se disparan con
> datos reales, nunca se afirma una causa sin datos que la respalden, y no hay
> usuarios falsos ni volumen falso — nunca.

---

## 📦 Instalación

### Requisitos

- **Node.js 22+** — [nodejs.org](https://nodejs.org)
- **Backend de IA — elige uno:**
  - **Ollama (local, por defecto)** — [ollama.com](https://ollama.com); toda la IA corre en tu máquina
  - **Cualquier API compatible con OpenAI** (OpenAI, Groq, OpenRouter, DeepSeek…) — sin modelos locales
- Un **token de bot de Telegram** de [@BotFather](https://t.me/BotFather)

### 1. Instala Ollama y descarga los modelos

```bash
# Linux / macOS
curl -fsSL https://ollama.com/install.sh | sh

# Windows: descarga el instalador de ollama.com, luego:
ollama pull llama3.2:3b      # modelo de chat (~2 GB)
ollama pull nomic-embed-text # modelo de embeddings (~274 MB)
```

### 2. Crea tu bot

Habla con [@BotFather](https://t.me/BotFather) en Telegram → `/newbot` → copia
el token. Consigue también tu ID numérica de Telegram (por ejemplo con
@userinfobot) — esa será la del dueño del bot.

### 3. Configura

```bash
cd packages/core
cp .env.example .env
```

Edita `.env`:

```ini
BOT_TOKEN=123456:ABC-DEF...          # de @BotFather
OWNER_ID=123456789                   # tu ID numérica de Telegram
# GROUP_ID=-1001234567890            # opcional: fija el bot a un solo grupo
OLLAMA_BASE_URL=http://127.0.0.1:11434
CHAT_MODEL=llama3.2:3b
EMBED_MODEL=nomic-embed-text
DB_PATH=./brain.db                   # SQLite, se crea automáticamente
```

**¿Alojas para otros / sin modelos locales?** Cambia a IA en la nube en vez de Ollama:

```ini
AI_MODE=cloud
OPENAI_BASE_URL=https://api.openai.com/v1   # o Groq / OpenRouter / DeepSeek
OPENAI_API_KEY=sk-...
CHAT_MODEL=gpt-4o-mini
EMBED_MODEL=text-embedding-3-small
```

> ¿Cambiaste el backend de IA en una comunidad existente? Ejecuta **`/reembed`**
> en ese chat una vez, para reconstruir los vectores de la base de conocimiento.

### 4. Ejecuta

```bash
npm install
npm run build
npm start
```

Deberías ver:

```
🧠 Community Brain online as @yourbot
   AI: ollama:llama3.2:3b (embed: nomic-embed-text) · mode=local
```

Añade el bot a tu grupo y ejecuta **`/setup`** para activarlo.

### Ejecutarlo para siempre (opcional)

En un servidor, mantenlo vivo con pm2:

```bash
npm i -g pm2
pm2 start "node dist/index.js" --name raidos
pm2 save
```

---

## 🕹 Uso

### Tus primeros 5 minutos

| Paso | Comando |
|---|---|
| 1. Añade el bot al grupo y ejecuta | `/setup` |
| 2. Enséñale las respuestas oficiales | `/learn El lanzamiento fue a las 12:00 UTC.` |
| 3. Deja que los miembros pregunten | `/ask cuando fue el lanzamiento?` |
| 4. Mira lo que la comunidad pregunta | `/brain` |

Ese es el bucle central: **el bot escucha, aprende tus respuestas oficiales y
responde la misma pregunta antes de que la respondas 50 veces.**

### 🧠 Comandos de inteligencia

| Comando | Quién | Qué |
|---|---|---|
| `/ask <pregunta>` | todos | Responde solo desde la base de conocimiento — si no sabe, lo dice. Nunca inventa. |
| `/learn <dato>` | admin | Añade un dato oficial a la base de conocimiento |
| `/kb` · `/kbdel <n>` | admin | Listar / eliminar entradas de conocimiento |
| Fijar un mensaje | admin | Los mensajes fijados se guardan automáticamente en la base de conocimiento |
| `/memory` | admin | Qué ha capturado el cerebro recientemente |
| `/brain` | admin | Informe completo: memoria, estadísticas, acciones recomendadas por IA |
| `/stats` | admin | Números de actividad |
| `/config` | admin | Activar/desactivar el cerebro / alertas por chat |

> **Privacidad:** en modo local el texto de los mensajes nunca sale de la
> máquina (Ollama corre localmente) y los mensajes se purgan tras
> `retentionDays`. En modo nube, los prompts van al proveedor de IA que
> configures.

### 🎮 Comandos de retención

| Comando | Quién | Qué |
|---|---|---|
| `/rank` | todos | Tu nivel, XP, racha e insignias |
| `/top` | todos | Leaderboard de la comunidad |
| `/badges` | todos | Tus insignias (se otorgan automáticamente por hitos) |
| `/quests` | todos | Misiones activas y tu progreso |
| `/quest add <nombre> \| <tipo> \| <meta> \| <XP>` | admin | Crear misión — tipos: `messages`, `reactions`, `invites`, `meme_submissions`, `poll_votes`, `raids` |

Ejemplo: `/quest add Constructor | invites | 3 | 500` → quien invite 3 miembros
la completa y gana 500 XP.

### ⚡ Raid Engine

Los raids convierten la atención de la comunidad en engagement real, organizado
y medible. Los miembros se unen, hacen las acciones manualmente y reportan cada
una — todo etiquetado **SELF-REPORTED** porque el bot nunca afirma que una
plataforma lo verificó.

```text
/raid create Lanzamiento SAUR | x | https://x.com/proyecto/status/123 | 30m | 500 | 100
/raid join 1        ← los miembros se unen
/raid in 1          ← ...haz una acción en X y reporta (hay cooldown)
/raid score 1       ← en vivo: participantes, acciones, completitud, velocidad
/raid end 1         ← cierra + informe completo
/raid top           ← leaderboard de raiders
/raid list          ← raids activos
```

Anti-abuso integrado: cooldown entre reportes, tope de acciones por raid, XP
decreciente por acción extra, tope diario de XP de raids, tope de participantes.

### 📊 Volume Intelligence

Trackea tu token y convierte la actividad de mercado en inteligencia legible:

```text
/volume set <dirección del token> SAUR dexscreener   ← admin: empieza a trackear
/volume                                              ← tarjeta de mercado completa
/volume alerts                                       ← admin: alertas automáticas on/off
```

Con las alertas activadas, un poller en segundo plano (5 min) dispara alertas
por umbrales: 🔥 pico de volumen · 📈 ruptura · 📉 caída · 💧 cambio de
liquidez · 🚨 drenaje. Los proveedores son enchufables (interfaz
`MarketDataProvider`): DexScreener viene sin API key, se pueden añadir más
cadenas/proveedores sin tocar la app.

### 😹 Concursos de memes

```text
/meme open Meme Friday 24h     ← admin abre submissions
/meme submit <texto o link>    ← los miembros participan
/meme voting                   ← admin cierra submissions, abre votación
/meme vote 7                   ← los miembros votan
/meme finish                   ← admin corona al ganador (+XP)
/meme list                     ← concurso actual y puntuaciones
```

---

## 💰 ¿Cómo se monetiza RaidOS?

1. **Setups llave en mano** — $300–$1,000 por instalación, una sola vez
2. **Hosting administrado** — $49–$299/mes por comunidad
3. **Trending patrocinado** — colocaciones de pago siempre etiquetadas `SPONSORED`

¿Interesado? Escríbenos por Instagram o X — detalles en la
[web oficial](https://inusaur.online).

## 🗂 Estructura del repositorio

```
packages/core/            Núcleo de RaidOS (bot de Telegram + inteligencia)
├── src/
│   ├── index.ts          Cableado del bot: comandos, listeners, jobs de fondo
│   ├── database/db.ts    SQLite (better-sqlite3): 17 tablas, multi-tenant por chat_id
│   ├── modules/          Lógica: kb, analyzer, xp, quests, badges, memes, raids…
│   ├── market/           Volume Intelligence: proveedores (DexScreener, mock), alertas
│   ├── ai/               Proveedores: Ollama (local), nube (compatible OpenAI), mock
│   └── config.panel.ts   Panel de /config
├── tests/                63 tests unitarios + de integración (vitest)
└── .env.example
site/                     Landing page (precios y posicionamiento)
docs/
├── assets/               Banner y assets de marca
├── sales/                Kit de ventas y outreach
└── superpowers/          Especificaciones de diseño
```

La base de datos auto-migra: las tablas nuevas se añaden junto a los datos
existentes al arrancar, así que actualizar nunca pierde el historial de tu
comunidad.

## 🧪 Desarrollo

```bash
cd packages/core
npm run dev        # compilar + correr localmente
npm test           # 63 tests
npm run typecheck  # TypeScript estricto
```

## 🗺 Roadmap

- **Trending engine** — ranurar tokens/temas por señales reales y medibles; los espacios patrocinados siempre etiquetados `SPONSORED`
- **Analítica de raids** — informes post-raid + insights del Community Brain
- **Alertas de momentum unificadas** — mercado + señales sociales en una sola alerta basada en datos
- **Dashboard web** — comunidad, token, raids, trending y gamificación en un centro de mando
- **Más cadenas y proveedores** — Birdeye, GeckoTerminal, RPC configurable tras la misma interfaz

## ❓ FAQ

**¿Esto genera volumen falso o spam?**
No. Por diseño. Detecta y amplifica actividad real, y cada número de engagement
que muestra está medido o etiquetado explícitamente `SELF-REPORTED`.

**¿Los datos de mi comunidad salen de mi servidor?**
En modo local, no. En modo nube, los prompts van al proveedor de IA que
configures — elige un proveedor de confianza o quédate en Ollama.

**¿Puedo usarlo sin las funciones de mercado?**
Sí — todo funciona de fábrica excepto `/volume`. Configura tu token cuando
quieras.

## 👤 Creador

RaidOS es construido y mantenido por **@nacho_web3**.

| Plataforma | Handle |
|---|---|
| 📸 Instagram | [@nacho_web3](https://instagram.com/nacho_web3) |
| 🐦 X (Twitter) | [@nacho_web3_](https://x.com/nacho_web3_) |
| ▶️ YouTube | [@nacho_web3](https://youtube.com/@nacho_web3) |
