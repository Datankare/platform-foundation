-- Migration 008: Rename player → user (TASK-018)
--
-- Platform-foundation is a consumer-agnostic template.
-- "player" is game-specific terminology; "user" is universal.
--
-- This migration renames:
--   Table:   players → users
--   Table:   player_entitlements → user_entitlements
--   Enum:    player_role → user_role
--   Column:  player_entitlements.player_id → user_entitlements.user_id
--   Indexes: all idx_players_* → idx_users_*
--   Indexes: idx_player_entitlements_* → idx_user_entitlements_*
--   Constraint: player_entitlements_player_id_entitlement_group_id_key
--
-- NOTE: Supabase has auth.users in the auth schema.
-- This migration creates public.users — different schema, no conflict.
-- This is the standard Supabase pattern (auth.users + public.profiles/users).

BEGIN;

-- -----------------------------------------------------------------------
-- 1. Rename enum type
-- -----------------------------------------------------------------------
ALTER TYPE player_role RENAME TO user_role;

-- -----------------------------------------------------------------------
-- 2. Rename tables
-- -----------------------------------------------------------------------
ALTER TABLE players RENAME TO users;
ALTER TABLE player_entitlements RENAME TO user_entitlements;

-- -----------------------------------------------------------------------
-- 3. Rename columns
-- -----------------------------------------------------------------------
ALTER TABLE user_entitlements RENAME COLUMN player_id TO user_id;

-- -----------------------------------------------------------------------
-- 4. Rename indexes on users table (formerly players)
-- -----------------------------------------------------------------------
ALTER INDEX idx_players_cognito_sub RENAME TO idx_users_cognito_sub;
ALTER INDEX idx_players_guest_token RENAME TO idx_users_guest_token;
ALTER INDEX idx_players_email RENAME TO idx_users_email;
ALTER INDEX idx_players_role_id RENAME TO idx_users_role_id;
ALTER INDEX idx_players_created_at RENAME TO idx_users_created_at;

-- -----------------------------------------------------------------------
-- 5. Rename indexes on user_entitlements (formerly player_entitlements)
-- -----------------------------------------------------------------------
ALTER INDEX idx_player_entitlements_player RENAME TO idx_user_entitlements_user;

-- -----------------------------------------------------------------------
-- 6. Rename unique constraint
-- -----------------------------------------------------------------------
ALTER TABLE user_entitlements
  RENAME CONSTRAINT player_entitlements_player_id_entitlement_group_id_key
  TO user_entitlements_user_id_entitlement_group_id_key;

-- -----------------------------------------------------------------------
-- 7. Update table comments
-- -----------------------------------------------------------------------
COMMENT ON TABLE users IS 'Core user record. Every user including guests.';
COMMENT ON TABLE user_entitlements IS 'Maps users to entitlement groups with time-bounded grants.';

-- -----------------------------------------------------------------------
-- 8. Update helper functions that reference old table names
-- -----------------------------------------------------------------------

-- Rename the function
ALTER FUNCTION get_current_player_id() RENAME TO get_current_user_id;

-- Recreate with updated SQL body (references public.users instead of players)
CREATE OR REPLACE FUNCTION get_current_user_id()
RETURNS UUID AS $$
  SELECT id FROM public.users WHERE cognito_sub = auth.uid()::text LIMIT 1;
$$ LANGUAGE SQL STABLE SECURITY DEFINER;

-- Update the permission check function (references users + user_entitlements)
CREATE OR REPLACE FUNCTION has_permission(required_permission TEXT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.users p
    JOIN roles r ON r.id = p.role_id
    JOIN role_permissions rp ON rp.role_id = r.id
    JOIN permissions perm ON perm.id = rp.permission_id
    WHERE p.id = get_current_user_id()
      AND perm.name = required_permission
  )
  OR EXISTS (
    SELECT 1
    FROM public.users p
    JOIN user_entitlements pe ON pe.user_id = p.id
    JOIN entitlement_group_permissions egp ON egp.entitlement_group_id = pe.entitlement_group_id
    JOIN permissions perm ON perm.id = egp.permission_id
    WHERE p.id = get_current_user_id()
      AND pe.revoked_at IS NULL
      AND (pe.expires_at IS NULL OR pe.expires_at > NOW())
      AND perm.name = required_permission
  );
$$ LANGUAGE SQL STABLE SECURITY DEFINER;

-- Update the admin check function
CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users p
    JOIN roles r ON r.id = p.role_id
    WHERE p.id = get_current_user_id()
      AND r.name IN ('admin', 'super_admin')
  );
$$ LANGUAGE SQL STABLE SECURITY DEFINER;

COMMIT;
