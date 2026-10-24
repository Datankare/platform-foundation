/**
 * platform/rag/postgres-embedding-store.ts — durable embedding store (Postgres/pgvector).
 *
 * ADR-042 shared-level reference store, on Postgres through platform/data (ADR-053 D4). Two
 * boundaries hold at once:
 *
 *   tenant  row-level security on document_embeddings: a tenant sees only its own rows, and
 *           tenant_id is filled by its column default, never written here.
 *   scope   enforced HERE, in the store: every statement carries `scope_key = $1`, derived
 *           from the scope by scopeKey(), on every read, write, and delete. No method
 *           reaches the table without it, and the store-agnostic no-leak kit proves it.
 *
 * Similarity is pgvector cosine (`<=>`), computed in the database over the scope's rows:
 * score = 1 − cosine distance, clamped to 0–1, and 0 when a vector has no magnitude — the
 * same score the in-memory store gives. The scan is exact (the ivfflat index is approximate
 * and is not used by the scoped, score-filtered query). Rows whose dimension differs from the
 * query's are skipped, not compared.
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
import { DataUnavailableError, withTenantTx } from "@/platform/data";
import { TenantContextError } from "@/platform/tenancy/context";

const SUPPORTED: readonly IsolationLevel[] = ["shared"];

interface EmbeddingRow {
  chunk_id: string;
  document_id: string;
  content: string;
  chunk_index: number;
  start_offset: number;
  end_offset: number;
  metadata: Record<string, unknown> | null;
  score: number;
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

/** pgvector's text form: `[1,2,3]`. */
function vectorLiteral(v: readonly number[]): string {
  return `[${v.join(",")}]`;
}

/** No tenant, or no database: not a statement failure, so never folded into one. */
function isScopeOrAvailability(err: unknown): boolean {
  return err instanceof TenantContextError || err instanceof DataUnavailableError;
}

function failure(what: string, err: unknown): Error {
  if (isScopeOrAvailability(err)) return err as Error;
  return new Error(`embedding ${what} failed: ${(err as Error).message}`, { cause: err });
}

export class PostgresEmbeddingStore implements EmbeddingStore {
  supportedLevels(): readonly IsolationLevel[] {
    return SUPPORTED;
  }

  async upsert(
    scope: Scope,
    chunkId: string,
    embedding: readonly number[],
    chunk: Chunk
  ): Promise<void> {
    try {
      await withTenantTx((tx) =>
        tx.query(
          `insert into document_embeddings
             (scope_key, chunk_id, document_id, content, chunk_index, start_offset, end_offset,
              embedding, metadata)
           values ($1, $2, $3, $4, $5::int, $6::int, $7::int, $8::vector, $9::jsonb)
           on conflict (tenant_id, scope_key, chunk_id) do update
             set document_id = excluded.document_id, content = excluded.content,
                 chunk_index = excluded.chunk_index, start_offset = excluded.start_offset,
                 end_offset = excluded.end_offset, embedding = excluded.embedding,
                 metadata = excluded.metadata, updated_at = now()`,
          [
            scopeKey(scope),
            chunkId,
            chunk.documentId,
            chunk.content,
            chunk.index,
            chunk.startOffset,
            chunk.endOffset,
            vectorLiteral(embedding),
            JSON.stringify(chunk.metadata ?? {}),
          ]
        )
      );
    } catch (err) {
      throw failure("upsert", err);
    }
  }

  async search(
    scope: Scope,
    queryEmbedding: readonly number[],
    topK: number,
    minScore: number,
    filters?: Record<string, string | number | boolean>
  ): Promise<readonly RetrievalResult[]> {
    let rows: EmbeddingRow[];
    try {
      // `metadata @> {k: v}` is per-key equality for the primitive filter values. The
      // dimension check comes first so `<=>` never compares vectors of different sizes.
      ({ rows } = await withTenantTx((tx) =>
        tx.query<EmbeddingRow>(
          `select chunk_id, document_id, content, chunk_index, start_offset, end_offset,
                  metadata, score
             from (
               select chunk_id, document_id, content, chunk_index, start_offset, end_offset,
                      metadata,
                      greatest(0, least(1, coalesce(
                        nullif(1 - (embedding <=> $2::vector), 'NaN'::float8), 0))) as score
                 from document_embeddings
                where scope_key = $1
                  and embedding is not null
                  and vector_dims(embedding) = vector_dims($2::vector)
                  and metadata @> $3::jsonb
             ) scored
            where score >= $4::float8
            order by score desc
            limit $5::int`,
          [
            scopeKey(scope),
            vectorLiteral(queryEmbedding),
            JSON.stringify(filters ?? {}),
            minScore,
            Math.max(0, Math.floor(topK)),
          ]
        )
      ));
    } catch (err) {
      if (err instanceof TenantContextError) throw err;
      logger.error("Embedding search failed", { error: (err as Error).message });
      return []; // fail-closed to empty
    }
    return rows.map((r) => ({ chunk: toChunk(r), score: Number(r.score) }));
  }

  async deleteByDocument(scope: Scope, documentId: string): Promise<number> {
    try {
      const { rowCount } = await withTenantTx((tx) =>
        tx.query(
          "delete from document_embeddings where scope_key = $1 and document_id = $2",
          [scopeKey(scope), documentId]
        )
      );
      return rowCount;
    } catch (err) {
      throw failure("delete", err);
    }
  }

  async count(scope?: Scope): Promise<number> {
    try {
      // No scope: every row this tenant has (diagnostics).
      const { rows } = await withTenantTx((tx) =>
        tx.query<{ n: number }>(
          "select count(*)::int as n from document_embeddings where ($1::text is null or scope_key = $1)",
          [scope ? scopeKey(scope) : null]
        )
      );
      return rows[0]?.n ?? 0;
    } catch (err) {
      throw failure("count", err);
    }
  }
}
