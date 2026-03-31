-- Migration 004: Allow dynamic role creation
-- 
-- Changes roles.name from player_role enum to text.
-- Required for GenAI admin — roles must be creatable at runtime.
--
-- Sprint 6

-- Drop the enum constraint on roles.name
ALTER TABLE roles ALTER COLUMN name TYPE text;

-- Drop the enum type (no longer needed)
DROP TYPE IF EXISTS player_role;
