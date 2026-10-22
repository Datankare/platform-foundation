-- 041_admin_page_permissions.sql — create the admin permissions the code requires (Sprint 7X)
--
-- The agent-registry, per-account restriction and approval-policy admin routes, and their AI
-- command-bar actions, require admin_manage_agents, admin_manage_account_restrictions and
-- admin_manage_approval_policy. No migration ever created them, so no role held them and those
-- pages refused everyone outside local development. Found by the 2026-10 adversarial audit's
-- authorization matrix: every permission the code requires must exist in the catalog
-- (__tests__/admin-authorization-matrix.test.ts), and the replay checks the catalog the tests
-- use matches the database (scripts/role-catalog.cjs).
--
-- Also admin_purge_user_data: the GDPR hard purge was gated by admin_manage_users, so any admin
-- could irreversibly erase any account (audit X-15). It now requires its own permission.
--
-- Granted to super_admin only. Each governs who agents may act for, which users may use which
-- features, who must approve held actions, or irreversible erasure — powers above an ordinary
-- admin.

INSERT INTO permissions (code, display_name, description, category) VALUES
  ('admin_manage_agents', 'Manage Agents', 'Register, suspend and scope trusted agents', 'admin'),
  ('admin_manage_account_restrictions', 'Manage Account Restrictions', 'Block or unblock features for a user account', 'admin'),
  ('admin_manage_approval_policy', 'Manage Approval Policy', 'Set who must approve held agent actions', 'admin'),
  ('admin_purge_user_data', 'Purge User Data', 'Irreversibly erase an account''s personal data (GDPR hard purge)', 'admin')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'super_admin'
  AND p.code IN ('admin_manage_agents', 'admin_manage_account_restrictions', 'admin_manage_approval_policy', 'admin_purge_user_data')
ON CONFLICT (role_id, permission_id) DO NOTHING;

insert into applied_migrations (filename, confidence, note)
values (
  '041_admin_page_permissions.sql',
  'verified',
  'Sprint 7X: creates admin_manage_agents, admin_manage_account_restrictions, admin_manage_approval_policy (required by code, never created) and admin_purge_user_data; grants them to super_admin.'
)
on conflict (filename) do nothing;
