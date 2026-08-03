-- ============================================================================
-- Phase 5, Sprint 2 — agent_budgets.used_steps
-- Migration: 024_agent_budget_used_steps.sql
--
-- Forward fix for migration 023, which referenced agent_budgets.used_steps. That column
-- does not exist: the table has used_tokens, from migration 016, and nothing has ever
-- written it. The function created successfully and failed at call time.
--
-- Applied history is not edited (021 precedent). Idempotent and re-runnable.
-- ============================================================================

alter table agent_budgets add column if not exists used_steps integer not null default 0;

comment on column agent_budgets.used_steps is
  'Steps consumed in the period. Observability only (P12) — the per-trajectory step limit is enforced by runtime.ts, not by budget. Distinct from used_tokens, which 016 created and nothing writes (TASK-067).';

-- Recreate the function now that its target column exists. Body unchanged from 023.

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
