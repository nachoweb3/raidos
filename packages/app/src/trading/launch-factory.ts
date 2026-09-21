/**
 * 🏭 Launch graduation factory — turns a simulated curve launch into a real
 * on-chain SPL token.
 *
 * Honesty contract (matches the rest of the launchpad):
 * - The curve never custodied USDC, so the factory does NOT conjure liquidity
 *   or a market. It mints the real token directly to the associated token
 *   accounts of the wallets registered in `launch_claims` — nothing more,
 *   nothing less. Seeding an LP is an explicit, separate operator decision.
 * - Distribution totals are derived from the net ledger (buys − sells), the
 *   same numbers the claim UI showed, so what holders signed for is what ships.
 * - Supply is fixed: after the last mint the mint authority is revoked, so
 *   nobody (including the treasury) can ever mint more.
 * - Execution is operator-gated: admin secret + kill switch, dry-run by
 *   default, plan inspectable before anything is broadcast.
 *
 * Network access goes through the minimal `SolanaLike` port so every decision
 * (plan shape, batching, amounts, authority handoff) is testable offline.
 */

import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  AuthorityType,
  ExtensionType,
  MINT_SIZE,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction,
  createInitializeMetadataPointerInstruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  getAssociatedTokenAddressSync,
  getMintLen,
} from "@solana/spl-token";
import bs58 from "bs58";

/** u64 ceiling for SPL amounts. */
export const U64_MAX = (1n << 64n) - 1n;
/** Conservative batch size including ATA creation and mint instructions. */
export const TRANSFER_BATCH_SIZE = 4;
/**
 * The curve trades WHOLE tokens (integer ledger units, no decimals column),
 * so the real mint uses 0 decimals: 1 base unit on-chain = 1 ledger token.
 * No conversion, no truncation, no drift between UI and chain.
 */
export const TOKEN_DECIMALS = 0;

export interface FactoryDistributionRow {
  userId: number;
  /** Destination wallet for Solana claims; null for other chains (skipped). */
  walletAddress: string | null;
  /** Net whole tokens from the ledger (gross buys − gross sells). */
  netTokens: number;
}

/** The launch row fields the factory reads. */
export interface FactoryLaunchRow {
  id: number;
  symbol: string;
  name: string;
  uri?: string | null;
  factory_status: string | null;
  graduated_on_chain: number;
}

/** Minimal DB surface the factory needs (subset of AppDb). */
export interface FactoryDb {
  beginLaunchFactoryExecution(launchId: number, expectedPlan: string, journal: string): boolean;
  getLaunch(id: number): FactoryLaunchRow | null;
  getLaunchDistribution(launchId: number): FactoryDistributionRow[];
  setLaunchFactoryStatus(launchId: number, status: string, result?: string | null, mintAddress?: string | null): void;
  markGraduatedOnChain(launchId: number, mintAddress: string, txSignature: string): void;
}

/**
 * Minimal Solana surface the factory uses. `Connection` satisfies this; tests
 * inject a stub so no test ever touches the network.
 */
export interface SolanaLike {
  getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  getMinimumBalanceForRentExemption(byteLength: number): Promise<number>;
  /** null when the account does not exist. */
  getAccountInfo(address: PublicKey): Promise<{ executable: boolean; owner: PublicKey; lamports: number; data: Uint8Array } | null>;
  sendRawTransaction(raw: Uint8Array): Promise<string>;
  /** Signature-based confirmation; matches Connection's string overload. */
  confirmTransaction(signature: string, commitment?: string): Promise<unknown>;
}

export interface GraduationAllocation {
  userId: number;
  wallet: string;
  /** Exact base units owed to this wallet. */
  amountBase: bigint;
  /** Derived destination ATA (offline derivation, no RPC). */
  ata: string;
}

export interface GraduationPlan {
  launchId: number;
  symbol: string;
  name: string;
  uri: string;
  decimals: number;
  /** Mint address chosen for this plan. */
  mintAddress: string;
  /** Sum of allocations in base units — the exact fixed supply. */
  totalSupplyBase: bigint;
  allocations: GraduationAllocation[];
  /** Number of holder transactions (excluding create-mint and revoke). */
  batches: number;
  /** Zero-balance rows kept out of the mint (transparency). */
  excludedAccounts: number;
}

/** JSON-safe plan (BigInt → string) for API responses and DB storage. */
export function planToJson(plan: GraduationPlan) {
  return {
    launchId: plan.launchId,
    symbol: plan.symbol,
    name: plan.name,
    uri: plan.uri,
    decimals: plan.decimals,
    mintAddress: plan.mintAddress,
    totalSupplyBase: plan.totalSupplyBase.toString(),
    totalTokensHuman: Number(plan.totalSupplyBase) / 10 ** plan.decimals,
    batches: plan.batches,
    excludedAccounts: plan.excludedAccounts,
    allocations: plan.allocations.map((a) => ({
      userId: a.userId,
      wallet: a.wallet,
      ata: a.ata,
      amountBase: a.amountBase.toString(),
    })),
  };
}

export class FactoryError extends Error {
  constructor(
    public readonly code:
      | "LAUNCH_NOT_FOUND"
      | "ALREADY_GRADUATED"
      | "EMPTY_DISTRIBUTION"
      | "BAD_WALLET"
      | "AMOUNT_OVERFLOW"
      | "STALE_PLAN"
      | "RECOVERY_REQUIRED"
      | "CONFIRMATION_FAILED"
      | "RPC_DISABLED",
    message: string,
  ) {
    super(message);
    this.name = "FactoryError";
  }
}


function assertSolanaWallet(userId: number, wallet: string): PublicKey {
  try {
    const key = new PublicKey(wallet);
    if (!isValidSolanaWallet(wallet)) throw new Error("charset");
    return key;
  } catch {
    throw new FactoryError("BAD_WALLET", `claim by user ${userId} has an invalid Solana wallet: ${wallet}`);
  }
}

export function isValidSolanaWallet(addr: string): boolean {
  return addr.length >= 32 && addr.length <= 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(addr);
}

/**
 * Pure function: launch row + claims → exact graduation plan.
 * No network, no signer, no writes. Auditable before execution.
 */
export function buildGraduationPlan(
  launch: FactoryLaunchRow,
  distribution: FactoryDistributionRow[],
  mintKeypair: Keypair,
  opts: { uri?: string } = {},
): GraduationPlan {
  if (launch.factory_status === "completed" || launch.graduated_on_chain === 1) {
    throw new FactoryError("ALREADY_GRADUATED", "launch has already graduated on-chain");
  }
  if (["executing", "recovery_required", "failed"].includes(launch.factory_status ?? "")) {
    throw new FactoryError("RECOVERY_REQUIRED", "previous graduation requires on-chain review before another execution");
  }

  const allocations: GraduationAllocation[] = [];
  for (const row of distribution) {
    if (row.netTokens <= 0) continue; // zero/negative net: nothing owed
    if (!row.walletAddress) continue; // non-Solana claim: cannot receive an SPL mint (counted as excluded)
    if (!Number.isSafeInteger(row.netTokens)) throw new FactoryError("AMOUNT_OVERFLOW", "ledger token amount must be an exact safe integer");
    const owner = assertSolanaWallet(row.userId, row.walletAddress);
    // Ledger units are whole tokens and the mint has 0 decimals: identity map.
    const amountBase = BigInt(row.netTokens);
    if (amountBase > U64_MAX) throw new FactoryError("AMOUNT_OVERFLOW", `allocation for user ${row.userId} exceeds u64`);
    allocations.push({
      userId: row.userId,
      wallet: row.walletAddress,
      amountBase,
      ata: getAssociatedTokenAddressSync(mintKeypair.publicKey, owner, false, TOKEN_2022_PROGRAM_ID).toBase58(),
    });
  }

  if (allocations.length === 0) {
    throw new FactoryError("EMPTY_DISTRIBUTION", "no registered claims with a positive balance — nothing to mint");
  }

  const totalSupplyBase = allocations.reduce((acc, a) => acc + a.amountBase, 0n);
  if (totalSupplyBase > U64_MAX) throw new FactoryError("AMOUNT_OVERFLOW", "total supply exceeds u64");

  return {
    launchId: launch.id,
    symbol: launch.symbol.slice(0, 10),
    name: launch.name.slice(0, 40),
    uri: (opts.uri ?? launch.uri ?? "").slice(0, 200),
    decimals: TOKEN_DECIMALS,
    mintAddress: mintKeypair.publicKey.toBase58(),
    totalSupplyBase,
    allocations,
    batches: Math.ceil(allocations.length / TRANSFER_BATCH_SIZE),
    excludedAccounts: distribution.length - allocations.length,
  };
}

/** Rebuild a plan from its JSON form (e.g. an API body). Throws if the shape is wrong. */
export function planFromJson(json: {
  launchId?: unknown;
  symbol?: unknown;
  name?: unknown;
  uri?: unknown;
  decimals?: unknown;
  mintAddress?: unknown;
  totalSupplyBase?: unknown;
  batches?: unknown;
  excludedAccounts?: unknown;
  allocations?: unknown;
}): GraduationPlan {
  const req = (v: unknown, field: string): string => {
    if (typeof v !== "string" || !v) throw new FactoryError("STALE_PLAN", `plan.${field} is required`);
    return v;
  };
  if (typeof json.launchId !== "number" || !Number.isFinite(json.launchId)) throw new FactoryError("STALE_PLAN", "plan.launchId is required");
  if (typeof json.decimals !== "number" || !Number.isInteger(json.decimals) || json.decimals < 0 || json.decimals > 9) {
    throw new FactoryError("STALE_PLAN", "plan.decimals is required (0-9)");
  }
  const allocs = json.allocations;
  if (!Array.isArray(allocs) || allocs.length === 0) throw new FactoryError("STALE_PLAN", "plan.allocations must be a non-empty array");
  const allocations = allocs.map((a) => {
    const row = a as Record<string, unknown>;
    const userId = row.userId;
    if (typeof userId !== "number" || !Number.isInteger(userId) || userId <= 0) throw new FactoryError("STALE_PLAN", "plan allocation userId is invalid");
    const wallet = req(row.wallet, "allocation.wallet");
    const ata = req(row.ata, "allocation.ata");
    const amountBase = req(row.amountBase, "allocation.amountBase");
    if (!/^\d+$/.test(amountBase)) throw new FactoryError("STALE_PLAN", "plan allocation amountBase must be a decimal string");
    const amount = BigInt(amountBase);
    if (amount <= 0n) throw new FactoryError("STALE_PLAN", "plan allocation amountBase must be positive");
    return { userId, wallet, ata, amountBase: amount };
  });
  const totalSupplyBase = req(json.totalSupplyBase, "totalSupplyBase");
  if (!/^\d+$/.test(totalSupplyBase)) throw new FactoryError("STALE_PLAN", "plan.totalSupplyBase must be a decimal string");
  return {
    launchId: json.launchId,
    symbol: req(json.symbol, "symbol"),
    name: req(json.name, "name"),
    uri: typeof json.uri === "string" ? json.uri : "",
    decimals: json.decimals,
    mintAddress: req(json.mintAddress, "mintAddress"),
    totalSupplyBase: BigInt(totalSupplyBase),
    allocations,
    batches: typeof json.batches === "number" ? json.batches : Math.ceil(allocations.length / TRANSFER_BATCH_SIZE),
    excludedAccounts: typeof json.excludedAccounts === "number" ? json.excludedAccounts : 0,
  };
}

export class LaunchFactory {
  private readonly solana: SolanaLike | null;
  private readonly programId: PublicKey;

  constructor(
    private readonly db: FactoryDb,
    opts: { solana?: SolanaLike; programId?: PublicKey } = {},
  ) {
    this.solana = opts.solana ?? null;
    this.programId = opts.programId ?? TOKEN_2022_PROGRAM_ID;
  }

  /**
   * Build and persist a plan. Deterministic except the fresh mint keypair.
   * No chain interaction; safe to run against production data.
   */
  plan(launchId: number, uri?: string): GraduationPlan {
    const launch = this.db.getLaunch(launchId);
    if (!launch) throw new FactoryError("LAUNCH_NOT_FOUND", `launch ${launchId} does not exist`);
    const mintKeypair = Keypair.generate();
    const plan = buildGraduationPlan(launch, this.db.getLaunchDistribution(launchId), mintKeypair, { uri });
    // Remember the keypair so `execute` can create this exact mint. Plans
    // survive only in-process: after a restart, a fresh plan must be
    // generated and re-reviewed — stale plans cannot be replayed blindly.
    this.recentPlans.set(launchId, { mintAddress: plan.mintAddress, keypair: mintKeypair, canonical: JSON.stringify(planToJson(plan)) });
    this.db.setLaunchFactoryStatus(launchId, "planned", JSON.stringify(planToJson(plan)), plan.mintAddress);
    return plan;
  }

  /**
   * Simulate the graduation: which transactions would be built, in what
   * order, with which instructions and amounts — without any network or
   * state change. This is what the admin endpoint returns by default.
   */
  dryRun(plan: GraduationPlan): Array<{ label: string; instructions: string[]; amounts: string[] }> {
    const mint = new PublicKey(plan.mintAddress);
    const steps: Array<{ label: string; instructions: string[]; amounts: string[] }> = [];

    steps.push({
      label: "create-mint",
      instructions: ["SystemProgram.createAccount", "initializeMetadataPointer", "initializeMint2"],
      amounts: [`supply=${plan.totalSupplyBase.toString()}`],
    });

    for (let i = 0; i < plan.allocations.length; i += TRANSFER_BATCH_SIZE) {
      const batch = plan.allocations.slice(i, i + TRANSFER_BATCH_SIZE);
      const idx = i / TRANSFER_BATCH_SIZE;
      const instructions: string[] = [];
      const amounts: string[] = [];
      for (const a of batch) {
        instructions.push(`createAssociatedTokenAccount?(${a.ata.slice(0, 8)}…)`, `mintTo(${a.ata.slice(0, 8)}…)`);
        amounts.push(a.amountBase.toString());
      }
      steps.push({ label: `holders-batch-${idx + 1}/${plan.batches}`, instructions, amounts });
    }

    void mint;
    steps.push({ label: "revoke-mint-authority", instructions: ["setAuthority(MintTokens → null)"], amounts: [] });
    return steps;
  }

  /**
   * Execute the graduation against the configured Solana endpoint:
   * create mint → mint supply to claimant ATAs (batched) → revoke authority.
   * Marks state "executing" first, "completed" only after the final confirm.
   * The treasury (fee payer + temporary mint authority) is passed per call so
   * the factory instance itself stays keyless.
   */
  async execute(plan: GraduationPlan, treasury: Keypair): Promise<{ mint: string; signatures: string[] }> {
    if (!this.solana) throw new FactoryError("RPC_DISABLED", "no Solana endpoint configured for the graduation factory");
    const solana = this.solana;
    const payer = treasury.publicKey;
    const signatures: string[] = [];

    // Re-verify against the DB: the plan must match the CURRENT claims.
    // If the distribution changed since planning (new claim, transfer, sell),
    // refuse to execute rather than mis-deliver someone's tokens.
    const launch = this.db.getLaunch(plan.launchId);
    if (!launch) throw new FactoryError("LAUNCH_NOT_FOUND", `launch ${plan.launchId} does not exist`);
    if (launch.graduated_on_chain === 1 || launch.factory_status === "completed") {
      throw new FactoryError("ALREADY_GRADUATED", "launch has already graduated on-chain");
    }
    const mintKeypair = this.mintKeypairFor(plan);
    if (JSON.stringify(planToJson(plan)) !== this.recentPlans.get(plan.launchId)!.canonical) {
      throw new FactoryError("STALE_PLAN", "plan is stale or modified; regenerate it before executing");
    }
    const verifyPlan = buildGraduationPlan(launch, this.db.getLaunchDistribution(plan.launchId), mintKeypair, { uri: plan.uri });
    if (
      verifyPlan.totalSupplyBase !== plan.totalSupplyBase ||
      verifyPlan.decimals !== plan.decimals ||
      verifyPlan.allocations.length !== plan.allocations.length ||
      verifyPlan.allocations.some((a, i) => {
        const planned = plan.allocations[i];
        if (!planned) return true;
        return a.userId !== planned.userId || a.wallet !== planned.wallet || a.amountBase !== planned.amountBase;
      })
    ) {
      throw new FactoryError("STALE_PLAN", "plan is stale: the claim distribution changed since it was generated; regenerate the plan");
    }

    // Resolve the mint keypair BEFORE any state write: a stale plan must not
    // leave the launch marked as executing.
    const mint = mintKeypair.publicKey;
    if (mint.toBase58() !== plan.mintAddress) {
      throw new FactoryError("STALE_PLAN", "plan is stale: regenerate the plan before executing");
    }

    const journal: { plan: ReturnType<typeof planToJson>; transactions: Array<{ signature: string; serialized: string; blockhash: string; lastValidBlockHeight: number; confirmed: boolean }>; error?: string } = {
      plan: planToJson(plan), transactions: [],
    };
    const persist = () => this.db.setLaunchFactoryStatus(plan.launchId, "executing", JSON.stringify(journal), plan.mintAddress);
    if (!this.db.beginLaunchFactoryExecution(plan.launchId, this.recentPlans.get(plan.launchId)!.canonical, JSON.stringify(journal))) {
      throw new FactoryError("RECOVERY_REQUIRED", "graduation already executing or persisted plan changed");
    }
    const send = async (tx: Transaction, extraSigners: Keypair[]) => {
      const { blockhash, lastValidBlockHeight } = await solana.getLatestBlockhash();
      tx.feePayer = treasury.publicKey; tx.recentBlockhash = blockhash;
      tx.sign(treasury, ...extraSigners);
      const raw = tx.serialize();
      const entry = { signature: bs58.encode(tx.signature!), serialized: raw.toString("base64"), blockhash, lastValidBlockHeight, confirmed: false };
      journal.transactions.push(entry); persist(); // durable BEFORE network submission
      const signature = await solana.sendRawTransaction(raw);
      if (signature !== entry.signature) throw new FactoryError("CONFIRMATION_FAILED", "RPC returned an unexpected transaction signature");
      const result = await solana.confirmTransaction(signature, "confirmed") as { value?: { err?: unknown } } | null;
      if (!result?.value || result.value.err !== null) throw new FactoryError("CONFIRMATION_FAILED", "transaction failed or confirmation is unavailable; review the persisted signature");
      entry.confirmed = true; persist(); return signature;
    };
    try {
    // Re-read after the durable lock: a concurrent ledger write may have won
    // immediately before it. Locked launches reject subsequent curve/claim writes.
    const lockedPlan = buildGraduationPlan({ ...launch, factory_status: "planned" }, this.db.getLaunchDistribution(plan.launchId), mintKeypair, { uri: plan.uri });
    if (JSON.stringify(planToJson(lockedPlan)) !== JSON.stringify(planToJson(plan))) throw new FactoryError("STALE_PLAN", "distribution changed while acquiring execution lock");

    // ── Tx 1: create + initialize the mint (Token-2022) ──
    const space = getMintLen([ExtensionType.MetadataPointer]);
    const rent = await solana.getMinimumBalanceForRentExemption(space);
    const createTx = new Transaction().add(
      SystemProgram.createAccount({ fromPubkey: payer, newAccountPubkey: mint, space, lamports: rent, programId: this.programId }),
      createInitializeMetadataPointerInstruction(mint, null, null, this.programId),
      createInitializeMint2Instruction(mint, plan.decimals, payer, null, this.programId),
    );
    signatures.push(await send(createTx, [mintKeypair]));

    // ── Txs 2..N: mint directly to each claimant's ATA, batched ──
    for (let i = 0; i < plan.allocations.length; i += TRANSFER_BATCH_SIZE) {
      const batch = plan.allocations.slice(i, i + TRANSFER_BATCH_SIZE);
      const instructions: TransactionInstruction[] = [];
      for (const a of batch) {
        const owner = new PublicKey(a.wallet);
        const ata = new PublicKey(a.ata);
        const info = await solana.getAccountInfo(ata);
        if (!info) instructions.push(createAssociatedTokenAccountInstruction(payer, ata, owner, mint, this.programId));
        instructions.push(createMintToInstruction(mint, ata, payer, a.amountBase, [], this.programId));
      }
      signatures.push(await send(new Transaction().add(...instructions), []));
    }

    // ── Final tx: revoke mint authority — supply is fixed forever ──
    const revokeTx = new Transaction().add(createSetAuthorityInstruction(mint, payer, AuthorityType.MintTokens, null, [], this.programId));
    signatures.push(await send(revokeTx, []));

    this.db.markGraduatedOnChain(plan.launchId, mint.toBase58(), signatures[signatures.length - 1] ?? "");
    this.db.setLaunchFactoryStatus(plan.launchId, "completed", JSON.stringify(journal), mint.toBase58());
    return { mint: mint.toBase58(), signatures };
    } catch (error) {
      journal.error = error instanceof Error ? error.message : "Graduation failed";
      this.db.setLaunchFactoryStatus(plan.launchId, "recovery_required", JSON.stringify(journal), mint.toBase58());
      throw error;
    }
  }

  /**
   * Derive the same mint keypair the plan was built with. Plans are generated
   * with `Keypair.generate()`, so this only works for plans produced in this
   * process lifetime — a safety property: a stale plan cannot be replayed
   * after a restart without regenerating and re-reviewing it.
   */
  private mintKeypairFor(plan: GraduationPlan): Keypair {
    const found = this.recentPlans.get(plan.launchId);
    if (!found || found.mintAddress !== plan.mintAddress) {
      throw new FactoryError("STALE_PLAN", "plan is stale: regenerate the plan before executing");
    }
    return found.keypair;
  }

  private recentPlans = new Map<number, { mintAddress: string; keypair: Keypair; canonical: string }>();

}
