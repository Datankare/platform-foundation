/**
 * @jest-environment node
 */
/**
 * PostgresEmbeddingStore against the replayed database: the ADR-042 no-leak kit inside one
 * tenant, the pgvector similarity query (ranking, clamping, zero vectors, dimensions, filters,
 * topK, minScore), upsert and delete, and the store isolated between tenants.
 *
 * document_embeddings.embedding is vector(1536). The kit and the ranking cases use short
 * vectors; the adapter below zero-pads them to 1536, which leaves every dot product and norm —
 * so every cosine score — unchanged.
 */

import { runEmbeddingStoreContract } from "../contract/embedding-store-contract";
import { runTenantIsolationContract } from "../contract/tenant-isolation-contract";
import { embeddingIsolation } from "../helpers/store-isolation-fixtures";
import { PostgresEmbeddingStore } from "@/platform/rag/postgres-embedding-store";
import type { Chunk, EmbeddingStore, Scope } from "@/platform/rag/types";
import { withTenantTx } from "@/platform/data";
import { logger } from "@/lib/logger";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  inTenant,
  type TestTenant,
} from "../helpers/db";

const DIMS = 1536;
const pad = (v: readonly number[]) =>
  v.length >= DIMS ? [...v] : [...v, ...new Array<number>(DIMS - v.length).fill(0)];

/**
 * A fresh tenant per store, made synchronously (the kit's makeStore is not async): every call
 * waits for the tenant, then runs inside it, with vectors padded to the column's size.
 */
function padded(tenant: Promise<TestTenant>): EmbeddingStore {
  const store = new PostgresEmbeddingStore();
  return {
    supportedLevels: () => store.supportedLevels(),
    upsert: async (s, id, e, c) =>
      (await tenant).run(() => store.upsert(s, id, pad(e), c)),
    search: async (s, q, k, m, f) =>
      (await tenant).run(() => store.search(s, pad(q), k, m, f)),
    deleteByDocument: async (s, d) =>
      (await tenant).run(() => store.deleteByDocument(s, d)),
    count: async (s) => (await tenant).run(() => store.count(s)),
  };
}

function chunk(id: string, documentId = "doc", metadata: Chunk["metadata"] = {}): Chunk {
  return {
    id,
    documentId,
    content: `content of ${id}`,
    index: 2,
    startOffset: 10,
    endOffset: 20,
    metadata,
  };
}
const A: Scope = { knowledgeBaseId: "kb", dimensions: { group: "a" } };
const B: Scope = { knowledgeBaseId: "kb", dimensions: { group: "b" } };

dbDescribe("PostgresEmbeddingStore", () => {
  beforeAll(connectTestDatabase);
  afterAll(async () => {
    await dropTestTenants();
    await disconnectTestDatabase();
  });

  runEmbeddingStoreContract({
    name: "PostgresEmbeddingStore",
    makeStore: () => padded(createTestTenant()),
  });

  describe("similarity, upsert and delete", () => {
    let tenant: TestTenant;
    let store: EmbeddingStore;
    beforeEach(async () => {
      tenant = await createTestTenant();
      store = padded(Promise.resolve(tenant));
    });

    it("supports the shared level", () => {
      expect(store.supportedLevels()).toEqual(["shared"]);
    });

    it("ranks by cosine similarity and round-trips the chunk", async () => {
      await store.upsert(A, "c1", [1, 0, 0], chunk("c1", "d1", { lang: "en" }));
      await store.upsert(A, "c2", [0.6, 0.8, 0], chunk("c2"));
      await store.upsert(A, "c3", [0, 1, 0], chunk("c3"));
      const results = await store.search(A, [1, 0, 0], 10, 0);
      expect(results.map((r) => r.chunk.id)).toEqual(["c1", "c2", "c3"]);
      expect(results[0].score).toBeCloseTo(1, 5);
      expect(results[1].score).toBeCloseTo(0.6, 5);
      expect(results[2].score).toBeCloseTo(0, 5);
      expect(results[0].chunk).toEqual(chunk("c1", "d1", { lang: "en" }));
    });

    it("clamps a negative similarity to 0 and scores a zero vector 0", async () => {
      await store.upsert(A, "opposite", [-1, 0, 0], chunk("opposite"));
      await store.upsert(A, "zero", [0, 0, 0], chunk("zero"));
      const results = await store.search(A, [1, 0, 0], 10, 0);
      expect(results.map((r) => r.score)).toEqual([0, 0]);
      expect(await store.search(A, [1, 0, 0], 10, 0.01)).toEqual([]);
    });

    it("honours minScore and topK", async () => {
      await store.upsert(A, "c1", [1, 0, 0], chunk("c1"));
      await store.upsert(A, "c2", [0.6, 0.8, 0], chunk("c2"));
      await store.upsert(A, "c3", [0, 1, 0], chunk("c3"));
      expect((await store.search(A, [1, 0, 0], 10, 0.5)).map((r) => r.chunk.id)).toEqual([
        "c1",
        "c2",
      ]);
      expect((await store.search(A, [1, 0, 0], 1, 0)).map((r) => r.chunk.id)).toEqual([
        "c1",
      ]);
      expect(await store.search(A, [1, 0, 0], 0, 0)).toEqual([]);
    });

    it("filters on metadata values (every filter must match)", async () => {
      await store.upsert(
        A,
        "en",
        [1, 0, 0],
        chunk("en", "d", { lang: "en", level: 2, pub: true })
      );
      await store.upsert(
        A,
        "fr",
        [1, 0, 0],
        chunk("fr", "d", { lang: "fr", level: 2, pub: true })
      );
      const ids = async (f: Record<string, string | number | boolean>) =>
        (await store.search(A, [1, 0, 0], 10, 0, f)).map((r) => r.chunk.id).sort();
      expect(await ids({ lang: "en" })).toEqual(["en"]);
      expect(await ids({ level: 2, pub: true })).toEqual(["en", "fr"]);
      expect(await ids({ lang: "en", level: 3 })).toEqual([]);
      expect(await ids({ missing: "x" })).toEqual([]);
    });

    it("upsert replaces a chunk in its scope and keeps scopes apart", async () => {
      await store.upsert(A, "c1", [1, 0, 0], chunk("c1", "d1"));
      await store.upsert(B, "c1", [1, 0, 0], chunk("c1", "d1"));
      await store.upsert(A, "c1", [0, 1, 0], { ...chunk("c1", "d2"), content: "new" });
      expect(await store.count(A)).toBe(1);
      const [hit] = await store.search(A, [0, 1, 0], 10, 0);
      expect(hit.chunk.content).toBe("new");
      expect(hit.chunk.documentId).toBe("d2");
      expect(hit.score).toBeCloseTo(1, 5);
      expect((await store.search(B, [1, 0, 0], 10, 0))[0].chunk.documentId).toBe("d1");
    });

    it("deletes by document within its scope only; count without a scope is the tenant's total", async () => {
      await store.upsert(A, "c1", [1, 0, 0], chunk("c1", "d1"));
      await store.upsert(A, "c2", [1, 0, 0], chunk("c2", "d1"));
      await store.upsert(B, "c1", [1, 0, 0], chunk("c1", "d1"));
      expect(await store.count()).toBe(3);
      expect(await store.deleteByDocument(A, "d1")).toBe(2);
      expect(await store.deleteByDocument(A, "d1")).toBe(0);
      expect(await store.count(A)).toBe(0);
      expect(await store.count(B)).toBe(1);
    });

    it("skips stored vectors of another dimension instead of failing the search", async () => {
      // The column is vector(1536), so a mismatch can only come from the query side.
      await store.upsert(A, "c1", [1, 0, 0], chunk("c1"));
      const raw = new PostgresEmbeddingStore();
      const spy = jest.spyOn(logger, "error").mockImplementation(() => undefined);
      expect(await tenant.run(() => raw.search(A, [1, 0, 0], 10, 0))).toEqual([]);
      expect(spy).not.toHaveBeenCalled(); // skipped by the dimension check, not a failed query
      spy.mockRestore();
    });

    it("fails a search closed to empty, logging, when the query is refused", async () => {
      const spy = jest.spyOn(logger, "error").mockImplementation(() => undefined);
      const raw = new PostgresEmbeddingStore();
      // An empty vector is refused by pgvector.
      expect(await tenant.run(() => raw.search(A, [], 10, 0))).toEqual([]);
      expect(spy).toHaveBeenCalledWith("Embedding search failed", expect.any(Object));
      spy.mockRestore();
    });

    it("throws a named error when an upsert is refused", async () => {
      const raw = new PostgresEmbeddingStore();
      await expect(
        tenant.run(() => raw.upsert(A, "c1", [1, 0, 0], chunk("c1")))
      ).rejects.toThrow(/^embedding upsert failed: .*1536/);
    });

    it("throws named errors when a delete or count is refused", async () => {
      const raw = new PostgresEmbeddingStore();
      const spy = jest
        .spyOn(
          (await import("@/platform/data")) as { withTenantTx: typeof withTenantTx },
          "withTenantTx"
        )
        .mockRejectedValue(new Error("refused"));
      try {
        await expect(tenant.run(() => raw.deleteByDocument(A, "d"))).rejects.toThrow(
          "embedding delete failed: refused"
        );
        await expect(tenant.run(() => raw.count(A))).rejects.toThrow(
          "embedding count failed: refused"
        );
      } finally {
        spy.mockRestore();
      }
    });
  });

  runTenantIsolationContract({
    name: "document_embeddings",
    makeStore: () => new PostgresEmbeddingStore(),
    createTenant: createTestTenant,
    ...embeddingIsolation(),
  });

  it("keeps tenant isolation even inside the same scope key", async () => {
    const t1 = await createTestTenant();
    const t2 = await createTestTenant();
    const s1 = inTenant(new PostgresEmbeddingStore(), t1);
    const s2 = inTenant(new PostgresEmbeddingStore(), t2);
    await s1.upsert(A, "same", pad([1, 0, 0]), chunk("same"));
    expect(await s2.search(A, pad([1, 0, 0]), 10, 0)).toEqual([]);
    expect(await s2.count()).toBe(0);
    expect(await s2.deleteByDocument(A, "doc")).toBe(0);
    expect(await s1.count(A)).toBe(1);
  });
});
