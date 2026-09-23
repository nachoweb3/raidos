import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import bs58 from "bs58";
import type { MarketSnapshot } from "./data.js";

/** Market coverage is independent of the trading chain registry. */
export const MARKET_CHAINS = ["solana", "ethereum", "base", "bsc", "arc"];
export function assetAddress(chain: string, address: string): string {
  if (!MARKET_CHAINS.includes(chain)) throw new Error("invalid market chain");
  if (typeof address !== "string") throw new Error("invalid contract address");
  if (chain === "solana") {
    try { if (bs58.decode(address).length === 32) return address; } catch { /* Invalid base58. */ }
  } else if (/^0x[0-9a-fA-F]{40}$/.test(address)) return address.toLowerCase();
  throw new Error("invalid contract address");
}
const numberOrNull = (v: unknown): number | null => v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
const nonnegative = (v: unknown): number | null => { const n = numberOrNull(v); return n !== null && n >= 0 ? n : null; };

export interface CatalogQuery {
  chain?: string; q?: string; limit?: number; cursor?: string;
  sort?: "indexed" | "newest" | "liquidity" | "volume" | "marketCap" | "marketCapAsc";
  maxAgeHours?: number;
  minLiquidity?: number; maxLiquidity?: number; minPrice?: number; maxPrice?: number;
  minMarketCap?: number; maxMarketCap?: number; minVolume?: number; maxVolume?: number;
}
export interface MarketJob {
  job_key: string; kind: "discover" | "refresh"; payload: string;
  attempts: number; lease_token: string; lease_until: number;
}

/** Display-only market projections. No market row authorizes a transaction. */
export class MarketCatalog {
  constructor(private readonly db: Database.Database, private readonly now = Date.now) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS market_schema (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS market_assets (
        id INTEGER PRIMARY KEY AUTOINCREMENT, chain TEXT NOT NULL, address TEXT NOT NULL,
        name TEXT NOT NULL, symbol TEXT NOT NULL, decimals INTEGER,
        first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
        UNIQUE(chain,address)
      );
      CREATE TABLE IF NOT EXISTS market_pools (
        asset_id INTEGER NOT NULL REFERENCES market_assets(id), address TEXT NOT NULL,
        price REAL, liquidity REAL, market_cap REAL, volume REAL, created_at REAL,
        source TEXT NOT NULL, as_of INTEGER NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY(asset_id,address)
      );
      CREATE INDEX IF NOT EXISTS idx_market_pools_asset_liquidity ON market_pools(asset_id,liquidity DESC);
      CREATE INDEX IF NOT EXISTS idx_market_assets_chain_id ON market_assets(chain,id);
      CREATE INDEX IF NOT EXISTS idx_market_assets_symbol ON market_assets(symbol COLLATE NOCASE);
      CREATE TABLE IF NOT EXISTS market_jobs (
        job_key TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL,
        due_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
        last_success INTEGER, last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_market_jobs_due ON market_jobs(due_at,lease_until);
    `);
    db.prepare("INSERT OR IGNORE INTO market_schema(version,applied_at) VALUES(1,?)").run(now());
    const columns = db.prepare("PRAGMA table_info(market_pools)").all() as { name: string }[];
    if (!columns.some((c) => c.name === "created_at")) {
      db.exec("ALTER TABLE market_pools ADD COLUMN created_at REAL");
      db.exec("UPDATE market_pools SET created_at=json_extract(payload,'$.pairCreatedAt') WHERE json_valid(payload)");
    }
    db.prepare("INSERT OR IGNORE INTO market_schema(version,applied_at) VALUES(2,?)").run(now());
  }

  ingest(snapshot: MarketSnapshot<any[]>): { accepted: number; skipped: number } {
    if (!Array.isArray(snapshot.data) || !Number.isSafeInteger(snapshot.asOf) || snapshot.asOf <= 0 || snapshot.asOf > this.now() + 60000) {
      throw new Error("invalid market snapshot");
    }
    const asset = this.db.prepare(`INSERT INTO market_assets(chain,address,name,symbol,decimals,first_seen,last_seen)
      VALUES(@chain,@address,@name,@symbol,@decimals,@asOf,@asOf)
      ON CONFLICT(chain,address) DO UPDATE SET name=excluded.name,symbol=excluded.symbol,
        decimals=COALESCE(excluded.decimals,market_assets.decimals),last_seen=excluded.last_seen
      WHERE excluded.last_seen >= market_assets.last_seen`);
    const pool = this.db.prepare(`INSERT INTO market_pools(asset_id,address,price,liquidity,market_cap,volume,created_at,source,as_of,status,payload)
      VALUES(@id,@pool,@price,@liquidity,@marketCap,@volume,@createdAt,@source,@asOf,@status,@payload)
      ON CONFLICT(asset_id,address) DO UPDATE SET price=excluded.price,liquidity=excluded.liquidity,
        market_cap=excluded.market_cap,volume=excluded.volume,created_at=excluded.created_at,source=excluded.source,
        as_of=excluded.as_of,status=excluded.status,payload=excluded.payload
      WHERE excluded.as_of >= market_pools.as_of`);
    return this.db.transaction(() => {
      let accepted = 0, skipped = 0;
      for (const p of snapshot.data) {
        let address: string, poolAddress: string;
        try {
          address = assetAddress(p.chainId, p.baseToken?.address);
          poolAddress = assetAddress(p.chainId, p.pairAddress);
        } catch { skipped++; continue; }
        const asOf = p.marketAsOf ?? snapshot.asOf;
        const source = p.source ?? snapshot.source;
        if (!Number.isSafeInteger(asOf) || asOf <= 0 || asOf > this.now() + 60000 || !["dexscreener", "geckoterminal"].includes(source)) {
          skipped++; continue;
        }
        const decimals = Number.isInteger(p.baseToken.decimals) && p.baseToken.decimals >= 0 && p.baseToken.decimals <= 255 ? p.baseToken.decimals : null;
        asset.run({ chain: p.chainId, address, name: String(p.baseToken.name ?? "").slice(0, 200),
          symbol: String(p.baseToken.symbol ?? "").slice(0, 80), decimals, asOf });
        const { id } = this.db.prepare("SELECT id FROM market_assets WHERE chain=? AND address=?").get(p.chainId, address) as { id: number };
        const status = p.marketStatus === "DEGRADED" || snapshot.status === "DEGRADED" ? "DEGRADED" : "LIVE";
        const normalized = { ...p, baseToken: { ...p.baseToken, address, decimals }, source, marketAsOf: asOf, marketStatus: status };
        pool.run({ id, pool: poolAddress, price: nonnegative(p.priceUsd), liquidity: nonnegative(p.liquidity?.usd),
          marketCap: nonnegative(p.marketCap), volume: nonnegative(p.volume?.h24), createdAt: nonnegative(p.pairCreatedAt), source, asOf, status,
          payload: JSON.stringify(normalized) });
        this.enqueue(`refresh:${p.chainId}:${address}`, "refresh", { chain: p.chainId, address }, this.now() + 300000);
        accepted++;
      }
      return { accepted, skipped };
    })();
  }

  list(query: CatalogQuery = {}) {
    const limit = query.limit ?? 40;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid catalog limit (1-100)");
    const chain = query.chain === "all" ? undefined : query.chain;
    if (chain && !MARKET_CHAINS.includes(chain)) throw new Error("invalid market chain");
    const q = (query.q ?? "").trim();
    if (q.length > 128) throw new Error("invalid catalog search");
    // Historical rows remain stored but disabled networks are excluded from discovery.
    const clauses: string[] = [`a.chain IN (${MARKET_CHAINS.map(() => "?").join(",")})`], values: unknown[] = [...MARKET_CHAINS];
    const bounds: Array<[keyof CatalogQuery, string, string]> = [
      ["minLiquidity", "liquidity", ">="], ["maxLiquidity", "liquidity", "<="],
      ["minPrice", "price", ">="], ["maxPrice", "price", "<="],
      ["minMarketCap", "market_cap", ">="], ["maxMarketCap", "market_cap", "<="],
      ["minVolume", "volume", ">="], ["maxVolume", "volume", "<="],
    ];
    const sorts = { indexed: ["a.id", "ASC"], newest: ["COALESCE(p.created_at,-1)", "DESC"],
      liquidity: ["COALESCE(p.liquidity,-1)", "DESC"], volume: ["COALESCE(p.volume,-1)", "DESC"],
      marketCap: ["COALESCE(p.market_cap,-1)", "DESC"], marketCapAsc: ["COALESCE(p.market_cap,1e308)", "ASC"] } as const;
    const sort = query.sort ?? "indexed";
    if (!Object.hasOwn(sorts, sort)) throw new Error("invalid catalog sort");
    const [sortColumn, direction] = sorts[sort];
    const filters: Record<string, unknown> = { chain: chain ?? "all", q, sort };
    if (query.maxAgeHours !== undefined) {
      if (!Number.isFinite(query.maxAgeHours) || query.maxAgeHours < 0 || query.maxAgeHours > 876000) throw new Error("invalid age filter");
      filters.maxAgeHours = query.maxAgeHours;
    }
    for (const [key, column, op] of bounds) {
      const v = query[key]; if (v === undefined) continue;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error("invalid catalog filter");
      clauses.push(`p.${column} ${op} ?`); values.push(v); filters[key] = v;
    }
    for (const [min, max] of [["minLiquidity", "maxLiquidity"], ["minPrice", "maxPrice"], ["minMarketCap", "maxMarketCap"], ["minVolume", "maxVolume"]] as const) {
      if (query[min] !== undefined && query[max] !== undefined && query[min]! > query[max]!) throw new Error("invalid filter range");
    }
    const fingerprint = createHash("sha256").update(JSON.stringify(filters)).digest("hex");
    let last = 0, lastValue = 0, queryAt = this.now(), ceiling = (this.db.prepare("SELECT COALESCE(MAX(id),0) AS n FROM market_assets").get() as { n: number }).n;
    if (query.cursor) {
      try {
        if (query.cursor.length > 512) throw new Error();
        const decoded = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
        if (decoded.v !== 2 || decoded.f !== fingerprint || !Number.isSafeInteger(decoded.last) || decoded.last < 0 ||
          !Number.isSafeInteger(decoded.ceiling) || decoded.ceiling < decoded.last || !Number.isFinite(decoded.value) ||
          !Number.isSafeInteger(decoded.queryAt) || decoded.queryAt <= 0 || decoded.queryAt > this.now()) throw new Error();
        last = decoded.last; ceiling = decoded.ceiling; lastValue = decoded.value; queryAt = decoded.queryAt;
      } catch { throw new Error("invalid catalog cursor or filters changed"); }
    }
    if (chain) { clauses.push("a.chain=?"); values.push(chain); }
    if (query.maxAgeHours !== undefined) { clauses.push("p.created_at>=? AND p.created_at<=?"); values.push(queryAt - query.maxAgeHours * 3600000, queryAt); }
    if (q) {
      const needle = "%" + q.replace(/[\\%_]/g, "\\$&") + "%";
      clauses.push("(a.address=? OR a.symbol LIKE ? ESCAPE '\\' OR a.name LIKE ? ESCAPE '\\' OR p.address=?)");
      values.push(q.startsWith("0x") ? q.toLowerCase() : q, needle, needle, q.startsWith("0x") ? q.toLowerCase() : q);
    }
    // Prefer liquid pools observed recently. Expired pools remain discoverable
    // but are explicitly unavailable; their historic value never authorizes trade.
    const join = `FROM market_assets a JOIN market_pools p ON p.asset_id=a.id AND p.address=(
      SELECT b.address FROM market_pools b WHERE b.asset_id=a.id
      ORDER BY (b.as_of >= ${this.now() - 300000}) DESC,b.liquidity DESC,b.as_of DESC,b.address LIMIT 1)`;
    const where = clauses.length ? " AND " + clauses.join(" AND ") : "";
    const continuation = last ? ` AND (${sortColumn} ${direction === "ASC" ? ">" : "<"} ? OR (${sortColumn}=? AND a.id>?))` : "";
    const rows = this.db.prepare(`SELECT a.id,p.payload,p.as_of,p.status,${sortColumn} AS sort_value ${join}
      WHERE a.id<=? ${where}${continuation} ORDER BY ${sortColumn} ${direction},a.id ASC LIMIT ?`)
      .all(ceiling, ...values, ...(last ? [lastValue, lastValue, last] : []), limit + 1) as any[];
    const total = (this.db.prepare(`SELECT COUNT(*) AS n ${join} WHERE a.id<=? ${where}`).get(ceiling, ...values) as { n: number }).n;
    const hasMore = rows.length > limit; rows.splice(limit);
    const pairs = rows.map((r) => ({ ...JSON.parse(r.payload), catalogId: r.id,
      marketStatus: this.now() - r.as_of > 300000 ? "UNAVAILABLE" : this.now() - r.as_of > 60000 ? "DEGRADED" : r.status,
      tradable: false, routeStatus: "UNVERIFIED", cacheAgeMs: Math.max(0, this.now() - r.as_of) }));
    return { pairs, total, nextCursor: hasMore ? Buffer.from(JSON.stringify({ v: 2, last: rows.at(-1).id, value: rows.at(-1).sort_value, queryAt, ceiling, f: fingerprint })).toString("base64url") : null,
      source: "catalog", coverage: "Observed provider pools; not an exhaustive blockchain index", order: sort };
  }

  stats() {
    return { ...(this.db.prepare(`SELECT (SELECT COUNT(*) FROM market_assets) AS assets,
      (SELECT COUNT(*) FROM market_pools) AS pools,(SELECT COUNT(*) FROM market_jobs) AS jobs,
      (SELECT MAX(as_of) FROM market_pools) AS lastObservation`).get() as { assets: number; pools: number; jobs: number; lastObservation: number | null }),
      coverage: "provider_observations", chains: MARKET_CHAINS, tradingEnabled: false };
  }

  enqueue(key: string, kind: "discover" | "refresh", payload: object, dueAt = this.now()) {
    this.db.prepare("INSERT OR IGNORE INTO market_jobs(job_key,kind,payload,due_at) VALUES(?,?,?,?)")
      .run(key, kind, JSON.stringify(payload), dueAt);
  }

  claim(leaseMs = 60000): MarketJob | undefined {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM market_jobs WHERE due_at<=? AND lease_until<=? ORDER BY due_at,job_key LIMIT 1")
        .get(this.now(), this.now()) as MarketJob | undefined;
      if (!row) return undefined;
      const lease_token = randomUUID(), lease_until = this.now() + leaseMs;
      this.db.prepare("UPDATE market_jobs SET lease_token=?,lease_until=? WHERE job_key=?").run(lease_token, lease_until, row.job_key);
      return { ...row, lease_token, lease_until };
    }).immediate();
  }

  complete(job: MarketJob, write: () => void, payload: object, delayMs: number): boolean {
    return this.db.transaction(() => {
      if (!this.owns(job)) return false;
      write();
      this.db.prepare(`UPDATE market_jobs SET payload=?,due_at=?,attempts=0,lease_token=NULL,lease_until=0,
        last_success=?,last_error=NULL WHERE job_key=?`).run(JSON.stringify(payload), this.now() + delayMs, this.now(), job.job_key);
      return true;
    }).immediate();
  }
  fail(job: MarketJob): boolean {
    const delay = Math.min(3600000, 15000 * 2 ** Math.min(job.attempts, 8));
    return this.db.transaction(() => {
      if (!this.owns(job)) return false;
      this.db.prepare(`UPDATE market_jobs SET attempts=attempts+1,due_at=?,lease_token=NULL,lease_until=0,
        last_error='PROVIDER_UNAVAILABLE' WHERE job_key=?`).run(this.now() + delay, job.job_key);
      return true;
    }).immediate();
  }
  private owns(job: MarketJob) {
    return Boolean(this.db.prepare("SELECT 1 FROM market_jobs WHERE job_key=? AND lease_token=? AND lease_until>?")
      .get(job.job_key, job.lease_token, this.now()));
  }
}
