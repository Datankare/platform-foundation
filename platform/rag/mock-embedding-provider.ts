/**
 * platform/rag/mock-embedding-provider.ts — Deterministic mock embeddings
 *
 * Produces repeatable vectors from text content using a simple hash.
 * Useful for tests and development without an API key.
 *
 * P7: Provider-aware — mock fallback.
 * P11: Always available — no network, no failure.
 *
 * @module platform/rag
 */

import type {
  EmbeddingProvider,
  EmbeddingRequest,
  EmbeddingResponse,
} from "./embedding-types";

const MOCK_DIMENSIONS = 128;

/**
 * Generate a deterministic vector from text.
 * Uses a simple hash to spread values across dimensions.
 * Same text always produces the same vector.
 */
function hashToVector(text: string, dimensions: number): readonly number[] {
  const vec: number[] = new Array(dimensions).fill(0);
  for (let i = 0; i < text.length; i++) {
    const charCode = text.charCodeAt(i);
    const dimIndex = i % dimensions;
    vec[dimIndex] += charCode;
  }
  const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  if (magnitude === 0) return vec;
  return vec.map((v) => v / magnitude);
}

/**
 * Create a mock embedding provider.
 * Produces deterministic 128-dimension vectors from text hashing.
 */
export function createMockEmbeddingProvider(): EmbeddingProvider {
  return {
    name: "mock",
    defaultModel: "mock",
    dimensions: MOCK_DIMENSIONS,

    async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
      const model = request.model ?? "mock";
      const texts = request.texts;
      const embeddings = texts.map((t) => hashToVector(t, MOCK_DIMENSIONS));
      const totalTokens = texts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0);
      return {
        embeddings,
        model,
        usage: { totalTokens },
        costUsd: 0,
      };
    },
  };
}
