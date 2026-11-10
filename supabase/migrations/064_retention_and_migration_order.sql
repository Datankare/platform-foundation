-- 064_retention_and_migration_order.sql — retention for every table, trajectory retention under
-- dual control, a purge that timed out recorded as such, and no older migration re-applied out of
-- order (TASK-203: N-25, N-26, N-27, N-53)
--
-- 1. Retention (N-25). Every table now has a rule or a stated reason to be kept
--    (platform/jobs/retention.ts RETENTION_REGISTER; __tests__/db/retention-coverage.db.test.ts fails
--    on a table without one). The rules no other duty applied are applied by a new job,
--    data.retention (each tenant, suspended ones too), each governed by its own setting seeded here
--    (operator-only, safety tier, retention category, bounded):
--      retention.network_identifiers_days   90  audit_log and consent_records keep their rows;
--                                                their ip_address and user_agent are cleared after
--      retention.user_interactions_days    365  user_interactions deleted after
--      retention.ai_metrics_days            90  ai_metrics deleted after
--      retention.content_safety_audit_days 365  content_safety_audit deleted after, except a row a
--                                                strike names (kept with the account)
--      retention.effect_ledger_days         90  effect_ledger: resolved entries deleted after
--      retention.guest_usage_days          365  guest_usage: a guest not seen for that long
--      retention.app_sessions_days         180  app_sessions not updated for that long
--      retention.agent_budgets_days         90  agent_budgets: past days' counters
--    and the job's own jobs.data.retention.enabled / .interval_minutes.
-- 2. Dual control (N-26). Turning trajectory retention off was one admin's change, while the GDPR
--    purge and the tenant purge were dual-controlled: jobs.agents.trajectory-retention.enabled and
--    jobs.data.retention.enabled join config.dual_control_keys — each key once, recorded in
--    config_dual_control_seeded (052's rule: a key an operator removed later stays removed).
-- 3. A purge that timed out (N-27) is recorded `indeterminate` in purge_log (its handler may still
--    finish), never `failed`: the status check accepts it.
-- 4. Migration order (N-53). Re-applying an older migration after later ones is not harmless
--    (re-running 039 after 049 put back 039's rate_limit_hit). Every migration from 025 records
--    itself in applied_migrations, so a trigger there refuses a migration's record when the
--    migration was applied before and another has been recorded since — the whole run then rolls
--    back (the SQL Editor runs a pasted script as one transaction). A first application, and the
--    newest one applied again, are never refused. A documented step that re-applies an older
--    migration on purpose says so first, in the same run:
--      set local platform.migration_reapply = '<its file name>';
--
-- Idempotent: inserts on conflict do nothing (an operator's later value stands), the dual-control
-- keys seeded once each, the constraint replaced only while it lacks `indeterminate`, the function
-- replaced and the trigger re-created as it was. Locks: one row each of platform_config and
-- config_dual_control_seeded; purge_log ACCESS EXCLUSIVE briefly while its check is replaced (a
-- small table: one row per purge; the check is validated against its rows); applied_migrations
-- SHARE ROW EXCLUSIVE while its trigger is created. lock_timeout 5 s: on a busy table it fails rather
-- than queueing others behind it; run it again. Apply it as ONE run.

set local lock_timeout = '5s';

-- ── 1. Retention settings and the job's schedule ─────────────────────────────────────────────
insert into public.platform_config
  (key, value, default_value, description, category, value_type, min_value, max_value, permission_tier, tenant_overridable)
values
  ('retention.network_identifiers_days', '90', '90',
   'Days an IP address and user agent are kept on audit and consent records; the records themselves are kept (accountability), these two fields cleared (TASK-203).',
   'retention', 'number', '1', '730', 'safety', false),
  ('retention.user_interactions_days', '365', '365',
   'Days a user interaction (an input, its output, a rating) is kept before it is deleted (TASK-203).',
   'retention', 'number', '7', '3650', 'safety', false),
  ('retention.ai_metrics_days', '90', '90',
   'Days an AI call''s metrics are kept before they are deleted (TASK-203).',
   'retention', 'number', '1', '730', 'safety', false),
  ('retention.content_safety_audit_days', '365', '365',
   'Days a content-safety decision is kept before it is deleted; one a strike names is kept with the account (TASK-203).',
   'retention', 'number', '30', '3650', 'safety', false),
  ('retention.effect_ledger_days', '90', '90',
   'Days a resolved external effect (confirmed or failed) is kept in the effect ledger; pending and indeterminate ones stay until resolved (TASK-203).',
   'retention', 'number', '7', '730', 'safety', false),
  ('retention.guest_usage_days', '365', '365',
   'Days a guest''s usage count is kept after the guest was last seen (TASK-203).',
   'retention', 'number', '30', '3650', 'safety', false),
  ('retention.app_sessions_days', '180', '180',
   'Days an app session is kept after it was last updated (TASK-203).',
   'retention', 'number', '1', '3650', 'safety', false),
  ('retention.agent_budgets_days', '90', '90',
   'Days an agent''s daily budget counters are kept after their day (TASK-203).',
   'retention', 'number', '2', '730', 'safety', false),
  ('jobs.data.retention.enabled', 'true', 'true',
   'Applies the retention rules no other duty applies (platform/jobs/retention.ts), for every active tenant and every suspended one (storage limitation does not pause).',
   'jobs', 'boolean', null, null, 'safety', false),
  ('jobs.data.retention.interval_minutes', '1440', '1440',
   'Minutes between retention runs.',
   'jobs', 'number', '60', '10080', 'safety', false)
on conflict (key) do nothing;

-- ── 2. Both retention duties under dual control, each key seeded once (052's rule) ───────────
with tracked(k, n) as (
  select k, n from unnest(array[
    'jobs.agents.trajectory-retention.enabled',
    'jobs.data.retention.enabled'
  ]) with ordinality as t(k, n)
),
list as (
  select value from public.platform_config
   where key = 'config.dual_control_keys' and jsonb_typeof(value) = 'array'
),
unrecorded as (
  select tracked.k, tracked.n,
         case
           when (select value from list) @> jsonb_build_array(tracked.k) then 'already_listed'
           when exists (
             select 1 from public.platform_config_history h
              where h.config_key = 'config.dual_control_keys'
                and h.scope = 'platform'
                and jsonb_typeof(h.previous_value) = 'array'
                and h.previous_value @> jsonb_build_array(tracked.k)
                and not (coalesce(h.new_value, '[]'::jsonb) @> jsonb_build_array(tracked.k))
           ) then 'removed_by_operator'
           else 'added'
         end as outcome
    from tracked
   where exists (select 1 from list)
     and not exists (select 1 from public.config_dual_control_seeded s where s.key = tracked.k)
),
added as (
  update public.platform_config
     set value = value || (
       select coalesce(jsonb_agg(u.k order by u.n), '[]'::jsonb)
         from unrecorded u where u.outcome = 'added'
     )
   where key = 'config.dual_control_keys'
     and jsonb_typeof(value) = 'array'
     and exists (select 1 from unrecorded u where u.outcome = 'added')
  returning key
)
insert into public.config_dual_control_seeded (key, seeded_by, outcome)
select u.k, '064_retention_and_migration_order.sql', u.outcome from unrecorded u
on conflict (key) do nothing;

-- ── 3. purge_log: a timed-out purge is `indeterminate` ────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'purge_log_status_check'
       and conrelid = 'public.purge_log'::regclass
       and pg_get_constraintdef(oid) like '%indeterminate%'
  ) then
    alter table public.purge_log drop constraint if exists purge_log_status_check;
    alter table public.purge_log add constraint purge_log_status_check
      check (status in ('pending', 'in-progress', 'completed', 'failed', 'partial', 'indeterminate'));
  end if;
end $$;

-- ── 4. No older migration re-applied out of order ────────────────────────────────────────────
create or replace function public.applied_migrations_in_order()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  last_at timestamptz;
  later text;
begin
  select a.recorded_at into last_at
    from public.applied_migrations a where a.filename = new.filename;
  -- A first application is never refused.
  if not found then
    return new;
  end if;
  -- A documented, deliberate re-application names its file first (set local).
  if coalesce(current_setting('platform.migration_reapply', true), '') in (new.filename, 'all') then
    return new;
  end if;
  select a.filename into later
    from public.applied_migrations a
   where a.recorded_at > last_at and a.filename <> new.filename
   order by a.recorded_at desc, a.filename desc
   limit 1;
  if later is not null then
    raise exception 'migration %: already applied, and % was applied after it — re-applying an older migration out of order is refused (TASK-203, N-53); nothing in this run was applied', new.filename, later
      using hint = 'Apply only the newest migration. A documented step that re-applies this one on purpose runs, first, in the same run: set local platform.migration_reapply = ''' || new.filename || ''';';
  end if;
  return new;
end $$;

comment on function public.applied_migrations_in_order() is
  'TASK-203 (N-53): refuses the record of a migration applied before when another was recorded since — an older migration re-applied out of order — unless the run set platform.migration_reapply to its file name.';

-- A trigger function: no role calls it (the public key, the request role least of all).
revoke all on function public.applied_migrations_in_order() from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.applied_migrations_in_order() from anon, authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'app_tenant') then
    execute 'revoke all on function public.applied_migrations_in_order() from app_tenant';
  end if;
end $$;

drop trigger if exists applied_migrations_in_order on public.applied_migrations;
create trigger applied_migrations_in_order
  before insert on public.applied_migrations
  for each row execute function public.applied_migrations_in_order();

insert into public.applied_migrations (filename, confidence, note, checksum)
values (
  '064_retention_and_migration_order.sql',
  'verified',
  'TASK-203: retention settings and the data.retention job (N-25); trajectory retention and data retention dual-controlled, seeded once (N-26); purge_log accepts indeterminate (N-27); an older migration re-applied out of order is refused (N-53).',
  'sha256:7b2641f6395f0de91a7f8b8be74a9085c9c0d6b0acf5b58aa6fa666b47a7a758'
)
on conflict (filename) do update set checksum = excluded.checksum;
