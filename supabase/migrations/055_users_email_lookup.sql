-- ============================================================================
-- 055_users_email_lookup.sql — an account is found by its address with an index (TASK-174,
-- review 15 M4)
--
-- The identity re-link (scripts/relink-identity.mjs, platform/auth/identity-relink.ts) finds
-- the accounts with an address as `lower(btrim(email)) = …` in a tenant (or in each tenant), and
-- provisioning's ban carry-over compares an address folded the same way. Nothing indexed that
-- expression: every lookup read the whole users table, and a bulk re-link (--all) read it once
-- per address — quadratic in the accounts. This index makes each lookup an index scan
-- (one statement per chunk of 500 addresses; docs/TENANCY_OPERATIONS.md §6.5 has the timing at
-- 100,000 accounts).
--
-- Lock: like every migration here it runs in one transaction (scripts/migration-replay.sh,
-- the SQL Editor), where `create index concurrently` is not allowed — so the build holds a SHARE
-- lock on users: reads go on, writes to users (a first sign-in's row, a profile change) wait
-- until it is built (about 0.2 s at 100,000 accounts). On a much larger table, build it first
-- outside a transaction with the same name, and this migration then changes nothing:
--
--   create index concurrently if not exists users_tenant_email_lookup_idx
--     on public.users (tenant_id, (lower(btrim(email))));
--
-- Idempotent and re-runnable: the index is created once; a second run changes nothing.
-- ============================================================================

create index if not exists users_tenant_email_lookup_idx
  on public.users (tenant_id, (lower(btrim(email))));

comment on index public.users_tenant_email_lookup_idx is
  'Accounts by tenant and address as compared (lower(btrim(email))): the identity re-link and the ban carry-over (migration 055, TASK-174).';

insert into public.applied_migrations (filename, confidence, note)
values (
  '055_users_email_lookup.sql',
  'verified',
  'users (tenant_id, lower(btrim(email))) index: accounts are found by their address without reading the table — the identity re-link at scale (TASK-174, review 15 M4).'
)
on conflict (filename) do nothing;
