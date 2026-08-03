-- ============================================================================
-- Phase 5, Sprint 2 — Proposals (ADR-031 D2/D3/D8)
-- Migration: 027_proposals.sql
--
-- A gated action is HELD, not refused: recorded, an approval requested, the trajectory
-- paused. ADR-031 D2 makes `proposed` a durable stage carrying a proposalId, with
-- `rejected` and `superseded` as terminal states that produce a trajectory and never a
-- stateVersion. D8: the reasoning behind a rejected proposal is as auditable as the
-- reasoning behind a committed one — a protocol that discards rejected proposals cannot
-- answer why an action did NOT happen, which is the question audits usually ask.
--
-- Idempotent and re-runnable. Applied by hand; verify with the introspection query.
-- ============================================================================

create table if not exists proposals (
  id              uuid        primary key default gen_random_uuid(),
  operation_id    text        not null,
  session_id      text        not null,
  trajectory_id   text        not null,
  label           text        not null,
  status          text        not null default 'proposed',
  actor_id        text        not null,
  actor_role      text        not null,
  effects         jsonb       not null default '[]'::jsonb,
  effective_risk  text        not null,
  payload         jsonb       not null default '{}'::jsonb,
  observed_version integer,
  decided_by      text,
  decided_at      timestamptz,
  decision_note   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint proposals_status_check
    check (status in ('proposed', 'approved', 'rejected', 'superseded'))
);

-- One operationId may carry MANY proposalIds (ADR-031 D3: a revision mints a new proposal
-- under the same operation and supersedes the prior one). At most one may be live.
create unique index if not exists idx_proposals_live
  on proposals (operation_id)
  where status = 'proposed';

create index if not exists idx_proposals_operation on proposals (operation_id);
create index if not exists idx_proposals_trajectory on proposals (trajectory_id);
create index if not exists idx_proposals_status on proposals (status, created_at desc);

comment on table proposals is
  'Held gated actions (ADR-031 D2). A rejected or superseded proposal keeps its trajectory and never acquires a stateVersion (D8).';
comment on column proposals.operation_id is
  'The logical action. One operationId may have many proposals but at most one live (D3).';
comment on column proposals.observed_version is
  'State version when the proposal was created. Commit compares against it for stale-approval reconciliation (D5).';

alter table proposals enable row level security;

drop policy if exists proposals_service_all on proposals;
create policy proposals_service_all on proposals
  for all using (auth.role() = 'service_role');

-- ── Self-record (migration 025 convention) ──────────────────────────────────

insert into applied_migrations (filename, confidence, note)
values (
  '027_proposals.sql',
  'verified',
  'Proposals table for ADR-031 D2 gating. Self-recorded on application.'
)
on conflict (filename) do update
  set confidence = 'verified',
      recorded_at = now();
