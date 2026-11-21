-- 076_trajectory_steps_as_rows.sql — a trajectory's steps become rows of agent_trajectory_steps;
-- the steps already stored are converted, never cleared (platform TASK-230, design 56e-3b)
--
-- ONE statement (a DO block): whole or nothing in every client. It does its work only while
-- agent_trajectories.steps exists; pasted again — or after the release — it finds every object as
-- it makes it and returns before taking any lock or changing anything (reviews SA-7, SB-2,
-- TB-b-1); after migration 077 it is refused by 064's order guard.
--
-- 1. agent_trajectory_steps (tenant_id, trajectory_id, seq, step): seq is the step's place in its
--    segment from 0; the key (tenant_id, trajectory_id, seq); the foreign key (tenant_id,
--    trajectory_id) to agent_trajectories (tenant_id, id), on delete cascade — a step never
--    attaches to another tenant's trajectory, whoever writes (review SA-8). Row-level security
--    forced, the tenant policy of 049; app_tenant may read, insert, and update the step column only
--    (no delete: steps go with their trajectory); nothing for anon, authenticated, service_role.
-- 2. agent_trajectories gains step_count and steps_bytes (the steps' text as printed — the one
--    size measure, docs/JSON_BOUND.md §1), kept by the steps' own trigger, and continued (true once
--    the segment has a continuation; set by the chain guard in the continuation's own statement).
--    An append locks the trajectory's row and reads continued and the counters from that locked
--    row, so an append that waited for a continuation sees it (review TA-b-1); it is refused past
--    1 000 steps or 16 MiB of text, out of order, or into a continued segment. A rewrite of a step
--    (the erasure) is allowed only with the trajectory already locked by the writer — erasure
--    statements lock their trajectories first, in key order, so two of them never deadlock on one
--    trajectory (review TA-b-3); a writer that did not and finds it busy gets lock_not_available
--    at once instead of waiting (checked for each row before it is written). What a statement's
--    rows add or change is counted once per statement: two statement triggers with transition
--    tables sum it per trajectory and update each trajectory once — step_count, steps_bytes and
--    version — so a 1 000-step append or rewrite is one update of its trajectory, not 1 000 (R2:
--    the per-row update made a shared session's erasure about 5x slower, hang report §2); the
--    segment is refused there past 16 MiB of text by appends, 128 MiB by rewrites (the most any
--    erasure can grow a full one is 6x: review TA-b-2).
--    A step never moves; it is deleted only with its trajectory.
-- 3. The steps already stored become rows: one INSERT … SELECT over jsonb_array_elements, in their
--    order. Then the counters and continued, then the column is dropped. A steps value that is not
--    an array (none is written; the old store kept only arrays) becomes one row holding it, so
--    nothing is lost. Every converted step is then read against 074's bound (json_bound_check):
--    a step over it stops this statement, naming trajectory and place, and nothing is changed.
-- 4. The chain guard keeps its rules, now on the counters: a continuation's step_offset is its
--    predecessor's step_offset + step_count; step_count, steps_bytes and continued change only
--    through the triggers.
-- 5. 074's bound: the new table's triggers made, agent_trajectories' remade without steps — those
--    two tables only (an emergency off of the bound on another table is left as it is: review
--    TA-b-5) — both read. public.trajectory_steps_missing(): readiness for what this makes.
--    Recorded last.
--
-- Locks: ACCESS EXCLUSIVE on agent_trajectories and (when it exists) agent_trajectory_steps for the
-- whole statement, through 074's public.json_bound_lock — each attempt gives up within half of
-- deadlock_timeout, never aborting an application's transaction, for at most 30 s. Every reader
-- and writer of trajectories waits while it converts (measured 18-40 MB of step text per second:
-- design 56e-3b §2.3). Run it with the release build ready to push straight after (design 56e-3b
-- §5): from this statement until the push, the build before it cannot touch a trajectory step.
do $m076$
declare
  converting boolean;
  busy int;
  r record;
  fp text;
  in_force boolean;
begin
  perform set_config('search_path', 'pg_catalog, pg_temp', true);
  -- First: a role that cannot see every row would read applied_migrations (forced row-level
  -- security, no policy) as empty and be told 074 and 075 are missing (confirmation C-3).
  if not (select ro.rolsuper or ro.rolbypassrls from pg_catalog.pg_roles ro where ro.rolname = current_user) then
    raise exception '076: % cannot see every row (row-level security); run it as the tables'' owner with BYPASSRLS, as postgres on Supabase', current_user;
  end if;
  if pg_catalog.to_regprocedure('public.json_bound_lock(regclass[],text)') is null
     or not exists (select 1 from public.applied_migrations where filename = '075_json_bound_existing_rows.sql') then
    raise exception '076: migrations 074 and 075 are not both applied; apply them first';
  end if;

  converting := exists (select 1 from pg_catalog.pg_attribute
                         where attrelid = 'public.agent_trajectories'::pg_catalog.regclass
                           and attname = 'steps' and not attisdropped);
  -- Pasted again after it applied: every object is as this statement makes it — return before any
  -- lock or change (a re-paste while the new build appends steps cannot deadlock: review TB-b-1).
  if not converting
     and exists (select 1 from public.applied_migrations where filename = '076_trajectory_steps_as_rows.sql')
     and pg_catalog.to_regprocedure('public.trajectory_steps_missing()') is not null then
    execute 'select not exists (select 1 from public.trajectory_steps_missing())' into in_force;
    if in_force then
      return;
    end if;
  end if;
  perform set_config('row_security', 'off', true);

  -- Both tables' locks first, yielding to any application transaction (reviews B-2, TB-b-1).
  busy := public.json_bound_lock(
    case when pg_catalog.to_regclass('public.agent_trajectory_steps') is null
         then array['public.agent_trajectories'::pg_catalog.regclass]
         else array['public.agent_trajectories'::pg_catalog.regclass, pg_catalog.to_regclass('public.agent_trajectory_steps')] end,
    'ACCESS EXCLUSIVE');

  -- ── 1. The table ─────────────────────────────────────────────────────────────────────────────
  create table if not exists public.agent_trajectory_steps (
    tenant_id uuid not null default public.app_current_tenant(),
    trajectory_id uuid not null,
    seq integer not null check (seq >= 0),
    step jsonb not null,
    created_at timestamptz not null default now(),
    primary key (tenant_id, trajectory_id, seq),
    foreign key (tenant_id, trajectory_id) references public.agent_trajectories (tenant_id, id) on delete cascade
  );
  comment on table public.agent_trajectory_steps is
    'TASK-230 (design 56e-3b): one row per step of an agent trajectory (a segment), seq from 0 in its order. Appended only through the trigger zy_agent_trajectory_steps_guard (in order, under the trajectory''s row lock, within 1 000 steps and 16 MiB of text, never into a continued segment); rewritten only with the trajectory locked first, within 128 MiB; counted once per statement (agent_trajectory_steps_appended, agent_trajectory_steps_rewritten); deleted only with the trajectory.';
  alter table public.agent_trajectory_steps enable row level security;
  alter table public.agent_trajectory_steps force row level security;
  drop policy if exists tenant_isolation on public.agent_trajectory_steps;
  create policy tenant_isolation on public.agent_trajectory_steps for all to app_tenant
    using (tenant_id = public.app_current_tenant()) with check (tenant_id = public.app_current_tenant());
  revoke all on public.agent_trajectory_steps from public;
  for r in select x.role from (values ('anon'), ('authenticated'), ('service_role')) x(role)
            where pg_catalog.to_regrole(x.role) is not null loop
    execute format('revoke all on public.agent_trajectory_steps from %I', r.role);
  end loop;
  if pg_catalog.to_regrole('app_tenant') is not null then
    revoke all on public.agent_trajectory_steps from app_tenant;
    grant select, insert on public.agent_trajectory_steps to app_tenant;
    grant update (step) on public.agent_trajectory_steps to app_tenant;
  end if;

  -- The platform's deletion manifest names every table its erasure covers (052, 070): a step is
  -- rewritten by the erasure (platform/auth/user-data.ts) and deleted with its trajectory.
  update public.deletion_manifest
     set table_names = array_append(table_names, 'agent_trajectory_steps')
   where module_name = 'platform'
     and not ('agent_trajectory_steps' = any (table_names));

  alter table public.agent_trajectories add column if not exists step_count integer not null default 0;
  alter table public.agent_trajectories add column if not exists steps_bytes bigint not null default 0;
  alter table public.agent_trajectories add column if not exists continued boolean not null default false;
  comment on column public.agent_trajectories.step_count is
    'TASK-230: how many steps this segment holds (rows of agent_trajectory_steps); kept by their triggers only.';
  comment on column public.agent_trajectories.steps_bytes is
    'TASK-230: the octet length of the steps'' text as printed, summed; kept by their triggers only.';
  comment on column public.agent_trajectories.continued is
    'TASK-230: true once this segment has a continuation (set by the chain guard in the continuation''s statement); an append to it is refused.';

  -- ── 2. The steps' rules ──────────────────────────────────────────────────────────────────────
  create or replace function public.agent_trajectory_steps_guard()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $f$
  declare
    parent record;
  begin
    -- One row's rules, checked before the row is written. What a statement's rows add or change
    -- is counted once per trajectory by the statement triggers below (agent_trajectory_steps_
    -- appended, agent_trajectory_steps_rewritten): this function never updates a trajectory.
    if tg_op = 'INSERT' then
      -- The trajectory's row, locked, and continued and the counters read FROM that row: when this
      -- waited for a continuation, the lock returns the row as the continuation left it
      -- (continued = true; review TA-b-1 — a separate look for a continuation used the snapshot
      -- taken before the wait and missed it). Appends to one segment happen one after another.
      select t.step_count, t.continued
        into parent
        from public.agent_trajectories t
       where t.tenant_id = new.tenant_id and t.id = new.trajectory_id
         for update;
      if not found then
        raise exception 'agent_trajectory_steps: the trajectory % does not exist in this tenant', new.trajectory_id
          using errcode = 'foreign_key_violation';
      end if;
      if parent.continued then
        raise exception 'agent_trajectory_steps: a continued segment keeps its steps; steps go to the chain''s last segment'
          using errcode = 'check_violation', constraint = 'trajectory_continued';
      end if;
      -- The next place: step_count, the counter as the last statement left it — or, for a later
      -- row of a statement appending several, the place right after the row this statement put
      -- before it (rows at or past step_count exist only as this statement's own, under this
      -- lock, and this trigger sees the rows its statement wrote before this one). Never a gap,
      -- never a place taken.
      if new.seq is distinct from parent.step_count
         and not (new.seq > parent.step_count
                  and exists (select 1 from public.agent_trajectory_steps s
                               where s.tenant_id = new.tenant_id and s.trajectory_id = new.trajectory_id and s.seq = new.seq - 1)
                  and not exists (select 1 from public.agent_trajectory_steps s
                                   where s.tenant_id = new.tenant_id and s.trajectory_id = new.trajectory_id and s.seq = new.seq)) then
        raise exception 'agent_trajectory_steps: step % appended where step % is next', new.seq,
          parent.step_count + (select count(*) from public.agent_trajectory_steps s
                                where s.tenant_id = new.tenant_id and s.trajectory_id = new.trajectory_id and s.seq >= parent.step_count)
          using errcode = 'check_violation', constraint = 'trajectory_step_order';
      end if;
      -- In order from 0, the place is the count: step 1 000 would be the 1 001st. The 16 MiB of
      -- text is the statement's check (agent_trajectory_steps_appended), on the segment's total.
      if new.seq + 1 > 1000 then
        raise exception 'agent_trajectory_steps: the segment holds the most it may (1 000 steps, 16 MiB of text)'
          using errcode = 'check_violation', constraint = 'trajectory_full';
      end if;
      return new;
    elsif tg_op = 'UPDATE' then
      if new.tenant_id is distinct from old.tenant_id or new.trajectory_id is distinct from old.trajectory_id
         or new.seq is distinct from old.seq then
        raise exception 'agent_trajectory_steps: a step never moves (its tenant, trajectory and place stay)'
          using errcode = 'check_violation', constraint = 'trajectory_step_fixed';
      end if;
      if new.step is distinct from old.step then
        -- The trajectory must already be this transaction's (erasure statements lock their
        -- trajectories first, in key order: review TA-b-3) or free; this never waits for it, so no
        -- two rewrites of one trajectory can deadlock. Its counters and version move once, at the
        -- end of the statement (agent_trajectory_steps_rewritten), with the 128 MiB bound.
        perform 1
           from public.agent_trajectories t
          where t.tenant_id = new.tenant_id and t.id = new.trajectory_id
            for update skip locked;
        if not found then
          raise exception 'agent_trajectory_steps: trajectory % is held by another transaction; a step is rewritten only with its trajectory locked first (select … from agent_trajectories … order by tenant_id, id for update)', new.trajectory_id
            using errcode = 'lock_not_available', hint = 'docs/runbooks/approvals-and-agents.md, "A step rewrite found its trajectory busy"';
        end if;
      end if;
      return new;
    else
      -- DELETE, run outside any trigger (the foreign key's cascade runs inside the trajectory's
      -- delete and skips this by the trigger's WHEN): refused while the trajectory exists — but
      -- for a deleted tenant: 049's tenant_purge deletes a tenant's tables leaves first, the steps
      -- before their trajectories (confirmation CB3-1).
      if exists (select 1 from public.agent_trajectories t
                  where t.tenant_id = old.tenant_id and t.id = old.trajectory_id)
         and not exists (select 1 from public.tenants n where n.id = old.tenant_id and n.status = 'deleted') then
        raise exception 'agent_trajectory_steps: a step is deleted only with its trajectory'
          using errcode = 'check_violation', constraint = 'trajectory_step_kept';
      end if;
      return old;
    end if;
  end
  $f$;

  -- A statement's appends, counted once (R2; hang report §2). The row trigger above has checked
  -- every row (its trajectory locked by this transaction, not continued, each row at the next
  -- place, within 1 000 steps: in order from 0, the place is the count); this counts the
  -- statement's rows per trajectory from the transition table and updates each trajectory once —
  -- step_count, steps_bytes (the rows' text as printed) and version (readers compare it, review
  -- SA-6; updated_at is the writer's to set: the reaper leaves it as it was). A segment past
  -- 16 MiB of text refuses the whole statement. It reads only the statement's own rows.
  create or replace function public.agent_trajectory_steps_appended()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $f$
  declare
    over int;
  begin
    with added as (
      select a.tenant_id, a.trajectory_id, count(*)::int as n, sum(octet_length(a.step::text))::bigint as bytes
        from appended_new a
       group by a.tenant_id, a.trajectory_id
    ), moved as (
      update public.agent_trajectories t
         set step_count = t.step_count + d.n, steps_bytes = t.steps_bytes + d.bytes, version = t.version + 1
        from added d
       where t.tenant_id = d.tenant_id and t.id = d.trajectory_id
      returning t.steps_bytes
    )
    select count(*) into over from moved where moved.steps_bytes > 16777216;
    if over > 0 then
      raise exception 'agent_trajectory_steps: the segment holds the most it may (1 000 steps, 16 MiB of text)'
        using errcode = 'check_violation', constraint = 'trajectory_full';
    end if;
    return null;
  end
  $f$;

  -- A statement's rewrites, counted once (R2; hang report §2). The row trigger above has checked
  -- every rewritten row (its place unchanged, its trajectory locked by this transaction); this
  -- sums the statement's change per trajectory from the transition tables and updates each
  -- trajectory once: steps_bytes and version. A segment past 128 MiB of text refuses the whole
  -- statement (review TA-b-2). A row's old and new versions are paired by grouping both tables on
  -- the row's key (which never changes), not by a join: the transition tables have no statistics
  -- (under app_tenant's row-level security the planner expects one row), and a join planned as a
  -- nested loop compared every old step with every new one — 1 000 x 1 000 for a full segment
  -- (measured 3 s); grouping costs one sort or hash of the rows, whatever the plan.
  create or replace function public.agent_trajectory_steps_rewritten()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $f$
  declare
    over int;
  begin
    with sides as (
      select n.tenant_id, n.trajectory_id, n.seq, n.step, octet_length(n.step::text)::bigint as bytes
        from rewritten_new n
      union all
      select o.tenant_id, o.trajectory_id, o.seq, o.step, -octet_length(o.step::text)::bigint
        from rewritten_old o
    ), per_step as (
      -- One group per rewritten row: its new and its old version; changed when they differ.
      select x.tenant_id, x.trajectory_id, sum(x.bytes) as delta, count(distinct x.step) > 1 as changed
        from sides x
       group by x.tenant_id, x.trajectory_id, x.seq
    ), changed as (
      select p.tenant_id, p.trajectory_id, sum(p.delta) as delta
        from per_step p
       where p.changed
       group by p.tenant_id, p.trajectory_id
    ), moved as (
      update public.agent_trajectories t
         set steps_bytes = t.steps_bytes + c.delta, version = t.version + 1
        from changed c
       where t.tenant_id = c.tenant_id and t.id = c.trajectory_id
      returning t.steps_bytes
    )
    select count(*) into over from moved where moved.steps_bytes > 134217728;
    if over > 0 then
      raise exception 'agent_trajectory_steps: a rewrite would take the segment past 128 MiB of text'
        using errcode = 'check_violation', constraint = 'trajectory_full';
    end if;
    return null;
  end
  $f$;

  -- The chain guard of 052, with its step rules on the counters (the steps column is gone), and the
  -- continuation marking its predecessor continued in its own statement (review TA-b-1).
  create or replace function public.agent_trajectories_chain_guard()
  returns trigger
  language plpgsql
  set search_path = public, pg_temp
  as $f$
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
      -- The counters are the steps' (TASK-230): only the steps' trigger moves them; continued is
      -- set only by this guard, for a continuation, and never cleared.
      if (new.step_count is distinct from old.step_count or new.steps_bytes is distinct from old.steps_bytes)
         and pg_catalog.pg_trigger_depth() < 2 then
        raise exception 'agent_trajectories: step_count and steps_bytes are kept by the steps'' own trigger'
          using errcode = 'check_violation';
      end if;
      if new.continued is distinct from old.continued and (old.continued or pg_catalog.pg_trigger_depth() < 2) then
        raise exception 'agent_trajectories: continued is set by the continuation''s insert and never cleared'
          using errcode = 'check_violation';
      end if;
      return new;
    end if;
    if new.step_count <> 0 or new.steps_bytes <> 0 or new.continued then
      raise exception 'agent_trajectories: a trajectory starts with no steps and no continuation; steps are rows of agent_trajectory_steps'
        using errcode = 'check_violation';
    end if;
    if new.previous_trajectory_id is null then
      new.chain_root_id := new.id;
      return new;
    end if;
    -- Read under the writer's own row-level security, locked (review 13 L3): an append to the
    -- predecessor (whose steps' trigger locks it too) and this continuation happen one after the
    -- other, and the step count checked below is the final one.
    select p.id, p.tenant_id, p.segment, p.chain_root_id, p.step_offset, p.step_count as n
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
    -- A new version of the predecessor's row: an append waiting for its lock reads continued = true
    -- (READ COMMITTED), or fails to serialize (REPEATABLE READ, SERIALIZABLE) — never appends.
    update public.agent_trajectories set continued = true
     where tenant_id = prev.tenant_id and id = prev.id;
    new.chain_root_id := prev.chain_root_id;
    return new;
  end;
  $f$;

  -- ── 3. The conversion (only while the column exists) ─────────────────────────────────────────
  if converting then
    execute $c$
      insert into public.agent_trajectory_steps (tenant_id, trajectory_id, seq, step)
      select t.tenant_id, t.id, e.n - 1, e.step
        from public.agent_trajectories t
        cross join lateral (
          select s.step, s.n from jsonb_array_elements(t.steps) with ordinality s(step, n)
           where jsonb_typeof(t.steps) = 'array'
          union all
          select t.steps, 1 where jsonb_typeof(t.steps) <> 'array'
        ) e
    $c$;
    -- The counters and continued, once, from the rows themselves (the steps' trigger does not exist
    -- yet — it is created below); the chain guard is held off for this one statement, inside this
    -- migration's lock.
    alter table public.agent_trajectories disable trigger agent_trajectories_chain_guard;
    update public.agent_trajectories t
       set step_count = coalesce(c.n, 0), steps_bytes = coalesce(c.b, 0),
           continued = exists (select 1 from public.agent_trajectories x
                                where x.tenant_id = t.tenant_id and x.previous_trajectory_id = t.id)
      from (select s.tenant_id, s.trajectory_id, count(*)::int as n, sum(octet_length(s.step::text))::bigint as b
              from public.agent_trajectory_steps s group by 1, 2) c
     where c.tenant_id = t.tenant_id and c.trajectory_id = t.id;
    update public.agent_trajectories t set continued = true
     where not t.continued and exists (select 1 from public.agent_trajectories x
                                        where x.tenant_id = t.tenant_id and x.previous_trajectory_id = t.id);
    alter table public.agent_trajectories enable trigger agent_trajectories_chain_guard;
    -- The bound's triggers on agent_trajectories name steps: dropped before the column, remade after.
    drop trigger if exists zz_json_bound_ins on public.agent_trajectories;
    drop trigger if exists zz_json_bound_upd on public.agent_trajectories;
    alter table public.agent_trajectories drop column steps;
  end if;

  -- The guard is named to fire after every other BEFORE trigger of the table but the bound's
  -- (zz_…): what it measures is what is stored (review TA-b-7); readiness names any trigger placed
  -- after it.
  drop trigger if exists agent_trajectory_steps_guard on public.agent_trajectory_steps;
  drop trigger if exists zy_agent_trajectory_steps_guard on public.agent_trajectory_steps;
  create trigger zy_agent_trajectory_steps_guard
    before insert or update on public.agent_trajectory_steps
    for each row execute function public.agent_trajectory_steps_guard();
  alter table public.agent_trajectory_steps enable always trigger zy_agent_trajectory_steps_guard;
  -- A statement's appends and rewrites counted once per trajectory (above), whoever writes (ALWAYS).
  drop trigger if exists agent_trajectory_steps_appended on public.agent_trajectory_steps;
  create trigger agent_trajectory_steps_appended
    after insert on public.agent_trajectory_steps
    referencing new table as appended_new
    for each statement execute function public.agent_trajectory_steps_appended();
  alter table public.agent_trajectory_steps enable always trigger agent_trajectory_steps_appended;
  drop trigger if exists agent_trajectory_steps_rewritten on public.agent_trajectory_steps;
  create trigger agent_trajectory_steps_rewritten
    after update on public.agent_trajectory_steps
    referencing old table as rewritten_old new table as rewritten_new
    for each statement execute function public.agent_trajectory_steps_rewritten();
  alter table public.agent_trajectory_steps enable always trigger agent_trajectory_steps_rewritten;
  -- A delete outside any trigger only: the cascade from a trajectory's delete (inside its foreign
  -- key's trigger) costs nothing per step (measured: design 56e-3b §2.6).
  drop trigger if exists agent_trajectory_steps_kept on public.agent_trajectory_steps;
  create trigger agent_trajectory_steps_kept
    before delete on public.agent_trajectory_steps
    for each row when (pg_trigger_depth() < 1) execute function public.agent_trajectory_steps_guard();
  alter table public.agent_trajectory_steps enable always trigger agent_trajectory_steps_kept;

  -- 074's per-column limit is left as 074 made it: its one exception (agent_trajectories.steps,
  -- depth only) names a column that no longer exists, so every remaining jsonb column — a step
  -- row's included — gets the whole bound (8 MiB of text, numbers, 128 levels: docs/JSON_BOUND.md).
  -- Replacing it would make 074's readiness name it (json_bound_missing fingerprints it, code
  -- review A-6), and the rollback needs the exception again.

  revoke all on function public.agent_trajectory_steps_guard() from public;
  revoke all on function public.agent_trajectory_steps_appended() from public;
  revoke all on function public.agent_trajectory_steps_rewritten() from public;
  for r in select x.role from (values ('anon'), ('authenticated'), ('service_role')) x(role)
            where pg_catalog.to_regrole(x.role) is not null loop
    execute format('revoke all on function public.agent_trajectory_steps_guard() from %I', r.role);
    execute format('revoke all on function public.agent_trajectory_steps_appended() from %I', r.role);
    execute format('revoke all on function public.agent_trajectory_steps_rewritten() from %I', r.role);
  end loop;

  -- ── 5. The bound on these two tables only, and its read of both ──────────────────────────────
  perform public.json_bound_install(array['public.agent_trajectory_steps'::pg_catalog.regclass,
                                          'public.agent_trajectories'::pg_catalog.regclass]);
  perform public.json_bound_check('public.agent_trajectory_steps'::pg_catalog.regclass);
  perform public.json_bound_check('public.agent_trajectories'::pg_catalog.regclass);

  -- Readiness for what this statement makes (read with json_bound_missing by the json-bound probe;
  -- the erasure's gate refuses on its lines 1–3). The fingerprints (definition, owner, grants —
  -- review TA-a-6) and the trigger definitions are taken here, as made above.
  select string_agg(format('(%L, %L)', p.oid::pg_catalog.regprocedure::text,
                           md5(pg_catalog.pg_get_functiondef(p.oid) || '|' || p.proowner::pg_catalog.regrole::text || '|' || coalesce(p.proacl::text, ''))),
                    ', ' order by p.proname)
         || ', ' ||
         (select string_agg(format('(%L, %L)', 'trigger ' || g.tgname, md5(pg_catalog.pg_get_triggerdef(g.oid) || '|' || g.tgenabled::text)), ', ' order by g.tgname)
            from pg_catalog.pg_trigger g
           where g.tgrelid in ('public.agent_trajectory_steps'::pg_catalog.regclass, 'public.agent_trajectories'::pg_catalog.regclass)
             and g.tgname in ('zy_agent_trajectory_steps_guard', 'agent_trajectory_steps_kept', 'agent_trajectory_steps_appended', 'agent_trajectory_steps_rewritten', 'agent_trajectories_chain_guard'))
    into fp
    from pg_catalog.pg_proc p
   where p.oid in ('public.agent_trajectory_steps_guard()'::pg_catalog.regprocedure,
                   'public.agent_trajectory_steps_appended()'::pg_catalog.regprocedure,
                   'public.agent_trajectory_steps_rewritten()'::pg_catalog.regprocedure,
                   'public.agent_trajectories_chain_guard()'::pg_catalog.regprocedure);
  execute format($ddl$
  create or replace function public.trajectory_steps_missing()
  returns setof text
  language sql
  stable
  security definer
  set search_path = pg_catalog, pg_temp
  as $g$
    -- 1. The migration recorded.
    select '076_trajectory_steps_as_rows.sql: not recorded'
     where not exists (select 1 from public.applied_migrations a where a.filename = '076_trajectory_steps_as_rows.sql')
    union all
    -- 2. The table and the counters there; 3. the old column gone.
    select x.what || ': missing'
      from (values ('public.agent_trajectory_steps', pg_catalog.to_regclass('public.agent_trajectory_steps') is not null),
                   ('agent_trajectories.step_count', exists (select 1 from pg_catalog.pg_attribute where attrelid = 'public.agent_trajectories'::pg_catalog.regclass and attname = 'step_count' and not attisdropped)),
                   ('agent_trajectories.steps_bytes', exists (select 1 from pg_catalog.pg_attribute where attrelid = 'public.agent_trajectories'::pg_catalog.regclass and attname = 'steps_bytes' and not attisdropped)),
                   ('agent_trajectories.continued', exists (select 1 from pg_catalog.pg_attribute where attrelid = 'public.agent_trajectories'::pg_catalog.regclass and attname = 'continued' and not attisdropped))) x(what, present)
     where not x.present
    union all
    select 'agent_trajectories.steps: still a column (076 has not converted it)'
     where exists (select 1 from pg_catalog.pg_attribute where attrelid = 'public.agent_trajectories'::pg_catalog.regclass and attname = 'steps' and not attisdropped)
    union all
    -- 4. The steps' and chain's functions and triggers as 076 makes them (definition, owner, grants;
    --    trigger text and ALWAYS).
    select w.f || ': not as migration 076 makes it'
      from (values %s) w(f, h)
     where w.h is distinct from coalesce(
             (select md5(pg_catalog.pg_get_functiondef(p.oid) || '|' || p.proowner::pg_catalog.regrole::text || '|' || coalesce(p.proacl::text, ''))
                from pg_catalog.pg_proc p where w.f not like 'trigger %%' and p.oid = pg_catalog.to_regprocedure(w.f)),
             (select md5(pg_catalog.pg_get_triggerdef(g.oid) || '|' || g.tgenabled::text)
                from pg_catalog.pg_trigger g
               where w.f like 'trigger %%' and g.tgname = substr(w.f, 9)
                 and g.tgrelid in ('public.agent_trajectory_steps'::pg_catalog.regclass, 'public.agent_trajectories'::pg_catalog.regclass)))
    union all
    -- 5. A BEFORE row trigger on the steps that fires after the guard (between it and the bound,
    --    or after both): it could change a step after the guard measured it (review TA-b-7).
    select 'public.agent_trajectory_steps: trigger ' || g.tgname || ' fires after zy_agent_trajectory_steps_guard'
      from pg_catalog.pg_trigger g
     where g.tgrelid = pg_catalog.to_regclass('public.agent_trajectory_steps') and not g.tgisinternal
       and (g.tgtype & 1) <> 0 and (g.tgtype & 2) <> 0 and (g.tgtype & (4 | 16)) <> 0
       and g.tgname::text collate "C" > 'zy_agent_trajectory_steps_guard'
       and g.tgname not in ('zz_json_bound_ins', 'zz_json_bound_upd')
    union all
    -- 6. Rights on the steps beyond 076's: app_tenant reads, inserts, rewrites the step only;
    --    anon, authenticated and service_role nothing.
    select 'public.agent_trajectory_steps: ' || x.r || ' may ' || x.p
      from (values ('app_tenant', 'DELETE'), ('app_tenant', 'TRUNCATE'), ('anon', 'SELECT'), ('anon', 'INSERT'), ('anon', 'UPDATE'), ('anon', 'DELETE'),
                   ('authenticated', 'SELECT'), ('authenticated', 'INSERT'), ('authenticated', 'UPDATE'), ('authenticated', 'DELETE'),
                   ('service_role', 'SELECT'), ('service_role', 'INSERT'), ('service_role', 'UPDATE'), ('service_role', 'DELETE')) x(r, p)
     where pg_catalog.to_regrole(x.r) is not null and pg_catalog.to_regclass('public.agent_trajectory_steps') is not null
       and pg_catalog.has_table_privilege(x.r, 'public.agent_trajectory_steps', x.p)
    union all
    select 'public.agent_trajectory_steps: app_tenant may update ' || a.attname
      from pg_catalog.pg_attribute a
     where pg_catalog.to_regrole('app_tenant') is not null and a.attrelid = pg_catalog.to_regclass('public.agent_trajectory_steps')
       and a.attnum > 0 and not a.attisdropped and a.attname <> 'step'
       and pg_catalog.has_column_privilege('app_tenant', a.attrelid, a.attnum, 'UPDATE')
  $g$
  $ddl$, fp);
  revoke all on function public.trajectory_steps_missing() from public;
  for r in select x.role from (values ('anon'), ('authenticated'), ('service_role')) x(role)
            where pg_catalog.to_regrole(x.role) is not null loop
    execute format('revoke all on function public.trajectory_steps_missing() from %I', r.role);
  end loop;
  if pg_catalog.to_regrole('app_tenant') is not null then
    grant execute on function public.trajectory_steps_missing() to app_tenant;
  end if;

  insert into public.applied_migrations (filename, confidence, note, checksum)
  values (
    '076_trajectory_steps_as_rows.sql',
    'verified',
    'TASK-230 (design 56e-3b): trajectory steps are rows of agent_trajectory_steps (key tenant, trajectory, seq; tenant-scoped foreign key; forced RLS); appends in order, within 1 000 steps and 16 MiB of text, never into a continued segment (continued set by the continuation); rewrites with the trajectory locked first, within 128 MiB; appends and rewrites counted once per trajectory per statement; counters kept by the steps'' triggers; the stored steps converted, agent_trajectories.steps dropped.',
    'sha256:59c2b353580b0236b7f3b842f7a457e66415f98e0a31196777e6db210249ccd9'
  )
  on conflict (filename) do update set checksum = excluded.checksum;
end
$m076$;
