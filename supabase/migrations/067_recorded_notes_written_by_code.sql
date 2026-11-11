-- 067_recorded_notes_written_by_code.sql — the platform's notes that TypeScript wrote into a record
-- are a catalog key and its values, not English (TASK-209, N-112)
--
-- After 066 (TASK-208: the notes SQL wrote), the platform's own words still reached rows from
-- TypeScript, and every reader saw them in English whatever its locale: a lapsed or undecided
-- hold's note ('expired: not run within 7 days of its approval'), a decision's default note
-- ('rejected_after_run_failed', 'verified that its run did not take effect', …), a superseded or
-- duplicate hold's note, a refused or stale hold's, an approval's kept-run note ('run failed,
-- approval kept: …', 'commit failed, approval kept', the lease notes) and 'marked executed by …'
-- written into last_run_error, a two-person approval withdrawn by the system (and 062's note), a
-- setting change's comment the platform made ('Changed on the config page', 'Approved: …', an
-- emergency suspension, the command bar's), the Sentinel's ban and strike reasons, the escalation
-- reaper's note, an external effect's ledger reason, and job_claim's dead-lease text. Now each is
-- kept as a catalog key and values (platform/errors/recorded-text.ts) or a code, and rendered in
-- the reader's locale; what a person wrote stays theirs, as written.
--
-- 1. Columns (jsonb, nullable; each with a check: an object whose "key" is a screen message
--    `screens.…` and whose "params", if any, is an object):
--    - config_pending_approvals.change_shown — the platform's note on a request (none written);
--    - config_pending_approvals.review_shown — the system's record when it withdrew a request;
--    - platform_config_history.change_shown — the platform's note on a change;
--    - review_queue.notes_shown — the platform's note on a decision it made (the reaper's).
--    config_pending_approvals.impact_summary is no longer written (it was English derived from the
--    key and values, which the row keeps; nothing showed it).
-- 2. job_claim (050) records a dead lease as the code 'lease_expired', worded by the Jobs console.
--    050 applied again (a documented re-application) puts back its own job_claim: apply this one
--    after it (scripts/migration-replay.sh does).
-- 3. Rows written before are migrated, matched exactly — anchored patterns of each composed text;
--    what a person wrote inside one ("Approved: <comment>", an operator's reason) is kept as
--    written, as a value. A text that does not match exactly (a person's) is left as it is; a row
--    already migrated (its note set) is not read again.
-- 4. The moderation pipeline's reasons (added in the batch): content_safety_audit gains
--    reasoning_shown and context_factors_shown (arrays of keys and values, checked); the Guardian's
--    reasoning (its parts, each a template, all or none), each context factor, and the classifier's
--    notes (in classifier_output and a review case's moderation_result: the platform's as `note`,
--    the model's own words as `rawReason`) are converted; a text that is not a template exactly
--    stays, and readers show it as recorded before reasons were coded. content_safety_audit holds
--    a row per screening: its update reads every row once (a text compare per row).
--
-- Idempotent: `add column if not exists`, each check added only when absent, `create or replace`
-- for job_claim (same text on a re-run), each update only on rows not yet migrated (a second run
-- matches none and writes nothing), the record upserted. The helper functions are pg_temp's.
-- Locks: the five tables ACCESS EXCLUSIVE briefly while each column (no default: no rewrite) and
-- check are added; then the matching rows of proposals, agent_trajectories,
-- config_pending_approvals, platform_config_history, users, review_queue, user_strikes,
-- effect_ledger, jobs, job_schedule_outcomes and content_safety_audit are updated
-- (agent_trajectories read once, with a text prefilter). lock_timeout 5 s: on a busy table it fails rather than queueing others behind
-- it; run it again. Apply it as ONE run.

set local lock_timeout = '5s';

-- ── 1. The columns ───────────────────────────────────────────────────────────────────────────
alter table public.config_pending_approvals add column if not exists change_shown jsonb;
alter table public.config_pending_approvals add column if not exists review_shown jsonb;
alter table public.platform_config_history add column if not exists change_shown jsonb;
alter table public.review_queue add column if not exists notes_shown jsonb;

comment on column public.config_pending_approvals.change_shown is
  'The platform''s own note on the request, when no person wrote one ("Changed on the config page", a command bar summary), as a screen message''s key and values; change_comment is what a person wrote (empty beside this). TASK-209.';
comment on column public.config_pending_approvals.review_shown is
  'The system''s record when it decided the request (a withdrawal: why, and who had approved it and when), as a screen message''s key and values; review_comment is what a reviewer wrote. TASK-209.';
comment on column public.config_pending_approvals.impact_summary is
  'No longer written (TASK-209): it was English derived from config_key, current_value and proposed_value, which the row keeps.';
comment on column public.platform_config_history.change_shown is
  'The platform''s own note on the change ("Approved: …", an emergency suspension, the command bar''s summary), as a screen message''s key and values; change_comment is what a person wrote (empty beside this). TASK-209.';
comment on column public.review_queue.notes_shown is
  'The platform''s own note on a decision it made (the escalation reaper''s block, ADR-041), as a screen message''s key and values; reviewer_notes is what a reviewer wrote. TASK-209.';

do $$
declare
  c record;
begin
  for c in
    select * from (values
      ('config_pending_approvals', 'change_shown', 'config_pending_approvals_change_shown_shown'),
      ('config_pending_approvals', 'review_shown', 'config_pending_approvals_review_shown_shown'),
      ('platform_config_history', 'change_shown', 'platform_config_history_change_shown_shown'),
      ('review_queue', 'notes_shown', 'review_queue_notes_shown_shown')
    ) as v (tbl, col, con)
  loop
    if not exists (
      select 1 from pg_constraint
       where conname = c.con and conrelid = ('public.' || c.tbl)::regclass
    ) then
      execute format(
        'alter table public.%I add constraint %I check (%I is null or (jsonb_typeof(%I) = %L'
        ' and jsonb_typeof(%I -> %L) = %L and (%I ->> %L) like %L'
        ' and (not %I ? %L or jsonb_typeof(%I -> %L) = %L)))',
        c.tbl, c.con, c.col, c.col, 'object', c.col, 'key', 'string', c.col, 'key', 'screens.%',
        c.col, 'params', c.col, 'params', 'object');
    end if;
  end loop;
end $$;

-- ── 2. job_claim: a dead lease is a code ─────────────────────────────────────────────────────
-- As 050 defines it, but for the dead lease's last_error: 'lease_expired' (screens.jobs.errors).
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
  -- attempt left to give it. Dead, not run again — recorded as a code (TASK-209).
  update public.jobs j
     set status = 'dead',
         last_error = 'lease_expired',
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
  -- tenant; each probe orders by that index's whole key, so no other index on tenant_id can
  -- serve it — one that could would walk a tenant's parked or finished rows), and each tenant's due jobs of each kind by a range scan of it limited to what is
  -- left to take — whatever else is queued, the work is bounded by tenants x kinds x limit.
  return query
  with recursive queued_tenants (tid) as (
    (select j.tenant_id from public.jobs j
      where j.status = 'queued' and j.tenant_id is not null
      order by j.tenant_id, j.kind, j.run_at, j.id limit 1)
    union all
    select (select j.tenant_id from public.jobs j
             where j.status = 'queued' and j.tenant_id > q.tid
             order by j.tenant_id, j.kind, j.run_at, j.id limit 1)
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

-- ── 3. Rows written before ───────────────────────────────────────────────────────────────────
-- A message's record: {"key": "screens.records.<name>"} with its values, when any.
create or replace function pg_temp.m067_key(name text, params jsonb default null)
returns jsonb language sql immutable as $fn$
  select case when params is null then jsonb_build_object('key', 'screens.records.' || name)
              else jsonb_build_object('key', 'screens.records.' || name, 'params', params) end
$fn$;

-- What the platform wrote as a hold's note (a decision's default note, its why), in its
-- catalog form; null when `note` is not one of the platform's (a person's: left as written).
create or replace function pg_temp.m067_note(note text)
returns jsonb language plpgsql immutable as $fn$
declare
  p text[];
begin
  if note is null then
    return null;
  end if;
  p := regexp_match(note, '^expired: not run within (\d+) days? of its approval$');
  if p is not null then
    return pg_temp.m067_key('expired_unused', jsonb_build_object('days', p[1]::int));
  end if;
  p := regexp_match(note, '^expired: not decided within (\d+) days? of being requested$');
  if p is not null then
    return pg_temp.m067_key('expired_undecided', jsonb_build_object('days', p[1]::int));
  end if;
  if note in ('rejected_after_run_failed', 'withdrawn: not approved again after its run failed') then
    return pg_temp.m067_key('withdrawn_run_failed');
  end if;
  if note = 'verified that its run did not take effect' then
    return pg_temp.m067_key('verified_not_applied');
  end if;
  if note = 'verified as applied' then
    return pg_temp.m067_key('verified_applied');
  end if;
  if note = 'approved again: verified that its run did not take effect' then
    return pg_temp.m067_key('approved_again');
  end if;
  if note = 'revised' then
    return pg_temp.m067_key('revised');
  end if;
  p := regexp_match(note, '^state advanced (-?\d+) -> (-?\d+); approval is stale$');
  if p is not null then
    return pg_temp.m067_key('stale_state',
      jsonb_build_object('observed', p[1]::int, 'current', p[2]::int));
  end if;
  p := regexp_match(note, '^duplicate of hold (\S+), which stands$');
  if p is not null then
    return pg_temp.m067_key('duplicate_of', jsonb_build_object('holdId', p[1]));
  end if;
  if note = 'stale: what it would replace changed since it was requested' then
    return pg_temp.m067_key('refused_stale');
  end if;
  p := regexp_match(note, '^refused: "([^"]+)" turns on a job that is now required — always on, and set only as the platform default$');
  if p is not null then
    return pg_temp.m067_key('refused', jsonb_build_object('reason',
      pg_temp.m067_key('required_job', jsonb_build_object('key', p[1]))));
  end if;
  p := regexp_match(note, '^refused: ([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)$');
  if p is not null then
    return pg_temp.m067_key('refused', jsonb_build_object('reason',
      jsonb_build_object('key', 'errors.' || p[1])));
  end if;
  if note = 'withdrawn: superseded — a power reduction was applied to the key' then
    return pg_temp.m067_key('superseded',
      jsonb_build_object('reason', pg_temp.m067_key('power_reduced')));
  end if;
  p := regexp_match(note, '^withdrawn: superseded — every agent was suspended: (.*)$');
  if p is not null then
    return pg_temp.m067_key('superseded', jsonb_build_object('reason',
      pg_temp.m067_key('agents_suspended', jsonb_build_object('reason', p[1]))));
  end if;
  return null;
end
$fn$;

-- A run's kept-approval note (last_run_error) as a code or catalog key; null when not one of the
-- platform's.
create or replace function pg_temp.m067_run(note text)
returns text language plpgsql immutable as $fn$
declare
  p text[];
begin
  if note = 'run did not end within its lease; its outcome is unknown — verify, then mark it executed, approve it again or withdraw it' then
    return 'screens.held.note_indeterminate';
  end if;
  if note = 'atomic run did not end within its lease; its transaction rolled back with its effect, approval kept' then
    return 'screens.held.note_atomic_recovered';
  end if;
  if note = 'commit failed, approval kept' then
    return 'screens.held.note_commit_failed';
  end if;
  if note = 'state moved before commit, approval kept' then
    return 'screens.held.note_state_moved';
  end if;
  p := regexp_match(note, '^run failed, approval kept: (.*)$', 's');
  if p is not null then
    -- The run's code when it gave one; otherwise its text was the platform's or a tool's own
    -- words (the detail is in the log), worded now by the catalog's note.
    return case when p[1] ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$' then p[1]
                else 'screens.held.note_run_failed' end;
  end if;
  return null;
end
$fn$;

-- 'marked executed by <who>: <note>' (last_run_error, review 11 H-1) as its record; null if not.
create or replace function pg_temp.m067_marked(note text)
returns jsonb language plpgsql immutable as $fn$
declare
  p text[];
begin
  p := regexp_match(note, '^marked executed by (\S+): (.*)$', 's');
  if p is null then
    return null;
  end if;
  return pg_temp.m067_key('marked_executed', jsonb_build_object(
    'by', p[1], 'note', coalesce(pg_temp.m067_note(p[2]), to_jsonb(p[2]))));
end
$fn$;

-- A setting change's comment the platform wrote, as its record; null for a person's.
create or replace function pg_temp.m067_comment(comment text)
returns jsonb language plpgsql immutable as $fn$
declare
  p text[];
  w text;
  what jsonb;
  items jsonb;
begin
  if comment is null then
    return null;
  end if;
  if comment in ('Changed on the config page', 'Tenant settings') then
    return pg_temp.m067_key('changed_on_page');
  end if;
  if comment = 'Set by an operator for this tenant' then
    return pg_temp.m067_key('set_by_operator');
  end if;
  if comment = 'Use the platform default' then
    return pg_temp.m067_key('reset_to_default');
  end if;
  p := regexp_match(comment, '^Emergency: every agent suspended — (.*)$', 's');
  if p is not null then
    return pg_temp.m067_key('emergency_suspended', jsonb_build_object('reason', p[1]));
  end if;
  p := regexp_match(comment, '^(Add|Remove) (\S+) (?:to|from) dual-control$');
  if p is not null and (p[1] = 'Add') = (comment like '% to dual-control') then
    return pg_temp.m067_key(case when p[1] = 'Add' then 'dual_control_added' else 'dual_control_removed' end,
      jsonb_build_object('key', p[2]));
  end if;
  p := regexp_match(comment, '^Command bar: (.*)$', 's');
  if p is not null then
    w := p[1];
    -- The command bar's summaries (screens.admin_console.results.*), each read back to its key
    -- and values; one that does not read back exactly is left as written.
    if w ~ '^Registered agent \S+$' then
      what := jsonb_build_object('key', 'screens.admin_console.results.agent_registered',
        'params', jsonb_build_object('agent', substr(w, 18)));
    elsif w ~ '^(Reactivated|Suspended) agent \S+$' then
      what := jsonb_build_object('key', 'screens.admin_console.results.agent_status',
        'params', jsonb_build_object(
          'agent', (regexp_match(w, 'agent (\S+)$'))[1],
          'status', case when w like 'Reactivated %' then 'reactivated' else 'suspended' end));
    elsif w ~ '^Removed every capability from the scope of \S+$' then
      what := jsonb_build_object('key', 'screens.admin_console.results.agent_scope',
        'params', jsonb_build_object('agent', (regexp_match(w, 'scope of (\S+)$'))[1],
                                     'scopes', '[]'::jsonb, 'count', 0));
    elsif w ~ '^Set the scope of \S+ to .+$' then
      items := to_jsonb(regexp_split_to_array(
        (regexp_match(w, '^Set the scope of \S+ to (.+)$'))[1], ', and |, | and '));
      what := jsonb_build_object('key', 'screens.admin_console.results.agent_scope',
        'params', jsonb_build_object('agent', (regexp_match(w, '^Set the scope of (\S+) to '))[1],
                                     'scopes', items, 'count', jsonb_array_length(items)));
    elsif w ~ '^Set the token ceiling of \S+ to [0-9,]+ seconds?$' then
      what := jsonb_build_object('key', 'screens.admin_console.results.agent_ttl',
        'params', jsonb_build_object(
          'agent', (regexp_match(w, 'ceiling of (\S+) to'))[1],
          'seconds', replace((regexp_match(w, ' to ([0-9,]+) second'))[1], ',', '')::int));
    elsif w ~ '^Removed capability mapping “[^”]+”$' then
      what := jsonb_build_object('key', 'screens.admin_console.results.mapping_removed',
        'params', jsonb_build_object('capability', (regexp_match(w, '“([^”]+)”'))[1]));
    elsif w ~ '^Mapped “[^”]+” to .+$' then
      what := jsonb_build_object('key', 'screens.admin_console.results.mapping_set',
        'params', jsonb_build_object(
          'capability', (regexp_match(w, '“([^”]+)”'))[1],
          'features', to_jsonb(regexp_split_to_array(
            (regexp_match(w, '” to (.+)$'))[1], ', and |, | and '))));
    else
      return null;
    end if;
    return jsonb_build_object('key', 'screens.admin_console.results.command_bar_comment',
      'params', jsonb_build_object('what', what));
  end if;
  p := regexp_match(comment, '^Approved: (.*)$', 's');
  if p is not null then
    -- The request's comment, as written — or, when the platform had made it, its record.
    return pg_temp.m067_key('change_approved', jsonb_build_object(
      'note', coalesce(pg_temp.m067_comment(p[1]), to_jsonb(p[1]))));
  end if;
  return null;
end
$fn$;

-- A two-person approval's review comment the system wrote, as its record; null for a person's.
create or replace function pg_temp.m067_review(comment text)
returns jsonb language plpgsql immutable as $fn$
declare
  p text[];
  why jsonb;
begin
  if comment is null then
    return null;
  end if;
  if comment = 'withdrawn by the system: "jobs.config.expire-approvals.enabled" turns on a job that is now required — always on, and set only as the platform default (migration 062)' then
    return pg_temp.m067_key('config_required_job_062', jsonb_build_object('why',
      pg_temp.m067_key('required_job', jsonb_build_object('key', 'jobs.config.expire-approvals.enabled'))));
  end if;
  p := regexp_match(comment, '^withdrawn by the system: (.*) \(approved by (\S+) at (\S+)\)$', 's');
  if p is not null then
    if p[1] ~ '^stale — "[^"]+" changed since it was requested$' then
      why := pg_temp.m067_key('config_stale',
        jsonb_build_object('key', (regexp_match(p[1], '"([^"]+)"'))[1]));
    elsif p[1] ~ '^refused — "[^"]+" no longer takes the value requested$' then
      why := pg_temp.m067_key('config_refused',
        jsonb_build_object('key', (regexp_match(p[1], '"([^"]+)"'))[1]));
    elsif p[1] ~ '^"[^"]+" turns on a job that is now required — always on, and set only as the platform default$' then
      why := pg_temp.m067_key('required_job',
        jsonb_build_object('key', (regexp_match(p[1], '"([^"]+)"'))[1]));
    else
      return null;
    end if;
    return pg_temp.m067_key('config_withdrawn', jsonb_build_object('why', why,
      'approvedBy', case when p[2] = 'unknown' then pg_temp.m067_key('unknown') else to_jsonb(p[2]) end,
      'approvedAt', case when p[3] = 'unknown' then pg_temp.m067_key('unknown') else to_jsonb(p[3]) end));
  end if;
  -- The supersession note (hold-withdrawal.ts), as on a runtime hold.
  return pg_temp.m067_note(comment);
end
$fn$;

-- One run step, migrated: a held action's note copied from its decision (gating.ts
-- endHeldTrajectory: output.note — its decision note, else its run's note) in its catalog form.
create or replace function pg_temp.m067_step(step jsonb)
returns jsonb language plpgsql immutable as $fn$
declare
  o jsonb := step -> 'output';
  n jsonb;
  r text;
begin
  if jsonb_typeof(o) is distinct from 'object' or jsonb_typeof(o -> 'note') is distinct from 'string' then
    return step;
  end if;
  n := coalesce(pg_temp.m067_note(o ->> 'note'), pg_temp.m067_marked(o ->> 'note'));
  if n is null then
    r := pg_temp.m067_run(o ->> 'note');
    if r is not null then
      n := jsonb_build_object('key', r);
    end if;
  end if;
  if n is null then
    return step;
  end if;
  return jsonb_set(step, '{output,note}', n);
end
$fn$;

-- Proposals: a withdrawal record whose why was the platform's — into the record.
update public.proposals p
   set decision_shown = jsonb_set(p.decision_shown, '{params,note}', pg_temp.m067_note(p.decision_note)),
       decision_note = null
 where p.decision_note is not null
   and p.decision_shown ->> 'key' in ('screens.records.withdrawn_after_approval',
                                      'screens.records.withdrawn_undecided')
   and jsonb_typeof(p.decision_shown -> 'params') = 'object'
   and not p.decision_shown -> 'params' ? 'note'
   and pg_temp.m067_note(p.decision_note) is not null;

-- Proposals: a decision's note the platform wrote, with no record beside it.
update public.proposals p
   set decision_shown = pg_temp.m067_note(p.decision_note),
       decision_note = null
 where p.decision_note is not null
   and p.decision_shown is null
   and pg_temp.m067_note(p.decision_note) is not null;

-- Proposals: 'marked executed by …' (last_run_error) — into the record; the run's note cleared.
update public.proposals p
   set decision_shown = pg_temp.m067_marked(p.last_run_error),
       last_run_error = null
 where p.status = 'executed'
   and p.decision_shown is null
   and p.last_run_error like 'marked executed by %'
   and pg_temp.m067_marked(p.last_run_error) is not null;

-- Proposals: a kept run's note, as its code or catalog key.
update public.proposals p
   set last_run_error = pg_temp.m067_run(p.last_run_error)
 where p.last_run_error is not null
   and pg_temp.m067_run(p.last_run_error) is not null;

-- Runs: their steps' notes (only rows a step of which changes are written).
update public.agent_trajectories a
   set steps = m.steps
  from (
    select t.tenant_id, t.id,
           (select jsonb_agg(pg_temp.m067_step(s.step) order by s.n)
              from jsonb_array_elements(t.steps) with ordinality as s(step, n)) as steps
      from public.agent_trajectories t
     where jsonb_typeof(t.steps) = 'array'
       and jsonb_array_length(t.steps) > 0
       and t.steps::text like any (array[
             '%"note": "expired: %', '%"note": "rejected_after_run_failed"%',
             '%"note": "withdrawn: %', '%"note": "verified %', '%"note": "approved again: %',
             '%"note": "revised"%', '%"note": "state advanced %', '%"note": "duplicate of hold %',
             '%"note": "stale: %', '%"note": "refused: %', '%"note": "marked executed by %',
             '%"note": "run did not end within its lease%', '%"note": "atomic run did not end%',
             '%"note": "commit failed, approval kept"%', '%"note": "state moved before commit%',
             '%"note": "run failed, approval kept: %'])
  ) m
 where a.tenant_id = m.tenant_id and a.id = m.id
   and a.steps is distinct from m.steps;

-- Two-person approvals: the system's withdrawal (and 062's) — into review_shown.
update public.config_pending_approvals c
   set review_shown = pg_temp.m067_review(c.review_comment),
       review_comment = null
 where c.review_comment is not null
   and c.review_shown is null
   and pg_temp.m067_review(c.review_comment) is not null;

-- Two-person approvals: a request's comment the platform made — into change_shown.
update public.config_pending_approvals c
   set change_shown = pg_temp.m067_comment(c.change_comment),
       change_comment = ''
 where c.change_shown is null
   and pg_temp.m067_comment(c.change_comment) is not null;

-- Two-person approvals: the impact summary (English derived from the row's key and values).
update public.config_pending_approvals c
   set impact_summary = null
 where c.impact_summary like 'Changing "%';

-- Setting changes: a comment the platform made — into change_shown.
update public.platform_config_history h
   set change_shown = pg_temp.m067_comment(h.change_comment),
       change_comment = ''
 where h.change_shown is null
   and pg_temp.m067_comment(h.change_comment) is not null;

-- Accounts: the Sentinel's ban reason — into ban_note (066's column).
update public.users
   set ban_note = jsonb_build_object('key', 'screens.records.ban_strike_threshold'),
       ban_reason = null
 where ban_note is null
   and ban_reason = 'Automatic ban: strike threshold exceeded';

-- Review items: the escalation reaper's note — into notes_shown.
update public.review_queue
   set notes_shown = jsonb_build_object('key', 'screens.records.escalation_auto_blocked',
         'params', jsonb_build_object('hours',
           (regexp_match(reviewer_notes, '^Auto-blocked: escalation exceeded the ([0-9]+(?:\.[0-9]+)?)h SLA'))[1]::numeric)),
       reviewer_notes = null
 where notes_shown is null
   and reviewer_notes ~ '^Auto-blocked: escalation exceeded the [0-9]+(\.[0-9]+)?h SLA without human review \(ADR-041\)\.$';

-- Strikes: the Sentinel's reason — its code (what triggered the block), when the row's category
-- and severity are the ones the text named.
update public.user_strikes s
   set reason = 'guardian_block:' || m.parts[3]
  from (
    select id, regexp_match(reason, '^Guardian blocked content: (.+) \(severity: (\S+), triggered by: ([a-z][a-z-]*)\)\.$') as parts
      from public.user_strikes
     where reason like 'Guardian blocked content: %'
  ) m
 where s.id = m.id
   and m.parts is not null
   and s.category = m.parts[1]
   and s.severity is not distinct from m.parts[2];

-- ── The moderation pipeline's reasons (the coordinator's scope correction, TASK-209) ────────────
-- The Guardian's reasoning and context factors, and the classifier's own notes, were English
-- composed in TypeScript (content_safety_audit.reasoning, context_factors, classifier_output's
-- "reason"; a review case's moderation_result). Now they are catalog keys and values
-- (platform/moderation/reasons.ts): two new columns on content_safety_audit, the keys in place in
-- moderation_result, and the classifier's notes as `note` — its model's own words, raw, as
-- `rawReason`. A text that matches the composed templates exactly, part by part, is converted; one
-- that does not keeps its stored text, which a reader shows as "recorded before reasons were
-- coded" with the stored text behind a disclosure (N-108).
alter table public.content_safety_audit add column if not exists reasoning_shown jsonb;
alter table public.content_safety_audit add column if not exists context_factors_shown jsonb;
comment on column public.content_safety_audit.reasoning_shown is
  'Why the Guardian decided, line by line: an array of screen messages'' keys and values (TASK-209). reasoning keeps only what was recorded before them and did not match a template.';
comment on column public.content_safety_audit.context_factors_shown is
  'The decision''s context factors: an array of screen messages'' keys and values (TASK-209). context_factors keeps only what was recorded before them and did not match a template.';
do $$
declare
  c record;
begin
  for c in
    select * from (values
      ('reasoning_shown', 'content_safety_audit_reasoning_shown_shown'),
      ('context_factors_shown', 'content_safety_audit_context_factors_shown_shown')
    ) as v (col, con)
  loop
    if not exists (
      select 1 from pg_constraint
       where conname = c.con and conrelid = 'public.content_safety_audit'::regclass
    ) then
      execute format(
        'alter table public.content_safety_audit add constraint %I check (%I is null or'
        ' (jsonb_typeof(%I) = %L and not jsonb_path_exists(%I, %L)))',
        c.con, c.col, c.col, 'array', c.col,
        '$[*] ? (@.type() != "object" || !(@.key like_regex "^screens\\."))');
    end if;
  end loop;
end $$;

-- A content-rating level's name, as the Guardian wrote it.
create or replace function pg_temp.m067_level(t text) returns jsonb language sql immutable as $f$
  select case t
    when 'child (under 13)' then '{"key": "screens.moderation.levels.child"}'::jsonb
    when 'teen (13–17)' then '{"key": "screens.moderation.levels.teen"}'::jsonb
    when 'adult (18+)' then '{"key": "screens.moderation.levels.adult"}'::jsonb
    when 'fail-closed (config unavailable)' then '{"key": "screens.moderation.levels.fail_closed"}'::jsonb
  end
$f$;

-- One context factor, as context.ts wrote it; null when it is not one exactly.
create or replace function pg_temp.m067_factor(t text) returns jsonb language plpgsql immutable as $f$
declare
  m text[];
begin
  if t = 'unknown-content-type: treated as generation' then
    return '{"key": "screens.moderation.factors.unknown_content_type"}';
  elsif t = 'ai-output: strikes not attributed to user' then
    return '{"key": "screens.moderation.factors.ai_output"}';
  elsif t = 'clean-history: user has long clean record' then
    return '{"key": "screens.moderation.factors.clean_history"}';
  elsif t = 'repeat-flags: 3+ flags in last 24h' then
    return '{"key": "screens.moderation.factors.repeat_flags"}';
  end if;
  m := regexp_match(t, '^([a-z][a-z-]*)-content: severity reduced by ([0-9]+)$');
  if m is not null then
    return jsonb_build_object('key', 'screens.moderation.factors.severity_reduced',
      'params', jsonb_build_object('contentType', m[1], 'reduction', m[2]));
  end if;
  m := regexp_match(t, '^language-context: (\S+) → (\S+)$');
  if m is not null then
    return jsonb_build_object('key', 'screens.moderation.factors.language_context',
      'params', jsonb_build_object('source', m[1], 'target', m[2]));
  end if;
  return null;
end
$f$;

-- The Guardian's reasoning (its parts joined by a space), part by part; null unless every part is
-- one of its templates exactly.
create or replace function pg_temp.m067_reasons(t text) returns jsonb language plpgsql immutable as $f$
declare
  lvl constant text := '(child \(under 13\)|teen \(13–17\)|adult \(18\+\)|fail-closed \(config unavailable\))';
  -- Each template, anchored, its whole text the first group and a space or the end after it.
  pats constant text[] := array[
    '^(Empty text — no content to screen\.)( |$)',
    '^(Context: ([^.]+)\.)( |$)',
    '^(Blocklist hit: ([a-z_, -]+) \(severity: ([a-z]+)\)\. Blocked immediately — classifier skipped\.)( |$)',
    '^(Classifier declined to assess the content \(declined\) — withheld for human review\.)( |$)',
    '^(Classifier unavailable — content withheld at every rating level \(fail-closed\)\.)( |$)',
    '^(Classifier answer unreadable — withheld for human review at every rating level \(fail-closed\)\.)( |$)',
    '^(Classifier: safe \(confidence ([0-9]+\.[0-9]+)\)\.)( |$)',
    '^(Low-severity blocklist match — warning applied\.)( |$)',
    '^(Config unavailable — using fail-closed thresholds\.)( |$)',
    '^(Severity adjusted: ([a-z]+) → ([a-z]+) \(([a-z][a-z-]*) context, -([0-9]+)\)\.)( |$)',
    '^(Confidence ([0-9]+\.[0-9]+) below threshold ([0-9.]+) for ' || lvl || ' — escalating for human review\.)( |$)',
    '^(Adjusted severity ([a-z]+) ≥ (block|warn) threshold ([a-z]+) for ' || lvl || '\.)( |$)',
    '^(Adjusted severity ([a-z]+) below warn threshold for ' || lvl || ' — allowed\.)( |$)',
    '^(Screening run did not complete — escalated for human review \(fail-closed\)\.)( |$)'
  ];
  rest text := t;
  out jsonb := '[]';
  m text[];
  i int;
  part jsonb;
  f jsonb;
  fs jsonb;
  item text;
begin
  if t is null or t = '' then return null; end if;
  while rest <> '' loop
    m := null;
    for n in 1 .. array_length(pats, 1) loop
      m := regexp_match(rest, pats[n]);
      i := n;
      exit when m is not null;
    end loop;
    if m is null then return null; end if;
    case i
      when 1 then part := '{"key": "screens.moderation.reasons.empty_text"}';
      when 2 then
        fs := '[]';
        foreach item in array string_to_array(m[2], '; ') loop
          f := pg_temp.m067_factor(item);
          if f is null then return null; end if;
          fs := fs || jsonb_build_array(f);
        end loop;
        part := jsonb_build_object('key', 'screens.moderation.reasons.context', 'params', jsonb_build_object('factors', fs));
      when 3 then part := jsonb_build_object('key', 'screens.moderation.reasons.blocklist_block', 'params', jsonb_build_object('categories', m[2], 'severity', m[3]));
      when 4 then part := '{"key": "screens.moderation.reasons.declined"}';
      when 5 then part := '{"key": "screens.moderation.reasons.unavailable"}';
      when 6 then part := '{"key": "screens.moderation.reasons.unreadable"}';
      when 7 then part := jsonb_build_object('key', 'screens.moderation.reasons.safe', 'params', jsonb_build_object('confidence', m[2]));
      when 8 then part := '{"key": "screens.moderation.reasons.low_blocklist"}';
      when 9 then part := '{"key": "screens.moderation.reasons.config_unavailable"}';
      when 10 then part := jsonb_build_object('key', 'screens.moderation.reasons.severity_adjusted', 'params',
        jsonb_build_object('from', m[2], 'to', m[3], 'contentType', m[4], 'reduction', m[5]));
      when 11 then part := jsonb_build_object('key', 'screens.moderation.reasons.escalate_confidence', 'params',
        jsonb_build_object('confidence', m[2], 'threshold', m[3], 'level', pg_temp.m067_level(m[4])));
      when 12 then part := jsonb_build_object('key', 'screens.moderation.reasons.' || m[3] || '_threshold', 'params',
        jsonb_build_object('severity', m[2], 'threshold', m[4], 'level', pg_temp.m067_level(m[5])));
      when 13 then part := jsonb_build_object('key', 'screens.moderation.reasons.allowed', 'params',
        jsonb_build_object('severity', m[2], 'level', pg_temp.m067_level(m[3])));
      else part := '{"key": "screens.moderation.reasons.run_incomplete"}';
    end case;
    out := out || jsonb_build_array(part);
    rest := substr(rest, length(m[1]) + 2);
  end loop;
  return out;
end
$f$;

-- The classifier's own note (its "reason" as the platform wrote it); null for the model's words.
create or replace function pg_temp.m067_classifier_note(t text) returns jsonb language plpgsql immutable as $f$
declare
  m text[];
  ps jsonb := '[]';
  item text;
  k text;
begin
  k := case t
    when 'Classifier answer is not a JSON object' then 'not_object'
    when 'Failed to parse classifier response' then 'unparsable'
    when 'Missing ''safe'' field' then 'missing_safe'
    when 'Classifier returned unexpected response type' then 'unexpected_type'
    when 'Classifier unavailable' then 'unavailable'
    when 'declined' then 'declined'
  end;
  if k is not null then return jsonb_build_object('key', 'screens.moderation.classifier.' || k); end if;
  m := regexp_match(t, '^Classifier answer not fully readable \((.+)\)$');
  if m is null then return null; end if;
  foreach item in array string_to_array(m[1], '; ') loop
    k := case item
      when 'categories missing' then 'categories_missing'
      when 'unknown category' then 'unknown_category'
      when 'confidence missing or outside 0–1' then 'confidence_invalid'
      when 'severity missing or unknown' then 'severity_invalid'
      when 'reason is not text' then 'reason_not_text'
      when 'a safe verdict with categories or a severity above low' then 'safe_contradiction'
    end;
    if k is null then return null; end if;
    ps := ps || jsonb_build_array(jsonb_build_object('key', 'screens.moderation.problems.' || k));
  end loop;
  return jsonb_build_object('key', 'screens.moderation.classifier.unreadable', 'params', jsonb_build_object('problems', ps));
end
$f$;

-- A classifier output with its "reason" split: the platform's note, or the model's words (raw).
create or replace function pg_temp.m067_classifier(o jsonb) returns jsonb language sql immutable as $f$
  select case
    when o is null or jsonb_typeof(o) <> 'object' or not (o ? 'reason') then o
    when jsonb_typeof(o -> 'reason') <> 'string' then o - 'reason'
    when pg_temp.m067_classifier_note(o ->> 'reason') is not null
      then (o - 'reason') || jsonb_build_object('note', pg_temp.m067_classifier_note(o ->> 'reason'))
    else (o - 'reason') || jsonb_build_object('rawReason', o -> 'reason')
  end
$f$;

-- A list of context factors (text), each converted where it is one exactly; the others as text.
create or replace function pg_temp.m067_factors(fs jsonb) returns jsonb language sql immutable as $f$
  select coalesce(jsonb_agg(coalesce(case when jsonb_typeof(e) = 'string' then pg_temp.m067_factor(e #>> '{}') end, e) order by n), '[]')
    from jsonb_array_elements(fs) with ordinality as x (e, n)
$f$;

-- content_safety_audit: the reasoning (all or nothing), each factor, the classifier's note.
update public.content_safety_audit
   set reasoning_shown = pg_temp.m067_reasons(reasoning), reasoning = ''
 where reasoning_shown is null and reasoning <> '' and pg_temp.m067_reasons(reasoning) is not null;
update public.content_safety_audit a
   set context_factors_shown = coalesce(a.context_factors_shown, '[]'::jsonb) || x.shown,
       context_factors = x.rest
  from (select id, tenant_id,
               coalesce(jsonb_agg(pg_temp.m067_factor(f) order by n) filter (where pg_temp.m067_factor(f) is not null), '[]') as shown,
               coalesce(array_agg(f order by n) filter (where pg_temp.m067_factor(f) is null), '{}') as rest
          from public.content_safety_audit, unnest(context_factors) with ordinality as u (f, n)
         where cardinality(context_factors) > 0
         group by id, tenant_id) x
 where a.id = x.id and a.tenant_id = x.tenant_id and x.shown <> '[]'::jsonb;
update public.content_safety_audit
   set classifier_output = pg_temp.m067_classifier(classifier_output)
 where classifier_output ? 'reason';

-- review_queue: a case's moderation result, in place.
update public.review_queue
   set moderation_result = moderation_result
         || case when jsonb_typeof(moderation_result -> 'reasoning') = 'string'
                  and pg_temp.m067_reasons(moderation_result ->> 'reasoning') is not null
                 then jsonb_build_object('reasoning', pg_temp.m067_reasons(moderation_result ->> 'reasoning'))
                 else '{}'::jsonb end
         || case when jsonb_typeof(moderation_result -> 'contextFactors') = 'array'
                 then jsonb_build_object('contextFactors', pg_temp.m067_factors(moderation_result -> 'contextFactors'))
                 else '{}'::jsonb end
         || case when moderation_result -> 'classifierOutput' ? 'reason'
                 then jsonb_build_object('classifierOutput', pg_temp.m067_classifier(moderation_result -> 'classifierOutput'))
                 else '{}'::jsonb end
 where (jsonb_typeof(moderation_result -> 'reasoning') = 'string'
        and pg_temp.m067_reasons(moderation_result ->> 'reasoning') is not null)
    or (jsonb_typeof(moderation_result -> 'contextFactors') = 'array'
        and pg_temp.m067_factors(moderation_result -> 'contextFactors') <> moderation_result -> 'contextFactors')
    or moderation_result -> 'classifierOutput' ? 'reason';

-- The effect ledger: its reasons, as catalog keys.
update public.effect_ledger
   set error = case error
         when 'the call may have taken effect: it timed out or its connection dropped (the detail is in the log)'
           then 'screens.records.effect_unknown'
         when 'the call failed (the detail is in the log)' then 'screens.records.effect_failed'
         else 'screens.records.effect_unresolved' end
 where error in (
   'the call may have taken effect: it timed out or its connection dropped (the detail is in the log)',
   'the call failed (the detail is in the log)',
   'unresolved entry found on retry; downstream state unknown');

-- Jobs: a dead lease, as the code job_claim now records.
update public.jobs
   set last_error = 'lease_expired'
 where last_error = 'The worker running the last attempt stopped before it finished (its lease expired).';
update public.job_schedule_outcomes
   set last_error = 'lease_expired'
 where last_error = 'The worker running the last attempt stopped before it finished (its lease expired).';

insert into public.applied_migrations (filename, confidence, note, checksum)
values (
  '067_recorded_notes_written_by_code.sql',
  'verified',
  'TASK-209: the platform''s notes TypeScript wrote into a record (hold and decision notes, a kept run''s note, marked executed, a system withdrawal, a change''s comment, ban and strike reasons, the reaper''s note, the effect ledger''s reasons, job_claim''s dead lease) are a catalog key and values or a code; rows written before are migrated (N-112).',
  'sha256:555d06573ad4b3acd1d947977e2d1f92d85a314c2bf24eb416cd720a33c1204e'
)
on conflict (filename) do update set checksum = excluded.checksum;
