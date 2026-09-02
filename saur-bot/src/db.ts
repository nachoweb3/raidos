import Database from "better-sqlite3";

/**
 * 🧠 SAUR BOT database
 * Tables: phrases, settings, analytics_events, daily_stats
 */
export class SaurDb {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS phrases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'community',
        language TEXT NOT NULL DEFAULT 'EN',
        enabled INTEGER NOT NULL DEFAULT 1,
        cooldown_seconds INTEGER NOT NULL DEFAULT 0,
        last_used INTEGER NOT NULL DEFAULT 0,
        times_used INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS analytics_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,              -- message | join | command | bot_reply | hype_post | x_post
        user_id INTEGER,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_ts ON analytics_events(ts);
      CREATE INDEX IF NOT EXISTS idx_events_kind ON analytics_events(kind);

      CREATE TABLE IF NOT EXISTS daily_stats (
        day TEXT PRIMARY KEY,            -- YYYY-MM-DD (UTC)
        new_members INTEGER NOT NULL DEFAULT 0,
        messages INTEGER NOT NULL DEFAULT 0,
        bot_interactions INTEGER NOT NULL DEFAULT 0,
        commands_used INTEGER NOT NULL DEFAULT 0,
        hype_posts INTEGER NOT NULL DEFAULT 0,
        x_posts INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  // ── Phrases ────────────────────────────────────────────────────────────

  addPhrase(text: string, category: string, language = "EN"): number {
    const stmt = this.db.prepare(
      "INSERT INTO phrases (text, category, language) VALUES (?, ?, ?)"
    );
    const info = stmt.run(text, category, language);
    return Number(info.lastInsertRowid);
  }

  getPhrase(id: number): PhraseRow | undefined {
    return this.db.prepare("SELECT * FROM phrases WHERE id = ?").get(id) as
      | PhraseRow
      | undefined;
  }

  listPhrases(category?: string): PhraseRow[] {
    if (category) {
      return this.db
        .prepare(
          "SELECT * FROM phrases WHERE category = ? AND enabled = 1 ORDER BY id"
        )
        .all(category) as PhraseRow[];
    }
    return this.db
      .prepare("SELECT * FROM phrases WHERE enabled = 1 ORDER BY id")
      .all() as PhraseRow[];
  }

  listAllPhrases(): PhraseRow[] {
    return this.db.prepare("SELECT * FROM phrases ORDER BY id").all() as PhraseRow[];
  }

  togglePhrase(id: number): boolean {
    const row = this.getPhrase(id);
    if (!row) return false;
    this.db
      .prepare("UPDATE phrases SET enabled = ? WHERE id = ?")
      .run(row.enabled ? 0 : 1, id);
    return true;
  }

  deletePhrase(id: number): boolean {
    const info = this.db.prepare("DELETE FROM phrases WHERE id = ?").run(id);
    return info.changes > 0;
  }

  /**
   * Pick a random enabled phrase in a category, avoiding recently used ones.
   * "Avoid repeat until many others used": prefer phrases whose last_used is
   * oldest; among the 50% least-recently-used we choose uniformly at random.
   */
  pickPhrase(category?: string): PhraseRow | undefined {
    const pool = category
      ? this.listPhrases(category)
      : this.listPhrases();
    if (pool.length === 0) return undefined;
    const now = Math.floor(Date.now() / 1000);
    const sorted = [...pool].sort((a, b) => a.last_used - b.last_used);
    const freshCount = Math.max(1, Math.ceil(sorted.length / 2));
    const fresh = sorted.slice(0, freshCount);
    const chosen = fresh[Math.floor(Math.random() * fresh.length)];
    this.db
      .prepare(
        "UPDATE phrases SET last_used = ?, times_used = times_used + 1 WHERE id = ?"
      )
      .run(now, chosen.id);
    return chosen;
  }

  phraseStats(): { total: number; enabled: number; byCategory: Record<string, number> } {
    const total = (this.db.prepare("SELECT COUNT(*) c FROM phrases").get() as any).c as number;
    const enabled = (
      this.db.prepare("SELECT COUNT(*) c FROM phrases WHERE enabled = 1").get() as any
    ).c as number;
    const byCategory: Record<string, number> = {};
    const rows = this.db
      .prepare("SELECT category, COUNT(*) c FROM phrases WHERE enabled = 1 GROUP BY category")
      .all() as { category: string; c: number }[];
    for (const r of rows) byCategory[r.category] = r.c;
    return { total, enabled, byCategory };
  }

  // ── Settings ───────────────────────────────────────────────────────────

  getSetting(key: string, fallback: string): string {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : fallback;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .run(key, value);
  }

  // ── Analytics ──────────────────────────────────────────────────────────

  logEvent(kind: string, userId?: number, detail?: string): void {
    this.db
      .prepare("INSERT INTO analytics_events (ts, kind, user_id, detail) VALUES (?, ?, ?, ?)")
      .run(Math.floor(Date.now() / 1000), kind, userId ?? null, detail ?? null);
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private bump(day: string, column: string, amount = 1): void {
    this.db
      .prepare(
        `INSERT INTO daily_stats (day, ${column}) VALUES (?, ?)
         ON CONFLICT(day) DO UPDATE SET ${column} = ${column} + ?`
      )
      .run(day, amount, amount);
  }

  trackMessage(): void {
    this.bump(this.today(), "messages");
    this.logEvent("message");
  }

  trackJoin(): void {
    this.bump(this.today(), "new_members");
    this.logEvent("join");
  }

  trackCommand(command: string, userId?: number): void {
    this.bump(this.today(), "commands_used");
    this.logEvent("command", userId, command);
  }

  trackBotInteraction(userId?: number, detail?: string): void {
    this.bump(this.today(), "bot_interactions");
    this.logEvent("bot_reply", userId, detail);
  }

  trackHypePost(category: string): void {
    this.bump(this.today(), "hype_posts");
    this.logEvent("hype_post", undefined, category);
  }

  trackXPost(): void {
    this.bump(this.today(), "x_posts");
    this.logEvent("x_post");
  }

  /** Aggregate activity per UTC hour for the last N days. */
  hourlyActivity(days = 2): Record<number, number> {
    const since = Math.floor(Date.now() / 1000) - days * 86400;
    const rows = this.db
      .prepare(
        `SELECT (ts / 3600) % 24 AS hour, COUNT(*) c
         FROM analytics_events WHERE ts >= ? GROUP BY hour`
      )
      .all(since) as { hour: number; c: number }[];
    const out: Record<number, number> = {};
    for (const r of rows) out[r.hour] = r.c;
    return out;
  }

  bestHour(days = 2): { hour: number; count: number } | undefined {
    const hours = this.hourlyActivity(days);
    let best: { hour: number; count: number } | undefined;
    for (const [h, c] of Object.entries(hours)) {
      if (!best || c > best.count) best = { hour: Number(h), count: c };
    }
    return best;
  }

  todayStats(): DailyStats {
    const row = this.db
      .prepare("SELECT * FROM daily_stats WHERE day = ?")
      .get(this.today()) as DailyStats | undefined;
    return (
      row ?? {
        day: this.today(),
        new_members: 0,
        messages: 0,
        bot_interactions: 0,
        commands_used: 0,
        hype_posts: 0,
        x_posts: 0,
      }
    );
  }

  activeUsers(days = 1): number {
    const since = Math.floor(Date.now() / 1000) - days * 86400;
    const row = this.db
      .prepare("SELECT COUNT(DISTINCT user_id) c FROM analytics_events WHERE ts >= ? AND user_id IS NOT NULL")
      .get(since) as any;
    return row.c as number;
  }

  close(): void {
    this.db.close();
  }
}

export interface PhraseRow {
  id: number;
  text: string;
  category: string;
  language: string;
  enabled: number;
  cooldown_seconds: number;
  last_used: number;
  times_used: number;
}

export interface DailyStats {
  day: string;
  new_members: number;
  messages: number;
  bot_interactions: number;
  commands_used: number;
  hype_posts: number;
  x_posts: number;
}
