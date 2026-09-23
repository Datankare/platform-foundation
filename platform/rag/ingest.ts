/**
 * platform/rag/ingest.ts — knowledge-base ingestion (ADR-042 D5 + ADR-043 D3 ingest point).
 *
 * ingestDocument screens a document BEFORE it is chunked and embedded, so a poisoned
 * document never enters the index (ADR-043 D3, OWASP-LLM data-poisoning). It then chunks,
 * embeds, and upserts into the scope-confined store (ADR-042). Content is versioned by a
 * stable fingerprint (ADR-042 D5) stamped into chunk metadata for idempotent re-ingest and
 * provenance. Fail-closed throughout: an unregistered KB or a scope that violates the KB's
 * boundary throws; a screen that blocks, escalates, or errors withholds ingestion.
 *
 * @module platform/rag
 */

import { createHash } from "node:crypto";
import type { EmbeddingProvider } from "./embedding-types";
import type { EmbeddingStore, Document, Chunk, Scope, ChunkingConfig } from "./types";
import { chunkDocument } from "./chunker";
import { getKnowledgeBase } from "./kb-registry";
import { assertScope } from "./scope";
import {
  defaultInputScreen,
  runInputScreen,
  screenPermits,
  type InputScreen,
  type ScreenDecision,
} from "./screen";
import { logger, generateRequestId } from "@/lib/logger";

export type IngestStatus = "ingested" | "rejected";

/** Outcome of an ingestion attempt. */
export interface IngestResult {
  readonly status: IngestStatus;
  readonly documentId: string;
  /** Number of chunks embedded and stored (0 when rejected or empty). */
  readonly chunkCount: number;
  /** Stable content fingerprint (ADR-042 D5). */
  readonly contentVersion: string;
  /** When rejected: the screen action that withheld ingestion (ADR-043 D4). */
  readonly rejectedBy?: ScreenDecision["action"];
  /** When rejected: human-readable reason from the screen. */
  readonly reason?: string;
}

export interface IngestOptions {
  /** Injected screener (ADR-043 D6). Defaults to the Guardian-backed screen. */
  readonly screen?: InputScreen;
  /** Chunking config. Defaults to the module default. */
  readonly chunking?: ChunkingConfig;
  /** Trace-correlation id. Defaults to a generated one. */
  readonly requestId?: string;
}

/** A stable content fingerprint — the content version (ADR-042 D5). */
function contentVersion(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/** Stamp the content version into a chunk's metadata (provenance + idempotent re-ingest). */
function withVersion(chunk: Chunk, version: string): Chunk {
  return { ...chunk, metadata: { ...chunk.metadata, contentVersion: version } };
}

/**
 * Ingest one document into a knowledge base: KB-check → screen → version → chunk → embed
 * → upsert. See the module header for the fail-closed contract.
 */
export async function ingestDocument(
  scope: Scope,
  document: Document,
  provider: EmbeddingProvider,
  store: EmbeddingStore,
  options: IngestOptions = {}
): Promise<IngestResult> {
  const screen = options.screen ?? defaultInputScreen;
  const requestId = options.requestId ?? generateRequestId();
  const version = contentVersion(document.content);

  // Fail-closed: ingestion requires a registered KB and a scope that satisfies its declared
  // boundary (ADR-042 D3). Both throw — a caller cannot ingest into an unknown or
  // under-specified scope.
  const kb = getKnowledgeBase(scope.knowledgeBaseId);
  if (!kb) throw new Error(`unknown knowledge base: ${scope.knowledgeBaseId}`);
  assertScope(kb.boundary, scope);

  // ADR-043 D3 (ingest): screen the raw document BEFORE chunk/embed. A poisoned document
  // never enters the index.
  const decision = await runInputScreen(screen, document.content, requestId);
  if (!screenPermits(decision)) {
    logger.warn("Ingestion withheld by input screen", {
      documentId: document.id,
      knowledgeBaseId: scope.knowledgeBaseId,
      action: decision.action,
      requestId,
    });
    return {
      status: "rejected",
      documentId: document.id,
      chunkCount: 0,
      contentVersion: version,
      rejectedBy: decision.action,
      reason: decision.reasoning,
    };
  }

  const chunks = chunkDocument(document, options.chunking);
  // Embed first (may throw) so a failed embed never deletes the prior version.
  const embedded =
    chunks.length > 0
      ? await provider.embed({ texts: chunks.map((c) => c.content) })
      : null;
  // Replace-on-re-ingest: clear this document's prior chunks, then write the new ones.
  // Chunk ids are fresh per run, so without this a re-ingest would duplicate.
  await store.deleteByDocument(scope, document.id);
  if (embedded) {
    for (let i = 0; i < chunks.length; i++) {
      await store.upsert(
        scope,
        chunks[i].id,
        embedded.embeddings[i],
        withVersion(chunks[i], version)
      );
    }
  }

  return {
    status: "ingested",
    documentId: document.id,
    chunkCount: chunks.length,
    contentVersion: version,
  };
}
