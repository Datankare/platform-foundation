-- ============================================================================
-- Phase 4, Sprint 4a — Social Data Model
-- Migration: 015_social_data_model.sql
--
-- Creates the core social tables: groups, group_memberships, group_invites.
-- All tables are additive — no ALTER on existing tables.
--
-- ADR-021: Social System Architecture
-- P7:  Provider-aware — Supabase persistence layer
-- P8:  Context/memory — groups.metadata JSONB for agent context
-- P10: Human oversight — invites require explicit resolution
-- ============================================================================

-- ── CUSTOM TYPES ────────────────────────────────────────────────────────────

CREATE TYPE group_status AS ENUM ('active', 'archived', 'suspended');
CREATE TYPE member_role AS ENUM ('owner', 'admin', 'member');
CREATE TYPE invite_status AS ENUM ('pending', 'accepted', 'declined', 'expired');

-- ── GROUPS ──────────────────────────────────────────────────────────────────

CREATE TABLE groups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL CHECK (char_length(name) >= 3 AND char_length(name) <= 100),
  description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  metadata    JSONB NOT NULL DEFAULT '{}',
  owner_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      group_status NOT NULL DEFAULT 'active',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE groups IS
  'Social groups — core organizational unit for social features.';
COMMENT ON COLUMN groups.metadata IS
  'Extensible JSONB metadata for agent context (P8, P16). Agents store per-group context here.';
COMMENT ON COLUMN groups.owner_id IS
  'The user who created this group. Only the owner can archive.';

CREATE INDEX idx_groups_owner_id ON groups(owner_id);
CREATE INDEX idx_groups_status ON groups(status);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_groups_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_groups_updated_at
  BEFORE UPDATE ON groups
  FOR EACH ROW EXECUTE FUNCTION update_groups_updated_at();

-- ── GROUP MEMBERSHIPS ───────────────────────────────────────────────────────

CREATE TABLE group_memberships (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id  UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      member_role NOT NULL DEFAULT 'member',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at   TIMESTAMPTZ
);

COMMENT ON TABLE group_memberships IS
  'Tracks user membership in groups. left_at set on leave/removal (soft delete).';
COMMENT ON COLUMN group_memberships.left_at IS
  'When user left or was removed. NULL = active member. Queries for active members filter WHERE left_at IS NULL.';

-- Unique constraint: one active membership per user per group
CREATE UNIQUE INDEX idx_memberships_active
  ON group_memberships(group_id, user_id)
  WHERE left_at IS NULL;

CREATE INDEX idx_memberships_user_id ON group_memberships(user_id);
CREATE INDEX idx_memberships_group_id ON group_memberships(group_id);

-- ── GROUP INVITES ───────────────────────────────────────────────────────────

CREATE TABLE group_invites (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  inviter_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invitee_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      invite_status NOT NULL DEFAULT 'pending',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

COMMENT ON TABLE group_invites IS
  'Invitations to join groups. P10: requires explicit accept/decline — no auto-join.';
COMMENT ON COLUMN group_invites.resolved_at IS
  'When the invite was accepted, declined, or expired. NULL = still pending.';

-- One pending invite per invitee per group
CREATE UNIQUE INDEX idx_invites_pending
  ON group_invites(group_id, invitee_id)
  WHERE status = 'pending';

CREATE INDEX idx_invites_invitee ON group_invites(invitee_id);
CREATE INDEX idx_invites_group_id ON group_invites(group_id);

-- ── RLS POLICIES ────────────────────────────────────────────────────────────

ALTER TABLE groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_invites ENABLE ROW LEVEL SECURITY;

-- Groups: members can see groups they belong to
CREATE POLICY groups_select_member ON groups
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM group_memberships
      WHERE group_memberships.group_id = groups.id
        AND group_memberships.user_id = auth.uid()
        AND group_memberships.left_at IS NULL
    )
  );

-- Groups: only owner can update
CREATE POLICY groups_update_owner ON groups
  FOR UPDATE USING (owner_id = auth.uid());

-- Groups: authenticated users can create
CREATE POLICY groups_insert_auth ON groups
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- Memberships: members can see their own group's memberships
CREATE POLICY memberships_select_member ON group_memberships
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM group_memberships AS gm
      WHERE gm.group_id = group_memberships.group_id
        AND gm.user_id = auth.uid()
        AND gm.left_at IS NULL
    )
  );

-- Invites: invitee can see their own invites
CREATE POLICY invites_select_invitee ON group_invites
  FOR SELECT USING (invitee_id = auth.uid());

-- Invites: group members can see invites for their group
CREATE POLICY invites_select_member ON group_invites
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM group_memberships
      WHERE group_memberships.group_id = group_invites.group_id
        AND group_memberships.user_id = auth.uid()
        AND group_memberships.left_at IS NULL
    )
  );

-- Invites: group members can create invites
CREATE POLICY invites_insert_member ON group_invites
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM group_memberships
      WHERE group_memberships.group_id = group_invites.group_id
        AND group_memberships.user_id = auth.uid()
        AND group_memberships.left_at IS NULL
    )
  );

-- Invites: invitee can update (accept/decline) their own invite
CREATE POLICY invites_update_invitee ON group_invites
  FOR UPDATE USING (invitee_id = auth.uid());

-- Service role bypass for all tables (agent operations are server-side)
CREATE POLICY groups_service_all ON groups
  FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY memberships_service_all ON group_memberships
  FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY invites_service_all ON group_invites
  FOR ALL USING (auth.role() = 'service_role');
