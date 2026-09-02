<p align="center"><img src="../../docs/assets/raidos-banner.png" alt="RaidOS" width="640"></p>

# RaidOS · core

**This package is the RaidOS engine** — see the [root README](../../README.md)
for the full product tour, installation and usage guide.

Telegram is the interface, Community Brain is the intelligence, Volume
Intelligence is the market layer, the Raid Engine is the activation layer,
XP/quests/badges are the retention layer.

A Telegram bot that gives any community memory, intelligence and automation.
It reads the group's conversation (locally, privately), detects recurring
questions, answers members from official info only, and briefs admins on what
the community needs — before anyone asks twice.

## Features (V1)

| Feature | What it does |
|---|---|
| 🧠 **Community Memory** | Clusters repeated questions, ranks what the community keeps asking |
| 🙋 **/ask** | Answers members using official info only — or says it doesn't know. Never invents. |
| ⚠️ **Confusion alerts** | When a question bursts (default 5× in 48h), admins get an alert + suggested action |
| 💓 **Community Pulse** | Weekly health report: activity, questions asked vs. answered, one AI narrative line |
| 📋 **/brain** | Admin briefing: memory + stats + AI-recommended actions |
| 📚 **Knowledge base** | `/learn` curated facts + auto-captured pinned messages and admin announcements |
| ⭐ **XP & levels** | Contribution is rewarded — questions pay more, streaks keep it daily |
| 🎯 **Quests** | Admin-created missions (“send 5 messages”, “invite 2 members”…) with XP rewards |
| 🏆 **Leaderboard** | `/top` rankings with level titles, `/rank` for personal stats |
| 😹 **Meme contests** | Submissions → community voting → crowned winner, community-driven |

## Features (RaidOS layer)

| Feature | What it does |
|---|---|
| 📊 **Volume Intelligence** | `/volume` market card (price, volume, liquidity, buys/sells, trend) via pluggable providers (DexScreener keyless, mock for tests) |
| 🔔 **Market alerts** | Background poller fires volume-spike, price breakout/drop and liquidity-change/drain alerts with configurable thresholds — data-driven, never fabricated |
| ⚡ **Raid Engine** | Admin-created engagement raids (`/raid create`) with objective, duration, platform and XP; participation is clearly labeled **SELF-REPORTED** |
| 🛡️ **Anti-abuse** | Check-in cooldowns, per-raid caps, diminishing XP returns, daily raid-XP cap, participant caps |
| 🏆 **Raid leaderboards** | `/raid top` (raids, actions, XP), `/raid score` live engagement velocity + completion, quest integration (`raids` kind) |
| 🏅 **Badges** | Milestone badges auto-awarded as members level up (`/badges`), plus admin honors (`/badge grant`) |

## Privacy first

All AI runs locally through [Ollama](https://ollama.com). **Message text never
leaves the host machine.** Message bodies are also purged after `retentionDays`
(default 14) — only aggregates and clusters survive.

## Quick start

```bash
# 1) Install Ollama and pull the models (one small, one tiny):
ollama pull llama3.2:3b
ollama pull nomic-embed-text

# 2) Create the bot with @BotFather, then:
cp .env.example .env   # fill BOT_TOKEN and OWNER_ID

# 3) Run:
npm install
npm run dev            # or: npm run build && npm start
```

Then, in your community group:

1. Add the bot as a member (admin is best — it can then read all messages).
2. `/setup` — activates the brain and verifies capture works.
3. `/learn The official website is ...` — feed it official info.
4. `/config` — tune thresholds, pulse schedule, retention.

## Commands

**Members:** `/ask <question>` · `/memory` · `/rank` · `/top` · `/quests` ·
`/meme` · `/badges` · `/volume` · `/raid` · `/start`

**Admins:** `/setup` · `/config` · `/learn <text>` · `/kb` · `/kbdel <id>` ·
`/brain` · `/stats` · `/quest add <name>|<kind>|<target>|<xp> [hours]` ·
`/meme open <title> [hours]` · `/meme voting` · `/meme finish` ·
`/volume set <address> [symbol] [provider]` · `/volume alerts` ·
`/raid create <title>|<platform>|<url>|<30m\|2h>|<objective>|<XP> [max]` · `/raid end [id]` ·
`/badge grant <code>`

Each group earns XP once `/setup` activates the brain: questions pay 3 XP,
regular messages 2 XP, votes, raids and quest rewards add more — capped daily,
with same-day streaks tracked per chat.

## How it works

```
Telegram → grammY
   ├─ capture: every group text → SQLite (pure insert, no AI on the hot path)
   ├─ analyzer (every 15 min): embed new questions (nomic-embed-text, ~50ms),
   │    cluster by cosine similarity, label bursting clusters (chat model)
   ├─ /ask: embed → retrieve top KB chunks → grounded answer (chat model)
   └─ pulse / brain: deterministic SQL metrics + one narrative LLM call
```

Architecture decisions (batch analysis, embeddings for clustering, chat_id
tenancy) are documented in `docs/superpowers/specs/2026-09-02-community-brain-design.md`.

## Tests

```bash
npm test    # 57 tests: unit (clustering, cosine, heuristics, XP, quests, raids, market) + integration (mocked AI)
```

## Roadmap

Trending engine (organic vs. sponsored), post-raid reports & brain insights,
unified market+social momentum alerts, web dashboard, content engine ("you
should post this"), onboarding autopilot, scam/impersonation detection, meme
image generation and template rendering.

---

Created by **@nacho_web3** — [Instagram](https://instagram.com/nacho_web3) · [X](https://x.com/nacho_web3_) · [YouTube](https://youtube.com/@nacho_web3)
