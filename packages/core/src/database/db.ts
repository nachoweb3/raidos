import Database from "better-sqlite3";

/**
 * 🧠 COMMUNITY BRAIN database
 * One shared DB, tenancy keyed by chat_id.
 * Tables: chats, settings, messages, member_joins, question_clusters, kb_entries, insights,
 * xp, xp_ledger, quests, quest_participants, meme_contests, meme_submissions, meme_votes,
 * badges, market_snapshots, raids, raid_participants,
 * content_templates, content_suggestions, content_schedule, content_performance
 */

export interface ChatRow {
  chat_id: number;
  title: string;
  added_at: number;
}

export interface MessageRow {
  id: number;
  chat_id: number;
  user_id: number | null;
  ts: number;
  text: string;
  is_question: number;
  analyzed: number;
}

export interface ClusterRow {
  id: number;
  chat_id: number;
  label: string;
  canonical_question: string | null;
  suggested_action: string | null;
  count: number;
  first_seen: number;
  last_seen: number;
  status: "open" | "answered" | "ignored";
  centroid: Buffer;
}

export interface KbRow {
  id: number;
  chat_id: number;
  source: "manual" | "pinned" | "admin_post";
  content: string;
  embedding: Buffer;
  added_by: number | null;
  ts: number;
  enabled: number;
}

export interface InsightRow {
  id: number;
  chat_id: number;
  ts: number;
  kind: "confusion" | "pulse" | "briefing" | "raid_report" | "momentum";
  payload: string;
}

export interface XpUserRow {
  chat_id: number;
  user_id: number;
  username: string | null;
  xp: number;
  streak: number;
  last_active_day: string | null;
}

export interface QuestRow {
  id: number;
  chat_id: number;
  name: string;
  description: string;
  requirement: string;
  xp_reward: number;
  status: "active" | "completed" | "cancelled";
  created_by: number | null;
  ends_at: number | null;
  max_participants: number | null;
  sponsored_by: string | null;
  created_at: number;
}

export interface QuestParticipantRow {
  quest_id: number;
  user_id: number;
  progress: number;
  completed: number;
}

export interface MemeContestRow {
  id: number;
  chat_id: number;
  title: string;
  status: "submissions" | "voting" | "finished";
  ends_at: number | null;
  xp_reward: number;
  created_at: number;
}

export interface MemeSubmissionRow {
  id: number;
  contest_id: number;
  user_id: number | null;
  username: string | null;
  content: string;
  votes: number;
  ts: number;
}

export interface BadgeRow {
  chat_id: number;
  user_id: number;
  code: string;
  awarded_at: number;
}

export interface RaidRow {
  id: number;
  chat_id: number;
  title: string;
  platform: string;
  target_url: string;
  objective: number;
  duration_minutes: number;
  xp_reward: number;
  max_participants: number | null;
  status: "active" | "finished" | "cancelled";
  created_by: number | null;
  started_at: number;
  ends_at: number;
  finished_at: number | null;
}

export interface RaidParticipantRow {
  raid_id: number;
  user_id: number;
  username: string | null;
  joined_at: number;
  last_checkin_at: number;
  checkins: number;
  xp_awarded: number;
}

export interface ContentSuggestionRow {
  id: number;
  chat_id: number;
  ts: number;
  /** Template kind: announcement|recap|market_update|raid_wrap|spotlight|reminder|kb_gap_nudge */
  kind: string;
  /** Signal kind that triggered the suggestion (cooldown key). */
  signal_kind: string;
  /** Opaque JSON blob: { kind, detail } — the measured signal behind the proposal. */
  signal: string;
  text: string;
  status: "proposed" | "approved" | "edited" | "scheduled" | "published" | "skipped";
  published_at: number | null;
  published_text: string | null;
}

export interface ContentScheduleRow {
  id: number;
  chat_id: number;
  suggestion_id: number;
  scheduled_at: number;
  channel: "group" | "x";
  status: "pending" | "done" | "missed";
}

export interface ContentScheduleDueRow extends ContentScheduleRow {
  suggestion_text: string;
  suggestion_kind: string;
}

export interface ContentPerformanceRow {
  id: number;
  chat_id: number;
  suggestion_id: number;
  measured: string;
  label: string;
  ts: number;
}

export type RaidCheckinDbResult =
  | { status: "ok"; xp: number; totalXp: number; checkins: number }
  | { status: "not_joined" | "cooldown" | "checkin_cap" | "raid_closed" | "daily_cap"; waitSeconds?: number };

export class BrainDb {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        chat_id INTEGER PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        added_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        chat_id INTEGER NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (chat_id, key)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        user_id INTEGER,
        ts INTEGER NOT NULL,
        text TEXT NOT NULL,
        is_question INTEGER NOT NULL DEFAULT 0,
        analyzed INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_id, ts);
      CREATE INDEX IF NOT EXISTS idx_messages_unanalyzed ON messages(chat_id, analyzed) WHERE analyzed = 0;

      CREATE TABLE IF NOT EXISTS member_joins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        joined INTEGER NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_member_joins_chat_ts ON member_joins(chat_id, ts);

      CREATE TABLE IF NOT EXISTS question_clusters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        label TEXT NOT NULL,
        canonical_question TEXT,
        suggested_action TEXT,
        count INTEGER NOT NULL DEFAULT 0,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        centroid BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_clusters_chat ON question_clusters(chat_id, status);

      CREATE TABLE IF NOT EXISTS kb_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        source TEXT NOT NULL,
        content TEXT NOT NULL,
        embedding BLOB NOT NULL,
        added_by INTEGER,
        ts INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_kb_chat ON kb_entries(chat_id, enabled);

      CREATE TABLE IF NOT EXISTS insights (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_insights_chat ON insights(chat_id, kind, ts);

      CREATE TABLE IF NOT EXISTS xp (
        chat_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        username TEXT,
        xp INTEGER NOT NULL DEFAULT 0,
        streak INTEGER NOT NULL DEFAULT 0,
        last_active_day TEXT,
        PRIMARY KEY (chat_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_xp_chat ON xp(chat_id, xp DESC);

      CREATE TABLE IF NOT EXISTS xp_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        xp INTEGER NOT NULL,
        reason TEXT NOT NULL,
        ts INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS quests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        requirement TEXT NOT NULL,
        xp_reward INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        created_by INTEGER,
        ends_at INTEGER,
        max_participants INTEGER,
        sponsored_by TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_quests_chat ON quests(chat_id, status);

      CREATE TABLE IF NOT EXISTS quest_participants (
        quest_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        completed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (quest_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS meme_contests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'submissions',
        ends_at INTEGER,
        xp_reward INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_meme_contests_chat ON meme_contests(chat_id, status);

      CREATE TABLE IF NOT EXISTS meme_submissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contest_id INTEGER NOT NULL,
        user_id INTEGER,
        username TEXT,
        content TEXT NOT NULL,
        votes INTEGER NOT NULL DEFAULT 0,
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_meme_submissions_contest ON meme_submissions(contest_id, votes DESC);

      CREATE TABLE IF NOT EXISTS meme_votes (
        contest_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        submission_id INTEGER NOT NULL,
        PRIMARY KEY (contest_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS badges (
        chat_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        code TEXT NOT NULL,
        awarded_at INTEGER NOT NULL,
        PRIMARY KEY (chat_id, user_id, code)
      );

      CREATE TABLE IF NOT EXISTS market_snapshots (
        chat_id INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_market_chat_ts ON market_snapshots(chat_id, ts);

      CREATE TABLE IF NOT EXISTS raids (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        platform TEXT NOT NULL DEFAULT 'x',
        target_url TEXT NOT NULL DEFAULT '',
        objective INTEGER NOT NULL DEFAULT 0,
        duration_minutes INTEGER NOT NULL DEFAULT 30,
        xp_reward INTEGER NOT NULL DEFAULT 0,
        max_participants INTEGER,
        status TEXT NOT NULL DEFAULT 'active',
        created_by INTEGER,
        started_at INTEGER NOT NULL,
        ends_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_raids_chat ON raids(chat_id, status);

      CREATE TABLE IF NOT EXISTS raid_participants (
        raid_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        username TEXT,
        joined_at INTEGER NOT NULL,
        last_checkin_at INTEGER NOT NULL,
        checkins INTEGER NOT NULL DEFAULT 0,
        xp_awarded INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (raid_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_raid_parts_user ON raid_participants(user_id);

      CREATE TABLE IF NOT EXISTS content_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        template TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        params TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_content_tpl_chat ON content_templates(chat_id, kind);

      CREATE TABLE IF NOT EXISTS content_suggestions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        signal_kind TEXT NOT NULL,
        signal TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'proposed',
        published_at INTEGER,
        published_text TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_content_sug_chat ON content_suggestions(chat_id, status);
      CREATE INDEX IF NOT EXISTS idx_content_sug_sig ON content_suggestions(chat_id, signal_kind, ts);

      CREATE TABLE IF NOT EXISTS content_schedule (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        suggestion_id INTEGER NOT NULL,
        scheduled_at INTEGER NOT NULL,
        channel TEXT NOT NULL DEFAULT 'group',
        status TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE INDEX IF NOT EXISTS idx_content_sched_due ON content_schedule(status, scheduled_at);
      DELETE FROM content_schedule
       WHERE status = 'pending'
         AND id NOT IN (
           SELECT MAX(id) FROM content_schedule WHERE status = 'pending' GROUP BY suggestion_id
         );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_content_sched_pending_suggestion ON content_schedule(suggestion_id) WHERE status = 'pending';

      CREATE TABLE IF NOT EXISTS content_performance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        suggestion_id INTEGER NOT NULL,
        measured TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT 'SELF-REPORTED',
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_content_perf_chat ON content_performance(chat_id, ts);
    `);
  }

  // ── Chats ──────────────────────────────────────────────────────────────

  registerChat(chatId: number, title: string): void {
    this.db
      .prepare(
        "INSERT INTO chats (chat_id, title, added_at) VALUES (?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET title = excluded.title"
      )
      .run(chatId, title, Math.floor(Date.now() / 1000));
  }

  getChat(chatId: number): ChatRow | undefined {
    return this.db.prepare("SELECT * FROM chats WHERE chat_id = ?").get(chatId) as
      | ChatRow
      | undefined;
  }

  listChats(): ChatRow[] {
    return this.db.prepare("SELECT * FROM chats ORDER BY chat_id").all() as ChatRow[];
  }

  // ── Settings ───────────────────────────────────────────────────────────

  getSetting(chatId: number, key: string, fallback: string): string {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE chat_id = ? AND key = ?")
      .get(chatId, key) as { value: string } | undefined;
    return row ? row.value : fallback;
  }

  setSetting(chatId: number, key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO settings (chat_id, key, value) VALUES (?, ?, ?) ON CONFLICT(chat_id, key) DO UPDATE SET value = excluded.value"
      )
      .run(chatId, key, value);
  }

  // ── Messages ───────────────────────────────────────────────────────────

  addMessage(chatId: number, userId: number | null, text: string, isQuestion: boolean, ts = Math.floor(Date.now() / 1000)): number {
    const info = this.db
      .prepare(
        "INSERT INTO messages (chat_id, user_id, ts, text, is_question, analyzed) VALUES (?, ?, ?, ?, ?, 0)"
      )
      .run(chatId, userId, ts, text, isQuestion ? 1 : 0);
    return Number(info.lastInsertRowid);
  }

  /** Unanalyzed questions for a chat, oldest first. */
  unanalyzedQuestions(chatId: number, limit = 200): MessageRow[] {
    return this.db
      .prepare(
        "SELECT * FROM messages WHERE chat_id = ? AND analyzed = 0 AND is_question = 1 ORDER BY ts ASC LIMIT ?"
      )
      .all(chatId, limit) as MessageRow[];
  }

  markAnalyzed(ids: number[]): void {
    const stmt = this.db.prepare("UPDATE messages SET analyzed = 1 WHERE id = ?");
    const tx = this.db.transaction((rows: number[]) => {
      for (const id of rows) stmt.run(id);
    });
    tx(ids);
  }

  /** Messages captured in [sinceTs, untilTs] (inclusive). */
  countMessages(chatId: number, sinceTs: number, untilTs: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND ts >= ? AND ts <= ?")
      .get(chatId, sinceTs, untilTs) as { n: number };
    return row.n;
  }

  /** Questions captured in [sinceTs, untilTs] (inclusive). */
  countQuestionsBetween(chatId: number, sinceTs: number, untilTs: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND ts >= ? AND ts <= ? AND is_question = 1")
      .get(chatId, sinceTs, untilTs) as { n: number };
    return row.n;
  }

  /** New-member joins recorded in [sinceTs, untilTs] (inclusive). */
  newMembersBetween(chatId: number, sinceTs: number, untilTs: number): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(joined), 0) AS n FROM member_joins WHERE chat_id = ? AND ts >= ? AND ts <= ?")
      .get(chatId, sinceTs, untilTs) as { n: number };
    return row.n;
  }

  /** Record new members joining the group (service message). */
  addMemberJoins(chatId: number, count: number, ts = Math.floor(Date.now() / 1000)): void {
    if (count <= 0) return;
    this.db
      .prepare("INSERT INTO member_joins (chat_id, joined, ts) VALUES (?, ?, ?)")
      .run(chatId, count, ts);
  }

  /** Distinct active users in [sinceTs, untilTs]. */
  distinctActiveUsers(chatId: number, sinceTs: number, untilTs: number): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(DISTINCT user_id) AS n FROM messages WHERE chat_id = ? AND ts >= ? AND ts <= ? AND user_id IS NOT NULL"
      )
      .get(chatId, sinceTs, untilTs) as { n: number };
    return row.n;
  }

  /** Message texts in [sinceTs, untilTs] (oldest first, capped at `limit`, newest kept). */
  listMessagesBetween(chatId: number, sinceTs: number, untilTs: number, limit = 20): { text: string; is_question: number }[] {
    return this.db
      .prepare(
        "SELECT text, is_question FROM (SELECT text, is_question, ts FROM messages WHERE chat_id = ? AND ts >= ? AND ts <= ? ORDER BY ts DESC LIMIT ?) ORDER BY ts ASC"
      )
      .all(chatId, sinceTs, untilTs, limit) as { text: string; is_question: number }[];
  }

  messageCount(chatId: number, sinceTs: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) c FROM messages WHERE chat_id = ? AND ts >= ?")
      .get(chatId, sinceTs) as { c: number };
    return row.c;
  }

  questionCount(chatId: number, sinceTs: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) c FROM messages WHERE chat_id = ? AND ts >= ? AND is_question = 1")
      .get(chatId, sinceTs) as { c: number };
    return row.c;
  }

  activeUsers(chatId: number, sinceTs: number): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(DISTINCT user_id) c FROM messages WHERE chat_id = ? AND ts >= ? AND user_id IS NOT NULL"
      )
      .get(chatId, sinceTs) as { c: number };
    return row.c;
  }

  /** Delete message text older than retention; returns rows removed. */
  purgeExpiredMessages(chatId: number, retentionDays: number): number {
    const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86400;
    // Keep analytics value: blank the text rather than deleting the row.
    const info = this.db
      .prepare("UPDATE messages SET text = '' WHERE chat_id = ? AND ts <= ? AND text != ''")
      .run(chatId, cutoff);
    return info.changes;
  }

  // ── Question clusters ──────────────────────────────────────────────────

  listClusters(chatId: number, status?: string): ClusterRow[] {
    if (status) {
      return this.db
        .prepare("SELECT * FROM question_clusters WHERE chat_id = ? AND status = ? ORDER BY count DESC, last_seen DESC")
        .all(chatId, status) as ClusterRow[];
    }
    return this.db
      .prepare("SELECT * FROM question_clusters WHERE chat_id = ? ORDER BY count DESC, last_seen DESC")
      .all(chatId) as ClusterRow[];
  }

  openClusters(chatId: number): ClusterRow[] {
    return this.listClusters(chatId, "open");
  }

  addCluster(chatId: number, label: string, centroid: Buffer, ts: number): number {
    const info = this.db
      .prepare(
        "INSERT INTO question_clusters (chat_id, label, count, first_seen, last_seen, status, centroid) VALUES (?, ?, 1, ?, ?, 'open', ?)"
      )
      .run(chatId, label, ts, ts, centroid);
    return Number(info.lastInsertRowid);
  }

  updateCluster(
    id: number,
    centroid: Buffer,
    ts: number
  ): void {
    this.db
      .prepare("UPDATE question_clusters SET count = count + 1, last_seen = ?, centroid = ? WHERE id = ?")
      .run(ts, centroid, id);
  }

  setClusterResolved(id: number, canonical: string, action: string): void {
    this.db
      .prepare("UPDATE question_clusters SET canonical_question = ?, suggested_action = ? WHERE id = ?")
      .run(canonical, action, id);
  }

  setClusterStatus(id: number, status: "open" | "answered" | "ignored"): boolean {
    const info = this.db
      .prepare("UPDATE question_clusters SET status = ? WHERE id = ?")
      .run(status, id);
    return info.changes > 0;
  }

  getCluster(id: number): ClusterRow | undefined {
    return this.db.prepare("SELECT * FROM question_clusters WHERE id = ?").get(id) as
      | ClusterRow
      | undefined;
  }

  // ── Knowledge base ─────────────────────────────────────────────────────

  addKbEntry(
    chatId: number,
    source: KbRow["source"],
    content: string,
    embedding: Buffer,
    addedBy: number | null
  ): number {
    const info = this.db
      .prepare(
        "INSERT INTO kb_entries (chat_id, source, content, embedding, added_by, ts, enabled) VALUES (?, ?, ?, ?, ?, ?, 1)"
      )
      .run(chatId, source, content, embedding, addedBy, Math.floor(Date.now() / 1000));
    return Number(info.lastInsertRowid);
  }

  listKbEntries(chatId: number, includeDisabled = false): KbRow[] {
    const where = includeDisabled ? "chat_id = ?" : "chat_id = ? AND enabled = 1";
    return this.db
      .prepare(`SELECT * FROM kb_entries WHERE ${where} ORDER BY ts DESC`)
      .all(chatId) as KbRow[];
  }

  getKbEntry(id: number): KbRow | undefined {
    return this.db.prepare("SELECT * FROM kb_entries WHERE id = ?").get(id) as KbRow | undefined;
  }

  deleteKbEntry(id: number, expectedChatId?: number): boolean {
    const info = expectedChatId === undefined
      ? this.db.prepare("DELETE FROM kb_entries WHERE id = ?").run(id)
      : this.db.prepare("DELETE FROM kb_entries WHERE id = ? AND chat_id = ?").run(id, expectedChatId);
    return info.changes > 0;
  }

  setKbEnabled(id: number, enabled: boolean): boolean {
    const info = this.db.prepare("UPDATE kb_entries SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
    return info.changes > 0;
  }

  replacePinnedEntry(chatId: number, content: string, embedding: Buffer): void {
    this.db.prepare("DELETE FROM kb_entries WHERE chat_id = ? AND source = 'pinned'").run(chatId);
    this.addKbEntry(chatId, "pinned", content, embedding, null);
  }

  // ── XP / streaks ───────────────────────────────────────────────────────

  private static dayString(offsetDays: number): string {
    const d = new Date(Date.now() + offsetDays * 86_400_000);
    return d.toISOString().slice(0, 10);
  }

  private static dayStringAt(ts: number, offsetDays = 0): string {
    return new Date((ts + offsetDays * 86_400) * 1000).toISOString().slice(0, 10);
  }

  private recordXpAt(chatId: number, userId: number, xp: number, reason: string, ts: number): { xp: number; streak: number } {
    const today = BrainDb.dayStringAt(ts);
    const yesterday = BrainDb.dayStringAt(ts, -1);
    const row = this.db.prepare("SELECT * FROM xp WHERE chat_id = ? AND user_id = ?").get(chatId, userId) as
      | XpUserRow
      | undefined;
    const streak = row
      ? row.last_active_day === today
        ? row.streak
        : row.last_active_day === yesterday
          ? row.streak + 1
          : 1
      : 1;
    const total = (row?.xp ?? 0) + xp;
    this.db
      .prepare(
        `INSERT INTO xp (chat_id, user_id, xp, streak, last_active_day) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(chat_id, user_id) DO UPDATE SET
           xp = xp + excluded.xp,
           streak = excluded.streak,
           last_active_day = excluded.last_active_day`
      )
      .run(chatId, userId, xp, streak, today);
    this.db
      .prepare("INSERT INTO xp_ledger (chat_id, user_id, xp, reason, ts) VALUES (?, ?, ?, ?, ?)")
      .run(chatId, userId, xp, reason, ts);
    return { xp: total, streak };
  }

  /** Add XP, keep the daily streak alive, log the reason. */
  recordXp(chatId: number, userId: number, xp: number, reason: string, ts = Math.floor(Date.now() / 1000)): { xp: number; streak: number } {
    const tx = this.db.transaction(() => this.recordXpAt(chatId, userId, xp, reason, ts));
    return tx.immediate();
  }

  getUserStats(chatId: number, userId: number): { xp: number; streak: number } {
    const row = this.db.prepare("SELECT * FROM xp WHERE chat_id = ? AND user_id = ?").get(chatId, userId) as
      | XpUserRow
      | undefined;
    return { xp: row?.xp ?? 0, streak: row?.streak ?? 0 };
  }

  topUsersByXp(chatId: number, limit = 10): { user_id: number; username: string | null; xp: number }[] {
    return this.db
      .prepare("SELECT user_id, username, xp FROM xp WHERE chat_id = ? AND xp > 0 ORDER BY xp DESC LIMIT ?")
      .all(chatId, limit) as { user_id: number; username: string | null; xp: number }[];
  }

  setXpUsername(chatId: number, userId: number, username: string): void {
    this.db.prepare("UPDATE xp SET username = ? WHERE chat_id = ? AND user_id = ?").run(username, chatId, userId);
  }

  // ── Quests ─────────────────────────────────────────────────────────────

  addQuest(input: {
    chat_id: number;
    name: string;
    description: string;
    requirement: string;
    xp_reward: number;
    status: string;
    created_by: number | null;
    ends_at: number | null;
    max_participants: number | null;
    sponsored_by: string | null;
  }): number {
    const info = this.db
      .prepare(
        `INSERT INTO quests (chat_id, name, description, requirement, xp_reward, status, created_by, ends_at, max_participants, sponsored_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.chat_id,
        input.name,
        input.description,
        input.requirement,
        input.xp_reward,
        input.status,
        input.created_by,
        input.ends_at,
        input.max_participants,
        input.sponsored_by,
        Math.floor(Date.now() / 1000)
      );
    return Number(info.lastInsertRowid);
  }

  listQuests(chatId: number, status?: string): QuestRow[] {
    if (status) {
      return this.db
        .prepare("SELECT * FROM quests WHERE chat_id = ? AND status = ? ORDER BY created_at DESC")
        .all(chatId, status) as QuestRow[];
    }
    return this.db.prepare("SELECT * FROM quests WHERE chat_id = ? ORDER BY created_at DESC").all(chatId) as QuestRow[];
  }

  getQuest(id: number): QuestRow | undefined {
    return this.db.prepare("SELECT * FROM quests WHERE id = ?").get(id) as QuestRow | undefined;
  }

  questParticipants(questId: number): QuestParticipantRow[] {
    return this.db.prepare("SELECT * FROM quest_participants WHERE quest_id = ?").all(questId) as QuestParticipantRow[];
  }

  setQuestProgress(questId: number, userId: number, progress: number): void {
    this.db
      .prepare(
        `INSERT INTO quest_participants (quest_id, user_id, progress) VALUES (?, ?, ?)
         ON CONFLICT(quest_id, user_id) DO UPDATE SET progress = excluded.progress`
      )
      .run(questId, userId, progress);
  }

  completeQuest(questId: number): boolean {
    const info = this.db
      .prepare("UPDATE quests SET status = 'completed' WHERE id = ? AND status = 'active'")
      .run(questId);
    return info.changes > 0;
  }

  // ── Meme contests ──────────────────────────────────────────────────────

  addMemeContest(input: {
    chat_id: number;
    title: string;
    status: string;
    ends_at: number | null;
  }): number {
    const info = this.db
      .prepare("INSERT INTO meme_contests (chat_id, title, status, ends_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(input.chat_id, input.title, input.status, input.ends_at, Math.floor(Date.now() / 1000));
    return Number(info.lastInsertRowid);
  }

  getMemeContest(id: number): MemeContestRow | undefined {
    return this.db.prepare("SELECT * FROM meme_contests WHERE id = ?").get(id) as MemeContestRow | undefined;
  }

  listMemeContests(chatId: number, status?: string): MemeContestRow[] {
    if (status) {
      return this.db
        .prepare("SELECT * FROM meme_contests WHERE chat_id = ? AND status = ? ORDER BY created_at DESC")
        .all(chatId, status) as MemeContestRow[];
    }
    return this.db
      .prepare("SELECT * FROM meme_contests WHERE chat_id = ? ORDER BY created_at DESC")
      .all(chatId) as MemeContestRow[];
  }

  setMemeContestStatus(id: number, status: MemeContestRow["status"]): boolean {
    const info = this.db.prepare("UPDATE meme_contests SET status = ? WHERE id = ?").run(status, id);
    return info.changes > 0;
  }

  topMemeSubmission(contestId: number): MemeSubmissionRow | undefined {
    return this.db
      .prepare("SELECT * FROM meme_submissions WHERE contest_id = ? ORDER BY votes DESC, ts ASC LIMIT 1")
      .get(contestId) as MemeSubmissionRow | undefined;
  }

  addMemeSubmission(contestId: number, userId: number | null, username: string | null, content: string): number {
    const info = this.db
      .prepare("INSERT INTO meme_submissions (contest_id, user_id, username, content, ts) VALUES (?, ?, ?, ?, ?)")
      .run(contestId, userId, username, content, Math.floor(Date.now() / 1000));
    return Number(info.lastInsertRowid);
  }

  listMemeSubmissions(contestId: number): MemeSubmissionRow[] {
    return this.db
      .prepare("SELECT * FROM meme_submissions WHERE contest_id = ? ORDER BY votes DESC, ts ASC")
      .all(contestId) as MemeSubmissionRow[];
  }

  hasVoted(contestId: number, userId: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM meme_votes WHERE contest_id = ? AND user_id = ?").get(contestId, userId);
  }

  addVote(contestId: number, userId: number, submissionId: number): boolean {
    const info = this.db
      .prepare("INSERT OR IGNORE INTO meme_votes (contest_id, user_id, submission_id) VALUES (?, ?, ?)")
      .run(contestId, userId, submissionId);
    if (info.changes === 0) return false;
    this.db.prepare("UPDATE meme_submissions SET votes = votes + 1 WHERE id = ?").run(submissionId);
    return true;
  }

  // ── Badges ─────────────────────────────────────────────────────────────

  awardBadge(chatId: number, userId: number, code: string): boolean {
    const info = this.db
      .prepare("INSERT OR IGNORE INTO badges (chat_id, user_id, code, awarded_at) VALUES (?, ?, ?, ?)")
      .run(chatId, userId, code, Math.floor(Date.now() / 1000));
    return info.changes > 0;
  }

  hasBadge(chatId: number, userId: number, code: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM badges WHERE chat_id = ? AND user_id = ? AND code = ?")
      .get(chatId, userId, code);
  }

  listBadges(chatId: number, userId: number): BadgeRow[] {
    return this.db
      .prepare("SELECT * FROM badges WHERE chat_id = ? AND user_id = ? ORDER BY awarded_at ASC")
      .all(chatId, userId) as BadgeRow[];
  }

  updateKbEmbedding(id: number, embedding: Buffer): void {
    this.db
      .prepare("UPDATE kb_entries SET embedding = ? WHERE id = ?")
      .run(embedding, id);
  }

  // ── Market snapshots ─────────────────────────────────────────────────

  addMarketSnapshot(chatId: number, payload: string): void {
    this.db
      .prepare("INSERT INTO market_snapshots (chat_id, ts, payload) VALUES (?, ?, ?)")
      .run(chatId, Math.floor(Date.now() / 1000), payload);
  }

  listMarketSnapshots(chatId: number, sinceTs: number): { ts: number; payload: string }[] {
    return this.db
      .prepare("SELECT ts, payload FROM market_snapshots WHERE chat_id = ? AND ts >= ? ORDER BY ts ASC")
      .all(chatId, sinceTs) as { ts: number; payload: string }[];
  }

  lastMarketSnapshot(chatId: number): { ts: number; payload: string } | undefined {
    return this.db
      .prepare("SELECT ts, payload FROM market_snapshots WHERE chat_id = ? ORDER BY ts DESC LIMIT 1")
      .get(chatId) as { ts: number; payload: string } | undefined;
  }

  pruneMarketSnapshots(chatId: number, keepCount: number): void {
    this.db
      .prepare(
        `DELETE FROM market_snapshots WHERE chat_id = ? AND ts NOT IN (
           SELECT ts FROM market_snapshots WHERE chat_id = ? ORDER BY ts DESC LIMIT ?
         )`
      )
      .run(chatId, chatId, keepCount);
  }

  // ── Raids ─────────────────────────────────────────────────────────────

  addRaid(r: {
    chat_id: number;
    title: string;
    platform: string;
    target_url: string;
    objective: number;
    duration_minutes: number;
    xp_reward: number;
    max_participants: number | null;
    status: "active";
    created_by: number | null;
    started_at: number;
    ends_at: number;
  }): number {
    const info = this.db
      .prepare(
        `INSERT INTO raids (chat_id, title, platform, target_url, objective, duration_minutes, xp_reward, max_participants, status, created_by, started_at, ends_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        r.chat_id,
        r.title,
        r.platform,
        r.target_url,
        r.objective,
        r.duration_minutes,
        r.xp_reward,
        r.max_participants,
        r.status,
        r.created_by,
        r.started_at,
        r.ends_at
      );
    return Number(info.lastInsertRowid);
  }

  getRaid(id: number): RaidRow | undefined {
    return this.db.prepare("SELECT * FROM raids WHERE id = ?").get(id) as RaidRow | undefined;
  }

  listRaids(chatId: number, status?: RaidRow["status"]): RaidRow[] {
    if (status) {
      return this.db
        .prepare("SELECT * FROM raids WHERE chat_id = ? AND status = ? ORDER BY started_at DESC")
        .all(chatId, status) as RaidRow[];
    }
    return this.db.prepare("SELECT * FROM raids WHERE chat_id = ? ORDER BY started_at DESC").all(chatId) as RaidRow[];
  }

  setRaidStatus(id: number, status: RaidRow["status"]): boolean {
    const info = this.db.prepare("UPDATE raids SET status = ? WHERE id = ?").run(status, id);
    return info.changes > 0;
  }

  finishRaidRow(id: number): boolean {
    const info = this.db
      .prepare("UPDATE raids SET status = 'finished', finished_at = ? WHERE id = ? AND status = 'active'")
      .run(Math.floor(Date.now() / 1000), id);
    return info.changes > 0;
  }

  addRaidParticipant(raidId: number, userId: number, username: string | null): boolean {
    const now = Math.floor(Date.now() / 1000);
    const info = this.db
      .prepare("INSERT OR IGNORE INTO raid_participants (raid_id, user_id, username, joined_at, last_checkin_at) VALUES (?, ?, ?, ?, ?)")
      .run(raidId, userId, username, now, now);
    return info.changes > 0;
  }

  /** Atomically validate the raid and reserve a participant slot. */
  joinRaidParticipant(
    raidId: number,
    userId: number,
    username: string | null,
    expectedChatId?: number,
    now = Math.floor(Date.now() / 1000)
  ): "ok" | "already" | "full" | "raid_closed" {
    const tx = this.db.transaction(() => {
      const raid = this.db.prepare("SELECT * FROM raids WHERE id = ?").get(raidId) as RaidRow | undefined;
      if (!raid || (expectedChatId !== undefined && raid.chat_id !== expectedChatId) || raid.status !== "active" || raid.ends_at <= now) return "raid_closed" as const;
      if (this.db.prepare("SELECT 1 FROM raid_participants WHERE raid_id = ? AND user_id = ?").get(raidId, userId)) return "already" as const;
      if (raid.max_participants !== null) {
        const row = this.db.prepare("SELECT COUNT(*) AS n FROM raid_participants WHERE raid_id = ?").get(raidId) as { n: number };
        if (row.n >= raid.max_participants) return "full" as const;
      }
      const info = this.db
        .prepare("INSERT OR IGNORE INTO raid_participants (raid_id, user_id, username, joined_at, last_checkin_at) VALUES (?, ?, ?, ?, ?)")
        .run(raidId, userId, username, now, now);
      return info.changes > 0 ? "ok" as const : "already" as const;
    });
    return tx.immediate();
  }


  getRaidParticipant(raidId: number, userId: number): RaidParticipantRow | undefined {
    return this.db
      .prepare("SELECT * FROM raid_participants WHERE raid_id = ? AND user_id = ?")
      .get(raidId, userId) as RaidParticipantRow | undefined;
  }

  listRaidParticipants(raidId: number): RaidParticipantRow[] {
    return this.db
      .prepare("SELECT * FROM raid_participants WHERE raid_id = ? ORDER BY joined_at ASC")
      .all(raidId) as RaidParticipantRow[];
  }

  touchRaidParticipant(raidId: number, userId: number): boolean {
    const info = this.db
      .prepare(
        `UPDATE raid_participants
         SET checkins = checkins + 1, last_checkin_at = ?
         WHERE raid_id = ? AND user_id = ?`
      )
      .run(Math.floor(Date.now() / 1000), raidId, userId);
    return info.changes > 0;
  }


  setRaidParticipantXp(raidId: number, userId: number, xp: number): void {
    this.db
      .prepare("UPDATE raid_participants SET xp_awarded = ? WHERE raid_id = ? AND user_id = ?")
      .run(xp, raidId, userId);
  }

  raidRanking(chatId: number, limit = 10): { user_id: number; username: string | null; raids: number; checkins: number; xp: number }[] {
    return this.db
      .prepare(
        `SELECT rp.user_id AS user_id,
                MAX(rp.username) AS username,
                COUNT(DISTINCT rp.raid_id) AS raids,
                SUM(rp.checkins) AS checkins,
                SUM(rp.xp_awarded) AS xp
         FROM raid_participants rp
         JOIN raids r ON r.id = rp.raid_id
         WHERE r.chat_id = ?
         GROUP BY rp.user_id
         ORDER BY raids DESC, xp DESC
         LIMIT ?`
      )
      .all(chatId, limit) as { user_id: number; username: string | null; raids: number; checkins: number; xp: number }[];
  }

  /** Atomically records a raid check-in, its participant counters, and the XP ledger entry. */
  checkinRaidParticipant(input: {
    raidId: number;
    userId: number;
    expectedChatId?: number;
    now: number;
    cooldownSeconds: number;
    maxCheckins: number;
    baseXp: number;
    decay: number;
    dailyXpCap: number;
  }): RaidCheckinDbResult {
    const tx = this.db.transaction(() => {
      const raid = this.db.prepare("SELECT * FROM raids WHERE id = ?").get(input.raidId) as RaidRow | undefined;
      if (!raid || (input.expectedChatId !== undefined && raid.chat_id !== input.expectedChatId) || raid.status !== "active" || raid.ends_at <= input.now) {
        return { status: "raid_closed" } as const;
      }
      const participant = this.db
        .prepare("SELECT * FROM raid_participants WHERE raid_id = ? AND user_id = ?")
        .get(input.raidId, input.userId) as RaidParticipantRow | undefined;
      if (!participant) return { status: "not_joined" } as const;
      if (participant.checkins >= input.maxCheckins) return { status: "checkin_cap" } as const;
      if (participant.checkins > 0 && input.now - participant.last_checkin_at < input.cooldownSeconds) {
        return { status: "cooldown", waitSeconds: input.cooldownSeconds - (input.now - participant.last_checkin_at) } as const;
      }

      const current = new Date(input.now * 1000);
      const dayStart = Math.floor(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate()) / 1000);
      const earned = this.sumXpBetween(raid.chat_id, dayStart, dayStart + 86_399, "raid:", input.userId);
      if (earned >= input.dailyXpCap) return { status: "daily_cap" } as const;
      const calculatedXp = Math.max(1, Math.round(input.baseXp * Math.pow(input.decay, Math.min(participant.checkins, 10))));
      const xp = Math.min(calculatedXp, input.dailyXpCap - earned);
      const nextCheckins = participant.checkins + 1;
      const nextTotalXp = participant.xp_awarded + xp;
      this.db
        .prepare("UPDATE raid_participants SET checkins = ?, last_checkin_at = ?, xp_awarded = ? WHERE raid_id = ? AND user_id = ?")
        .run(nextCheckins, input.now, nextTotalXp, input.raidId, input.userId);
      if (xp > 0) this.recordXpAt(raid.chat_id, input.userId, xp, `raid:${input.raidId}`, input.now);
      return { status: "ok", xp, totalXp: nextTotalXp, checkins: nextCheckins } as const;
    });
    return tx.immediate();
  }

  /** Total XP granted in [sinceTs, untilTs]; optionally only reasons starting with `reasonPrefix` (e.g. "raid:"). */
  sumXpBetween(chatId: number, sinceTs: number, untilTs: number, reasonPrefix?: string, userId?: number): number {
    const clauses = ["chat_id = ?", "ts >= ?", "ts <= ?"];
    const params: (number | string)[] = [chatId, sinceTs, untilTs];
    if (reasonPrefix) {
      clauses.push("reason LIKE ?");
      params.push(`${reasonPrefix}%`);
    }
    if (userId !== undefined) {
      clauses.push("user_id = ?");
      params.push(userId);
    }
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(xp), 0) AS n FROM xp_ledger WHERE ${clauses.join(" AND ")}`)
      .get(...params) as { n: number };
    return row.n;
  }

  /** Most recent XP ledger entry whose reason starts with `reasonPrefix` (e.g. "quest:"). */
  latestXpLedger(chatId: number, reasonPrefix: string): { user_id: number; username: string | null; xp: number; reason: string; ts: number } | undefined {
    return this.db
      .prepare(
        `SELECT l.user_id AS user_id, x.username AS username, l.xp AS xp, l.reason AS reason, l.ts AS ts
         FROM xp_ledger l
         LEFT JOIN xp x ON x.chat_id = l.chat_id AND x.user_id = l.user_id
         WHERE l.chat_id = ? AND l.reason LIKE ?
         ORDER BY l.ts DESC
         LIMIT 1`
      )
      .get(chatId, `${reasonPrefix}%`) as { user_id: number; username: string | null; xp: number; reason: string; ts: number } | undefined;
  }

  // ── Content engine ─────────────────────────────────────────────────────

  addContentSuggestion(chatId: number, kind: string, signalKind: string, signal: string, text: string, ts = Math.floor(Date.now() / 1000)): number {
    const info = this.db
      .prepare(
        "INSERT INTO content_suggestions (chat_id, ts, kind, signal_kind, signal, text, status) VALUES (?, ?, ?, ?, ?, ?, 'proposed')"
      )
      .run(chatId, ts, kind, signalKind, signal, text);
    return Number(info.lastInsertRowid);
  }

  getContentSuggestion(id: number): ContentSuggestionRow | undefined {
    return this.db.prepare("SELECT * FROM content_suggestions WHERE id = ?").get(id) as ContentSuggestionRow | undefined;
  }

  listContentSuggestions(chatId: number, status?: string, limit = 20): ContentSuggestionRow[] {
    if (status) {
      return this.db
        .prepare("SELECT * FROM content_suggestions WHERE chat_id = ? AND status = ? ORDER BY ts DESC, id DESC LIMIT ?")
        .all(chatId, status, limit) as ContentSuggestionRow[];
    }
    return this.db
      .prepare("SELECT * FROM content_suggestions WHERE chat_id = ? ORDER BY ts DESC, id DESC LIMIT ?")
      .all(chatId, limit) as ContentSuggestionRow[];
  }

  /** Most recent suggestion for a signal kind since `sinceTs` — cooldown + re-surface check. */
  recentContentSuggestionByKind(chatId: number, signalKind: string, sinceTs: number): ContentSuggestionRow | undefined {
    return this.db
      .prepare("SELECT * FROM content_suggestions WHERE chat_id = ? AND signal_kind = ? AND ts >= ? ORDER BY ts DESC, id DESC LIMIT 1")
      .get(chatId, signalKind, sinceTs) as ContentSuggestionRow | undefined;
  }

  setContentSuggestionStatus(id: number, status: ContentSuggestionRow["status"]): boolean {
    const info = this.db.prepare("UPDATE content_suggestions SET status = ? WHERE id = ?").run(status, id);
    return info.changes > 0;
  }

  setSuggestionText(id: number, text: string): boolean {
    const info = this.db.prepare("UPDATE content_suggestions SET text = ? WHERE id = ?").run(text, id);
    return info.changes > 0;
  }

  publishContentSuggestion(id: number, publishedText: string, publishedAt = Math.floor(Date.now() / 1000)): boolean {
    const info = this.db
      .prepare("UPDATE content_suggestions SET status = 'published', published_at = ?, published_text = ? WHERE id = ?")
      .run(publishedAt, publishedText, id);
    return info.changes > 0;
  }

  addContentSchedule(chatId: number, suggestionId: number, scheduledAt: number, channel: "group" | "x" = "group"): number {
    const info = this.db
      .prepare("INSERT INTO content_schedule (chat_id, suggestion_id, scheduled_at, channel, status) VALUES (?, ?, ?, ?, 'pending') ON CONFLICT(suggestion_id) WHERE status = 'pending' DO UPDATE SET scheduled_at = excluded.scheduled_at, channel = excluded.channel")
      .run(chatId, suggestionId, scheduledAt, channel);
    const existing = this.db
      .prepare("SELECT id FROM content_schedule WHERE suggestion_id = ? AND status = 'pending'")
      .get(suggestionId) as { id: number } | undefined;
    if (!existing) throw new Error("content schedule upsert failed");
    return existing.id;
  }

  /** Pending schedule jobs due at or before `now`, joined with their suggestion text. */
  listDueContentSchedule(now: number): ContentScheduleDueRow[] {
    return this.db
      .prepare(
        `SELECT cs.*, sug.text AS suggestion_text, sug.kind AS suggestion_kind
         FROM content_schedule cs
         JOIN content_suggestions sug ON sug.id = cs.suggestion_id
         WHERE cs.status = 'pending' AND cs.scheduled_at <= ?
         ORDER BY cs.scheduled_at ASC`
      )
      .all(now) as ContentScheduleDueRow[];
  }

  listContentSchedule(chatId: number, status?: string, limit = 20): ContentScheduleRow[] {
    if (status) {
      return this.db
        .prepare("SELECT * FROM content_schedule WHERE chat_id = ? AND status = ? ORDER BY scheduled_at DESC LIMIT ?")
        .all(chatId, status, limit) as ContentScheduleRow[];
    }
    return this.db
      .prepare("SELECT * FROM content_schedule WHERE chat_id = ? ORDER BY scheduled_at DESC LIMIT ?")
      .all(chatId, limit) as ContentScheduleRow[];
  }

  setScheduleStatus(id: number, status: ContentScheduleRow["status"]): boolean {
    const info = this.db.prepare("UPDATE content_schedule SET status = ? WHERE id = ? AND status = 'pending'").run(status, id);
    return info.changes > 0;
  }

  addContentPerformance(chatId: number, suggestionId: number, measured: string, ts = Math.floor(Date.now() / 1000)): void {
    this.db
      .prepare("INSERT INTO content_performance (chat_id, suggestion_id, measured, label, ts) VALUES (?, ?, ?, 'SELF-REPORTED', ?)")
      .run(chatId, suggestionId, measured, ts);
  }

  getContentPerformance(suggestionId: number): ContentPerformanceRow | undefined {
    return this.db
      .prepare("SELECT * FROM content_performance WHERE suggestion_id = ? ORDER BY ts DESC LIMIT 1")
      .get(suggestionId) as ContentPerformanceRow | undefined;
  }

  // ── Insights ───────────────────────────────────────────────────────────

  addInsight(chatId: number, kind: InsightRow["kind"], payload: string): void {
    this.db
      .prepare("INSERT INTO insights (chat_id, ts, kind, payload) VALUES (?, ?, ?, ?)")
      .run(chatId, Math.floor(Date.now() / 1000), kind, payload);
  }

  latestInsight(chatId: number, kind: InsightRow["kind"]): InsightRow | undefined {
    return this.db
      .prepare("SELECT * FROM insights WHERE chat_id = ? AND kind = ? ORDER BY ts DESC LIMIT 1")
      .get(chatId, kind) as InsightRow | undefined;
  }

  /** Insights of a kind captured since `sinceTs`, newest first. */
  listInsightsSince(chatId: number, kind: InsightRow["kind"], sinceTs: number, limit = 50): InsightRow[] {
    return this.db
      .prepare("SELECT * FROM insights WHERE chat_id = ? AND kind = ? AND ts >= ? ORDER BY ts DESC LIMIT ?")
      .all(chatId, kind, sinceTs, limit) as InsightRow[];
  }

  close(): void {
    this.db.close();
  }
}
