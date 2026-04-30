-- ============================================================================
-- Phase 4, Sprint 4a — Agent Runtime
-- Migration: 016_agent_runtime.sql
--
-- Creates tables for agent trajectory persistence and budget tracking.
-- All tables are additive — no ALTER on existing tables.
--
-- ADR-022: Agent Runtime
-- P2:  Agentic execution — trajectories record full workflow history
-- P3:  Total observability — every step with cost, latency, timestamps
-- P12: Economic transparency — per-agent per-scope budget enforcement
-- P18: Durable trajectories — inspectable, replayable, checkpointable
-- ============================================================================

-- ── CUSTOM TYPES ────────────────────────────────────────────────────────────

CREATE TYPE trajectory_status AS ENUM (
  'running', 'completed', 'failed', 'paused'
);

CREATE TYPE trajectory_scope AS ENUM (
  'group', 'user', 'platform'
);

-- ── AGENT TRAJECTORIES ──────────────────────────────────────────────────────

CREATE TABLE agent_trajectories (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     TEXT NOT NULL,
  trigger      TEXT NOT NULL,
  scope_type   trajectory_scope NOT NULL DEFAULT 'platform',
  scope_id     UUID,
  status       trajectory_status NOT NULL DEFAULT 'running',
  steps        JSONB NOT NULL DEFAULT '[]',
  total_cost   JSONB NOT NULL DEFAULT '{"tokens": 0, "apiCalls": 0, "usd": 0}',
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

COMMENT ON TABLE agent_trajectories IS
  'Durable agent execution trajectories (P18). Each row is one agent run.';
COMMENT ON COLUMN agent_trajectories.agent_id IS
  'Agent identifier (e.g., guardian, matchmaker, gatekeeper). Not a UUID — agent names are stable strings.';
COMMENT ON COLUMN agent_trajectories.trigger IS
  'What initiated this trajectory (e.g., "group-create", "join-request", "scheduled").';
COMMENT ON COLUMN agent_trajectories.scope_type IS
  'The scope of this trajectory: group-level, user-level, or platform-level.';
COMMENT ON COLUMN agent_trajectories.scope_id IS
  'ID of the scoped entity (group_id or user_id). NULL for platform scope.';
COMMENT ON COLUMN agent_trajectories.steps IS
  'JSONB array of steps. Each step: {stepIndex, action, boundary, input, output, cost, durationMs, timestamp}.';
COMMENT ON COLUMN agent_trajectories.total_cost IS
  'Accumulated cost: {tokens: int, apiCalls: int, usd: decimal}. Updated after each step.';

CREATE INDEX idx_trajectories_agent_id ON agent_trajectories(agent_id);
CREATE INDEX idx_trajectories_scope ON agent_trajectories(scope_type, scope_id);
CREATE INDEX idx_trajectories_status ON agent_trajectories(status);
CREATE INDEX idx_trajectories_started_at ON agent_trajectories(started_at DESC);

-- ── AGENT BUDGETS ───────────────────────────────────────────────────────────

CREATE TABLE agent_budgets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      TEXT NOT NULL,
  scope_type    trajectory_scope NOT NULL DEFAULT 'platform',
  scope_id      UUID,
  period        TEXT NOT NULL,
  budget_tokens INT NOT NULL DEFAULT 0,
  used_tokens   INT NOT NULL DEFAULT 0,
  budget_usd    DECIMAL(10, 4) NOT NULL DEFAULT 0,
  used_usd      DECIMAL(10, 4) NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE agent_budgets IS
  'Per-agent per-scope budget tracking (P12). Period is YYYY-MM format.';
COMMENT ON COLUMN agent_budgets.period IS
  'Budget period in YYYY-MM format (e.g., 2026-04). One row per agent per scope per period.';
COMMENT ON COLUMN agent_budgets.budget_tokens IS
  'Token budget for this period. 0 = unlimited.';
COMMENT ON COLUMN agent_budgets.budget_usd IS
  'USD budget for this period. 0 = unlimited.';

-- One budget row per agent per scope per period
CREATE UNIQUE INDEX idx_budgets_unique
  ON agent_budgets(agent_id, scope_type, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'), period);

CREATE INDEX idx_budgets_agent_period ON agent_budgets(agent_id, period);
CREATE INDEX idx_budgets_scope ON agent_budgets(scope_type, scope_id);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_agent_budgets_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_agent_budgets_updated_at
  BEFORE UPDATE ON agent_budgets
  FOR EACH ROW EXECUTE FUNCTION update_agent_budgets_updated_at();

-- ── RLS POLICIES ────────────────────────────────────────────────────────────

-- Agent tables are server-side only — service role access
ALTER TABLE agent_trajectories ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_budgets ENABLE ROW LEVEL SECURITY;

CREATE POLICY trajectories_service_all ON agent_trajectories
  FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY budgets_service_all ON agent_budgets
  FOR ALL USING (auth.role() = 'service_role');

-- ── SEED CONFIG ENTRIES ─────────────────────────────────────────────────────

INSERT INTO platform_config (key, value, description, updated_by) VALUES
  ('agent.budget.default_tokens_per_month', '100000',
   'Default monthly token budget per agent per scope', 'migration-016'),
  ('agent.budget.default_usd_per_month', '5.00',
   'Default monthly USD budget per agent per scope', 'migration-016'),
  ('agent.trajectory.max_steps', '50',
   'Maximum steps per trajectory before forced completion', 'migration-016'),
  ('agent.trajectory.retention_days', '90',
   'Days to retain completed trajectories before archival', 'migration-016')
ON CONFLICT (key) DO NOTHING;
