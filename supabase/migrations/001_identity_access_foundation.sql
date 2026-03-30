-- ============================================================================
-- Playform Phase 1 — Identity & Access Foundation Schema
-- Migration: 001_identity_access_foundation.sql
--
-- Run against Supabase SQL Editor or via CLI:
--   supabase db push
--
-- ADR-012: Cognito for auth, Supabase for DB/RLS
-- All tables have RLS enabled (auto-RLS is on, but we enable explicitly)
-- ============================================================================

-- ── EXTENSIONS ──────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── CUSTOM TYPES ────────────────────────────────────────────────────────────

CREATE TYPE player_role AS ENUM (
  'guest',
  'free',
  'daily',
  'monthly',
  'annual',
  'lifetime',
  'admin'
);

CREATE TYPE parental_consent_status AS ENUM (
  'not_required',
  'pending',
  'granted',
  'denied'
);

CREATE TYPE profile_visibility AS ENUM (
  'private',
  'friends',
  'public'
);

CREATE TYPE audit_action AS ENUM (
  'role_changed',
  'permission_granted',
  'permission_revoked',
  'entitlement_granted',
  'entitlement_revoked',
  'entitlement_expired',
  'profile_updated',
  'profile_viewed_by_admin',
  'password_changed',
  'password_reset',
  'mfa_enabled',
  'mfa_disabled',
  'device_registered',
  'device_removed',
  'account_created',
  'account_deleted',
  'account_converted_from_guest',
  'consent_granted',
  'consent_revoked',
  'admin_action',
  'login_success',
  'login_failed',
  'guest_nudge_shown',
  'guest_locked_out'
);

-- ── 1. ROLES TABLE ──────────────────────────────────────────────────────────
-- Static role definitions. Seeded with 7 roles.
-- Roles are not player-created — they are platform-defined.

CREATE TABLE roles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name player_role NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description TEXT,
  is_default BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE roles ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE roles IS 'Platform role definitions. Exactly one role per player.';

-- ── 2. PERMISSIONS TABLE ────────────────────────────────────────────────────
-- Capabilities catalog. Extensible — new permissions added via Admin UI.

CREATE TABLE permissions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL DEFAULT 'general',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE permissions ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE permissions IS 'Capabilities catalog. Extensible via Admin UI.';

-- ── 3. ROLE_PERMISSIONS TABLE ───────────────────────────────────────────────
-- Maps permissions to roles. Many-to-many.

CREATE TABLE role_permissions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  granted_by UUID,  -- admin player_id who made the change (NULL for seed data)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(role_id, permission_id)
);

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE role_permissions IS 'Role-to-permission assignments.';

-- ── 4. ROLE_INHERITANCE TABLE ───────────────────────────────────────────────
-- Optional inheritance. Role X inherits all permissions from Role Y.
-- Not assumed linear — Admin configures explicitly.

CREATE TABLE role_inheritance (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  inherits_from_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(role_id, inherits_from_id),
  CHECK (role_id != inherits_from_id)
);

ALTER TABLE role_inheritance ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE role_inheritance IS 'Optional role inheritance. Not assumed linear.';

-- ── 5. PLAYERS TABLE ────────────────────────────────────────────────────────
-- Core player record. Every player (including guests) gets a row.

CREATE TABLE players (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  cognito_sub TEXT UNIQUE,              -- NULL for guests (no Cognito account)
  guest_token TEXT UNIQUE,              -- NULL for registered players
  
  -- Identity
  email TEXT,                           -- NULL for guests
  display_name TEXT,
  avatar_url TEXT,
  real_name TEXT,                       -- Private — never shown unless player chooses
  
  -- Role
  role_id UUID NOT NULL REFERENCES roles(id),
  
  -- Preferences
  language_preference TEXT NOT NULL DEFAULT 'en',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  
  -- Privacy controls (default: private)
  profile_visibility profile_visibility NOT NULL DEFAULT 'private',
  display_name_visibility profile_visibility NOT NULL DEFAULT 'private',
  avatar_visibility profile_visibility NOT NULL DEFAULT 'private',
  language_visibility profile_visibility NOT NULL DEFAULT 'private',
  timezone_visibility profile_visibility NOT NULL DEFAULT 'private',
  
  -- Communication
  email_opt_in BOOLEAN NOT NULL DEFAULT false,
  push_notifications_enabled BOOLEAN NOT NULL DEFAULT false,
  
  -- COPPA (schema — full implementation Phase 4)
  date_of_birth DATE,                   -- NULL for guests
  age_verified BOOLEAN NOT NULL DEFAULT false,
  age_verified_at TIMESTAMPTZ,
  parental_consent_status parental_consent_status NOT NULL DEFAULT 'not_required',
  parental_consent_email TEXT,
  content_rating_level INTEGER NOT NULL DEFAULT 1,  -- 1 = strictest
  
  -- Auth state
  mfa_enabled BOOLEAN NOT NULL DEFAULT false,
  email_verified BOOLEAN NOT NULL DEFAULT false,
  
  -- Guest lifecycle
  guest_play_seconds INTEGER NOT NULL DEFAULT 0,
  guest_nudge_shown_at TIMESTAMPTZ,
  guest_locked_out_at TIMESTAMPTZ,
  
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ               -- Soft delete for GDPR audit trail
);

ALTER TABLE players ENABLE ROW LEVEL SECURITY;

-- Indexes for common queries
CREATE INDEX idx_players_cognito_sub ON players(cognito_sub) WHERE cognito_sub IS NOT NULL;
CREATE INDEX idx_players_guest_token ON players(guest_token) WHERE guest_token IS NOT NULL;
CREATE INDEX idx_players_email ON players(email) WHERE email IS NOT NULL;
CREATE INDEX idx_players_role_id ON players(role_id);
CREATE INDEX idx_players_created_at ON players(created_at);

COMMENT ON TABLE players IS 'Core player record. Every player including guests.';

-- ── 6. ENTITLEMENT_GROUPS TABLE ─────────────────────────────────────────────
-- Named entitlement groups (Beta Testers, VIP, etc.)

CREATE TABLE entitlement_groups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description TEXT,
  expires_at TIMESTAMPTZ,               -- Group-level expiry (NULL = no expiry)
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES players(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE entitlement_groups ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE entitlement_groups IS 'Named entitlement groups with optional expiry.';

-- ── 7. ENTITLEMENT_PERMISSIONS TABLE ────────────────────────────────────────
-- Which permissions each entitlement group grants.

CREATE TABLE entitlement_permissions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entitlement_group_id UUID NOT NULL REFERENCES entitlement_groups(id) ON DELETE CASCADE,
  permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(entitlement_group_id, permission_id)
);

ALTER TABLE entitlement_permissions ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE entitlement_permissions IS 'Permissions granted by each entitlement group.';

-- ── 8. PLAYER_ENTITLEMENTS TABLE ────────────────────────────────────────────
-- Which entitlement groups a player belongs to. Time-bounded.

CREATE TABLE player_entitlements (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  entitlement_group_id UUID NOT NULL REFERENCES entitlement_groups(id) ON DELETE CASCADE,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,               -- Per-player expiry (overrides group expiry)
  revoked_at TIMESTAMPTZ,               -- NULL = active
  granted_by UUID REFERENCES players(id),
  revoked_by UUID REFERENCES players(id),
  UNIQUE(player_id, entitlement_group_id)
);

ALTER TABLE player_entitlements ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_player_entitlements_player ON player_entitlements(player_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_player_entitlements_expiry ON player_entitlements(expires_at) WHERE expires_at IS NOT NULL AND revoked_at IS NULL;

COMMENT ON TABLE player_entitlements IS 'Player-to-entitlement-group assignments. Time-bounded.';

-- ── 9. AUDIT_LOG TABLE ──────────────────────────────────────────────────────
-- Immutable log of all auditable events.
-- Never updated or deleted. Append-only.

CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  action audit_action NOT NULL,
  actor_id UUID,                        -- Player who performed the action (NULL for system)
  target_id UUID,                       -- Player who was affected (NULL for system actions)
  details JSONB NOT NULL DEFAULT '{}',  -- Structured event data
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- Indexes for common audit queries
CREATE INDEX idx_audit_log_action ON audit_log(action);
CREATE INDEX idx_audit_log_actor ON audit_log(actor_id) WHERE actor_id IS NOT NULL;
CREATE INDEX idx_audit_log_target ON audit_log(target_id) WHERE target_id IS NOT NULL;
CREATE INDEX idx_audit_log_created ON audit_log(created_at);

COMMENT ON TABLE audit_log IS 'Immutable audit trail. Append-only — never updated or deleted.';

-- ── 10. CONSENT_RECORDS TABLE ───────────────────────────────────────────────
-- Tracks what the player agreed to, when, and which version.

CREATE TABLE consent_records (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  consent_type TEXT NOT NULL,           -- e.g., 'terms_of_service', 'privacy_policy', 'marketing'
  consent_version TEXT NOT NULL,        -- e.g., '1.0', '2.1'
  granted BOOLEAN NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  ip_address INET,
  user_agent TEXT
);

ALTER TABLE consent_records ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_consent_player ON consent_records(player_id);

COMMENT ON TABLE consent_records IS 'Player consent records — GDPR purpose limitation.';

-- ── 11. PLAYER_DEVICES TABLE ────────────────────────────────────────────────
-- Device registry — tracks which devices a player has logged in from.

CREATE TABLE player_devices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,              -- Provider-specific device identifier
  device_name TEXT,                     -- User-friendly name (Chrome on MacOS, etc.)
  is_trusted BOOLEAN NOT NULL DEFAULT false,
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(player_id, device_id)
);

ALTER TABLE player_devices ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_player_devices_player ON player_devices(player_id);

COMMENT ON TABLE player_devices IS 'Device registry for cross-device session management.';

-- ── 12. PASSWORD_POLICY TABLE ───────────────────────────────────────────────
-- Password rotation policy with role-level and individual overrides.
-- Schema in Phase 1, enforcement in Phase 2.

CREATE TABLE password_policy (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- Either role_id OR player_id is set, not both. NULL/NULL = global default.
  role_id UUID REFERENCES roles(id) ON DELETE CASCADE,
  player_id UUID REFERENCES players(id) ON DELETE CASCADE,
  rotation_days INTEGER NOT NULL DEFAULT 90,
  min_length INTEGER NOT NULL DEFAULT 12,
  require_uppercase BOOLEAN NOT NULL DEFAULT true,
  require_lowercase BOOLEAN NOT NULL DEFAULT true,
  require_number BOOLEAN NOT NULL DEFAULT true,
  require_special BOOLEAN NOT NULL DEFAULT true,
  password_history_count INTEGER NOT NULL DEFAULT 5,  -- Cannot reuse last N passwords
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Exactly one scope: global (both NULL), role, or individual
  CHECK (
    (role_id IS NULL AND player_id IS NULL) OR
    (role_id IS NOT NULL AND player_id IS NULL) OR
    (role_id IS NULL AND player_id IS NOT NULL)
  )
);

ALTER TABLE password_policy ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE password_policy IS 'Password rotation policy. Global → role → individual override chain.';

-- ── 13. DELETION_MANIFEST TABLE ─────────────────────────────────────────────
-- Registry of modules that store player data and their cleanup functions.
-- Used by GDPR right-to-erasure to ensure complete deletion.

CREATE TABLE deletion_manifest (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  module_name TEXT NOT NULL UNIQUE,     -- e.g., 'auth', 'groups', 'scores', 'moderation'
  table_names TEXT[] NOT NULL,          -- Tables this module owns
  description TEXT,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE deletion_manifest ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE deletion_manifest IS 'GDPR deletion manifest — modules register their player data tables.';

-- ── 14. GUEST_CONFIG TABLE ──────────────────────────────────────────────────
-- Admin-configurable guest lifecycle thresholds.
-- Single row — global configuration.

CREATE TABLE guest_config (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  nudge_after_seconds INTEGER NOT NULL DEFAULT 3600,      -- 1 hour default
  grace_period_seconds INTEGER NOT NULL DEFAULT 1800,     -- 30 minutes default
  lockout_after_seconds INTEGER NOT NULL DEFAULT 5400,    -- 1.5 hours total (nudge + grace)
  updated_by UUID REFERENCES players(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE guest_config ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE guest_config IS 'Admin-configurable guest lifecycle thresholds.';

-- ── UPDATED_AT TRIGGER ──────────────────────────────────────────────────────
-- Automatically set updated_at on any row update.

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to all tables with updated_at
CREATE TRIGGER set_updated_at BEFORE UPDATE ON roles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON permissions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON players
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON entitlement_groups
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON password_policy
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON guest_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
