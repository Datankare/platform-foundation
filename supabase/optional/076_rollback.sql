-- supabase/optional/076_rollback.sql — undo 076 when its release cannot be deployed (design 56e-3b
-- §5, the stated action when the push is delayed or CI fails). ONE statement. The steps' rows go
-- back into agent_trajectories.steps in their order (nothing lost; a segment whose stored steps
-- were not an array — none is written — comes back as a one-element array: review TA-b-7), the
-- steps table, its triggers and their three functions, the counters, continued and 076's readiness
-- function are dropped,
-- 052's chain guard comes back, the bound is remade and read on
-- agent_trajectories only (review TA-b-5), the purges the old build deferred while 076 stood are
-- made due again with that one attempt not counted (review TA-b-6, TB-b-4: only an attempt made
-- after 076 was recorded; an attempt deferred for any other reason before it keeps its count),
-- and 076's record is removed — then the build before it works again; deploy it.
-- Not part of the replay (supabase/optional). Pasted when 076 is not applied, it changes nothing.
-- Locks: ACCESS EXCLUSIVE on both trajectory tables through 074's json_bound_lock (never aborting
-- an application transaction; 30 s at most).
do $r076$
declare
  busy int;
  applied_at timestamptz;
begin
  perform set_config('search_path', 'pg_catalog, pg_temp', true);
  if pg_catalog.to_regclass('public.agent_trajectory_steps') is null then
    return;
  end if;
  if not (select ro.rolsuper or ro.rolbypassrls from pg_catalog.pg_roles ro where ro.rolname = current_user) then
    raise exception '076 rollback: % cannot see every row; run it as postgres', current_user;
  end if;
  perform set_config('row_security', 'off', true);
  busy := public.json_bound_lock(array['public.agent_trajectories'::pg_catalog.regclass,
                                       'public.agent_trajectory_steps'::pg_catalog.regclass], 'ACCESS EXCLUSIVE');
  -- When 076 was applied: the window in which the old build's purges failed on the missing column.
  applied_at := (select a.recorded_at from public.applied_migrations a where a.filename = '076_trajectory_steps_as_rows.sql');

  -- 052's chain guard first: it reads steps again, so the column comes back before any update.
  alter table public.agent_trajectories add column steps jsonb not null default '[]'::jsonb;
  CREATE OR REPLACE FUNCTION public.agent_trajectories_chain_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $f$
declare
  prev record;
begin
  if tg_op = 'UPDATE' then
    if new.segment is distinct from old.segment
       or new.previous_trajectory_id is distinct from old.previous_trajectory_id
       or new.step_offset is distinct from old.step_offset
       or new.chain_root_id is distinct from old.chain_root_id
       or new.tenant_id is distinct from old.tenant_id then
      raise exception 'agent_trajectories: a trajectory''s chain never changes after it is created'
        using errcode = 'check_violation';
    end if;
    -- A segment that has been continued keeps its step count (its continuation's step_offset
    -- counts them): no step added, none removed (review 13 L3 — a shrink misnumbered the chain as
    -- surely as a growth); an erasure's same-length rewrite of its steps is allowed.
    if (case when jsonb_typeof(new.steps) = 'array' then jsonb_array_length(new.steps) else 0 end)
       <> (case when jsonb_typeof(old.steps) = 'array' then jsonb_array_length(old.steps) else 0 end)
       and exists (select 1 from public.agent_trajectories c
                    where c.tenant_id = new.tenant_id and c.previous_trajectory_id = new.id) then
      raise exception 'agent_trajectories: a continued segment keeps its step count; steps go to the chain''s last segment'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if new.previous_trajectory_id is null then
    new.chain_root_id := new.id;
    return new;
  end if;
  -- Read under the writer's own row-level security: another tenant's row is not found. Locked
  -- (review 13 L3): a concurrent update of the predecessor's steps waits for this insert to
  -- commit (and is then refused: the segment has a continuation), and an update already in
  -- progress is waited for — its new step count is the one checked below. Without the lock an
  -- update growing the predecessor while its continuation was being inserted left the chain
  -- misnumbered.
  select p.id, p.tenant_id, p.segment, p.chain_root_id, p.step_offset,
         case when jsonb_typeof(p.steps) = 'array' then jsonb_array_length(p.steps) else 0 end as n
    into prev
    from public.agent_trajectories p where p.id = new.previous_trajectory_id
     for update;
  if not found or prev.tenant_id is distinct from new.tenant_id then
    raise exception 'agent_trajectories: a continuation''s predecessor must exist in its tenant'
      using errcode = 'check_violation';
  end if;
  if new.segment <> prev.segment + 1 then
    raise exception 'agent_trajectories: a continuation is its predecessor''s segment + 1'
      using errcode = 'check_violation';
  end if;
  if new.chain_root_id is not null and new.chain_root_id is distinct from prev.chain_root_id then
    raise exception 'agent_trajectories: a continuation belongs to its predecessor''s chain'
      using errcode = 'check_violation';
  end if;
  if new.step_offset <> prev.step_offset + prev.n then
    raise exception 'agent_trajectories: a continuation''s step_offset is the steps before it'
      using errcode = 'check_violation';
  end if;
  new.chain_root_id := prev.chain_root_id;
  return new;
end;
$f$;
  alter table public.agent_trajectories disable trigger agent_trajectories_chain_guard;
  update public.agent_trajectories t
     set steps = coalesce((select jsonb_agg(s.step order by s.seq) from public.agent_trajectory_steps s
                            where s.tenant_id = t.tenant_id and s.trajectory_id = t.id), '[]'::jsonb)
   where t.step_count > 0;
  alter table public.agent_trajectories enable trigger agent_trajectories_chain_guard;
  drop table public.agent_trajectory_steps;
  update public.deletion_manifest
     set table_names = array_remove(table_names, 'agent_trajectory_steps')
   where module_name = 'platform';
  drop function public.agent_trajectory_steps_guard();
  drop function public.agent_trajectory_steps_appended();
  drop function public.agent_trajectory_steps_rewritten();
  drop function if exists public.trajectory_steps_missing();
  alter table public.agent_trajectories drop column step_count, drop column steps_bytes, drop column continued;

  -- 074's json_bound_limit was never replaced by 076: its exception for agent_trajectories.steps
  -- (depth only) holds again for the column put back.
  perform public.json_bound_install(array['public.agent_trajectories'::pg_catalog.regclass]);
  perform public.json_bound_check('public.agent_trajectories'::pg_catalog.regclass);
  -- The purges whose last attempt failed after 076 was recorded (the old build cannot erase without
  -- the steps column): due now, that one attempt not counted. The attempt's time is the retry time
  -- less its back-off (gdpr-deletion.ts deferPurge: 1 h doubling, at most 7 days). Run within the
  -- hour (design 56e-3b §5), a window holds at most one attempt per account.
  if applied_at is not null then
    update public.user_deletions d
       set purge_attempts = greatest(d.purge_attempts - 1, 0),
           purge_retry_at = null,
           last_purge_error = case when d.purge_attempts <= 1 then null else d.last_purge_error end
     where d.purged_at is null and d.purge_retry_at is not null and d.purge_attempts > 0
       and d.purge_retry_at - least(interval '7 days', interval '1 hour' * power(2, least(d.purge_attempts - 1, 8))) >= applied_at;
  end if;
  delete from public.applied_migrations where filename = '076_trajectory_steps_as_rows.sql';
end
$r076$;
