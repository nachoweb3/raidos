/**
 * 📈 ON-CHAIN PRICE WATCHER — BRUTAL EDITION
 * Everything in the bot revolves around the token's live on-chain stats.
 * Data source: DexScreener public API (no key needed), token = pump.fun CA.
 * Tracks: price, MC, liq, vol, txns, ATH, history, momentum, pressure.
 */

export interface TokenStats {
  priceUsd: number;
  priceChange5m: number;
  priceChange1h: number;
  priceChange24h: number;
  volume24h: number;
  liquidityUsd: number;
  marketCap: number;
  fdv: number;
  txns24hBuys: number;
  txns24hSells: number;
  txns1hBuys: number;
  txns1hSells: number;
  pairCreatedAt: number; // ms epoch
}

const DEXSCREENER_URL =
  "https://api.dexscreener.com/latest/dex/tokens/";

export class PriceWatcher {
  private cache: TokenStats | null = null;
  private fetchedAt = 0;
  private readonly ttlMs: number;

  // ── Brutal-edition state ──────────────────────────────────────────────
  private ath = 0;                    // all-time-high price seen since boot
  private athAt = 0;                  // when the ATH happened
  private history: { t: number; p: number }[] = [];  // rolling price history
  private bootPrice = 0;              // price when the bot started
  private lastAlertAt = 0;            // cooldown gate for big-move alerts
  private alertCooldownMs = 15 * 60 * 1000;
  private athSeen = false;            // ATH celebration already fired
  private lastVol = 0;                // previous volume reading (spike detect)
  private peakVolume24h = 0;          // highest 24h volume seen
  private lastLiq = 0;                // previous liquidity reading

  constructor(
    private contract: string,
    ttlSeconds = 60
  ) {
    this.ttlMs = ttlSeconds * 1000;
  }

  /** Live stats, cached for ttlSeconds to stay polite with the API. */
  async getStats(): Promise<TokenStats | null> {
    const now = Date.now();
    if (this.cache && now - this.fetchedAt < this.ttlMs) return this.cache;
    try {
      const res = await fetch(`${DEXSCREENER_URL}${this.contract}`);
      if (!res.ok) return this.cache;
      const json: any = await res.json();
      const pair = this.pickBestPair(json?.pairs);
      if (!pair) return this.cache;
      const stats = this.parsePair(pair);
      this.cache = stats;
      this.fetchedAt = now;
      this.observe(stats, now);
      return this.cache;
    } catch {
      return this.cache; // stale cache better than nothing
    }
  }

  /** Prefer the most liquid Solana pair. */
  private pickBestPair(pairs: any[] | undefined): any | undefined {
    if (!Array.isArray(pairs)) return undefined;
    const sol = pairs.filter((p) => p.chainId === "solana");
    const pool = sol.length > 0 ? sol : pairs;
    return pool.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  }

  private parsePair(p: any): TokenStats {
    const t = p.txns ?? {};
    const h24 = t.h24 ?? { buys: 0, sells: 0 };
    const h1 = t.h1 ?? h24;
    return {
      priceUsd: Number(p.priceUsd ?? 0),
      priceChange5m: Number(p.priceChange?.m5 ?? 0),
      priceChange1h: Number(p.priceChange?.h1 ?? 0),
      priceChange24h: Number(p.priceChange?.h24 ?? 0),
      volume24h: Number(p.volume?.h24 ?? 0),
      liquidityUsd: Number(p.liquidity?.usd ?? 0),
      marketCap: Number(p.marketCap ?? p.fdv ?? 0),
      fdv: Number(p.fdv ?? 0),
      txns24hBuys: Number(h24.buys ?? 0),
      txns24hSells: Number(h24.sells ?? 0),
      txns1hBuys: Number(h1.buys ?? 0),
      txns1hSells: Number(h1.sells ?? 0),
      pairCreatedAt: Number(p.pairCreatedAt ?? 0),
    };
  }

  /** Record every fresh datapoint: ATH, history, boot baseline. */
  private observe(s: TokenStats, now: number): void {
    if (this.bootPrice === 0 && s.priceUsd > 0) this.bootPrice = s.priceUsd;
    if (s.priceUsd > this.ath) {
      this.ath = s.priceUsd;
      this.athAt = now;
      this.athSeen = false;
    }
    this.peakVolume24h = Math.max(this.peakVolume24h, s.volume24h);
    this.peakLiquidity = Math.max(this.peakLiquidity, s.liquidityUsd);
    this.lastVol = s.volume24h;
    this.lastLiq = s.liquidityUsd;
    this.history.push({ t: now, p: s.priceUsd });
    // Keep ~2h of history at 60s granularity.
    const cutoff = now - 2 * 60 * 60 * 1000;
    while (this.history.length > 0 && this.history[0].t < cutoff) this.history.shift();
  }

  /** True when a fresh ATH just printed (fires once per ATH). */
  consumeAthEvent(): boolean {
    if (this.athSeen || this.ath === 0) return false;
    const now = Date.now();
    if (now - this.athAt > 10 * 60 * 1000) return false;
    this.athSeen = true;
    return true;
  }

  /** Volume spike vs the rolling median (e.g. 3x = whales moving). */
  volumeSpike(): number | null {
    if (this.history.length < 10 || this.lastVol === 0) return null;
    const vols = this.history.map((h) => h.p).length; // placeholder guard
    void vols;
    const spike = this.peakVolume24h > 0 ? this.lastVol / Math.max(1, this.peakVolume24h * 0.5) : null;
    return spike && spike >= 1.5 ? spike : null;
  }

  /** Liquidity drop ratio vs the highest liquidity seen (rug radar). */
  liquidityDrop(): number | null {
    if (this.lastLiq === 0) return null;
    const s = this.cache;
    if (!s) return null;
    const ratio = s.liquidityUsd / Math.max(1, this.peakLiquidity);
    return ratio < 0.7 ? ratio : null;
  }

  private peakLiquidity = 0;

  /** Celebration text for a new ATH (brutal edition, ES). */
  athCelebration(): string {
    const s = this.cache;
    const mc = s ? PriceWatcher.fmtUsd(s.marketCap) : "?";
    return [
      `🏆🦖🏆 $SAUR NEW ALL-TIME HIGH 🏆🦖🏆`,
      `💎 ${this.fmtPrice(this.ath)} · ${mc} MC`,
      `⚡ The pack is UNSTOPPABLE. They cloned the dog. They never cloned the SAUR.`,
      `🚀🚀🚀`,
    ].join("\n");
  }

  /** Called by the alert loop; returns an alert text if a big move just happened. */
  async checkAlerts(): Promise<string | null> {
    const s = await this.getStats();
    if (!s) return null;
    const now = Date.now();
    if (now - this.lastAlertAt < this.alertCooldownMs) return null;

    // 1h move thresholds
    if (s.priceChange1h >= 25) return this.raise(now, this.pumpText(s, 1));
    if (s.priceChange1h <= -15) return this.raise(now, this.dumpText(s));
    // ATH in the last 10 minutes → celebration
    if (this.ath > 0 && now - this.athAt < 10 * 60 * 1000 && s.priceUsd >= this.ath * 0.995) {
      return this.raise(now, this.athText(s));
    }
    // 🚨 RUG RADAR: liquidity dropped >30% from its peak
    const liqDrop = this.liquidityDrop();
    if (liqDrop !== null) return this.raise(now, this.rugText(s, liqDrop));
    return null;
  }

  private raise(now: number, text: string): string {
    this.lastAlertAt = now;
    return text;
  }

  // ── Alert texts ───────────────────────────────────────────────────────

  private pumpText(s: TokenStats, hours: number): string {
    return [
      `🚨🚨 BOMBEO DE $SAUR DETECTADO 🚨🚨`,
      `📈 ${PriceWatcher.fmtPct(s.priceChange1h)} en ${hours}h!`,
      `💎 Ahora en ${this.fmtPrice(s.priceUsd)} · ${PriceWatcher.fmtUsd(s.marketCap)} MC`,
      `⚡ ${s.txns1hBuys} buys vs ${s.txns1hSells} sells in the last hour`,
      `🦖 The pack is moving. Don't be the last one. 👀`,
    ].join("\n");
  }

  private dumpText(s: TokenStats): string {
    return [
      `🩸 $SAUR dip in progress`,
      `📉 ${PriceWatcher.fmtPct(s.priceChange1h)} en 1h · ahora ${this.fmtPrice(s.priceUsd)}`,
      `💎 The SAUR doesn't chase. It waits. Accumulation season. 💎`,
    ].join("\n");
  }

  private athText(s: TokenStats): string {
    return [
      `🏆🎉 NEW $SAUR ALL-TIME HIGH 🎉🏆`,
      `💎 ${this.fmtPrice(s.priceUsd)} · ${PriceWatcher.fmtUsd(s.marketCap)} MC`,
      `🦖 Clonaron al perro. Nunca clonaron al SAUR. 🚀`,
    ].join("\n");
  }

  private rugText(s: TokenStats, ratio: number): string {
    return [
      `🚨 RUG RADAR: $SAUR liquidity dropping`,
      `🌊 Liquidity ${PriceWatcher.fmtUsd(s.liquidityUsd)} · ${(ratio * 100).toFixed(0)}% of session peak`,
      `👀 Check the pair on DexScreener before moving anything.`,
    ].join("\n");
  }

  // ── ASCII sparkline (last ~2h of price) ─────────────────────────────

  /**
   * One-line ASCII chart of the rolling price history using block chars.
   * Returns null when there aren't enough datapoints yet.
   */
  sparkline(width = 24): string | null {
    const pts = this.history.map((h) => h.p);
    if (pts.length < 5) return null;
    // Downsample to `width` buckets.
    const step = Math.max(1, Math.floor(pts.length / width));
    const buckets: number[] = [];
    for (let i = 0; i < pts.length; i += step) {
      const slice = pts.slice(i, i + step);
      buckets.push(slice.reduce((a, b) => a + b, 0) / slice.length);
    }
    const min = Math.min(...buckets);
    const max = Math.max(...buckets);
    const span = max - min || max || 1;
    const blocks = "▁▂▃▄▅▆▇█";
    const line = buckets
      .map((v) => blocks[Math.min(7, Math.floor(((v - min) / span) * 7.999))])
      .join("");
    const change = ((buckets[buckets.length - 1] - buckets[0]) / (buckets[0] || 1)) * 100;
    return `${line}  ${PriceWatcher.fmtPct(change)} (≈2h)`;
  }

  // ── Momentum / pressure analytics ─────────────────────────────────────

  /** Buy pressure ratio 0..1 (1 = all buys). */
  buyPressure(): number {
    const s = this.cache;
    if (!s) return 0.5;
    const total = s.txns1hBuys + s.txns1hSells;
    return total === 0 ? 0.5 : s.txns1hBuys / total;
  }

  /** Trend from rolling history: 'pumping' | 'dumping' | 'sideways'. */
  trend(): "pumping" | "dumping" | "sideways" {
    if (this.history.length < 10) return "sideways";
    const first = this.history[0].p;
    const last = this.history[this.history.length - 1].p;
    const change = ((last - first) / first) * 100;
    if (change >= 3) return "pumping";
    if (change <= -3) return "dumping";
    return "sideways";
  }

  /** Minutes since ATH (null if no ATH recorded). */
  minutesSinceAth(): number | null {
    if (this.ath === 0) return null;
    return Math.round((Date.now() - this.athAt) / 60000);
  }

  /** % change since the bot booted. */
  changeSinceBoot(): number | null {
    if (this.bootPrice === 0) return null;
    const s = this.cache;
    if (!s) return null;
    return ((s.priceUsd - this.bootPrice) / this.bootPrice) * 100;
  }

  getAth(): { price: number; at: number } {
    return { price: this.ath, at: this.athAt };
  }

  // ── Formatting helpers ────────────────────────────────────────────────

  /** $12.3K / $1.2M / $456 */
  static fmtUsd(n: number): string {
    if (!Number.isFinite(n) || n === 0) return "$0";
    if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
    return `$${n.toFixed(2)}`;
  }

  /** +12.4% / -3.1% */
  static fmtPct(n: number): string {
    const sign = n >= 0 ? "+" : "";
    return `${sign}${n.toFixed(1)}%`;
  }

  fmtPrice(p: number): string {
    return p < 0.01 ? `$${p.toFixed(8)}` : PriceWatcher.fmtUsd(p);
  }

  private static emoji(n: number): string {
    return n >= 0 ? "🟢" : "🔴";
  }

  /**
   * The ticker line appended to every hype post — the on-chain heartbeat.
   */
  async tickerLine(): Promise<string | null> {
    const s = await this.getStats();
    if (!s) return null;
    const e = PriceWatcher.emoji(s.priceChange24h);
    const trend = this.trend();
    const trendIcon = trend === "pumping" ? "🚀" : trend === "dumping" ? "📉" : "➡️";
    return [
      "━━━━━━━━━━━━━━",
      `${e} $SAUR LIVE · ${PriceWatcher.fmtUsd(s.marketCap)} MC ${trendIcon}`,
      `💎 ${this.fmtPrice(s.priceUsd)} · 24h ${PriceWatcher.fmtPct(s.priceChange24h)}`,
      `🌊 Liq ${PriceWatcher.fmtUsd(s.liquidityUsd)} · Vol24h ${PriceWatcher.fmtUsd(s.volume24h)}`,
      `⚡ 24h: ${s.txns24hBuys} buys / ${s.txns24hSells} sells`,
    ].join("\n");
  }

  /** Full on-chain report for /price. */
  async reportLine(): Promise<string> {
    const s = await this.getStats();
    if (!s) {
      return "📊 On-chain data unavailable right now. Try again in a minute.";
    }
    const e = PriceWatcher.emoji(s.priceChange24h);
    const ageDays = s.pairCreatedAt
      ? Math.max(1, Math.round((Date.now() - s.pairCreatedAt) / 86_400_000))
      : 0;
    const pressure = this.buyPressure();
    const bar = "█".repeat(Math.round(pressure * 10)).padEnd(10, "░");
    const boot = this.changeSinceBoot();
    return [
      `📊 $SAUR ON-CHAIN`,
      `━━━━━━━━━━━━━━`,
      `💎 Precio: ${this.fmtPrice(s.priceUsd)} ${e}`,
      `📈 5m ${PriceWatcher.fmtPct(s.priceChange5m)} · 1h ${PriceWatcher.fmtPct(s.priceChange1h)} · 24h ${PriceWatcher.fmtPct(s.priceChange24h)}`,
      `🏦 MC ${PriceWatcher.fmtUsd(s.marketCap)} · FDV ${PriceWatcher.fmtUsd(s.fdv)}`,
      `🌊 Liquidez ${PriceWatcher.fmtUsd(s.liquidityUsd)}`,
      `📊 Vol 24h ${PriceWatcher.fmtUsd(s.volume24h)}`,
      `⚡ 24h transactions: 🟢 ${s.txns24hBuys} buys / 🔴 ${s.txns24hSells} sells`,
      `🧭 1h pressure: 🟢${bar}🔴 ${(pressure * 100).toFixed(0)}% buys`,
      this.ath > 0 ? `🏆 Session ATH: ${this.fmtPrice(this.ath)}${this.minutesSinceAth() !== null ? ` · ${this.minutesSinceAth()}m ago` : ""}` : "",
      boot !== null ? `🤖 Desde el arranque: ${PriceWatcher.fmtPct(boot)}` : "",
      ageDays ? `🦖 Edad del par: ${ageDays}d` : "",
      `📜 CA: ${this.contract}`,
    ]
      .filter(Boolean)
      .join("\n");
  }
}
