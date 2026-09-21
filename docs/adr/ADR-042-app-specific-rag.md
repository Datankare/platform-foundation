# ADR-042: Application-Specific RAG and Knowledge Bases

Status: Proposed (Phase 5 Sprint 5). Decision maker: Raman Sud.
Related: ADR-023 (Phase-4 RAG pipeline — EmbeddingProvider, chunker, retrieval, budget-aware
context injector, per-user AI context store), ADR-015 (GenAI-native stack), Supabase migration 017
(pgvector), `platform/rag/`.

---

## 1. The end state

A consumer can register one or more **application-specific knowledge bases** — bodies of app-owned
content (rules, lore, docs, catalogs) — and have relevant passages retrieved and injected into a
generation call's context, on the same governed runtime as every other model interaction. The
Phase-4 RAG foundation already provides embeddings, chunking, a retrieval pipeline, a budget-aware
context injector, and a per-user context store; Sprint 5 extends it from _per-user_ memory to
_per-application_ knowledge — the consumer supplies the knowledge-base content, the platform owns
ingestion, retrieval, budgeting, and injection.

## 2. Decisions

_To be authored during Sprint 5, after the pre-code survey of `platform/rag/` (L11/L14)._ Open
questions the survey must settle: knowledge-base registration + isolation model; ingestion/refresh
ownership (consumer-pushed vs platform-pulled); retrieval scoping (per-app, per-user-within-app);
how app knowledge and per-user context compose in the budget-aware injector; the failure mode when
retrieval is unavailable (degrade to no-context generation, not turn failure — P11); and the L21
conformance-kit surface.

## 3. Consequences

_To follow with the decisions._
