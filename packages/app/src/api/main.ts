/**
 * 🚀 ENTRY POINT — run the RaidOS trading API as a standalone service.
 *
 * Env vars:
 *   PORT              listen port (default 8787)
 *   DB_PATH           SQLite file path — MUST live on a persistent disk in production
 *                     (default ./raidos.db)
 *   SITE_DIR          optional static dashboard dir; set to a copied site/ folder to
 *                     serve the dashboard from this process, or leave unset for API-only
 *   APP_MODE          "live" (real chain txs) | "mock" (labeled simulation, default)
 *   BOOTSTRAP_SECRET  secret required to register users after the first one
 *
 * Usage:  npx tsx src/api/main.ts     (dev)   |   node dist/api/main.js     (built)
 */

import { ApiServer } from "./server.js";

const port = Number(process.env.PORT ?? 8787);

const server = new ApiServer({
  dbPath: process.env.DB_PATH ?? "raidos.db",
  port,
});

const actualPort = await server.start();
console.log(`[raidos-api] listening on http://0.0.0.0:${actualPort} (mode: ${server.appMode})`);
