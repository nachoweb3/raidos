// Read-only mainnet certification for the direct Raydium CPMM module.
// Never signs, never broadcasts, never moves funds:
//  1. Finds REAL migrated LaunchLab pools on-chain (getProgramAccounts on CPMM
//     filtered by the canonical migration config + WSOL quote — the exact
//     derivation rule used by the API). No third-party index involved.
//  2. Reads pool/config/vaults through the exact decodePool() path used by the
//     LaunchCpmm API (state/quote/prepareSwap).
//  3. Cross-checks the derived price against an independent source (Jupiter price).
//  4. Simulates prepareSwap()'s unsigned tx WITHOUT signatures (sigVerify:false).
//     Pass USER_PUBKEY (a funded wallet you own) to run this step.
//
// Usage:
//   node scripts/certify-cpmm.mjs [mintA]      # certify one mint, or auto-discover
//   USER_PUBKEY=<wallet> node scripts/certify-cpmm.mjs [mintA]   # + swap simulation
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import { CpmmPoolInfoLayout } from '@raydium-io/raydium-sdk-v2';
import { LaunchCpmm, CPMM_PROGRAM, deriveCpmmPoolId } from '../dist/trading/launch-cpmm.js';

const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');
const engine = new LaunchCpmm(connection, {
  recordLaunchLabTrade: () => false,
  listUserLaunchLabTrades: () => [],
});
const results = [];

async function jupiterPrice(mint) {
  try {
    const res = await fetch('https://lite-api.jup.ag/price/v3?ids=' + encodeURIComponent(mint), { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const body = await res.json();
    const row = body?.[mint];
    const price = Number(row?.usdPrice ?? row?.indexPrice ?? row?.price);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch { return null; }
}

/**
 * On-chain discovery: find CPMM pools whose (configId, mintB=WSOL) match the
 * exact derivation rule used by the API (canonical LaunchLab migration config).
 * Field offsets are learned from a live sample account instead of hard-coding.
 */
async function discoverCandidateMints(limit) {
  const { configId } = deriveCpmmPoolId(Keypair.generate().publicKey, NATIVE_MINT);
  const sampleId = 'Q2sPHPdUWFMg7M7wwrQKLrn619cAucfRsmhVJffodSp'; // known live CPMM pool, only to learn field offsets
  const sample = await connection.getAccountInfo(new PublicKey(sampleId));
  if (!sample) return [];
  const raw = Buffer.from(sample.data);
  const configOff = raw.indexOf(configId.toBytes());
  const wsolOff = raw.indexOf(NATIVE_MINT.toBytes());
  if (configOff < 0 || wsolOff < 0) {
    console.log('[discover] could not locate field offsets in the sample pool');
    return [];
  }
  const response = await connection.getProgramAccounts(CPMM_PROGRAM, {
    commitment: 'confirmed',
    dataSlice: { offset: 0, length: 0 },
    filters: [
      { memcmp: { offset: configOff, bytes: configId.toBase58() } },
      { memcmp: { offset: wsolOff, bytes: NATIVE_MINT.toBase58() } },
    ],
  });
  console.log(`[discover] on-chain pools matching (migration config, WSOL quote): ${response.length}`);
  const mints = [];
  for (const { pubkey } of response.slice(0, limit * 3)) {
    try {
      const info = await connection.getAccountInfo(pubkey, 'confirmed');
      if (!info) continue;
      const pool = CpmmPoolInfoLayout.decode(Buffer.from(info.data));
      // Real migrations put WSOL on pool side A; accept either orientation and
      // let the engine's own decode + reserve math decide viability.
      const tokenMint = pool.mintB.equals(NATIVE_MINT) ? pool.mintA : pool.mintB;
      mints.push(tokenMint.toBase58());
      if (mints.length >= limit) break;
    } catch { /* not decodable; skip */ }
  }
  return mints;
}

async function certify(mintA) {
  const out = { mintA, checks: {} };
  try {
    // 1. Real on-chain decode through the exact API path.
    const state = await engine.state(mintA);
    out.checks.pool = {
      poolId: state.poolId, status: state.status,
      baseReserve: state.baseReserve, quoteReserve: state.quoteReserve,
      priceSol: state.priceBaseInQuote,
      reservesPositive: BigInt(state.baseReserve) > 0n && BigInt(state.quoteReserve) > 0n,
    };

    // 2. Independent price cross-check (constant-product price vs Jupiter).
    const [jupToken, jupSol] = await Promise.all([jupiterPrice(mintA), jupiterPrice(NATIVE_MINT.toBase58())]);
    if (state.priceBaseInQuote && jupToken && jupSol) {
      const oursUsd = Number(state.priceBaseInQuote) * jupSol;
      const diff = Math.abs(oursUsd - jupToken) / jupToken;
      out.checks.price = { source: 'jupiter', oursUsd, jupiterUsd: jupToken, relativeDiff: Number(diff.toFixed(4)), verdict: diff <= 0.15 ? 'PASS' : diff <= 0.5 ? 'WARN' : 'FAIL' };
    } else {
      out.checks.price = { source: 'jupiter', verdict: 'UNAVAILABLE', oursUsd: null, jupiterUsd: null };
    }

    // 3. Quotes both ways (pure math over real reserves) + round-trip sanity.
    const lamports = 50_000_000n; // 0.05 SOL
    const buy = await engine.quote(mintA, 'buy', lamports, 100);
    const sell = await engine.quote(mintA, 'sell', BigInt(buy.amountOut), 100);
    // Round trip: spend `lamports` SOL buying tokens, then sell ALL of them back.
    const recoveredBps = lamports > 0n ? BigInt(sell.amountOut) * 10_000n / lamports : 0n;
    out.checks.quotes = {
      buy, sellBack: sell,
      roundTripLossPct: Number((10_000n - recoveredBps).toString()) / 100,
    };

    // 4. Simulation of the prepared buy tx (signature-free, read-only).
    const user = process.env.USER_PUBKEY ? new PublicKey(process.env.USER_PUBKEY) : null;
    if (user) {
      const prepared = await engine.prepareSwap({ user: user.toBase58(), mintA, side: 'buy', amountIn: lamports, slippageBps: 100 });
      const tx = Transaction.from(Buffer.from(prepared.serialized, 'base64'));
      const sim = await connection.simulateTransaction(new VersionedTransaction(tx.compileMessage()), { sigVerify: false, replaceRecentBlockhash: true });
      out.checks.simulation = {
        err: sim.value.err, unitsConsumed: sim.value.unitsConsumed,
        logs: (sim.value.logs ?? []).slice(-8),
        verdict: sim.value.err ? 'FAIL' : 'PASS',
      };
    } else {
      out.checks.simulation = { verdict: 'SKIPPED', note: 'pass USER_PUBKEY (funded wallet you own) to simulate the prepared swap' };
    }
  } catch (err) {
    out.error = String(err?.message || err);
    out.code = err?.code ?? null;
  }
  results.push(out);
  console.log('\n' + JSON.stringify(out, null, 2));
}

const explicitMint = process.argv[2];
let mints;
if (explicitMint) {
  mints = [new PublicKey(explicitMint).toBase58()]; // validates format early
} else {
  const candidates = await discoverCandidateMints(3);
  mints = [];
  for (const mint of candidates) {
    if (mints.length >= 3) break;
    try {
      const decoded = await engine.decodePool(mint);
      if (decoded.reserves.baseReserve > 0n) mints.push(mint);
    } catch { /* not a decodable migration-config pool; skip */ }
  }
  if (!mints.length) console.error('[discover] no migrated pools found automatically; pass a mint: node scripts/certify-cpmm.mjs <mintA>');
}
for (const mint of mints) await certify(mint);

const failed = results.some(r => r.error || Object.values(r.checks).some(c => c?.verdict === 'FAIL'));
console.log('\n=== SUMMARY ===');
console.log(JSON.stringify({ poolsChecked: results.length, failed, note: 'read-only: nothing signed or broadcast' }, null, 2));
if (failed) process.exitCode = 1;
