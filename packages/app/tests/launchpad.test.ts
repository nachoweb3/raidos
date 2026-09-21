/**
 * 🚀 Launchpad safety tests — curve integrity, holdings enforcement and
 * creation validation. The curve is a server-side simulation; these tests
 * pin the financial invariants that the future on-chain factory must keep.
 */

import { generateKeyPairSync, sign as ed25519Sign } from "node:crypto";
import bs58 from "bs58";
import { ethers } from "ethers";
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { TokenLaunchpad, type LaunchRow } from "../src/trading/launchpad.js";
import {
  LaunchFactory,
  buildGraduationPlan,
  planFromJson,
  planToJson,
  TRANSFER_BATCH_SIZE,
  type SolanaLike,
} from "../src/trading/launch-factory.js";

/** Minimal fake ledger: per-user gross buys/sells, no cross-user leakage. */
function makeDb() {
  const launches = new Map<number, LaunchRow>();
  const trades: { launchId: number; userId: number; side: "buy" | "sell"; tokens: string; usdc: string }[] = [];
  const claims: { launchId: number; userId: number; chain: string; walletAddress: string; message: string; createdAt: number; updatedAt: number }[] = [];
  let nextId = 1;
  const totals = (launchId: number, userId: number, side: "buy" | "sell") =>
    trades
      .filter((t) => t.launchId === launchId && t.userId === userId && t.side === side)
      .reduce((a, t) => ({ tokens: a.tokens + BigInt(t.tokens), usdc: a.usdc + BigInt(t.usdc) }), { tokens: 0n, usdc: 0n });

  return {
    launches,
    trades,
    createLaunch(input: any) {
      const id = nextId++;
      launches.set(id, { ...input, id } as LaunchRow);
      return id;
    },
    getLaunch(id: number) {
      return launches.get(id);
    },
    listLaunches(chain: string, status?: string, limit = 20) {
      return [...launches.values()].filter((l) => l.chain === chain && (!status || l.status === status)).slice(0, limit);
    },
    listLaunchesByUser(_userId: number, _limit?: number) {
      return [];
    },
    updateLaunch(id: number, updates: Partial<LaunchRow>) {
      const l = launches.get(id);
      if (l) Object.assign(l, updates);
    },
    addLaunchBuyer(_launchId: number, _userId: number, _usdc: string, _tokens: string) {},
    launchTransaction<T>(fn: () => T): T {
      return fn();
    },
    getLaunchBuyTotals: (launchId: number, userId: number) => totals(launchId, userId, "buy"),
    getLaunchSellTotals: (launchId: number, userId: number) => totals(launchId, userId, "sell"),
    addLaunchTrade(launchId: number, userId: number, side: "buy" | "sell", tokens: string, usdc: string) {
      trades.push({ launchId, userId, side, tokens, usdc });
    },
    // Claim wallet registry (mirrors AppDb.upsertLaunchClaim semantics)
    upsertLaunchClaim(launchId: number, userId: number, chain: string, walletAddress: string, message: string) {
      const now = Math.floor(Date.now() / 1000);
      const existing = claims.find((c) => c.userId === userId && c.launchId === launchId);
      if (existing) {
        if (claims.some((c) => c.launchId === launchId && c.walletAddress === walletAddress && c.userId !== userId)) {
          throw new Error("WALLET_IN_USE");
        }
        existing.chain = chain;
        existing.walletAddress = walletAddress;
        existing.message = message;
        existing.updatedAt = now;
        return { created: false };
      }
      if (claims.some((c) => c.launchId === launchId && c.walletAddress === walletAddress)) {
        throw new Error("WALLET_IN_USE");
      }
      claims.push({ launchId, userId, chain, walletAddress, message, createdAt: now, updatedAt: now });
      return { created: true };
    },
    getLaunchClaim(launchId: number, userId: number) {
      const c = claims.find((c) => c.userId === userId && c.launchId === launchId);
      return c ? { chain: c.chain, wallet_address: c.walletAddress, created_at: c.createdAt, updated_at: c.updatedAt } : undefined;
    },
    listLaunchClaims(launchId: number) {
      return claims
        .filter((c) => c.launchId === launchId)
        .map((c) => ({ user_id: c.userId, chain: c.chain, wallet_address: c.walletAddress, created_at: c.createdAt }));
    },
    // ── Graduation factory surface (mirrors AppDb) ──
    getLaunchDistribution(launchId: number) {
      return claims
        .filter((c) => c.launchId === launchId)
        .map((c) => {
          const net = totals(launchId, c.userId, "buy").tokens - totals(launchId, c.userId, "sell").tokens;
          return { userId: c.userId, walletAddress: c.chain === "solana" ? c.walletAddress : null, netTokens: Number(net) };
        });
    },
    beginLaunchFactoryExecution(launchId: number, expectedPlan: string, journal: string) {
      const l = launches.get(launchId);
      if (!l || l.factory_status !== "planned" || l.factory_result !== expectedPlan || l.graduated_on_chain === 1) return false;
      l.factory_status = "executing"; l.factory_result = journal; return true;
    },
    setLaunchFactoryStatus(launchId: number, status: string, result?: string | null, mintAddress?: string | null) {
      const l = launches.get(launchId);
      if (!l) return;
      Object.assign(l, {
        factory_status: status,
        factory_result: result ?? (l as any).factory_result ?? null,
        mint_address: mintAddress ?? (l as any).mint_address ?? null,
      });
    },
    markGraduatedOnChain(launchId: number, mintAddress: string, txSignature: string) {
      const l = launches.get(launchId);
      if (!l) return;
      Object.assign(l, {
        graduated_on_chain: 1,
        graduation_simulated: 0,
        mint_address: mintAddress,
        factory_status: "completed",
        factory_result: JSON.stringify({ graduated: true, txSignature }),
      });
    },
  };
}

function makeLaunchpad() {
  const db = makeDb();
  const lp = new TokenLaunchpad(db as never);
  return { db, lp };
}

/** Snake-case row defaults, mirroring what AppDb.createLaunch stores. */
const ROW_DEFAULTS = {
  creator_id: 1,
  chain: "solana",
  name: "Test Coin",
  symbol: "TST",
  description: "",
  image_url: "",
  total_supply: "1000000000000",
  current_price_usdc: "1000",
  market_cap_usdc: "1000000",
  raised_usdc: "0",
  graduate_threshold: "85000000000",
  status: "created",
  buyers_count: 0,
  created_at: 1_700_000_000,
};

const DRAFT_DEFAULTS = {
  chain: "solana",
  name: "Test Coin",
  symbol: "TST",
  description: "",
  imageUrl: "",
  totalSupply: "1000000000000",
};

describe("launchpad safety", () => {
  it("rejects selling tokens the user never bought (holdings exploit)", async () => {
    const { db, lp } = makeLaunchpad();
    const id = db.createLaunch({ ...ROW_DEFAULTS, raised_usdc: "50000000", current_price_usdc: "1050", status: "funding" });

    const r = await lp.sellTokens(2, id, "1000");
    expect(r.success).toBe(false);
    expect(r.error).toBe("Insufficient holdings");
  });

  it("caps sells at the user's net (buys - sells) holdings", async () => {
    const { db, lp } = makeLaunchpad();
    const id = db.createLaunch({ ...ROW_DEFAULTS, raised_usdc: "50000000", current_price_usdc: "1050", status: "funding" });
    db.addLaunchTrade(id, 2, "buy", "1000", "1000000");

    const oversell = await lp.sellTokens(2, id, "1001");
    expect(oversell.success).toBe(false);

    const ok = await lp.sellTokens(2, id, "400");
    expect(ok.success).toBe(true);
    expect(ok.usdcAmount).toBeDefined();

    const second = await lp.sellTokens(2, id, "601");
    expect(second.success).toBe(false);
  });

  it("keeps curve invariants: raised tracks ledger delta, price monotone", async () => {
    const { db, lp } = makeLaunchpad();
    const id = db.createLaunch({ ...ROW_DEFAULTS });

    const b1 = await lp.buyTokens(2, id, "5000000"); // 5 USDC
    expect(b1.success).toBe(true);
    const afterBuy = db.getLaunch(id)!;
    expect(afterBuy.raised_usdc).toBe("5000000");
    const buyPrice = BigInt(afterBuy.current_price_usdc);

    const s1 = await lp.sellTokens(2, id, (Number(b1.tokenAmount) / 2).toFixed(0));
    expect(s1.success).toBe(true);
    const afterSell = db.getLaunch(id)!;
    expect(BigInt(afterSell.raised_usdc)).toBeLessThan(5000000n);
    expect(BigInt(afterSell.raised_usdc)).toBeGreaterThanOrEqual(0n);
    expect(BigInt(afterSell.current_price_usdc)).toBeLessThan(buyPrice);
  });

  it("rejects invalid inputs before touching the ledger", async () => {
    const { db, lp } = makeLaunchpad();
    const id = db.createLaunch({ ...ROW_DEFAULTS });

    expect((await lp.buyTokens(2, id, "-5")).success).toBe(false);
    expect((await lp.buyTokens(2, id, "999")).success).toBe(false); // below dust floor
    expect((await lp.sellTokens(2, id, "-1")).success).toBe(false);
    expect((await lp.sellTokens(2, id, "1e3")).success).toBe(false);
    expect(db.trades.filter((t) => t.launchId === id)).toHaveLength(0);
  });

  it("enforces the dust floor of 0.1 USDC on buys", async () => {
    const { db, lp } = makeLaunchpad();
    const id = db.createLaunch({ ...ROW_DEFAULTS });
    const r = await lp.buyTokens(2, id, "99999"); // 0.099999 USDC
    expect(r.success).toBe(false);
  });

  it("graduation carries no fake txHash", async () => {
    const { db, lp } = makeLaunchpad();
    const id = db.createLaunch({ ...ROW_DEFAULTS, raised_usdc: "84999999999", current_price_usdc: "1100", status: "funding" });
    const r = await lp.buyTokens(2, id, "1000000");
    expect(r.graduated).toBe(true);
    expect(r.txHash).toBeUndefined();
    const l = db.getLaunch(id)!;
    expect(l.status).toBe("graduated");
    expect(l.graduation_simulated).toBe(1);
  });

  it("validateDraft rejects bad symbol, supply and chain", () => {
    const { lp } = makeLaunchpad();
    expect(() => lp.validateDraft({ ...DRAFT_DEFAULTS, symbol: "TOOLONGSYMBO" })).toThrow(/symbol/i);
    expect(() => lp.validateDraft({ ...DRAFT_DEFAULTS, symbol: "A!" })).toThrow(/symbol/i);
    expect(() => lp.validateDraft({ ...DRAFT_DEFAULTS, name: "a" })).toThrow(/name/i);
    expect(() => lp.validateDraft({ ...DRAFT_DEFAULTS, totalSupply: "-5" })).toThrow(/supply/i);
    expect(() => lp.validateDraft({ ...DRAFT_DEFAULTS, totalSupply: "1000000000000000000000000000000000000" })).toThrow(/supply/i);
    expect(() => lp.validateDraft({ ...DRAFT_DEFAULTS, chain: "polygon" })).toThrow(/chain/i);
    const ok = lp.validateDraft({ ...DRAFT_DEFAULTS, symbol: "ok" });
    expect(ok.symbol).toBe("OK");
  });

  it("position derives holdings and avg cost from the ledger", async () => {
    const { db, lp } = makeLaunchpad();
    const id = db.createLaunch({ ...ROW_DEFAULTS });
    await lp.buyTokens(2, id, "5000000");
    const p1 = lp.getLaunchPosition(2, id)!;
    expect(BigInt(p1.tokens) > 0n).toBe(true);
    expect(BigInt(p1.avgCostUsdc) > 0n).toBe(true);

    await lp.sellTokens(2, id, (Number(p1.tokens) / 4).toFixed(0));
    const p2 = lp.getLaunchPosition(2, id)!;
    expect(BigInt(p2.tokens)).toBeLessThan(BigInt(p1.tokens));
    expect(BigInt(p2.realizedUsdc) > 0n).toBe(true);

    const p3 = lp.getLaunchPosition(3, id)!; // launch exists → honest zero position
    expect(p3.tokens).toBe("0");
    expect(p3.costUsdc).toBe("0");
    expect(lp.getLaunchPosition(2, 999999)).toBeNull(); // unknown launch → null
  });
});

/** Real ed25519 signer built from a node keypair (same wire format as Phantom). */
function makeSolanaSigner() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const address = bs58.encode(der.subarray(der.length - 32));
  return { address, sign(message: string) {
    return Buffer.from(ed25519Sign(null, Buffer.from(message, "utf8"), privateKey)).toString("hex");
  } };
}

describe("launch claims", () => {
  it("requires a valid signature and keeps one wallet per holder", async () => {
    const { db, lp } = makeLaunchpad();
    const id = db.createLaunch({ ...ROW_DEFAULTS });
    const signer = makeSolanaSigner();
    const ch = { message: "trenches wants you to sign in\nNonce: abc" };

    // Bad signature is rejected without writing anything.
    await expect(lp.registerClaim(2, id, { chain: "solana", address: signer.address, message: ch.message, signature: "00".repeat(64) }))
      .rejects.toThrow("BAD_SIGNATURE");
    expect(lp.getClaimStatus(2, id)!.wallet).toBeNull();

    // Valid signature registers; re-registration updates instead of duplicating.
    const wallet = await lp.registerClaim(2, id, { chain: "solana", address: signer.address, message: ch.message, signature: signer.sign(ch.message) });
    expect(wallet).toEqual({ chain: "solana", address: signer.address });
    const again = await lp.registerClaim(2, id, { chain: "solana", address: signer.address, message: ch.message, signature: signer.sign(ch.message) });
    expect(again.address).toBe(signer.address);
    expect(lp.getLaunchDistribution(id)).toHaveLength(1);

    // A second account cannot claim the same wallet on the same launch.
    await expect(lp.registerClaim(3, id, { chain: "solana", address: signer.address, message: ch.message, signature: signer.sign(ch.message) }))
      .rejects.toThrow("WALLET_IN_USE");

    // Malformed addresses are rejected before any crypto runs.
    await expect(lp.registerClaim(2, id, { chain: "solana", address: "not-base58!!", message: ch.message, signature: "00" }))
      .rejects.toThrow("INVALID_ADDRESS");
  });

  it("accepts EVM claims and derives the distribution from net ledger holdings", async () => {
    const { db, lp } = makeLaunchpad();
    const id = db.createLaunch({ ...ROW_DEFAULTS });
    const evm = ethers.Wallet.createRandom();
    const ch = { message: "trenches claim challenge" };

    await lp.registerClaim(2, id, { chain: "evm", address: evm.address, message: ch.message, signature: await evm.signMessage(ch.message) });

    // User 2: buy 5 USDC, sell a quarter → distribution must be NET holdings.
    const b = await lp.buyTokens(2, id, "5000000");
    expect(b.success).toBe(true);
    await lp.sellTokens(2, id, (Number(b.tokenAmount) / 4).toFixed(0));

    // User 3 trades but has NOT registered a wallet → excluded from the snapshot.
    await lp.buyTokens(3, id, "2000000");

    const dist = lp.getLaunchDistribution(id);
    expect(dist).toHaveLength(1);
    expect(dist[0]!.walletAddress.toLowerCase()).toBe(evm.address.toLowerCase());
    const netTokens = BigInt(dist[0]!.tokens);
    expect(netTokens > 0n).toBe(true);
    expect(BigInt(dist[0]!.netUsdc)).toBeLessThan(5000000n); // net of the sell

    const status = lp.getClaimStatus(2, id)!;
    expect(status.tokens).toBe(netTokens.toString());
    expect(status.wallet).toEqual({ chain: "evm", address: evm.address });
  });

  it("rejects claims on unknown launches", async () => {
    const { lp } = makeLaunchpad();
    const signer = makeSolanaSigner();
    await expect(lp.registerClaim(2, 999999, { chain: "solana", address: signer.address, message: "m", signature: signer.sign("m") }))
      .rejects.toThrow("NOT_FOUND");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 🏭 On-chain graduation factory
//   The curve never custodied USDC, so graduation mints the real token to
//   signed-claim wallets — nothing else. These tests pin the plan shape,
//   batching, authority revocation, state transitions and stale-plan
//   refusal, all offline through the SolanaLike port.
// ═══════════════════════════════════════════════════════════════════════

describe("launch graduation factory", () => {
  /** Offline Solana stub: records raw txs, derives ATA existence from them. */
  function makeSolanaStub() {
    const raw: Uint8Array[] = [];
    const createdAccounts = new Set<string>();
    const stub: SolanaLike = {
      getLatestBlockhash: async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 100 }),
      getMinimumBalanceForRentExemption: async (bytes: number) => 1_000_000 + bytes * 100,
      getAccountInfo: async (address: PublicKey) =>
        createdAccounts.has(address.toBase58())
          ? { executable: false, owner: TOKEN_2022_PROGRAM_ID, lamports: 1_000_000, data: new Uint8Array(165) }
          : null,
      sendRawTransaction: async (bytes: Uint8Array) => {
        raw.push(bytes);
        // Every ATA the tx creates counts as existing for subsequent calls.
        const tx = Transaction.from(bytes);
        for (const i of tx.instructions) {
          if (i.programId.equals(SystemProgram.programId)) {
            if (i.keys.length >= 2) createdAccounts.add(i.keys[1]!.pubkey.toBase58());
          } else {
            for (const k of i.keys) createdAccounts.add(k.pubkey.toBase58());
          }
        }
        return bs58.encode(tx.signature!);
      },
      confirmTransaction: async () => ({ value: { err: null } }),
    };
    return { stub, raw };
  }

  function setupFactory() {
    const db = makeDb();
    const lp = new TokenLaunchpad(db as never);
    const { stub, raw } = makeSolanaStub();
    const factory = new LaunchFactory(db as never, { solana: stub });
    return { db, lp, factory, raw, stub };
  }

  /** Seed two buyers with signed Solana claims and one buyer with no claim. */
  async function seedClaimedLaunch(db: ReturnType<typeof makeDb>, lp: TokenLaunchpad) {
    const id = db.createLaunch({ ...ROW_DEFAULTS });
    const s1 = makeSolanaSigner();
    const s2 = makeSolanaSigner();
    const ch = "claim challenge";
    await lp.registerClaim(2, id, { chain: "solana", address: s1.address, message: ch, signature: s1.sign(ch) });
    await lp.registerClaim(3, id, { chain: "solana", address: s2.address, message: ch, signature: s2.sign(ch) });
    await lp.buyTokens(2, id, "3000000");
    await lp.buyTokens(3, id, "1000000");
    await lp.buyTokens(4, id, "5000000"); // no claim → must NOT be minted to
    return { id, s1, s2 };
  }

  it("plans the exact distribution: whole tokens, batches, excludes zero-balance and EVM claims", async () => {
    const { db, lp, factory } = setupFactory();
    const id = db.createLaunch({ ...ROW_DEFAULTS });
    const s1 = makeSolanaSigner();
    const evm = ethers.Wallet.createRandom();
    await lp.registerClaim(2, id, { chain: "solana", address: s1.address, message: "m", signature: s1.sign("m") });
    await lp.registerClaim(3, id, { chain: "evm", address: evm.address, message: "m", signature: await evm.signMessage("m") });
    await lp.buyTokens(2, id, "4000000");
    await lp.buyTokens(3, id, "2000000");

    const plan = factory.plan(id);
    expect(plan.decimals).toBe(0); // whole-token ledger = whole-token mint
    expect(plan.allocations).toHaveLength(1); // EVM claim excluded from SPL mint
    expect(plan.allocations[0]!.wallet).toBe(s1.address);
    expect(plan.allocations[0]!.ata).toBe(getAssociatedTokenAddressSync(new PublicKey(plan.mintAddress), new PublicKey(s1.address), false, TOKEN_2022_PROGRAM_ID).toBase58());
    // Exact whole-token ledger units bought for 4 USDC (no conversion at all).
    expect(plan.allocations[0]!.amountBase).toBe(BigInt(lp.getLaunchPosition(2, id)!.tokens));
    expect(plan.batches).toBe(1);
    expect(plan.excludedAccounts).toBe(1);

    const dry = factory.dryRun(plan);
    expect(dry[0]!.label).toBe("create-mint");
    expect(dry[dry.length - 1]!.label).toBe("revoke-mint-authority");
  });

  it("serializes every holder batch within the Solana packet limit", async () => {
    const { db, lp, factory, raw } = setupFactory();
    const id = db.createLaunch({ ...ROW_DEFAULTS });
    for (let u = 2; u <= 19; u++) {
      const s = makeSolanaSigner();
      await lp.registerClaim(u, id, { chain: "solana", address: s.address, message: "m", signature: s.sign("m") });
      await lp.buyTokens(u, id, "1000000");
    }
    const plan = factory.plan(id);
    expect(plan.allocations).toHaveLength(18);
    expect(plan.batches).toBe(Math.ceil(18 / TRANSFER_BATCH_SIZE));
    await factory.execute(plan, Keypair.generate());
    expect(raw.length).toBe(plan.batches + 2);
    expect(raw.every(bytes => bytes.length <= 1232)).toBe(true);
  });

  it("refuses to plan twice-graduated or empty-distribution launches", () => {
    const { db, factory } = setupFactory();
    const id = db.createLaunch({ ...ROW_DEFAULTS });
    expect(() => factory.plan(id)).toThrow("nothing to mint");
    db.markGraduatedOnChain(id, Keypair.generate().publicKey.toBase58(), "sig");
    expect(() => factory.plan(id)).toThrow("already graduated");
  });

  it("executes: create mint → mintTo per claimant → revoke authority, and persists graduation", async () => {
    const { db, lp, factory, raw } = setupFactory();
    const { id } = await seedClaimedLaunch(db, lp);
    const plan = factory.plan(id);
    const treasury = Keypair.generate();
    const { mint, signatures } = await factory.execute(plan, treasury);

    expect(mint).toBe(plan.mintAddress);
    // 1 create + 1 batch (2 claimants ≤ 8) + 1 revoke
    expect(signatures).toHaveLength(3);
    expect(raw).toHaveLength(3);

    // Tx 1 creates the mint account with the treasury as fee payer.
    const createTx = Transaction.from(raw[0]!);
    expect(createTx.feePayer?.toBase58()).toBe(treasury.publicKey.toBase58());
    const createAccountIx = createTx.instructions.find((i) => i.programId.equals(SystemProgram.programId));
    expect(createAccountIx).toBeDefined();
    // Tx 2 mints to each claimant's derived ATA.
    const mintTx = Transaction.from(raw[1]!);
    const mintTos = mintTx.instructions.filter((i) => i.programId.equals(TOKEN_2022_PROGRAM_ID));
    expect(mintTos.length).toBe(2);
    // Tx 3 revokes mint authority: supply is fixed forever.
    const revokeTx = Transaction.from(raw[2]!);
    expect(revokeTx.instructions.length).toBeGreaterThan(0);

    const launch = db.getLaunch(id)!;
    expect(launch.graduated_on_chain).toBe(1);
    expect(launch.graduation_simulated).toBe(0);
    expect(launch.mint_address).toBe(mint);
    expect(launch.factory_status).toBe("completed");
  });

  it("refuses a stale plan when the distribution changed after planning", async () => {
    const { db, lp, factory } = setupFactory();
    const { id } = await seedClaimedLaunch(db, lp);
    const plan = factory.plan(id);
    // A holder sells after planning → the on-chain plan no longer matches.
    const pos = lp.getLaunchPosition(2, id)!;
    await lp.sellTokens(2, id, (BigInt(pos.tokens) / 4n).toString());
    const treasury = Keypair.generate();
    await expect(factory.execute(plan, treasury)).rejects.toThrow("stale");
    const launch = db.getLaunch(id)!;
    expect(launch.factory_status).toBe("planned"); // never marked executing
  });

  it("refuses to execute after a restart: mint keypair lives only in the planning session", async () => {
    const { db, lp, factory } = setupFactory();
    const { id } = await seedClaimedLaunch(db, lp);
    const plan = factory.plan(id);

    // A second factory instance simulates a process restart: it never saw the
    // plan's mint keypair, so it must refuse instead of improvising a mint.
    const { stub: stub2 } = makeSolanaStub();
    const factoryB = new LaunchFactory(db as never, { solana: stub2 });
    const treasury = Keypair.generate();
    await expect(factoryB.execute(planFromJson(planToJson(plan)), treasury)).rejects.toThrow("stale");

    // A tampered mint address is equally unacceptable.
    const forged = planFromJson(planToJson({ ...plan, mintAddress: Keypair.generate().publicKey.toBase58() }));
    await expect(factory.execute(forged, treasury)).rejects.toThrow("stale");
  });

  it("rejects altered recipient ATAs before sending or changing lifecycle state", async () => {
    const { db, lp, factory, raw } = setupFactory();
    const { id } = await seedClaimedLaunch(db, lp);
    const plan = factory.plan(id);
    plan.allocations[0]!.ata = Keypair.generate().publicKey.toBase58();
    await expect(factory.execute(plan, Keypair.generate())).rejects.toThrow("modified");
    expect(raw).toHaveLength(0); expect(db.getLaunch(id)!.factory_status).toBe("planned");
  });

  it("persists failed confirmation for review and prevents duplicate issuance", async () => {
    const { db, lp, factory, raw, stub } = setupFactory();
    const { id } = await seedClaimedLaunch(db, lp);
    const plan = factory.plan(id);
    stub.confirmTransaction = async () => ({ value: { err: { InstructionError: [0, "Custom"] } } });
    await expect(factory.execute(plan, Keypair.generate())).rejects.toThrow("transaction failed");
    expect(raw).toHaveLength(1);
    const row = db.getLaunch(id)!;
    expect(row.graduated_on_chain).not.toBe(1); expect(row.factory_status).toBe("recovery_required");
    const journal = JSON.parse(row.factory_result!);
    expect(journal.transactions).toHaveLength(1); expect(journal.transactions[0].confirmed).toBe(false);
    expect(Transaction.from(Buffer.from(journal.transactions[0].serialized, "base64")).verifySignatures()).toBe(true);
    const restarted = new LaunchFactory(db as never, { solana: stub });
    expect(() => restarted.plan(id)).toThrow("review");
    await expect(factory.execute(plan, Keypair.generate())).rejects.toThrow("review");
    expect((await lp.buyTokens(2, id, "1000000")).success).toBe(false);
    expect((await lp.sellTokens(2, id, "1")).success).toBe(false);
  });

  it("journals the signature before an ambiguous send failure", async () => {
    const { db, lp, factory, stub } = setupFactory();
    const { id } = await seedClaimedLaunch(db, lp);
    const plan = factory.plan(id);
    stub.sendRawTransaction = async () => {
      const saved = JSON.parse(db.getLaunch(id)!.factory_result!);
      expect(saved.transactions[0].signature).toBeTruthy();
      throw Error("connection lost after broadcast");
    };
    await expect(factory.execute(plan, Keypair.generate())).rejects.toThrow("connection lost");
    expect(db.getLaunch(id)!.factory_status).toBe("recovery_required");
  });

  it("locks concurrent execution and claim changes while a send is in flight", async () => {
    const { db, lp, factory, stub } = setupFactory();
    const { id, s1 } = await seedClaimedLaunch(db, lp);
    const plan = factory.plan(id);
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const rent = stub.getMinimumBalanceForRentExemption;
    stub.getMinimumBalanceForRentExemption = async bytes => { await barrier; return rent(bytes); };
    const running = factory.execute(plan, Keypair.generate());
    try {
      await expect(factory.execute(plan, Keypair.generate())).rejects.toThrow("review");
      await expect(lp.registerClaim(2, id, { chain: "solana", address: s1.address, message: "m", signature: s1.sign("m") })).rejects.toThrow("DISTRIBUTION_LOCKED");
    } finally { release(); await running; }
  });

  it("json round-trip preserves the plan exactly", async () => {
    const { db, lp, factory } = setupFactory();
    const { id } = await seedClaimedLaunch(db, lp);
    const plan = factory.plan(id);
    const back = planFromJson(planToJson(plan));
    expect(back.mintAddress).toBe(plan.mintAddress);
    expect(back.totalSupplyBase).toBe(plan.totalSupplyBase);
    expect(back.decimals).toBe(plan.decimals);
    expect(back.allocations).toHaveLength(plan.allocations.length);
    expect(back.allocations[0]!.amountBase).toBe(plan.allocations[0]!.amountBase);
  });
});
