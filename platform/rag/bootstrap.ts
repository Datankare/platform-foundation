/**
 * platform/rag/bootstrap.ts — live activation of the reference knowledge base (ADR-042).
 *
 * Called from initProviders() (platform/providers) at server boot, on the same path every
 * other platform reference is registered — the adaptive behavior (ADR-036) and the social
 * content type (ADR-037). Registers the curator reference knowledge base so the RAG
 * framework has a live, registered KB out of the box: the demonstrated shared-level KB the
 * first consumer (Playform, Sprint 7) inherits. Idempotent — safe to call more than once
 * (boot + the per-test-file mirror in jest.setup); it never double-registers.
 *
 * @module platform/rag
 */

import { registerKnowledgeBase, hasKnowledgeBase } from "./kb-registry";
import type { KnowledgeBaseConfig } from "./types";

/**
 * The curator reference knowledge base — the platform's demonstrated shared-level KB
 * (ADR-042). Shared isolation, no boundary dimensions: a single shared corpus the curator
 * content type (ADR-037) can ground digests in, and the worked example adopters copy (see
 * docs/KNOWLEDGE_BASES.md). It is registered empty; content is ingested at runtime through
 * ingestDocument (ADR-043-screened).
 */
export const CURATOR_REFERENCE_KB: KnowledgeBaseConfig = {
  id: "curator-reference",
  name: "Curator Reference Knowledge Base",
  isolationLevel: "shared",
  boundary: [],
};

/** Register the reference knowledge base. Idempotent. */
export function registerRagReference(): void {
  if (!hasKnowledgeBase(CURATOR_REFERENCE_KB.id)) {
    registerKnowledgeBase(CURATOR_REFERENCE_KB);
  }
}
