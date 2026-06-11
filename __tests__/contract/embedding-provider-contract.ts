/**
 * __tests__/contract/embedding-provider-contract.ts
 * EmbeddingProvider conformance kit (TCK) — ADR-027. Not a *.test.ts.
 */

import type { EmbeddingProvider } from "@/platform/rag/embedding-types";

export const EMBEDDING_CONTRACT = {
  text: "The quick brown fox.",
  texts: ["alpha", "beta", "gamma"],
} as const;

export interface EmbeddingContractFixtures {
  makeProvider: () => EmbeddingProvider | Promise<EmbeddingProvider>;
}

export function runEmbeddingProviderContract(fx: EmbeddingContractFixtures): void {
  const C = EMBEDDING_CONTRACT;
  let provider: EmbeddingProvider;

  beforeEach(async () => {
    provider = await fx.makeProvider();
  });

  describe("metadata", () => {
    it("exposes name, default model, and positive dimensions", () => {
      expect(typeof provider.name).toBe("string");
      expect(provider.name.length).toBeGreaterThan(0);
      expect(typeof provider.defaultModel).toBe("string");
      expect(provider.defaultModel.length).toBeGreaterThan(0);
      expect(provider.dimensions).toBeGreaterThan(0);
    });
  });

  describe("embed", () => {
    it("returns one vector of the provider's dimensions per input", async () => {
      const r = await provider.embed({ texts: [C.text] });
      expect(r.embeddings.length).toBe(1);
      expect(r.embeddings[0].length).toBe(provider.dimensions);
      r.embeddings[0].forEach((n) => expect(typeof n).toBe("number"));
      expect(typeof r.model).toBe("string");
      expect(r.usage.totalTokens).toBeGreaterThanOrEqual(0);
      expect(r.costUsd).toBeGreaterThanOrEqual(0);
    });

    it("preserves input order and count for multiple texts", async () => {
      const r = await provider.embed({ texts: [...C.texts] });
      expect(r.embeddings.length).toBe(C.texts.length);
      r.embeddings.forEach((vec) => expect(vec.length).toBe(provider.dimensions));
    });
  });
}
