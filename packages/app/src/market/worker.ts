import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MarketCatalog } from "./catalog.js";
import { MarketDataService } from "./data.js";
import { MarketIndexer } from "./indexer.js";

const path = process.env.DB_PATH;
if (!path) throw new Error("DB_PATH is required for the market worker");
mkdirSync(dirname(path), { recursive: true });
const db = new Database(path);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
const catalog = new MarketCatalog(db);
const indexer = new MarketIndexer(catalog, new MarketDataService());
indexer.seed((process.env.MARKET_DISCOVERY_CHAINS ?? "solana,base").split(",").map((s) => s.trim()).filter(Boolean));
let stopping = false;
process.once("SIGINT", () => { stopping = true; });
process.once("SIGTERM", () => { stopping = true; });
try {
  do {
    const started = Date.now();
    const result = await indexer.runOnce();
    console.log(JSON.stringify({ event: "market_indexer", ...result, durationMs: Date.now() - started, ...catalog.stats() }));
    if (process.argv.includes("--once") || stopping) break;
    await new Promise((resolve) => setTimeout(resolve, 10000));
  } while (!stopping);
} finally { db.close(); }
