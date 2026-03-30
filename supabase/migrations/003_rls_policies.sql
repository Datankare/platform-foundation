-- ============================================================================
-- Playform Phase 1 — Row-Level Security Policies
-- Migration: 003_rls_policies.sql
--
-- Run AFTER 001 and 002.
--
-- Design principles:
-- - Default deny: RLS is enabled, no policy = no access
-- - auth.uid() returns the Cognito sub from the JWT (via Supabase JWT bridge)
-- - Service role key bypasses ALL RLS (used for admin/system operations)
-- - Players can only read/modify their own data
-- - Roles, permissions, and entitlement groups are readable by all authenticated users
-- - Audit log is append-only (insert via service role, read by admins)
--
-- ADR-012: Cognito JWT → Supabase RLS via auth.uid() = players.cognito_sub
-- ============================================================================

-- ── HELPER FUNCTION ─────────────────────────────────────────────────────────
-- Get the current player's ID from their Cognito sub in the JWT.
-- Returns NULL if no valid JWT (guest or unauthenticated).

CREATE OR REPLACE FUNCTION get_current_player_id()
RETURNS UUID AS $$
  SELECT id FROM players WHERE cognito_sub = auth.uid()::text LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Check if the current player has a specific permission
-- (from their role + entitlements)
CREATE OR REPLACE FUNCTION has_permission(permission_code TEXT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    -- Permission from primary role
    SELECT 1
    FROM players p
    JOIN role_permissions rp ON rp.role_id = p.role_id
    JOIN permissions perm ON perm.id = rp.permission_id
    WHERE p.cognito_sub = auth.uid()::text
      AND perm.code = permission_code
      AND p.deleted_at IS NULL

    UNION

    -- Permission from entitlements
    SELECT 1
    FROM players p
    JOIN player_entitlements pe ON pe.player_id = p.id
    JOIN entitlement_permissions ep ON ep.entitlement_group_id = pe.entitlement_group_id
    JOIN permissions perm ON perm.id = ep.permission_id
    WHERE p.cognito_sub = auth.uid()::text
      AND perm.code = permission_code
      AND pe.revoked_at IS NULL
      AND (pe.expires_at IS NULL OR pe.expires_at > now())
      AND p.deleted_at IS NULL
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Check if the current player is an admin
CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM players p
    JOIN roles r ON r.id = p.role_id
    WHERE p.cognito_sub = auth.uid()::text
      AND r.name = 'admin'
      AND p.deleted_at IS NULL
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- ── 1. ROLES — readable by all authenticated ────────────────────────────────

CREATE POLICY "Roles are readable by all authenticated users"
  ON roles FOR SELECT
  TO authenticated
  USING (true);

-- Only service role can insert/update/delete roles (via admin operations)

-- ── 2. PERMISSIONS — readable by all authenticated ──────────────────────────

CREATE POLICY "Permissions are readable by all authenticated users"
  ON permissions FOR SELECT
  TO authenticated
  USING (true);

-- ── 3. ROLE_PERMISSIONS — readable by all authenticated ─────────────────────

CREATE POLICY "Role permissions are readable by all authenticated users"
  ON role_permissions FOR SELECT
  TO authenticated
  USING (true);

-- ── 4. ROLE_INHERITANCE — readable by all authenticated ─────────────────────

CREATE POLICY "Role inheritance is readable by all authenticated users"
  ON role_inheritance FOR SELECT
  TO authenticated
  USING (true);

-- ── 5. PLAYERS — own data only ──────────────────────────────────────────────

CREATE POLICY "Players can read their own record"
  ON players FOR SELECT
  TO authenticated
  USING (cognito_sub = auth.uid()::text AND deleted_at IS NULL);

CREATE POLICY "Players can update their own record"
  ON players FOR UPDATE
  TO authenticated
  USING (cognito_sub = auth.uid()::text AND deleted_at IS NULL)
  WITH CHECK (cognito_sub = auth.uid()::text AND deleted_at IS NULL);

-- Admins can read all players (for player management screen)
CREATE POLICY "Admins can read all players"
  ON players FOR SELECT
  TO authenticated
  USING (is_admin());

-- Insert is done via service role (sign-up creates the player record)
-- Delete is done via service role (GDPR deletion)

-- ── 6. ENTITLEMENT_GROUPS — readable by all authenticated ───────────────────

CREATE POLICY "Entitlement groups are readable by all authenticated users"
  ON entitlement_groups FOR SELECT
  TO authenticated
  USING (true);

-- ── 7. ENTITLEMENT_PERMISSIONS — readable by all authenticated ──────────────

CREATE POLICY "Entitlement permissions are readable by all authenticated users"
  ON entitlement_permissions FOR SELECT
  TO authenticated
  USING (true);

-- ── 8. PLAYER_ENTITLEMENTS — own data only ──────────────────────────────────

CREATE POLICY "Players can read their own entitlements"
  ON player_entitlements FOR SELECT
  TO authenticated
  USING (player_id = get_current_player_id());

-- Admins can read all entitlements (for entitlement management)
CREATE POLICY "Admins can read all player entitlements"
  ON player_entitlements FOR SELECT
  TO authenticated
  USING (is_admin());

-- Grant/revoke done via service role (admin operations)

-- ── 9. AUDIT_LOG — admins read, system writes ───────────────────────────────

CREATE POLICY "Admins can read audit log"
  ON audit_log FOR SELECT
  TO authenticated
  USING (is_admin());

-- Players can read their own audit entries
CREATE POLICY "Players can read their own audit entries"
  ON audit_log FOR SELECT
  TO authenticated
  USING (target_id = get_current_player_id());

-- Insert is done via service role (system writes only)
-- No update or delete — audit log is immutable

-- ── 10. CONSENT_RECORDS — own data only ─────────────────────────────────────

CREATE POLICY "Players can read their own consent records"
  ON consent_records FOR SELECT
  TO authenticated
  USING (player_id = get_current_player_id());

CREATE POLICY "Players can insert their own consent records"
  ON consent_records FOR INSERT
  TO authenticated
  WITH CHECK (player_id = get_current_player_id());

-- Revocation done via service role (to ensure audit trail)

-- ── 11. PLAYER_DEVICES — own data only ──────────────────────────────────────

CREATE POLICY "Players can read their own devices"
  ON player_devices FOR SELECT
  TO authenticated
  USING (player_id = get_current_player_id());

CREATE POLICY "Players can delete their own devices"
  ON player_devices FOR DELETE
  TO authenticated
  USING (player_id = get_current_player_id());

-- Insert/update done via service role (device registration during auth)

-- ── 12. PASSWORD_POLICY — readable by authenticated ─────────────────────────
-- Players need to read policy to show requirements in UI.
-- Only service role can modify.

CREATE POLICY "Password policy is readable by all authenticated users"
  ON password_policy FOR SELECT
  TO authenticated
  USING (true);

-- ── 13. DELETION_MANIFEST — admin only ──────────────────────────────────────

CREATE POLICY "Admins can read deletion manifest"
  ON deletion_manifest FOR SELECT
  TO authenticated
  USING (is_admin());

-- ── 14. GUEST_CONFIG — readable by authenticated, writable by admin ─────────

CREATE POLICY "Guest config is readable by all authenticated users"
  ON guest_config FOR SELECT
  TO authenticated
  USING (true);

-- Update done via service role (admin operations)
