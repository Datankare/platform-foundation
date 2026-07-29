-- ============================================================================
-- Phase 5, Sprint 2 — Durable agent budgets
-- Migration: 023_agent_budget_consume.sql
--
-- Forward reconciliation, idempotent and re-runnable. The live database has no
-- migration-tracking table (Gotcha 60) and there is no second Supabase project to
-- rehearse against, so a partial failure must leave a re-appliable database.
--
-- Closes TASK-063 at the schema level. Three changes:
--
--   1. scope_id widens to text. Migration 022 did this for agent_trajectories and left
--      agent_budgets alone. The platform types scopeId as a string and passes values like
--      'group-1', which a uuid column rejects at insert with no compile-time signal.
--   2. used_usd / budget_usd widen to NUMERIC(12,6). At four decimal places a per-step cost
--      below a hundredth of a cent truncates to zero, so a cheap-but-frequent agent
--      accumulates nothing against its cap — a spend counter that fails open.
--   3. agent_budget_consume() — atomic upsert-and-return, so concurrent increments cannot
--      be lost. Column arithmetic is not expressible in a PostgREST PATCH, which is why
--      budget persistence needed a migration of its own.
--
-- ADR-029 D8 (budgets), TASK-063
-- ============================================================================

-- ── 1 + 2. Column types ─────────────────────────────────────────────────────
--
-- The unique index coalesces scope_id against a uuid sentinel, so it cannot survive the
-- type change. Dropped first, recreated below against a text sentinel.

drop index if exists idx_budgets_unique;
drop index if exists idx_budgets_scope;

alter table agent_budgets alter column scope_id  type text using scope_id::text;
alter table agent_budgets alter column used_usd  type numeric(12, 6);
alter table agent_budgets alter column budget_usd type numeric(12, 6);

create unique index if not exists idx_budgets_unique
  on agent_budgets (agent_id, scope_type, coalesce(scope_id, ''), period);

create index if not exists idx_budgets_scope on agent_budgets (scope_type, scope_id);

comment on column agent_budgets.scope_id is
  'Scoped entity id. TEXT rather than UUID: the platform types this as a string and does not constrain it to uuid form.';
comment on column agent_budgets.used_usd is
  'Accumulated spend for the period. NUMERIC(12,6) so sub-hundredth-of-a-cent step costs do not truncate to zero.';
comment on column agent_budgets.period is
  'Budget period, YYYY-MM-DD. Daily, matching BudgetConfig.maxCostPerDay (TASK-063).';

-- ── 3. Atomic accumulation ──────────────────────────────────────────────────
--
-- One round trip, atomic in the database. A read-modify-write from application code loses
-- concurrent increments, and a spend counter that loses increments under-reports spend —
-- it fails open, in the direction of overspending.

create or replace function agent_budget_consume(
  p_agent_id    text,
  p_scope_type  trajectory_scope,
  p_scope_id    text,
  p_period      text,
  p_delta_usd   numeric,
  p_delta_steps integer
)
returns table (used_usd numeric, used_steps integer)
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into agent_budgets as b
    (agent_id, scope_type, scope_id, period, used_usd, used_steps)
  values
    (p_agent_id, p_scope_type, p_scope_id, p_period, p_delta_usd, p_delta_steps)
  on conflict (agent_id, scope_type, coalesce(scope_id, ''), period)
  do update
    set used_usd   = b.used_usd + p_delta_usd,
        used_steps = b.used_steps + p_delta_steps,
        updated_at = now()
  returning b.used_usd, b.used_steps
    into used_usd, used_steps;

  return next;
end;
$$;

comment on function agent_budget_consume is
  'Atomic budget accumulation (TASK-063). Returns the totals AFTER the increment. Never read-modify-write a spend counter from application code.';

revoke all on function agent_budget_consume(
  text, trajectory_scope, text, text, numeric, integer
) from public;

grant execute on function agent_budget_consume(
  text, trajectory_scope, text, text, numeric, integer
) to service_role;
