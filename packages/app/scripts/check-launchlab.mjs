// Read-only mainnet check: never signs or broadcasts a transaction.
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { LaunchRaydium, RAYDIUM_PLATFORM_ID } from '../dist/trading/launch-raydium.js';
import { LAUNCHPAD_PROGRAM } from '@raydium-io/raydium-sdk-v2';
const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');
const platform = await connection.getAccountInfo(RAYDIUM_PLATFORM_ID);
console.log(JSON.stringify({ platformExists: !!platform, ownedByLaunchLab: platform?.owner.equals(LAUNCHPAD_PROGRAM) }));
const recent = await connection.getSignaturesForAddress(LAUNCHPAD_PROGRAM, { limit: 5 });
const reference = await connection.getTransaction(recent.find(s => !s.err).signature, { maxSupportedTransactionVersion: 0 });
const payer = reference.transaction.message.staticAccountKeys?.[0] || reference.transaction.message.accountKeys[0];
const engine = new LaunchRaydium(connection, {});
const mint = Keypair.generate().publicKey;
const prepared = await engine.prepareCreateTx({ creator: payer.toBase58(), mintPubkey: mint.toBase58(), name: 'Simulation only', symbol: 'CHECK', uri: 'https://example.com/metadata.json', buyAmountLamports: 20_000_000n });
const tx = Transaction.from(Buffer.from(prepared.serialized, 'base64'));
const result = await connection.simulateTransaction(new VersionedTransaction(tx.compileMessage()), { sigVerify: false, replaceRecentBlockhash: true });
console.log(JSON.stringify({ bytes: Buffer.from(prepared.serialized, 'base64').length, error: result.value.err, units: result.value.unitsConsumed, logs: result.value.logs }, null, 2));
if (result.value.err) process.exitCode = 1;
