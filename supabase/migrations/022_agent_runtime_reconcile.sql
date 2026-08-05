-- ============================================================================
-- Phase 5, Sprint 2 — Agent runtime reconciliation
-- Migration: 022_agent_runtime_reconcile.sql
--
-- Forward reconciliation in the shape of 021, NOT an edit to applied history.
--
-- Context: the live database has no migration-tracking table (Gotcha 60), so applied
-- state is only knowable by object introspection. Introspection on 2026-07-29 found:
--   - agent_trajectories and agent_budgets PRESENT, both 0 rows
--   - app_sessions ABSENT — 018_app_framework.sql was authored 2026-07-26 and never applied
--   - two migrations numbered 018, and (in Playform) two numbered 007
--
-- Everything below is idempotent and re-runnable. There is no second Supabase project to
-- rehearse against, so a partial failure must leave a re-appliable database.
--
-- ADR-028 D2 (app_sessions), ADR-029 D4 (trajectory subject), ADR-031 D9 (step identity)
-- ============================================================================

-- ── 1. app_sessions — never applied from 018_app_framework.sql ──────────────
--
-- Verbatim shape from that migration. `id` is TEXT, not UUID: session ids are hex from
-- generateSecureId(), not UUIDs.

create table if not exists app_sessions (
  id           text primary key,
  state        jsonb       not null,
  version      integer     not null default 1,
  produced_by  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists app_sessions_id_version_idx on app_sessions (id, version);

comment on table app_sessions is
  'ActivitySession versioned state (ADR-028 D2/D5). Authoritative system of record; trajectory persistence is separate (platform/agents).';
comment on column app_sessions.version is
  'Optimistic-concurrency counter. Commits are CAS: UPDATE ... WHERE version = expected (ADR-028 D5).';
comment on column app_sessions.produced_by is
  'operationId of the action that produced this version — reconstructible-state guarantee (ADR-028 D2).';

alter table app_sessions enable row level security;

drop policy if exists app_sessions_service_all on app_sessions;
create policy app_sessions_service_all on app_sessions
  for all using (auth.role() = 'service_role');

-- ── 2. agent_trajectories — carry the subject, version the steps ────────────
--
-- ADR-029 D4: a trajectory is about an agent run or an application session, and the two
-- must be distinguishable. Before D4, session trajectories were written with a sessionId
-- in the agent_id column, which type-checked and was wrong.

alter table agent_trajectories add column if not exists subject_kind text;
alter table agent_trajectories add column if not exists subject_id   text;
alter table agent_trajectories add column if not exists version      integer not null default 1;
alter table agent_trajectories add column if not exists created_at   timestamptz not null default now();
alter table agent_trajectories add column if not exists updated_at   timestamptz not null default now();

-- Backfill. A no-op at 0 rows, but correct if this is ever re-run against a populated table:
-- every pre-D4 row was an agent trajectory, because nothing else could write one.
update agent_trajectories
   set subject_kind = coalesce(subject_kind, 'agent'),
       subject_id   = coalesce(subject_id, agent_id)
 where subject_kind is null or subject_id is null;

update agent_trajectories
   set created_at = coalesce(created_at, started_at),
       updated_at = coalesce(updated_at, started_at)
 where created_at is null or updated_at is null;

alter table agent_trajectories alter column subject_kind set not null;
alter table agent_trajectories alter column subject_id   set not null;

alter table agent_trajectories drop constraint if exists agent_trajectories_subject_kind_check;
alter table agent_trajectories add  constraint agent_trajectories_subject_kind_check
  check (subject_kind in ('agent', 'session'));

-- scope_id widens to text. The code types it `string` and the call sites pass values like
-- 'group-1'; a uuid column rejects those at insert with no compile-time signal.
alter table agent_trajectories alter column scope_id type text using scope_id::text;

-- agent_id is superseded by subject_id. Keeping both would restore the ambiguity D4 removed.
alter table agent_trajectories drop column if exists agent_id;

drop index if exists idx_trajectories_agent_id;
create index if not exists idx_trajectories_subject on agent_trajectories (subject_kind, subject_id);
create index if not exists idx_trajectories_created_at on agent_trajectories (created_at desc);

comment on column agent_trajectories.subject_kind is
  'Whether this trajectory is an agent run or an application session (ADR-029 D4).';
comment on column agent_trajectories.subject_id is
  'The agent id or the session id, per subject_kind. Replaces agent_id.';
comment on column agent_trajectories.version is
  'Optimistic-concurrency counter for step append. addStep is a CAS: UPDATE ... WHERE version = expected.';
comment on column agent_trajectories.scope_id is
  'Scoped entity id. TEXT rather than UUID: the platform types this as a string and does not constrain it to uuid form.';

-- ── 3. agent_budgets — unchanged ────────────────────────────────────────────
--
-- The defects here are semantic, not structural: getCurrentPeriod() returns YYYY-MM while
-- the config field is maxCostPerDay, and usedSteps is compared against a per-trajectory
-- limit while accumulating per agent per month. Both are code fixes (TASK-063), landing
-- with the durable budget store. The columns are already the right ones.

comment on column agent_budgets.period is
  'Budget period. Daily, YYYY-MM-DD, matching BudgetConfig.maxCostPerDay (TASK-063).';
