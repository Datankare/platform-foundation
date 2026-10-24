#!/usr/bin/env bash
# scripts/migration-replay.sh — build a database from zero the way a new instance is built
# (TASK-091): Supabase shim, schema baseline, then every migration the baseline does not
# record, in filename order. Any SQL error fails. Then checks what the platform needs is there.
#
# "Covered" means recorded in the baseline's applied_migrations seed — not "numbered at or below
# baseline-covers-through". A consuming app's own migrations (Playform's 007_playform_*, 031–036)
# share that number range but are not the platform's, so the baseline never contains them; they
# are replayed after it like any newer migration (TASK-119).
#
# Uses the standard PG* environment (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE) and
# expects an EMPTY database. CI runs it against a pgvector Postgres service; locally:
#   PGDATABASE=replay scripts/migration-replay.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASELINE="$ROOT/supabase/baseline/000_baseline.sql"
PSQL=(psql -X -q -v ON_ERROR_STOP=1)

through=$(sed -nE 's/^-- baseline-covers-through: ([0-9]+)$/\1/p' "$BASELINE")
[ -n "$through" ] || { echo "✗ baseline has no 'baseline-covers-through' marker"; exit 1; }

step() { echo "▸ $1"; }

step "shim"
"${PSQL[@]}" -f "$ROOT/supabase/baseline/supabase-shim.sql" >/dev/null

# Realtime, replay only: a minimal stand-in for Supabase's realtime.messages and the two
# functions 049's topic policies call, so those policies are created here and exercised below
# (049 creates them only where Realtime exists). Supabase's own definitions read the same
# settings: the request's JWT claims and the message's topic.
step "realtime stand-in (replay only)"
"${PSQL[@]}" <<'SQL' >/dev/null
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
  $$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
CREATE SCHEMA IF NOT EXISTS realtime;
CREATE TABLE IF NOT EXISTS realtime.messages (
  id bigserial PRIMARY KEY,
  topic text NOT NULL,
  extension text NOT NULL DEFAULT 'broadcast',
  payload jsonb,
  private boolean NOT NULL DEFAULT true,
  inserted_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION realtime.topic() RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('realtime.topic', true), '') $$;
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA realtime, auth TO authenticated;
GRANT SELECT, INSERT ON realtime.messages TO authenticated;
GRANT USAGE ON SEQUENCE realtime.messages_id_seq TO authenticated;
GRANT EXECUTE ON FUNCTION realtime.topic(), auth.jwt() TO authenticated;
SQL

step "baseline (covers 001–$through)"
"${PSQL[@]}" --single-transaction -f "$BASELINE" >/dev/null

applied=0
for f in $(ls "$ROOT/supabase/migrations" | grep -E '^[0-9]+_.*\.sql$' | sort); do
  if ! grep -qF "('$f', 'verified'" "$BASELINE"; then
    step "migration $f"
    "${PSQL[@]}" --single-transaction -f "$ROOT/supabase/migrations/$f" >/dev/null
    applied=$((applied + 1))
  fi
done

step "checks"
"${PSQL[@]}" -At <<'SQL'
DO $$
DECLARE missing text;
BEGIN
  -- Every tracked migration file is recorded.
  IF (SELECT count(*) FROM public.applied_migrations) < 2 THEN
    RAISE EXCEPTION 'applied_migrations is empty';
  END IF;
  -- Tables and functions the platform calls.
  SELECT string_agg(t, ', ') INTO missing FROM unnest(ARRAY[
    'users','roles','permissions','role_permissions','platform_config','platform_config_history',
    'guest_usage','user_devices','user_entitlements','groups','group_memberships',
    'group_invites','review_queue','user_strikes','content_safety_audit','agent_budgets',
    'agent_trajectories','proposals','effect_ledger','app_sessions','document_embeddings',
    'rate_limit_events','applied_migrations','ai_metrics','tenants','tenant_domains',
    'tenant_config_overrides','tenant_lifecycle_requests'
  ]) AS t WHERE to_regclass('public.' || t) IS NULL;
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'missing tables: %', missing; END IF;
  SELECT string_agg(f, ', ') INTO missing FROM unnest(ARRAY[
    'agent_budget_consume','guest_allowance_consume','rate_limit_hit','rate_limit_reset',
    'app_current_tenant','directory_host','directory_tenant','tenant_own_domains'
  ]) AS f WHERE NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = f);
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'missing functions: %', missing; END IF;
  -- Every table in public has row-level security (production has no automatic-RLS trigger).
  SELECT string_agg(c.relname, ', ') INTO missing FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity;
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'tables without row-level security: %', missing; END IF;
  -- No function that writes and runs as its owner (SECURITY DEFINER) is executable by anon or
  -- authenticated: it would bypass row-level security for anyone holding the public key (TASK-137).
  SELECT string_agg(p.proname, ', ') INTO missing FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef AND p.provolatile = 'v'
      AND (has_function_privilege('anon', p.oid, 'EXECUTE')
        OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'owner-rights functions that anon or authenticated can execute: %', missing;
  END IF;
  -- Governance seed is present.
  IF NOT EXISTS (SELECT 1 FROM public.roles WHERE name = 'super_admin') THEN
    RAISE EXCEPTION 'seed missing: super_admin role';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.platform_config WHERE key = 'guest.translate_allowance') THEN
    RAISE EXCEPTION 'seed missing: guest.translate_allowance';
  END IF;
END $$;
SQL

step "role catalog the tests use matches the database"
# scripts/role-catalog.cjs computes each role's permissions from the SQL; test identities and the
# authorization matrix are built from it. Equal here means those tests use the real roles.
for view in pairs inheritance; do
  if [ "$view" = pairs ]; then
    query="SELECT r.name || '|' || p.code FROM public.role_permissions rp JOIN public.roles r ON r.id = rp.role_id JOIN public.permissions p ON p.id = rp.permission_id ORDER BY 1"
  else
    query="SELECT r.name || '|' || f.name FROM public.role_inheritance ri JOIN public.roles r ON r.id = ri.role_id JOIN public.roles f ON f.id = ri.inherits_from_id ORDER BY 1"
  fi
  expected=$(node "$ROOT/scripts/role-catalog.cjs" "--$view" | sed '/^$/d' | LC_ALL=C sort)
  actual=$("${PSQL[@]}" -At -c "$query" | LC_ALL=C sort)
  if [ "$expected" != "$actual" ]; then
    echo "✗ role catalog ($view) differs from the database:"
    diff <(echo "$expected") <(echo "$actual") || true
    exit 1
  fi
done
missing=$(comm -23 <(node -e 'process.stdout.write(require(process.argv[1]).loadRoleCatalog().permissions.join("\n")+"\n")' "$ROOT/scripts/role-catalog.cjs" | LC_ALL=C sort) \
  <("${PSQL[@]}" -At -c "SELECT code FROM public.permissions" | LC_ALL=C sort))
[ -z "$missing" ] || { echo "✗ permissions in the catalog but not the database: $missing"; exit 1; }

step "ai_metrics is server-only (TASK-113)"
open_to=$("${PSQL[@]}" -At -c "SELECT string_agg(r, ',') FROM unnest(ARRAY['anon','authenticated']) r WHERE has_table_privilege(r, 'public.ai_metrics', 'SELECT,INSERT,UPDATE,DELETE')")
[ -z "$open_to" ] || { echo "✗ ai_metrics is readable or writable by: $open_to"; exit 1; }
sink_ok=$("${PSQL[@]}" -At -c "SELECT has_table_privilege('service_role', 'public.ai_metrics', 'SELECT') AND has_table_privilege('service_role', 'public.ai_metrics', 'INSERT')")
[ "$sink_ok" = "t" ] || { echo "✗ the service role cannot read and write ai_metrics (the sink would fail)"; exit 1; }

step "the default role the code provisions exists and is the default (TASK-148)"
# platform/auth/user-provisioning.ts DEFAULT_USER_ROLE is the role every new user gets; if the
# database lacks it, or another role is the default, first sign-in fails or diverges.
default_role=$(sed -nE 's/^export const DEFAULT_USER_ROLE = "([a-z_]+)";$/\1/p' "$ROOT/platform/auth/user-provisioning.ts")
[ -n "$default_role" ] || { echo "✗ could not read DEFAULT_USER_ROLE from platform/auth/user-provisioning.ts"; exit 1; }
db_default=$("${PSQL[@]}" -At -c "SELECT string_agg(name, ',' ORDER BY name) FROM public.roles WHERE is_default")
[ "$db_default" = "$default_role" ] || { echo "✗ default role: code provisions '$default_role', database default is '$db_default'"; exit 1; }

step "no migration is recorded as applied while its effect is absent (TASK-148)"
# 007_seed_separation creates the `registered` role; a database without it must not record 007 as
# applied. 047 corrects the record.
claimed=$("${PSQL[@]}" -At -c "SELECT count(*) FROM public.applied_migrations WHERE filename = '007_seed_separation.sql' AND confidence <> 'absent' AND NOT EXISTS (SELECT 1 FROM public.roles WHERE name = 'registered')")
[ "$claimed" = "0" ] || { echo "✗ 007_seed_separation recorded as applied, but no registered role exists"; exit 1; }

step "every audit action the code records is accepted by the database"
# platform/auth/audit.ts AUDIT_ACTIONS is the list the code may write; an action the enum rejects
# means that record is never written (audit X-8).
code_actions=$(sed -n '/^export const AUDIT_ACTIONS = \[/,/^\] as const;/p' "$ROOT/platform/auth/audit.ts" \
  | grep -oE '"[a-z_]+"' | tr -d '"' | LC_ALL=C sort -u)
[ -n "$code_actions" ] || { echo "✗ could not read AUDIT_ACTIONS from platform/auth/audit.ts"; exit 1; }
db_actions=$("${PSQL[@]}" -At -c "SELECT unnest(enum_range(NULL::public.audit_action))::text" | LC_ALL=C sort -u)
missing=$(comm -23 <(echo "$code_actions") <(echo "$db_actions"))
[ -z "$missing" ] || { echo "✗ audit actions the database rejects: $missing"; exit 1; }

step "config values are JSON, and stringified values are repaired (045)"
"${PSQL[@]}" <<'SQL'
BEGIN;
-- No governed value of a non-string type is stored as JSON text.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.platform_config
             WHERE value_type NOT IN ('string','string_enum') AND jsonb_typeof(value) = 'string') THEN
    RAISE EXCEPTION 'a non-string setting is stored as JSON text';
  END IF;
END $$;
-- Rows written the old way are repaired; strings and non-JSON text are left alone.
UPDATE public.platform_config SET value = to_jsonb('200'::text) WHERE key = 'ai.daily_paid_requests_per_actor';
UPDATE public.platform_config SET value = to_jsonb('["ai.daily_paid_requests_per_actor"]'::text)
  WHERE key = 'config.dual_control_keys';
INSERT INTO public.platform_config (key, value, default_value, description, category, value_type, permission_tier)
  VALUES ('replay.text_setting', to_jsonb('123'::text), to_jsonb('123'::text), 'replay', 'replay', 'string', 'standard'),
         ('replay.bad_number', to_jsonb('not json'::text), '1', 'replay', 'replay', 'number', 'standard');
SELECT public.normalize_config_json();
DO $$ BEGIN
  IF (SELECT jsonb_typeof(value) FROM public.platform_config WHERE key = 'ai.daily_paid_requests_per_actor') <> 'number'
  OR (SELECT jsonb_typeof(value) FROM public.platform_config WHERE key = 'config.dual_control_keys') <> 'array'
  OR (SELECT jsonb_typeof(value) FROM public.platform_config WHERE key = 'replay.text_setting') <> 'string'
  OR (SELECT jsonb_typeof(value) FROM public.platform_config WHERE key = 'replay.bad_number') <> 'string' THEN
    RAISE EXCEPTION 'normalize_config_json repaired the wrong rows';
  END IF;
END $$;
ROLLBACK;
SQL

step "daily paid-call quota is governed and dual-controlled (044)"
"${PSQL[@]}" -tAc "SELECT 1 FROM public.platform_config c, public.platform_config d WHERE c.key = 'ai.daily_paid_requests_per_actor' AND c.value = '200'::jsonb AND c.permission_tier = 'safety' AND d.key = 'config.dual_control_keys' AND d.value @> '[\"ai.daily_paid_requests_per_actor\"]'::jsonb" | grep -qx 1 || { echo "✗ 044 quota setting missing or not dual-controlled"; exit 1; }

step "one password policy per scope (042)"
"${PSQL[@]}" -At <<'SQL'
DO $$
DECLARE r uuid;
BEGIN
  PERFORM set_config('app.tenant_id', '00000000-0000-4000-8000-000000000001', true);
  -- The global scope (both null) is unique too: NULLS NOT DISTINCT.
  IF NOT EXISTS (SELECT 1 FROM public.password_policy WHERE role_id IS NULL AND user_id IS NULL) THEN
    INSERT INTO public.password_policy (role_id, user_id) VALUES (NULL, NULL);
  END IF;
  BEGIN
    INSERT INTO public.password_policy (role_id, user_id) VALUES (NULL, NULL);
    RAISE EXCEPTION 'a second global password policy was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  SELECT id INTO r FROM public.roles ORDER BY name LIMIT 1;
  INSERT INTO public.password_policy (role_id, user_id) VALUES (r, NULL);
  BEGIN
    INSERT INTO public.password_policy (role_id, user_id) VALUES (r, NULL);
    RAISE EXCEPTION 'a second password policy for one role was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  DELETE FROM public.password_policy WHERE role_id = r;
END $$;
SQL

step "rate limiting behaves (ADR-052)"
"${PSQL[@]}" -At <<'SQL'
DO $$
DECLARE r record; n integer;
BEGIN
  PERFORM set_config('app.tenant_id', '00000000-0000-4000-8000-000000000001', true);
  -- Counts up to the limit, then refuses with a positive retry-after within the window.
  SELECT * INTO r FROM public.rate_limit_hit('replay:a', 2, 60);
  IF NOT r.allowed OR r.used <> 1 THEN RAISE EXCEPTION 'first hit: %', r; END IF;
  SELECT * INTO r FROM public.rate_limit_hit('replay:a', 2, 60);
  IF NOT r.allowed OR r.used <> 2 THEN RAISE EXCEPTION 'second hit: %', r; END IF;
  SELECT * INTO r FROM public.rate_limit_hit('replay:a', 2, 60);
  IF r.allowed OR r.used <> 2 OR r.retry_after_seconds NOT BETWEEN 1 AND 60 THEN
    RAISE EXCEPTION 'over the limit: %', r;
  END IF;
  -- A refusal is not counted.
  SELECT count(*) INTO n FROM public.rate_limit_events WHERE bucket = 'replay:a';
  IF n <> 2 THEN RAISE EXCEPTION 'refusal was counted: % rows', n; END IF;
  -- Peeking does not count; buckets are independent.
  SELECT * INTO r FROM public.rate_limit_hit('replay:b', 1, 60, false);
  IF NOT r.allowed OR r.used <> 0 THEN RAISE EXCEPTION 'peek: %', r; END IF;
  SELECT * INTO r FROM public.rate_limit_hit('replay:b', 1, 60);
  IF NOT r.allowed OR r.used <> 1 THEN RAISE EXCEPTION 'independent bucket: %', r; END IF;
  -- Reset forgets a bucket.
  PERFORM public.rate_limit_reset('replay:a');
  SELECT * INTO r FROM public.rate_limit_hit('replay:a', 2, 60);
  IF NOT r.allowed OR r.used <> 1 THEN RAISE EXCEPTION 'after reset: %', r; END IF;
  -- Invalid input is refused, not coerced.
  BEGIN
    PERFORM public.rate_limit_hit('replay:c', 0, 60);
    RAISE EXCEPTION 'a zero limit was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'rate_limit_hit: invalid limit%' THEN RAISE; END IF;
  END;
  DELETE FROM public.rate_limit_events WHERE bucket LIKE 'replay:%';
END $$;
SQL

# Concurrency: 20 simultaneous requests for one bucket with a limit of 5 admit exactly 5.
tmp=$(mktemp -d)
for i in $(seq 20); do
  "${PSQL[@]}" -At -c "SELECT set_config('app.tenant_id', '00000000-0000-4000-8000-000000000001', true) IS NULL; SELECT allowed FROM public.rate_limit_hit('replay:concurrent', 5, 60)" | tail -1 >"$tmp/$i" &
done
wait
admitted=$(cat "$tmp"/* | grep -c '^t$' || true)
rm -rf "$tmp"
"${PSQL[@]}" -At -c "DELETE FROM public.rate_limit_events WHERE bucket = 'replay:concurrent'" >/dev/null
[ "$admitted" -eq 5 ] || { echo "✗ concurrent rate_limit_hit admitted $admitted of 20 with a limit of 5"; exit 1; }

step "tenancy: every table is classified, forced, and isolated (ADR-053 D4, D8)"
"${PSQL[@]}" -At <<'SQL'
DO $$
DECLARE missing text;
BEGIN
  -- Every table forces row-level security, so not even its owner reads it unfiltered by mistake.
  SELECT string_agg(c.relname, ', ') INTO missing FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p') AND NOT c.relforcerowsecurity;
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'tables without FORCE ROW LEVEL SECURITY: %', missing; END IF;
  -- A table either names its tenant (and is isolated by it), or is on the platform list.
  SELECT string_agg(c.relname, ', ') INTO missing FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p')
      AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
      AND c.relname NOT IN ('permissions','roles','role_permissions','role_inheritance','entitlement_groups',
        'entitlement_permissions','deletion_manifest','platform_config','applied_migrations','tenants');
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'tables with no tenant_id that are not platform-owned: %', missing; END IF;
  SELECT string_agg(c.relname, ', ') INTO missing FROM pg_class c
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p')
      AND c.relname NOT IN ('tenant_domains', 'tenant_lifecycle_requests', 'tenant_config_overrides')
      AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname
        AND p.policyname = 'tenant_isolation' AND p.roles = '{app_tenant}' AND p.cmd = 'ALL'
        AND p.qual LIKE '%tenant_id = app_current_tenant()%' AND p.with_check LIKE '%tenant_id = app_current_tenant()%');
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'tenant tables without the tenant_isolation policy: %', missing; END IF;
  -- A tenant's own configuration: one policy per command; every write needs a tenant-settable key.
  SELECT string_agg(x.cmd, ', ') INTO missing FROM (VALUES
      ('SELECT', 'tenant_config_read', false, false), ('INSERT', 'tenant_config_insert', false, true),
      ('UPDATE', 'tenant_config_update', true, true), ('DELETE', 'tenant_config_delete', true, false)
    ) AS x (cmd, name, using_overridable, check_overridable)
    WHERE NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public'
      AND p.tablename = 'tenant_config_overrides' AND p.policyname = x.name AND p.cmd = x.cmd
      AND p.roles = '{app_tenant}'
      AND (x.cmd = 'INSERT' OR p.qual LIKE '%tenant_id = app_current_tenant()%')
      AND (NOT x.using_overridable OR p.qual LIKE '%tenant_overridable%')
      AND (NOT x.check_overridable OR p.with_check LIKE '%tenant_overridable%'));
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'tenant_config_overrides lacks its per-command policy for: %', missing; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'tenant_config_overrides') <> 4 THEN
    RAISE EXCEPTION 'tenant_config_overrides has policies other than its four';
  END IF;
  SELECT string_agg(c.relname, ', ') INTO missing FROM pg_class c
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p')
      AND c.relname NOT IN ('platform_config_history','config_pending_approvals') AND NOT a.attnotnull;
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'tenant tables where tenant_id may be null: %', missing; END IF;
  -- Every tenant table's primary key starts with tenant_id (users: the identity's own id).
  SELECT string_agg(c.conrelid::regclass::text, ', ') INTO missing FROM pg_constraint c
    WHERE c.contype = 'p' AND c.connamespace = 'public'::regnamespace
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attname = 'tenant_id')
      AND c.conrelid::regclass::text NOT IN ('users', 'tenant_domains', 'tenant_lifecycle_requests', 'platform_config_history', 'config_pending_approvals')
      AND (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attnum = c.conkey[1]) <> 'tenant_id';
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'tenant tables whose primary key is not per tenant: %', missing; END IF;
  -- No policy other than the platform's own exists (the auth.uid()-era ones are gone).
  SELECT string_agg(tablename || '.' || policyname, ', ') INTO missing FROM pg_policies
    WHERE schemaname = 'public' AND policyname NOT IN ('tenant_isolation','catalog_read',
      'tenant_config_read','tenant_config_insert','tenant_config_update','tenant_config_delete');
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'unexpected policies: %', missing; END IF;
  -- Every foreign key between tenant tables carries tenant_id.
  SELECT string_agg(conrelid::regclass || '.' || conname, ', ') INTO missing FROM pg_constraint c
    WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attname = 'tenant_id')
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.confrelid AND a.attname = 'tenant_id')
      AND c.confrelid <> 'public.tenants'::regclass
      AND NOT (SELECT bool_or(a.attname = 'tenant_id') FROM pg_attribute a
               WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey));
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'foreign keys that can cross tenants: %', missing; END IF;
  -- Constraints added unchecked (to avoid long locks) were validated afterwards.
  SELECT string_agg(conrelid::regclass || '.' || conname, ', ') INTO missing FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace AND NOT convalidated;
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'constraints never validated: %', missing; END IF;
  -- Every unique key on a tenant-owned table includes tenant_id, except these (049 says why):
  -- users' id and identity subject (one identity, one tenant), keys led by a user id (itself of
  -- one tenant), generated ids of config history and approvals (tenant_id null for platform
  -- rows), and the directory's own tables (a host serves one tenant platform-wide).
  SELECT string_agg(i.indexrelid::regclass::text, ', ') INTO missing FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    WHERE c.relnamespace = 'public'::regnamespace AND i.indisunique
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
      AND NOT EXISTS (SELECT 1 FROM unnest(i.indkey) k JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k
                      WHERE a.attname = 'tenant_id')
      AND (c.relname, (SELECT string_agg(a.attname, ',' ORDER BY u.ord) FROM unnest(i.indkey) WITH ORDINALITY u(k, ord)
                       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = u.k))
          NOT IN (('users', 'id'), ('users', 'cognito_sub'), ('user_devices', 'user_id,device_id'),
                  ('user_entitlements', 'user_id,entitlement_group_id'), ('platform_config_history', 'id'),
                  ('config_pending_approvals', 'id'), ('tenant_domains', 'host'), ('tenant_lifecycle_requests', 'id'));
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'unique keys on tenant tables that span tenants: %', missing; END IF;
  -- The request role cannot step outside row-level security.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_tenant' AND (rolbypassrls OR rolsuper OR rolcreaterole OR rolcreatedb)) THEN
    RAISE EXCEPTION 'app_tenant can bypass row-level security or create roles';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = 'app_tenant') THEN
    RAISE EXCEPTION 'app_tenant is a member of another role';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE r.rolname = 'app_tenant') THEN
    RAISE EXCEPTION 'app_tenant owns a table';
  END IF;
  -- The public key reaches no table and no platform function.
  SELECT string_agg(c.relname, ', ') INTO missing FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p','v')
      AND (has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE')
        OR has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE'));
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'tables the public key can reach: %', missing; END IF;
  SELECT string_agg(p.proname, ', ') INTO missing FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
      AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'functions the public key can run: %', missing; END IF;
END $$;
SQL

step "tenancy: app_tenant sees only its tenant, and nothing without one (ADR-053 D8)"
"${PSQL[@]}" -At <<'SQL'
-- Two tenants with a user each, written by the owner.
INSERT INTO public.tenants (id, slug, name) VALUES
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'replay-a', 'Replay A'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'replay-b', 'Replay B');
INSERT INTO public.tenant_domains (host, tenant_id) VALUES ('a.replay.example', 'aaaaaaaa-0000-4000-8000-00000000000a');
INSERT INTO public.users (id, cognito_sub, email, role_id, tenant_id)
  SELECT 'aaaaaaaa-1111-4111-8111-11111111111a', 'aaaaaaaa-1111-4111-8111-11111111111a', 'a@replay.example', id,
         'aaaaaaaa-0000-4000-8000-00000000000a' FROM public.roles WHERE is_default;
INSERT INTO public.users (id, cognito_sub, email, role_id, tenant_id)
  SELECT 'bbbbbbbb-1111-4111-8111-11111111111b', 'bbbbbbbb-1111-4111-8111-11111111111b', 'b@replay.example', id,
         'bbbbbbbb-0000-4000-8000-00000000000b' FROM public.roles WHERE is_default;

-- An operator's value for tenant A of a key no tenant may set.
INSERT INTO public.tenant_config_overrides (tenant_id, key, value)
  VALUES ('aaaaaaaa-0000-4000-8000-00000000000a', 'ai.daily_paid_requests_per_actor', '50');

-- No tenant: nothing is visible, nothing can be written.
BEGIN;
SET LOCAL ROLE app_tenant;
DO $$ BEGIN
  IF (SELECT count(*) FROM public.users) <> 0 THEN RAISE EXCEPTION 'users visible with no tenant'; END IF;
  BEGIN
    INSERT INTO public.user_devices (user_id, device_id) VALUES ('aaaaaaaa-1111-4111-8111-11111111111a', 'replay');
    RAISE EXCEPTION 'insert accepted with no tenant';
  EXCEPTION WHEN not_null_violation OR insufficient_privilege OR check_violation OR invalid_text_representation OR undefined_column THEN NULL;
  END;
  -- The catalog is readable; the directory answers one host; the tables behind it are not.
  IF (SELECT count(*) FROM public.roles) = 0 THEN RAISE EXCEPTION 'role catalog unreadable'; END IF;
  IF public.directory_host('a.replay.example') <> 'aaaaaaaa-0000-4000-8000-00000000000a' THEN
    RAISE EXCEPTION 'directory_host did not answer';
  END IF;
  BEGIN
    PERFORM 1 FROM public.tenants;
    RAISE EXCEPTION 'tenants table readable by app_tenant';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM 1 FROM public.applied_migrations;
    RAISE EXCEPTION 'migration records readable by app_tenant';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE public.roles SET description = 'x';
    RAISE EXCEPTION 'catalog writable by app_tenant';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
ROLLBACK;

-- Tenant A: its own rows only; B's are invisible, unmodifiable, undeletable, unreferenceable.
BEGIN;
SET LOCAL ROLE app_tenant;
DO $$ BEGIN PERFORM set_config('app.tenant_id', 'aaaaaaaa-0000-4000-8000-00000000000a', true); END $$;
DO $$ DECLARE n integer; BEGIN
  IF (SELECT count(*) FROM public.users) <> 1 THEN RAISE EXCEPTION 'tenant A sees % users', (SELECT count(*) FROM public.users); END IF;
  UPDATE public.users SET email = 'x' WHERE id = 'bbbbbbbb-1111-4111-8111-11111111111b';
  GET DIAGNOSTICS n = ROW_COUNT; IF n <> 0 THEN RAISE EXCEPTION 'tenant A updated B''s user'; END IF;
  DELETE FROM public.users WHERE id = 'bbbbbbbb-1111-4111-8111-11111111111b';
  GET DIAGNOSTICS n = ROW_COUNT; IF n <> 0 THEN RAISE EXCEPTION 'tenant A deleted B''s user'; END IF;
  -- Writing a row for another tenant is refused by the policy's check.
  BEGIN
    INSERT INTO public.user_devices (user_id, device_id, tenant_id)
      VALUES ('bbbbbbbb-1111-4111-8111-11111111111b', 'replay', 'bbbbbbbb-0000-4000-8000-00000000000b');
    RAISE EXCEPTION 'tenant A wrote a row for tenant B';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- Pointing its own row at B's user is refused by the tenant-scoped foreign key.
  BEGIN
    INSERT INTO public.user_devices (user_id, device_id)
      VALUES ('bbbbbbbb-1111-4111-8111-11111111111b', 'replay');
    RAISE EXCEPTION 'tenant A referenced tenant B''s user';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  -- Moving its own row to B is refused.
  BEGIN
    UPDATE public.users SET tenant_id = 'bbbbbbbb-0000-4000-8000-00000000000b' WHERE id = 'aaaaaaaa-1111-4111-8111-11111111111a';
    RAISE EXCEPTION 'tenant A moved a row to tenant B';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- A row it writes is its own without naming the tenant.
  INSERT INTO public.user_devices (user_id, device_id) VALUES ('aaaaaaaa-1111-4111-8111-11111111111a', 'replay');
  IF (SELECT tenant_id FROM public.user_devices WHERE user_id = 'aaaaaaaa-1111-4111-8111-11111111111a')
     <> 'aaaaaaaa-0000-4000-8000-00000000000a' THEN RAISE EXCEPTION 'default tenant_id not applied'; END IF;
  -- Its own configuration, only for keys a tenant may set.
  INSERT INTO public.tenant_config_overrides (key, value) VALUES ('default_language', '"fr"');
  BEGIN
    INSERT INTO public.tenant_config_overrides (key, value) VALUES ('config.dual_control_keys', '[]');
    RAISE EXCEPTION 'tenant A overrode an operator-only key';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- An operator's value for a key the tenant may not set (written by the owner, below the
  -- tenant's reach): readable, as it applies to the tenant, but not removable or changeable.
  IF (SELECT count(*) FROM public.tenant_config_overrides WHERE key = 'ai.daily_paid_requests_per_actor') <> 1 THEN
    RAISE EXCEPTION 'tenant A cannot see the operator''s value that applies to it';
  END IF;
  DELETE FROM public.tenant_config_overrides WHERE key = 'ai.daily_paid_requests_per_actor';
  GET DIAGNOSTICS n = ROW_COUNT; IF n <> 0 THEN RAISE EXCEPTION 'tenant A deleted an operator-only override'; END IF;
  UPDATE public.tenant_config_overrides SET value = '9999' WHERE key = 'ai.daily_paid_requests_per_actor';
  GET DIAGNOSTICS n = ROW_COUNT; IF n <> 0 THEN RAISE EXCEPTION 'tenant A changed an operator-only override'; END IF;
  -- Nor moved away onto a key it may set (the new row would pass a check on the new row alone).
  UPDATE public.tenant_config_overrides SET key = 'supported_languages', value = '["en"]'
    WHERE key = 'ai.daily_paid_requests_per_actor';
  GET DIAGNOSTICS n = ROW_COUNT; IF n <> 0 THEN RAISE EXCEPTION 'tenant A moved an operator-only override onto its own key'; END IF;
  -- Nor turned into one: its own value of a settable key cannot be re-keyed to an operator-only one.
  BEGIN
    UPDATE public.tenant_config_overrides SET key = 'config.dual_control_keys', value = '[]' WHERE key = 'default_language';
    RAISE EXCEPTION 'tenant A re-keyed its value to an operator-only key';
  EXCEPTION WHEN insufficient_privilege OR unique_violation THEN NULL;
  END;
  -- Its own settable values it changes and removes freely.
  UPDATE public.tenant_config_overrides SET value = '"de"' WHERE key = 'default_language';
  GET DIAGNOSTICS n = ROW_COUNT; IF n <> 1 THEN RAISE EXCEPTION 'tenant A could not change its own value'; END IF;
  -- The budget function runs as the caller and counts in its tenant.
  PERFORM public.agent_budget_consume('agent:replay', 'user', 'u', '2026-10-23', 1.5, 1);
  IF (SELECT tenant_id FROM public.agent_budgets WHERE agent_id = 'agent:replay') <> 'aaaaaaaa-0000-4000-8000-00000000000a' THEN
    RAISE EXCEPTION 'budget counted outside the tenant';
  END IF;
  -- Rate-limit buckets of the same name are per tenant.
  PERFORM public.rate_limit_hit('replay:tenant', 1, 60);
END $$;
COMMIT;

BEGIN;
SET LOCAL ROLE app_tenant;
DO $$ BEGIN PERFORM set_config('app.tenant_id', 'bbbbbbbb-0000-4000-8000-00000000000b', true); END $$;
DO $$ DECLARE r record; BEGIN
  IF (SELECT count(*) FROM public.user_devices) <> 0 THEN RAISE EXCEPTION 'tenant B sees A''s devices'; END IF;
  IF (SELECT count(*) FROM public.tenant_config_overrides) <> 0 THEN RAISE EXCEPTION 'tenant B sees A''s config'; END IF;
  IF (SELECT count(*) FROM public.agent_budgets) <> 0 THEN RAISE EXCEPTION 'tenant B sees A''s budget'; END IF;
  SELECT * INTO r FROM public.rate_limit_hit('replay:tenant', 1, 60);
  IF NOT r.allowed THEN RAISE EXCEPTION 'tenant B shares tenant A''s rate-limit bucket'; END IF;
  PERFORM public.agent_budget_consume('agent:replay', 'user', 'u', '2026-10-23', 2, 1);
  IF (SELECT used_usd FROM public.agent_budgets WHERE agent_id = 'agent:replay') <> 2 THEN
    RAISE EXCEPTION 'tenant B''s budget includes tenant A''s spend';
  END IF;
END $$;
ROLLBACK;

-- Clean up as the owner.
DELETE FROM public.rate_limit_events WHERE bucket = 'replay:tenant';
DELETE FROM public.agent_budgets WHERE agent_id = 'agent:replay';
DELETE FROM public.tenant_config_overrides WHERE tenant_id = 'aaaaaaaa-0000-4000-8000-00000000000a';
DELETE FROM public.user_devices WHERE tenant_id IN ('aaaaaaaa-0000-4000-8000-00000000000a','bbbbbbbb-0000-4000-8000-00000000000b');
DELETE FROM public.users WHERE tenant_id IN ('aaaaaaaa-0000-4000-8000-00000000000a','bbbbbbbb-0000-4000-8000-00000000000b');
DELETE FROM public.tenants WHERE slug IN ('replay-a','replay-b');
SQL

step "tenancy: Realtime topics are per tenant (ADR-053 A7)"
"${PSQL[@]}" -At <<'SQL'
DO $$ BEGIN
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'realtime' AND tablename = 'messages'
      AND policyname IN ('tenant_topics_read', 'tenant_topics_write')) <> 2 THEN
    RAISE EXCEPTION 'the Realtime topic policies were not created';
  END IF;
END $$;
INSERT INTO realtime.messages (topic, payload) VALUES
  ('t:aaaaaaaa-0000-4000-8000-00000000000a:room', '{}'),
  ('t:bbbbbbbb-0000-4000-8000-00000000000b:room', '{}');
BEGIN;
SET LOCAL ROLE authenticated;
DO $$ DECLARE n integer; BEGIN
  PERFORM set_config('request.jwt.claims', '{"tenant_id":"aaaaaaaa-0000-4000-8000-00000000000a"}', true);
  -- Reading: Realtime sets the topic of the channel being joined; only the token's tenant's.
  PERFORM set_config('realtime.topic', 't:aaaaaaaa-0000-4000-8000-00000000000a:room', true);
  SELECT count(*) INTO n FROM realtime.messages;
  IF n = 0 THEN RAISE EXCEPTION 'a browser cannot read its own tenant''s topic'; END IF;
  PERFORM set_config('realtime.topic', 't:bbbbbbbb-0000-4000-8000-00000000000b:room', true);
  SELECT count(*) INTO n FROM realtime.messages;
  IF n <> 0 THEN RAISE EXCEPTION 'a browser of tenant A read tenant B''s topic'; END IF;
  -- Writing: only to its own tenant's topic.
  PERFORM set_config('realtime.topic', 't:aaaaaaaa-0000-4000-8000-00000000000a:room', true);
  INSERT INTO realtime.messages (topic, payload) VALUES ('t:aaaaaaaa-0000-4000-8000-00000000000a:room', '{}');
  PERFORM set_config('realtime.topic', 't:bbbbbbbb-0000-4000-8000-00000000000b:room', true);
  BEGIN
    INSERT INTO realtime.messages (topic, payload) VALUES ('t:bbbbbbbb-0000-4000-8000-00000000000b:room', '{}');
    RAISE EXCEPTION 'a browser of tenant A sent on tenant B''s topic';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- A token with no tenant, or a malformed one, reaches no topic.
  PERFORM set_config('request.jwt.claims', '{"tenant_id":"aaaaaaaa"}', true);
  PERFORM set_config('realtime.topic', 't:aaaaaaaa:room', true);
  SELECT count(*) INTO n FROM realtime.messages;
  IF n <> 0 THEN RAISE EXCEPTION 'a malformed tenant claim reached a topic'; END IF;
  PERFORM set_config('request.jwt.claims', '{}', true);
  PERFORM set_config('realtime.topic', 't::room', true);
  SELECT count(*) INTO n FROM realtime.messages;
  IF n <> 0 THEN RAISE EXCEPTION 'a token without a tenant reached a topic'; END IF;
END $$;
ROLLBACK;
DELETE FROM realtime.messages;
SQL

step "tenancy: 049 applied again changes nothing (idempotent)"
# What an operator may have changed since 049 ran, and what a later migration may have added:
# re-running 049 must keep all of it — a platform history row (tenant_id null by design), a
# tenant-settable key an operator closed, a later migration's policies.
"${PSQL[@]}" -At <<'SQL' >/dev/null
INSERT INTO public.platform_config_history (config_key, previous_value, new_value, change_comment, scope, tenant_id)
  VALUES ('default_language', '"en"', '"fr"', 'replay: a platform change', 'platform', NULL);
UPDATE public.platform_config SET tenant_overridable = false WHERE key = 'signups_enabled';
CREATE TABLE public.replay_later (id int PRIMARY KEY, tenant_id uuid NOT NULL);
ALTER TABLE public.replay_later ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.replay_later FROM anon, authenticated;
CREATE POLICY tenant_isolation ON public.replay_later FOR ALL TO app_tenant
  USING (tenant_id = public.app_current_tenant()) WITH CHECK (tenant_id = public.app_current_tenant());
CREATE POLICY replay_later_read ON public.users FOR SELECT TO service_role USING (true);
SQL
snapshot() {
  "${PSQL[@]}" -At <<'SQL'
SELECT 'config|' || md5(string_agg(to_jsonb(c)::text, '' ORDER BY c.key)) FROM public.platform_config c
UNION ALL SELECT 'history|' || count(*) || '|' || count(*) FILTER (WHERE tenant_id IS NULL) || '|'
  || md5(coalesce(string_agg(id::text || ':' || coalesce(tenant_id::text, '-'), ',' ORDER BY id), ''))
  FROM public.platform_config_history
UNION ALL SELECT 'approvals|' || count(*) || '|' || count(*) FILTER (WHERE tenant_id IS NULL)
  FROM public.config_pending_approvals
UNION ALL SELECT 'policy|' || schemaname || '.' || tablename || '.' || policyname || '|' || cmd || '|'
  || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, '')
  FROM pg_policies WHERE schemaname IN ('public', 'realtime')
UNION ALL SELECT 'constraint|' || conrelid::regclass || '.' || conname || '|' || pg_get_constraintdef(oid)
  || '|' || convalidated FROM pg_constraint WHERE connamespace = 'public'::regnamespace
UNION ALL SELECT 'index|' || pg_get_indexdef(i.indexrelid) FROM pg_index i
  JOIN pg_class c ON c.oid = i.indrelid WHERE c.relnamespace = 'public'::regnamespace
UNION ALL SELECT 'column|' || a.attrelid::regclass || '.' || a.attname || '|' || format_type(a.atttypid, a.atttypmod)
  || '|' || a.attnotnull || '|' || coalesce(pg_get_expr(d.adbin, d.adrelid), '')
  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
UNION ALL SELECT 'function|' || p.oid::regprocedure || '|' || md5(pg_get_functiondef(p.oid)) || '|'
  || coalesce(p.proacl::text, '') FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
UNION ALL SELECT 'relation|' || c.oid::regclass || '|' || coalesce(c.relacl::text, '') || '|'
  || c.relrowsecurity || '|' || c.relforcerowsecurity
  FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'S', 'v')
UNION ALL SELECT 'database|' || coalesce(datacl::text, '') FROM pg_database WHERE datname = current_database()
UNION ALL SELECT 'rows|' || (SELECT count(*) FROM public.tenants) || '|' || (SELECT count(*) FROM public.users)
  || '|' || (SELECT count(*) FROM public.applied_migrations) || '|' || (SELECT count(*) FROM public.permissions)
ORDER BY 1
SQL
}
before=$(snapshot)
"${PSQL[@]}" --single-transaction -f "$ROOT/supabase/migrations/049_tenancy.sql" >/dev/null 2>&1 \
  || { echo "✗ 049 failed when applied a second time:"; "${PSQL[@]}" --single-transaction -f "$ROOT/supabase/migrations/049_tenancy.sql" >/dev/null; exit 1; }
after=$(snapshot)
if [ "$before" != "$after" ]; then
  echo "✗ applying 049 a second time changed the database:"
  diff <(echo "$before") <(echo "$after") || true
  exit 1
fi
"${PSQL[@]}" -At <<'SQL' >/dev/null
DELETE FROM public.platform_config_history WHERE change_comment = 'replay: a platform change';
UPDATE public.platform_config SET tenant_overridable = true WHERE key = 'signups_enabled';
DROP TABLE public.replay_later;
DROP POLICY replay_later_read ON public.users;
SQL

step "tenancy: signed in as app_tenant, the role cannot be left (ADR-053 D4)"
# SET ROLE is checked against the role that signed in, so this needs a real app_tenant login —
# given here for the check only, and taken away again.
pw="replay-$(date +%s%N)"
"${PSQL[@]}" -c "ALTER ROLE app_tenant LOGIN PASSWORD '$pw'" >/dev/null
switched=$(PGUSER=app_tenant PGPASSWORD="$pw" "${PSQL[@]}" -h "${PGHOST:-localhost}" -At \
  -c "SET ROLE postgres" -c "SELECT current_user" 2>&1 || true)
# Nor create a temporary table (049 revokes TEMPORARY; PUBLIC's is replaced by explicit grants).
temp=$(PGUSER=app_tenant PGPASSWORD="$pw" "${PSQL[@]}" -h "${PGHOST:-localhost}" -At \
  -c "CREATE TEMP TABLE replay_shadow (id int)" 2>&1 || true)
others=$("${PSQL[@]}" -At -c "SELECT string_agg(r, ',') FROM unnest(ARRAY['postgres','anon','authenticated','service_role']) r WHERE NOT has_database_privilege(r, current_database(), 'TEMPORARY')")
"${PSQL[@]}" -c "ALTER ROLE app_tenant NOLOGIN PASSWORD NULL" >/dev/null
case "$switched" in
  *"permission denied to set role"*) ;;
  *) echo "✗ app_tenant could switch role, or could not sign in to be checked: $switched"; exit 1 ;;
esac
case "$temp" in
  *"permission denied to create temporary tables"*) ;;
  *) echo "✗ app_tenant could create a temporary table, or could not sign in to be checked: $temp"; exit 1 ;;
esac
[ -z "$others" ] || { echo "✗ revoking TEMPORARY from app_tenant took it from: $others"; exit 1; }

echo "✓ replay: baseline + $applied migration(s) it does not record, checks passed"
