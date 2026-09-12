-- 034_safety_approver_role.sql — ADR-040: the safety_approver role
--
-- A dual-control PEER: it can view and co-sign safety-config changes, and nothing else
-- powerful. This makes two-person control operable at one super_admin + one safety_approver
-- without a second apex account. Grants (all existing permissions):
--   config_manage_safety  edit AND approve safety-tier config — the authority the approver
--                         rule requires ("approve iff independently authorized to edit")
--   can_access_admin      see the pending-approvals queue
--   config_view           see the held change and its "why held" context (no rubber-stamping)
-- Deliberately EXCLUDES admin_manage_roles / users / entitlements, so the role cannot
-- self-escalate into a shadow super_admin. Assigned by super_admin through the normal
-- (audited) role management — not database-only like super_admin, since it cannot escalate.

INSERT INTO roles (name, display_name, description, is_default, sort_order)
VALUES (
  'safety_approver',
  'Safety Approver',
  'Independent approver for dual-controlled safety-config changes (ADR-040). Views and co-signs safety changes; cannot manage users, entitlements, or roles.',
  false,
  4
)
ON CONFLICT (name) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'safety_approver'
  AND p.code IN ('config_manage_safety', 'can_access_admin', 'config_view')
ON CONFLICT (role_id, permission_id) DO NOTHING;

insert into applied_migrations (filename, confidence, note)
values (
  '034_safety_approver_role.sql',
  'verified',
  'Seeds the safety_approver role (ADR-040): grants config_manage_safety + can_access_admin + config_view; a dual-control peer that cannot self-escalate.'
);
