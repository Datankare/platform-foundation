-- ============================================================================
-- 056_users_list_indexes.sql — the admin console's Users list in either order without reading the
-- tenant's users to sort them (TASK-185)
--
-- GET /api/admin/users pages a tenant's accounts by created or by last sign-in, at most 100 a
-- page. Nothing indexed either order within a tenant. This adds:
--
--   users_tenant_created_idx     (tenant_id, created_at desc, id) — newest first (`order by
--                                created_at desc, id`); read backwards it serves oldest first
--                                (`order by created_at asc, id desc`);
--   users_tenant_last_login_idx  (tenant_id, last_login_at desc nulls last, id) — most recent
--                                sign-in first; read backwards, least recent first with the
--                                never-signed-in first (`asc nulls first, id desc`).
--
-- Search is not indexed. It is a substring match (`ilike '%' || $1 || '%'`) run as the request
-- role under row-level security, where `ilike` is not leakproof: Postgres applies the tenant
-- policy before it and does not use a trigram index for it (measured on a trigram index: used by
-- the owner role, never by app_tenant). A search therefore reads one tenant's accounts, bounded by
-- the request's statement timeout (DATABASE_STATEMENT_TIMEOUT_MS, 10 s by default), the page size
-- (at most 100) and the offset cap (900 with a search).
--
-- users.last_login_at is filled from the audit log by 057, in its own transaction, so these
-- builds' locks are not held while it runs.
--
-- Lock: like every migration here it runs in one transaction (scripts/migration-replay.sh, the
-- SQL Editor), so each build holds a SHARE lock on users until this commits: reads go on, writes
-- to users (a first sign-in's row, a sign-in's last_login_at, a profile change) wait. Each is a
-- btree over (tenant_id, a timestamp, id) — the size of 055's, about 0.1–0.2 s at 100,000
-- accounts. On a much larger table, build them first outside a transaction with
-- `create index concurrently if not exists` and the same definitions; this migration then changes
-- nothing but its record.
--
-- Idempotent and re-runnable: each index is created once; a second run changes nothing.
-- ============================================================================

create index if not exists users_tenant_created_idx
  on public.users (tenant_id, created_at desc, id);

create index if not exists users_tenant_last_login_idx
  on public.users (tenant_id, last_login_at desc nulls last, id);

comment on index public.users_tenant_created_idx is
  'The admin Users list by created, either direction (migration 056, TASK-185).';
comment on index public.users_tenant_last_login_idx is
  'The admin Users list by last sign-in, either direction (migration 056, TASK-185).';

insert into public.applied_migrations (filename, confidence, note)
values (
  '056_users_list_indexes.sql',
  'verified',
  'users (tenant_id, created_at desc, id) and (tenant_id, last_login_at desc nulls last, id): the admin Users list in either order (TASK-185).'
)
on conflict (filename) do nothing;
