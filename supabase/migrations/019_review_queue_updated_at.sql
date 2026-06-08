-- ============================================================================
-- Migration 019: review_queue.updated_at trigger
--
-- Adds DB-side maintenance of review_queue.updated_at, mirroring every other
-- table that has an updated_at column (roles, permissions, players, etc.). Uses
-- the shared update_updated_at_column() function defined in migration 001.
-- Previously updated_at on review_queue was set only by the application layer;
-- this guarantees it on every UPDATE regardless of writer.
--
-- CREATE OR REPLACE TRIGGER is idempotent (Postgres 14+ / Supabase), so this is
-- safe to re-run from the dashboard.
--
-- Sprint 6 (follow-up)
-- ============================================================================

CREATE OR REPLACE TRIGGER set_updated_at BEFORE UPDATE ON review_queue
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
