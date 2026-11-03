-- 061_feature_permissions_enforced.sql — the feature permissions are enforced; every role keeps
-- the features it has; a safety approver may approve an erasure (TASK-194, audit C-4; round 1 A2)
--
-- can_translate, can_view_profile and can_edit_profile were seeded and granted but checked by no
-- route: /api/process and the profile routes gated on account status only, so removing a
-- permission from a role, or building a role or tier without it, changed nothing. The platform
-- now enforces them (platform/auth/actor-guard.ts FEATURE_PERMISSIONS): translate needs
-- can_translate, view_profile can_view_profile, update_profile can_edit_profile.
--
-- Until now every account could use those features whatever its role. So that no account loses
-- one, every role that exists when this runs is granted all three — the seeded roles that lacked
-- some (guest: can_translate, can_edit_profile; moderator and safety_approver: all three) and any
-- role an administrator created. None is a staff permission (role-governance rule 4), so the
-- default role may carry them. Removing one from a role afterwards is an administrator's governed
-- change, which now takes effect. can_play and can_create_group are reserved (no route provides
-- gameplay or groups yet: __tests__/admin-authorization-matrix.test.ts RESERVED_PERMISSIONS).
--
-- An account's erasure is always held for a second holder of admin_purge_user_data (audit C-6),
-- and only super_admin held it: a deployment with one super_admin could never complete one. The
-- safety_approver role is granted it (round 1, A2), so an erasure needs two distinct holders of
-- admin_purge_user_data — each a super_admin or a safety_approver (round 2, N5): the requester
-- and an approver who is not the requester. The first safety approver is a documented one-time
-- bootstrap (docs/TENANCY_OPERATIONS.md, "Dual control needs a second approver; the first safety
-- approver").
--
-- One open erasure per account (round 2, A6): a partial unique index on proposals — the tenant and
-- the account (payload userId, lower case: round 3, L1) of a purge_user_data hold that is proposed,
-- approved, executing or undecided — so two requests made at once cannot both be held (the route
-- answers the loser admin.erasure_pending). It holds a SHARE lock on proposals while it is built (a
-- small table: held actions only), within the lock_timeout below. A hold whose period ran out but
-- was not yet withdrawn still counts as open: a new erasure request withdraws it first (the route,
-- TASK-194 rebase I-3), as the config.expire-approvals job does on its schedule. An index of this
-- name with another definition — a development database that applied a draft of 061 (before round
-- 3, L1: without lower(); or not unique) — is dropped and built again (TASK-199), so applying 061
-- again corrects it; an account with more than one open erasure hold makes it refuse, naming them
-- (below), until all but one are decided.
--
-- Refuses to run (raises, nothing granted) when a permission it grants is not in the catalog.
--
-- Safe to re-run: the grants run only while this migration's applied_migrations row is absent —
-- the first time. Applied again (by hand, in the SQL Editor), it grants nothing, so it never grants
-- back a permission an administrator removed since (scripts/migration-replay.sh proves it); a
-- draft's index of another definition is replaced (proved there too).
-- Apply it as ONE run — the SQL Editor runs a pasted script as one transaction; psql needs
-- --single-transaction — so the record is written in the same transaction as the grants and a
-- failed run leaves neither. Transactional statements only.

set local lock_timeout = '5s';

do $$
declare
  missing text[];
begin
  select array_agg(c order by c) into missing
    from unnest(array['can_translate', 'can_view_profile', 'can_edit_profile',
                      'admin_purge_user_data']) as c
   where not exists (select 1 from public.permissions p where p.code = c);
  if missing is not null then
    raise exception '061: permissions missing from the catalog: %', missing;
  end if;
end $$;

do $$
begin
  if exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'proposals_purge_one_open'
       and not (indexdef ilike 'CREATE UNIQUE INDEX%'
                and indexdef ilike '%(tenant_id, lower((payload ->> ''userId''::text)))%'
                and indexdef ilike '%purge_user_data%'
                and indexdef ilike '%''proposed''%' and indexdef ilike '%''approved''%'
                and indexdef ilike '%''executing''%' and indexdef ilike '%''indeterminate''%')
  ) then
    drop index public.proposals_purge_one_open;
  end if;
end $$;

-- Two open erasure holds for one account (a database that ran a draft without the index, or
-- held erasures before it): the index cannot be built over them. 061 refuses, naming each account
-- and its holds, and changes nothing (one transaction) — it does not pick which erasure stands:
-- a newer hold may be the one approved or running. Decide all but one in Approvals (keep the
-- oldest; reject one proposed or approved; one executing: wait for its run to end, then decide it
-- by its new status; one indeterminate: verify whether its erasure took effect — it did, mark it
-- executed; it did not, withdraw it; never approve it again, which runs a second erasure), then
-- apply 061 again.
do $$
declare
  duplicates text;
begin
  select string_agg(format('%s/%s: %s', tenant_id, account, holds), '; ' order by tenant_id, account)
    into duplicates
    from (
      select tenant_id, lower(payload ->> 'userId') as account,
             string_agg(format('%s (%s)', id, status), ', ' order by created_at, id) as holds
        from public.proposals
       where label = 'purge_user_data'
         and status in ('proposed', 'approved', 'executing', 'indeterminate')
       group by 1, 2
      having count(*) > 1
    ) d;
  if duplicates is not null then
    raise exception '061: accounts with more than one open erasure hold (tenant/account: holds, oldest first, each with its status): %. Keep the oldest of each and decide the others in Approvals: proposed or approved: reject it; executing: wait for its run to end, then decide it by its new status; indeterminate: verify whether its erasure took effect: it did, mark it executed; it did not, withdraw it (never approve it again: that runs a second erasure). Then apply 061 again.', duplicates;
  end if;
end $$;

create unique index if not exists proposals_purge_one_open
  on public.proposals (tenant_id, lower(payload ->> 'userId'))
  where label = 'purge_user_data'
    and status in ('proposed', 'approved', 'executing', 'indeterminate');

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where p.code in ('can_translate', 'can_view_profile', 'can_edit_profile')
  and not exists (
    select 1 from public.applied_migrations
     where filename = '061_feature_permissions_enforced.sql'
  )
on conflict (role_id, permission_id) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.name = 'safety_approver' and p.code in ('admin_purge_user_data')
  and not exists (
    select 1 from public.applied_migrations
     where filename = '061_feature_permissions_enforced.sql'
  )
on conflict (role_id, permission_id) do nothing;

insert into public.applied_migrations (filename, confidence, note)
values (
  '061_feature_permissions_enforced.sql',
  'verified',
  'can_translate, can_view_profile and can_edit_profile granted to every existing role, as the platform starts enforcing them (TASK-194, audit C-4); admin_purge_user_data granted to safety_approver, so an erasure has a second approver (round 1, A2); one open erasure per account (proposals_purge_one_open, round 2, A6).'
)
on conflict (filename) do nothing;
