-- 050_jobs.sql — the durable job queue and its schedules (ADR-056 D2, D3; TASK-141)
--
-- Before: timed duties (the escalation-SLA reaper, review-claim release, strike expiry, the GDPR
-- retention purge, tenant purge, scheduled agents) had functions and no trigger; retries
-- happened inside a request only, and nothing was dead-lettered.
--
-- After:
--   * jobs — one row per unit of background work. A tenant's job carries its tenant_id and is
--     isolated like every tenant table (forced row-level security, tenant_isolation for
--     app_tenant); a platform job (tenant purge, cross-tenant housekeeping) has tenant_id null
--     and is reachable only on the owner connection. Idempotent: (tenant_id, kind,
--     idempotency_key) is unique — nulls not distinct, so one platform job per key — and the
--     same key in two tenants is two jobs. status queued → running → succeeded, or back to
--     queued with a later run_at (a retry), or dead after its last attempt; parked while its
--     tenant is not active (below). last_error holds the platform's own sanitized wording only
--     (platform/jobs/errors.ts), never a database message. A job is never due before it was
--     enqueued: run_at in the past is clamped to now() (no queue-jumping).
--   * parking — a suspended or deleted tenant's queued jobs are parked (status parked) by a
--     trigger on tenants, and a job enqueued or requeued for such a tenant is parked as it is
--     written, so the claim's index holds only work that can run: a suspended tenant's backlog
--     never slows every other tenant's claim. Resuming the tenant queues them again. A kind
--     declared runsForSuspended (the GDPR retention purge — a legal obligation) is never parked
--     for a suspended tenant (runs_for_suspended); a deleted tenant's jobs always are (its purge
--     removes them).
--   * job_schedules — the runtime state of each recurring job: when its next slot is due and
--     when the last slot was enqueued. Whether a schedule is enabled and its interval are
--     governed configuration (jobs.<kind>.enabled, jobs.<kind>.interval_minutes, below), so a
--     change to either gets the configuration's tier check, audit record, history and — for the
--     safety duties — dual control.
--   * job_schedule_outcomes — how each tenant's (or the platform's) latest job of a recurring
--     kind ended, one row per tenant and kind, so one tenant's success never overwrites another's
--     failure on the console.
--   * job_claim(worker, kinds, limit, lease_seconds) — the one cross-tenant step: claims due
--     jobs with FOR UPDATE SKIP LOCKED, so two workers never take the same job, and leases each
--     (locked_until, lease_token). Lapsed leases first (a job whose worker died is due again; one
--     that lapsed on its last attempt is dead), then queued jobs tenant by tenant in turn
--     (round-robin), so one tenant's backlog cannot starve the others. Claims are serialised by a
--     transaction-scoped advisory lock (each takes milliseconds), so concurrent claimers neither
--     take a job twice nor come up short. Every lookup is an index range scan bounded by the
--     claim's limit (jobs_queued_idx: tenant, kind, due time, id; queued only). Owner rights, closed
--     to public, anon, authenticated and app_tenant (the TASK-137 check in
--     scripts/migration-replay.sh). platform/jobs runs each claimed job inside its tenant
--     (withTenantTx, ADR-053 D4).
--
-- app_tenant may read its own tenant's jobs (the tenant administrators' read-only history). It
-- inserts, changes and removes none: every enqueue goes through platform/jobs on the owner
-- connection, which binds the job to the caller's tenant and the kind's scope (queue.ts) — so a
-- request role reached by an injection cannot queue work, backdate it or name an unknown kind.
--
-- Idempotent and lock-light: new tables and indexes only (no existing table is rewritten or
-- locked beyond a catalog row and one trigger), every step checks what exists, configuration rows
-- are inserted on conflict do nothing, so an operator's later choice stands on a re-run, and the
-- dual-control list is extended on this migration's first application only — an operator who
-- later removes a key keeps it removed (scripts/migration-replay.sh applies it twice and compares).

-- ── Jobs ─────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  -- A tenant's job defaults to the transaction's tenant; the owner sets it (or null) explicitly.
  tenant_id uuid default public.app_current_tenant()
    references public.tenants (id) on delete restrict,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  idempotency_key text not null,
  status text not null default 'queued',
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  run_at timestamptz not null default now(),
  locked_until timestamptz,
  locked_by text,
  lease_token uuid,
  last_error text,
  -- How the job came to be: a schedule's slot, an operator's "run now", a replay, or code.
  source text not null default 'enqueue',
  -- The kind runs for a suspended tenant too (a legal obligation): never parked for one.
  runs_for_suspended boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  constraint jobs_kind_shape check (
    kind ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$' and char_length(kind) <= 100
  ),
  constraint jobs_status_check check (status in ('queued', 'running', 'succeeded', 'dead', 'parked')),
  constraint jobs_source_check check (source in ('enqueue', 'schedule', 'manual', 'replay')),
  constraint jobs_attempts_check check (attempts >= 0 and attempts <= max_attempts),
  constraint jobs_max_attempts_check check (max_attempts between 1 and 25),
  constraint jobs_key_shape check (char_length(idempotency_key) between 1 and 200),
  constraint jobs_payload_object check (jsonb_typeof(payload) = 'object'),
  constraint jobs_payload_size check (octet_length(payload::text) <= 65536),
  constraint jobs_last_error_length check (last_error is null or char_length(last_error) <= 1000),
  constraint jobs_locked_by_length check (locked_by is null or char_length(locked_by) <= 200),
  -- A running job always holds a lease; nothing else does.
  constraint jobs_lease_check check (
    (status = 'running') = (locked_until is not null and lease_token is not null)
  ),
  -- A platform job has no tenant to be suspended for.
  constraint jobs_suspended_tenant_only check (not runs_for_suspended or tenant_id is not null)
);

create unique index if not exists jobs_idempotency_key
  on public.jobs (tenant_id, kind, idempotency_key) nulls not distinct;
-- What job_claim reads: queued jobs by tenant, kind and due time, in the claim's own order (a
-- range scan per tenant and kind that stops at the claim's limit — parked and finished rows are
-- not in it); running jobs by lease expiry.
create index if not exists jobs_queued_idx on public.jobs (tenant_id, kind, run_at, id)
  where status = 'queued';
create index if not exists jobs_lease_idx on public.jobs (locked_until) where status = 'running';
-- The console's per-kind counts.
create index if not exists jobs_kind_status_idx on public.jobs (kind, status);
-- The dead-letter list, newest first; a tenant's history, newest first.
create index if not exists jobs_dead_idx on public.jobs (updated_at desc) where status = 'dead';
create index if not exists jobs_tenant_created_idx on public.jobs (tenant_id, created_at desc);
-- Pruning finished jobs by age.
create index if not exists jobs_finished_idx on public.jobs (finished_at)
  where status = 'succeeded';

alter table public.jobs enable row level security;
alter table public.jobs force row level security;
drop policy if exists tenant_isolation on public.jobs;
create policy tenant_isolation on public.jobs
  for all to app_tenant
  using (tenant_id = public.app_current_tenant())
  with check (tenant_id = public.app_current_tenant());
revoke all on table public.jobs from public, anon, authenticated;
-- app_tenant: read only. Revoked only where held, so a re-run leaves the privilege list exactly
-- as it was.
revoke update, delete, truncate, references, trigger on table public.jobs from app_tenant;
do $$
begin
  if has_any_column_privilege('app_tenant', 'public.jobs', 'INSERT') then
    revoke insert on table public.jobs from app_tenant;
    revoke insert (kind, payload, idempotency_key, run_at, max_attempts) on table public.jobs
      from app_tenant;
  end if;
end $$;
grant select on table public.jobs to app_tenant;
grant all on table public.jobs to service_role;

comment on table public.jobs is
  'Durable background jobs (ADR-056 D2). Claimed by job_claim, run in their tenant by platform/jobs; last_error is sanitized; parked while the tenant is not active.';

-- Every job written queued: never due before now, and parked when its tenant cannot run it.
create or replace function public.jobs_on_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
begin
  if tg_op = 'INSERT' and new.run_at < now() then
    new.run_at := now();
  end if;
  if new.status = 'queued' and new.tenant_id is not null then
    select t.status into v_status from public.tenants t where t.id = new.tenant_id;
    if v_status is distinct from 'active'
       and not (v_status = 'suspended' and new.runs_for_suspended) then
      new.status := 'parked';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.jobs_on_write() from public, anon, authenticated, app_tenant;

drop trigger if exists jobs_on_write on public.jobs;
create trigger jobs_on_write
  before insert or update of status on public.jobs
  for each row execute function public.jobs_on_write();

-- A tenant's status change parks or unparks its queued work.
create or replace function public.jobs_follow_tenant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'active' then
    update public.jobs set status = 'queued', updated_at = now()
     where tenant_id = new.id and status = 'parked';
  elsif new.status = 'suspended' then
    update public.jobs set status = 'parked', updated_at = now()
     where tenant_id = new.id and status = 'queued' and not runs_for_suspended;
    update public.jobs set status = 'queued', updated_at = now()
     where tenant_id = new.id and status = 'parked' and runs_for_suspended;
  else
    update public.jobs set status = 'parked', updated_at = now()
     where tenant_id = new.id and status = 'queued';
  end if;
  return null;
end;
$$;
revoke all on function public.jobs_follow_tenant() from public, anon, authenticated, app_tenant;

drop trigger if exists jobs_follow_tenant on public.tenants;
create trigger jobs_follow_tenant
  after update of status on public.tenants
  for each row when (old.status is distinct from new.status)
  execute function public.jobs_follow_tenant();

-- ── Schedules ────────────────────────────────────────────────────────────────────────────────
create table if not exists public.job_schedules (
  kind text primary key,
  -- When the next slot is due; the scheduler advances it as it enqueues the slot's jobs. A
  -- shortened interval applies at once: the slot is also due at last_run_at + the interval now
  -- in force (platform/jobs/postgres-store.ts).
  next_run_at timestamptz not null default now(),
  -- When the last slot was enqueued, and how many jobs it enqueued (one per tenant, or one).
  last_run_at timestamptz,
  last_enqueued integer not null default 0,
  updated_at timestamptz not null default now(),
  constraint job_schedules_kind_shape check (
    kind ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$' and char_length(kind) <= 100
  ),
  constraint job_schedules_last_enqueued_check check (last_enqueued >= 0)
);
alter table public.job_schedules enable row level security;
alter table public.job_schedules force row level security;
revoke all on table public.job_schedules from public, anon, authenticated, app_tenant;
grant all on table public.job_schedules to service_role;

comment on table public.job_schedules is
  'Runtime state of recurring jobs (ADR-056 D3). Enabled and interval are governed config: jobs.<kind>.enabled, jobs.<kind>.interval_minutes.';

-- How each tenant's latest job of a recurring kind ended (tenant_id null: the platform's).
create table if not exists public.job_schedule_outcomes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants (id) on delete cascade,
  kind text not null,
  status text not null,
  last_error text,
  finished_at timestamptz not null default now(),
  constraint job_schedule_outcomes_kind_shape check (
    kind ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$' and char_length(kind) <= 100
  ),
  constraint job_schedule_outcomes_status_check
    check (status in ('succeeded', 'retrying', 'dead')),
  constraint job_schedule_outcomes_last_error_length
    check (last_error is null or char_length(last_error) <= 1000)
);
create unique index if not exists job_schedule_outcomes_key
  on public.job_schedule_outcomes (tenant_id, kind) nulls not distinct;
create index if not exists job_schedule_outcomes_kind_idx
  on public.job_schedule_outcomes (kind, status);
alter table public.job_schedule_outcomes enable row level security;
alter table public.job_schedule_outcomes force row level security;
drop policy if exists tenant_isolation on public.job_schedule_outcomes;
create policy tenant_isolation on public.job_schedule_outcomes
  for all to app_tenant
  using (tenant_id = public.app_current_tenant())
  with check (tenant_id = public.app_current_tenant());
revoke all on table public.job_schedule_outcomes from public, anon, authenticated, app_tenant;
grant all on table public.job_schedule_outcomes to service_role;

comment on table public.job_schedule_outcomes is
  'Latest outcome of each recurring job kind per tenant (ADR-056 D3): the console reports the worst, never only the last to finish.';

-- ── The claim ────────────────────────────────────────────────────────────────────────────────
-- Owner rights: it reads every tenant's due jobs (the one step that does), takes only the kinds
-- the calling worker can run, and only jobs a tenant may run now (an active tenant's, a
-- suspended tenant's of a kind that runs for suspended tenants, the platform's). Bounded inputs;
-- refuses anything else.
create or replace function public.job_claim(
  p_worker text,
  p_kinds text[],
  p_limit integer,
  p_lease_seconds integer
)
returns table (
  id uuid,
  tenant_id uuid,
  kind text,
  payload jsonb,
  attempts integer,
  max_attempts integer,
  lease_token uuid,
  locked_until timestamptz,
  source text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_taken integer;
  v_left integer;
begin
  if p_worker is null or char_length(p_worker) not between 1 and 200 then
    raise exception 'job_claim: invalid worker';
  end if;
  if p_kinds is null or cardinality(p_kinds) = 0 or cardinality(p_kinds) > 200 then
    raise exception 'job_claim: invalid kinds';
  end if;
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'job_claim: invalid limit';
  end if;
  if p_lease_seconds is null or p_lease_seconds not between 5 and 3600 then
    raise exception 'job_claim: invalid lease';
  end if;

  -- One claim at a time (until the claiming transaction ends): each statement below then sees
  -- every earlier claim, so concurrent workers neither take one job twice nor come up short.
  perform pg_advisory_xact_lock(hashtextextended('public.job_claim', 0));

  -- A lease that lapsed on the last attempt: the worker died running it, and there is no
  -- attempt left to give it. Dead, not run again.
  update public.jobs j
     set status = 'dead',
         last_error = 'The worker running the last attempt stopped before it finished (its lease expired).',
         locked_until = null, locked_by = null, lease_token = null,
         finished_at = now(), updated_at = now()
   where j.status = 'running' and j.locked_until < now()
     and j.attempts >= j.max_attempts and j.kind = any (p_kinds);

  -- Lapsed leases first: they were due before anything queued now.
  return query
  with lapsed as (
    select j.id
      from public.jobs j
      left join public.tenants t on t.id = j.tenant_id
     where j.status = 'running' and j.locked_until < now() and j.kind = any (p_kinds)
       and (j.tenant_id is null or t.status = 'active'
            or (t.status = 'suspended' and j.runs_for_suspended))
     order by j.locked_until, j.id
     limit p_limit
     for update of j skip locked
  )
  update public.jobs j
     set attempts = j.attempts + 1,
         locked_until = now() + make_interval(secs => p_lease_seconds),
         locked_by = p_worker,
         lease_token = gen_random_uuid(),
         started_at = now(),
         updated_at = now()
    from lapsed
   where j.id = lapsed.id
  returning j.id, j.tenant_id, j.kind, j.payload, j.attempts, j.max_attempts, j.lease_token,
            j.locked_until, j.source;
  get diagnostics v_taken = row_count;
  v_left := p_limit - v_taken;
  if v_left <= 0 then
    return;
  end if;

  -- Then queued jobs, tenants in turn: each tenant's oldest due job, then each one's next. The
  -- tenants with queued work are found by skipping through jobs_queued_idx (one probe per
  -- tenant), and each tenant's due jobs of each kind by a range scan of it limited to what is
  -- left to take — whatever else is queued, the work is bounded by tenants x kinds x limit.
  return query
  with recursive queued_tenants (tid) as (
    (select j.tenant_id from public.jobs j
      where j.status = 'queued' and j.tenant_id is not null
      order by j.tenant_id limit 1)
    union all
    select (select j.tenant_id from public.jobs j
             where j.status = 'queued' and j.tenant_id > q.tid
             order by j.tenant_id limit 1)
      from queued_tenants q
     where q.tid is not null
  ),
  candidates as (
    select c.id, c.run_at,
           row_number() over (partition by c.tenant_id order by c.run_at, c.id) as turn
      from (
        select x.id, t.id as tenant_id, x.run_at
          from queued_tenants q
          join public.tenants t on t.id = q.tid and t.status in ('active', 'suspended')
         cross join unnest(p_kinds) as k (kind)
         cross join lateral (
           select j.id, j.run_at
             from public.jobs j
            where j.tenant_id = t.id and j.kind = k.kind and j.status = 'queued'
              and j.run_at <= now() and (t.status = 'active' or j.runs_for_suspended)
            order by j.run_at, j.id
            limit v_left
         ) x
        union all
        select x.id, null::uuid, x.run_at
          from unnest(p_kinds) as k (kind)
         cross join lateral (
           select j.id, j.run_at
             from public.jobs j
            where j.tenant_id is null and j.kind = k.kind and j.status = 'queued'
              and j.run_at <= now()
            order by j.run_at, j.id
            limit v_left
         ) x
      ) c
  ),
  due as (
    select j.id
      from public.jobs j
      join candidates c on c.id = j.id
     where j.status = 'queued' and j.run_at <= now()
     order by c.turn, c.run_at, j.id
     limit v_left
     for update of j skip locked
  )
  update public.jobs j
     set status = 'running',
         attempts = j.attempts + 1,
         locked_until = now() + make_interval(secs => p_lease_seconds),
         locked_by = p_worker,
         lease_token = gen_random_uuid(),
         started_at = now(),
         updated_at = now()
    from due
   where j.id = due.id
  returning j.id, j.tenant_id, j.kind, j.payload, j.attempts, j.max_attempts, j.lease_token,
            j.locked_until, j.source;
end;
$$;

revoke all on function public.job_claim(text, text[], integer, integer)
  from public, anon, authenticated, app_tenant;
grant execute on function public.job_claim(text, text[], integer, integer) to service_role;

-- ── Governed schedules ───────────────────────────────────────────────────────────────────────
-- One enabled flag and one interval per core recurring job, operator-only (not tenant
-- settable). The module jobs' keys are seeded by their module's migration. Safety tier: turning
-- a duty off, or stretching it, weakens what it enforces.
insert into public.platform_config
  (key, value, default_value, description, category, value_type, min_value, max_value, permission_tier)
values
  ('jobs.moderation.escalation-reaper.enabled', 'true', 'true',
   'Runs the escalation-SLA reaper (ADR-041) for every active tenant. Off, over-SLA escalations stay withheld without a decision.',
   'jobs', 'boolean', null, null, 'safety'),
  ('jobs.moderation.escalation-reaper.interval_minutes', '15', '15',
   'Minutes between escalation-SLA reaper runs. An item can stay over its SLA by up to this long.',
   'jobs', 'number', '5', '60', 'safety'),
  ('jobs.moderation.release-claims.enabled', 'true', 'true',
   'Returns review items whose claim timed out to the queue, for every active tenant.',
   'jobs', 'boolean', null, null, 'safety'),
  ('jobs.moderation.release-claims.interval_minutes', '15', '15',
   'Minutes between releases of timed-out review claims.',
   'jobs', 'number', '5', '120', 'safety'),
  ('jobs.moderation.expire-strikes.enabled', 'true', 'true',
   'Marks strikes past their expiry as expired, for every active tenant.',
   'jobs', 'boolean', null, null, 'safety'),
  ('jobs.moderation.expire-strikes.interval_minutes', '60', '60',
   'Minutes between strike-expiry runs.',
   'jobs', 'number', '15', '1440', 'safety'),
  ('jobs.accounts.expire-restrictions.enabled', 'true', 'true',
   'Steps restricted or suspended accounts whose end date has passed down to warned, for every active tenant.',
   'jobs', 'boolean', null, null, 'safety'),
  ('jobs.accounts.expire-restrictions.interval_minutes', '60', '60',
   'Minutes between runs that lift lapsed restrictions and suspensions.',
   'jobs', 'number', '15', '1440', 'safety'),
  ('jobs.gdpr.retention-purge.enabled', 'true', 'true',
   'Erases accounts whose GDPR retention period has passed (hard purge), for every active tenant and every suspended one (a legal obligation that does not pause).',
   'jobs', 'boolean', null, null, 'safety'),
  ('jobs.gdpr.retention-purge.interval_minutes', '1440', '1440',
   'Minutes between GDPR retention purges.',
   'jobs', 'number', '60', '1440', 'safety'),
  ('jobs.agents.trajectory-retention.enabled', 'true', 'true',
   'Deletes completed and failed agent trajectories older than agent.trajectory.retention_days, for every active tenant and every suspended one (storage limitation does not pause).',
   'jobs', 'boolean', null, null, 'safety'),
  ('jobs.agents.trajectory-retention.interval_minutes', '1440', '1440',
   'Minutes between trajectory-retention runs.',
   'jobs', 'number', '60', '10080', 'safety'),
  ('jobs.config.expire-approvals.enabled', 'true', 'true',
   'Marks pending configuration approvals past their expiry as expired (TASK-036), across tenants.',
   'jobs', 'boolean', null, null, 'safety'),
  ('jobs.config.expire-approvals.interval_minutes', '60', '60',
   'Minutes between runs that expire stale configuration approvals.',
   'jobs', 'number', '15', '1440', 'safety'),
  ('jobs.tenancy.purge-due.enabled', 'true', 'true',
   'Purges the data of deleted tenants whose purge time has passed (ADR-053 D7).',
   'jobs', 'boolean', null, null, 'safety'),
  ('jobs.tenancy.purge-due.interval_minutes', '60', '60',
   'Minutes between tenant purges.',
   'jobs', 'number', '15', '1440', 'safety'),
  ('jobs.jobs.prune.enabled', 'true', 'true',
   'Deletes succeeded jobs older than jobs.retention_days. Dead jobs are kept until an operator replays or discards them.',
   'jobs', 'boolean', null, null, 'safety'),
  ('jobs.jobs.prune.interval_minutes', '1440', '1440',
   'Minutes between job-history prunes.',
   'jobs', 'number', '60', '10080', 'safety'),
  ('jobs.retention_days', '30', '30',
   'Days a succeeded job is kept in the history before it is pruned.',
   'jobs', 'number', '1', '365', 'safety')
on conflict (key) do nothing;

-- The duties whose absence is a safety or compliance failure: turning one off needs a second
-- operator (dual control, ADR-039). Added on this migration's first application only: an
-- operator who later removes one (a governed change of its own) keeps it removed on a re-run.
update public.platform_config
   set value = value || (
     select coalesce(jsonb_agg(k), '[]'::jsonb)
       from unnest(array[
         'jobs.moderation.escalation-reaper.enabled',
         'jobs.gdpr.retention-purge.enabled',
         'jobs.tenancy.purge-due.enabled'
       ]) as k
      where not (platform_config.value @> jsonb_build_array(k))
   )
 where key = 'config.dual_control_keys'
   and jsonb_typeof(value) = 'array'
   and not exists (
     select 1 from public.applied_migrations where filename = '050_jobs.sql'
   );

insert into public.applied_migrations (filename, confidence, note)
values (
  '050_jobs.sql',
  'verified',
  'ADR-056 D2/D3 (TASK-141): jobs (forced RLS, read-only to app_tenant; platform jobs owner-only; parked while the tenant is not active), job_schedules and job_schedule_outcomes, job_claim (serialised, round-robin across tenants, SKIP LOCKED lease, owner rights, closed to public/anon/authenticated/app_tenant), governed schedule keys, safety duties under dual control (seeded once).'
)
on conflict (filename) do nothing;
