import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HeliusOnchainService,
  HeliusRiskService,
  HeliusUnavailableError,
  JITO_TIP_ACCOUNTS,
  classifySwap,
  createsMint,
  hasJitoTip,
  initializedMints,
} from "../src/market/helius.js";

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const MINT = "So11111111111111111111111111111111111111112";
const CREATOR = "CreatorWallet1111111111111111111111111111111";
const TIP = JITO_TIP_ACCOUNTS[0];
const VAULT = "VaultWallet111111111111111111111111111111111";
const BUYER = "BuyerWallet111111111111111111111111111111111";
const OTHER_MINT = "OtherMint11111111111111111111111111111111111";

vi.stubEnv("HELIUS_RPC_URL", "https://mainnet.helius-rpc.com/?api-key=test");

afterEach(() => vi.restoreAllMocks());

/** Real SPL-Token instruction wire format: [opcode][decimals][authority 32B][freezeOpt][freezeAuthority 32B]. */
const b58 = (bytes: number[]) => {
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  // Leading zero bytes encode as "1" prefixes.
  for (const b of bytes) { if (b === 0) out = "1" + out; else break; }
  return out;
};
const initMintData = (opcode = 0) => b58([opcode, 6, ...new Array(32).fill(2), 0, ...new Array(32).fill(0)]);

/** A json-encoded swap tx: buyer receives mint tokens, vault (largest holder) ships them. */
const swapTx = (opts: { tip?: boolean; dir?: "buy" | "sell" } = {}) => {
  const vaultBefore = 1_000_000n;
  const buyerBefore = 10n;
  const delta = 5_000n;
  const vaultAfter = opts.dir === "buy" ? vaultBefore - delta : vaultBefore + delta;
  const buyerAfter = opts.dir === "buy" ? buyerBefore + delta : buyerBefore - delta;
  const tipLamports = opts.tip ? 1_000_000 : 0;
  return {
    transaction: { message: { accountKeys: [CREATOR, VAULT, BUYER, TIP], instructions: [] } },
    meta: {
      err: null,
      preBalances: [10_000_000, 0, 0, 0],
      postBalances: [9_000_000 - tipLamports, 0, 0, tipLamports],
      preTokenBalances: [
        { accountIndex: 1, mint: MINT, uiTokenAmount: { amount: vaultBefore.toString() } },
        { accountIndex: 2, mint: MINT, uiTokenAmount: { amount: buyerBefore.toString() } },
      ],
      postTokenBalances: [
        { accountIndex: 1, mint: MINT, uiTokenAmount: { amount: vaultAfter.toString() } },
        { accountIndex: 2, mint: MINT, uiTokenAmount: { amount: buyerAfter.toString() } },
      ],
      innerInstructions: [],
    },
  };
};

const serviceWith = (results: Record<string, unknown>) => {
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    void body;
    const next = Object.entries(results);
    if (!next.length) throw new Error("unexpected rpc call");
    const [key, value] = next[0]!;
    if (typeof value === "function") return (value as (b: any) => Response)(body);
    return jsonRes({ jsonrpc: "2.0", id: 1, result: value });
  });
  return { fetcher, service: new HeliusOnchainService({ fetcher }) };
};

describe("transaction classification (pure helpers)", () => {
  it("detects a Jito tip by lamport delta on tip accounts, ignoring dust", () => {
    expect(hasJitoTip(swapTx({ tip: true }))).toBe(true);
    expect(hasJitoTip(swapTx())).toBe(false);
    const dust = swapTx({ tip: true });
    dust.meta.postBalances[3] = dust.meta.preBalances[3]! + 50; // 50 lamports: not a tip
    expect(hasJitoTip(dust)).toBe(false);
  });

  it("does not classify transfers as buys or sells from balances alone", () => {
    expect(classifySwap(swapTx({ dir: "buy" }), MINT)).toBeNull();
    expect(classifySwap(swapTx({ dir: "sell" }), MINT)).toBeNull();
  });

  it("minting from zero balance is not a sell", () => {
    const mintTo = {
      transaction: { message: { accountKeys: [CREATOR, VAULT] } },
      meta: {
        err: null,
        preTokenBalances: [],
        postTokenBalances: [{ accountIndex: 1, mint: MINT, uiTokenAmount: { amount: "1000000" } }],
      },
    };
    expect(classifySwap(mintTo, MINT)).toBeNull();
    expect(createsMint(mintTo, MINT)).toBe(false);
  });

  it("initializeMint (SPL + Token-2022, base58 data) is resolved to its mint", () => {
    const b58 = (bytes: number[]) => {
      const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
      let n = 0n;
      for (const b of bytes) n = n * 256n + BigInt(b);
      let out = "";
      while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
      // Leading zero bytes encode as "1" prefixes.
      for (const b of bytes) { if (b === 0) out = "1" + out; else break; }
      return out;
    };
    const tx = (programId: string, opcode = 0) => ({
      transaction: { message: { accountKeys: [MINT], instructions: [{ programId, accounts: [0], data: initMintData(opcode) }] } },
      meta: { err: null, innerInstructions: [] },
    });
    expect(initializedMints(tx("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", 0))).toEqual([MINT]);
    expect(initializedMints(tx("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", 20))).toEqual([MINT]);
    expect(initializedMints(tx("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", 3))).toEqual([]); // InitializeAccount: not a launch
    expect(initializedMints(tx("MintProgramFake1111111111111111111111111111"))).toEqual([]);
  });
});

describe("HeliusOnchainService.risk", () => {
  it("without HELIUS_RPC_URL throws the named unavailable error", async () => {
    vi.stubEnv("HELIUS_RPC_URL", "");
    const { service } = serviceWith({});
    await expect(service.risk("solana", MINT)).rejects.toBeInstanceOf(HeliusUnavailableError);
    await expect(service.risk("solana", MINT)).rejects.toThrow(/HELIUS_RPC_URL/);
    vi.stubEnv("HELIUS_RPC_URL", "https://mainnet.helius-rpc.com/?api-key=test");
  });

  it("rejects non-solana chains and invalid addresses", async () => {
    const { service } = serviceWith({});
    await expect(service.risk("base", MINT)).rejects.toThrow(/solana-only/);
    await expect(service.risk("solana", "short")).rejects.toThrow();
  });

  it("reports tips separately from unknown bundles and verifies initialization payer", async () => {
    const creation = {
      transaction: { message: { accountKeys: [CREATOR, MINT], instructions: [{ programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", accounts: [1], data: initMintData() }] } },
      meta: {
        err: null,
        preTokenBalances: [],
        postTokenBalances: [{ accountIndex: 1, mint: MINT, uiTokenAmount: { amount: "1" } }],
        innerInstructions: [],
      },
    };
    const mintTx = {
      transaction: {
        message: {
          accountKeys: [CREATOR, OTHER_MINT],
          instructions: [{ programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", accounts: [1], data: initMintData(0) }],
        },
      },
      meta: { err: null, innerInstructions: [] },
    };
    const results: Record<string, unknown> = {
      // 3 successful sigs in the sample window
      "getSignaturesForAddress#1": [
        { signature: "s1", err: null, blockTime: 1700 },
        { signature: "s2", err: null, blockTime: 1600 },
        { signature: "s3", err: null, blockTime: 1500 },
      ],
      "getBalance": { value: 2_500_000_000 },
      // creator's recent activity initializes another mint
      "getSignaturesForAddress#2": [{ signature: "c1", err: null, blockTime: 2000 }],
    };
    let sigCalls = 0;
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const method: string = body.method;
      if (method === "getSignaturesForAddress") {
        sigCalls++;
        // First call = token history; later calls = creator history (or pagination)
        return jsonRes({ jsonrpc: "2.0", id: 1, result: sigCalls === 1 ? results["getSignaturesForAddress#1"] : results["getSignaturesForAddress#2"] });
      }
      if (method === "getTransaction") {
        const sig = body.params[0];
        if (sig === "s3") return jsonRes({ jsonrpc: "2.0", id: 1, result: creation }); // oldest = creation
        if (sig === "s1") return jsonRes({ jsonrpc: "2.0", id: 1, result: swapTx({ tip: true, dir: "buy" }) });
        if (sig === "s2") return jsonRes({ jsonrpc: "2.0", id: 1, result: swapTx({ dir: "sell" }) });
        if (sig === "c1") return jsonRes({ jsonrpc: "2.0", id: 1, result: mintTx });
      }
      if (method === "getBalance") return jsonRes({ jsonrpc: "2.0", id: 1, result: results["getBalance"] });
      return jsonRes({ jsonrpc: "2.0", id: 1, result: null });
    });
    const service = new HeliusOnchainService({ fetcher });
    const risk = await service.risk("solana", MINT);
    // s1 = buy with tip; s2 = sell (vault received); s3 = creation (mint from zero).
    expect(risk.bundle.observedBuys).toBeNull();
    expect(risk.bundle.bundleBuys).toBeNull();
    expect(risk.bundle.tippedTransactions).toBe(1);
    expect(risk.bundle.bundlesPct).toBeNull();
    expect(risk.bundle.sampleSize).toBe(3);
    expect(risk.bundle.windowFrom).toBe(1500);
    expect(risk.bundle.windowTo).toBe(1700);
    expect(risk.creator.creator).toBe(CREATOR);
    expect(risk.creator.creatorSol).toBe(2.5);
    expect(risk.creator.tokensLaunched).toBe(1);
    expect(risk.creator.launches[0]?.mint).toBe(OTHER_MINT);
    expect(risk.source).toBe("helius-rpc");
  });

  it("accepts RPC version-1 transactions instead of degrading every sample", async () => {
    const tx = { ...swapTx({ tip: true }), version: 1 };
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.method === "getSignaturesForAddress") return jsonRes({ result: [{ signature: "v1", err: null, blockTime: 100 }] });
      if (body.method === "getTransaction") {
        if (body.params[1].maxSupportedTransactionVersion < 1) return jsonRes({ error: { code: -32015, message: "Transaction version (1) is not supported" } });
        return jsonRes({ result: tx });
      }
      return jsonRes({ result: [] });
    });
    const risk = await new HeliusOnchainService({ fetcher }).risk("solana", MINT);
    expect(risk.bundle.sampleSize).toBe(1);
    expect(risk.bundle.complete).toBe(true);
    expect(risk.bundle.tippedTransactions).toBe(1);
    const reads = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body))).filter(r => r.method === "getTransaction");
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every(r => r.params[1].encoding === "json" && r.params[1].maxSupportedTransactionVersion === 1)).toBe(true);
  });

  it("when the sample never reaches creation, creator stays unknown (no invention)", async () => {
    const plainSwap = swapTx(); // fee payer is a wallet, not evidence of creation
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.method === "getSignaturesForAddress") {
        return jsonRes({ jsonrpc: "2.0", id: 1, result: [{ signature: "old1", err: null, blockTime: 100 }] });
      }
      if (body.method === "getTransaction") return jsonRes({ jsonrpc: "2.0", id: 1, result: plainSwap });
      return jsonRes({ jsonrpc: "2.0", id: 1, result: [] });
    });
    const service = new HeliusOnchainService({ fetcher });
    const risk = await service.risk("solana", MINT);
    expect(risk.creator.creator).toBeNull();
    expect(risk.creator.tokensLaunched).toBeNull();
    expect(risk.creator.note).toMatch(/no alcanzó/);
  });

  it("caches the risk snapshot per token (one probe per 5-min window)", async () => {
    const fetcher = vi.fn(async () => jsonRes({ jsonrpc: "2.0", id: 1, result: [] }));
    const service = new HeliusOnchainService({ fetcher });
    await service.risk("solana", MINT);
    await service.risk("solana", MINT);
    const calls = fetcher.mock.calls.length;
    await service.risk("solana", MINT);
    expect(fetcher.mock.calls.length).toBe(calls);
  });
});

describe("HeliusRiskService pool lookup", () => {
  it("marks dead launches and live liquidity honestly", async () => {
    const service = new HeliusRiskService(
      (mint) => Promise.resolve(mint.startsWith("Alive") ? { liquidityUsd: 1500 } : undefined),
      { fetcher: async () => jsonRes({ jsonrpc: "2.0", id: 1, result: [] }) },
    );
    const launches = await Promise.all([service["launchStatus"]("AliveMint111111111111111111111111111"), service["launchStatus"]("DeadMint11111111111111111111111111111")]);
    expect(launches[0]).toMatchObject({ poolFound: true, liquidityUsd: 1500 });
    expect(launches[1]).toMatchObject({ poolFound: false, liquidityUsd: null });
  });

  it("lookup failure keeps the launch unverified (never false-dead)", async () => {
    const service = new HeliusRiskService(
      async () => { throw new Error("dexscreener down"); },
      { fetcher: async () => jsonRes({ jsonrpc: "2.0", id: 1, result: [] }) },
    );
    const launch = await service["launchStatus"]("SomeMint111111111111111111111111111111");
    expect(launch.poolFound).toBeNull();
    expect(launch.note).toMatch(/no disponible/);
  });
});

describe("Helius evidence boundaries", () => {
  it("resolves compiled v0 program and mint indexes through lookup addresses", () => {
    const tx = {
      transaction: { message: { accountKeys: [CREATOR], instructions: [{ programIdIndex: 2, accounts: [1], data: initMintData() }] } },
      meta: { err: null, loadedAddresses: { writable: [MINT], readonly: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"] } },
    };
    expect(createsMint(tx, MINT)).toBe(true);
    tx.meta.err = "failed" as any;
    expect(initializedMints(tx)).toEqual([]);
  });
  it("does not turn provider failure into a live empty observation", async () => {
    const service = new HeliusOnchainService({ fetcher: async () => jsonRes({}, 429) });
    await expect(service.risk("solana", MINT)).rejects.toThrow(/429/);
  });
  it("marks unavailable sampled transactions as degraded", async () => {
    const service = new HeliusOnchainService({ fetcher: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return jsonRes({ result: body.method === "getSignaturesForAddress" && !body.params[1].before
        ? [{ signature: "missing", err: null, blockTime: 100 }] : body.method === "getTransaction" ? null : [] });
    } });
    const risk = await service.risk("solana", MINT);
    expect(risk.status).toBe("DEGRADED");
    expect(risk.bundle.sampleSize).toBe(0);
    expect(risk.bundle.requestedSampleSize).toBe(1);
    expect(risk.bundle.bundlesPct).toBeNull();
  });
});

describe("Helius artwork",()=>{
 it("uses exact mint metadata and shares a cached response",async()=>{
  const fetcher=vi.fn(async()=>jsonRes({result:{id:MINT,content:{links:{image:"https://example.org/token.png"},files:[{uri:"ipfs://cid/image.png"},{uri:"javascript:bad"}]}}}));
  const service=new HeliusOnchainService({fetcher});
  const art=await service.artwork(MINT);
  expect(art.imageUrls).toEqual(["https://example.org/token.png","ipfs://cid/image.png"]);
  await service.artwork(MINT);expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it("rejects metadata for another mint",async()=>{
  const service=new HeliusOnchainService({fetcher:async()=>jsonRes({result:{id:OTHER_MINT,content:{links:{image:"https://example.org/wrong.png"}}}})});
  await expect(service.artwork(MINT)).rejects.toThrow("mismatch");
 });
});
