-- ============================================================================
-- Phase 5, Sprint 2 — Effect ledger + indeterminate status
-- Migration: 028_effect_ledger.sql
--
-- ADR-029 D10 / ADR-031 D7.
--
-- `indeterminate` is a real terminal state for an external effect: the downstream neither
-- confirmed nor denied. Collapsing it into success or failure is an at-most-once or
-- at-least-once violation depending on which way the guess falls, and the guess leaves no
-- trace. It gets a status value and a durable ledger rather than a log line.
--
-- trajectory_status is an ENUM, so widening is ALTER TYPE ADD VALUE. That is irreversible:
-- Postgres has no DROP VALUE. IF NOT EXISTS makes re-running safe.
--
-- Idempotent and re-runnable.
-- ============================================================================

alter type trajectory_status add value if not exists 'indeterminate';

comment on type trajectory_status is
  'Trajectory lifecycle. `indeterminate` means an external effect neither confirmed nor denied and MUST NOT be reported as completed (ADR-029 D10).';

-- ── Effect ledger (ADR-031 D7) ──────────────────────────────────────────────
--
-- Written BEFORE the downstream call and resolved after. A retry that finds an unresolved
-- entry does not re-fire: it reconciles where the downstream can be queried, and otherwise
-- surfaces the operation as indeterminate for human resolution.
--
-- The unique key is (operation_id, effect_key): one logical action may fire several
-- distinct external effects, but each at most once (ADR-031 invariant 2).

create table if not exists effect_ledger (
  id             uuid        primary key default gen_random_uuid(),
  operation_id   text        not null,
  effect_key     text        not null,
  effect_type    text        not null,
  status         text        not null default 'pending',
  idempotency_key text       not null,
  request        jsonb       not null default '{}'::jsonb,
  receipt        jsonb,
  error          text,
  attempts       integer     not null default 1,
  created_at     timestamptz not null default now(),
  resolved_at    timestamptz,
  constraint effect_ledger_status_check
    check (status in ('pending', 'confirmed', 'failed', 'indeterminate')),
  constraint effect_ledger_type_check
    check (effect_type in ('externalCall', 'sendMessage'))
);

create unique index if not exists idx_effect_ledger_operation
  on effect_ledger (operation_id, effect_key);

create index if not exists idx_effect_ledger_unresolved
  on effect_ledger (status, created_at)
  where status in ('pending', 'indeterminate');

comment on table effect_ledger is
  'Durable record of external effects (ADR-031 D7). Written before the call, resolved after. An unresolved entry on retry does not re-fire.';
comment on column effect_ledger.idempotency_key is
  'Derived from operationId. Supplied to downstreams that accept one; the ledger exists for those that do not.';
comment on column effect_ledger.status is
  'pending = written, call outcome unknown. indeterminate = the downstream neither confirmed nor denied; needs human resolution and MUST NOT be collapsed.';

alter table effect_ledger enable row level security;

drop policy if exists effect_ledger_service_all on effect_ledger;
create policy effect_ledger_service_all on effect_ledger
  for all using (auth.role() = 'service_role');

-- ── Self-record (migration 025 convention) ──────────────────────────────────

insert into applied_migrations (filename, confidence, note)
values (
  '028_effect_ledger.sql',
  'verified',
  'Effect ledger + indeterminate trajectory status. Self-recorded on application.'
)
on conflict (filename) do update
  set confidence = 'verified',
      recorded_at = now();
