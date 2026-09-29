import { afterEach, expect, it, vi } from "vitest";
import { HeliusOnchainService } from "../src/market/helius.js";
import bs58 from "bs58";
const mint = "So11111111111111111111111111111111111111112";
const payer = "11111111111111111111111111111111";
const other = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const tx = (m: string, sig: string) => ({
  transaction: { signatures: [sig], message: { accountKeys: [payer, m], instructions: [{
    programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", accounts: [1],
    data: bs58.encode(new Uint8Array([20,6,...new Array(32).fill(2),0,...new Array(32).fill(0)])),
  }] } }, meta: { err: null }, blockTime: 1234,
});
afterEach(() => vi.unstubAllEnvs());
function service(pages: any[]) {
  vi.stubEnv("HELIUS_RPC_URL", "https://example.test");
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init?.body));
    let result: any;
    if (method === "getBalance") result = { value: 1000000000 };
    else if (method === "getTransactionsForAddress") {
      if (params[0] === mint) result = { data: [tx(mint, "creation")] };
      else result = pages.shift();
    } else throw new Error("Unexpected standard RPC");
    return new Response(JSON.stringify({ result }), { status: 200 });
  });
  return { api: new HeliusOnchainService({ fetcher }), fetcher };
}
it("finds creation oldest-first and follows payer history to cursor exhaustion", async () => {
  const { api, fetcher } = service([{ data: [tx(other, "a")], paginationToken: "next" }, { data: [tx(mint, "creation")] }]);
  const risk = await api.risk("solana", mint);
  expect(risk.creator).toMatchObject({ creator: payer, creationSignature: "creation", createdAt: 1234,
    historyComplete: true, historySource: "helius-archive", sampleSize: 2, tokensLaunched: 1 });
  expect(risk.bundle.bundlesPct).toBeNull();
  expect(fetcher.mock.calls.some(([, init]) => JSON.parse(String(init?.body)).params?.[1]?.sortOrder === "asc")).toBe(true);
});
it("stops after three history pages and keeps coverage partial", async () => {
  const { api } = service([1,2,3].map(n => ({ data: [tx(other, String(n))], paginationToken: String(n) })));
  const risk = await api.risk("solana", mint);
  expect(risk.creator).toMatchObject({ historyComplete: false, sampleSize: 3, tokensLaunched: 1 });
});
it("does not claim complete history when a page contains unavailable transactions", async () => {
  const { api } = service([{ data: [null, tx(other, "a")] }]);
  const risk = await api.risk("solana", mint);
  expect(risk.creator).toMatchObject({ historyComplete: false, sampleSize: 1, requestedSampleSize: 2 });
});
it("breaks repeated cursors without declaring complete history", async () => {
  const { api } = service([{ data: [tx(other, "a")], paginationToken: "same" }, { data: [], paginationToken: "same" }]);
  expect((await api.risk("solana", mint)).creator.historyComplete).toBe(false);
});
