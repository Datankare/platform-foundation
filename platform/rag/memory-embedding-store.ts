/**
 * platform/rag/memory-embedding-store.ts — In-memory embedding store
 *
 * Default implementation for tests and development.
 * Uses cosine similarity for vector search.
 *
 * P7:  Provider-aware — mock/fallback provider.
 * P11: Always available — no network, no failure.
 *
 * @module platform/rag
 */

import type { EmbeddingStore, Chunk, RetrievalResult } from "./types";

interface StoredEntry {
  readonly chunkId: string;
  readonly embedding: readonly number[];
  readonly chunk: Chunk;
}

/**
 * Compute cosine similarity between two vectors.
 * Returns 0–1 (clamped). Assumes non-zero magnitude vectors.
 */
function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) return 0;
  return Math.max(0, Math.min(1, dot / denom));
}

export class InMemoryEmbeddingStore implements EmbeddingStore {
  private entries: StoredEntry[] = [];

  async upsert(
    chunkId: string,
    embedding: readonly number[],
    chunk: Chunk
  ): Promise<void> {
    const existingIndex = this.entries.findIndex((e) => e.chunkId === chunkId);
    const entry: StoredEntry = { chunkId, embedding, chunk };
    if (existingIndex >= 0) {
      this.entries[existingIndex] = entry;
    } else {
      this.entries.push(entry);
    }
  }

  async search(
    queryEmbedding: readonly number[],
    topK: number,
    minScore: number,
    filters?: Record<string, unknown>
  ): Promise<readonly RetrievalResult[]> {
    let candidates = this.entries;

    if (filters) {
      candidates = candidates.filter((entry) =>
        Object.entries(filters).every(
          ([key, value]) => entry.chunk.metadata[key] === value
        )
      );
    }

    const scored: RetrievalResult[] = candidates
      .map((entry) => ({
        chunk: entry.chunk,
        score: cosineSimilarity(queryEmbedding, entry.embedding),
      }))
      .filter((r) => r.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return scored;
  }

  async deleteByDocument(documentId: string): Promise<number> {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.chunk.documentId !== documentId);
    return before - this.entries.length;
  }

  async count(): Promise<number> {
    return this.entries.length;
  }
}
