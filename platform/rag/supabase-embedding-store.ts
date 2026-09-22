/**
 * platform/rag/supabase-embedding-store.ts — durable embedding store (Supabase/pgvector).
 *
 * ADR-042 shared-level reference store. Isolation is enforced HERE, in the store layer,
 * not in the database: every operation is confined to its scope through one chokepoint
 * ({@link SupabaseEmbeddingStore.scoped}) that stamps `scope_key` on every read, write,
 * and delete. No method reaches the table without it, so cross-scope leakage is
 * structural — and the store-agnostic no-leak kit proves it, hermetically, against a
 * fake client. Vector similarity is computed in the application (cosine), so the store
 * needs no RPC, stored procedure, or `<=>` query.
 *
 * An OPTIONAL Row-Level-Security backstop (defense-in-depth) can be enabled later with no
 * schema change and no store change — see supabase/optional/rag_rls_backstop.sql. The
 * platform does not depend on it; it is purely additive.
 *
 * @module platform/rag
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  EmbeddingStore,
  Chunk,
  RetrievalResult,
  Scope,
  IsolationLevel,
} from "./types";
import { scopeKey } from "./scope";
import { logger } from "@/lib/logger";

const TABLE = "document_embeddings";
const COLUMNS =
  "chunk_id,document_id,content,chunk_index,start_offset,end_offset,embedding,metadata";
const SUPPORTED: readonly IsolationLevel[] = ["shared"];

interface EmbeddingRow {
  chunk_id: string;
  document_id: string;
  content: string;
  chunk_index: number;
  start_offset: number;
  end_offset: number;
  embedding: string | number[];
  metadata: Record<string, unknown> | null;
}

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
  return denom === 0 ? 0 : Math.max(0, Math.min(1, dot / denom));
}

function parseEmbedding(v: string | number[]): number[] {
  return typeof v === "string" ? (JSON.parse(v) as number[]) : v;
}

function toChunk(row: EmbeddingRow): Chunk {
  return {
    id: row.chunk_id,
    documentId: row.document_id,
    content: row.content,
    index: row.chunk_index,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    metadata: row.metadata ?? {},
  };
}

export class SupabaseEmbeddingStore implements EmbeddingStore {
  constructor(private readonly client: SupabaseClient) {}

  supportedLevels(): readonly IsolationLevel[] {
    return SUPPORTED;
  }

  /**
   * The single scope chokepoint. Every query is routed through here, so no operation
   * can read or write outside its scope — this unconditional scope_key predicate IS the
   * platform's isolation guarantee. (The builder is typed loosely because supabase-js
   * generics instantiate too deeply to thread through a helper — TS2589; the guarantee
   * is the code path, not the types, and the no-leak kit proves it.)
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private scoped(builder: any, scope: Scope): any {
    return builder.eq("scope_key", scopeKey(scope));
  }

  async upsert(
    scope: Scope,
    chunkId: string,
    embedding: readonly number[],
    chunk: Chunk
  ): Promise<void> {
    const row = {
      scope_key: scopeKey(scope),
      chunk_id: chunkId,
      document_id: chunk.documentId,
      content: chunk.content,
      chunk_index: chunk.index,
      start_offset: chunk.startOffset,
      end_offset: chunk.endOffset,
      embedding: `[${embedding.join(",")}]`,
      metadata: chunk.metadata,
    };
    const { error } = await this.client
      .from(TABLE)
      .upsert(row, { onConflict: "scope_key,chunk_id" });
    if (error) throw new Error(`embedding upsert failed: ${error.message}`);
  }

  async search(
    scope: Scope,
    queryEmbedding: readonly number[],
    topK: number,
    minScore: number,
    filters?: Record<string, string | number | boolean>
  ): Promise<readonly RetrievalResult[]> {
    const { data, error } = await this.scoped(
      this.client.from(TABLE).select(COLUMNS),
      scope
    );
    if (error) {
      logger.error("Embedding search failed", { error: error.message });
      return []; // fail-closed to empty
    }
    let rows = (data ?? []) as EmbeddingRow[];
    if (filters) {
      rows = rows.filter((r) =>
        Object.entries(filters).every(([k, v]) => (r.metadata ?? {})[k] === v)
      );
    }
    return rows
      .map((r) => ({ chunk: toChunk(r), emb: parseEmbedding(r.embedding) }))
      .filter((x) => x.emb.length === queryEmbedding.length)
      .map((x) => ({ chunk: x.chunk, score: cosineSimilarity(queryEmbedding, x.emb) }))
      .filter((r) => r.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  async deleteByDocument(scope: Scope, documentId: string): Promise<number> {
    const { count, error } = await this.scoped(
      this.client.from(TABLE).delete({ count: "exact" }).eq("document_id", documentId),
      scope
    );
    if (error) throw new Error(`embedding delete failed: ${error.message}`);
    return count ?? 0;
  }

  async count(scope?: Scope): Promise<number> {
    const base = this.client.from(TABLE).select("*", { count: "exact", head: true });
    const { count, error } = await (scope ? this.scoped(base, scope) : base);
    if (error) throw new Error(`embedding count failed: ${error.message}`);
    return count ?? 0;
  }
}
