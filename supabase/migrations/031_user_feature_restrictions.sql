-- ============================================================================
-- Sprint 3c — F1: Per-account feature restriction (ADR-034)
--
-- A per-account, per-feature block that is ORTHOGONAL to account status: a
-- specific user barred from a specific feature regardless of standing. Checked in
-- checkAccountStatus before account state is loaded (so it applies for any status)
-- and takes precedence over the status path.
--
-- Durable per-account data (not global config). (user_id, feature) is unique — a
-- composite PK — so applying the same block twice is a no-op. created_by / reason
-- give the audit trail (P3). RLS: service_role only; the app layer enforces the
-- admin scope that may write here (as with the other account-status data).
--
-- Fail-closed at the guard: a read error on this table denies the request under
-- evaluation (ADR-034) — the block status is unknowable and a security control
-- must hold under stress.
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_feature_restrictions (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feature     TEXT NOT NULL,
  reason      TEXT,
  created_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, feature)
);

-- Per-request lookup is by user_id (the guard reads a user's whole block set).
CREATE INDEX IF NOT EXISTS idx_user_feature_restrictions_user
  ON user_feature_restrictions(user_id);

ALTER TABLE user_feature_restrictions ENABLE ROW LEVEL SECURITY;

-- Service role only; app layer enforces admin scope.
CREATE POLICY user_feature_restrictions_service_all ON user_feature_restrictions
  FOR ALL USING (auth.role() = 'service_role');

-- ── Self-record (migration 025 convention) ──────────────────────────────────

insert into applied_migrations (filename, confidence, note)
values (
  '031_user_feature_restrictions.sql',
  'verified',
  'Per-account feature restriction table for Sprint 3c F1 (ADR-034). Self-recorded on application.'
)
on conflict (filename) do update
  set confidence = 'verified',
      recorded_at = now();
