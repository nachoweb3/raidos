/**
 * E2E test for the Raydium LaunchLab integration over the REAL HTTP server.
 *
 * Devnet has no LaunchLab deployment (placeholder account), so on-chain E2E is
 * impossible. Instead this test boots the full ApiServer (real router, real
 * SQLite, real durable sessions, real byte-level verification) and injects a
 * stub Solana surface fed with REAL LaunchLab account encodings (SDK encoders)
 * — then walks the exact flow a browser would:
 *
 *   register → link wallet (signed challenge) → create-tx (browser-held mint
 *   signs locally) → confirm-create → state → quote → prepare buy → sign with
 *   the user keypair → submit → activity; plus hostile paths (wrong signer,
 *   tampered message, replay).
 */

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiServer } from "../src/api/server.js";
import {
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  Connection,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction } from "@solana/spl-token";
import {
  LaunchpadPool,
  LaunchpadConfig,
  PlatformConfig,
  getPdaLaunchpadPoolId,
  getPdaLaunchpadConfigId,
  getPdaLaunchpadVaultId,
  getPdaMetadataKey,
  getPdaLaunchpadAuth,
  getPdaPlatformVault,
  getPdaCreatorVault,
  getPdaCpiEvent,
  LAUNCHPAD_PROGRAM,
  CpmmPoolInfoLayout,
  CpmmConfigInfoLayout,
  getCpmmPdaAmmConfigId,
  getCpmmPdaPoolId,
  getPdaVault,
  getPdaObservationId,
} from "@raydium-io/raydium-sdk-v2";
import { CPMM_PROGRAM } from "../src/trading/launch-cpmm.js";
import BN from "bn.js";
import bs58 from "bs58";

const { ed25519 } = await import("@noble/curves/ed25519");
const configId = getPdaLaunchpadConfigId(LAUNCHPAD_PROGRAM, NATIVE_MINT, 0, 0).publicKey;
const platformId = new PublicKey("4Bu96XjU84XjPDSpveTVf6LYGCkfW5FK7SNkREWcEfV4");
const auth = getPdaLaunchpadAuth(LAUNCHPAD_PROGRAM).publicKey;
const TOTAL_SELL_A = new BN("793100000000000");
const TOTAL_FUND = new BN("85000000000");
const creator = Keypair.generate();

function encodePool(opts: { realA: BN; realB: BN; status?: number; mintA?: PublicKey }): { data: Buffer; poolId: PublicKey; vaultA: PublicKey; vaultQuote: PublicKey } {
  const mintA = opts.mintA ?? Keypair.generate().publicKey;
  const { publicKey: poolId } = getPdaLaunchpadPoolId(LAUNCHPAD_PROGRAM, mintA, NATIVE_MINT);
  const vaultA = getPdaLaunchpadVaultId(LAUNCHPAD_PROGRAM, poolId, mintA).publicKey;
  const vaultQuote = getPdaLaunchpadVaultId(LAUNCHPAD_PROGRAM, poolId, NATIVE_MINT).publicKey;
  const buf = Buffer.alloc(LaunchpadPool.span);
  LaunchpadPool.encode({
    epoch: new BN(0), bump: 250, status: opts.status ?? 0, mintDecimalsA: 6, mintDecimalsB: 9,
    migrateType: 1, supply: new BN("1000000000000000"), totalSellA: TOTAL_SELL_A,
    virtualA: new BN("1073471847374405"), virtualB: new BN("30050573465"),
    realA: opts.realA, realB: opts.realB, totalFundRaisingB: TOTAL_FUND,
    protocolFee: new BN(0), platformFee: new BN(0), migrateFee: new BN(0),
    vestingSchedule: { totalLockedAmount: new BN(0), cliffPeriod: new BN(0), unlockPeriod: new BN(0), startTime: new BN(0), totalAllocatedShare: new BN(0) },
    configId, platformId, mintA, mintB: NATIVE_MINT, vaultA, vaultB: vaultQuote, creator: creator.publicKey,
    mintProgramFlag: 0, cpmmCreatorFeeOn: 0, platformVestingShare: new BN(0),
  }, buf);
  return { data: buf, poolId, vaultA, vaultQuote };
}

function encodeConfig(): Buffer {
  const buf = Buffer.alloc(LaunchpadConfig.span);
  LaunchpadConfig.encode({
    epoch: new BN(0), curveType: 0, index: 0, migrateFee: new BN(0), tradeFeeRate: new BN(2500),
    maxShareFeeRate: new BN(10000), minSupplyA: new BN(10000000), maxLockRate: new BN(800000),
    minSellRateA: new BN(200000), minMigrateRateA: new BN(150000), minFundRaisingB: new BN(24000000000),
    mintB: NATIVE_MINT, protocolFeeOwner: Keypair.generate().publicKey, migrateFeeOwner: Keypair.generate().publicKey,
    migrateToAmmWallet: Keypair.generate().publicKey, migrateToCpmmWallet: Keypair.generate().publicKey,
  }, buf);
  return buf;
}

/** Classic SPL token mint (82 bytes, no authorities). */
function encodeClassicMint(decimals = 6): Buffer {
  const data = Buffer.alloc(82);
  data.writeUInt8(decimals, 44);
  data.writeUInt8(1, 45);
  return data;
}

/** Canonical CPMM ammConfig (index 0) matching the LaunchLab migration. */
function encodeCpmmConfig(): Buffer {
  const buf = Buffer.alloc(CpmmConfigInfoLayout.span);
  CpmmConfigInfoLayout.encode({
    bump: 254, disableCreatePool: false, index: 0,
    tradeFeeRate: new BN(2500), protocolFeeRate: new BN(120000), fundFeeRate: new BN(0),
    createPoolFee: new BN(0),
    protocolOwner: Keypair.generate().publicKey, fundOwner: Keypair.generate().publicKey,
    creatorFeeRate: new BN(0), creatorFeeShareRate: new BN(0),
    __extra: Buffer.alloc(14 * 8),
  }, buf);
  return buf;
}

function encodePlatform(): Buffer {
  const buf = Buffer.alloc(PlatformConfig.span);
  PlatformConfig.encode({
    epoch: new BN(0), bump: 251, status: 0, plateFormIndex: 0, feeRate: new BN(1000),
    name: new Array(64).fill(0), web: new Array(256).fill(0), burnScale: new BN(0),
    transferFee: new BN(0), burnRatio: new BN(0), mintB: NATIVE_MINT, owner: Keypair.generate().publicKey,
    mintPool: new Array(77).fill(Keypair.generate().publicKey),
    withdrawFee: new BN(0), creatorDefaultVesting: { totalLockedAmount: new BN(0), cliffPeriod: new BN(0), unlockPeriod: new BN(0), startTime: new BN(0), totalAllocatedShare: new BN(0) },
    migrateFeeReceiver: Keypair.generate().publicKey, migrateToAmmWallet: Keypair.generate().publicKey, migrateToCpmmWallet: Keypair.generate().publicKey,
    seq: new Array(16).fill(new BN(0)),
  }, buf);
  return buf;
}

// Stubbed chain state (real encodings, addresses the stub RPC serves).
const accounts = new Map<string, { owner: PublicKey; lamports: number; data: Buffer }>();
const configData = encodeConfig();
accounts.set(configId.toBase58(), { owner: LAUNCHPAD_PROGRAM, lamports: 1_000_000, data: configData });
accounts.set(platformId.toBase58(), { owner: LAUNCHPAD_PROGRAM, lamports: 1_000_000, data: encodePlatform() });

class StubConnection extends Connection {
  async getLatestBlockhash() {
    return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 12345 };
  }
  async getAccountInfo(address: PublicKey) {
    const acc = accounts.get(address.toBase58());
    return acc
      ? { owner: acc.owner, lamports: acc.lamports, data: acc.data as unknown as import("@solana/web3.js").AccountInfo<Buffer>["data"], executable: false, rentEpoch: undefined as never }
      : null;
  }
  async sendRawTransaction(raw: Uint8Array): Promise<string> {
    sent.push(raw);
    return bs58.encode(Transaction.from(raw).signature!);
  }
  async confirmTransaction(_sig: string, _c?: string) {
    return { value: { err: null } };
  }
  async getSignatureStatus(signature: string) {
    return { context: { slot: 1 }, value: sent.some(raw => bs58.encode(Transaction.from(raw).signature!) === signature) ? { slot: 1, confirmations: null, err: null, confirmationStatus: "finalized" as const } : null };
  }
  async getMinimumBalanceForRentExemption(n: number) {
    return 1_461_600 + n;
  }
}
const sent: Uint8Array[] = [];

// ── HTTP helpers ──────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), "launchlab-e2e-"));
let server: ApiServer;
let baseUrl: string;
let apiKey = "";

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function signMessageBytes(keypair: Keypair, message: string): string {
  const sig = ed25519.sign(Buffer.from(message, "utf8"), keypair.secretKey.subarray(0, 32));
  return Buffer.from(sig).toString("hex");
}

/** Browser-equivalent signing: deserialize, fill remaining signatures, serialize. */
function signTxLikeBrowser(unsignedB64: string, ...signers: Keypair[]): string {
  const tx = Transaction.from(Buffer.from(unsignedB64, "base64"));
  const message = new Uint8Array(tx.serializeMessage());
  for (const s of signers) {
    const sig = Buffer.from(ed25519.sign(message, s.secretKey.subarray(0, 32)));
    tx.addSignature(s.publicKey, sig);
  }
  return tx.serialize({ requireAllSignatures: true, verifySignatures: false }).toString("base64");
}

beforeAll(async () => {
  server = new ApiServer({
    dbPath: join(dir, "e2e.db"),
    port: 0,
    siteDir: null,
    appMode: "live",
    // Inject the stub chain (real LaunchLab encodings) in place of live RPC.
    solanaConnectionFactory: () => new StubConnection("http://stub") as unknown as Connection,
  });
  const port = await server.start();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("LaunchLab E2E over the real HTTP server", () => {
  it("registers, links the wallet with a signed challenge, and arms execution", async () => {
    const reg = await api("POST", "/api/auth/register", {});
    expect(reg.status).toBe(201);
    apiKey = reg.json.apiKey;

    const ch = await api("POST", "/api/auth/challenge", { chain: "solana" });
    expect(ch.status).toBe(200);
    const wallet = await api("POST", "/api/auth/wallet", {
      chain: "solana", address: creator.publicKey.toBase58(),
      nonce: ch.json.nonce, message: ch.json.message, signature: signMessageBytes(creator, ch.json.message),
    });
    expect(wallet.status).toBe(200);
    // The wallet identity owns its account — use THAT key for the LaunchLab
    // flow (requireLaunchLabWallet demands identity.user_id === authenticated user).
    apiKey = wallet.json.apiKey;
    expect(wallet.json.userId).toBeTruthy();
  });

  it("create-tx → browser-style co-sign of the mint → confirm-create registers the launch", async () => {
    const mint = Keypair.generate();
    const prepared = await api("POST", "/api/launchlab/create-tx", {
      wallet: creator.publicKey.toBase58(), mintPubkey: mint.publicKey.toBase58(),
      name: "E2E Token", symbol: "E2ET", uri: "https://example.com/metadata.json", buyAmountLamports: "20000000",
    });
    expect(prepared.status).toBe(200);
    expect(prepared.json.sessionId).toBeTruthy();

    const signed = signTxLikeBrowser(prepared.json.serialized, mint, creator);
    const confirmed = await api("POST", "/api/launchlab/confirm-create", {
      wallet: creator.publicKey.toBase58(), sessionId: prepared.json.sessionId, signedTx: signed,
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.json.mint).toBe(mint.publicKey.toBase58());

    // The registry row must be confirmed.
    const list = await api("GET", "/api/launchlab/list");
    expect(list.status).toBe(200);
    const row = list.json.launches.find((l: any) => l.mintA === mint.publicKey.toBase58());
    expect(row).toBeTruthy();
    expect(row.confirmedAt).toBeTruthy();
    expect(row.symbol).toBe("E2ET");
  });

  it("state + quote read the live curve for the confirmed mint", async () => {
    const mint = (await api("GET", "/api/launchlab/list")).json.launches[0].mintA;
    // Seed a live pool account for that mint with some real activity.
    const pool = encodePool({ realA: new BN("100000000000"), realB: new BN("10000000000"), mintA: new PublicKey(mint) });
    accounts.set(pool.poolId.toBase58(), { owner: LAUNCHPAD_PROGRAM, lamports: 1_000_000, data: pool.data });

    const state = await api("GET", `/api/launchlab/${mint}/state`);
    expect(state.status).toBe(200);
    expect(state.json.state.curveOpen).toBe(true);
    expect(state.json.state.status).toBe("curve");
    expect(Number(state.json.state.raisedQuote)).toBeGreaterThan(0);

    const q = await api("GET", `/api/launchlab/${mint}/quote?side=buy&amount=50000000&slippageBps=100`);
    expect(q.status).toBe(200);
    expect(Number(q.json.quote.amountOut)).toBeGreaterThan(0);
    expect(Number(q.json.quote.minOut)).toBeLessThan(Number(q.json.quote.amountOut));
  });

  it("prepare → user signature → submit records the fill exactly-once", async () => {
    const mint = (await api("GET", "/api/launchlab/list")).json.launches[0].mintA;
    const prepared = await api("POST", `/api/launchlab/${mint}/prepare`, {
      wallet: creator.publicKey.toBase58(), side: "buy", amountIn: "50000000", slippageBps: 100,
    });
    expect(prepared.status).toBe(200);
    const sessionId = prepared.json.sessionId;

    const signed = signTxLikeBrowser(prepared.json.serialized, creator);
    const submitted = await api("POST", `/api/launchlab/${mint}/submit`, {
      wallet: creator.publicKey.toBase58(), sessionId, signedTx: signed,
    });
    expect(submitted.status).toBe(200);
    expect(submitted.json.signature).toBeTruthy();

    // Activity ledger now contains the fill.
    const act = await api("GET", `/api/launchlab/${mint}/activity`);
    expect(act.status).toBe(200);
    expect(act.json.activity.length).toBe(1);
    expect(act.json.activity[0].side).toBe("buy");

    const recovered = await api("GET", `/api/launchlab/sessions/${sessionId}`);
    expect(recovered.status).toBe(200);
    expect(recovered.json.status).toBe("confirmed");
    expect(recovered.json.signature).toBe(submitted.json.signature);
    const recoveredAgain = await api("GET", `/api/launchlab/sessions/${sessionId}`);
    expect(recoveredAgain.json.status).toBe("confirmed");
    expect((await api("GET", `/api/launchlab/${mint}/activity`)).json.activity.length).toBe(1);

    // Replay of the same session must be rejected (exactly-once).
    const replay = await api("POST", `/api/launchlab/${mint}/submit`, {
      wallet: creator.publicKey.toBase58(), sessionId, signedTx: signed,
    });
    expect(replay.status).toBe(409);
  });

  it("rejects a tampered signed message and a foreign signer", async () => {
    const mint = (await api("GET", "/api/launchlab/list")).json.launches[0].mintA;

    // 1) Tampered: sign a DIFFERENT tx, claim the prepared session.
    const prepared = await api("POST", `/api/launchlab/${mint}/prepare`, {
      wallet: creator.publicKey.toBase58(), side: "buy", amountIn: "30000000", slippageBps: 50,
    });
    expect(prepared.status).toBe(200);
    const other = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
      SystemProgram.transfer({ fromPubkey: creator.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }),
    );
    other.feePayer = creator.publicKey;
    other.recentBlockhash = Keypair.generate().publicKey.toBase58();
    const tampered = other.serialize({ requireAllSignatures: true, verifySignatures: false }).toString("base64");
    const bad = await api("POST", `/api/launchlab/${mint}/submit`, {
      wallet: creator.publicKey.toBase58(), sessionId: prepared.json.sessionId, signedTx: tampered,
    });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/does not match/i);

    // 2) Foreign signer: a different keypair signs a fresh prepare.
    const stranger = Keypair.generate();
    const reg = await api("POST", "/api/auth/challenge", { chain: "solana" });
    const walletLogin = await api("POST", "/api/auth/wallet", {
      chain: "solana", address: stranger.publicKey.toBase58(),
      nonce: reg.json.nonce, message: reg.json.message, signature: signMessageBytes(stranger, reg.json.message),
    });
    expect(walletLogin.status).toBe(200);
    const foreignPrepared = await api("POST", `/api/launchlab/${mint}/prepare`, {
      wallet: stranger.publicKey.toBase58(), side: "buy", amountIn: "20000000", slippageBps: 100,
    });
    expect(foreignPrepared.status).toBe(403);
    apiKey = walletLogin.json.apiKey;
    expect((await api("GET", `/api/launchlab/${mint}/activity`)).json.activity).toEqual([]);
    expect((await api("GET", `/api/launchlab/sessions/${prepared.json.sessionId}`)).status).toBe(404);
    const ownPrepared = await api("POST", `/api/launchlab/${mint}/prepare`, {
      wallet: stranger.publicKey.toBase58(), side: "buy", amountIn: "20000000", slippageBps: 100,
    });
    expect(ownPrepared.status).toBe(200);
    const foreignSigned = signTxLikeBrowser(ownPrepared.json.serialized, stranger);
    const foreignSubmitted = await api("POST", `/api/launchlab/${mint}/submit`, {
      wallet: stranger.publicKey.toBase58(), sessionId: ownPrepared.json.sessionId, signedTx: foreignSigned,
    });
    expect(foreignSubmitted.status).toBe(200); // stranger's OWN session is valid for the stranger
    expect(sent.length).toBeGreaterThanOrEqual(3);
  });

  it("CPMM: flag off → 503; flag on → prepare/sign/submit/record/recover exactly-once", async () => {
    process.env.CPMM_EXECUTION_ENABLED = "1";
    try {
      // Seed a REAL-shape CPMM pool for a fresh launch token (WSOL on side A,
      // the orientation verified against migrated LaunchLab pools).
      const cpmmConfigId = getCpmmPdaAmmConfigId(CPMM_PROGRAM, 0).publicKey;
      const tokenMint = Keypair.generate().publicKey;
      const { publicKey: cpmmPoolId } = getCpmmPdaPoolId(CPMM_PROGRAM, cpmmConfigId, NATIVE_MINT, tokenMint);
      const vaultA = getPdaVault(CPMM_PROGRAM, cpmmPoolId, NATIVE_MINT).publicKey;
      const vaultB = getPdaVault(CPMM_PROGRAM, cpmmPoolId, tokenMint).publicKey;
      const observationId = getPdaObservationId(CPMM_PROGRAM, cpmmPoolId).publicKey;
      const buf = Buffer.alloc(CpmmPoolInfoLayout.span);
      CpmmPoolInfoLayout.encode({
        bump: 253, status: 0, configId: cpmmConfigId, poolCreator: Keypair.generate().publicKey,
        vaultA, vaultB, mintLp: Keypair.generate().publicKey,
        mintA: NATIVE_MINT, mintB: tokenMint,
        mintProgramA: TOKEN_PROGRAM_ID, mintProgramB: TOKEN_PROGRAM_ID,
        observationId, lpDecimals: 9, mintDecimalA: 9, mintDecimalB: 6,
        lpAmount: new BN("1000000000000000"),
        protocolFeesMintA: new BN(0), protocolFeesMintB: new BN(0),
        fundFeesMintA: new BN(0), fundFeesMintB: new BN(0),
        openTime: new BN(0), epoch: new BN(0), feeOn: 2, enableCreatorFee: false,
        creatorFeesMintA: new BN(0), creatorFeesMintB: new BN(0),
      }, buf);
      accounts.set(cpmmPoolId.toBase58(), { owner: CPMM_PROGRAM, lamports: 1_000_000, data: buf });
      accounts.set(cpmmConfigId.toBase58(), { owner: CPMM_PROGRAM, lamports: 1_000_000, data: encodeCpmmConfig() });
      accounts.set(tokenMint.toBase58(), { owner: TOKEN_PROGRAM_ID, lamports: 1_000_000, data: encodeClassicMint(6) });
      const tokenAcc = (amount: bigint, mint: PublicKey) => {
        const d = Buffer.alloc(165);
        d.writeBigUInt64LE(amount, 64);
        mint.toBuffer().copy(d, 0);
        cpmmPoolId.toBuffer().copy(d, 32);
        return { owner: TOKEN_PROGRAM_ID, lamports: 1_000_000, data: d };
      };
      accounts.set(vaultA.toBase58(), tokenAcc(85_000_000_000n, NATIVE_MINT));
      accounts.set(vaultB.toBase58(), tokenAcc(500_000_000_000n, tokenMint));
      const mintA = tokenMint.toBase58();

      // Own identity for the CPMM flow (previous tests left a different key).
      const cpmmUser = Keypair.generate();
      const ch = await api("POST", "/api/auth/challenge", { chain: "solana" });
      const wl = await api("POST", "/api/auth/wallet", {
        chain: "solana", address: cpmmUser.publicKey.toBase58(),
        nonce: ch.json.nonce, message: ch.json.message, signature: signMessageBytes(cpmmUser, ch.json.message),
      });
      expect(wl.status).toBe(200);
      apiKey = wl.json.apiKey;

      // Flag OFF first: prepare must stay disabled.
      delete process.env.CPMM_EXECUTION_ENABLED;
      const off = await api("POST", `/api/cpmm/${mintA}/prepare`, { wallet: cpmmUser.publicKey.toBase58(), side: "buy", amountIn: "50000000", slippageBps: 100 });
      expect(off.status).toBe(503);
      process.env.CPMM_EXECUTION_ENABLED = "1";

      const prepared = await api("POST", `/api/cpmm/${mintA}/prepare`, { wallet: cpmmUser.publicKey.toBase58(), side: "buy", amountIn: "50000000", slippageBps: 100 });
      expect(prepared.status).toBe(200);
      const sessionId = prepared.json.sessionId;

      const signed = signTxLikeBrowser(prepared.json.serialized, cpmmUser);
      const submitted = await api("POST", `/api/cpmm/${mintA}/submit`, { wallet: cpmmUser.publicKey.toBase58(), sessionId, signedTx: signed });
      expect(submitted.status).toBe(200);
      expect(submitted.json.signature).toBeTruthy();

      const act = await api("GET", `/api/cpmm/${mintA}/activity`);
      expect(act.status).toBe(200);
      expect(act.json.activity.length).toBe(1);
      expect(act.json.activity[0].side).toBe("buy");

      // Recovery endpoint: confirmed with the journaled signature, idempotent.
      const recovered = await api("GET", `/api/cpmm/sessions/${sessionId}`);
      expect(recovered.status).toBe(200);
      expect(recovered.json.status).toBe("confirmed");
      expect(recovered.json.signature).toBe(submitted.json.signature);
      expect((await api("GET", `/api/cpmm/sessions/${sessionId}`)).json.status).toBe("confirmed");
      expect((await api("GET", `/api/cpmm/${mintA}/activity`)).json.activity.length).toBe(1);

      // Replay of the same session must be rejected (exactly-once).
      const replay = await api("POST", `/api/cpmm/${mintA}/submit`, { wallet: cpmmUser.publicKey.toBase58(), sessionId, signedTx: signed });
      expect(replay.status).toBe(409);
    } finally {
      delete process.env.CPMM_EXECUTION_ENABLED;
    }
  });
});
