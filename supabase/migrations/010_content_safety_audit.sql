-- ============================================================================
-- Phase 4, Sprint 2 — Content Safety Audit Table + Moderation Config Seeds
-- Migration: 010_content_safety_audit.sql
--
-- ADR-016: Every moderation decision permanently logged with full context,
-- trajectory, reasoning, and classifier output.
--
-- Also seeds moderation configuration into platform_config table.
-- These are the source-of-truth defaults. Code has no hardcoded thresholds.
-- ============================================================================

-- ── CUSTOM TYPES ────────────────────────────────────────────────────────────

CREATE TYPE moderation_action AS ENUM (
  'allow',
  'warn',
  'block',
  'escalate'
);

CREATE TYPE screening_direction AS ENUM (
  'input',
  'output'
);

CREATE TYPE moderation_trigger AS ENUM (
  'blocklist',
  'classifier',
  'content-rating',
  'context',
  'none'
);

CREATE TYPE content_type AS ENUM (
  'translation',
  'generation',
  'transcription',
  'extraction',
  'profile',
  'social',
  'ai-output'
);

-- ── TABLE ───────────────────────────────────────────────────────────────────

CREATE TABLE content_safety_audit (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Privacy: SHA-256 hash of input, not raw content
  input_hash            TEXT NOT NULL,

  -- Pipeline metadata
  direction             screening_direction NOT NULL DEFAULT 'input',
  content_type          content_type NOT NULL DEFAULT 'generation',
  content_rating_level  INTEGER NOT NULL DEFAULT 1
                        CHECK (content_rating_level BETWEEN 1 AND 3),
  user_id               TEXT,

  -- Layer results
  triggered_by          moderation_trigger NOT NULL DEFAULT 'none',
  classifier_output     JSONB,
  categories_flagged    TEXT[] NOT NULL DEFAULT '{}',
  confidence            DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  severity              TEXT NOT NULL DEFAULT 'low',

  -- Decision
  action_taken          moderation_action NOT NULL DEFAULT 'allow',
  reasoning             TEXT NOT NULL DEFAULT '',
  severity_adjustment   INTEGER NOT NULL DEFAULT 0,
  context_factors       TEXT[] NOT NULL DEFAULT '{}',
  attribute_to_user     BOOLEAN NOT NULL DEFAULT TRUE,

  -- Cost tracking (P12)
  classifier_cost_usd   DOUBLE PRECISION NOT NULL DEFAULT 0.0,

  -- Agent traceability (P15, P18)
  trajectory_id         TEXT NOT NULL,
  agent_id              TEXT NOT NULL,

  -- Performance
  pipeline_latency_ms   INTEGER NOT NULL DEFAULT 0,

  -- Trace correlation
  request_id            TEXT NOT NULL,

  -- Timestamps
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── INDEXES ─────────────────────────────────────────────────────────────────

CREATE INDEX idx_csa_action_taken ON content_safety_audit (action_taken);
CREATE INDEX idx_csa_created_at ON content_safety_audit (created_at DESC);
CREATE INDEX idx_csa_input_hash ON content_safety_audit (input_hash);
CREATE INDEX idx_csa_request_id ON content_safety_audit (request_id);
CREATE INDEX idx_csa_rating_action ON content_safety_audit (content_rating_level, action_taken);
CREATE INDEX idx_csa_direction ON content_safety_audit (direction);
CREATE INDEX idx_csa_content_type ON content_safety_audit (content_type);
CREATE INDEX idx_csa_user_id ON content_safety_audit (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_csa_trajectory_id ON content_safety_audit (trajectory_id);
CREATE INDEX idx_csa_agent_id ON content_safety_audit (agent_id);

-- ── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE content_safety_audit ENABLE ROW LEVEL SECURITY;

-- Audit records are system-internal. All access via service role.
-- Admin read access added in Sprint 6 (human review queue).

-- ── COMMENTS ────────────────────────────────────────────────────────────────

COMMENT ON TABLE content_safety_audit IS
  'ADR-016: Immutable audit trail for every Guardian moderation decision. '
  'Raw content never stored — input_hash is SHA-256. '
  'Phase 4 Sprint 2.';

COMMENT ON COLUMN content_safety_audit.reasoning IS
  'Human-readable reasoning chain from the Guardian agent. '
  'Explains why the decision was made — feeds human review queue.';

COMMENT ON COLUMN content_safety_audit.trajectory_id IS
  'P18: Links this decision to the Guardian agent trajectory. '
  'All steps in the decision are inspectable via this ID.';

-- ============================================================================
-- MODERATION CONFIG SEEDS — platform_config table
--
-- These are the intended defaults. Code has NO hardcoded thresholds.
-- If these rows are absent, code falls back to STRICTEST possible values
-- (fail-closed: block everything at low severity).
--
-- Admins change these via the admin config panel or setConfig().
-- ============================================================================

-- ── Level 1: Under 13 (COPPA, strictest) ────────────────────────────────────

INSERT INTO platform_config (key, value, description, category)
VALUES
  ('moderation.level1.block_severity', '"medium"',
   'Minimum severity to BLOCK for Level 1 (under 13). Options: low, medium, high, critical.',
   'moderation'),
  ('moderation.level1.warn_severity', '"low"',
   'Minimum severity to WARN for Level 1 (under 13). Options: low, medium, high, critical.',
   'moderation'),
  ('moderation.level1.escalate_below', '0.7',
   'Classifier confidence threshold — below this, escalate for human review (Level 1). Range: 0.0-1.0.',
   'moderation')
ON CONFLICT (key) DO NOTHING;

-- ── Level 2: 13–17 (teen, moderate) ──────────────────────────────────────────

INSERT INTO platform_config (key, value, description, category)
VALUES
  ('moderation.level2.block_severity', '"high"',
   'Minimum severity to BLOCK for Level 2 (13-17). Options: low, medium, high, critical.',
   'moderation'),
  ('moderation.level2.warn_severity', '"medium"',
   'Minimum severity to WARN for Level 2 (13-17). Options: low, medium, high, critical.',
   'moderation'),
  ('moderation.level2.escalate_below', '0.6',
   'Classifier confidence threshold for escalation (Level 2). Range: 0.0-1.0.',
   'moderation')
ON CONFLICT (key) DO NOTHING;

-- ── Level 3: 18+ (adult, standard) ──────────────────────────────────────────

INSERT INTO platform_config (key, value, description, category)
VALUES
  ('moderation.level3.block_severity', '"critical"',
   'Minimum severity to BLOCK for Level 3 (18+). Options: low, medium, high, critical.',
   'moderation'),
  ('moderation.level3.warn_severity', '"high"',
   'Minimum severity to WARN for Level 3 (18+). Options: low, medium, high, critical.',
   'moderation'),
  ('moderation.level3.escalate_below', '0.5',
   'Classifier confidence threshold for escalation (Level 3). Range: 0.0-1.0.',
   'moderation')
ON CONFLICT (key) DO NOTHING;

-- ── Content type severity reductions ─────────────────────────────────────────

INSERT INTO platform_config (key, value, description, category)
VALUES
  ('moderation.translation_severity_reduction', '1',
   'Severity levels to reduce for translation content (user translating existing text). Range: 0-3.',
   'moderation'),
  ('moderation.transcription_severity_reduction', '1',
   'Severity levels to reduce for transcription content (STT artifacts). Range: 0-3.',
   'moderation'),
  ('moderation.extraction_severity_reduction', '1',
   'Severity levels to reduce for extraction content (user uploaded document). Range: 0-3.',
   'moderation')
ON CONFLICT (key) DO NOTHING;

-- ── Strike thresholds (account consequences) ─────────────────────────────────

INSERT INTO platform_config (key, value, description, category)
VALUES
  ('moderation.strike_warn_threshold', '1',
   'Number of strikes before user receives a warning. Range: 1-10.',
   'moderation'),
  ('moderation.strike_suspend_threshold', '3',
   'Number of strikes before user is suspended (7 days). Range: 1-20.',
   'moderation'),
  ('moderation.strike_ban_threshold', '4',
   'Number of strikes before permanent ban (appeal via human review). Range: 1-50.',
   'moderation')
ON CONFLICT (key) DO NOTHING;

-- ── Pipeline configuration ───────────────────────────────────────────────────

INSERT INTO platform_config (key, value, description, category)
VALUES
  ('moderation.classifier_effort', '"standard"',
   'Default effort tier for the LLM classifier. Options: low, standard, max.',
   'moderation'),
  ('moderation.blocklist_only_surfaces', '[]',
   'Content types that skip the classifier (blocklist only). JSON array of content_type values.',
   'moderation')
ON CONFLICT (key) DO NOTHING;
