// Treasury setup wizard — run this on YOUR machine, never share the secret.
//
//   node scripts/setup-treasury.mjs              # dry-run: verify + report, no changes
//   node scripts/setup-treasury.mjs --wait       # dry-run + poll until the treasury is funded
//   node scripts/setup-treasury.mjs --wait --yes # apply: create fee ATAs + import secret into Fly
//
// The private key is read from the environment of YOUR shell and is never
// printed, logged, or written to disk by this script:
//   SOLANA_FEE_SECRET   Phantom export (base58, 64B), solana-keygen JSON
//                       byte-array, or base64 (what Fly expects)
//
// What --yes does:
//   1. Creates the fee ATAs for the top catalog mints (idempotent, ~0.002 SOL each)
//   2. Pipes TREASURY_KEYPAIR_BASE64=<base64> into `flyctl secrets import`
//      via stdin, so the secret never appears in shell history or argv
//
// Run from packages/app so @solana/* resolve from the workspace.

import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const args = process.argv.slice(2);
const APPLY = args.includes("--yes");
const WAIT = args.includes("--wait");
const require = createRequire(import.meta.url);
const { PublicKey, Connection, Keypair } = await import("@solana/web3.js");
const bs58 = (() => { try { return require("bs58"); } catch { return null; } })();

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const TREASURY = process.env.SOLANA_PLATFORM_FEE_OWNER ?? "48S2froLbV7qcnpCvTCfh823BDgL1ZH4Bk5sWHigbFy8";
const MIN_SOL = Number(process.env.MIN_TREASURY_SOL ?? "0.15");
const FLY_APP = process.env.FLY_APP ?? "raidos-api";
const FLYCTL = process.env.FLYCTL ?? (process.platform === "win32" ? "C:/Users/Usuario/.fly/bin/flyctl.exe" : "flyctl");
const step = (n, msg) => console.log(`\n[${n}] ${msg}`);
const mask = (k) => `${k.slice(0, 4)}…${k.slice(-4)}`;

// ── 1. Decode the secret from the local environment ────────────────────────
step(1, "Decoding SOLANA_FEE_SECRET from your local environment (never printed)");
const secret = process.env.SOLANA_FEE_SECRET;
if (!secret) {
  console.error("MISSING: export SOLANA_FEE_SECRET first (Phantom: wallet details → export private key).");
  console.error('  PowerShell:  $env:SOLANA_FEE_SECRET = Read-Host "secret"   # hidden input');
  console.error('  bash:        read -s SOLANA_FEE_SECRET && export SOLANA_FEE_SECRET');
  process.exit(1);
}
let keypair;
try {
  let bytes;
  if (secret.trim().startsWith("[")) bytes = Uint8Array.from(JSON.parse(secret.trim()));
  else if (/^[A-Za-z0-9+/=]+$/.test(secret.trim()) && secret.includes("=")) bytes = Buffer.from(secret.trim(), "base64");
  else if (bs58) bytes = bs58.default ? bs58.default.decode(secret.trim()) : bs58.decode(secret.trim());
  else bytes = Buffer.from(secret.trim(), "base64");
  if (bytes.length !== 64) throw new Error(`expected 64 bytes, got ${bytes.length}`);
  keypair = Keypair.fromSecretKey(Buffer.from(bytes));
} catch (err) {
  console.error("REFUSED: the secret could not be decoded as Phantom base58 / JSON array / base64:", err.message);
  process.exit(1);
}
const fromSecret = (b) => Keypair.fromSecretKey(Buffer.from(b));
if (fromSecret(keypair.secretKey).publicKey.toBase58() !== keypair.publicKey.toBase58()) {
  console.error("REFUSED: keypair round-trip failed — aborting.");
  process.exit(1);
}
console.log(`  keypair OK: ${mask(keypair.publicKey.toBase58())}`);
if (keypair.publicKey.toBase58() !== TREASURY) {
  console.error(`  WARNING: this keypair is NOT the configured treasury ${mask(TREASURY)}.`);
  console.error("  If it is a NEW treasury, update SOLANA_PLATFORM_FEE_OWNER in Fly first, then re-run.");
  if (!APPLY) console.error("  (dry-run continues; --yes would stop here)");
  if (APPLY) process.exit(1);
}

// ── 2. On-chain balance + funding wait ─────────────────────────────────────
step(2, "Checking treasury balance on-chain");
const connection = new Connection(RPC, "confirmed");
const lamports = await connection.getBalance(keypair.publicKey);
const sol = lamports / 1e9;
console.log(`  balance: ${sol.toFixed(6)} SOL (need ≥ ${MIN_SOL} SOL: ~60 fee ATAs + gas for claims/graduations)`);
let funded = sol >= MIN_SOL;
if (!funded && WAIT) {
  console.log(`\n  → send ${Math.max(MIN_SOL - sol, 0.01).toFixed(3)} SOL to ${keypair.publicKey.toBase58()}`);
  console.log("    (buy in Phantom/exchange and transfer on Solana network; ~1 min)");
  console.log("  polling every 15 s… (Ctrl+C to stop)");
  const deadline = Date.now() + 30 * 60_000;
  while (!funded && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15_000));
    const now = (await connection.getBalance(keypair.publicKey)) / 1e9;
    process.stdout.write(`    ${new Date().toLocaleTimeString()}  ${now.toFixed(6)} SOL\r`);
    funded = now >= MIN_SOL;
  }
  console.log("");
}
if (!funded) {
  console.log(`\n  RESULT: fund the treasury to ≥ ${MIN_SOL} SOL and re-run with --wait --yes.`);
  console.log(`  Deposit address: ${keypair.publicKey.toBase58()}`);
  if (!APPLY) console.log("  (dry-run complete — nothing was changed)");
  process.exit(funded ? 0 : 2);
}

// ── 3. Create the fee ATAs (the 0.3% fee needs them to exist per mint) ─────
if (APPLY) {
  step(3, "Creating fee ATAs for the top catalog mints (idempotent)");
  const scriptDir = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1").replace(/\/$/, "");
  const r = spawnSync(process.execPath, ["solana-fee-atas.mjs", "--create"], {
    stdio: "inherit",
    env: { ...process.env, SOLANA_FEE_SECRET: secret },
    cwd: scriptDir,
  });
  if (r.status !== 0) {
    console.error("fee ATA creation failed — fix and re-run; secrets were NOT imported.");
    process.exit(1);
  }
} else {
  step(3, "Fee ATAs: would run scripts/solana-fee-atas.mjs --create (~0.12 SOL of rent)");
}

// ── 4. Import TREASURY_KEYPAIR_BASE64 into Fly via stdin (no argv, no echo) ─
const b64 = Buffer.from(keypair.secretKey).toString("base64");
if (APPLY) {
  step(4, `Importing TREASURY_KEYPAIR_BASE64 into Fly app ${FLY_APP} (via stdin)`);
  const flyVersion = spawnSync(FLYCTL, ["version"], { encoding: "utf8" });
  if (flyVersion.status !== 0) {
    console.error(`flyctl not runnable at ${FLYCTL} — set FLYCTL and re-run; secrets were NOT imported.`);
    process.exit(1);
  }
  await new Promise((resolve, reject) => {
    const child = spawn(FLYCTL, ["secrets", "import", "--app", FLY_APP, "-y"], { stdio: ["pipe", "inherit", "inherit"] });
    child.stdin.write(`TREASURY_KEYPAIR_BASE64=${b64}\n`);
    child.stdin.end();
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`flyctl secrets import exited ${code}`))));
    child.on("error", reject);
  });
  console.log("  imported. The machine restarts with the secret; verify with:");
  console.log(`  ${FLYCTL} secrets list --app ${FLY_APP}   # shows the NAME only, never the value`);
} else {
  step(4, `Would import TREASURY_KEYPAIR_BASE64 into Fly app ${FLY_APP} via stdin (secret never echoed)`);
}

// ── 5. Post-checks ─────────────────────────────────────────────────────────
step(5, "What happens next (automatic, no action needed)");
console.log("  • Solana 0.3% fee starts flowing on the next swap per mint (5 min cache expiry).");
console.log("  • Rewards claims pay REAL USDC from this treasury (rewards are already ON).");
console.log("  • Pool execution stays OFF until you set POOL_EXECUTION_ENABLED=1 + pool keypair.");
console.log(`\nDONE${APPLY ? "" : " (dry-run)"}. Treasury: ${keypair.publicKey.toBase58()}`);
