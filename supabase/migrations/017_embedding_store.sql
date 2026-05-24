-- Migration 017: Embedding store for RAG pipeline
-- Sprint 5: pgvector-backed vector storage for document chunks
-- ADR-023: RAG Architecture
--
-- Prerequisites: pgvector extension enabled (Sprint 0)
-- Run in Supabase SQL Editor before deploying Sprint 5 to production

-- Embedding storage table
CREATE TABLE IF NOT EXISTS document_embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chunk_id TEXT NOT NULL UNIQUE,
  document_id TEXT NOT NULL,
  content TEXT NOT NULL,
  chunk_index INTEGER NOT NULL DEFAULT 0,
  start_offset INTEGER NOT NULL DEFAULT 0,
  end_offset INTEGER NOT NULL DEFAULT 0,
  embedding vector(1536),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for vector similarity search (cosine distance)
-- Note: ivfflat requires data to be effective; for <1000 rows, sequential scan is faster
CREATE INDEX IF NOT EXISTS idx_embeddings_vector
  ON document_embeddings
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Index for filtering by document
CREATE INDEX IF NOT EXISTS idx_embeddings_document_id
  ON document_embeddings (document_id);

-- Index for metadata filtering (GIN on JSONB)
CREATE INDEX IF NOT EXISTS idx_embeddings_metadata
  ON document_embeddings
  USING gin (metadata);

-- User AI context table (P16: cognitive memory)
CREATE TABLE IF NOT EXISTS user_ai_context (
  user_id TEXT PRIMARY KEY,
  preferences JSONB NOT NULL DEFAULT '{}',
  patterns TEXT[] NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- User interaction history (P16: episodic memory)
CREATE TABLE IF NOT EXISTS user_interactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES user_ai_context(user_id) ON DELETE CASCADE,
  input TEXT NOT NULL,
  output TEXT NOT NULL,
  feature TEXT NOT NULL,
  rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_interactions_user_id
  ON user_interactions (user_id);

CREATE INDEX IF NOT EXISTS idx_interactions_created_at
  ON user_interactions (created_at DESC);

-- RLS policies
ALTER TABLE document_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_ai_context ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_interactions ENABLE ROW LEVEL SECURITY;

-- Service role has full access (admin/system operations)
CREATE POLICY "service_role_embeddings" ON document_embeddings
  FOR ALL TO service_role USING (true);

CREATE POLICY "service_role_user_context" ON user_ai_context
  FOR ALL TO service_role USING (true);

CREATE POLICY "service_role_interactions" ON user_interactions
  FOR ALL TO service_role USING (true);
