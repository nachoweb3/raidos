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
//   node scripts/devnet-launchlab-swap.mjs                        # auto-discover a live curve
//   node scripts/devnet-launchlab-swap.mjs <mintA> <poolIdBase58>  # explicit curve
//   DEVNET_SECRET_B64=<base64> node scripts/devnet-launchlab-swap.mjs
//
// Funded by devnet airdrops only. Never touches mainnet or real funds.

import { Connection, Keypair, PublicKey, SystemProgram, Transaction, ComputeBudgetProgram } from '@solana/web3.js';
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
  buyExactInInstruction,
  sellExactInInstruction,
} from '@raydium-io/raydium-sdk-v2';
import BN from 'bn.js';
import bs58 from 'bs58';

const DEV_LAB = new PublicKey('DRay6fNdQ5J82H7xV6uq2aV3mNrUZ1J4PgSKsWgptcm6');
const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Accepts a 64-byte secret key as base64 or base58. */
function secretBytes(encoded) {
  const b64 = Buffer.from(encoded, 'base64');
  if (b64.length === 64) return b64;
  const b58 = bs58.decode(encoded.trim());
  if (b58.length === 64) return Buffer.from(b58);
  throw new Error('DEVNET_SECRET_B64 must decode to 64 bytes (base64 or base58)');
}

async function findLiveCurve() {
  log('[discover] scanning devnet LaunchLab for a live curve (buyable, not migrated)…');
  const configs = await connection.getProgramAccounts(DEV_LAB, {
    commitment: 'confirmed',
    filters: [{ dataSize: LaunchpadPool.span }],
  });
  log(`[discover] pool accounts on devnet: ${configs.length}`);
  const live = [];
  for (const { pubkey, account } of configs) {
    try {
      const pool = LaunchpadPool.decode(account.data);
      // status 0 = curve open; fund method 0 = SOL quote; classic SPL
      if (pool.status === 0 && pool.mintProgramFlag === 0 && pool.mintB.equals(NATIVE_MINT)) {
        live.push({ poolId: pubkey, pool });
      }
    } catch { /* not a pool */ }
  }
  // prefer curves with most SOL raised (more liquidity → less price impact on 0.05 SOL)
  live.sort((a, b) => Number(BigInt(b.pool.realB.toString()) - BigInt(a.pool.realB.toString())));
  if (!live.length) throw new Error('no live curve found on devnet LaunchLab — create one or pass explicit mint+pool');
  return live[0];
}

async function main() {
  const programInfo = await connection.getAccountInfo(DEV_LAB);
  if (!programInfo?.executable) throw new Error('devnet LaunchLab program is not deployed/executable');
  log(`[0] devnet LaunchLab LIVE at ${DEV_LAB.toBase58()}`);

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
    creatorFeeRate: platformInfo.creatorFeeRate ?? new BN(0),
    curveType: configInfo.curveType,
  };

  if (pool.status !== 0) throw new Error(`curve not open (status=${pool.status})`);
  if (!pool.mintB.equals(NATIVE_MINT)) throw new Error('curve quote is not SOL');

  log(`[1] curve selected:
    mint      ${mint.toBase58()}
    pool      ${poolId.toBase58()}
    status    ${pool.status} (open)
    sold      ${pool.realA} / ${pool.totalSellA} base units
    raised    ${pool.realB} / ${pool.totalFundRaisingB} lamports
    curveType ${rates.curveType}  protocolFee ${rates.protocolFeeRate}  platformFee ${rates.platformFeeRate}  creatorFee ${rates.creatorFeeRate}`);

  // 2. Keypair: from DEVNET_SECRET_B64 env, or fresh throwaway + airdrop.
  const user = process.env.DEVNET_SECRET_B64
    ? Keypair.fromSecretKey(secretBytes(process.env.DEVNET_SECRET_B64))
    : Keypair.generate();
  log(`[2] wallet ${user.publicKey.toBase58()}${process.env.DEVNET_SECRET_B64 ? ' (from DEVNET_SECRET_B64)' : ' (fresh throwaway)'}`);

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
  if (bal < 0.25e9) throw new Error(`faucet rate-limited (balance ${bal} lamports). Pasa DEVNET_SECRET_B64 o reintenta.`);
  log(`    funded: ${bal / 1e9} SOL`);

  // 3. Off-chain quote (same math as the API).
  const amountInLamports = 0.05e9; // 0.05 SOL
  const buyQ = Curve.buyExactIn({
    poolInfo: pool,
    amountB: new BN(amountInLamports.toString()),
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
  const minOut = amountOut.muln(99).divn(100); // 1% slippage
  log(`[3] quote: 0.05 SOL -> ${amountOut.toString()} base units (minOut ${minOut.toString()})`);

  // Derived accounts.
  const userAtaA     = getATAAddress(user.publicKey, mint, TOKEN_PROGRAM_ID).publicKey;
  const userAtaQuote = getATAAddress(user.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID).publicKey;
  const auth         = getPdaLaunchpadAuth(DEV_LAB).publicKey;
  const platformVault = getPdaPlatformVault(DEV_LAB, pool.platformId, pool.mintB).publicKey;
  const creatorVault  = getPdaCreatorVault(DEV_LAB, pool.creator, pool.mintB).publicKey;
  const cpiEvent      = getPdaCpiEvent(DEV_LAB).publicKey;
  const vaultA      = pool.vaultA;
  const vaultQuote  = pool.vaultB;

  async function buildAndSend(side, amtIn, minAmountOut) {
    const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })];

    // Always ensure token ATAs exist.
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(
      user.publicKey, userAtaA, user.publicKey, mint, TOKEN_PROGRAM_ID));
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(
      user.publicKey, userAtaQuote, user.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID));

    if (side === 'buy') {
      // Wrap SOL: transfer + syncNative.
      ixs.push(SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: userAtaQuote, lamports: amtIn }));
      ixs.push(createSyncNativeInstruction(userAtaQuote));
    }

    // Use the SDK's instruction builder — correct discriminator + layout.
    const swapIx = side === 'buy'
      ? buyExactInInstruction(
          DEV_LAB,
          user.publicKey,   // owner
          auth,
          configId,
          pool.platformId,
          poolId,
          userAtaA,
          userAtaQuote,
          vaultA,
          vaultQuote,
          mint,
          pool.mintB,       // quoteMint = WSOL
          TOKEN_PROGRAM_ID, // mintAProgram
          TOKEN_PROGRAM_ID, // quoteMintProgram
          platformVault,
          creatorVault,
          new BN(amtIn.toString()),        // amountB (SOL in)
          new BN(minAmountOut.toString()), // minAmountA
          new BN(0),                       // shareFeeRate
        )
      : sellExactInInstruction(
          DEV_LAB,
          user.publicKey,   // owner
          auth,
          configId,
          pool.platformId,
          poolId,
          userAtaA,
          userAtaQuote,
          vaultA,
          vaultQuote,
          mint,
          pool.mintB,
          TOKEN_PROGRAM_ID,
          TOKEN_PROGRAM_ID,
          platformVault,
          creatorVault,
          new BN(amtIn.toString()),        // amountA (tokens in)
          new BN(minAmountOut.toString()), // minAmountB
          new BN(0),                       // shareFeeRate
        );

    ixs.push(swapIx);

    const tx = new Transaction().add(...ixs);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    tx.feePayer = user.publicKey;
    tx.recentBlockhash = blockhash;
    tx.sign(user);
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    const confirmation = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    return { sig, err: confirmation.value.err };
  }

  // 4. BUY (if wallet doesn't already hold tokens from a previous run)
  let initialTokenBal = 0n;
  try {
    const existingTokenAcc = await getAccount(connection, userAtaA);
    initialTokenBal = existingTokenAcc.amount;
  } catch {
    // ATA does not exist yet
  }

  let buySig = 'skipped-already-holding-tokens';
  if (initialTokenBal === 0n) {
    log('[4] BUY: sending real devnet transaction (0.05 SOL into the curve)…');
    const buy = await buildAndSend('buy', BigInt(amountInLamports), BigInt(minOut.toString()));
    if (buy.err) throw new Error('buy tx failed on-chain: ' + JSON.stringify(buy.err));
    buySig = buy.sig;
    log(`    confirmed: https://explorer.solana.com/tx/${buy.sig}?cluster=devnet`);
  } else {
    log(`[4] BUY: already holding ${initialTokenBal} tokens from prior run; proceeding directly to sell`);
  }

  const tokenAcc = await getAccount(connection, userAtaA);
  log(`    token balance now: ${tokenAcc.amount.toString()} base units`);
  if (tokenAcc.amount <= 0n) throw new Error('no tokens available to sell');

  // 5. REAL devnet sell of the full balance.
  log('[5] SELL: sending real devnet transaction (entire token balance back to the curve)…');

  // Re-read pool state to get accurate quote for sell.
  const poolAccAfterBuy = await connection.getAccountInfo(poolId);
  const poolAfterBuy = LaunchpadPool.decode(poolAccAfterBuy.data);

  const sellQ = Curve.sellExactIn({
    poolInfo: poolAfterBuy,
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
  // Curve.sellExactIn returns amountB directly as a BN (already net of fees)
  const quoteBack = sellQ.amountB;
  const minBack   = quoteBack.muln(95).divn(100); // 5% floor
  log(`    quote: ${tokenAcc.amount.toString()} tokens -> ${quoteBack.toString()} lamports (floor ${minBack.toString()})`);

  const sell = await buildAndSend('sell', tokenAcc.amount, BigInt(minBack.toString()));
  if (sell.err) throw new Error('sell tx failed on-chain: ' + JSON.stringify(sell.err));
  log(`    confirmed: https://explorer.solana.com/tx/${sell.sig}?cluster=devnet`);

  // 6. Verify the round trip.
  const finalToken = await getAccount(connection, userAtaA);
  const finalSol   = await connection.getBalance(user.publicKey);
  const verdict    = finalToken.amount === 0n;
  const solSpent   = bal - finalSol;

  log(`[6] round trip:
    token balance: ${finalToken.amount.toString()} (expect 0)
    SOL balance:   ${finalSol / 1e9} SOL  (spent ${solSpent / 1e9} SOL in fees+curve spread)
    VERDICT: ${verdict ? '✅ PASS' : '⚠️  CHECK'} — ${verdict
      ? 'full curve round trip executed on devnet LaunchLab'
      : 'some tokens remain; inspect the sell tx'}`);

  const summary = {
    program:    DEV_LAB.toBase58(),
    mint:       mint.toBase58(),
    pool:       poolId.toBase58(),
    buyTx:      buySig,
    sellTx:     sell.sig,
    tokensLeft: finalToken.amount.toString(),
    solSpentLamports: solSpent.toString(),
    verdict:    verdict ? 'PASS' : 'CHECK',
    note: 'real signed + broadcast devnet transactions; CPMM leg remains mainnet-only',
  };
  log(`\n=== SUMMARY ===\n${JSON.stringify(summary, null, 2)}`);
}

main().catch(err => { console.error('FAILED:', err?.message || err); process.exitCode = 1; });
