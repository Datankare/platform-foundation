/**
 * platform/rag/__tests__/mock-embedding-provider.test.ts
 *
 * Tests for the mock embedding provider.
 */

import { createMockEmbeddingProvider } from "../mock-embedding-provider";

describe("createMockEmbeddingProvider", () => {
  const provider = createMockEmbeddingProvider();

  it("has correct metadata", () => {
    expect(provider.name).toBe("mock");
    expect(provider.defaultModel).toBe("mock");
    expect(provider.dimensions).toBe(128);
  });

  it("embeds single text", async () => {
    const response = await provider.embed({ texts: ["hello world"] });
    expect(response.embeddings).toHaveLength(1);
    expect(response.embeddings[0]).toHaveLength(128);
    expect(response.model).toBe("mock");
    expect(response.costUsd).toBe(0);
  });

  it("embeds multiple texts", async () => {
    const response = await provider.embed({
      texts: ["hello", "world", "test"],
    });
    expect(response.embeddings).toHaveLength(3);
  });

  it("produces deterministic vectors", async () => {
    const r1 = await provider.embed({ texts: ["deterministic"] });
    const r2 = await provider.embed({ texts: ["deterministic"] });
    expect(r1.embeddings[0]).toEqual(r2.embeddings[0]);
  });

  it("produces different vectors for different texts", async () => {
    const r1 = await provider.embed({ texts: ["alpha"] });
    const r2 = await provider.embed({ texts: ["beta"] });
    expect(r1.embeddings[0]).not.toEqual(r2.embeddings[0]);
  });

  it("produces normalized vectors", async () => {
    const response = await provider.embed({ texts: ["normalize me"] });
    const vec = response.embeddings[0];
    const magnitude = Math.sqrt(vec.reduce((sum: number, v: number) => sum + v * v, 0));
    expect(magnitude).toBeCloseTo(1.0, 5);
  });

  it("tracks token usage", async () => {
    const response = await provider.embed({ texts: ["hello world"] });
    expect(response.usage.totalTokens).toBeGreaterThan(0);
  });

  it("handles empty string", async () => {
    const response = await provider.embed({ texts: [""] });
    expect(response.embeddings).toHaveLength(1);
  });

  it("uses custom model name", async () => {
    const response = await provider.embed({
      texts: ["test"],
      model: "custom-model",
    });
    expect(response.model).toBe("custom-model");
  });
});
