import { describe, it, expect, vi } from "vitest";
import { CloudProvider } from "../src/ai/cloud.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("CloudProvider", () => {
  const provider = new CloudProvider(
    "test-model",
    "test-embed",
    "https://api.example.com/v1/",
    "sk-test",
    vi.fn()
  );

  it("builds the provider name from the model", () => {
    expect(provider.name).toBe("cloud:test-model");
  });

  it("is available when a key is present", async () => {
    await expect(provider.available()).resolves.toBe(true);
  });

  it("completes via /chat/completions with Bearer auth", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: "  hello world  " } }] })
    );
    const p = new CloudProvider("m", "e", "https://api.example.com/v1", "sk-test", fetchImpl);
    const out = await p.complete([{ role: "user", content: "hi" }], { temperature: 0.2, maxTokens: 10 });
    expect(out).toBe("hello world");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk-test");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("m");
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(10);
  });

  it("returns '' on HTTP error instead of throwing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: "boom" }, 500));
    const p = new CloudProvider("m", "e", "https://api.example.com/v1", "sk-test", fetchImpl);
    await expect(p.complete([{ role: "user", content: "hi" }])).resolves.toBe("");
  });

  it("embeds via /embeddings and returns the vector", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ data: [{ embedding: [0.1, 0.2, 0.3] }] })
    );
    const p = new CloudProvider("m", "e", "https://api.example.com/v1", "sk-test", fetchImpl);
    await expect(p.embed("hello")).resolves.toEqual([0.1, 0.2, 0.3]);
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://api.example.com/v1/embeddings");
  });

  it("returns [] on embed failure", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    const p = new CloudProvider("m", "e", "https://api.example.com/v1", "sk-test", fetchImpl);
    await expect(p.embed("hello")).resolves.toEqual([]);
  });
});
