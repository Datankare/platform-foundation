/**
 * platform/rag/__tests__/retriever.test.ts
 *
 * Tests for the retrieval pipeline.
 */

import { retrieve } from "../retriever";
import { InMemoryEmbeddingStore } from "../memory-embedding-store";
import { createMockEmbeddingProvider } from "../mock-embedding-provider";
import type { Chunk, RetrievalQuery } from "../types";
import type { EmbeddingProvider } from "../embedding-types";

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: jest.fn(() => "test-request-id"),
}));

function makeChunk(id: string, content: string): Chunk {
  return {
    id,
    documentId: "doc-1",
    content,
    index: 0,
    startOffset: 0,
    endOffset: content.length,
    metadata: { source: "test.txt" },
  };
}

describe("retrieve", () => {
  let store: InMemoryEmbeddingStore;
  let provider: EmbeddingProvider;

  beforeEach(async () => {
    store = new InMemoryEmbeddingStore();
    provider = createMockEmbeddingProvider();

    const texts = ["cats are great pets", "dogs love walks", "fish swim in water"];
    for (let i = 0; i < texts.length; i++) {
      const chunk = makeChunk(`c${i}`, texts[i]);
      const response = await provider.embed({ texts: [texts[i]] });
      await store.upsert(chunk.id, response.embeddings[0], chunk);
    }
  });

  it("returns results for a matching query", async () => {
    const query: RetrievalQuery = {
      query: "cats are great pets",
      topK: 3,
      minScore: 0,
    };
    const output = await retrieve(query, provider, store);
    expect(output.results.length).toBeGreaterThan(0);
    expect(output.results[0].chunk.content).toBe("cats are great pets");
    expect(output.results[0].score).toBeCloseTo(1.0, 5);
  });

  it("respects topK", async () => {
    const query: RetrievalQuery = { query: "pets", topK: 1, minScore: 0 };
    const output = await retrieve(query, provider, store);
    expect(output.results).toHaveLength(1);
  });

  it("includes explanation steps", async () => {
    const query: RetrievalQuery = { query: "cats", topK: 3, minScore: 0 };
    const output = await retrieve(query, provider, store);
    expect(output.explanationSteps.length).toBeGreaterThanOrEqual(2);
    expect(output.explanationSteps[0].phase).toBe("query-embedding");
    expect(output.explanationSteps[1].phase).toBe("vector-search");
  });

  it("records durationMs", async () => {
    const query: RetrievalQuery = { query: "test", topK: 3, minScore: 0 };
    const output = await retrieve(query, provider, store);
    expect(output.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns empty results on provider error (P11)", async () => {
    const failingProvider: EmbeddingProvider = {
      name: "failing",
      defaultModel: "fail",
      dimensions: 128,
      embed: jest.fn().mockRejectedValue(new Error("API down")),
    };
    const query: RetrievalQuery = { query: "test", topK: 3, minScore: 0 };
    const output = await retrieve(query, failingProvider, store);
    expect(output.results).toEqual([]);
    expect(output.explanationSteps.some((s) => s.phase === "error")).toBe(true);
  });

  it("returns empty results for empty store", async () => {
    const emptyStore = new InMemoryEmbeddingStore();
    const query: RetrievalQuery = { query: "anything", topK: 5, minScore: 0.5 };
    const output = await retrieve(query, provider, emptyStore);
    expect(output.results).toEqual([]);
  });

  it("passes filters to store", async () => {
    const query: RetrievalQuery = {
      query: "test",
      topK: 5,
      minScore: 0,
      filters: { source: "other.txt" },
    };
    const output = await retrieve(query, provider, store);
    expect(output.results).toEqual([]);
  });
});
