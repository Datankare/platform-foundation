-- ============================================================================
-- Phase 4, Sprint 3a — Config Management Enhancement
-- Migration: 011_config_management.sql
--
-- Enhances platform_config with validation metadata (min, max, default,
-- allowed values, permission tier, value type).
-- Creates platform_config_history for full audit trail.
-- Creates config_pending_approvals for two-person approval workflow.
-- Adds new permissions: config_view, config_manage_standard, config_manage_safety.
-- Backfills all existing config rows with proper metadata.
-- ============================================================================

-- ── SCHEMA ENHANCEMENT: platform_config ─────────────────────────────────────

ALTER TABLE platform_config
  ADD COLUMN IF NOT EXISTS default_value JSONB,
  ADD COLUMN IF NOT EXISTS value_type TEXT NOT NULL DEFAULT 'string',
  ADD COLUMN IF NOT EXISTS min_value JSONB,
  ADD COLUMN IF NOT EXISTS max_value JSONB,
  ADD COLUMN IF NOT EXISTS allowed_values JSONB,
  ADD COLUMN IF NOT EXISTS permission_tier TEXT NOT NULL DEFAULT 'standard';

COMMENT ON COLUMN platform_config.default_value IS
  'Intended default value (from seed migration). Separate from current value.';
COMMENT ON COLUMN platform_config.value_type IS
  'Drives UI input widget: string, number, boolean, string_enum, json_array.';
COMMENT ON COLUMN platform_config.min_value IS
  'Minimum allowed value (for numbers). Null for non-numeric types.';
COMMENT ON COLUMN platform_config.max_value IS
  'Maximum allowed value (for numbers). Null for non-numeric types.';
COMMENT ON COLUMN platform_config.allowed_values IS
  'For string_enum: JSON array of allowed values. Null for free-form types.';
COMMENT ON COLUMN platform_config.permission_tier IS
  'standard = admin can change. safety = super_admin or config_manage_safety required.';

-- ── CHANGE HISTORY TABLE ────────────────────────────────────────────────────

CREATE TABLE platform_config_history (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  config_key      TEXT NOT NULL REFERENCES platform_config(key) ON DELETE CASCADE,
  previous_value  JSONB,
  new_value       JSONB NOT NULL,
  changed_by      UUID REFERENCES users(id),
  change_comment  TEXT NOT NULL,
  change_source   TEXT NOT NULL DEFAULT 'admin_ui',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pch_config_key ON platform_config_history (config_key);
CREATE INDEX idx_pch_created_at ON platform_config_history (created_at DESC);
CREATE INDEX idx_pch_changed_by ON platform_config_history (changed_by) WHERE changed_by IS NOT NULL;

ALTER TABLE platform_config_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY pch_service_all ON platform_config_history
  FOR ALL USING (auth.role() = 'service_role');

COMMENT ON TABLE platform_config_history IS
  'Full audit trail for every config change. Who changed what, from what, to what, and why.';

-- ── PENDING APPROVALS TABLE ─────────────────────────────────────────────────

CREATE TYPE config_approval_status AS ENUM (
  'pending',
  'approved',
  'rejected',
  'expired'
);

CREATE TABLE config_pending_approvals (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  config_key      TEXT NOT NULL REFERENCES platform_config(key) ON DELETE CASCADE,
  current_value   JSONB,
  proposed_value  JSONB NOT NULL,
  requested_by    UUID REFERENCES users(id),
  change_comment  TEXT NOT NULL,
  impact_summary  TEXT,
  status          config_approval_status NOT NULL DEFAULT 'pending',
  reviewed_by     UUID REFERENCES users(id),
  review_comment  TEXT,
  reviewed_at     TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_cpa_status ON config_pending_approvals (status);
CREATE INDEX idx_cpa_config_key ON config_pending_approvals (config_key);
CREATE INDEX idx_cpa_requested_by ON config_pending_approvals (requested_by) WHERE requested_by IS NOT NULL;

ALTER TABLE config_pending_approvals ENABLE ROW LEVEL SECURITY;

CREATE POLICY cpa_service_all ON config_pending_approvals
  FOR ALL USING (auth.role() = 'service_role');

COMMENT ON TABLE config_pending_approvals IS
  'Two-person approval for safety-critical config changes. Built in but disabled by default.';

-- ── NEW PERMISSIONS ─────────────────────────────────────────────────────────

INSERT INTO permissions (code, display_name, description, category) VALUES
  ('config_view', 'View Configuration', 'View all platform configuration entries and history', 'admin'),
  ('config_manage_standard', 'Manage Standard Config', 'Edit standard-tier configuration entries', 'admin'),
  ('config_manage_safety', 'Manage Safety Config', 'Edit safety-critical configuration entries (moderation, strikes, COPPA)', 'admin')
ON CONFLICT (code) DO NOTHING;

-- Grant config_view to all admin roles
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name IN ('admin', 'super_admin')
  AND p.code = 'config_view'
ON CONFLICT DO NOTHING;

-- Grant config_manage_standard to admin and super_admin
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name IN ('admin', 'super_admin')
  AND p.code = 'config_manage_standard'
ON CONFLICT DO NOTHING;

-- Grant config_manage_safety to super_admin only
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'super_admin'
  AND p.code = 'config_manage_safety'
ON CONFLICT DO NOTHING;

-- ══════════════════════════════════════════════════════════════════════════
-- BACKFILL: Add metadata to all existing config rows
-- ══════════════════════════════════════════════════════════════════════════

-- ── System config (standard tier) ───────────────────────────────────────

UPDATE platform_config SET
  default_value = value,
  value_type = 'boolean',
  permission_tier = 'safety'
WHERE key = 'maintenance_mode';

UPDATE platform_config SET
  default_value = value,
  value_type = 'boolean',
  permission_tier = 'safety'
WHERE key = 'signups_enabled';

UPDATE platform_config SET
  default_value = value,
  value_type = 'number',
  min_value = '1',
  max_value = '20',
  permission_tier = 'standard'
WHERE key = 'max_devices_per_player';

UPDATE platform_config SET
  default_value = value,
  value_type = 'number',
  min_value = '10',
  max_value = '1000',
  permission_tier = 'standard'
WHERE key = 'rate_limit_rpm';

UPDATE platform_config SET
  default_value = value,
  value_type = 'string',
  allowed_values = '["en","hi","es","fr","de","ja","ko","zh","pt","ar"]',
  permission_tier = 'standard'
WHERE key = 'default_language';

UPDATE platform_config SET
  default_value = value,
  value_type = 'json_array',
  permission_tier = 'standard'
WHERE key = 'supported_languages';

UPDATE platform_config SET
  default_value = value,
  value_type = 'number',
  min_value = '1',
  max_value = '100',
  permission_tier = 'standard'
WHERE key = 'guest_session_limit';

UPDATE platform_config SET
  default_value = value,
  value_type = 'number',
  min_value = '1',
  max_value = '50',
  permission_tier = 'standard'
WHERE key = 'guest_nudge_after';

-- ── Moderation thresholds (safety tier) ─────────────────────────────────

UPDATE platform_config SET
  default_value = value,
  value_type = 'string_enum',
  allowed_values = '["low","medium","high","critical"]',
  permission_tier = 'safety'
WHERE key LIKE 'moderation.level%.block_severity';

UPDATE platform_config SET
  default_value = value,
  value_type = 'string_enum',
  allowed_values = '["low","medium","high","critical"]',
  permission_tier = 'safety'
WHERE key LIKE 'moderation.level%.warn_severity';

UPDATE platform_config SET
  default_value = value,
  value_type = 'number',
  min_value = '0.0',
  max_value = '1.0',
  permission_tier = 'safety'
WHERE key LIKE 'moderation.level%.escalate_below';

-- ── Severity reductions (safety tier) ───────────────────────────────────

UPDATE platform_config SET
  default_value = value,
  value_type = 'number',
  min_value = '0',
  max_value = '3',
  permission_tier = 'safety'
WHERE key LIKE 'moderation.%_severity_reduction';

-- ── Strike thresholds (safety tier) ─────────────────────────────────────

UPDATE platform_config SET
  default_value = value,
  value_type = 'number',
  min_value = '1',
  max_value = '10',
  permission_tier = 'safety'
WHERE key = 'moderation.strike_warn_threshold';

UPDATE platform_config SET
  default_value = value,
  value_type = 'number',
  min_value = '1',
  max_value = '20',
  permission_tier = 'safety'
WHERE key = 'moderation.strike_suspend_threshold';

UPDATE platform_config SET
  default_value = value,
  value_type = 'number',
  min_value = '1',
  max_value = '50',
  permission_tier = 'safety'
WHERE key = 'moderation.strike_ban_threshold';

-- ── Pipeline config (safety tier) ───────────────────────────────────────

UPDATE platform_config SET
  default_value = value,
  value_type = 'string_enum',
  allowed_values = '["low","standard","max"]',
  permission_tier = 'safety'
WHERE key = 'moderation.classifier_effort';

UPDATE platform_config SET
  default_value = value,
  value_type = 'json_array',
  permission_tier = 'safety'
WHERE key = 'moderation.blocklist_only_surfaces';

-- ── Two-person approval meta-config ─────────────────────────────────────

INSERT INTO platform_config (key, value, default_value, description, category, value_type, permission_tier) VALUES
  ('config.require_two_person_approval', 'false', 'false',
   'When true, safety-critical config changes require super_admin approval before taking effect.',
   'system', 'boolean', 'safety')
ON CONFLICT (key) DO NOTHING;

INSERT INTO platform_config (key, value, default_value, description, category, value_type, min_value, max_value, permission_tier) VALUES
  ('config.approval_expiry_days', '7', '7',
   'Pending approval requests expire after this many days.',
   'system', 'number', '1', '30', 'safety')
ON CONFLICT (key) DO NOTHING;
