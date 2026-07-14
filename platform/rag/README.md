# platform/rag — Retrieval-Augmented Generation

Retrieval, embedding, cognitive memory, and explainability infrastructure (ADR-023).

## Status

✅ **Complete** (Phase 4, Sprint 5) — chunker, retriever, embedding store, context injector,
user AI context store, explainability chain.

## Architecture

All retrieval flows through provider interfaces. The embedding provider is a registry slot
(`EMBEDDING_PROVIDER`), swappable by environment variable — no direct API calls.

```
Document → chunkDocument() → EmbeddingProvider.embed() → EmbeddingStore
                                                              │
Query    → retrieve() ────────────────────────────────────────┘
              │
              └→ buildContextBlock() → budget-aware context → LLM prompt
```

## Public API

| Export                                              | Purpose                                             |
| --------------------------------------------------- | --------------------------------------------------- |
| `chunkDocument()`                                   | Sliding-window + sentence chunking strategies       |
| `retrieve()`                                        | Similarity search over the embedding store          |
| `buildContextBlock()`                               | Budget-aware context injection into prompts         |
| `InMemoryEmbeddingStore`                            | Cosine-similarity store (pgvector in migration 017) |
| `InMemoryUserContextStore`                          | Per-user episodic / semantic / procedural memory    |
| `createExplanationBuilder()`                        | Explainability chain for every AI decision          |
| `getEmbeddingStore()` / `setEmbeddingStore()`       | Store singleton (provider init + testing)           |
| `getEmbeddingProvider()` / `setEmbeddingProvider()` | Provider singleton                                  |
| `getUserContextStore()` / `setUserContextStore()`   | User-context singleton                              |
| `resetRAG()`                                        | Reset all singletons (testing only)                 |

Config defaults: `DEFAULT_CHUNKING_CONFIG`, `DEFAULT_RETRIEVAL_CONFIG`, `DEFAULT_INJECTION_CONFIG`.
Model registry: `EMBEDDING_MODEL_REGISTRY`.

## GenAI principles

- **P8 — Context & Memory:** retrieval, session state, and system memory as distinct layers;
  injection is auditable, cost-aware, and bounded.
- **P16 — Cognitive Memory:** `UserAIContext` holds episodic, semantic, and procedural memory.
- **P7 — Provider-Aware:** the embedding provider is a registry slot, not a hardcoded SDK call.

## Related

ADR-023 (RAG architecture), ADR-017 §5–§6 (user context, explainability), Supabase migration 017.
