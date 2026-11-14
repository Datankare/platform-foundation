-- 073_retention_lifecycles.sql — an app session's runs end with it, rate-limit counters are
-- deleted on a schedule, and an external call left pending is settled (TASK-215, audit B-5, B-12,
-- and the rate-limit finding of the S4 retention audit)
--
-- 1. Rate-limit counters (S4). A bucket's events were deleted only when that same bucket was
--    counted again (rate_limit_hit, 049), or by a 1-in-100 sweep of the calling tenant on a later
--    count: a one-time visitor's address bucket could stay indefinitely in a quiet tenant. The
--    data.retention job now deletes every tenant's events older than
--    retention.rate_limit_events_days (default 1 — no window is longer than a day — 1 to 30),
--    seeded here as the other retention settings are (064: operator-only, safety tier).
-- 2. An app session's agent runs (B-5). A session's history is an agent_trajectories row (or a
--    chain of them) with subject_kind 'session' and the session's id. It had no end: the
--    trajectory reaper skips a session's run (the session, not a timer, governs it), and when a
--    session was deleted — by data.retention after retention.app_sessions_days idle, by an erasure,
--    by its app — its runs stayed, `running`, for good. Now a statement-level trigger on
--    app_sessions deletes the runs of every session a statement deletes, in the same transaction:
--    whatever deletes a session deletes its history. The runs of sessions already gone are deleted
--    here once (a session's run is opened after its session is stored, so a run with no session is
--    one whose session was deleted — or, in an environment that kept sessions in memory, lost).
-- 3. An external call left pending (B-12). The ledger writes an entry before a call and resolves it
--    after; one left pending by a process that stopped mid-call was looked at again only by a retry
--    of the same operation. effects.pending_timeout_minutes (default 60, 5 to 10080; operator-only,
--    safety tier) bounds it: data.retention settles an older one as of unknown outcome
--    (indeterminate), which an operator then marks on the operator console's Jobs page
--    (platform/agents/effect-settlement.ts).
--
-- Idempotent: settings inserted on conflict do nothing (an operator's later value stands); the
-- function replaced and the trigger re-created as they are; the cleanup deletes only runs whose
-- session is gone (a second run finds none). Locks: app_sessions SHARE ROW EXCLUSIVE while its
-- trigger is created (brief); agent_trajectories ROW EXCLUSIVE while the orphaned runs are deleted
-- (one pass, by subject). lock_timeout 5 s: on a busy table it fails rather than queueing others
-- behind it; run it again. Apply it as ONE run.

set local lock_timeout = '5s';

-- ── 1 and 3. Settings ─────────────────────────────────────────────────────────────────────────
insert into public.platform_config
  (key, value, default_value, description, category, value_type, min_value, max_value, permission_tier, tenant_overridable)
values
  ('retention.rate_limit_events_days', '1', '1',
   'Days a counted request (a rate-limit event: an account''s or a network address''s bucket) is kept, in every tenant, whether or not its bucket is counted again (TASK-215).',
   'retention', 'number', '1', '30', 'safety', false),
  ('effects.pending_timeout_minutes', '60', '60',
   'Minutes an external call may stay pending before it is settled as of unknown outcome, for an operator to mark on the Jobs page (TASK-215, ADR-031 D7).',
   'agents', 'number', '5', '10080', 'safety', false)
on conflict (key) do nothing;

-- ── 2. A session's runs end with it ───────────────────────────────────────────────────────────
create or replace function public.app_sessions_end_trajectories()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  delete from public.agent_trajectories t
   using ended e
   where t.subject_kind = 'session'
     and t.subject_id = e.id
     and t.tenant_id = e.tenant_id;
  return null;
end;
$$;

-- Fired by the trigger only: no role calls it (a trigger needs no EXECUTE grant to fire it).
revoke all on function public.app_sessions_end_trajectories() from public, anon, authenticated;

comment on function public.app_sessions_end_trajectories() is
  'TASK-215 (audit B-5): the agent runs of every app session a statement deletes are deleted with it (subject_kind session), whatever deleted the session.';

drop trigger if exists app_sessions_end_trajectories on public.app_sessions;
create trigger app_sessions_end_trajectories
  after delete on public.app_sessions
  referencing old table as ended
  for each statement
  execute function public.app_sessions_end_trajectories();

delete from public.agent_trajectories t
 where t.subject_kind = 'session'
   and not exists (
     select 1 from public.app_sessions s
      where s.id = t.subject_id and s.tenant_id = t.tenant_id);

insert into public.applied_migrations (filename, confidence, note, checksum)
values (
  '073_retention_lifecycles.sql',
  'verified',
  'TASK-215 (audit B-5, B-12, S4): retention.rate_limit_events_days and effects.pending_timeout_minutes seeded; an app session''s runs deleted with it (statement trigger on app_sessions), the runs of sessions already gone deleted once.',
  'sha256:035bd4c4514439995b1b992cbeb3e2333354512a214b1aa69da384597e256a76'
)
on conflict (filename) do update set checksum = excluded.checksum;
