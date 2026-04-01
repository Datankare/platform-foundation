-- ============================================================================
-- Phase 1 — Sprint 7b.5: super_admin role + permission alignment
--
-- 1. Adds super_admin role (sort_order 7, above admin)
-- 2. Adds missing admin permissions to match route guards
-- 3. Aligns permission codes: routes use admin_* prefix
-- 4. Assigns governance to super_admin only, operational to admin
-- ============================================================================

-- ── ADD SUPER_ADMIN ROLE ────────────────────────────────────────────────────

INSERT INTO roles (name, display_name, description, is_default, sort_order)
VALUES ('super_admin', 'Super Admin', 'Access governance only. Cannot be self-assigned.', false, 7)
ON CONFLICT (name) DO NOTHING;

-- ── ADD MISSING PERMISSIONS (match admin route guard codes) ─────────────────

INSERT INTO permissions (code, display_name, description, category) VALUES
  ('admin_manage_roles',        'Manage Roles',        'Create, edit, delete roles and role-permission mappings', 'admin'),
  ('admin_manage_config',       'Manage Config',       'Edit platform config (guest, password policy)',           'admin'),
  ('admin_view_audit',          'View Audit Log',      'Read audit trail entries',                                'admin'),
  ('admin_manage_players',      'Manage Players',      'Edit player roles, view player data',                     'admin'),
  ('admin_manage_entitlements', 'Manage Entitlements', 'Create, grant, revoke entitlement groups',               'admin')
ON CONFLICT (code) DO NOTHING;

-- ── SUPER_ADMIN: all permissions ────────────────────────────────────────────

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'super_admin'
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );

-- ── ADMIN: operational permissions only (NOT governance) ────────────────────
-- Admin gets: can_access_admin, admin_view_audit, admin_manage_players,
--             admin_manage_entitlements, plus all non-admin permissions.
-- Admin does NOT get: admin_manage_roles, admin_manage_config

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'admin'
  AND p.code IN (
    'can_access_admin',
    'admin_view_audit',
    'admin_manage_players',
    'admin_manage_entitlements',
    'can_play', 'can_translate', 'can_create_group',
    'can_view_profile', 'can_edit_profile',
    'can_export_data', 'can_delete_account'
  )
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );
