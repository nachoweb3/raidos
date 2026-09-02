# 💬 RaidOS — Outreach & Pitch Kit

Working scripts for selling **Launch Setup ($300–$1,000)** and **Managed Hosting ($49–$299/mo)**.
Personalize the `[brackets]` — never send a raw template. Creator handle: **@nacho_web3**.

---

## The 2-minute demo (your edge)

Before any pitch, have `@inusaurai_bot` live in a demo group:

1. `/learn The official website is https://... and fair launch was [date].`
2. From a second account: `/ask when was fair launch?` → bot answers from official info only.
3. `/volume` → live market card for the token.
4. `/rank` and `/badges` → show XP, levels, streaks.
5. `/raid list` → show an active raid with progress.

Screen-record this once — that clip **is** your pitch.

---

## DM templates — English

### Pump.fun / fresh launcher

> Hey — saw you're launching [TOKEN]. The first 48h your group gets the same 20 questions ("wen launch", "is it rug", "CA?") and your mods burn out answering.
>
> I built RaidOS: a Telegram bot that answers from YOUR official info only, shows live price/volume with spike alerts, runs raids and rewards holders with XP and quests.
>
> Setup is done-for-you, live in 48h, $300+ one-time (hosting optional at $49/mo). Want to see the 2-min demo video?

### KOL-led established group

> Hey [name] — your group's engagement is [genuinely something specific]. I run RaidOS for communities like yours: it answers member questions automatically (trained on your official info), fires whale/volume alerts on [TOKEN], and runs XP raids that keep the group active between your posts.
>
> Mods stop repeating themselves, members farm XP instead of lurking. Managed hosting starts at $49/mo. Can I send you a 2-min demo?

### Launchpad / agency (multi-token)

> [Agency name] launches [N] tokens a month — every one needs the same mod stack. I offer RaidOS deployments: brain trained per token, market alerts, raids, XP system. Volume pricing if you standardize on it across launches. Worth a call?

---

## Plantillas — Español

### Lanzamiento nuevo (pump.fun)

> Hey — vi que van a lanzar [TOKEN]. Las primeras 48h el grupo repite las mismas 20 preguntas ("wen launch", "es rug?", "el CA?") y tus mods se queman respondiendo.
>
> Hice RaidOS: un bot de Telegram que responde SOLO con tu info oficial, muestra precio/volumen en vivo con alertas de spikes, lanza raids y premia a la comunidad con XP y misiones.
>
> Todo instalado por mí, listo en 48h, desde $300 pago único (hosting opcional $49/mes). ¿Te mando el demo de 2 minutos?

### Grupo establecido con KOL

> Hey [nombre] — el engagement de tu grupo es [algo específico y real]. Manejo RaidOS para comunidades como la tuya: responde preguntas automáticamente (entrenado con tu info oficial), dispara alertas de ballenas/volumen de [TOKEN] y corre raids con XP que mantienen el grupo activo entre tus posts.
>
> Tus mods dejan de repetirse y los miembros farmean XP en vez de quedarse mirando. Hosting administrado desde $49/mes. ¿Te paso el demo?

---

## Objection handling

| Objection | Answer |
|---|---|
| "A free bot does half of this" | Free bots parrot canned replies or hallucinate. RaidOS answers **only** from your official info — it literally says "I don't know" rather than invent. Plus market alerts + raids + XP in one system. |
| "We'll self-host it" | It's open source — go for it (link). Most teams come back for managed hosting when the server 3am-crashes mid-launch. |
| "Too expensive" | One mod shift costs more per month. $49/mo = a mod that never sleeps, answers instantly and runs your raids. |
| "Is my data safe?" | Self-hosted mode runs AI locally via Ollama — message text never leaves your machine. Managed mode uses your community data only to answer your community. |
| "Can it post fake engagement?" | No — and that's a feature. All raid tracking is honestly labeled SELF-REPORTED. Exchanges and KOLs can't call you out for botted numbers. |

---

## Onboarding checklist (per client)

**Day 0 — collect from client:**
- [ ] Bot added to group **as admin** (invite link + admin rights screenshot)
- [ ] Token contract address + chain (for `/volume set`)
- [ ] Official links: website, X, docs, chart, pinned messages
- [ ] 10–20 official Q&A pairs (or their docs to extract from)
- [ ] Admins' Telegram IDs (for OWNER_ID / admin commands)
- [ ] Payment settled (50% up front for one-time setups)

**Day 1 — deploy:**
- [ ] Provision server / environment; `.env` configured (`AI_MODE=cloud` for hosting clients)
- [ ] `AI_MODE=cloud` → set `OPENAI_BASE_URL`, `OPENAI_API_KEY`, models (or local Ollama per client request)
- [ ] Bot online, `/setup` in the group
- [ ] `/learn` all official facts; pin the key one; verify `/ask` answers correctly 10/10
- [ ] `/volume set <contract> <SYMBOL> dexscreener` + `/volume alerts` on (higher tiers)
- [ ] Create 2–3 starter quests (`/quest add …`)

**Day 2 — launch:**
- [ ] Schedule first raid with mods (`/raid create …`)
- [ ] Welcome post announcing the bot + `/start` hint
- [ ] Admin walkthrough call (15 min): `/brain`, `/config`, `/meme open`
- [ ] Verify alert delivery (`postAlert` destination)

**Week 1 — tune:**
- [ ] Review `/brain` + confusion alerts; close gaps in KB
- [ ] Adjust XP values, quest targets, alert thresholds with mods
- [ ] Ask for the testimonial / referral while they're impressed
- [ ] Upsell: Managed Hosting if they started with one-time setup
