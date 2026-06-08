-- ============================================================================
-- 021_reconcile_permission_vocabulary.sql
--
-- Brings the live database's roles/permissions into line with the vocabulary
-- the deployed code actually guards on (adminGuard call sites in both repos).
--
-- This DB predates two PF migrations:
--   * 005 (admin_* permission rename + super_admin role)
--   * the 008 player->user rename (code now guards admin_manage_USERS)
-- so its admin permissions are still in the old can_* form, several
-- code-required permissions are absent, and there is no super_admin role —
-- leaving multiple admin routes guarded on permissions that do not exist
-- (audit, roles, entitlements, users, password/guest config).
--
-- Governance split (per 005): the dangerous governance levers —
-- admin_manage_roles, admin_manage_config, and config_manage_safety — are held
-- by super_admin ONLY. admin keeps the operational permission set.
--
-- Safe to run repeatedly (idempotent). No accounts currently depend on these
-- grants, so this is a clean forward reconciliation rather than a careful
-- in-place rename of live data.
-- ============================================================================

-- ── 1. Rename admin permissions to the admin_* codes the route guards use ───
-- UPDATE preserves the existing role_permissions rows (they reference
-- permission_id, which is stable across a code change). Idempotent: once
-- renamed, the old code no longer matches and the statement is a no-op.

UPDATE permissions
  SET code = 'admin_view_audit',
      display_name = 'View Audit Log',
      description = 'Read audit trail entries',
      category = 'admin'
  WHERE code = 'can_view_audit';

UPDATE permissions
  SET code = 'admin_manage_roles',
      display_name = 'Manage Roles',
      description = 'Create, edit, delete roles and role-permission mappings',
      category = 'admin'
  WHERE code = 'can_manage_roles';

UPDATE permissions
  SET code = 'admin_manage_entitlements',
      display_name = 'Manage Entitlements',
      description = 'Create, grant, revoke entitlement groups',
      category = 'admin'
  WHERE code = 'can_manage_entitlements';

-- ── 2. Add the code-required permissions that are absent here ───────────────
-- admin_manage_config gates password-policy + guest-config routes.
-- admin_manage_users gates the user-management route (post player->user rename).

INSERT INTO permissions (code, display_name, description, category) VALUES
  ('admin_manage_config', 'Manage Config', 'Edit governance config (password policy, guest config)', 'admin'),
  ('admin_manage_users',  'Manage Users',  'Edit user roles and view user data',                       'admin')
ON CONFLICT (code) DO NOTHING;

-- ── 3. Add the super_admin governance role ──────────────────────────────────
-- The deployed code already references super_admin: GDPR purge-log access,
-- config safety-tier approval, and PROTECTED_ROLES (cannot be UI-assigned).
-- sort_order 7 places it above admin (6) and below the tester sentinel (99).

INSERT INTO roles (name, display_name, description, is_default, sort_order)
VALUES ('super_admin', 'Super Admin', 'Governance access. Cannot be self-assigned via the UI.', false, 7)
ON CONFLICT (name) DO NOTHING;

-- ── 4. super_admin holds every permission ───────────────────────────────────

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'super_admin'
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );

-- ── 5. admin gets the operational permissions it is still missing ───────────
-- After the step-1 renames, admin already holds admin_view_audit,
-- admin_manage_entitlements, config_view, config_manage_standard, can_moderate,
-- can_access_admin and the base can_*. The only operational permission admin
-- still lacks is admin_manage_users.

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'admin'
  AND p.code IN ('admin_manage_users')
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );

-- ── 6. Withhold governance permissions from admin (super_admin only) ─────────
-- admin_manage_roles arrived on admin via the step-1 rename (it previously held
-- can_manage_roles). Revoke it: role management is governance and belongs to
-- super_admin only. admin_manage_config and config_manage_safety are never
-- granted to admin in the first place — super_admin holds them via step 4.
-- Idempotent: if the row is already gone, this deletes nothing.

DELETE FROM role_permissions
WHERE role_id = (SELECT id FROM roles WHERE name = 'admin')
  AND permission_id = (SELECT id FROM permissions WHERE code = 'admin_manage_roles');
