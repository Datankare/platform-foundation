-- ============================================================================
-- Phase 1 — Sprint 7b.1: Platform Config Table
--
-- Generic key-value runtime configuration. Supports:
-- - Feature flags (maintenance_mode, signups_enabled)
-- - Tunable limits (max_devices_per_player, rate_limit_rpm)
-- - UI settings (default_language, supported_languages)
--
-- All changes are audit-logged via the application layer.
-- Only super_admin and admin with admin_manage_config can write.
-- ============================================================================

CREATE TABLE IF NOT EXISTS platform_config (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  description TEXT,
  category    TEXT NOT NULL DEFAULT 'general',
  updated_by  UUID REFERENCES players(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for category-based queries
CREATE INDEX IF NOT EXISTS idx_platform_config_category ON platform_config(category);

-- RLS: only service role can read/write (app layer enforces permissions)
ALTER TABLE platform_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY platform_config_service_all ON platform_config
  FOR ALL USING (auth.role() = 'service_role');

-- ── SEED DEFAULT CONFIG ─────────────────────────────────────────────────────

INSERT INTO platform_config (key, value, description, category) VALUES
  ('maintenance_mode',       'false',                              'When true, all non-admin requests return 503',          'system'),
  ('signups_enabled',        'true',                               'When false, new registrations are blocked',              'system'),
  ('max_devices_per_player', '5',                                  'Maximum devices a player can register',                  'limits'),
  ('rate_limit_rpm',         '60',                                 'Default API rate limit (requests per minute)',            'limits'),
  ('default_language',       '"en"',                               'Default UI language code',                                'i18n'),
  ('supported_languages',    '["en","hi","es","fr","de","ja","ko","zh","pt","ar"]', 'Languages available in the platform', 'i18n'),
  ('guest_session_limit',    '10',                                 'Max sessions before guest lockout',                       'guest'),
  ('guest_nudge_after',      '3',                                  'Sessions before showing registration nudge',              'guest')
ON CONFLICT (key) DO NOTHING;
