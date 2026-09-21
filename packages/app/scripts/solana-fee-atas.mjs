// Pre-create Solana fee ATAs for the treasury so Jupiter platform fees can
// actually be charged. Jupiter debits the platform fee by transferring output
// tokens to the feeAccount; a transfer to a non-existent SPL account aborts
// the whole swap, so every output mint needs its fee ATA to exist first.
//
// Modes:
//   node solana-fee-atas.mjs --check              read-only audit (no key)
//   node solana-fee-atas.mjs --create             idempotent creation
//
// Secrets are read from the environment of the operator's own machine and
// are never printed, logged or written to disk by this script:
//   SOLANA_FEE_SECRET   base58 64-byte secret (as Phantom exports) or a JSON
//                       byte-array string (as `solana-keygen pubkey` files)
//
// Everything else has safe defaults: --owner (fee owner, defaults to the
// production treasury), --rpc (public mainnet), --limit (top catalog tokens),
// --api (production catalog endpoint).
//
// Run from packages/app so @solana/* resolve from the workspace:
//   cd packages/app && node scripts/solana-fee-atas.mjs --check

const args = process.argv.slice(2);
const mode = args.includes("--check") ? "check" : args.includes("--create") ? "create" : null;
const getArg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

if (!mode) {
  console.error("usage: node solana-fee-atas.mjs (--check | --create) [--owner <pubkey>] [--rpc <url>] [--limit N] [--api <url>]");
  process.exit(1);
}

const { PublicKey, Connection, Transaction, SystemProgram } = await import("@solana/web3.js");
const { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } = await import("@solana/spl-token");

const OWNER = getArg("--owner", process.env.SOLANA_PLATFORM_FEE_OWNER ?? "48S2froLbV7qcnpCvTCfh823BDgL1ZH4Bk5sWHigbFy8");
const RPC = getArg("--rpc", "https://api.mainnet-beta.solana.com");
const API = getArg("--api", "https://raidos-api.fly.dev/api/market/catalog?chain=solana&sort=liquidity&limit=");
const LIMIT = Number(getArg("--limit", "60"));
const BATCH = 5; // create instructions per transaction (safe size)

const owner = new PublicKey(OWNER);
const connection = new Connection(RPC, "confirmed");

// Canonical mints that are not always present in the catalog but are common
// swap outputs: USDC (sell side) and wrapped SOL.
const BASE_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "So11111111111111111111111111111111111111112", // wSOL
]);

async function collectMints() {
  const res = await fetch(API + LIMIT);
  if (!res.ok) throw new Error(`catalog fetch failed: ${res.status}`);
  const data = await res.json();
  const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
  const mints = new Set(BASE_MINTS);
  for (const p of pairs) {
    const mint = p?.baseToken?.address;
    if (typeof mint === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) mints.add(mint);
  }
  return [...mints];
}

async function ataExists(mint, feeAta) {
  const info = await connection.getAccountInfo(feeAta);
  return Boolean(info);
}

function feeAtaFor(mint) {
  return getAssociatedTokenAddressSync(new PublicKey(mint), owner, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
}

const mints = await collectMints();
console.log(`fee owner: ${OWNER}`);
console.log(`rpc: ${RPC}`);
console.log(`mints collected: ${mints.length} (catalog top ${LIMIT} + USDC/wSOL)`);

const missing = [];
let exists = 0;
for (const mint of mints) {
  const ata = feeAtaFor(mint);
  const has = await ataExists(mint, ata);
  if (has) {
    exists++;
  } else {
    missing.push({ mint, ata: ata.toBase58() });
  }
}

const rent = await connection.getMinimumBalanceForRentExemption(165);
const lamportsNeeded = rent * missing.length + 5000 * Math.ceil(missing.length / BATCH);
console.log(`existing fee ATAs: ${exists}`);
console.log(`missing fee ATAs: ${missing.length}`);
console.log(`rent per account: ${rent} lamports (~${(rent / 1e9).toFixed(6)} SOL)`);
console.log(`total SOL needed for --create: ~${(lamportsNeeded / 1e9).toFixed(6)} SOL`);
for (const { mint, ata } of missing) console.log(`  missing ${mint} -> ${ata}`);

if (mode === "check") {
  console.log("check-only: no transactions sent");
  process.exit(0);
}

// ── create mode ──
const secret = process.env.SOLANA_FEE_SECRET;
if (!secret || secret.length < 40) {
  console.error("SOLANA_FEE_SECRET missing: export the treasury secret in YOUR shell (base58 from Phantom, or JSON byte-array) and rerun --create");
  process.exit(1);
}

let payer;
const { Keypair } = await import("@solana/web3.js");
if (secret.trim().startsWith("[")) {
  payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret)));
} else {
  const bs58 = (await import("bs58")).default;
  payer = Keypair.fromSecretKey(bs58.decode(secret.trim()));
}

const balance = await connection.getBalance(payer.publicKey);
if (!payer.publicKey.equals(owner)) {
  console.error(`warning: keypair ${payer.publicKey.toBase58()} is NOT the fee owner ${OWNER}; creation would fail (ATA owner mismatch). Use the treasury key.`);
  process.exit(1);
}
if (balance < lamportsNeeded) {
  console.error(`insufficient balance: ${balance} lamports; need ~${lamportsNeeded}. Fund the treasury with ~${(lamportsNeeded / 1e9).toFixed(6)} SOL first.`);
  process.exit(1);
}

let created = 0;
for (let i = 0; i < missing.length; i += BATCH) {
  const chunk = missing.slice(i, i + BATCH);
  const tx = new Transaction().add(
    ...chunk.map(({ mint, ata }) =>
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey, new PublicKey(ata), owner, new PublicKey(mint),
        TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    ),
  );
  tx.feePayer = payer.publicKey;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.sign(payer);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  created += chunk.length;
  console.log(`tx ${sig} -> ${chunk.length} ATAs (${created}/${missing.length})`);
}

console.log(`done: ${created} fee ATAs ensured (idempotent; existing ones were untouched)`);
console.log(`total SOL spent: ~${(lamportsNeeded / 1e9).toFixed(6)} (rent is recoverable by closing accounts later)`);
