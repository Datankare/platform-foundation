-- ============================================================================
-- Phase 4, Sprint 3d — Profile Screening + Account Status Guard Config
-- Migration: 014_profile_screening_config.sql
--
-- Seeds platform_config with:
--   - Profile field screening settings (which fields, length limits)
--   - Account status feature restrictions (per status level)
--
-- Source: Sprint 3d plan, ADR-016 (content safety at every surface),
-- coppa-gate.ts Gotcha #4 (account status check missing).
-- ============================================================================

-- ── Profile screening config ────────────────────────────────────────────────

INSERT INTO platform_config
  (key, value, default_value, description, category, value_type, permission_tier)
VALUES
  (
    'profile.screened_fields',
    '["displayName","realName"]',
    '["displayName","realName"]',
    'Profile fields that require Guardian screening before write. Field names must match ProfileUpdate keys.',
    'safety', 'json_array', 'safety'
  )
ON CONFLICT (key) DO NOTHING;

INSERT INTO platform_config
  (key, value, default_value, description, category, value_type, min_value, max_value, permission_tier)
VALUES
  (
    'profile.max_display_name_length',
    '50', '50',
    'Maximum length for display names. Enforced before Guardian screening.',
    'safety', 'number', '1', '200', 'standard'
  ),
  (
    'profile.max_real_name_length',
    '100', '100',
    'Maximum length for real names. Enforced before Guardian screening.',
    'safety', 'number', '1', '300', 'standard'
  )
ON CONFLICT (key) DO NOTHING;

-- ── Account status feature restrictions ─────────────────────────────────────

INSERT INTO platform_config
  (key, value, default_value, description, category, value_type, permission_tier)
VALUES
  (
    'account_status.restricted_features',
    '["translate","transcribe","identify_song","generate","upload_file","update_profile"]',
    '["translate","transcribe","identify_song","generate","upload_file","update_profile"]',
    'Features blocked for users with account_status = restricted. Feature names must match API route identifiers.',
    'safety', 'json_array', 'safety'
  ),
  (
    'account_status.suspended_features',
    '["*"]',
    '["*"]',
    'Features blocked for users with account_status = suspended. ["*"] means all features.',
    'safety', 'json_array', 'safety'
  )
ON CONFLICT (key) DO NOTHING;
