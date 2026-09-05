/**
 * 🗄 APP DATABASE — schema for the trading app
 * Tables: users, wallets, trades, launches, profiles, follows, calls,
 * subscriptions, ad_campaigns, revenue_events, copy_settings
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { generateApiKey } from "../api/auth.js";

export class AppDb {
  private db: Database.Database;

  constructor(dbPath: string) {
    // better-sqlite3 creates the file but not its parent dir — ensure it exists
    // (matters for volume mounts like /data/raidos.db and local ./data/… paths)
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      -- Users (API-key auth; keys stored hashed, never plaintext)
      CREATE TABLE IF NOT EXISTS users (
        user_id INTEGER PRIMARY KEY,
        api_key_hash TEXT NOT NULL UNIQUE,
        ref_code TEXT UNIQUE,
        referred_by INTEGER,
        created_at INTEGER NOT NULL
      );

      -- Landing page waitlist (email capture)
      CREATE TABLE IF NOT EXISTS waitlist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );

      -- External identities (wallet addresses, Google, X) → user link
      CREATE TABLE IF NOT EXISTS identities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,          -- 'solana' | 'evm' | 'google' | 'x'
        external_id TEXT NOT NULL,       -- wallet address | google sub | x user id
        user_id INTEGER NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        avatar_url TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        UNIQUE(provider, external_id)
      );
      CREATE INDEX IF NOT EXISTS idx_identities_user ON identities(user_id);

      -- Wallets (encrypted private keys per user per chain)
      CREATE TABLE IF NOT EXISTS wallets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        chain TEXT NOT NULL,
        address TEXT NOT NULL,
        encrypted_key TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT 'Primary',
        is_primary INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        UNIQUE(user_id, chain, address)
      );
      CREATE INDEX IF NOT EXISTS idx_wallets_user ON wallets(user_id);

      -- Trades
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        from_chain TEXT NOT NULL,
        to_chain TEXT NOT NULL,
        sell_token TEXT NOT NULL,
        buy_token TEXT NOT NULL,
        sell_amount TEXT NOT NULL,
        buy_amount TEXT NOT NULL,
        sell_price_usdc TEXT NOT NULL DEFAULT '0',
        buy_price_usdc TEXT NOT NULL DEFAULT '0',
        fee_usdc TEXT NOT NULL DEFAULT '0',
        tx_hash TEXT NOT NULL DEFAULT '',
        launch_id INTEGER,
        copied_user_id INTEGER,
        realized_pnl_usdc TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_trades_user ON trades(user_id, ts DESC);
      CREATE INDEX IF NOT EXISTS idx_trades_chain ON trades(from_chain, ts DESC);

      -- Token launches
      CREATE TABLE IF NOT EXISTS launches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        creator_id INTEGER NOT NULL,
        chain TEXT NOT NULL,
        name TEXT NOT NULL,
        symbol TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        image_url TEXT NOT NULL DEFAULT '',
        token_address TEXT,
        bonding_curve_address TEXT,
        total_supply TEXT NOT NULL,
        current_price_usdc TEXT NOT NULL DEFAULT '1000',
        market_cap_usdc TEXT NOT NULL DEFAULT '1000000',
        raised_usdc TEXT NOT NULL DEFAULT '0',
        graduate_threshold TEXT NOT NULL,
        fee_paid TEXT NOT NULL DEFAULT '0',
        status TEXT NOT NULL DEFAULT 'created',
        buyers_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        graduated_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_launches_chain ON launches(chain, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_launches_creator ON launches(creator_id);

      -- Launch buyers
      CREATE TABLE IF NOT EXISTS launch_buyers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        launch_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        usdc_amount TEXT NOT NULL,
        token_amount TEXT NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_launch_buyers_launch ON launch_buyers(launch_id);

      -- Profiles
      CREATE TABLE IF NOT EXISTS profiles (
        user_id INTEGER PRIMARY KEY,
        x_handle TEXT,
        display_name TEXT NOT NULL DEFAULT '',
        avatar_url TEXT,
        bio TEXT NOT NULL DEFAULT '',
        followers_count INTEGER NOT NULL DEFAULT 0,
        following_count INTEGER NOT NULL DEFAULT 0,
        total_pnl_usdc TEXT NOT NULL DEFAULT '0',
        win_rate REAL NOT NULL DEFAULT 0,
        total_trades INTEGER NOT NULL DEFAULT 0,
        total_calls INTEGER NOT NULL DEFAULT 0,
        copy_trade_followers INTEGER NOT NULL DEFAULT 0,
        badges TEXT NOT NULL DEFAULT '[]',
        joined_at INTEGER NOT NULL
      );

      -- Follows
      CREATE TABLE IF NOT EXISTS follows (
        follower_id INTEGER NOT NULL,
        target_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (follower_id, target_id)
      );

      -- Trade calls (signals)
      CREATE TABLE IF NOT EXISTS calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token_address TEXT NOT NULL,
        token_symbol TEXT NOT NULL,
        chain TEXT NOT NULL,
        direction TEXT NOT NULL,
        entry_price TEXT NOT NULL,
        target_price TEXT NOT NULL,
        stop_loss TEXT,
        outcome TEXT NOT NULL DEFAULT 'pending',
        realized_pnl_usdc TEXT,
        text TEXT NOT NULL DEFAULT '',
        likes INTEGER NOT NULL DEFAULT 0,
        comments INTEGER NOT NULL DEFAULT 0,
        posted_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_calls_user ON calls(user_id, posted_at DESC);

      -- Subscriptions
      CREATE TABLE IF NOT EXISTS subscriptions (
        user_id INTEGER PRIMARY KEY,
        tier_id TEXT NOT NULL DEFAULT 'free',
        started_at INTEGER NOT NULL,
        expires_at INTEGER
      );

      -- Ad campaigns
      CREATE TABLE IF NOT EXISTS ad_campaigns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        advertiser_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        chain TEXT NOT NULL,
        budget_usdc TEXT NOT NULL,
        spent_usdc TEXT NOT NULL DEFAULT '0',
        impressions INTEGER NOT NULL DEFAULT 0,
        clicks INTEGER NOT NULL DEFAULT 0,
        token_address TEXT,
        starts_at INTEGER NOT NULL,
        ends_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
      );

      -- Revenue events
      CREATE TABLE IF NOT EXISTS revenue_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stream TEXT NOT NULL,
        user_id INTEGER NOT NULL DEFAULT 0,
        amount_usdc TEXT NOT NULL,
        ref_type TEXT NOT NULL DEFAULT '',
        ref_id INTEGER NOT NULL DEFAULT 0,
        meta TEXT NOT NULL DEFAULT '{}',
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_revenue_stream ON revenue_events(stream, ts DESC);
      CREATE INDEX IF NOT EXISTS idx_revenue_ts ON revenue_events(ts DESC);

      -- Copy-trade settings
      CREATE TABLE IF NOT EXISTS copy_settings (
        user_id INTEGER PRIMARY KEY,
        max_per_trade_usdc TEXT NOT NULL DEFAULT '10000000',
        max_total_usdc TEXT NOT NULL DEFAULT '50000000',
        enabled INTEGER NOT NULL DEFAULT 0,
        chains TEXT NOT NULL DEFAULT '["solana","ethereum","base"]'
      );

      -- Positions (swap build-ups per token per user; powers feed + PnL)
      -- NOTE: no UNIQUE(user,chain,token,status) — a user may reopen a position
      -- on the same token after closing one; each cycle gets its own row.
      CREATE TABLE IF NOT EXISTS positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        chain TEXT NOT NULL,
        token TEXT NOT NULL,
        token_symbol TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        amount_remaining TEXT NOT NULL DEFAULT '0',
        total_bought TEXT NOT NULL DEFAULT '0',
        total_sold TEXT NOT NULL DEFAULT '0',
        avg_entry_usdc TEXT NOT NULL DEFAULT '0',
        net_invested_usdc TEXT NOT NULL DEFAULT '0',
        realized_pnl_usdc TEXT,
        opened_at INTEGER NOT NULL,
        closed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_positions_user ON positions(user_id, status, opened_at DESC);
      CREATE INDEX IF NOT EXISTS idx_positions_token ON positions(chain, token, status);

      -- Feed events (social activity stream: swaps, positions, theses, follows)
      CREATE TABLE IF NOT EXISTS feed_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        actor_id INTEGER NOT NULL,
        chain TEXT NOT NULL DEFAULT '',
        token TEXT NOT NULL DEFAULT '',
        token_symbol TEXT NOT NULL DEFAULT '',
        payload TEXT NOT NULL DEFAULT '{}',
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_feed_ts ON feed_events(ts DESC);
      CREATE INDEX IF NOT EXISTS idx_feed_actor ON feed_events(actor_id, ts DESC);
      CREATE INDEX IF NOT EXISTS idx_feed_token ON feed_events(chain, token, ts DESC);

      -- Leaderboard snapshots per period
      CREATE TABLE IF NOT EXISTS leaderboard_snapshots (
        period TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        pnl_usdc TEXT NOT NULL,
        trades INTEGER NOT NULL DEFAULT 0,
        win_rate REAL NOT NULL DEFAULT 0,
        ts INTEGER NOT NULL,
        PRIMARY KEY (period, user_id)
      );
    `);
  }

  // ── User / auth methods ─────────────────────────────────────────────

  createUser(userId: number, apiKeyHash: string, refCode?: string, referredBy?: number) {
    this.db.prepare(
      "INSERT INTO users (user_id, api_key_hash, ref_code, referred_by, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(userId, apiKeyHash, refCode ?? null, referredBy ?? null, Math.floor(Date.now() / 1000));
  }

  getUserByApiKeyHash(apiKeyHash: string) {
    return this.db.prepare("SELECT * FROM users WHERE api_key_hash = ?").get(apiKeyHash) as any;
  }

  getUserById(userId: number) {
    return this.db.prepare("SELECT * FROM users WHERE user_id = ?").get(userId) as any;
  }

  getUserByRefCode(refCode: string) {
    return this.db.prepare("SELECT * FROM users WHERE ref_code = ?").get(refCode) as any;
  }

  countUsers(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
    return row.n;
  }

  /** Users referred by the given user, newest first. */
  getReferrals(userId: number, limit = 50, offset = 0) {
    return this.db.prepare(
      "SELECT user_id, ref_code, created_at FROM users WHERE referred_by = ? ORDER BY created_at DESC LIMIT ? OFFSET ?"
    ).all(userId, limit, offset) as any[];
  }

  countReferrals(userId: number): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE referred_by = ?").get(userId) as { n: number };
    return row.n;
  }

  // ── Waitlist methods ──────────────────────────────────────────────────

  addWaitlist(email: string): boolean {
    const info = this.db.prepare(
      "INSERT OR IGNORE INTO waitlist (email, created_at) VALUES (?, ?)"
    ).run(email.trim().toLowerCase(), Math.floor(Date.now() / 1000));
    return info.changes > 0;
  }

  countWaitlist(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM waitlist").get() as { n: number };
    return row.n;
  }

  // ── Identity methods (wallet / Google / X login) ──────────────────────

  /** Find the user linked to an external identity, or undefined. */
  getUserByIdentity(provider: string, externalId: string) {
    const row = this.db.prepare(
      "SELECT user_id FROM identities WHERE provider = ? AND external_id = ?"
    ).get(provider, externalId) as { user_id: number } | undefined;
    return row ? this.getUserById(row.user_id) : undefined;
  }

  /** Link an external identity to a user. Returns true when newly created. */
  createIdentity(provider: string, externalId: string, userId: number, displayName = "", avatarUrl = "") {
    const info = this.db.prepare(
      "INSERT OR IGNORE INTO identities (provider, external_id, user_id, display_name, avatar_url, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(provider, externalId, userId, displayName, avatarUrl, Math.floor(Date.now() / 1000));
    return info.changes > 0;
  }

  /** List the external identities linked to a user. */
  getUserIdentities(userId: number) {
    return this.db.prepare("SELECT provider, external_id, display_name, avatar_url FROM identities WHERE user_id = ?").all(userId) as any[];
  }

  /** Rotate a user's API key: returns the fresh plaintext key (hash stored). */
  rotateApiKey(userId: number): string {
    const { apiKey, keyHash } = generateApiKey();
    this.db.prepare("UPDATE users SET api_key_hash = ? WHERE user_id = ?").run(keyHash, userId);
    return apiKey;
  }

  // ── Wallet methods ────────────────────────────────────────────────────

  getWallet(userId: number, chain: string) {
    return this.db.prepare("SELECT * FROM wallets WHERE user_id = ? AND chain = ? AND is_primary = 1").get(userId, chain) as any;
  }

  getUserWallets(userId: number) {
    return this.db.prepare("SELECT * FROM wallets WHERE user_id = ? ORDER BY is_primary DESC, created_at DESC").all(userId) as any[];
  }

  createWallet(userId: number, chain: string, address: string, encryptedKey: any, label: string, isPrimary: number) {
    const info = this.db.prepare(
      "INSERT INTO wallets (user_id, chain, address, encrypted_key, label, is_primary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(userId, chain, address, JSON.stringify(encryptedKey), label, isPrimary, Math.floor(Date.now() / 1000));
    return Number(info.lastInsertRowid);
  }

  deleteWallet(walletId: number, userId: number) {
    const info = this.db.prepare("DELETE FROM wallets WHERE id = ? AND user_id = ?").run(walletId, userId);
    return info.changes > 0;
  }

  setPrimaryWallet(userId: number, chain: string, walletId: number) {
    this.db.prepare("UPDATE wallets SET is_primary = 0 WHERE user_id = ? AND chain = ?").run(userId, chain);
    this.db.prepare("UPDATE wallets SET is_primary = 1 WHERE id = ? AND user_id = ?").run(walletId, userId);
  }

  // ── Launch methods ────────────────────────────────────────────────────

  createLaunch(input: any) {
    const cols = Object.keys(input);
    const placeholders = cols.map(() => "?").join(", ");
    const values = cols.map((c) => {
      const v = (input as any)[c];
      // null must stay SQL NULL — typeof null === "object" would store "null" strings
      return v === null ? null : typeof v === "object" ? JSON.stringify(v) : v;
    });
    const info = this.db.prepare(
      `INSERT INTO launches (${cols.join(", ")}) VALUES (${placeholders})`
    ).run(...values);
    return Number(info.lastInsertRowid);
  }

  getLaunch(id: number) {
    return this.db.prepare("SELECT * FROM launches WHERE id = ?").get(id) as any;
  }

  listLaunches(chain: string, status?: string, limit = 20) {
    if (status) {
      return this.db.prepare("SELECT * FROM launches WHERE chain = ? AND status = ? ORDER BY created_at DESC LIMIT ?").all(chain, status, limit) as any[];
    }
    return this.db.prepare("SELECT * FROM launches WHERE chain = ? ORDER BY created_at DESC LIMIT ?").all(chain, limit) as any[];
  }

  /** All launches across chains, optionally filtered, with a sort key.
   *  Sorts: latest (default) | raised (most raised) | buyers (most buyers) | price. */
  listAllLaunches(status?: string, sort = "latest", limit = 30) {
    const orderBy = sort === "raised" ? "CAST(raised_usdc AS INTEGER) DESC"
      : sort === "buyers" ? "buyers_count DESC, created_at DESC"
      : sort === "price" ? "CAST(current_price_usdc AS INTEGER) DESC, created_at DESC"
      : "created_at DESC";
    if (status) {
      return this.db.prepare(`SELECT * FROM launches WHERE status = ? ORDER BY ${orderBy} LIMIT ?`).all(status, limit) as any[];
    }
    return this.db.prepare(`SELECT * FROM launches ORDER BY ${orderBy} LIMIT ?`).all(limit) as any[];
  }

  listLaunchesByUser(userId: number, limit = 20) {
    return this.db.prepare("SELECT * FROM launches WHERE creator_id = ? ORDER BY created_at DESC LIMIT ?").all(userId, limit) as any[];
  }

  updateLaunch(id: number, updates: Record<string, any>) {
    const sets = Object.keys(updates).map((k) => `${k} = ?`).join(", ");
    const values = Object.values(updates).map((v) => v === null ? null : typeof v === "object" ? JSON.stringify(v) : v);
    this.db.prepare(`UPDATE launches SET ${sets} WHERE id = ?`).run(...values, id);
  }

  addLaunchBuyer(launchId: number, userId: number, usdcAmount: string, tokenAmount: string) {
    this.db.prepare(
      "INSERT INTO launch_buyers (launch_id, user_id, usdc_amount, token_amount, ts) VALUES (?, ?, ?, ?, ?)"
    ).run(launchId, userId, usdcAmount, tokenAmount, Math.floor(Date.now() / 1000));
  }

  // ── Profile methods ───────────────────────────────────────────────────

  getProfile(userId: number) {
    return this.db.prepare("SELECT * FROM profiles WHERE user_id = ?").get(userId) as any;
  }

  updateProfile(userId: number, updates: Record<string, any>) {
    const existing = this.getProfile(userId);
    if (!existing) {
      const cols = ["user_id", "joined_at", ...Object.keys(updates)];
      const vals = [userId, Math.floor(Date.now() / 1000), ...Object.values(updates)];
      const placeholders = cols.map(() => "?").join(", ");
      // Map camelCase keys to snake_case DB columns
      const colMap: Record<string, string> = { xHandle: 'x_handle', displayName: 'display_name', avatarUrl: 'avatar_url', followersCount: 'followers_count', followingCount: 'following_count', totalPnlUsdc: 'total_pnl_usdc', winRate: 'win_rate', totalTrades: 'total_trades', totalCalls: 'total_calls', copyTradeFollowers: 'copy_trade_followers', joinedAt: 'joined_at' };
      const dbCols = cols.map((c) => colMap[c] ?? c);
      const placeholders2 = dbCols.map(() => "?").join(", ");
      this.db.prepare(`INSERT INTO profiles (${dbCols.join(", ")}) VALUES (${placeholders2})`).run(...vals);
    } else {
      const colMap2: Record<string, string> = { xHandle: 'x_handle', displayName: 'display_name', avatarUrl: 'avatar_url', followersCount: 'followers_count', followingCount: 'following_count', totalPnlUsdc: 'total_pnl_usdc', winRate: 'win_rate', totalTrades: 'total_trades', totalCalls: 'total_calls', copyTradeFollowers: 'copy_trade_followers', joinedAt: 'joined_at' };
      const sets = Object.keys(updates).map((k) => `${colMap2[k] ?? k} = ?`).join(", ");
      const vals = Object.values(updates);
      this.db.prepare(`UPDATE profiles SET ${sets} WHERE user_id = ?`).run(...vals, userId);
    }
  }

  follow(followerId: number, targetId: number) {
    const info = this.db.prepare("INSERT OR IGNORE INTO follows (follower_id, target_id, created_at) VALUES (?, ?, ?)").run(followerId, targetId, Math.floor(Date.now() / 1000));
    if (info.changes > 0) {
      this.db.prepare("UPDATE profiles SET followers_count = followers_count + 1 WHERE user_id = ?").run(targetId);
      this.db.prepare("UPDATE profiles SET following_count = following_count + 1 WHERE user_id = ?").run(followerId);
    }
    return info.changes > 0;
  }

  unfollow(followerId: number, targetId: number) {
    const info = this.db.prepare("DELETE FROM follows WHERE follower_id = ? AND target_id = ?").run(followerId, targetId);
    if (info.changes > 0) {
      this.db.prepare("UPDATE profiles SET followers_count = MAX(0, followers_count - 1) WHERE user_id = ?").run(targetId);
      this.db.prepare("UPDATE profiles SET following_count = MAX(0, following_count - 1) WHERE user_id = ?").run(followerId);
    }
    return info.changes > 0;
  }

  isFollowing(followerId: number, targetId: number) {
    return !!this.db.prepare("SELECT 1 FROM follows WHERE follower_id = ? AND target_id = ?").get(followerId, targetId);
  }

  getFollowers(userId: number, limit = 50) {
    return this.db.prepare(
      "SELECT p.* FROM profiles p JOIN follows f ON f.follower_id = p.user_id WHERE f.target_id = ? ORDER BY f.created_at DESC LIMIT ?"
    ).all(userId, limit) as any[];
  }

  getFollowing(userId: number, limit = 50) {
    return this.db.prepare(
      "SELECT p.* FROM profiles p JOIN follows f ON f.target_id = p.user_id WHERE f.follower_id = ? ORDER BY f.created_at DESC LIMIT ?"
    ).all(userId, limit) as any[];
  }

  // ── Calls ─────────────────────────────────────────────────────────────

  createCall(input: any) {
    const info = this.db.prepare(
      "INSERT INTO calls (user_id, token_address, token_symbol, chain, direction, entry_price, target_price, stop_loss, outcome, realized_pnl_usdc, text, posted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(input.userId, input.tokenAddress, input.tokenSymbol, input.chain, input.direction, input.entryPrice, input.targetPrice, input.stopLoss ?? null, input.outcome, input.pnlUsdc ?? null, input.text, input.postedAt);
    return Number(info.lastInsertRowid);
  }

  getCall(callId: number) {
    return this.db.prepare("SELECT * FROM calls WHERE id = ?").get(callId) as any;
  }

  listUserCalls(userId: number, limit = 20) {
    return this.db.prepare("SELECT * FROM calls WHERE user_id = ? ORDER BY posted_at DESC LIMIT ?").all(userId, limit) as any[];
  }

  likeCall(userId: number, callId: number) {
    const info = this.db.prepare("UPDATE calls SET likes = likes + 1 WHERE id = ?").run(callId);
    return info.changes > 0;
  }

  getTopTraders(chain: string, limit = 20) {
    return this.db.prepare(
      `SELECT p.user_id, p.x_handle, p.display_name, p.avatar_url, p.total_pnl_usdc, p.win_rate, p.total_trades, p.followers_count
       FROM profiles p
       WHERE p.total_trades > 0
       ORDER BY CAST(p.total_pnl_usdc AS INTEGER) DESC
       LIMIT ?`
    ).all(limit) as any[];
  }

  // ── Search (fuzzy tokens + users, fomo-style) ──────────────────────

  searchUsers(term: string, limit = 10) {
    const like = `%${term}%`;
    return this.db.prepare(
      `SELECT user_id, x_handle, display_name, avatar_url, followers_count, total_pnl_usdc, win_rate, total_trades
       FROM profiles
       WHERE x_handle LIKE ? OR display_name LIKE ?
       ORDER BY followers_count DESC LIMIT ?`
    ).all(like, like, limit) as any[];
  }

  searchLaunches(term: string, limit = 10) {
    const like = `%${term}%`;
    return this.db.prepare(
      `SELECT * FROM launches
       WHERE name LIKE ? OR symbol LIKE ?
       ORDER BY CAST(raised_usdc AS INTEGER) DESC LIMIT ?`
    ).all(like, like, limit) as any[];
  }

  // ── Revenue ───────────────────────────────────────────────────────────

  addRevenueEvent(event: any) {
    const info = this.db.prepare(
      "INSERT INTO revenue_events (stream, user_id, amount_usdc, ref_type, ref_id, meta, ts) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(event.stream, event.userId, event.amountUsdc, event.refType, event.refId, event.meta, event.ts);
    return Number(info.lastInsertRowid);
  }

  getRevenueByStream(stream: string, since: number) {
    return this.db.prepare("SELECT * FROM revenue_events WHERE stream = ? AND ts >= ? ORDER BY ts DESC").all(stream, since) as any[];
  }

  getRevenueByUser(userId: number, since = 0) {
    if (since > 0) {
      return this.db.prepare("SELECT * FROM revenue_events WHERE user_id = ? AND ts >= ? ORDER BY ts DESC").all(userId, since) as any[];
    }
    return this.db.prepare("SELECT * FROM revenue_events WHERE user_id = ? ORDER BY ts DESC").all(userId) as any[];
  }

  getTotalRevenue(since: number) {
    const row = this.db.prepare("SELECT COALESCE(SUM(CAST(amount_usdc AS INTEGER)), 0) AS total FROM revenue_events WHERE ts >= ?").get(since) as { total: number };
    return String(row.total);
  }

  getUserSubscription(userId: number) {
    const row = this.db.prepare("SELECT tier_id FROM subscriptions WHERE user_id = ?").get(userId) as { tier_id: string } | undefined;
    return row?.tier_id;
  }

  setUserSubscription(userId: number, tierId: string) {
    this.db.prepare(
      "INSERT INTO subscriptions (user_id, tier_id, started_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET tier_id = excluded.tier_id, started_at = excluded.started_at"
    ).run(userId, tierId, Math.floor(Date.now() / 1000));
  }

  addAdCampaign(input: any) {
    const info = this.db.prepare(
      "INSERT INTO ad_campaigns (advertiser_id, type, chain, budget_usdc, token_address, starts_at, ends_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(input.advertiserId, input.type, input.chain, input.budgetUsdc, input.tokenAddress ?? null, input.startsAt, input.endsAt, "active");
    return Number(info.lastInsertRowid);
  }

  recordAdImpression(campaignId: number) {
    this.db.prepare("UPDATE ad_campaigns SET impressions = impressions + 1, spent_usdc = CAST(CAST(spent_usdc AS INTEGER) + 1000 AS TEXT) WHERE id = ?").run(campaignId);
  }

  recordAdClick(campaignId: number) {
    this.db.prepare("UPDATE ad_campaigns SET clicks = clicks + 1, spent_usdc = CAST(CAST(spent_usdc AS INTEGER) + 10000 AS TEXT) WHERE id = ?").run(campaignId);
  }

  // ── Trade methods ─────────────────────────────────────────────────────

  addTrade(trade: any) {
    const cols = Object.keys(trade);
    const placeholders = cols.map(() => "?").join(", ");
    const values = Object.values(trade).map((v) => v === null ? null : typeof v === "object" ? JSON.stringify(v) : v);
    const info = this.db.prepare(`INSERT INTO trades (${cols.join(", ")}) VALUES (${placeholders})`).run(...values);
    return Number(info.lastInsertRowid);
  }

  getTrade(id: number) {
    return this.db.prepare("SELECT * FROM trades WHERE id = ?").get(id) as any;
  }

  getUserTrades(userId: number, limit = 50, offset = 0) {
    return this.db.prepare("SELECT * FROM trades WHERE user_id = ? ORDER BY ts DESC LIMIT ? OFFSET ?").all(userId, limit, offset) as any[];
  }

  getUserPnl(userId: number) {
    const trades = this.db.prepare("SELECT * FROM trades WHERE user_id = ? AND status = 'confirmed'").all(userId) as any[];
    let totalPnl = 0n;
    let wins = 0;
    let losses = 0;
    let totalVolume = 0n;
    let totalFees = 0n;
    let bestTrade = 0n;
    let worstTrade = 0n;

    for (const t of trades) {
      const pnlRaw = t.realized_pnl_usdc;
      const pnl = BigInt(pnlRaw != null && pnlRaw !== "null" ? pnlRaw : "0");
      totalPnl += pnl;
      if (pnl > 0n) wins++;
      if (pnl < 0n) losses++;
      totalVolume += BigInt(t.sell_amount);
      totalFees += BigInt(t.fee_usdc);
      if (pnl > bestTrade) bestTrade = pnl;
      if (pnl < worstTrade) worstTrade = pnl;
    }

    return {
      userId,
      totalPnlUsdc: totalPnl.toString(),
      pnlByChain: {},
      winRate: trades.length > 0 ? (wins / trades.length) * 100 : 0,
      totalTrades: trades.length,
      winningTrades: wins,
      losingTrades: losses,
      bestTradePnlUsdc: bestTrade.toString(),
      worstTradePnlUsdc: worstTrade.toString(),
      totalFeesUsdc: totalFees.toString(),
      volumeUsdc: totalVolume.toString(),
      avgTradeSizeUsdc: trades.length > 0 ? (totalVolume / BigInt(trades.length)).toString() : "0",
      pnlByToken: this.computePnlByToken(trades),
    };
  }

  /** Per-token realized PnL + holdings derived from confirmed trades.
   *  Convention: buy amounts are in buyToken units, sell amounts in sellToken units;
   *  USDC legs are excluded (they are the quote asset, not a holding). */
  private computePnlByToken(trades: any[]): Record<string, { balance: string; realizedPnlUsdc: string }> {
    const byToken: Record<string, { bal: bigint; pnl: bigint }> = {};
    for (const t of trades) {
      const sell = t.sell_token;
      const buy = t.buy_token;
      if (sell && sell.toUpperCase() !== "USDC") {
        const entry = (byToken[sell] ??= { bal: 0n, pnl: 0n });
        entry.bal -= BigInt(t.sell_amount);
        entry.pnl += BigInt(t.realized_pnl_usdc ?? "0");
      }
      if (buy && buy.toUpperCase() !== "USDC") {
        const entry = (byToken[buy] ??= { bal: 0n, pnl: 0n });
        entry.bal += BigInt(t.buy_amount);
        entry.pnl += BigInt(t.realized_pnl_usdc ?? "0");
      }
    }
    const out: Record<string, { balance: string; realizedPnlUsdc: string }> = {};
    for (const [token, v] of Object.entries(byToken)) {
      out[token] = { balance: v.bal.toString(), realizedPnlUsdc: v.pnl.toString() };
    }
    return out;
  }

  getChainPnl(userId: number, chain: string) {
    const trades = this.db.prepare("SELECT * FROM trades WHERE user_id = ? AND from_chain = ? AND status = 'confirmed'").all(userId, chain) as any[];
    let totalPnl = 0n;
    let wins = 0;
    for (const t of trades) {
      const pnlRaw = t.realized_pnl_usdc;
      const pnl = BigInt(pnlRaw != null && pnlRaw !== "null" ? pnlRaw : "0");
      totalPnl += pnl;
      if (pnl > 0n) wins++;
    }
    return {
      userId,
      totalPnlUsdc: totalPnl.toString(),
      pnlByChain: { [chain]: totalPnl.toString() },
      winRate: trades.length > 0 ? (wins / trades.length) * 100 : 0,
      totalTrades: trades.length,
      winningTrades: wins,
      losingTrades: trades.length - wins,
      bestTradePnlUsdc: "0",
      worstTradePnlUsdc: "0",
      totalFeesUsdc: "0",
      volumeUsdc: "0",
      avgTradeSizeUsdc: "0",
    };
  }

  getRecentActivity(userId: number, limit = 20) {
    const trades = this.db.prepare("SELECT type, from_chain, sell_token, buy_token, sell_amount, buy_amount, realized_pnl_usdc, ts FROM trades WHERE user_id = ? ORDER BY ts DESC LIMIT ?").all(userId, limit) as any[];
    return trades.map((t: any) => ({
      type: "trade" as const,
      summary: `${t.type} ${t.sell_token} → ${t.buy_token}`,
      chain: t.from_chain,
      pnlUsdc: t.realized_pnl_usdc,
      ts: t.ts,
    }));
  }

  getTopPerformers(chain: string, since: number, limit = 10) {
    return this.db.prepare(
      `SELECT user_id, SUM(CAST(realized_pnl_usdc AS INTEGER)) AS pnl_usdc, COUNT(*) AS trades
       FROM trades WHERE from_chain = ? AND ts >= ? AND status = 'confirmed'
       GROUP BY user_id ORDER BY pnl_usdc DESC LIMIT ?`
    ).all(chain, since, limit) as any[];
  }

  // ── Positions ─────────────────────────────────────────────────────────

  getOpenPosition(userId: number, chain: string, token: string) {
    return this.db.prepare(
      "SELECT * FROM positions WHERE user_id = ? AND chain = ? AND token = ? AND status = 'open'"
    ).get(userId, chain, token) as any;
  }

  upsertPosition(p: any) {
    if (p.id) {
      const sets = ["status", "amount_remaining", "total_bought", "total_sold", "avg_entry_usdc", "net_invested_usdc", "realized_pnl_usdc", "closed_at"]
        .map((k) => `${k} = ?`).join(", ");
      this.db.prepare(`UPDATE positions SET ${sets} WHERE id = ?`).run(
        p.status, p.amount_remaining, p.total_bought, p.total_sold,
        p.avg_entry_usdc, p.net_invested_usdc, p.realized_pnl_usdc, p.closed_at, p.id,
      );
      return p.id;
    }
    const info = this.db.prepare(
      `INSERT INTO positions (user_id, chain, token, token_symbol, status, amount_remaining,
        total_bought, total_sold, avg_entry_usdc, net_invested_usdc, realized_pnl_usdc, opened_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(p.user_id, p.chain, p.token, p.token_symbol, p.status, p.amount_remaining,
      p.total_bought, p.total_sold, p.avg_entry_usdc, p.net_invested_usdc,
      p.realized_pnl_usdc, p.opened_at, p.closed_at);
    return Number(info.lastInsertRowid);
  }

  getUserPositions(userId: number, status: string | null, limit = 50) {
    if (status) {
      return this.db.prepare(
        "SELECT * FROM positions WHERE user_id = ? AND status = ? ORDER BY opened_at DESC LIMIT ?"
      ).all(userId, status, limit) as any[];
    }
    return this.db.prepare(
      "SELECT * FROM positions WHERE user_id = ? ORDER BY opened_at DESC LIMIT ?"
    ).all(userId, limit) as any[];
  }

  // ── Feed ─────────────────────────────────────────────────────────────

  addFeedEvent(e: { type: string; actor_id: number; chain?: string; token?: string; token_symbol?: string; payload?: any; ts: number }) {
    const info = this.db.prepare(
      "INSERT INTO feed_events (type, actor_id, chain, token, token_symbol, payload, ts) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(e.type, e.actor_id, e.chain ?? "", e.token ?? "", e.token_symbol ?? "",
      typeof e.payload === "string" ? e.payload : JSON.stringify(e.payload ?? {}), e.ts);
    return Number(info.lastInsertRowid);
  }

  getFeed(opts: { sinceId?: number; limit?: number; chain?: string; token?: string; actorId?: number } = {}) {
    const limit = Math.min(opts.limit ?? 30, 100);
    const clauses: string[] = [];
    const args: any[] = [];
    if (opts.sinceId !== undefined) { clauses.push("id > ?"); args.push(opts.sinceId); }
    if (opts.chain) { clauses.push("chain = ?"); args.push(opts.chain); }
    if (opts.token) { clauses.push("token = ?"); args.push(opts.token); }
    if (opts.actorId !== undefined) { clauses.push("actor_id = ?"); args.push(opts.actorId); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db.prepare(
      `SELECT * FROM feed_events ${where} ORDER BY id DESC LIMIT ?`
    ).all(...args, limit) as any[];
  }

  getFeedMaxId(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM feed_events").get() as { m: number };
    return row.m;
  }

  // ── Leaderboard snapshots ────────────────────────────────────────────

  saveLeaderboardSnapshot(period: string, rows: { user_id: number; pnl_usdc: string; trades: number; win_rate: number }[]) {
    const now = Math.floor(Date.now() / 1000);
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO leaderboard_snapshots (period, user_id, pnl_usdc, trades, win_rate, ts) VALUES (?, ?, ?, ?, ?, ?)"
    );
    const tx = this.db.transaction((rows2: any[]) => {
      for (const r of rows2) stmt.run(period, r.user_id, r.pnl_usdc, r.trades, r.win_rate, now);
    });
    tx(rows);
  }

  getLeaderboardByPeriod(period: string, limit = 20) {
    return this.db.prepare(
      `SELECT l.user_id, l.pnl_usdc, l.trades, l.win_rate, p.display_name, p.x_handle, p.avatar_url, p.followers_count
       FROM leaderboard_snapshots l LEFT JOIN profiles p ON p.user_id = l.user_id
       WHERE l.period = ? ORDER BY CAST(l.pnl_usdc AS INTEGER) DESC LIMIT ?`
    ).all(period, limit) as any[];
  }

  /** Recompute per-period PnL from confirmed trades (used to refresh snapshots). */
  getPnlSince(since: number, limit = 25) {
    return this.db.prepare(
      `SELECT user_id,
              SUM(CAST(COALESCE(NULLIF(realized_pnl_usdc,'null'), '0') AS INTEGER)) AS pnl_usdc,
              COUNT(*) AS trades,
              AVG(CASE WHEN CAST(COALESCE(NULLIF(realized_pnl_usdc,'null'),'0') AS INTEGER) > 0 THEN 1.0 ELSE 0.0 END) AS win_rate
       FROM trades WHERE status = 'confirmed' AND ts >= ?
       GROUP BY user_id ORDER BY pnl_usdc DESC LIMIT ?`
    ).all(since, limit) as any[];
  }

  // ── Copy settings ─────────────────────────────────────────────────────

  getCopySettings(userId: number) {
    return this.db.prepare("SELECT * FROM copy_settings WHERE user_id = ?").get(userId) as any;
  }

  setCopySettings(userId: number, settings: any) {
    this.db.prepare(
      "INSERT INTO copy_settings (user_id, max_per_trade_usdc, max_total_usdc, enabled, chains) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET max_per_trade_usdc = excluded.max_per_trade_usdc, max_total_usdc = excluded.max_total_usdc, enabled = excluded.enabled, chains = excluded.chains"
    ).run(userId, settings.maxPerTradeUsdc, settings.maxTotalUsdc, settings.enabled ? 1 : 0, JSON.stringify(settings.chains));
  }

  close(): void {
    this.db.close();
  }
}
