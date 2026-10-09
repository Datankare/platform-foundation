-- ============================================================================
-- 038_retire_guest_lifecycle.sql — Sprint 7A (TASK-111)
--
-- Retires the session-count guest lifecycle. It never worked: guest_config stored *seconds*
-- thresholds while the code read *session* columns that do not exist, users had no session
-- counter, and no route called it. Admin edits to it (the Guest Config panel, the admin AI tool,
-- the guest_session_limit / guest_nudge_after config keys) had no effect. Guests are bounded by
-- the governed translate allowance (037, guest.translate_allowance) and carry signed,
-- namespaced tokens that are never stored on users (ADR-050 D4).
--
-- Removes: table guest_config (with its policy and trigger); users.guest_token,
-- guest_play_seconds, guest_nudge_shown_at, guest_locked_out_at (with their constraint and
-- index); the two dead platform_config keys (their history and pending approvals cascade).
-- The audit_action values guest_nudge_shown / guest_locked_out stay: enum values cannot be
-- dropped without rebuilding the type, and past audit rows may use them.
-- Idempotent.
-- ============================================================================

drop table if exists public.guest_config;

drop index if exists public.idx_users_guest_token;
alter table public.users drop constraint if exists players_guest_token_key;
alter table public.users drop column if exists guest_token;
alter table public.users drop column if exists guest_play_seconds;
alter table public.users drop column if exists guest_nudge_shown_at;
alter table public.users drop column if exists guest_locked_out_at;

delete from public.platform_config where key in ('guest_session_limit', 'guest_nudge_after');

insert into applied_migrations (filename, confidence, note)
values (
  '038_retire_guest_lifecycle.sql',
  'verified',
  'Sprint 7A (TASK-111): retires the non-functional session-count guest lifecycle — guest_config, four unused users guest columns, two dead config keys. Guests are bounded by guest.translate_allowance (037).'
)
on conflict (filename) do nothing;
