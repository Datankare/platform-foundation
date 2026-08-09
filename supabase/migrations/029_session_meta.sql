-- 029_session_meta.sql
-- app_sessions persisted state and nothing else, so a session could be created and never
-- reconstructed: participants, budget, turn state and definitionId lived in memory only.
-- That left ADR-031 D6's repair with no caller — the ADR says repair runs on session load,
-- and there was no session load. Idempotent and re-runnable.

alter table app_sessions add column if not exists meta jsonb not null default '{}'::jsonb;

comment on column app_sessions.meta is
  'Session shape that is not state: definitionId, participants, budget, turn, status. Required for loadSession (TASK-071) and for turn durability.';

insert into applied_migrations (filename, confidence, note)
values (
  '029_session_meta.sql',
  'verified',
  'Session metadata column for loadSession and turn durability. Self-recorded on application.'
)
on conflict (filename) do update
  set confidence = 'verified', recorded_at = now();
