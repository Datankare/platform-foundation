# ADR-023: RAG Architecture

**Status:** Accepted
**Date:** 2026-05-18
**Sprint:** Phase 4, Sprint 5

## Context

AI interactions in the platform start cold — no user history, no domain knowledge, no personalization. Every request is treated as a first interaction. This limits the quality of AI responses and prevents the platform from learning user preferences.

The ROADMAP identifies four deliverables for Sprint 5:

1. RAG foundation — document chunking, context injection, retrieval pipeline
2. Embedding store — pgvector extension on Supabase
3. User AI context store — per-user interaction history, learning patterns, preferences
4. AI output explainability — explanation chain for every AI decision

## Decision

### Architecture

The RAG pipeline is a composable sequence: **chunk, embed, store, retrieve, inject, explain**.

Each step is a standalone module in `platform/rag/`:

| Module                       | Responsibility                                                  |
| ---------------------------- | --------------------------------------------------------------- |
| types.ts                     | All RAG type definitions                                        |
| embedding-types.ts           | EmbeddingProvider interface (slot #13)                          |
| chunker.ts                   | Document to Chunk[] with sliding-window and sentence strategies |
| memory-embedding-store.ts    | InMemoryEmbeddingStore (cosine similarity)                      |
| retriever.ts                 | Query, embed, search, rank pipeline                             |
| context-injector.ts          | Budget-aware, sanitized context injection                       |
| memory-user-context-store.ts | Per-user episodic/semantic/procedural memory                    |
| explainability.ts            | Step-by-step explanation chain builder                          |
| index.ts                     | Barrel exports + get/set singletons                             |

### Provider model

EmbeddingProvider follows the existing provider pattern (P7):

- Interface in embedding-types.ts
- MockEmbeddingProvider for tests (deterministic hash vectors, 128-dim)
- Registry slot #13 (EMBEDDING_PROVIDER=openai or mock)
- Real OpenAI provider deferred to when API key is available

### Storage model

Two tiers following the existing InMemory/Supabase pattern:

- InMemoryEmbeddingStore — tests and development (default)
- SupabaseEmbeddingStore — production (pgvector, migration 017)
- InMemoryUserContextStore — tests and development (default)
- SupabaseUserContextStore — production (migration 017)

### Safety

- All retrieved content passes through sanitizeForPrompt() before prompt injection (P4)
- Context injection is budget-aware with sanitizationOverhead tracking (P12)
- Retrieval failure returns empty results, never crashes (P11)
- Metadata filters restricted to primitive types to prevent SQL injection (A2)
- Dimension mismatch between query and stored vectors logged and returns empty (S1)

### Explainability

Every AI decision that uses RAG produces an ExplanationChain:

- Which chunks were retrieved and why (scores, filters)
- How the prompt was constructed (context size, budget)
- What the model was asked and how it responded
- Human-reviewable in the human review queue (Sprint 6)

## Consequences

- Every AI call can now be augmented with retrieved context
- User interactions accumulate into personalization over time
- AI decisions are auditable through explanation chains
- pgvector dependency requires Supabase with the vector extension enabled
- Real embedding provider (OpenAI) adds an external API dependency and cost

## GenAI Principles

P1 (intent-driven), P2 (composable), P3 (observable), P4 (safe), P7 (provider-aware), P8 (context/memory), P10 (human oversight), P11 (resilient), P12 (economic), P16 (cognitive memory), P17 (cognition-commitment), P18 (durable trajectories).

---

_Last updated: May 18, 2026 (Sprint 5)_
