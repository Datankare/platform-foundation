-- 070_auth_sessions.sql — server-side sign-in sessions (TASK-214, ADR-057, SEC-016, N-30)
--
-- Until now the browser held the identity provider's access token in script-readable storage, and
-- a script in the page could take it and act as the user against the app and the provider. From
-- this migration the browser holds only an opaque session id in an HttpOnly cookie; the session,
-- and the provider's tokens, live here (platform/auth/session-store.ts, session-vault.ts).
--
--   auth_sessions   one row per sign-in session, tenant-owned (row-level security: a session id
--                   presented to another tenant's address finds no row). The id itself is never
--                   stored — `id_hash` is its SHA-256 — so a read of this table yields nothing a
--                   browser could present. `sealed_tokens` is the provider's tokens (a guest's
--                   platform-signed token) encrypted by the application with AES-256-GCM under
--                   SESSION_ENCRYPTION_KEY before they reach the database; the database never sees
--                   the key. `token_version` orders renewals: a renewed token is stored only by
--                   the request whose version is still current (concurrent renewals keep one).
--                   `revoked_at` ends a session at once (sign-out, sign-out everywhere, a password
--                   or factor change, a ban, a role change, erasure, rotation).
--
-- Session lifetimes are governed settings (safety tier, operator-only, bounded; seconds):
--      auth.session.user_idle_seconds       604800   7 days      a user not seen for that long
--      auth.session.user_absolute_seconds  2592000   30 days     a user's session, whatever its use
--      auth.session.staff_idle_seconds        1800   30 minutes  a staff member not seen for that long
--      auth.session.staff_absolute_seconds   43200   12 hours    a staff member's session
--      auth.session.guest_absolute_seconds   86400   24 hours    a guest's session (no idle limit)
--    bounds: idle 900 (15 minutes) to 2592000 (30 days); absolute 3600 (1 hour) to 7776000 (90 days).
--    The code clamps whatever a row says to the same bounds (platform/auth/session-lifetimes.ts).
-- Ended sessions are deleted by the data.retention job after retention.auth_sessions_days (45;
-- 31 to 400 — never less than the longest idle lifetime, so a live session is never deleted).
--
-- The platform's row of deletion_manifest gains the table (erasure deletes a user's sessions).
--
-- Idempotent: the table, its indexes and policy are created only when absent or re-created as they
-- were; the settings are inserted on conflict do nothing (an operator's later value stands); the
-- manifest gains the table once. A new, empty table: no lock on anything that exists but one row
-- lock per inserted setting and one on the manifest's row.

create table if not exists public.auth_sessions (
  tenant_id uuid not null default public.app_current_tenant()
    references public.tenants (id) on delete restrict,
  id_hash text not null,
  kind text not null,
  subject text not null,
  method text not null,
  csrf_token text not null,
  sealed_tokens text not null,
  token_version integer not null default 1,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_reason text,
  primary key (tenant_id, id_hash),
  constraint auth_sessions_id_hash_shape check (id_hash ~ '^[0-9a-f]{64}$'),
  constraint auth_sessions_kind_check check (kind in ('user', 'guest')),
  constraint auth_sessions_subject_shape check (length(subject) between 1 and 200),
  constraint auth_sessions_method_shape check (method ~ '^[a-z_]{1,40}$'),
  constraint auth_sessions_csrf_shape check (csrf_token ~ '^[A-Za-z0-9_-]{43}$'),
  constraint auth_sessions_token_version_positive check (token_version >= 1),
  constraint auth_sessions_revoked_reason_shape
    check (revoked_reason is null or revoked_reason ~ '^[a-z_]{1,40}$'),
  constraint auth_sessions_revoked_together
    check ((revoked_at is null) = (revoked_reason is null))
);

comment on table public.auth_sessions is
  'Server-side sign-in sessions (TASK-214, ADR-057). Tenant-owned. id_hash is the SHA-256 of the session id (the id is only in the browser''s HttpOnly cookie); sealed_tokens is encrypted by the application (AES-256-GCM, SESSION_ENCRYPTION_KEY).';
comment on column public.auth_sessions.sealed_tokens is
  'The identity provider''s tokens (a guest''s platform-signed token), sealed by platform/auth/session-vault.ts: v1.<key id>.<nonce>.<ciphertext and tag>. Never readable without the application''s key.';
comment on column public.auth_sessions.token_version is
  'Compare-and-set counter for renewals of sealed_tokens: update … where token_version = expected.';

create index if not exists auth_sessions_subject_live_idx
  on public.auth_sessions (tenant_id, subject) where revoked_at is null;
create index if not exists auth_sessions_last_seen_idx
  on public.auth_sessions (tenant_id, last_seen_at);

alter table public.auth_sessions enable row level security;
alter table public.auth_sessions force row level security;
drop policy if exists tenant_isolation on public.auth_sessions;
create policy tenant_isolation on public.auth_sessions
  for all to app_tenant
  using (tenant_id = public.app_current_tenant())
  with check (tenant_id = public.app_current_tenant());
revoke all on table public.auth_sessions from public;
grant select, insert, update, delete on table public.auth_sessions to app_tenant;
do $$
begin
  -- The Supabase roles exist only where Supabase created them (049's rule): act on those there.
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table public.auth_sessions from anon, authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant all on table public.auth_sessions to service_role';
  end if;
end $$;

-- The platform's deletion manifest names every table its erasure covers (052; the user-data
-- register, platform/auth/user-data.ts): a user's sessions are deleted with the account.
update public.deletion_manifest
   set table_names = array_append(table_names, 'auth_sessions')
 where module_name = 'platform'
   and not ('auth_sessions' = any (table_names));

insert into public.platform_config
  (key, value, default_value, description, category, value_type, min_value, max_value, permission_tier, tenant_overridable)
values
  ('auth.session.user_idle_seconds', '604800', '604800',
   'Seconds a signed-in user''s session lasts without a request before it ends (TASK-214). Default 7 days.',
   'auth', 'number', '900', '2592000', 'safety', false),
  ('auth.session.user_absolute_seconds', '2592000', '2592000',
   'Seconds a signed-in user''s session lasts from sign-in, however it is used (TASK-214). Default 30 days.',
   'auth', 'number', '3600', '7776000', 'safety', false),
  ('auth.session.staff_idle_seconds', '1800', '1800',
   'Seconds a staff member''s session lasts without a request before it ends (TASK-214). Default 30 minutes.',
   'auth', 'number', '900', '2592000', 'safety', false),
  ('auth.session.staff_absolute_seconds', '43200', '43200',
   'Seconds a staff member''s session lasts from sign-in, however it is used (TASK-214). Default 12 hours.',
   'auth', 'number', '3600', '7776000', 'safety', false),
  ('auth.session.guest_absolute_seconds', '86400', '86400',
   'Seconds a guest''s session lasts from its start (TASK-214); a guest''s session has no idle limit. Default 24 hours.',
   'auth', 'number', '3600', '7776000', 'safety', false),
  ('retention.auth_sessions_days', '45', '45',
   'Days a sign-in session''s record is kept after it was last used or ended (TASK-214). Never less than the longest idle lifetime (30 days).',
   'retention', 'number', '31', '400', 'safety', false)
on conflict (key) do nothing;

insert into public.applied_migrations (filename, confidence, note, checksum)
values (
  '070_auth_sessions.sql',
  'verified',
  'TASK-214 (ADR-057, SEC-016, N-30): auth_sessions (tenant-owned server-side sign-in sessions; the id hashed, the tokens sealed by the application) and the governed session lifetimes.',
  'sha256:95473c64222d9889584a48971a94159d8f000de0b7cc6b42d1592be19be5fdab'
)
on conflict (filename) do update set checksum = excluded.checksum;
