-- ============================================================================
-- Migration: 040_budget_consume_service_only.sql
--
-- agent_budget_consume() is callable by the service role only (TASK-137). Idempotent and
-- re-runnable.
--
-- The function runs as its owner (SECURITY DEFINER), so it bypasses row-level security on
-- agent_budgets. It was executable by `anon` and `authenticated` — the database's default grant —
-- so anyone holding the project's public (anon) key could call it through the REST API: a negative
-- delta resets an agent's daily spend and defeats the governed cost cap (ADR-048); a large positive
-- one exhausts the budget and stops the agents that depend on it, Guardian among them (which then
-- fails closed and refuses all content). The platform only ever calls it with the service role
-- (platform/agents/supabase-budget-store.ts).
--
--   1. Execute is revoked from public, anon and authenticated, and granted to service_role — the
--      pattern of guest_allowance_consume (037) and rate_limit_hit (039).
--   2. The function refuses a negative or non-finite delta, so even a service-role caller cannot
--      lower a recorded spend.
--
-- The migration replay (scripts/migration-replay.sh) now fails on any function that writes and
-- runs as its owner while anon or authenticated can execute it, so the class cannot return.
-- ============================================================================

create or replace function agent_budget_consume(
  p_agent_id text,
  p_scope_type trajectory_scope,
  p_scope_id text,
  p_period text,
  p_delta_usd numeric,
  p_delta_steps integer
)
returns table(used_usd numeric, used_steps integer)
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_delta_usd is null or p_delta_usd < 0 or p_delta_usd = 'NaN'::numeric then
    raise exception 'agent_budget_consume: invalid delta_usd';
  end if;
  if p_delta_steps is null or p_delta_steps < 0 then
    raise exception 'agent_budget_consume: invalid delta_steps';
  end if;

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

comment on function agent_budget_consume(text, trajectory_scope, text, text, numeric, integer) is
  'Atomic budget accumulation (TASK-063). Returns the totals AFTER the increment. Never read-modify-write a spend counter from application code. Service role only; refuses negative deltas (TASK-137).';

revoke all on function agent_budget_consume(text, trajectory_scope, text, text, numeric, integer)
  from public, anon, authenticated;
grant execute on function agent_budget_consume(text, trajectory_scope, text, text, numeric, integer)
  to service_role;

insert into applied_migrations (filename, confidence, note)
values (
  '040_budget_consume_service_only.sql',
  'verified',
  'TASK-137: agent_budget_consume() executable by service_role only (was anon/authenticated, SECURITY DEFINER); refuses negative deltas.'
)
on conflict (filename) do nothing;
