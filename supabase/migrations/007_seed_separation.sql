-- ============================================================================
-- Phase 1 — Sprint 7b.4: Seed Data Separation
--
-- Platform-foundation defines generic roles only:
--   guest, registered, admin, super_admin
--
-- This migration (for existing databases):
-- 1. Adds "registered" as the generic default role
-- 2. Moves is_default from "free" to "registered"
-- 3. Sets up role inheritance chain
-- ============================================================================

INSERT INTO roles (name, display_name, description, is_default, sort_order)
VALUES ('registered', 'Registered', 'Authenticated user with verified email. Base platform access.', true, 1)
ON CONFLICT (name) DO UPDATE SET is_default = true, display_name = 'Registered';

UPDATE roles SET is_default = false WHERE name = 'free' AND is_default = true;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'registered'
  AND p.code IN ('can_play', 'can_translate', 'can_view_profile', 'can_edit_profile', 'can_export_data', 'can_delete_account')
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );

INSERT INTO role_inheritance (role_id, inherits_from_id)
SELECT r.id, g.id FROM roles r, roles g
WHERE r.name = 'registered' AND g.name = 'guest'
  AND NOT EXISTS (SELECT 1 FROM role_inheritance ri WHERE ri.role_id = r.id AND ri.inherits_from_id = g.id);

INSERT INTO role_inheritance (role_id, inherits_from_id)
SELECT r.id, reg.id FROM roles r, roles reg
WHERE r.name = 'admin' AND reg.name = 'registered'
  AND NOT EXISTS (SELECT 1 FROM role_inheritance ri WHERE ri.role_id = r.id AND ri.inherits_from_id = reg.id);

INSERT INTO role_inheritance (role_id, inherits_from_id)
SELECT r.id, a.id FROM roles r, roles a
WHERE r.name = 'super_admin' AND a.name = 'admin'
  AND NOT EXISTS (SELECT 1 FROM role_inheritance ri WHERE ri.role_id = r.id AND ri.inherits_from_id = a.id);
