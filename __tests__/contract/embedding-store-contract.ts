/**
 * __tests__/contract/embedding-store-contract.ts — ADR-042 L21 store no-leak kit.
 *
 * The portable, store-agnostic contract every EmbeddingStore must satisfy: results
 * never cross a scope boundary, an unwritten scope is empty (fail-closed), and count
 * and delete are per-scope. A store — reference or third-party — is trusted only once
 * it passes this. Run it with a factory that makes a fresh store.
 */
import type { EmbeddingStore, Scope, Chunk } from "@/platform/rag/types";

export interface EmbeddingStoreContractSpec {
  readonly name: string;
  readonly makeStore: () => EmbeddingStore;
}

const VEC: readonly number[] = [1, 0, 0, 0];
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

export function runEmbeddingStoreContract(spec: EmbeddingStoreContractSpec): void {
  describe(`embedding store contract — ${spec.name} (ADR-042 L21)`, () => {
    let store: EmbeddingStore;
    beforeEach(() => {
      store = spec.makeStore();
    });

    it("advertises at least one isolation level", () => {
      expect(store.supportedLevels().length).toBeGreaterThan(0);
    });

    it("never returns another scope's vectors (no cross-scope leak)", async () => {
      await store.upsert(A, "a1", VEC, chunk("a1"));
      expect(await store.search(B, VEC, 10, 0)).toEqual([]);
      expect((await store.search(A, VEC, 10, 0)).map((r) => r.chunk.id)).toEqual(["a1"]);
    });

    it("returns empty for a scope never written (fail-closed)", async () => {
      expect(await store.search(A, VEC, 10, 0)).toEqual([]);
      expect(await store.count(A)).toBe(0);
    });

    it("count and delete are confined to their scope", async () => {
      await store.upsert(A, "a1", VEC, chunk("a1", "dA"));
      await store.upsert(B, "b1", VEC, chunk("b1", "dB"));
      expect(await store.count(A)).toBe(1);
      expect(await store.deleteByDocument(B, "dA")).toBe(0);
      expect(await store.count(A)).toBe(1);
      expect(await store.deleteByDocument(A, "dA")).toBe(1);
      expect(await store.count(A)).toBe(0);
    });
  });
}
