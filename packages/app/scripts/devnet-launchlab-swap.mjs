// Devnet LaunchLab REAL swap trial: buy -> sell round trip on a LIVE third-party curve.
//
// What this proves end-to-end (with real signed + broadcast transactions):
//   1. Raydium LaunchLab is LIVE on devnet (program DRay6fNdQ5J82H7xV6uq2aV3mNrUZ1J4PgSKsWgptcm6).
//   2. Our client (swap account metas + data layout + quote math) matches the
//      deployed devnet program: the program accepts our buy and our sell.
//   3. Wallet plumbing works: funding, wsol ATA wrapping, ATA creation, fee payer.
//   4. Broadcasting + confirming + balance verification work against a real RPC.
//
// What this does NOT prove (CPMM is mainnet-only):
//   - The post-graduation CPMM swap. Raydium's CPMM program is NOT deployed on
//     devnet/testnet, so that leg can only be certified on mainnet.
//
// Usage:
//   node scripts/devnet-launchlab-swap.mjs                 # auto-discover a live curve
//   node scripts/devnet-launchlab-swap.mjs <mintA> <poolIdBase58>   # explicit curve
//
// Funded by devnet airdrops only. Never touches mainnet or real funds.

import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, ComputeBudgetProgram } from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  getAccount,
} from '@solana/spl-token';
import {
  Curve,
  LaunchpadPool,
  LaunchpadConfig,
  PlatformConfig,
  getPdaLaunchpadAuth,
  getPdaPlatformVault,
  getPdaCreatorVault,
  getPdaCpiEvent,
  getATAAddress,
  anchorDataBuf,
} from '@raydium-io/raydium-sdk-v2';
import BN from 'bn.js';
import { createHash } from 'node:crypto';

const DEVNET_LAB = new PublicKey('DRay6fNdQ5J82H7xV6uq2aV3mNrUZ1J4PgSKsWgptcm6');
const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const DISC_BUY = anchorDisc('buyExactIn');
const DISC_SELL = anchorDisc('sellExactIn');
function anchorDisc(name) {
  return Buffer.from(createHash('sha256').update('global:' + name).digest().subarray(0, 8));
}

function computeBudgetIx() {
  return ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 });
}
function swapData(amountIn, minOut) {
  const data = Buffer.alloc(24);
  data.writeBigUInt64LE(amountIn, 0);
  data.writeBigUInt64LE(minOut, 8);
  data.writeBigUInt64LE(0n, 16);
  return data;
}
function swapKeys(p) {
  return [
    { pubkey: p.user, isSigner: true, isWritable: true },
    { pubkey: p.auth, isSigner: false, isWritable: false },
    { pubkey: p.configId, isSigner: false, isWritable: false },
    { pubkey: p.platformId, isSigner: false, isWritable: false },
    { pubkey: p.poolId, isSigner: false, isWritable: true },
    { pubkey: p.userAtaA, isSigner: false, isWritable: true },
    { pubkey: p.userAtaQuote, isSigner: false, isWritable: true },
    { pubkey: p.vaultA, isSigner: false, isWritable: true },
    { pubkey: p.vaultQuote, isSigner: false, isWritable: true },
    { pubkey: p.mint, isSigner: false, isWritable: false },
    { pubkey: p.quoteMint, isSigner: false, isWritable: false },
    { pubkey: p.mintAProgram, isSigner: false, isWritable: false },
    { pubkey: p.quoteMintProgram, isSigner: false, isWritable: false },
    { pubkey: p.cpiEvent, isSigner: false, isWritable: false },
    { pubkey: DEVNET_LAB, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: p.platformVault, isSigner: false, isWritable: true },
    { pubkey: p.creatorVault, isSigner: false, isWritable: true },
  ];
}

async function findLiveCurve() {
  log('[discover] scanning devnet LaunchLab for a live curve (buyable, not migrated)…');
  const configs = await connection.getProgramAccounts(DEVNET_LAB, {
    commitment: 'confirmed',
    filters: [{ dataSize: LaunchpadPool.span }],
  });
  log(`[discover] pool accounts on devnet: ${configs.length}`);
  const live = [];
  for (const { pubkey, account } of configs) {
    try {
      const pool = LaunchpadPool.decode(account.data);
      // status 0 = curve open; fund method 0 = SOL quote; classic SPL mint program flag
      if (pool.status === 0 && pool.mintProgramFlag === 0) live.push({ poolId: pubkey, pool });
    } catch { /* not a pool */ }
  }
  live.sort((a, b) => Number(BigInt(b.pool.realA.toString()) - BigInt(a.pool.realA.toString())));
  if (!live.length) throw new Error('no live curve found on devnet LaunchLab — create one or pass explicit mint+pool');
  return live[0];
}

async function main() {
  const programInfo = await connection.getAccountInfo(DEVNET_LAB);
  if (!programInfo?.executable) throw new Error('devnet LaunchLab program is not deployed/executable');
  log(`[0] devnet LaunchLab LIVE at ${DEVNET_LAB.toBase58()}`);

  let mint, poolId, pool, configId;
  if (process.argv[2] && process.argv[3]) {
    mint = new PublicKey(process.argv[2]);
    poolId = new PublicKey(process.argv[3]);
    const acc = await connection.getAccountInfo(poolId);
    if (!acc) throw new Error('pool account not found');
    pool = LaunchpadPool.decode(acc.data);
    configId = pool.configId;
  } else {
    const found = await findLiveCurve();
    ({ poolId, pool } = found);
    configId = pool.configId;
    mint = pool.mintA;
  }
  const configAcc = await connection.getAccountInfo(configId);
  if (!configAcc) throw new Error('config account not found');
  const configInfo = LaunchpadConfig.decode(configAcc.data);
  const platformAcc = await connection.getAccountInfo(pool.platformId);
  if (!platformAcc) throw new Error('platform account not found');
  const platformInfo = PlatformConfig.decode(platformAcc.data);
  const rates = {
    protocolFeeRate: configInfo.tradeFeeRate,
    platformFeeRate: platformInfo.feeRate,
    creatorFeeRate: platformInfo.creatorFeeRate,
    curveType: configInfo.curveType,
  };
  if (pool.status !== 0) throw new Error(`curve not open (status=${pool.status})`);
  if (!pool.mintB.equals(NATIVE_MINT)) throw new Error('curve quote is not SOL');
  log(`[1] curve selected:
    mint      ${mint.toBase58()}
    pool      ${poolId.toBase58()}
    status    ${pool.status} (open)
    sold      ${pool.realA} / ${pool.totalSellA} base units
    raised    ${pool.realB} lamports of ${pool.totalFundRaisingB}
    curveType ${rates.curveType}  protocolFee ${rates.protocolFeeRate}  platformFee ${rates.platformFeeRate}  creatorFee ${rates.creatorFeeRate}`);

  // 2. Fresh wallet funded purely by devnet airdrops (or a pre-funded keypair via DEVNET_SECRET_B64).
  const user = process.env.DEVNET_SECRET_B64
    ? Keypair.fromSecretKey(Buffer.from(process.env.DEVNET_SECRET_B64, 'base64'))
    : Keypair.generate();
  log(`[2] wallet ${user.publicKey.toBase58()} (devnet-only)${process.env.DEVNET_SECRET_B64 ? ' (from DEVNET_SECRET_B64)' : ' (fresh throwaway)'}`);
  let bal = await connection.getBalance(user.publicKey);
  if (bal < 0.25e9) {
    let attempts = 0;
    while (bal < 0.25e9 && attempts < 12) {
      attempts++;
      const chunk = bal === 0 ? 0.1e9 : 0.05e9;
      try {
        const sig = await connection.requestAirdrop(user.publicKey, chunk);
        await connection.confirmTransaction(sig, 'confirmed');
        bal = await connection.getBalance(user.publicKey);
        log(`    airdrop ${chunk / 1e9} SOL ok — balance ${bal / 1e9} SOL`);
      } catch {
        if (attempts % 4 === 0) log(`    faucet throttled (${attempts} attempts) — backing off…`);
        await sleep(15_000);
      }
    }
  }
  bal = await connection.getBalance(user.publicKey);
  if (bal < 0.25e9) throw new Error(`faucet rate-limited (balance ${bal} lamports). Pasa DEVNET_SECRET_B64 (keypair devnet con fondos) o reintenta en unos minutos.`);
  log(`    funded: ${bal / 1e9} SOL`);

  // 3. Off-chain quote with the same curve math the API uses.
  const amountIn = 0.05e9; // 0.05 SOL
  const poolInfoLike = pool;
  const buyQ = Curve.buyExactIn({
    poolInfo: poolInfoLike,
    amountB: new BN(amountIn.toString()),
    protocolFeeRate: rates.protocolFeeRate,
    platformFeeRate: rates.platformFeeRate,
    curveType: rates.curveType,
    shareFeeRate: new BN(0),
    creatorFeeRate: rates.creatorFeeRate,
    transferFeeConfigA: undefined,
    transferFeeConfigB: undefined,
    slot: 0,
  });
  const amountOut = buyQ.amountA.amount.sub(buyQ.amountA.fee ?? new BN(0));
  if (amountOut.lte(new BN(0))) throw new Error('quote yielded zero tokens');
  const ONE = new BN(10_000);
  const minOut = amountOut.mul(ONE.sub(new BN(100))).div(ONE); // 1% slippage
  log(`[3] quote: 0.05 SOL -> ${amountOut.toString()} base units (minOut ${minOut.toString()})`);

  const userAtaA = getATAAddress(user.publicKey, mint, TOKEN_PROGRAM_ID).publicKey;
  const userAtaQuote = getATAAddress(user.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID).publicKey;
  const auth = getPdaLaunchpadAuth(DEVNET_LAB).publicKey;
  const platformVault = getPdaPlatformVault(DEVNET_LAB, pool.platformId, pool.mintB).publicKey;
  const creatorVault = getPdaCreatorVault(DEVNET_LAB, pool.creator, pool.mintB).publicKey;
  const cpiEvent = getPdaCpiEvent(DEVNET_LAB).publicKey;
  const vaultA = pool.vaultA;
  const vaultQuote = pool.vaultB;

  async function buildAndSend(side, amtIn, minAmountOut) {
    const ixs = [computeBudgetIx()];
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(user.publicKey, userAtaA, user.publicKey, mint, TOKEN_PROGRAM_ID));
    if (side === 'buy') {
      ixs.push(createAssociatedTokenAccountIdempotentInstruction(user.publicKey, userAtaQuote, user.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID));
      ixs.push(SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: userAtaQuote, lamports: amtIn }));
      ixs.push(createSyncNativeInstruction(userAtaQuote));
    } else {
      ixs.push(createAssociatedTokenAccountIdempotentInstruction(user.publicKey, userAtaQuote, user.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID));
    }
    ixs.push(new TransactionInstruction({
      programId: DEVNET_LAB,
      keys: swapKeys({
        user: user.publicKey, auth, configId: pool.configId, platformId: pool.platformId, poolId,
        userAtaA, userAtaQuote, vaultA, vaultQuote, mint, quoteMint: pool.mintB,
        mintAProgram: TOKEN_PROGRAM_ID, quoteMintProgram: TOKEN_PROGRAM_ID,
        platformVault, creatorVault, cpiEvent,
      }),
      data: Buffer.concat([side === 'buy' ? DISC_BUY : DISC_SELL, swapData(amtIn, minAmountOut)]),
    }));
    const tx = new Transaction().add(...ixs);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    tx.feePayer = user.publicKey;
    tx.recentBlockhash = blockhash;
    tx.sign(user);
    const serialized = tx.serialize();
    const sig = await connection.sendRawTransaction(serialized, { skipPreflight: false });
    const confirmation = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    return { sig, err: confirmation.value.err };
  }

  // 4. REAL devnet buy.
  log('[4] BUY: sending real devnet transaction (0.05 SOL into the curve)…');
  const buy = await buildAndSend('buy', BigInt(amountIn), BigInt(minOut.toString()));
  if (buy.err) throw new Error('buy tx failed on-chain: ' + JSON.stringify(buy.err));
  log(`    confirmed: https://explorer.solana.com/tx/${buy.sig}?cluster=devnet`);

  const tokenAcc = await getAccount(connection, userAtaA);
  log(`    token balance now: ${tokenAcc.amount.toString()} base units`);
  if (tokenAcc.amount <= 0n) throw new Error('buy did not credit any tokens');
  if (tokenAcc.amount < amountOut) log(`    note: received slightly less than quoted (curve moved or fee rounding)`);

  // 5. REAL devnet sell of the full balance.
  log('[5] SELL: sending real devnet transaction (entire token balance back to the curve)…');
  const sellQ = Curve.sellExactIn({
    poolInfo: poolInfoLike,
    amountA: new BN(tokenAcc.amount.toString()),
    protocolFeeRate: rates.protocolFeeRate,
    platformFeeRate: rates.platformFeeRate,
    curveType: rates.curveType,
    shareFeeRate: new BN(0),
    creatorFeeRate: rates.creatorFeeRate,
    transferFeeConfigA: undefined,
    transferFeeConfigB: undefined,
    slot: 0,
  });
  const quoteBack = sellQ.amountB;
  const minBack = quoteBack.mul(ONE.sub(new BN(500))).div(ONE); // 5% floor
  log(`    quote: ${tokenAcc.amount.toString()} tokens -> ${quoteBack.toString()} lamports (floor ${minBack.toString()})`);
  const sell = await buildAndSend('sell', tokenAcc.amount, BigInt(minBack.toString()));
  if (sell.err) throw new Error('sell tx failed on-chain: ' + JSON.stringify(sell.err));
  log(`    confirmed: https://explorer.solana.com/tx/${sell.sig}?cluster=devnet`);

  // 6. Verify the round trip.
  const finalToken = await getAccount(connection, userAtaA);
  const finalSol = await connection.getBalance(user.publicKey);
  const verdict = finalToken.amount === 0n;
  log(`[6] round trip:
    token balance: ${finalToken.amount.toString()} (expect 0)
    SOL balance:   ${finalSol} lamports (started ${bal}, spent ${bal - finalSol} lamports = ${(bal - finalSol) / 1e9} SOL in fees+curve spread)
    VERDICT: ${verdict ? 'PASS' : 'CHECK'} — ${verdict ? 'full curve round trip executed on devnet LaunchLab' : 'some tokens remain; inspect the sell tx'}`);

  log(`
=== SUMMARY ===
${JSON.stringify({
  program: DEVNET_LAB.toBase58(),
  mint: mint.toBase58(),
  pool: poolId.toBase58(),
  buyTx: buy.sig,
  sellTx: sell.sig,
  tokensLeft: finalToken.amount.toString(),
  solSpent: (bal - finalSol).toString(),
  sessionId: createHash('sha256').update(buy.sig).digest('hex').slice(0, 32),
  note: 'real signed + broadcast devnet transactions, airdrop-funded; CPMM leg remains mainnet-only',
}, null, 2)}`);
}

main().catch(err => { console.error('FAILED:', err?.message || err); process.exitCode = 1; });
