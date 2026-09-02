import { SaurDb } from "./db.js";

/**
 * Seed phrases — psychologically super bullish.
 * Built on proven persuasion levers: scarcity, social proof,
 * loss aversion, identity, commitment and asymmetry.
 * Categories mirror campaign tones: bullish, community, fomo, momentum, lore, hold.
 */
const SEED_PHRASES: { text: string; category: string }[] = [
  // 🟢 Bullish — identity + inevitability
  { text: "🟢 The SAUR is waking up. The ones who noticed are already here.", category: "bullish" },
  { text: "🟢 Being early is a strategy, not an accident. Those who act are the rare ones.", category: "bullish" },
  { text: "🟢 The chart is quiet. The on-chain data is not. $SAUR", category: "bullish" },
  { text: "🟢 Quiet phases build loud stories. Every legend starts in silence.", category: "bullish" },
  { text: "🟢 Nobody remembers those who waited. Everybody remembers those who moved.", category: "bullish" },
  { text: "🟢 Conviction is cheap right now. It won't be later. That's the whole point.", category: "bullish" },

  // 🦖 Community — social proof + belonging
  { text: "🦖 INU + SAUR. One meme. One community. One mission. And you're already in.", category: "community" },
  { text: "🦖 Everyone wants to find the next great community early. You're reading this — that's what early looks like.", category: "community" },
  { text: "🦖 The pack grows every day. The question isn't if. It's whether you're in before they are.", category: "community" },
  { text: "🦖 Strong communities aren't built overnight. That's exactly why they can't be copied.", category: "community" },
  { text: "🦖 Memes fade. Communities compound. The people here now are the compounding.", category: "community" },
  { text: "🦖 The loudest voices of every cycle started as silent members of a pack like this one.", category: "community" },

  // 👀 FOMO — loss aversion + scarcity
  { text: "👀 Most people discover the next meme after it moves. Reading this is your window.", category: "fomo" },
  { text: "👀 They'll call it luck when they find out later. You'll remember this moment.", category: "fomo" },
  { text: "👀 The best time to pay attention was yesterday. Every hour you wait, the gap grows.", category: "fomo" },
  { text: "👀 Some stories you watch. Others you live. Only one of them has an entry price.", category: "fomo" },
  { text: "👀 Windows like this don't reopen. They get remembered.", category: "fomo" },
  { text: "👀 The cost of being early is patience. The cost of being late is everything.", category: "fomo" },

  // 🚀 Momentum — social proof + urgency
  { text: "🚀 Early communities write the story. Everyone else pays to read it later.", category: "momentum" },
  { text: "🚀 The on-chain numbers are moving. The timeline hasn't noticed yet. It will.", category: "momentum" },
  { text: "🚀 Momentum favors those who arrived before the noise. The noise is coming.", category: "momentum" },
  { text: "🚀 The roar is growing. You can still hear it before everyone else.", category: "momentum" },
  { text: "🚀 Every big move starts with a small group that refuses to look away. This is that group.", category: "momentum" },

  // 🧠 Lore — narrative identity + exclusivity
  { text: "🧠 Long before the chart, there was the roar. You're here for the roar.", category: "lore" },
  { text: "🧠 A dinosaur and a dog walk into the metaverse. Only one walks out a legend. You know which.", category: "lore" },
  { text: "🧠 Every great meme has an origin story. The ones reading this are in ours.", category: "lore" },
  { text: "🧠 They cloned the dog. They never cloned the SAUR. Scarcity isn't a feature. It's the story.", category: "lore" },
  { text: "🧠 Legends aren't discovered later. They're built by the ones who stayed.", category: "lore" },

  // 💎 Hold — commitment + identity
  { text: "💎 Diamonds are just carbon that stayed patient under pressure. So is conviction.", category: "hold" },
  { text: "💎 Weak hands trade stories. Strong hands write them — and keep them.", category: "hold" },
  { text: "💎 The SAUR doesn't chase. It waits. And waiting is what the impatient can't do.", category: "hold" },
  { text: "💎 Patience is the rarest meme of all. That's why it pays the most.", category: "hold" },
  { text: "💎 Selling early doesn't lock in a win. It locks in a story you'll tell with regret.", category: "hold" },
  { text: "💎 Every seller needs a buyer with more conviction. Be the buyer they needed.", category: "hold" },
];

export function seedIfEmpty(db: SaurDb): void {
  const { total } = db.phraseStats();
  if (total > 0) return;
  for (const p of SEED_PHRASES) {
    db.addPhrase(p.text, p.category);
  }
}
