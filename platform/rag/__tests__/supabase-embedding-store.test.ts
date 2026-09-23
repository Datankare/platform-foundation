/**
 * supabase-embedding-store.test.ts — durable store, app-layer scope enforcement (ADR-042).
 */
import { SupabaseEmbeddingStore } from "../supabase-embedding-store";
import { makeFakeSupabase } from "@/__tests__/helpers/fake-embedding-supabase";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Chunk, Scope } from "../types";

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

function store() {
  return new SupabaseEmbeddingStore(makeFakeSupabase() as unknown as SupabaseClient);
}
function chunk(id: string, documentId = "doc"): Chunk {
  return {
    id,
    documentId,
    content: id,
    index: 0,
    startOffset: 0,
    endOffset: 1,
    metadata: {},
  };
}
const A: Scope = { knowledgeBaseId: "kb", dimensions: { tenant: "a" } };
const B: Scope = { knowledgeBaseId: "kb", dimensions: { tenant: "b" } };

describe("SupabaseEmbeddingStore", () => {
  it("supports the shared level", () => {
    expect(store().supportedLevels()).toEqual(["shared"]);
  });

  it("upserts and ranks by cosine similarity within a scope", async () => {
    const s = store();
    await s.upsert(A, "c1", [1, 0, 0], chunk("c1"));
    await s.upsert(A, "c2", [0, 1, 0], chunk("c2"));
    const results = await s.search(A, [1, 0, 0], 10, 0);
    expect(results[0].chunk.id).toBe("c1");
    expect(results[0].score).toBeCloseTo(1, 5);
  });

  it("never returns another scope's vectors (app-layer no-leak)", async () => {
    const s = store();
    await s.upsert(A, "c1", [1, 0, 0], chunk("c1"));
    expect(await s.search(B, [1, 0, 0], 10, 0)).toEqual([]);
    expect(await s.count(B)).toBe(0);
    expect(await s.count(A)).toBe(1);
  });

  it("deletes by document within scope only", async () => {
    const s = store();
    await s.upsert(A, "c1", [1, 0, 0], chunk("c1", "d1"));
    await s.upsert(B, "c1", [1, 0, 0], chunk("c1", "d1"));
    expect(await s.deleteByDocument(A, "d1")).toBe(1);
    expect(await s.count(A)).toBe(0);
    expect(await s.count(B)).toBe(1);
  });
});
