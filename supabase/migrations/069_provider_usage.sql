-- 069_provider_usage.sql — what a prepaid provider has billed, counted (TASK-212, N-77)
--
-- ACRCloud's song identification is prepaid: the account holds a credit, and the credit — not a
-- key's expiry — is what ends the service. ACRCloud offers no API that reports an account's
-- balance or remaining quota, and its identification responses carry no quota header (its
-- documentation lists none: docs.acrcloud.com, "Identification API" and "Base Projects"); the
-- only sign was the exhaustion itself (status 3003, "Request count limit exceeded"). So the
-- platform counts what the provider bills and warns before the credit runs out
-- (platform/voice/acrcloud-usage.ts, against ACRCLOUD_CREDIT_ALERT_AT).
--
--   provider_usage   one row per provider: the billable units counted since `since`, in halves
--                    (ACRCloud bills a request with a result as one and one with no result as a
--                    half: docs.acrcloud.com, FAQ "Definition of Terms"). Platform-owned: a
--                    provider account serves the whole deployment, not one tenant. No policy:
--                    neither app_tenant nor the public roles reach the table itself.
--   provider_usage_add(provider, halves)   adds and answers the new total, in one statement
--                    (concurrent requests on any instance never lose a count).
--   provider_usage_read(provider)          the total and since when; no row, nothing counted.
--
-- Both are owner-rights functions granted to app_tenant only, each acting on one named row (a
-- provider name of lower-case letters, digits and hyphens). Idempotent; a new, empty table: no
-- lock on anything that exists.

create table if not exists public.provider_usage (
  provider text primary key,
  billable_halves bigint not null default 0,
  since timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint provider_usage_provider_shape check (provider ~ '^[a-z][a-z0-9-]{0,39}$'),
  constraint provider_usage_halves_nonnegative check (billable_halves >= 0)
);

comment on table public.provider_usage is
  'Billable units a prepaid provider has counted, in halves (TASK-212, N-77). Platform-owned; reached only through provider_usage_add and provider_usage_read.';

alter table public.provider_usage enable row level security;
alter table public.provider_usage force row level security;
revoke all on table public.provider_usage from public, anon, authenticated;
grant all on table public.provider_usage to service_role;

create or replace function public.provider_usage_add(p_provider text, p_halves integer)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_total bigint;
begin
  if p_provider is null or p_provider !~ '^[a-z][a-z0-9-]{0,39}$' then
    raise exception 'provider_usage_add: invalid provider';
  end if;
  if p_halves is null or p_halves < 0 or p_halves > 1000 then
    raise exception 'provider_usage_add: invalid count';
  end if;
  insert into public.provider_usage as u (provider, billable_halves)
  values (p_provider, p_halves)
  on conflict (provider) do update
    set billable_halves = u.billable_halves + excluded.billable_halves,
        updated_at = now()
  returning u.billable_halves into v_total;
  return v_total;
end;
$$;

create or replace function public.provider_usage_read(p_provider text)
returns table (billable_halves bigint, since timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select u.billable_halves, u.since from public.provider_usage u where u.provider = p_provider
$$;

revoke all on function public.provider_usage_add(text, integer) from public, anon, authenticated;
revoke all on function public.provider_usage_read(text) from public, anon, authenticated;
grant execute on function public.provider_usage_add(text, integer) to app_tenant;
grant execute on function public.provider_usage_read(text) to app_tenant;

insert into public.applied_migrations (filename, confidence, note, checksum)
values (
  '069_provider_usage.sql',
  'verified',
  'TASK-212 (N-77): provider_usage (platform-owned, billable units in halves) with provider_usage_add and provider_usage_read for app_tenant — the ACRCloud credit is counted and warned on before it runs out.',
  'sha256:32c1c1ab4702b60a1611ca531ec3b92c78ad0121eafb49741bdb99d3066ec108'
)
on conflict (filename) do update set checksum = excluded.checksum;
