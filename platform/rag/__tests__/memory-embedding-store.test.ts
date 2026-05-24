/**
 * platform/rag/__tests__/memory-embedding-store.test.ts
 *
 * Tests for InMemoryEmbeddingStore — cosine similarity search,
 * upsert, delete, filtering.
 */

import { InMemoryEmbeddingStore } from "../memory-embedding-store";

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: jest.fn(() => "test-request-id"),
}));
import type { Chunk } from "../types";

function makeChunk(id: string, docId = "doc-1", content = "test"): Chunk {
  return {
    id,
    documentId: docId,
    content,
    index: 0,
    startOffset: 0,
    endOffset: content.length,
    metadata: { source: "test.txt" },
  };
}

function normalizedVector(dimensions: number, seed: number): readonly number[] {
  const vec = new Array(dimensions).fill(0);
  for (let i = 0; i < dimensions; i++) {
    vec[i] = Math.sin(seed * (i + 1));
  }
  const mag = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0));
  return vec.map((v: number) => v / mag);
}

describe("InMemoryEmbeddingStore", () => {
  let store: InMemoryEmbeddingStore;
  const dims = 8;

  beforeEach(() => {
    store = new InMemoryEmbeddingStore();
  });

  describe("upsert", () => {
    it("stores a new entry", async () => {
      await store.upsert("c1", normalizedVector(dims, 1), makeChunk("c1"));
      expect(await store.count()).toBe(1);
    });

    it("updates existing entry with same chunkId", async () => {
      const vec1 = normalizedVector(dims, 1);
      const vec2 = normalizedVector(dims, 2);
      await store.upsert("c1", vec1, makeChunk("c1"));
      await store.upsert("c1", vec2, makeChunk("c1", "doc-1", "updated"));
      expect(await store.count()).toBe(1);
    });

    it("stores multiple entries", async () => {
      await store.upsert("c1", normalizedVector(dims, 1), makeChunk("c1"));
      await store.upsert("c2", normalizedVector(dims, 2), makeChunk("c2"));
      await store.upsert("c3", normalizedVector(dims, 3), makeChunk("c3"));
      expect(await store.count()).toBe(3);
    });
  });

  describe("search", () => {
    beforeEach(async () => {
      await store.upsert("c1", normalizedVector(dims, 1), makeChunk("c1"));
      await store.upsert("c2", normalizedVector(dims, 2), makeChunk("c2"));
      await store.upsert("c3", normalizedVector(dims, 3), makeChunk("c3"));
    });

    it("returns results ranked by similarity", async () => {
      const query = normalizedVector(dims, 1);
      const results = await store.search(query, 3, 0);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].chunk.id).toBe("c1");
      expect(results[0].score).toBeCloseTo(1.0, 5);
    });

    it("respects topK limit", async () => {
      const query = normalizedVector(dims, 1);
      const results = await store.search(query, 1, 0);
      expect(results).toHaveLength(1);
    });

    it("filters by minScore", async () => {
      const query = normalizedVector(dims, 1);
      const results = await store.search(query, 10, 0.999);
      expect(results).toHaveLength(1);
      expect(results[0].chunk.id).toBe("c1");
    });

    it("returns empty when no results above minScore", async () => {
      const orthogonal = new Array(dims).fill(0);
      orthogonal[0] = 1;
      const results = await store.search(orthogonal, 10, 0.999);
      expect(results).toHaveLength(0);
    });

    it("returns empty for empty store", async () => {
      const emptyStore = new InMemoryEmbeddingStore();
      const results = await emptyStore.search(normalizedVector(dims, 1), 5, 0);
      expect(results).toEqual([]);
    });
  });

  describe("search with filters", () => {
    it("filters by metadata", async () => {
      const chunkA = makeChunk("ca", "doc-a");
      (chunkA.metadata as Record<string, unknown>).category = "news";
      const chunkB = makeChunk("cb", "doc-b");
      (chunkB.metadata as Record<string, unknown>).category = "blog";

      await store.upsert("ca", normalizedVector(dims, 1), chunkA);
      await store.upsert("cb", normalizedVector(dims, 1), chunkB);

      const results = await store.search(normalizedVector(dims, 1), 10, 0, {
        category: "news",
      });
      expect(results).toHaveLength(1);
      expect(results[0].chunk.id).toBe("ca");
    });
  });

  describe("dimension mismatch", () => {
    it("returns empty and warns on dimension mismatch", async () => {
      await store.upsert("c1", normalizedVector(dims, 1), makeChunk("c1"));
      const wrongDims = normalizedVector(16, 1);
      const results = await store.search(wrongDims, 5, 0);
      expect(results).toEqual([]);
    });
  });

  describe("deleteByDocument", () => {
    it("deletes all chunks for a document", async () => {
      await store.upsert("c1", normalizedVector(dims, 1), makeChunk("c1", "doc-1"));
      await store.upsert("c2", normalizedVector(dims, 2), makeChunk("c2", "doc-1"));
      await store.upsert("c3", normalizedVector(dims, 3), makeChunk("c3", "doc-2"));

      const deleted = await store.deleteByDocument("doc-1");
      expect(deleted).toBe(2);
      expect(await store.count()).toBe(1);
    });

    it("returns 0 when document not found", async () => {
      const deleted = await store.deleteByDocument("nonexistent");
      expect(deleted).toBe(0);
    });
  });

  describe("count", () => {
    it("returns 0 for empty store", async () => {
      expect(await store.count()).toBe(0);
    });
  });
});
