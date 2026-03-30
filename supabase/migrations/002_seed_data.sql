-- ============================================================================
-- Playform Phase 1 — Seed Data
-- Migration: 002_seed_data.sql
--
-- Run AFTER 001_identity_access_foundation.sql
--
-- Seeds: 7 roles, 11 starter permissions, role-permission assignments,
-- default password policy, default guest config, initial deletion manifest.
-- ============================================================================

-- ── ROLES ───────────────────────────────────────────────────────────────────

INSERT INTO roles (name, display_name, description, is_default, sort_order) VALUES
  ('guest',    'Guest',    'Anonymous player with persistent token. Time-limited play, no translate.', false, 0),
  ('free',     'Free',     'Registered player with email verified. Full access, ad-supported.',        true,  1),
  ('daily',    'Daily',    'Paid — 24-hour access pass.',                                              false, 2),
  ('monthly',  'Monthly',  'Paid — monthly subscription.',                                             false, 3),
  ('annual',   'Annual',   'Paid — annual subscription.',                                              false, 4),
  ('lifetime', 'Lifetime', 'Paid — one-time purchase, permanent access.',                              false, 5),
  ('admin',    'Admin',    'Platform operator. Full access + admin UI.',                                false, 6);

-- ── PERMISSIONS (Starter Catalog) ───────────────────────────────────────────

INSERT INTO permissions (code, display_name, description, category) VALUES
  ('can_play',                'Can Play',                'Access gameplay',                         'gameplay'),
  ('can_translate',           'Can Translate',           'Use translation feature',                 'gameplay'),
  ('can_create_group',        'Can Create Group',        'Form player groups',                      'social'),
  ('can_view_profile',        'Can View Profile',        'View own profile',                        'profile'),
  ('can_edit_profile',        'Can Edit Profile',        'Edit own profile fields',                 'profile'),
  ('can_export_data',         'Can Export Data',         'Download own data (GDPR)',                'privacy'),
  ('can_delete_account',      'Can Delete Account',      'Delete own account (GDPR)',               'privacy'),
  ('can_access_admin',        'Can Access Admin',        'Access admin UI',                         'admin'),
  ('can_manage_roles',        'Can Manage Roles',        'Edit role-permission mappings',           'admin'),
  ('can_manage_entitlements', 'Can Manage Entitlements', 'Create and assign entitlement groups',    'admin'),
  ('can_view_audit',          'Can View Audit',          'View audit trail',                        'admin');

-- ── ROLE-PERMISSION ASSIGNMENTS ─────────────────────────────────────────────
-- Guest: can_play (time-limited), can_view_profile
-- Free: can_play, can_translate, can_create_group, can_view_profile, can_edit_profile, can_export_data, can_delete_account
-- Daily/Monthly/Annual/Lifetime: same as Free (monetization differences come in Phase 6)
-- Admin: everything

-- Helper: insert role_permissions by name
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE
  -- Guest permissions
  (r.name = 'guest' AND p.code IN ('can_play', 'can_view_profile'))
  OR
  -- Free permissions
  (r.name = 'free' AND p.code IN ('can_play', 'can_translate', 'can_create_group', 'can_view_profile', 'can_edit_profile', 'can_export_data', 'can_delete_account'))
  OR
  -- Paid tiers — same as Free for now (monetization differences in Phase 6)
  (r.name = 'daily' AND p.code IN ('can_play', 'can_translate', 'can_create_group', 'can_view_profile', 'can_edit_profile', 'can_export_data', 'can_delete_account'))
  OR
  (r.name = 'monthly' AND p.code IN ('can_play', 'can_translate', 'can_create_group', 'can_view_profile', 'can_edit_profile', 'can_export_data', 'can_delete_account'))
  OR
  (r.name = 'annual' AND p.code IN ('can_play', 'can_translate', 'can_create_group', 'can_view_profile', 'can_edit_profile', 'can_export_data', 'can_delete_account'))
  OR
  (r.name = 'lifetime' AND p.code IN ('can_play', 'can_translate', 'can_create_group', 'can_view_profile', 'can_edit_profile', 'can_export_data', 'can_delete_account'))
  OR
  -- Admin — all permissions
  (r.name = 'admin' AND p.code IS NOT NULL);

-- ── DEFAULT PASSWORD POLICY (Global) ────────────────────────────────────────

INSERT INTO password_policy (role_id, player_id, rotation_days, min_length, require_uppercase, require_lowercase, require_number, require_special, password_history_count)
VALUES (NULL, NULL, 90, 12, true, true, true, true, 5);

-- ── DEFAULT GUEST CONFIG ────────────────────────────────────────────────────

INSERT INTO guest_config (nudge_after_seconds, grace_period_seconds, lockout_after_seconds)
VALUES (3600, 1800, 5400);

-- ── INITIAL DELETION MANIFEST ───────────────────────────────────────────────
-- Phase 1 modules register here. Each subsequent phase adds its entry.

INSERT INTO deletion_manifest (module_name, table_names, description) VALUES
  ('auth', ARRAY['players', 'player_devices', 'consent_records'], 'Core auth and player profile data'),
  ('permissions', ARRAY['role_permissions', 'player_entitlements'], 'Player role and entitlement assignments'),
  ('audit', ARRAY['audit_log'], 'Audit trail entries (anonymized on deletion, not fully removed)');
