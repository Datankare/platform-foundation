/**
 * platform/rag/memory-embedding-store.ts — in-memory embedding store.
 *
 * Reference implementation for tests and development. Isolation is structural: each
 * scope's vectors live in their own partition, and a search reads only its scope's
 * partition — cross-scope leakage is impossible by construction (ADR-042 D3), at any
 * declared isolation level.
 *
 * P7:  Provider-aware — mock/fallback provider.
 * P11: Always available — no network, no failure.
 *
 * @module platform/rag
 */

import type {
  EmbeddingStore,
  Chunk,
  RetrievalResult,
  Scope,
  IsolationLevel,
} from "./types";
import { scopeKey } from "./scope";
import { logger } from "@/lib/logger";

interface StoredEntry {
  readonly chunkId: string;
  readonly embedding: readonly number[];
  readonly chunk: Chunk;
}

/** Cosine similarity, clamped to 0–1. Assumes non-zero-magnitude vectors. */
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

// In memory, per-scope partitioning is structural isolation for every level.
const ALL_LEVELS: readonly IsolationLevel[] = ["shared", "partition", "dedicated"];

export class InMemoryEmbeddingStore implements EmbeddingStore {
  /** scopeKey → that scope's entries. A search never reads another scope's map. */
  private readonly partitions = new Map<string, StoredEntry[]>();

  supportedLevels(): readonly IsolationLevel[] {
    return ALL_LEVELS;
  }

  private partitionFor(scope: Scope): StoredEntry[] {
    const key = scopeKey(scope);
    let entries = this.partitions.get(key);
    if (!entries) {
      entries = [];
      this.partitions.set(key, entries);
    }
    return entries;
  }

  async upsert(
    scope: Scope,
    chunkId: string,
    embedding: readonly number[],
    chunk: Chunk
  ): Promise<void> {
    const entries = this.partitionFor(scope);
    const i = entries.findIndex((e) => e.chunkId === chunkId);
    const entry: StoredEntry = { chunkId, embedding, chunk };
    if (i >= 0) entries[i] = entry;
    else entries.push(entry);
  }

  async search(
    scope: Scope,
    queryEmbedding: readonly number[],
    topK: number,
    minScore: number,
    filters?: Record<string, string | number | boolean>
  ): Promise<readonly RetrievalResult[]> {
    // Structural boundary: only this scope's partition is ever read.
    const entries = this.partitions.get(scopeKey(scope)) ?? [];
    if (entries.length > 0 && queryEmbedding.length !== entries[0].embedding.length) {
      logger.warn("Embedding dimension mismatch", {
        queryDimensions: queryEmbedding.length,
        storedDimensions: entries[0].embedding.length,
      });
      return [];
    }
    let candidates = entries;
    if (filters) {
      candidates = candidates.filter((e) =>
        Object.entries(filters).every(([k, v]) => e.chunk.metadata[k] === v)
      );
    }
    return candidates
      .map((e) => ({
        chunk: e.chunk,
        score: cosineSimilarity(queryEmbedding, e.embedding),
      }))
      .filter((r) => r.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  async deleteByDocument(scope: Scope, documentId: string): Promise<number> {
    const key = scopeKey(scope);
    const entries = this.partitions.get(key);
    if (!entries) return 0;
    const kept = entries.filter((e) => e.chunk.documentId !== documentId);
    this.partitions.set(key, kept);
    return entries.length - kept.length;
  }

  async count(scope?: Scope): Promise<number> {
    if (scope) return (this.partitions.get(scopeKey(scope)) ?? []).length;
    let n = 0;
    for (const p of this.partitions.values()) n += p.length;
    return n;
  }
}
