-- Migration 035: knowledge-base scope on the embedding store
-- Sprint 5 (ADR-042): named-dimensions scope.
--
-- Isolation is enforced in the PLATFORM STORE LAYER: every embedding operation is
-- confined to its scope at a single chokepoint (SupabaseEmbeddingStore filters on
-- scope_key on every read, write, and delete; no code path omits it). This migration
-- adds the column that makes that enforcement possible and keeps the table ready for an
-- OPTIONAL Row-Level-Security backstop (defense-in-depth) that an operator may enable
-- later WITHOUT any schema change -- see supabase/optional/rag_rls_backstop.sql.

ALTER TABLE document_embeddings
  ADD COLUMN IF NOT EXISTS scope_key TEXT NOT NULL DEFAULT '';

-- A chunk id is unique per scope, not globally (the same id may exist in another KB).
ALTER TABLE document_embeddings DROP CONSTRAINT IF EXISTS document_embeddings_chunk_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_embeddings_scope_chunk
  ON document_embeddings (scope_key, chunk_id);

-- Scope-scoped scans (the store always filters by scope_key first).
CREATE INDEX IF NOT EXISTS idx_embeddings_scope_key
  ON document_embeddings (scope_key);

insert into applied_migrations (filename, confidence, note)
values (
  '035_embedding_store_scope.sql',
  'verified',
  'ADR-042 named-dimensions scope: scope_key column, per-scope unique index, scope index. Isolation is enforced in the platform store layer; an RLS backstop is optional and additive (supabase/optional/rag_rls_backstop.sql).'
);
