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

-- RLS: Only super_admin can read purge logs
ALTER TABLE public.purge_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Super admins can read purge logs"
  ON public.purge_log
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'super_admin'
    )
  );

-- No INSERT/UPDATE/DELETE policies — writes happen via service role only
COMMENT ON TABLE public.purge_log IS 'GDPR purge audit trail. Records all data deletion operations for regulatory compliance.';
