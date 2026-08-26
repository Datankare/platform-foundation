-- ============================================================================
-- Sprint 3c — A3: Agent approval policy (admin-governed, versioned)
--
-- Who may approve a held agentic action, per action class. Append-only and
-- VERSIONED: each policy change INSERTs a new row (never UPDATE/DELETE), so the
-- table is its own audit trail — decided_by + created_at reconstruct every change
-- (P3/P18). The latest row (max version) is the current policy.
--
-- Atomicity: version is UNIQUE, so two concurrent writers cannot both claim the
-- same version — the loser gets a 409 and retries against the new max. This makes
-- a policy change atomic in the database, not a read-then-write in the app.
--
-- Behavior-preserving: with no rows, the app resolves the built-in default
-- (human approves everything, P10). No seed row is required.
--
-- Only super_admin / admin with admin_manage_approval_policy write (app layer, A4).
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_approval_policy (
  id               UUID PRIMARY KEY,
  version          INTEGER NOT NULL UNIQUE,
  default_approver TEXT NOT NULL DEFAULT 'user',
  rules            JSONB NOT NULL DEFAULT '[]'::jsonb,
  decided_by       TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Latest-policy lookup is order by version desc limit 1.
CREATE INDEX IF NOT EXISTS idx_agent_approval_policy_version
  ON agent_approval_policy(version DESC);

-- RLS: only the service role touches it; the app layer enforces the admin scope.
ALTER TABLE agent_approval_policy ENABLE ROW LEVEL SECURITY;

CREATE POLICY agent_approval_policy_service_all ON agent_approval_policy
  FOR ALL USING (auth.role() = 'service_role');

-- Append-only: no UPDATE or DELETE policy is defined, so RLS denies both even to
-- the service role's data-plane callers. Version history is immutable by design.

-- ── Self-record (migration 025 convention) ──────────────────────────────────

insert into applied_migrations (filename, confidence, note)
values (
  '030_approval_policy.sql',
  'verified',
  'Agent approval policy table for Sprint 3c A3 (ADR-030/ADR-033). Self-recorded on application.'
)
on conflict (filename) do update
  set confidence = 'verified',
      recorded_at = now();
