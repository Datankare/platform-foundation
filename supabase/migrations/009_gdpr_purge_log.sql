-- Migration: 009_gdpr_purge_log
-- GDPR hard purge audit trail.
-- Records every purge operation for regulatory compliance.
-- User IDs are retained in the audit log (required for compliance proof).
-- Actual user data is deleted; this table proves deletion occurred.

CREATE TABLE IF NOT EXISTS public.purge_log (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  purge_id      TEXT NOT NULL UNIQUE,
  user_id       TEXT NOT NULL,
  requested_by  TEXT NOT NULL,
  reason        TEXT NOT NULL CHECK (reason IN ('user-request', 'admin-action', 'account-deletion', 'legal-order')),
  status        TEXT NOT NULL CHECK (status IN ('pending', 'in-progress', 'completed', 'failed', 'partial')),
  steps_json    JSONB NOT NULL DEFAULT '[]'::jsonb,
  total_deleted INTEGER NOT NULL DEFAULT 0,
  requested_at  TIMESTAMPTZ NOT NULL,
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Index for lookups by user (compliance audits)
CREATE INDEX IF NOT EXISTS idx_purge_log_user_id ON public.purge_log (user_id);

-- Index for status-based queries (monitoring incomplete purges)
CREATE INDEX IF NOT EXISTS idx_purge_log_status ON public.purge_log (status);

-- RLS: server-side access only. purge_log is written and read via the service
-- role (the GDPR routes use the service client); super_admin gating is enforced
-- at the API layer, consistent with the other server-side tables (review_queue,
-- user_strikes, agent_*). NOTE: the original policy referenced a non-existent
-- public.profiles table and would fail to create on any DB; replaced here.
ALTER TABLE public.purge_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS purge_log_service_all ON public.purge_log;
CREATE POLICY purge_log_service_all ON public.purge_log
  FOR ALL USING (auth.role() = 'service_role');
COMMENT ON TABLE public.purge_log IS 'GDPR purge audit trail. Records all data deletion operations for regulatory compliance.';
