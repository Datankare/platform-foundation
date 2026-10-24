-- 049_tenancy.sql — tenants, and row-level security that is the enforcement (ADR-053 D4, D5, D7)
--
-- Before: no tenant anywhere; every server path used the service role, which bypasses row-level
-- security, so the policies (keyed on auth.uid(), never set under Cognito) protected nothing.
--
-- After:
--   * tenants and tenant_domains, with the default tenant every existing row belongs to.
--   * Every tenant-owned table has tenant_id (not null, defaulting to the transaction's tenant),
--     FORCE ROW LEVEL SECURITY, and one policy for the request role app_tenant:
--         tenant_id = app_current_tenant()
--     where app_current_tenant() reads the transaction-local setting app.tenant_id that
--     platform/data's withTenantTx sets. No setting: matches nothing, and inserts fail (not null).
--   * Foreign keys between tenant-owned tables include tenant_id, so a row can never point at
--     another tenant's row (a foreign key check is not filtered by row-level security).
--   * Natural keys that were unique platform-wide are unique per tenant.
--   * Platform-owned tables (role and permission catalog, entitlement catalog, config defaults,
--     deletion manifest) are readable by app_tenant and writable only by the owner.
--   * Configuration is layered: platform_config holds the platform defaults; a tenant's own
--     values are rows in tenant_config_overrides, which app_tenant may write only for keys marked
--     tenant_overridable (operators may override any key, through the owner connection).
--   * tenants and tenant_domains are not readable by app_tenant at all: requests resolve a host
--     or a tenant through two narrow owner-rights functions (directory_host, directory_tenant).
--   * Every policy the earlier migrations made for anon, authenticated and the service role is
--     dropped (by name) and the public roles' table and function privileges revoked: nothing
--     reads tables with the public key (Realtime uses broadcast). app_tenant may not create
--     temporary tables.
--   * The owner-rights function agent_budget_consume runs as its caller now, under row-level
--     security; the auth.uid()-based helpers (is_admin, has_permission, get_current_user_id) are
--     dropped — permission checks are the application's (D5).
--
-- app_tenant is created NOLOGIN here: a migration never carries a password. The deployment
-- gives it a password and login (docs/TENANCY_OPERATIONS.md), then sets DATABASE_URL to it.
--
-- Idempotent: every step checks what exists. Re-running changes nothing — no backfill runs
-- again, no operator choice made since is undone, no later migration's policy is dropped
-- (scripts/migration-replay.sh applies it twice and compares).
--
-- On a database with data: no table is rewritten (tenant_id is added with a constant default,
-- which Postgres stores once), foreign keys are added unchecked and then validated; index
-- builds (tenant-scoped keys, primary keys) still block writes to their table while they run.
-- The whole script runs as one transaction in the SQL Editor, so every lock it takes is held
-- until it commits: apply it in a quiet period (docs/TENANCY_OPERATIONS.md §1.1).


-- ── The request role ─────────────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_tenant') then
    create role app_tenant nologin noinherit nobypassrls nocreatedb nocreaterole;
  end if;
  -- Whatever a deployment did since, the role never bypasses row-level security.
  alter role app_tenant nobypassrls nocreatedb nocreaterole noinherit;
end $$;

grant usage on schema public to app_tenant;

-- No temporary tables for the request role: it has no use for them, and a temporary table named
-- like a platform table would shadow it for any later statement that did not schema-qualify
-- the name. Postgres gives TEMPORARY to PUBLIC on every database by default, and a privilege
-- held through PUBLIC cannot be revoked from one role — so where PUBLIC holds it, every other
-- existing role (anon, authenticated, service_role, postgres, Supabase's own…) is granted it
-- explicitly first, then PUBLIC's is revoked: nothing changes for any role but app_tenant. A
-- role created later gets no TEMPORARY by default and needs an explicit grant if it wants one.
-- Run by a role that may not change the database's privileges, the revokes do nothing; the
-- warning then says so (docs/TENANCY_OPERATIONS.md §1.1 has the check).
--
-- What privileges cannot stop: app_tenant can call set_config('app.tenant_id', …) itself — it
-- is an ordinary setting. Isolation therefore also rests on no SQL text ever being built from
-- values (only platform/data sets the tenant, and only as a bound parameter), which
-- __tests__/data-sql-hygiene.test.ts enforces on every source file.
do $$
declare
  r record;
  db text := current_database();
begin
  execute format('revoke temporary on database %I from app_tenant', db);
  if exists (
    select 1 from pg_database d
    cross join lateral aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
    where d.datname = db and a.grantee = 0 and a.privilege_type = 'TEMPORARY'
  ) then
    for r in select rolname from pg_roles where rolname !~ '^pg_' and rolname <> 'app_tenant' loop
      execute format('grant temporary on database %I to %I', db, r.rolname);
    end loop;
    execute format('revoke temporary on database %I from public', db);
  end if;
  if has_database_privilege('app_tenant', db, 'TEMPORARY') then
    raise warning '049: app_tenant can still create temporary tables in %: run this migration as the database owner', db;
  end if;
end $$;

-- ── The transaction's tenant ─────────────────────────────────────────────────────────────────
-- An unset setting is NULL (never set in this session) or '' (set earlier in a pooled session,
-- reset at commit); both mean "no tenant". Anything else is a UUID set by withTenantTx.
create or replace function public.app_current_tenant()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(current_setting('app.tenant_id', true), '')::uuid
$$;
revoke all on function public.app_current_tenant() from public;
grant execute on function public.app_current_tenant() to app_tenant;

-- ── Tenants and their addresses ──────────────────────────────────────────────────────────────
create table if not exists public.tenants (
  id uuid primary key,
  slug text not null,
  name text not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  status_changed_at timestamptz,
  status_changed_by text,
  status_reason text,
  -- Set when a tenant is deleted: its data is purged after this time (D7).
  purge_after timestamptz,
  constraint tenants_slug_key unique (slug),
  constraint tenants_slug_shape check (slug ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'),
  constraint tenants_name_shape check (char_length(btrim(name)) between 2 and 100),
  constraint tenants_status_check check (status in ('active', 'suspended', 'deleted')),
  constraint tenants_deleted_has_purge check ((status = 'deleted') = (purge_after is not null))
);

create table if not exists public.tenant_domains (
  host text primary key,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  created_at timestamptz not null default now(),
  -- The form platform/tenancy/directory.ts normaliseHost produces: lower-case DNS labels.
  constraint tenant_domains_host_shape check (
    host = 'localhost'
    or (
      char_length(host) <= 255
      and host ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
      and host !~ '^[0-9.]+$'
    )
  )
);
create index if not exists tenant_domains_tenant_idx on public.tenant_domains (tenant_id);

-- When a deleted tenant's data was purged (D7). The row stays as the record that it existed.
alter table public.tenants add column if not exists purged_at timestamptz;

-- Operator requests that need a second operator (D7: deletion is destructive). Owner-only.
create table if not exists public.tenant_lifecycle_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  action text not null,
  reason text not null,
  requested_by text not null,
  status text not null default 'pending',
  decided_by text,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  constraint tenant_lifecycle_requests_action_check check (action in ('delete')),
  constraint tenant_lifecycle_requests_status_check
    check (status in ('pending', 'executed', 'rejected', 'expired')),
  constraint tenant_lifecycle_requests_reason_check check (char_length(btrim(reason)) between 3 and 500),
  constraint tenant_lifecycle_requests_decided check ((status = 'pending') = (decided_at is null))
);
create unique index if not exists tenant_lifecycle_requests_one_pending
  on public.tenant_lifecycle_requests (tenant_id, action) where status = 'pending';
alter table public.tenant_lifecycle_requests enable row level security;
alter table public.tenant_lifecycle_requests force row level security;
revoke all on table public.tenant_lifecycle_requests from public, anon, authenticated, app_tenant;

insert into public.tenants (id, slug, name, status)
values ('00000000-0000-4000-8000-000000000001', 'default', 'Default', 'active')
on conflict (id) do nothing;

alter table public.tenants enable row level security;
alter table public.tenants force row level security;
alter table public.tenant_domains enable row level security;
alter table public.tenant_domains force row level security;
revoke all on table public.tenants, public.tenant_domains from public, anon, authenticated, app_tenant;

-- The two questions a request may ask of the directory. Owner rights, so app_tenant needs no
-- access to the tables; each answers one row, never a listing.
create or replace function public.directory_host(p_host text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select d.tenant_id from public.tenant_domains d where d.host = p_host
$$;

-- What a request may know of a tenant. The status of any tenant (request resolution asks before
-- a tenant is set, and must refuse a suspended or deleted one); its slug, name and dates only
-- when it is the transaction's own tenant; who changed its status and why, never — operators
-- read those through the owner connection. One row, never a listing.
drop function if exists public.directory_tenant(uuid);
create function public.directory_tenant(p_tenant_id uuid)
returns table (
  id uuid,
  status text,
  slug text,
  name text,
  created_at timestamptz,
  updated_at timestamptz,
  status_changed_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select t.id, t.status,
         case when own then t.slug end,
         case when own then t.name end,
         case when own then t.created_at end,
         case when own then t.updated_at end,
         case when own then t.status_changed_at end
  from public.tenants t
  cross join lateral (select (t.id = public.app_current_tenant()) is true as own) o
  where t.id = p_tenant_id
$$;

-- A tenant's own addresses, for its administrators' settings page. Its own only.
create or replace function public.tenant_own_domains()
returns table (host text, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select d.host, d.created_at from public.tenant_domains d
  where d.tenant_id = public.app_current_tenant()
  order by d.host
$$;
revoke all on function public.tenant_own_domains() from public;
grant execute on function public.tenant_own_domains() to app_tenant;

revoke all on function public.directory_host(text) from public;
revoke all on function public.directory_tenant(uuid) from public;
grant execute on function public.directory_host(text) to app_tenant;
grant execute on function public.directory_tenant(uuid) to app_tenant;

-- ── Layered configuration ────────────────────────────────────────────────────────────────────
-- What a tenant's own administrators may set for their tenant. Everything else — dual control,
-- safety thresholds, cost guards, the trusted-agent registry, COPPA, account-status rules,
-- maintenance — governs the platform and is the operator's (D5). Marked once, when the column is
-- created: on a re-run an operator's later choice for any of these keys stands.
do $$
begin
  if not exists (
    select 1 from pg_attribute
    where attrelid = 'public.platform_config'::regclass and attname = 'tenant_overridable'
      and not attisdropped
  ) then
    alter table public.platform_config
      add column tenant_overridable boolean not null default false;
    update public.platform_config
    set tenant_overridable = true
    where key in (
      'signups_enabled',
      'default_language',
      'supported_languages',
      'profile.max_display_name_length',
      'profile.max_real_name_length',
      'max_devices_per_player',
      'agent.trajectory.retention_days',
      'song_id.min_duration_seconds',
      'song_id.max_duration_seconds'
    );
  end if;
end $$;

-- ADR-053 D6: each tenant's daily cap on all its agents' spend together, above the per-agent caps.
-- Safety tier and not tenant-settable: operators set it, per tenant or as the platform default.
insert into public.platform_config
  (key, value, default_value, description, category, value_type, min_value, max_value, permission_tier)
values (
  'agent.budget.tenant_max_cost_per_day', '100', '100',
  'Daily cap (USD) on all of one tenant''s agents together, checked after each agent''s own cap. Operators set it per tenant (ADR-053 D6).',
  'agents', 'number', '0.01', '100000', 'safety'
)
on conflict (key) do nothing;

create table if not exists public.tenant_config_overrides (
  tenant_id uuid not null default public.app_current_tenant()
    references public.tenants (id) on delete restrict,
  key text not null references public.platform_config (key) on delete cascade,
  value jsonb not null,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (tenant_id, key)
);
-- Forced below with every tenant-owned table; enabled here so the table is never without it.
alter table public.tenant_config_overrides enable row level security;

-- History and pending approvals hold changes to a tenant's values (tenant_id set) and to the
-- platform defaults (tenant_id null — the operator's, invisible to every tenant). Every row that
-- exists when the column is created was made by the one tenant there was: the column is added
-- with that tenant as its default, which fills existing rows without rewriting the table, and
-- the default then becomes the transaction's tenant. Only then: on a re-run the column exists,
-- and a platform row (tenant_id null by design) is never reassigned.
--
-- Their primary keys stay (id): ids are generated UUIDs, never caller-chosen, so no tenant can
-- take or probe another's; and tenant_id is null for platform rows, so it cannot be part of a
-- primary key.
do $$
declare
  t text;
begin
  foreach t in array array['platform_config_history', 'config_pending_approvals'] loop
    if not exists (
      select 1 from pg_attribute
      where attrelid = ('public.' || t)::regclass and attname = 'tenant_id' and not attisdropped
    ) then
      execute format(
        'alter table public.%I add column tenant_id uuid default %L::uuid',
        t, '00000000-0000-4000-8000-000000000001'
      );
    end if;
    execute format(
      'alter table public.%I alter column tenant_id set default public.app_current_tenant()', t
    );
    if not exists (select 1 from pg_constraint where conname = t || '_tenant_fkey') then
      -- Added unchecked, then validated: the check scans the table but blocks no reads.
      execute format(
        'alter table public.%I add constraint %I foreign key (tenant_id) references public.tenants (id) on delete restrict not valid',
        t, t || '_tenant_fkey'
      );
    end if;
    if exists (
      select 1 from pg_constraint where conname = t || '_tenant_fkey' and not convalidated
    ) then
      execute format('alter table public.%I validate constraint %I', t, t || '_tenant_fkey');
    end if;
  end loop;
end $$;
-- scope: what the change is to — the platform default ('platform') or the tenant's own value
-- ('tenant'). Every change before tenancy was to the platform default.
alter table public.platform_config_history add column if not exists scope text not null default 'platform';
alter table public.config_pending_approvals add column if not exists scope text not null default 'platform';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'platform_config_history_scope_check') then
    alter table public.platform_config_history
      add constraint platform_config_history_scope_check check (scope in ('platform', 'tenant'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'config_pending_approvals_scope_check') then
    alter table public.config_pending_approvals
      add constraint config_pending_approvals_scope_check check (scope in ('platform', 'tenant'));
  end if;
end $$;
alter table public.platform_config_history alter column scope set default 'tenant';
alter table public.config_pending_approvals alter column scope set default 'tenant';

-- action: what an approved change does — set the proposed value ('set'), or remove the tenant's
-- own value so it follows the platform default again ('reset'). A reset is governed like a set:
-- the same tier, two-person approval and dual-control rules.
alter table public.config_pending_approvals add column if not exists action text not null default 'set';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'config_pending_approvals_action_check') then
    alter table public.config_pending_approvals
      add constraint config_pending_approvals_action_check
      check (action in ('set', 'reset') and (action = 'set' or scope = 'tenant'));
  end if;
end $$;

create index if not exists platform_config_history_tenant_idx
  on public.platform_config_history (tenant_id, config_key, created_at desc);
create index if not exists config_pending_approvals_tenant_idx
  on public.config_pending_approvals (tenant_id, status);

-- ── tenant_id on every tenant-owned table ────────────────────────────────────────────────────
-- Every row that exists when the column is created is the default tenant's. Adding the column
-- NOT NULL with that tenant as a constant default fills every existing row without rewriting
-- the table or scanning it (Postgres 11+ stores the value once); the default then becomes the
-- transaction's tenant, for rows written from now on. A column that already exists is left as
-- it is — except one still nullable (a partial earlier run), whose nulls are the default
-- tenant's and which is then made NOT NULL through a validated check, not a second rewrite.
-- The foreign key to tenants is added unchecked and then validated (a scan, not a rewrite).
do $$
declare
  t text;
  owned text[] := array[
    'agent_approval_policy', 'agent_budgets', 'agent_trajectories', 'ai_metrics', 'app_sessions',
    'audit_log', 'consent_records', 'content_safety_audit', 'document_embeddings',
    'effect_ledger', 'group_invites', 'group_memberships', 'groups', 'guest_usage',
    'password_policy', 'proposals', 'purge_log', 'rate_limit_events', 'review_queue',
    'user_ai_context', 'user_devices', 'user_entitlements', 'user_feature_restrictions',
    'user_interactions', 'user_strikes', 'users'
  ];
begin
  foreach t in array owned loop
    if to_regclass('public.' || t) is null then
      raise exception '049: tenant-owned table % does not exist', t;
    end if;
    if not exists (
      select 1 from pg_attribute
      where attrelid = ('public.' || t)::regclass and attname = 'tenant_id' and not attisdropped
    ) then
      execute format(
        'alter table public.%I add column tenant_id uuid not null default %L::uuid',
        t, '00000000-0000-4000-8000-000000000001'
      );
    elsif exists (
      select 1 from pg_attribute
      where attrelid = ('public.' || t)::regclass and attname = 'tenant_id' and not attnotnull
    ) then
      execute format(
        'update public.%I set tenant_id = %L where tenant_id is null',
        t, '00000000-0000-4000-8000-000000000001'
      );
      execute format(
        'alter table public.%I add constraint %I check (tenant_id is not null) not valid',
        t, t || '_tenant_not_null'
      );
      execute format('alter table public.%I validate constraint %I', t, t || '_tenant_not_null');
      -- With a validated check in place, SET NOT NULL needs no scan of its own.
      execute format('alter table public.%I alter column tenant_id set not null', t);
      execute format('alter table public.%I drop constraint %I', t, t || '_tenant_not_null');
    end if;
    execute format(
      'alter table public.%I alter column tenant_id set default public.app_current_tenant()', t
    );
    if not exists (
      select 1 from pg_constraint where conname = t || '_tenant_fkey'
    ) then
      execute format(
        'alter table public.%I add constraint %I foreign key (tenant_id) references public.tenants (id) on delete restrict not valid',
        t, t || '_tenant_fkey'
      );
    end if;
    if exists (
      select 1 from pg_constraint where conname = t || '_tenant_fkey' and not convalidated
    ) then
      execute format('alter table public.%I validate constraint %I', t, t || '_tenant_fkey');
    end if;
    execute format('create index if not exists %I on public.%I (tenant_id)', t || '_tenant_idx', t);
  end loop;
end $$;

-- ── Natural keys unique per tenant ───────────────────────────────────────────────────────────
alter table public.agent_approval_policy drop constraint if exists agent_approval_policy_version_key;
drop index if exists public.agent_approval_policy_version_key;
create unique index if not exists agent_approval_policy_tenant_version_key
  on public.agent_approval_policy (tenant_id, version);

drop index if exists public.idx_budgets_unique;
create unique index if not exists idx_budgets_tenant_unique
  on public.agent_budgets (tenant_id, agent_id, scope_type, coalesce(scope_id, ''), period);

drop index if exists public.uq_embeddings_scope_chunk;
create unique index if not exists uq_embeddings_tenant_scope_chunk
  on public.document_embeddings (tenant_id, scope_key, chunk_id);

drop index if exists public.idx_effect_ledger_operation;
create unique index if not exists idx_effect_ledger_tenant_operation
  on public.effect_ledger (tenant_id, operation_id, effect_key);

drop index if exists public.password_policy_scope_unique;
create unique index if not exists password_policy_tenant_scope_unique
  on public.password_policy (tenant_id, role_id, user_id) nulls not distinct;

drop index if exists public.idx_proposals_one_live;
create unique index if not exists idx_proposals_tenant_one_live
  on public.proposals (tenant_id, operation_id)
  where status = any (array['proposed'::text, 'approved'::text, 'executed'::text]);

alter table public.purge_log drop constraint if exists purge_log_purge_id_key;
drop index if exists public.purge_log_purge_id_key;
create unique index if not exists purge_log_tenant_purge_id_key
  on public.purge_log (tenant_id, purge_id);

-- A group's id is unique only within its tenant (its primary key begins with tenant_id), so the
-- one-pending-invite and one-active-membership rules are per tenant too.
drop index if exists public.idx_invites_pending;
create unique index if not exists idx_invites_tenant_pending
  on public.group_invites (tenant_id, group_id, invitee_id) where status = 'pending';

drop index if exists public.idx_memberships_active;
create unique index if not exists idx_memberships_tenant_active
  on public.group_memberships (tenant_id, group_id, user_id) where left_at is null;

-- Unique keys that stay platform-wide, on purpose (the replay checks every other unique key on a
-- tenant-owned table includes tenant_id):
--   users (id), users (cognito_sub) — one identity, one tenant (D2): an identity's subject and
--     its user id name exactly one account on the platform, which is what keeps one identity
--     from holding accounts in two tenants.
--   user_devices (user_id, device_id), user_entitlements (user_id, entitlement_group_id) — keyed
--     on a user id, which is platform-wide unique and of one tenant, so the key is that tenant's.
--   platform_config_history (id), config_pending_approvals (id) — generated UUIDs, never chosen
--     by a caller; tenant_id is null for platform rows, so it cannot be in the primary key.

-- ── Foreign keys that stay inside a tenant ───────────────────────────────────────────────────
-- Every single-column foreign key from one tenant-scoped table to another becomes
-- (tenant_id, column) → (tenant_id, key), keeping its actions. The parent gets the unique key
-- it needs. A SET NULL or SET DEFAULT action would also clear tenant_id, so none may exist.
do $$
declare
  fk record;
  scoped text[] := array[
    'agent_approval_policy', 'agent_budgets', 'agent_trajectories', 'ai_metrics', 'app_sessions',
    'audit_log', 'consent_records', 'content_safety_audit', 'document_embeddings',
    'effect_ledger', 'group_invites', 'group_memberships', 'groups', 'guest_usage',
    'password_policy', 'proposals', 'purge_log', 'rate_limit_events', 'review_queue',
    'user_ai_context', 'user_devices', 'user_entitlements', 'user_feature_restrictions',
    'user_interactions', 'user_strikes', 'users',
    'platform_config_history', 'config_pending_approvals'
  ];
  on_delete text;
  on_update text;
  parent_key text;
begin
  for fk in
    select c.conname, c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent,
           a.attname as col, pa.attname as refcol, c.confdeltype, c.confupdtype
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    join pg_attribute pa on pa.attrelid = c.confrelid and pa.attnum = c.confkey[1]
    where c.contype = 'f'
      and c.connamespace = 'public'::regnamespace
      and array_length(c.conkey, 1) = 1
      and c.conrelid::regclass::text = any (scoped)
      and c.confrelid::regclass::text = any (scoped)
      and a.attname <> 'tenant_id'
  loop
    if fk.confdeltype in ('n', 'd') or fk.confupdtype in ('n', 'd') then
      raise exception '049: % on % sets a column on delete/update; it would clear tenant_id',
        fk.conname, fk.child;
    end if;
    on_delete := case fk.confdeltype when 'c' then 'cascade' when 'r' then 'restrict' else 'no action' end;
    on_update := case fk.confupdtype when 'c' then 'cascade' when 'r' then 'restrict' else 'no action' end;
    parent_key := fk.parent || '_tenant_' || fk.refcol || '_key';
    if not exists (select 1 from pg_constraint where conname = parent_key) then
      execute format('alter table public.%I add constraint %I unique (tenant_id, %I)',
        fk.parent, parent_key, fk.refcol);
    end if;
    execute format('alter table public.%I drop constraint %I', fk.child, fk.conname);
    -- Added unchecked, then validated: a scan of the child, not a rewrite.
    execute format(
      'alter table public.%I add constraint %I foreign key (tenant_id, %I) references public.%I (tenant_id, %I) on delete %s on update %s not valid',
      fk.child, fk.conname, fk.col, fk.parent, fk.refcol, on_delete, on_update
    );
    execute format('alter table public.%I validate constraint %I', fk.child, fk.conname);
  end loop;
end $$;

-- Columns that record who acted — not whose the row is — reference no user: an operator acting
-- in a tenant is not one of its users, and an attribution must not be able to block the action
-- it records (or be erased with the person). The audit log already names actors this way.
alter table public.platform_config drop constraint if exists platform_config_updated_by_fkey;
alter table public.platform_config_history drop constraint if exists platform_config_history_changed_by_fkey;
alter table public.config_pending_approvals drop constraint if exists config_pending_approvals_requested_by_fkey;
alter table public.config_pending_approvals drop constraint if exists config_pending_approvals_reviewed_by_fkey;
alter table public.user_entitlements drop constraint if exists player_entitlements_granted_by_fkey;
alter table public.user_entitlements drop constraint if exists player_entitlements_revoked_by_fkey;
alter table public.entitlement_groups drop constraint if exists entitlement_groups_created_by_fkey;

-- ── Primary keys inside a tenant ─────────────────────────────────────────────────────────────
-- A key that is unique across tenants lets one tenant's insert collide with another's row — a
-- refused write that also tells it the id exists elsewhere — and lets a caller-chosen id (an
-- activity session, a policy version, a user's AI context) be taken by another tenant first.
-- Every tenant-owned table's primary key therefore begins with tenant_id. users is the one
-- exception: its id is the identity provider's subject, and an identity belongs to exactly one
-- tenant (D2), so it stays unique everywhere.
do $$
declare
  t record;
  cols text;
begin
  for t in
    select c.conrelid::regclass::text as tbl, c.conname, c.oid
    from pg_constraint c
    where c.contype = 'p' and c.connamespace = 'public'::regnamespace
      and c.conrelid::regclass::text = any (array[
        'agent_approval_policy', 'agent_budgets', 'agent_trajectories', 'ai_metrics',
        'app_sessions', 'audit_log', 'consent_records', 'content_safety_audit',
        'document_embeddings', 'effect_ledger', 'group_invites', 'group_memberships', 'groups',
        'guest_usage', 'password_policy', 'proposals', 'purge_log', 'rate_limit_events',
        'review_queue', 'user_ai_context', 'user_devices', 'user_entitlements',
        'user_feature_restrictions', 'user_interactions', 'user_strikes'
      ])
      and not exists (
        select 1 from unnest(c.conkey) k
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k
        where a.attname = 'tenant_id'
      )
  loop
    select string_agg(quote_ident(a.attname), ', ' order by u.ord) into cols
    from pg_constraint c
    cross join lateral unnest(c.conkey) with ordinality u(k, ord)
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = u.k
    where c.oid = t.oid;
    -- No foreign key uses this key any more: the previous step pointed every one at the
    -- (tenant_id, key) constraint. Without cascade, a dependency left behind is an error.
    execute format('alter table public.%I drop constraint %I', t.tbl, t.conname);
    execute format('alter table public.%I add constraint %I primary key (tenant_id, %s)',
      t.tbl, t.conname, cols);
  end loop;
end $$;

-- ── Row-level security: drop the old policies, forced, one policy per table ──────────────────
-- Dropped by name: the auth.uid()-era and service-role policies the migrations before this one
-- created (001–048; a table renamed since keeps its policies, so both names are listed), and
-- this migration's own, on the tables it manages, so a re-run recreates them. A policy a later
-- migration adds is never touched. The replay fails on any policy left that is not the
-- platform's own, so a legacy policy missing here is found.
do $$
declare
  p record;
  managed text[] := array[
    'agent_approval_policy', 'agent_budgets', 'agent_trajectories', 'ai_metrics', 'app_sessions',
    'audit_log', 'consent_records', 'content_safety_audit', 'document_embeddings',
    'effect_ledger', 'group_invites', 'group_memberships', 'groups', 'guest_usage',
    'password_policy', 'proposals', 'purge_log', 'rate_limit_events', 'review_queue',
    'user_ai_context', 'user_devices', 'user_entitlements', 'user_feature_restrictions',
    'user_interactions', 'user_strikes', 'users',
    'platform_config_history', 'config_pending_approvals',
    'permissions', 'roles', 'role_permissions', 'role_inheritance', 'entitlement_groups',
    'entitlement_permissions', 'deletion_manifest', 'platform_config',
    'tenant_config_overrides', 'user_deletions'
  ];
begin
  for p in
    select pol.tablename, pol.policyname
    from pg_policies pol
    join (values
      ('player_entitlements', 'Admins can read all player entitlements'),
      ('user_entitlements', 'Admins can read all player entitlements'),
      ('players', 'Admins can read all players'),
      ('users', 'Admins can read all players'),
      ('audit_log', 'Admins can read audit log'),
      ('deletion_manifest', 'Admins can read deletion manifest'),
      ('entitlement_groups', 'Entitlement groups are readable by all authenticated users'),
      ('entitlement_permissions', 'Entitlement permissions are readable by all authenticated users'),
      ('guest_config', 'Guest config is readable by all authenticated users'),
      ('password_policy', 'Password policy is readable by all authenticated users'),
      ('permissions', 'Permissions are readable by all authenticated users'),
      ('player_devices', 'Players can delete their own devices'),
      ('user_devices', 'Players can delete their own devices'),
      ('consent_records', 'Players can insert their own consent records'),
      ('audit_log', 'Players can read their own audit entries'),
      ('consent_records', 'Players can read their own consent records'),
      ('player_devices', 'Players can read their own devices'),
      ('user_devices', 'Players can read their own devices'),
      ('player_entitlements', 'Players can read their own entitlements'),
      ('user_entitlements', 'Players can read their own entitlements'),
      ('players', 'Players can read their own record'),
      ('users', 'Players can read their own record'),
      ('players', 'Players can update their own record'),
      ('users', 'Players can update their own record'),
      ('role_inheritance', 'Role inheritance is readable by all authenticated users'),
      ('role_permissions', 'Role permissions are readable by all authenticated users'),
      ('roles', 'Roles are readable by all authenticated users'),
      ('document_embeddings', 'service_role_embeddings'),
      ('user_interactions', 'service_role_interactions'),
      ('user_ai_context', 'service_role_user_context'),
      ('agent_approval_policy', 'agent_approval_policy_service_all'),
      ('app_sessions', 'app_sessions_service_all'),
      ('applied_migrations', 'applied_migrations_service_all'),
      ('agent_budgets', 'budgets_service_all'),
      ('config_pending_approvals', 'cpa_service_all'),
      ('effect_ledger', 'effect_ledger_service_all'),
      ('groups', 'groups_insert_auth'),
      ('groups', 'groups_select_member'),
      ('groups', 'groups_service_all'),
      ('groups', 'groups_update_owner'),
      ('group_invites', 'invites_insert_member'),
      ('group_invites', 'invites_select_invitee'),
      ('group_invites', 'invites_select_member'),
      ('group_invites', 'invites_service_all'),
      ('group_invites', 'invites_update_invitee'),
      ('group_memberships', 'memberships_select_member'),
      ('group_memberships', 'memberships_service_all'),
      ('platform_config_history', 'pch_service_all'),
      ('platform_config', 'platform_config_service_all'),
      ('proposals', 'proposals_service_all'),
      ('purge_log', 'purge_log_service_all'),
      ('review_queue', 'review_queue_service_all'),
      ('user_strikes', 'strikes_service_all'),
      ('agent_trajectories', 'trajectories_service_all'),
      ('user_feature_restrictions', 'user_feature_restrictions_service_all')
    ) as legacy (tablename, policyname)
      on legacy.tablename = pol.tablename and legacy.policyname = pol.policyname
    where pol.schemaname = 'public'
    union
    select pol.tablename, pol.policyname
    from pg_policies pol
    where pol.schemaname = 'public' and pol.tablename = any (managed)
      and pol.policyname in ('tenant_isolation', 'catalog_read', 'tenant_config_read',
        'tenant_config_insert', 'tenant_config_update', 'tenant_config_delete')
  loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

do $$
declare
  t text;
  owned text[] := array[
    'agent_approval_policy', 'agent_budgets', 'agent_trajectories', 'ai_metrics', 'app_sessions',
    'audit_log', 'consent_records', 'content_safety_audit', 'document_embeddings',
    'effect_ledger', 'group_invites', 'group_memberships', 'groups', 'guest_usage',
    'password_policy', 'proposals', 'purge_log', 'rate_limit_events', 'review_queue',
    'user_ai_context', 'user_devices', 'user_entitlements', 'user_feature_restrictions',
    'user_interactions', 'user_strikes', 'users',
    'platform_config_history', 'config_pending_approvals'
  ];
  catalog text[] := array[
    'permissions', 'roles', 'role_permissions', 'role_inheritance', 'entitlement_groups',
    'entitlement_permissions', 'deletion_manifest', 'platform_config'
  ];
begin
  foreach t in array owned || catalog || array['tenant_config_overrides', 'applied_migrations'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
  foreach t in array owned loop
    execute format(
      'create policy tenant_isolation on public.%I for all to app_tenant using (tenant_id = public.app_current_tenant()) with check (tenant_id = public.app_current_tenant())',
      t
    );
    execute format('grant select, insert, update, delete on table public.%I to app_tenant', t);
  end loop;
  foreach t in array catalog loop
    execute format('create policy catalog_read on public.%I for select to app_tenant using (true)', t);
    execute format('revoke insert, update, delete, truncate on table public.%I from app_tenant', t);
    execute format('grant select on table public.%I to app_tenant', t);
  end loop;
end $$;

-- A tenant's own values. It reads all of its own — including an operator's value for a key it
-- may not set, which is what applies to it — but inserts, changes and removes only values of
-- keys a tenant may set: one policy per command, because a DELETE evaluates no WITH CHECK, and
-- an UPDATE's USING decides which rows it may touch at all. An operator's value for any other
-- key (set on the owner connection) stays out of the tenant's reach.
create policy tenant_config_read on public.tenant_config_overrides
  for select to app_tenant
  using (tenant_id = public.app_current_tenant());
create policy tenant_config_insert on public.tenant_config_overrides
  for insert to app_tenant
  with check (
    tenant_id = public.app_current_tenant()
    and exists (
      select 1 from public.platform_config c where c.key = tenant_config_overrides.key and c.tenant_overridable
    )
  );
create policy tenant_config_update on public.tenant_config_overrides
  for update to app_tenant
  using (
    tenant_id = public.app_current_tenant()
    and exists (
      select 1 from public.platform_config c where c.key = tenant_config_overrides.key and c.tenant_overridable
    )
  )
  with check (
    tenant_id = public.app_current_tenant()
    and exists (
      select 1 from public.platform_config c where c.key = tenant_config_overrides.key and c.tenant_overridable
    )
  );
create policy tenant_config_delete on public.tenant_config_overrides
  for delete to app_tenant
  using (
    tenant_id = public.app_current_tenant()
    and exists (
      select 1 from public.platform_config c where c.key = tenant_config_overrides.key and c.tenant_overridable
    )
  );
grant select, insert, update, delete on table public.tenant_config_overrides to app_tenant;

-- Each erasure a tenant carries out (GDPR Art. 17): when the account was anonymized, when its data
-- may be purged, and when it was. Outlives the account it describes (no foreign key to users).
-- Before this, the per-user record was written to deletion_manifest — the platform's registry of
-- deletion modules, which has no per-user columns — so it was never written.
create table if not exists public.user_deletions (
  tenant_id uuid not null default public.app_current_tenant()
    references public.tenants (id) on delete restrict,
  user_id uuid not null,
  requested_by text not null,
  soft_deleted_at timestamptz not null default now(),
  purge_after timestamptz not null default (now() + interval '30 days'),
  purged_at timestamptz,
  modules jsonb not null default '[]'::jsonb,
  primary key (tenant_id, user_id),
  constraint user_deletions_modules_array check (jsonb_typeof(modules) = 'array')
);
alter table public.user_deletions enable row level security;
alter table public.user_deletions force row level security;
drop policy if exists tenant_isolation on public.user_deletions;
create policy tenant_isolation on public.user_deletions
  for all to app_tenant
  using (tenant_id = public.app_current_tenant())
  with check (tenant_id = public.app_current_tenant());
grant select, insert, update, delete on table public.user_deletions to app_tenant;
revoke all on table public.user_deletions from anon, authenticated;
grant all on table public.user_deletions to service_role;

-- Migration records are the owner's.
revoke all on table public.applied_migrations from app_tenant;

-- Sequences behind tenant-owned tables.
grant usage, select on all sequences in schema public to app_tenant;

-- ── Close the public key's access (TASK-114) ─────────────────────────────────────────────────
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
-- Functions are executable by PUBLIC by default, which anon and authenticated inherit; so the
-- platform's own functions are closed to PUBLIC and granted to the roles that call them.
-- Extension functions (pgvector's operators) stay as the extension installed them.
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and not exists (
        select 1 from pg_depend d
        where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
      )
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;
-- Tables, sequences and functions created later are not opened to the public key either.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- Realtime (Supabase only): channels are private and named `t:<tenant>:<name>`
-- (platform/realtime/tenant-topic.ts). A browser may read or send on a topic only of the tenant
-- its token names (a `tenant_id` claim); the server broadcasts with its own credentials. Where
-- there is no Realtime schema (other hosts, the replay), there is nothing to do.
do $$
begin
  if to_regclass('realtime.messages') is not null
     and to_regprocedure('auth.jwt()') is not null
     and to_regprocedure('realtime.topic()') is not null then
    execute 'drop policy if exists tenant_topics_read on realtime.messages';
    execute 'drop policy if exists tenant_topics_write on realtime.messages';
    execute $p$
      create policy tenant_topics_read on realtime.messages for select to authenticated
      using (
        (auth.jwt() ->> 'tenant_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and split_part(realtime.topic(), ':', 1) = 't'
        and split_part(realtime.topic(), ':', 2) = (auth.jwt() ->> 'tenant_id')
      )
    $p$;
    execute $p$
      create policy tenant_topics_write on realtime.messages for insert to authenticated
      with check (
        (auth.jwt() ->> 'tenant_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and split_part(realtime.topic(), ':', 1) = 't'
        and split_part(realtime.topic(), ':', 2) = (auth.jwt() ->> 'tenant_id')
      )
    $p$;
  end if;
end $$;

-- ── Functions ────────────────────────────────────────────────────────────────────────────────
drop function if exists public.is_admin();
drop function if exists public.has_permission(text);
drop function if exists public.get_current_user_id();

-- Runs as its caller now: under row-level security, the budget row it adds is the caller's
-- tenant's (tenant_id defaults to the transaction's tenant; the conflict key includes it).
create or replace function public.agent_budget_consume(
  p_agent_id text,
  p_scope_type trajectory_scope,
  p_scope_id text,
  p_period text,
  p_delta_usd numeric,
  p_delta_steps integer
)
returns table (used_usd numeric, used_steps integer)
language plpgsql
security invoker
set search_path = public
as $function$
begin
  if public.app_current_tenant() is null then
    raise exception 'agent_budget_consume: no tenant';
  end if;
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
  on conflict (tenant_id, agent_id, scope_type, coalesce(scope_id, ''), period)
  do update
    set used_usd   = b.used_usd + p_delta_usd,
        used_steps = b.used_steps + p_delta_steps,
        updated_at = now()
  returning b.used_usd, b.used_steps
    into used_usd, used_steps;

  return next;
end;
$function$;

-- One step's spend, added to the agent's own budget and to its tenant's total together (ADR-053
-- D6): one transaction, the tenant's total row first — every consume in a tenant takes that row
-- lock first, so they serialise on it in one order (no deadlock) and each sees the totals the one
-- before it left. The two counters can never disagree: a failure adds to neither. The tenant's
-- total is the reserved scope '*tenant*' (platform/agents/budget-tracker.ts TENANT_TOTAL_AGENT).
-- A step's cost is known only once it has run, so a cap stops the next step, not the one that
-- crossed it; the tracker checks both totals before every step.
create or replace function public.agent_budget_consume_with_tenant(
  p_agent_id text,
  p_scope_type trajectory_scope,
  p_scope_id text,
  p_period text,
  p_delta_usd numeric,
  p_delta_steps integer
)
returns table (used_usd numeric, used_steps integer, tenant_used_usd numeric, tenant_used_steps integer)
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if p_agent_id is null or p_agent_id = '*tenant*' then
    raise exception 'agent_budget_consume_with_tenant: invalid agent id';
  end if;
  select c.used_usd, c.used_steps into tenant_used_usd, tenant_used_steps
  from public.agent_budget_consume('*tenant*', 'platform'::public.trajectory_scope, null, p_period,
                                   p_delta_usd, p_delta_steps) c;
  select c.used_usd, c.used_steps into used_usd, used_steps
  from public.agent_budget_consume(p_agent_id, p_scope_type, p_scope_id, p_period,
                                   p_delta_usd, p_delta_steps) c;
  return next;
end;
$function$;
revoke all on function public.agent_budget_consume_with_tenant(text, trajectory_scope, text, text, numeric, integer) from public, anon, authenticated;

-- The guest counter's conflict key is now its tenant-scoped primary key. Runs as its caller.
create or replace function public.guest_allowance_consume(p_guest_id text, p_limit integer)
returns table (allowed boolean, used integer)
language plpgsql
security invoker
set search_path = public
as $function$
declare
  v_used integer;
begin
  if public.app_current_tenant() is null then
    raise exception 'guest_allowance_consume: no tenant';
  end if;
  if p_guest_id is null or p_guest_id !~ '^guest_[a-z0-9]{32}$' then
    raise exception 'guest_allowance_consume: invalid guest id';
  end if;
  if p_limit is null or p_limit < 1 then
    raise exception 'guest_allowance_consume: invalid limit';
  end if;

  insert into guest_usage as g (guest_id, translations_used)
  values (p_guest_id, 1)
  on conflict (tenant_id, guest_id) do update
    set translations_used = g.translations_used + 1,
        last_used_at      = now()
    where g.translations_used < p_limit
  returning g.translations_used into v_used;

  if v_used is null then
    -- At the limit: the conditional update matched nothing. Report the current count.
    select g.translations_used into v_used from guest_usage g where g.guest_id = p_guest_id;
    return query select false, coalesce(v_used, p_limit);
  else
    return query select true, v_used;
  end if;
end;
$function$;

-- The rate limiter's window (039), serialised per tenant and bucket rather than per bucket name.
create or replace function public.rate_limit_hit(
  p_bucket text,
  p_limit integer,
  p_window_seconds integer,
  p_consume boolean default true
)
returns table (allowed boolean, used integer, retry_after_seconds integer, reset_at bigint)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_now    timestamptz := clock_timestamp();
  v_start  timestamptz;
  v_used   integer;
  v_oldest timestamptz;
begin
  if p_bucket is null or char_length(p_bucket) not between 1 and 512 then
    raise exception 'rate_limit_hit: invalid bucket';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 1000000 then
    raise exception 'rate_limit_hit: invalid limit';
  end if;
  if p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'rate_limit_hit: invalid window';
  end if;

  -- One caller at a time per bucket of a tenant; released when the transaction ends. The tenant
  -- is in the key: a bucket's rows are per tenant (row-level security), so two tenants' buckets
  -- of one name never wait on each other — nor learn, by waiting, that the other is busy.
  perform pg_advisory_xact_lock(
    hashtextextended(coalesce(public.app_current_tenant()::text, '-') || '/' || p_bucket, 0)
  );

  v_start := v_now - make_interval(secs => p_window_seconds);
  delete from rate_limit_events e where e.bucket = p_bucket and e.at <= v_start;

  select count(*)::integer, min(e.at) into v_used, v_oldest
  from rate_limit_events e where e.bucket = p_bucket;

  if random() < 0.01 then
    delete from rate_limit_events e where e.at < v_now - interval '1 day';
  end if;

  if v_used >= p_limit then
    return query select
      false,
      v_used,
      greatest(1, ceil(extract(epoch from (v_oldest + make_interval(secs => p_window_seconds) - v_now)))::integer),
      ceil(extract(epoch from (v_oldest + make_interval(secs => p_window_seconds))))::bigint;
    return;
  end if;

  if p_consume then
    insert into rate_limit_events (bucket, at) values (p_bucket, v_now);
    v_used := v_used + 1;
    if v_oldest is null then
      v_oldest := v_now;
    end if;
  end if;

  return query select
    true,
    v_used,
    0,
    ceil(extract(epoch from (coalesce(v_oldest, v_now) + make_interval(secs => p_window_seconds))))::bigint;
end;
$$;

-- The request role calls these; they run as the caller, under row-level security.
grant execute on function public.agent_budget_consume(text, trajectory_scope, text, text, numeric, integer) to app_tenant;
grant execute on function public.agent_budget_consume_with_tenant(text, trajectory_scope, text, text, numeric, integer) to app_tenant;
grant execute on function public.rate_limit_hit(text, integer, integer, boolean) to app_tenant;
grant execute on function public.rate_limit_reset(text) to app_tenant;
grant execute on function public.guest_allowance_consume(text, integer) to app_tenant;

-- The service role keeps what it had until the last server path leaves it (ADR-053 D4).
grant execute on function public.agent_budget_consume(text, trajectory_scope, text, text, numeric, integer) to service_role;
grant execute on function public.rate_limit_hit(text, integer, integer, boolean) to service_role;
grant execute on function public.rate_limit_reset(text) to service_role;
grant execute on function public.guest_allowance_consume(text, integer) to service_role;
grant all on table public.tenants, public.tenant_domains, public.tenant_config_overrides to service_role;

-- ── Tenant export and purge (D7) — the owner's only ──────────────────────────────────────────
-- Every table that holds a tenant's rows, children before parents: the order a purge deletes in.
create or replace function public.tenant_tables()
returns table (table_name text)
language sql
stable
set search_path = ''
as $$
  with recursive owned as (
    select c.oid, c.relname::text as name
    from pg_class c
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
      and c.relname not in ('tenants', 'tenant_domains', 'tenant_lifecycle_requests')
  ),
  -- depth: how far a table is from the leaves of the foreign-key graph among owned tables
  edges as (
    select distinct con.conrelid as child, con.confrelid as parent
    from pg_constraint con
    where con.contype = 'f' and con.conrelid in (select oid from owned)
      and con.confrelid in (select oid from owned) and con.conrelid <> con.confrelid
  ),
  depth (oid, d) as (
    select o.oid, 0 from owned o where not exists (select 1 from edges e where e.parent = o.oid)
    union all
    select e.parent, depth.d + 1 from edges e join depth on depth.oid = e.child where depth.d < 50
  )
  select o.name from owned o
  left join (select oid, max(d) as d from depth group by oid) m on m.oid = o.oid
  order by coalesce(m.d, 0), o.name
$$;

-- One table's rows of one tenant, as JSON (the export reads them through a cursor).
create or replace function public.tenant_export_rows(p_table text, p_tenant uuid)
returns setof jsonb
language plpgsql
stable
set search_path = ''
as $$
begin
  if not exists (select 1 from public.tenant_tables() t where t.table_name = p_table) then
    raise exception 'tenant_export_rows: % is not a tenant table', p_table;
  end if;
  return query execute format('select to_jsonb(r) from public.%I r where r.tenant_id = $1', p_table)
    using p_tenant;
end;
$$;

-- Delete every row a tenant owns, children first; the tenant and its request history remain.
-- The tenant's row is locked first and its state read under the lock: a restore (which changes
-- that row only while it is deleted and not yet purged) either commits before — and the purge
-- refuses — or waits, and then finds it purged. Never a "restored" tenant with no data.
create or replace function public.tenant_purge(p_tenant uuid)
returns table (table_name text, deleted bigint)
language plpgsql
set search_path = ''
as $$
declare
  t record;
  n bigint;
  v_status text;
begin
  select tn.status into v_status from public.tenants tn where tn.id = p_tenant for update;
  if v_status is distinct from 'deleted' then
    raise exception 'tenant_purge: tenant % is not deleted', p_tenant;
  end if;
  for t in select tt.table_name from public.tenant_tables() tt loop
    execute format('delete from public.%I where tenant_id = $1', t.table_name) using p_tenant;
    get diagnostics n = row_count;
    table_name := t.table_name;
    deleted := n;
    return next;
  end loop;
  delete from public.tenant_domains where tenant_id = p_tenant;
  update public.tenants set purged_at = now(), updated_at = now() where id = p_tenant;
end;
$$;

revoke all on function public.tenant_tables() from public, anon, authenticated, app_tenant;
revoke all on function public.tenant_export_rows(text, uuid) from public, anon, authenticated, app_tenant;
revoke all on function public.tenant_purge(uuid) from public, anon, authenticated, app_tenant;

-- ── The operator ─────────────────────────────────────────────────────────────────────────────
-- Platform-wide powers — tenants and their lifecycle, a shared deployment's platform defaults,
-- the role and entitlement catalogs, cross-tenant views — need platform_operate. Every other
-- admin permission acts within the admin's own tenant (D5).
INSERT INTO permissions (code, display_name, description, category) VALUES
  ('platform_operate', 'Operate the Platform', 'Manage tenants, platform defaults and catalogs across tenants', 'admin')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'super_admin'
  AND p.code IN ('platform_operate')
ON CONFLICT (role_id, permission_id) DO NOTHING;

insert into public.applied_migrations (filename, confidence, note)
values (
  '049_tenancy.sql',
  'verified',
  'ADR-053: tenants and domains, tenant_id on every tenant-owned table, tenant-scoped foreign keys and uniques, forced RLS for app_tenant, layered config, public key closed (TASK-114).'
)
on conflict (filename) do nothing;

