-- ============================================================================
-- Phase 4, Sprint 3b — Account Consequences + COPPA Enforcement
-- Migration: 012_account_consequences.sql
--
-- Creates the strikes table for per-category strike tracking.
-- Adds account status columns to users table.
-- Adds COPPA enforcement flag for consent gate.
-- Seeds new config entries for strike expiry and COPPA feature blocking.
-- ============================================================================

-- ── CUSTOM TYPES ────────────────────────────────────────────────────────────

CREATE TYPE account_status AS ENUM (
  'active',
  'warned',
  'restricted',
  'suspended',
  'banned'
);

-- ── USERS TABLE: Account status columns ─────────────────────────────────────

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS account_status account_status NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS restricted_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS suspended_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS banned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ban_reason TEXT,
  ADD COLUMN IF NOT EXISTS status_changed_by TEXT,
  ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ;

COMMENT ON COLUMN users.account_status IS
  'Current account status. Drives feature access and content restrictions.';
COMMENT ON COLUMN users.restricted_until IS
  'When restriction expires. NULL = not restricted. Restriction = read-only, no generation/modification.';
COMMENT ON COLUMN users.suspended_until IS
  'When suspension expires. NULL = not suspended. Suspension = no platform access.';
COMMENT ON COLUMN users.banned_at IS
  'When permanent ban was applied. NULL = not banned. Ban requires human review to lift.';
COMMENT ON COLUMN users.ban_reason IS
  'Human-readable reason for ban. Shown in appeal interface.';
COMMENT ON COLUMN users.status_changed_by IS
  'Who changed the status — user ID of admin, or agent ID of Sentinel.';
COMMENT ON COLUMN users.status_changed_at IS
  'When status was last changed.';

CREATE INDEX idx_users_account_status ON users (account_status)
  WHERE account_status != 'active';

-- ── STRIKES TABLE ───────────────────────────────────────────────────────────

CREATE TABLE user_strikes (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category        TEXT NOT NULL,
  severity        TEXT NOT NULL DEFAULT 'medium',
  moderation_audit_id UUID,
  trajectory_id   TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  reason          TEXT NOT NULL,
  expires_at      TIMESTAMPTZ,
  expired         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_strikes_user_id ON user_strikes (user_id);
CREATE INDEX idx_strikes_active ON user_strikes (user_id, expired)
  WHERE expired = FALSE;
CREATE INDEX idx_strikes_category ON user_strikes (user_id, category)
  WHERE expired = FALSE;
CREATE INDEX idx_strikes_created_at ON user_strikes (created_at DESC);

ALTER TABLE user_strikes ENABLE ROW LEVEL SECURITY;

CREATE POLICY strikes_service_all ON user_strikes
  FOR ALL USING (auth.role() = 'service_role');

COMMENT ON TABLE user_strikes IS
  'Per-user, per-category strike tracking. Drives the account consequences ladder. '
  'Each strike links to a moderation audit record and Sentinel trajectory. '
  'Strikes can expire (configurable per severity). Expired strikes are not counted.';

COMMENT ON COLUMN user_strikes.category IS
  'Safety category that triggered this strike (harassment, sexual, violence, etc.).';
COMMENT ON COLUMN user_strikes.severity IS
  'Severity of the violation (low, medium, high, critical).';
COMMENT ON COLUMN user_strikes.moderation_audit_id IS
  'Links to content_safety_audit record for the decision that triggered this strike.';
COMMENT ON COLUMN user_strikes.trajectory_id IS
  'P18: Sentinel trajectory ID for this strike decision.';
COMMENT ON COLUMN user_strikes.agent_id IS
  'P15: Sentinel agent instance that recorded this strike.';
COMMENT ON COLUMN user_strikes.expires_at IS
  'When this strike expires. NULL = never expires (for critical severity).';
COMMENT ON COLUMN user_strikes.expired IS
  'Denormalized expiry flag. Updated by cron or on-read. Avoids time-based queries on every check.';

-- ── COPPA ENFORCEMENT COLUMNS ───────────────────────────────────────────────
-- The consent gate needs a fast way to check enforcement status.
-- parental_consent_status already exists (migration 001). We add a computed
-- enforcement flag to avoid repeated case-statement logic in the gate.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS coppa_enforcement_active BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN users.coppa_enforcement_active IS
  'TRUE when user is under 13 AND parental consent is not granted. '
  'Set by COPPA service on age verification and consent changes. '
  'The consent gate checks this single boolean, not the compound condition.';

-- Backfill: any existing under-13 users without consent should be enforced
UPDATE users
SET coppa_enforcement_active = TRUE
WHERE content_rating_level = 1
  AND age_verified = TRUE
  AND parental_consent_status != 'granted';

CREATE INDEX idx_users_coppa_enforcement ON users (coppa_enforcement_active)
  WHERE coppa_enforcement_active = TRUE;

-- ── NEW CONFIG SEEDS ────────────────────────────────────────────────────────

-- Strike expiry durations (in days) — per severity level
INSERT INTO platform_config (key, value, default_value, description, category, value_type, min_value, max_value, permission_tier) VALUES
  ('moderation.strike_expiry_low_days', '90', '90',
   'Days until a low-severity strike expires. 0 = never expires.',
   'moderation', 'number', '0', '365', 'safety'),
  ('moderation.strike_expiry_medium_days', '180', '180',
   'Days until a medium-severity strike expires. 0 = never expires.',
   'moderation', 'number', '0', '365', 'safety'),
  ('moderation.strike_expiry_high_days', '365', '365',
   'Days until a high-severity strike expires. 0 = never expires.',
   'moderation', 'number', '0', '730', 'safety'),
  ('moderation.strike_expiry_critical_days', '0', '0',
   'Days until a critical-severity strike expires. 0 = never expires.',
   'moderation', 'number', '0', '730', 'safety')
ON CONFLICT (key) DO NOTHING;

-- Consequence durations
INSERT INTO platform_config (key, value, default_value, description, category, value_type, min_value, max_value, permission_tier) VALUES
  ('moderation.restriction_duration_hours', '24', '24',
   'Duration of content restriction (read-only mode) in hours.',
   'moderation', 'number', '1', '168', 'safety'),
  ('moderation.suspension_duration_days', '7', '7',
   'Duration of account suspension in days.',
   'moderation', 'number', '1', '30', 'safety')
ON CONFLICT (key) DO NOTHING;

-- COPPA feature blocking list
INSERT INTO platform_config (key, value, default_value, description, category, value_type, permission_tier) VALUES
  ('coppa.blocked_features', '["translate","transcribe","identify_song","generate","upload_file"]', '["translate","transcribe","identify_song","generate","upload_file"]',
   'Features blocked for under-13 users without parental consent. JSON array of feature identifiers.',
   'coppa', 'json_array', 'safety'),
  ('coppa.enforcement_enabled', 'true', 'true',
   'Master switch for COPPA enforcement. When false, consent gate is bypassed (for development only).',
   'coppa', 'boolean', 'safety')
ON CONFLICT (key) DO NOTHING;
