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
# Migrations are applied core first, then the selected product modules' (REPLAY_MODULES, default
# all — ADR-054 D5). Uses the standard PG* environment (PGHOST, PGPORT, PGUSER, PGPASSWORD,
# PGDATABASE) and expects an EMPTY database. CI runs it against a pgvector Postgres service; locally:
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

# ADR-054 D5: the core's migrations, then each selected module's (REPLAY_MODULES, comma-separated;
# default: every module in platform/modules/manifest.json), modules in dependency order — the order
# scripts/module-manifest.cjs computes. A module's migrations are listed in its manifest entry.
order=$(node "$ROOT/scripts/module-manifest.cjs" --replay-order "${REPLAY_MODULES:-}") || {
  echo "✗ migration order (platform/modules/manifest.json)"; exit 1; }
applied=0
for f in $order; do
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
    'tenant_config_overrides','tenant_lifecycle_requests','jobs','job_schedules',
    'config_dual_control_seeded'
  ]) AS t WHERE to_regclass('public.' || t) IS NULL;
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'missing tables: %', missing; END IF;
  SELECT string_agg(f, ', ') INTO missing FROM unnest(ARRAY[
    'agent_budget_consume','guest_allowance_consume','rate_limit_hit','rate_limit_reset',
    'app_current_tenant','directory_host','directory_tenant','tenant_own_domains','job_claim'
  ]) AS f WHERE NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = f);
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'missing functions: %', missing; END IF;
  -- Every table in public has row-level security (production has no automatic-RLS trigger).
  SELECT string_agg(c.relname, ', ') INTO missing FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity;
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'tables without row-level security: %', missing; END IF;
  -- No function that runs as its owner (SECURITY DEFINER) is executable by anon or
  -- authenticated: it would bypass row-level security for anyone holding the public key
  -- (TASK-137). Every one, whatever its volatility — a stable one that reads is as much a hole as
  -- one that writes (audit E-11: only volatile ones were checked).
  SELECT string_agg(p.proname, ', ') INTO missing FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef
      AND (has_function_privilege('anon', p.oid, 'EXECUTE')
        OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'owner-rights functions that anon or authenticated can execute: %', missing;
  END IF;
  -- Every owner-rights function fixes its search_path, so no caller's schema can shadow what it
  -- calls (audit E-18).
  SELECT string_agg(p.proname, ', ') INTO missing FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef
      AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) AS c WHERE c LIKE 'search_path=%');
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'owner-rights functions without a fixed search_path: %', missing;
  END IF;
  -- A view runs as its owner unless it is security_invoker, so one anon or authenticated can read
  -- would bypass row-level security (audit E-11: views were not checked).
  SELECT string_agg(c.relname, ', ') INTO missing FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('v', 'm')
      AND NOT coalesce('security_invoker=true' = ANY (c.reloptions), false)
      AND (has_table_privilege('anon', c.oid, 'SELECT')
        OR has_table_privilege('authenticated', c.oid, 'SELECT'));
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'owner-rights views that anon or authenticated can read: %', missing;
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
# platform/auth/audit-actions.ts AUDIT_ACTIONS (re-exported by audit.ts) is the list the code may write; an action the enum rejects
# means that record is never written (audit X-8).
code_actions=$(sed -n '/^export const AUDIT_ACTIONS = \[/,/^\] as const;/p' "$ROOT/platform/auth/audit-actions.ts" \
  | grep -oE '"[a-z_]+"' | tr -d '"' | LC_ALL=C sort -u)
[ -n "$code_actions" ] || { echo "✗ could not read AUDIT_ACTIONS from platform/auth/audit-actions.ts"; exit 1; }
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
        'entitlement_permissions','deletion_manifest','platform_config','applied_migrations','tenants',
        'job_schedules','config_dual_control_seeded');
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
      AND c.relname NOT IN ('platform_config_history','config_pending_approvals','jobs','job_schedule_outcomes') AND NOT a.attnotnull;
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'tenant tables where tenant_id may be null: %', missing; END IF;
  -- Every tenant table's primary key starts with tenant_id (users: the identity's own id; jobs and
  -- job_schedule_outcomes: a generated id, since a platform row has no tenant — 050).
  SELECT string_agg(c.conrelid::regclass::text, ', ') INTO missing FROM pg_constraint c
    WHERE c.contype = 'p' AND c.connamespace = 'public'::regnamespace
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attname = 'tenant_id')
      AND c.conrelid::regclass::text NOT IN ('users', 'tenant_domains', 'tenant_lifecycle_requests', 'platform_config_history', 'config_pending_approvals', 'jobs', 'job_schedule_outcomes')
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
  -- one tenant), generated ids of config history, approvals, jobs and schedule outcomes
  -- (tenant_id null for platform rows; 050), and the directory's own tables (a host serves one
  -- tenant platform-wide).
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
                  ('config_pending_approvals', 'id'), ('tenant_domains', 'host'), ('tenant_lifecycle_requests', 'id'),
                  ('jobs', 'id'), ('job_schedule_outcomes', 'id'));
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

step "jobs: the claim is closed, exclusive, leased and per tenant (ADR-056 D2, TASK-137)"
"${PSQL[@]}" -At <<'SQL'
DO $$
DECLARE missing text;
BEGIN
  -- The claim runs as its owner, with a fixed search path; no public, request or anonymous role
  -- may call it (it reads every tenant's due work).
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.job_claim(text,text[],integer,integer)'::regprocedure AND p.prosecdef
       AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%')
  ) THEN
    RAISE EXCEPTION 'job_claim is not an owner-rights function with a fixed search_path';
  END IF;
  SELECT string_agg(r, ', ') INTO missing FROM unnest(ARRAY['public','anon','authenticated','app_tenant']) r
   WHERE has_function_privilege(r, 'public.job_claim(text,text[],integer,integer)', 'EXECUTE');
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'job_claim is executable by: %', missing; END IF;
  -- The request role reads its tenant's jobs; it inserts, changes and removes none (every enqueue
  -- goes through platform/jobs on the owner connection, bound to the caller's tenant and the
  -- kind's scope); the schedules and their outcomes are the owner's alone.
  SELECT string_agg(x, ', ') INTO missing FROM (VALUES
      ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('INSERT')) AS v (x)
   WHERE has_table_privilege('app_tenant', 'public.jobs', x);
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'app_tenant may % jobs', missing; END IF;
  IF has_any_column_privilege('app_tenant', 'public.jobs', 'INSERT') THEN
    RAISE EXCEPTION 'app_tenant may insert some jobs columns';
  END IF;
  IF has_table_privilege('app_tenant', 'public.job_schedules', 'SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'app_tenant can reach job_schedules';
  END IF;
  IF has_table_privilege('app_tenant', 'public.job_schedule_outcomes', 'SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'app_tenant can reach job_schedule_outcomes';
  END IF;
  -- Bounded inputs.
  BEGIN
    PERFORM public.job_claim('w', ARRAY['replay.job'], 0, 60);
    RAISE EXCEPTION 'job_claim accepted a zero limit';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'job_claim: invalid limit%' THEN RAISE; END IF;
  END;
END $$;

INSERT INTO public.tenants (id, slug, name) VALUES
  ('aaaaaaaa-0000-4000-8000-0000000000a1', 'replay-jobs-a', 'Replay jobs A'),
  ('bbbbbbbb-0000-4000-8000-0000000000b1', 'replay-jobs-b', 'Replay jobs B');
-- Forty due jobs across the two tenants and the platform, for the concurrent claim below.
INSERT INTO public.jobs (tenant_id, kind, idempotency_key)
  SELECT CASE i % 3 WHEN 0 THEN 'aaaaaaaa-0000-4000-8000-0000000000a1'::uuid
                    WHEN 1 THEN 'bbbbbbbb-0000-4000-8000-0000000000b1'::uuid END,
         'replay.job', 'k' || i
    FROM generate_series(1, 40) i;
SQL

# Four workers claim at once, ten each: every job is taken exactly once (FOR UPDATE SKIP LOCKED).
tmp=$(mktemp -d)
for w in 1 2 3 4; do
  "${PSQL[@]}" -At -c "SELECT id FROM public.job_claim('replay-w$w', ARRAY['replay.job'], 10, 60)" >"$tmp/$w" &
done
wait
claimed=$(cat "$tmp"/* | sed '/^$/d' | wc -l)
distinct=$(cat "$tmp"/* | sed '/^$/d' | sort -u | wc -l)
rm -rf "$tmp"
[ "$claimed" -eq 40 ] && [ "$distinct" -eq 40 ] \
  || { echo "✗ concurrent job_claim: $claimed claims of $distinct distinct jobs (expected 40 of 40)"; exit 1; }

"${PSQL[@]}" -At <<'SQL'
DO $$
DECLARE r record; n integer; tok uuid;
BEGIN
  -- Nothing is due while every lease holds.
  SELECT count(*) INTO n FROM public.job_claim('replay-w5', ARRAY['replay.job'], 100, 60);
  IF n <> 0 THEN RAISE EXCEPTION 'job_claim took % jobs that are leased', n; END IF;
  -- A lapsed lease (the worker died) makes the job due again: a new attempt, a new token.
  SELECT id, lease_token INTO r FROM public.jobs WHERE idempotency_key = 'k1';
  UPDATE public.jobs SET locked_until = now() - interval '1 second' WHERE id = r.id;
  SELECT lease_token INTO tok FROM public.job_claim('replay-w6', ARRAY['replay.job'], 100, 60) LIMIT 1;
  IF tok IS NULL OR tok = r.lease_token THEN RAISE EXCEPTION 'a lapsed lease was not recovered with a new token'; END IF;
  IF (SELECT attempts FROM public.jobs WHERE id = r.id) <> 2 THEN RAISE EXCEPTION 'the recovered job did not count an attempt'; END IF;
  -- A lease that lapsed on the last attempt: dead, not run again.
  UPDATE public.jobs SET max_attempts = 2, locked_until = now() - interval '1 second' WHERE id = r.id;
  SELECT count(*) INTO n FROM public.job_claim('replay-w7', ARRAY['replay.job'], 100, 60);
  IF n <> 0 OR (SELECT status FROM public.jobs WHERE id = r.id) <> 'dead' THEN
    RAISE EXCEPTION 'a job whose last attempt lapsed was not dead-lettered';
  END IF;
  -- Only the kinds asked for; and a suspended tenant's jobs wait, parked — except a kind that
  -- runs for suspended tenants (a legal obligation).
  INSERT INTO public.jobs (tenant_id, kind, idempotency_key)
    VALUES ('aaaaaaaa-0000-4000-8000-0000000000a1', 'replay.other', 'o1'),
           ('bbbbbbbb-0000-4000-8000-0000000000b1', 'replay.other', 'o2');
  INSERT INTO public.jobs (tenant_id, kind, idempotency_key, runs_for_suspended)
    VALUES ('bbbbbbbb-0000-4000-8000-0000000000b1', 'replay.legal', 'l1', true);
  UPDATE public.tenants SET status = 'suspended' WHERE id = 'bbbbbbbb-0000-4000-8000-0000000000b1';
  IF (SELECT status FROM public.jobs WHERE idempotency_key = 'o2') <> 'parked' THEN
    RAISE EXCEPTION 'a suspended tenant''s queued job was not parked';
  END IF;
  IF (SELECT status FROM public.jobs WHERE idempotency_key = 'l1') <> 'queued' THEN
    RAISE EXCEPTION 'a job that runs for suspended tenants was parked';
  END IF;
  -- Enqueued while suspended: parked as it is written.
  INSERT INTO public.jobs (tenant_id, kind, idempotency_key)
    VALUES ('bbbbbbbb-0000-4000-8000-0000000000b1', 'replay.other', 'o3');
  IF (SELECT status FROM public.jobs WHERE idempotency_key = 'o3') <> 'parked' THEN
    RAISE EXCEPTION 'a job enqueued for a suspended tenant was not parked';
  END IF;
  SELECT count(*) INTO n FROM public.job_claim('replay-w8', ARRAY['replay.job'], 100, 60);
  IF n <> 0 THEN RAISE EXCEPTION 'job_claim took a kind it was not asked for'; END IF;
  SELECT count(*) INTO n FROM public.job_claim('replay-w8', ARRAY['replay.other'], 100, 60);
  IF n <> 1 THEN RAISE EXCEPTION 'job_claim took % jobs (expected the active tenant''s one)', n; END IF;
  SELECT count(*) INTO n FROM public.job_claim('replay-w8', ARRAY['replay.legal'], 100, 60);
  IF n <> 1 THEN RAISE EXCEPTION 'job_claim took % legal-obligation jobs of a suspended tenant (expected 1)', n; END IF;
  -- Resumed: its parked jobs are queued again.
  UPDATE public.tenants SET status = 'active' WHERE id = 'bbbbbbbb-0000-4000-8000-0000000000b1';
  IF (SELECT count(*) FROM public.jobs WHERE idempotency_key IN ('o2', 'o3') AND status = 'queued') <> 2 THEN
    RAISE EXCEPTION 'a resumed tenant''s parked jobs were not queued again';
  END IF;
  -- A deleted tenant's jobs are all parked, legal obligations too.
  UPDATE public.tenants SET status = 'deleted', purge_after = now() + interval '30 days'
   WHERE id = 'bbbbbbbb-0000-4000-8000-0000000000b1';
  IF EXISTS (SELECT 1 FROM public.jobs WHERE tenant_id = 'bbbbbbbb-0000-4000-8000-0000000000b1' AND status = 'queued') THEN
    RAISE EXCEPTION 'a deleted tenant''s job stayed queued';
  END IF;
  UPDATE public.tenants SET status = 'active', purge_after = NULL
   WHERE id = 'bbbbbbbb-0000-4000-8000-0000000000b1';
  -- No job is due before it was written: a past run_at is clamped to now().
  INSERT INTO public.jobs (tenant_id, kind, idempotency_key, run_at)
    VALUES (NULL, 'replay.other', 'past', '1970-01-01');
  IF (SELECT run_at FROM public.jobs WHERE idempotency_key = 'past') < now() THEN
    RAISE EXCEPTION 'a backdated run_at was accepted';
  END IF;
  -- One key per tenant and kind: the same key in another tenant is another job; twice in one is refused.
  BEGIN
    INSERT INTO public.jobs (tenant_id, kind, idempotency_key)
      VALUES ('aaaaaaaa-0000-4000-8000-0000000000a1', 'replay.other', 'o1');
    RAISE EXCEPTION 'a duplicate idempotency key was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.jobs (tenant_id, kind, idempotency_key) VALUES (NULL, 'replay.job', 'k3');
    INSERT INTO public.jobs (tenant_id, kind, idempotency_key) VALUES (NULL, 'replay.job', 'k3');
    RAISE EXCEPTION 'a duplicate platform idempotency key was accepted (nulls must not be distinct)';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;

-- The request role, as tenant A: its own jobs only, read only.
BEGIN;
SET LOCAL ROLE app_tenant;
DO $$ BEGIN PERFORM set_config('app.tenant_id', 'aaaaaaaa-0000-4000-8000-0000000000a1', true); END $$;
DO $$ DECLARE n integer; BEGIN
  IF EXISTS (SELECT 1 FROM public.jobs WHERE tenant_id IS DISTINCT FROM 'aaaaaaaa-0000-4000-8000-0000000000a1') THEN
    RAISE EXCEPTION 'tenant A sees another tenant''s or a platform job';
  END IF;
  IF (SELECT count(*) FROM public.jobs) = 0 THEN RAISE EXCEPTION 'tenant A cannot see its own jobs'; END IF;
  BEGIN
    INSERT INTO public.jobs (kind, idempotency_key, payload) VALUES ('replay.mine', 'm1', '{"a":1}');
    RAISE EXCEPTION 'tenant A inserted a job';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO public.jobs (kind, idempotency_key, status) VALUES ('replay.mine', 'm2', 'succeeded');
    RAISE EXCEPTION 'tenant A set a job''s status';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE public.jobs SET run_at = now();
    RAISE EXCEPTION 'tenant A changed a job';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.job_claim('tenant', ARRAY['replay.job'], 1, 60);
    RAISE EXCEPTION 'tenant A ran job_claim';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM 1 FROM public.job_schedules;
    RAISE EXCEPTION 'tenant A read job_schedules';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
ROLLBACK;

DELETE FROM public.jobs WHERE kind IN ('replay.job', 'replay.other', 'replay.mine', 'replay.legal');
DELETE FROM public.tenants WHERE slug IN ('replay-jobs-a', 'replay-jobs-b');
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

step "jobs: 050 and 051 applied again change nothing (idempotent)"
# An operator's choice since (a schedule turned off, a stretched interval, a duty taken off the
# dual-control list) and a schedule's state must survive a re-run, as must every later object.
dual_before=$("${PSQL[@]}" -At -c "SELECT value::text FROM public.platform_config WHERE key = 'config.dual_control_keys'")
"${PSQL[@]}" -At <<'SQL' >/dev/null
UPDATE public.platform_config SET value = 'false' WHERE key = 'jobs.jobs.prune.enabled';
UPDATE public.platform_config SET value = value - 'jobs.tenancy.purge-due.enabled'
 WHERE key = 'config.dual_control_keys';
INSERT INTO public.job_schedules (kind, last_enqueued) VALUES ('replay.schedule', 3);
SQL
before=$(snapshot)
for f in $order; do
  case "$f" in 050_jobs.sql|051_social_scheduled_agents.sql) ;; *) continue ;; esac
  "${PSQL[@]}" --single-transaction -f "$ROOT/supabase/migrations/$f" >/dev/null 2>&1 \
    || { echo "✗ $f failed when applied a second time:"; "${PSQL[@]}" --single-transaction -f "$ROOT/supabase/migrations/$f" >/dev/null; exit 1; }
done
after=$(snapshot)
if [ "$before" != "$after" ]; then
  echo "✗ applying 050 and 051 a second time changed the database:"
  diff <(echo "$before") <(echo "$after") || true
  exit 1
fi
[ "$("${PSQL[@]}" -At -c "SELECT value::text FROM public.platform_config WHERE key = 'jobs.jobs.prune.enabled'")" = "false" ] \
  || { echo "✗ re-running 050 undid an operator's schedule choice"; exit 1; }
# A third application: still removed (050 seeds dual control on its first application only).
"${PSQL[@]}" --single-transaction -f "$ROOT/supabase/migrations/050_jobs.sql" >/dev/null 2>&1 \
  || { echo "✗ 050 failed when applied a third time"; exit 1; }
[ "$("${PSQL[@]}" -At -c "SELECT value @> '[\"jobs.tenancy.purge-due.enabled\"]' FROM public.platform_config WHERE key = 'config.dual_control_keys'")" = "f" ] \
  || { echo "✗ re-running 050 put back a dual-control key an operator removed"; exit 1; }
"${PSQL[@]}" -At <<SQL >/dev/null
UPDATE public.platform_config SET value = 'true' WHERE key = 'jobs.jobs.prune.enabled';
UPDATE public.platform_config SET value = '$dual_before'::jsonb WHERE key = 'config.dual_control_keys';
DELETE FROM public.job_schedules WHERE kind = 'replay.schedule';
SQL

step "audit wave 2: 052's changes are present"
"${PSQL[@]}" -At <<'SQL' >/dev/null
DO $$
DECLARE missing text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                  WHERE t.typname = 'audit_action' AND e.enumlabel = 'logout') THEN
    RAISE EXCEPTION '052: audit_action has no logout';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
       AND table_name = 'user_deletions' AND column_name IN ('standing', 'email_hash', 'email_hash_key')) <> 3 THEN
    RAISE EXCEPTION '052: user_deletions lacks standing, email_hash or email_hash_key';
  END IF;
  -- Review 8 H-C: whole-value replacement; callable by the request role, not by the public key.
  IF to_regprocedure('public.jsonb_replace_text_value(jsonb, text, text)') IS NULL
     OR NOT has_function_privilege('app_tenant', 'public.jsonb_replace_text_value(jsonb, text, text)', 'execute')
     OR has_function_privilege('public', 'public.jsonb_replace_text_value(jsonb, text, text)', 'execute') THEN
    RAISE EXCEPTION '052: jsonb_replace_text_value missing, or granted wrongly';
  END IF;
  IF public.jsonb_replace_text_value('{"a": ["Ann@X.Y", "joann@x.y", {"b": "ann@x.y"}], "c": "mail ann@x.y"}', 'ann@x.y', 'id')
     <> '{"a": ["id", "joann@x.y", {"b": "id"}], "c": "mail ann@x.y"}'::jsonb THEN
    RAISE EXCEPTION '052: jsonb_replace_text_value replaced more or less than whole values';
  END IF;
  -- Review 8 M2: every setting whose change is a change of power is under dual control.
  SELECT string_agg(k, ', ') INTO missing FROM unnest(ARRAY[
      'auth.token_cache_seconds', 'auth.token_stale_grace_seconds', 'agent.capability_features',
      'agent.trusted_agents', 'agent.delegation.max_ttl_seconds', 'agent.budget.tenant_max_cost_per_day',
      'account_status.known_features', 'account_status.restricted_features',
      'account_status.suspended_features', 'coppa.enforcement_enabled', 'coppa.blocked_features',
      'profile.screened_fields', 'moderation.level3.block_severity', 'moderation.level3.warn_severity',
      'moderation.level3.escalate_below', 'moderation.strike_suspend_threshold',
      'config.approval_expiry_days']) AS k
   WHERE NOT (SELECT value @> to_jsonb(k) FROM public.platform_config WHERE key = 'config.dual_control_keys');
  IF missing IS NOT NULL THEN RAISE EXCEPTION '052: not under dual control: %', missing; END IF;
  SELECT string_agg(k, ', ') INTO missing FROM unnest(ARRAY['auth.staff_mfa_required', 'admin.dual_control_actions']) AS k
   WHERE NOT EXISTS (SELECT 1 FROM public.platform_config c WHERE c.key = k AND c.permission_tier = 'safety')
      OR NOT (SELECT value @> to_jsonb(k) FROM public.platform_config WHERE key = 'config.dual_control_keys');
  IF missing IS NOT NULL THEN RAISE EXCEPTION '052: not seeded under dual control: %', missing; END IF;
  SELECT string_agg(key, ', ') INTO missing FROM public.platform_config
   WHERE key IN ('account_status.known_features', 'coppa.blocked_features') AND NOT value @> '["stream"]';
  IF missing IS NOT NULL THEN RAISE EXCEPTION '052: stream missing from %', missing; END IF;
  -- Retired, not deleted: the row (and so its history) stays, marked, off the dual-control list.
  IF NOT EXISTS (SELECT 1 FROM public.platform_config
                  WHERE key = 'moderation.blocklist_only_surfaces' AND category = 'retired')
     OR (SELECT value ? 'moderation.blocklist_only_surfaces' FROM public.platform_config WHERE key = 'config.dual_control_keys') THEN
    RAISE EXCEPTION '052: moderation.blocklist_only_surfaces not retired';
  END IF;
  -- The entitlement actions are under dual control (review 7 M6).
  SELECT string_agg(a, ', ') INTO missing
    FROM unnest(ARRAY['create_entitlement_group', 'set_entitlement_group_active']) AS a
   WHERE NOT (SELECT value @> to_jsonb(a) FROM public.platform_config WHERE key = 'admin.dual_control_actions');
  IF missing IS NOT NULL THEN RAISE EXCEPTION '052: not held for a second admin: %', missing; END IF;
  -- One hold per change (review 10 H1): no config-writing action is held as an action — the keys
  -- they write are, under their own rules.
  SELECT string_agg(a, ', ') INTO missing
    FROM unnest(ARRAY['set_capability_mapping', 'register_agent', 'suspend_agent', 'set_agent_scope', 'set_agent_ttl']) AS a
   WHERE (SELECT value @> to_jsonb(a) FROM public.platform_config WHERE key = 'admin.dual_control_actions')
      OR (SELECT default_value @> to_jsonb(a) FROM public.platform_config WHERE key = 'admin.dual_control_actions');
  IF missing IS NOT NULL THEN RAISE EXCEPTION '052: a config write is held as an action too: %', missing; END IF;
  -- Review 10 H2: a run's claim of its approval.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'proposals_status_check'
                  AND pg_get_constraintdef(oid) LIKE '%executing%')
     OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_proposals_tenant_one_live'
                     AND indexdef LIKE '%executing%')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name = 'proposals' AND column_name = 'last_run_error') THEN
    RAISE EXCEPTION '052: proposals cannot record a run in progress (executing, last_run_error)';
  END IF;
  -- Review 11 H-1: a claim's generation, and a run whose outcome is unknown.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'proposals_status_check'
                  AND pg_get_constraintdef(oid) LIKE '%indeterminate%')
     OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_proposals_tenant_one_live'
                     AND indexdef LIKE '%indeterminate%')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name = 'proposals' AND column_name = 'run_token') THEN
    RAISE EXCEPTION '052: proposals cannot record a claim''s token or an undecided run (run_token, indeterminate)';
  END IF;
  SELECT string_agg(t, ', ') INTO missing FROM public.deletion_manifest m, unnest(m.table_names) AS t
   WHERE NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname = t);
  IF missing IS NOT NULL THEN RAISE EXCEPTION '052: the deletion manifest names missing tables: %', missing; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.deletion_manifest WHERE module_name = 'platform') THEN
    RAISE EXCEPTION '052: the deletion manifest has no platform module';
  END IF;
END $$;
SQL

step "audit wave 2: a hostile trajectory chain is refused (review 12 L6)"
# The chain guard (052) keeps every chain linear, numbered, in one tenant: each hostile row below
# must be refused — a cycle, a skipped segment, another tenant's predecessor, a wrong step_offset,
# a fork, a chain column changed, a step appended to a continued segment. All rolled back.
"${PSQL[@]}" -At <<'SQL' >/dev/null
BEGIN;
DO $$
DECLARE
  ta uuid := gen_random_uuid();
  tb uuid := gen_random_uuid();
  r uuid := gen_random_uuid();
  c uuid := gen_random_uuid();
  root uuid;
  refused boolean;
BEGIN
  INSERT INTO public.tenants (id, slug, name) VALUES
    (ta, 'replay-chain-a', 'Replay chain A'), (tb, 'replay-chain-b', 'Replay chain B');
  INSERT INTO public.agent_trajectories (id, tenant_id, subject_kind, subject_id, trigger, scope_type, status, steps, total_cost, version)
    VALUES (r, ta, 'agent', 'replay-chain', 't', 'platform', 'running', '[{"s":1},{"s":2}]', '{}', 1);
  IF (SELECT chain_root_id FROM public.agent_trajectories WHERE id = r) <> r THEN
    RAISE EXCEPTION 'a first segment is not its own chain root';
  END IF;
  -- A skipped segment, another tenant's predecessor, a wrong step_offset, a root not the chain's.
  FOR i IN 1..4 LOOP
    refused := false;
    BEGIN
      INSERT INTO public.agent_trajectories (id, tenant_id, subject_kind, subject_id, trigger, scope_type, status, steps, total_cost, version, segment, previous_trajectory_id, step_offset, chain_root_id)
        VALUES (gen_random_uuid(), CASE WHEN i = 2 THEN tb ELSE ta END, 'agent', 'replay-chain', 't', 'platform', 'running', '[]', '{}', 1,
                CASE WHEN i = 1 THEN 3 ELSE 2 END, r, CASE WHEN i = 3 THEN 5 ELSE 2 END,
                CASE WHEN i = 4 THEN gen_random_uuid() ELSE NULL END);
    EXCEPTION WHEN check_violation THEN refused := true;
    END;
    IF NOT refused THEN RAISE EXCEPTION 'hostile continuation % was accepted', i; END IF;
  END LOOP;
  -- The one valid continuation: its chain root is set by the database.
  INSERT INTO public.agent_trajectories (id, tenant_id, subject_kind, subject_id, trigger, scope_type, status, steps, total_cost, version, segment, previous_trajectory_id, step_offset)
    VALUES (c, ta, 'agent', 'replay-chain', 't', 'platform', 'running', '[]', '{}', 1, 2, r, 2);
  SELECT chain_root_id INTO root FROM public.agent_trajectories WHERE id = c;
  IF root <> r THEN RAISE EXCEPTION 'a continuation''s chain root is not its chain''s first segment'; END IF;
  -- A fork: a second continuation of the same segment.
  refused := false;
  BEGIN
    INSERT INTO public.agent_trajectories (id, tenant_id, subject_kind, subject_id, trigger, scope_type, status, steps, total_cost, version, segment, previous_trajectory_id, step_offset)
      VALUES (gen_random_uuid(), ta, 'agent', 'replay-chain', 't', 'platform', 'running', '[]', '{}', 1, 2, r, 2);
  EXCEPTION WHEN unique_violation THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'a forked chain was accepted'; END IF;
  -- A cycle: the first segment re-linked after its own continuation.
  refused := false;
  BEGIN
    UPDATE public.agent_trajectories SET previous_trajectory_id = c, segment = 3 WHERE id = r;
  EXCEPTION WHEN check_violation THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'a cyclic chain was accepted'; END IF;
  -- A step appended to a segment that has been continued.
  refused := false;
  BEGIN
    UPDATE public.agent_trajectories SET steps = steps || '[{"s":3}]'::jsonb WHERE id = r;
  EXCEPTION WHEN check_violation THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'a step was appended to a continued segment'; END IF;
  -- An erasure's same-length rewrite of a continued segment's steps is allowed.
  UPDATE public.agent_trajectories SET steps = '[{"s":"x"},{"s":"y"}]'::jsonb WHERE id = r;
END $$;
ROLLBACK;
SQL

step "audit wave 2: 052 applied again changes nothing (idempotent)"
# An operator's choices since 052 (a key taken off dual control, stream taken off the consent-gated
# list) must survive a re-run, as must every other object.
dual_before=$("${PSQL[@]}" -At -c "SELECT value::text FROM public.platform_config WHERE key = 'config.dual_control_keys'")
blocked_before=$("${PSQL[@]}" -At -c "SELECT value::text FROM public.platform_config WHERE key = 'coppa.blocked_features'")
"${PSQL[@]}" -At <<'SQL' >/dev/null
UPDATE public.platform_config SET value = value - 'admin.dual_control_actions'
 WHERE key = 'config.dual_control_keys';
UPDATE public.platform_config SET value = value - 'stream' WHERE key = 'coppa.blocked_features';
SQL
before=$(snapshot)
# Review 11 L-6: the email-hash scheme CHECK is not dropped and re-added (a full scan under an
# exclusive lock) when it is already this release's form — the same constraint object afterwards.
hash_check_q="SELECT c.oid::text || ':' || c.convalidated::text FROM pg_constraint c WHERE c.conrelid = 'public.user_deletions'::regclass AND c.conname = 'user_deletions_email_hash_scheme_known'"
hash_check_before=$("${PSQL[@]}" -At -c "$hash_check_q")
"${PSQL[@]}" --single-transaction -f "$ROOT/supabase/migrations/052_audit_wave2.sql" >/dev/null 2>&1 \
  || { echo "✗ 052 failed when applied a second time:"; "${PSQL[@]}" --single-transaction -f "$ROOT/supabase/migrations/052_audit_wave2.sql" >/dev/null; exit 1; }
hash_check_after=$("${PSQL[@]}" -At -c "$hash_check_q")
case "$hash_check_before" in
  *:true) ;;
  *) echo "✗ the email-hash scheme CHECK is missing or not validated: $hash_check_before"; exit 1 ;;
esac
if [ "$hash_check_before" != "$hash_check_after" ]; then
  echo "✗ 052 re-created the email-hash scheme CHECK on a second application ($hash_check_before → $hash_check_after)"
  exit 1
fi
after=$(snapshot)
if [ "$before" != "$after" ]; then
  echo "✗ applying 052 a second time changed the database:"
  diff <(echo "$before") <(echo "$after") || true
  exit 1
fi
"${PSQL[@]}" -At <<SQL >/dev/null
UPDATE public.platform_config SET value = '$dual_before'::jsonb WHERE key = 'config.dual_control_keys';
UPDATE public.platform_config SET value = '$blocked_before'::jsonb WHERE key = 'coppa.blocked_features';
SQL

step "audit wave 2: a database that ran an earlier 052 gets the keys added since, removals stand (review 13 L4)"
# An earlier 052 seeded the dual-control list once and kept no per-key record. Simulated here: no
# record; agent.trajectory_max_segments never seeded (an earlier list lacked it); and
# coppa.enforcement_enabled removed by an operator (a config-history row says so). Re-applied, 052
# adds the never-seeded key and leaves the removed one off. Rolled back afterwards.
"${PSQL[@]}" -At <<SQL >/dev/null
BEGIN;
SET LOCAL client_min_messages = warning;
DELETE FROM public.config_dual_control_seeded;
UPDATE public.platform_config
   SET value = value - 'agent.trajectory_max_segments' - 'coppa.enforcement_enabled'
 WHERE key = 'config.dual_control_keys';
INSERT INTO public.platform_config_history
  (config_key, previous_value, new_value, change_comment, change_source, scope)
SELECT 'config.dual_control_keys', value || '["coppa.enforcement_enabled"]'::jsonb, value,
       'replay: an operator takes coppa.enforcement_enabled off dual control', 'admin_ui', 'platform'
  FROM public.platform_config WHERE key = 'config.dual_control_keys';
\i $ROOT/supabase/migrations/052_audit_wave2.sql
DO \$\$
DECLARE v jsonb := (SELECT value FROM public.platform_config WHERE key = 'config.dual_control_keys');
BEGIN
  IF NOT v ? 'agent.trajectory_max_segments' THEN
    RAISE EXCEPTION 'a key never seeded on this database was not added: %', v;
  END IF;
  IF v ? 'coppa.enforcement_enabled' THEN
    RAISE EXCEPTION 'an operator''s removal was undone: %', v;
  END IF;
  IF (SELECT outcome FROM public.config_dual_control_seeded WHERE key = 'agent.trajectory_max_segments') <> 'added'
     OR (SELECT outcome FROM public.config_dual_control_seeded WHERE key = 'coppa.enforcement_enabled') <> 'removed_by_operator'
     OR (SELECT outcome FROM public.config_dual_control_seeded WHERE key = 'agent.trusted_agents') <> 'already_listed' THEN
    RAISE EXCEPTION 'the seeded-keys record is wrong: %',
      (SELECT jsonb_object_agg(key, outcome) FROM public.config_dual_control_seeded);
  END IF;
END \$\$;
ROLLBACK;
SQL

step "audit wave 2: 052 keeps what is not the platform's to remove (review 7 L2)"
# Re-applied over hostile rows: an app module's manifest row naming a table a later migration of
# the app creates, a schema-qualified name, a quoted mixed-case name, a legacy row naming a
# retired platform table beside a live one; and the retired key's history and a pending approval.
"${PSQL[@]}" -At <<'SQL' >/dev/null
INSERT INTO public.deletion_manifest (module_name, table_names, description) VALUES
  ('replay_app_later', ARRAY['quiz_scores'], 'replay'),
  ('replay_app_qualified', ARRAY['public.users', 'other.schema.name'], 'replay'),
  ('replay_app_mixed', ARRAY['Foo'], 'replay'),
  ('replay_legacy', ARRAY['players', 'consent_records', 'player_devices'], 'replay'),
  ('replay_legacy_only', ARRAY['player_entitlements'], 'replay');
INSERT INTO public.platform_config_history (config_key, previous_value, new_value, changed_by, change_comment, change_source)
  VALUES ('moderation.blocklist_only_surfaces', '[]', '["x"]', NULL, 'replay', 'admin_ui');
INSERT INTO public.config_pending_approvals (config_key, proposed_value, change_comment, scope, tenant_id)
  VALUES ('moderation.blocklist_only_surfaces', '["y"]', 'replay', 'platform', NULL);
SQL
history_before=$("${PSQL[@]}" -At -c "SELECT count(*) FROM public.platform_config_history WHERE config_key = 'moderation.blocklist_only_surfaces'")
"${PSQL[@]}" --single-transaction -f "$ROOT/supabase/migrations/052_audit_wave2.sql" >/dev/null 2>&1 \
  || { echo "✗ 052 failed over hostile deletion-manifest rows:"; "${PSQL[@]}" --single-transaction -f "$ROOT/supabase/migrations/052_audit_wave2.sql" >/dev/null; exit 1; }
"${PSQL[@]}" -At <<SQL >/dev/null
DO \$\$
DECLARE got text;
BEGIN
  SELECT string_agg(module_name || '=' || array_to_string(table_names, '|'), ' ' ORDER BY module_name) INTO got
    FROM public.deletion_manifest WHERE module_name LIKE 'replay\\_%';
  IF got IS DISTINCT FROM 'replay_app_later=quiz_scores replay_app_mixed=Foo replay_app_qualified=public.users|other.schema.name replay_legacy=consent_records' THEN
    RAISE EXCEPTION '052 changed rows that are not the platform''s to remove: %', got;
  END IF;
  IF (SELECT count(*) FROM public.platform_config_history WHERE config_key = 'moderation.blocklist_only_surfaces') <> $history_before THEN
    RAISE EXCEPTION '052 lost the retired setting''s history';
  END IF;
  IF EXISTS (SELECT 1 FROM public.config_pending_approvals
              WHERE config_key = 'moderation.blocklist_only_surfaces' AND status = 'pending') THEN
    RAISE EXCEPTION '052 left an approval of the retired setting pending';
  END IF;
END \$\$;
DELETE FROM public.deletion_manifest WHERE module_name LIKE 'replay\\_%';
DELETE FROM public.config_pending_approvals WHERE config_key = 'moderation.blocklist_only_surfaces' AND change_comment = 'replay';
DELETE FROM public.platform_config_history WHERE config_key = 'moderation.blocklist_only_surfaces' AND change_comment = 'replay';
SQL

step "audit wave 2: an email hash's key id never stands without its scheme (review 10 L12)"
# The CHECK passed on NULL: `email_hash_scheme = 'hmac-of-sha256'` is NULL for a key id with no
# scheme, and a CHECK passes on NULL. A hostile row is refused; the valid forms are accepted.
hostile=$("${PSQL[@]}" -At -c "INSERT INTO public.user_deletions (tenant_id, user_id, requested_by, email_hash, email_hash_key, email_hash_scheme) SELECT id, gen_random_uuid(), 'replay', repeat('a', 64), repeat('b', 16), NULL FROM public.tenants ORDER BY id LIMIT 1" 2>&1 || true)
case "$hostile" in
  *user_deletions_email_hash_scheme_known*) ;;
  *) echo "✗ a key id with no scheme was not refused: $hostile"; exit 1 ;;
esac
"${PSQL[@]}" -At <<'SQL' >/dev/null
INSERT INTO public.user_deletions (tenant_id, user_id, requested_by, email_hash, email_hash_key, email_hash_scheme)
SELECT id, gen_random_uuid(), 'replay-valid', repeat('a', 64), k, s
  FROM (SELECT id FROM public.tenants ORDER BY id LIMIT 1) t,
       (VALUES (repeat('b', 16), 'hmac-of-sha256'), (NULL, 'sha256'), (NULL, NULL)) v(k, s);
DELETE FROM public.user_deletions WHERE requested_by = 'replay-valid';
SQL
for bad in "repeat('b', 16), 'sha256'" "NULL, 'unknown'"; do
  refused=$("${PSQL[@]}" -At -c "INSERT INTO public.user_deletions (tenant_id, user_id, requested_by, email_hash, email_hash_key, email_hash_scheme) SELECT id, gen_random_uuid(), 'replay', repeat('a', 64), $bad FROM public.tenants ORDER BY id LIMIT 1" 2>&1 || true)
  case "$refused" in
    *user_deletions_email_hash_scheme_known*) ;;
    *) echo "✗ ($bad) was not refused: $refused"; exit 1 ;;
  esac
done

step "053: a workflow can wait to be approved again (awaiting_retry); applied again changes nothing"
"${PSQL[@]}" -At <<'SQL' >/dev/null
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                  WHERE t.typname = 'trajectory_status' AND e.enumlabel = 'awaiting_retry') THEN
    RAISE EXCEPTION '053: trajectory_status has no awaiting_retry';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.applied_migrations
                  WHERE filename = '053_trajectory_awaiting_retry.sql') THEN
    RAISE EXCEPTION '053 is not recorded in applied_migrations';
  END IF;
  PERFORM 'awaiting_retry'::public.trajectory_status;
END $$;
SQL
enum_before=$("${PSQL[@]}" -At -c "SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder) FROM pg_enum WHERE enumtypid = 'public.trajectory_status'::regtype")
before=$(snapshot)
"${PSQL[@]}" --single-transaction -f "$ROOT/supabase/migrations/053_trajectory_awaiting_retry.sql" >/dev/null 2>&1 \
  || { echo "✗ 053 failed when applied a second time:"; "${PSQL[@]}" --single-transaction -f "$ROOT/supabase/migrations/053_trajectory_awaiting_retry.sql" >/dev/null; exit 1; }
after=$(snapshot)
enum_after=$("${PSQL[@]}" -At -c "SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder) FROM pg_enum WHERE enumtypid = 'public.trajectory_status'::regtype")
if [ "$before" != "$after" ] || [ "$enum_before" != "$enum_after" ]; then
  echo "✗ applying 053 a second time changed the database:"
  diff <(echo "$before"; echo "$enum_before") <(echo "$after"; echo "$enum_after") || true
  exit 1
fi

step "054: an erasure remembers the identity it closed (user_deletions.cognito_sub); applied again changes nothing"
"${PSQL[@]}" -At <<'SQL' >/dev/null
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'user_deletions'
                    AND column_name = 'cognito_sub' AND data_type = 'text') THEN
    RAISE EXCEPTION '054: user_deletions has no cognito_sub';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname = 'public' AND indexname = 'user_deletions_cognito_sub_idx') THEN
    RAISE EXCEPTION '054: user_deletions_cognito_sub_idx is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.applied_migrations
                  WHERE filename = '054_user_deletions_subject.sql') THEN
    RAISE EXCEPTION '054 is not recorded in applied_migrations';
  END IF;
END $$;
SQL
# The backfill: a soft-deleted account's record is given its subject; one already set is kept.
"${PSQL[@]}" -At <<'SQL' >/dev/null
DO $$
DECLARE t uuid; a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); got text;
BEGIN
  SELECT id INTO t FROM public.tenants ORDER BY id LIMIT 1;
  INSERT INTO public.users (id, cognito_sub, role_id, tenant_id, deleted_at)
  SELECT a, 'replay-054-sub', r.id, t, now() FROM public.roles r WHERE r.is_default LIMIT 1;
  INSERT INTO public.user_deletions (tenant_id, user_id, requested_by) VALUES (t, a, 'replay-054');
  INSERT INTO public.user_deletions (tenant_id, user_id, requested_by, cognito_sub)
  VALUES (t, b, 'replay-054', 'replay-054-kept');
  UPDATE public.user_deletions d SET cognito_sub = u.cognito_sub FROM public.users u
   WHERE u.tenant_id = d.tenant_id AND u.id = d.user_id AND u.cognito_sub IS NOT NULL
     AND d.cognito_sub IS NULL;
  SELECT cognito_sub INTO got FROM public.user_deletions WHERE user_id = a;
  IF got IS DISTINCT FROM 'replay-054-sub' THEN RAISE EXCEPTION '054 backfill: %', got; END IF;
  SELECT cognito_sub INTO got FROM public.user_deletions WHERE user_id = b;
  IF got IS DISTINCT FROM 'replay-054-kept' THEN RAISE EXCEPTION '054 backfill overwrote: %', got; END IF;
  DELETE FROM public.user_deletions WHERE requested_by = 'replay-054';
  DELETE FROM public.users WHERE id = a;
END $$;
SQL
ud_sql="SELECT md5(coalesce(string_agg(to_jsonb(d)::text, '' ORDER BY d.tenant_id, d.user_id), '')) || '|' || (SELECT count(*) FROM pg_indexes WHERE tablename = 'user_deletions') FROM public.user_deletions d"
before="$(snapshot)$("${PSQL[@]}" -At -c "$ud_sql")"
"${PSQL[@]}" --single-transaction -f "$ROOT/supabase/migrations/054_user_deletions_subject.sql" >/dev/null 2>&1 \
  || { echo "✗ 054 failed when applied a second time:"; "${PSQL[@]}" --single-transaction -f "$ROOT/supabase/migrations/054_user_deletions_subject.sql" >/dev/null; exit 1; }
after="$(snapshot)$("${PSQL[@]}" -At -c "$ud_sql")"
if [ "$before" != "$after" ]; then
  echo "✗ applying 054 a second time changed the database:"
  diff <(echo "$before") <(echo "$after") || true
  exit 1
fi

step "055: accounts are found by their address with an index; applied again changes nothing"
"${PSQL[@]}" -At <<'SQL' >/dev/null
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname = 'public' AND tablename = 'users'
                    AND indexname = 'users_tenant_email_lookup_idx'
                    AND indexdef ILIKE '%(tenant_id, lower(btrim(email)))%') THEN
    RAISE EXCEPTION '055: users_tenant_email_lookup_idx is missing or not on (tenant_id, lower(btrim(email)))';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.applied_migrations
                  WHERE filename = '055_users_email_lookup.sql') THEN
    RAISE EXCEPTION '055 is not recorded in applied_migrations';
  END IF;
END $$;
SQL
ix_sql="SELECT string_agg(indexname || ':' || indexdef, '|' ORDER BY indexname) FROM pg_indexes WHERE tablename = 'users'"
before="$(snapshot)$("${PSQL[@]}" -At -c "$ix_sql")"
"${PSQL[@]}" --single-transaction -f "$ROOT/supabase/migrations/055_users_email_lookup.sql" >/dev/null 2>&1 \
  || { echo "✗ 055 failed when applied a second time:"; "${PSQL[@]}" --single-transaction -f "$ROOT/supabase/migrations/055_users_email_lookup.sql" >/dev/null; exit 1; }
after="$(snapshot)$("${PSQL[@]}" -At -c "$ix_sql")"
if [ "$before" != "$after" ]; then
  echo "✗ applying 055 a second time changed the database:"
  diff <(echo "$before") <(echo "$after") || true
  exit 1
fi

step "056: the Users list's sort indexes (no search index); applied again changes nothing"
"${PSQL[@]}" -At <<'SQL' >/dev/null
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'users'
                  AND indexname = 'users_tenant_created_idx'
                  AND indexdef ILIKE '%(tenant_id, created_at DESC, id)%') THEN
    RAISE EXCEPTION '056: users_tenant_created_idx is missing or not on (tenant_id, created_at desc, id)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'users'
                  AND indexname = 'users_tenant_last_login_idx'
                  AND indexdef ILIKE '%(tenant_id, last_login_at DESC NULLS LAST, id)%') THEN
    RAISE EXCEPTION '056: users_tenant_last_login_idx is missing or not on (tenant_id, last_login_at desc nulls last, id)';
  END IF;
  -- No trigram index: under row-level security the request role cannot use one (see 056).
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'users'
              AND indexdef ILIKE '%gin_trgm_ops%') THEN
    RAISE EXCEPTION '056: a trigram index on users is not expected';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.applied_migrations
                  WHERE filename = '056_users_list_indexes.sql') THEN
    RAISE EXCEPTION '056 is not recorded in applied_migrations';
  END IF;
END $$;
SQL
ix_sql="SELECT string_agg(indexname || ':' || indexdef, '|' ORDER BY indexname) FROM pg_indexes WHERE tablename = 'users'"
before="$(snapshot)$("${PSQL[@]}" -At -c "$ix_sql")"
"${PSQL[@]}" --single-transaction -f "$ROOT/supabase/migrations/056_users_list_indexes.sql" >/dev/null 2>&1 \
  || { echo "✗ 056 failed when applied a second time:"; "${PSQL[@]}" --single-transaction -f "$ROOT/supabase/migrations/056_users_list_indexes.sql" >/dev/null; exit 1; }
after="$(snapshot)$("${PSQL[@]}" -At -c "$ix_sql")"
if [ "$before" != "$after" ]; then
  echo "✗ applying 056 a second time changed the database:"
  diff <(echo "$before") <(echo "$after") || true
  exit 1
fi

step "057: last sign-in filled from the record (latest non-refresh, never lowered); applied again changes nothing"
"${PSQL[@]}" -At <<'SQL' >/dev/null
DO $$
DECLARE t uuid; a uuid := gen_random_uuid(); b uuid := gen_random_uuid();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.applied_migrations
                  WHERE filename = '057_users_last_login_backfill.sql') THEN
    RAISE EXCEPTION '057 is not recorded in applied_migrations';
  END IF;
  SELECT id INTO t FROM public.tenants ORDER BY id LIMIT 1;
  INSERT INTO public.users (id, cognito_sub, role_id, tenant_id, last_login_at)
  SELECT a, 'replay-057-a', r.id, t, NULL FROM public.roles r WHERE r.is_default LIMIT 1;
  INSERT INTO public.users (id, cognito_sub, role_id, tenant_id, last_login_at)
  SELECT b, 'replay-057-b', r.id, t, now() FROM public.roles r WHERE r.is_default LIMIT 1;
  INSERT INTO public.audit_log (tenant_id, action, actor_id, details, created_at) VALUES
    (t, 'login_success', a, '{"method":"password"}', now() - interval '2 days'),
    (t, 'login_success', a, '{"method":"refresh"}', now() - interval '1 day'),
    (t, 'login_success', b, '{"method":"sso"}', now() - interval '3 days');
END $$;
SQL
"${PSQL[@]}" --single-transaction -f "$ROOT/supabase/migrations/057_users_last_login_backfill.sql" >/dev/null
"${PSQL[@]}" -At <<'SQL' >/dev/null
DO $$
DECLARE a_at timestamptz; b_at timestamptz;
BEGIN
  SELECT last_login_at INTO a_at FROM public.users WHERE cognito_sub = 'replay-057-a';
  SELECT last_login_at INTO b_at FROM public.users WHERE cognito_sub = 'replay-057-b';
  IF a_at IS NULL OR a_at > now() - interval '47 hours' THEN
    RAISE EXCEPTION '057: last_login_at is not the latest non-refresh sign-in (got %)', a_at;
  END IF;
  IF b_at < now() - interval '1 hour' THEN
    RAISE EXCEPTION '057: a later last_login_at was lowered (got %)', b_at;
  END IF;
END $$;
SQL
ll_sql="SELECT string_agg(id::text || ':' || coalesce(last_login_at::text, '-') || ':' || updated_at::text, ',' ORDER BY id) FROM public.users"
before="$(snapshot)$("${PSQL[@]}" -At -c "$ll_sql")"
"${PSQL[@]}" --single-transaction -f "$ROOT/supabase/migrations/057_users_last_login_backfill.sql" >/dev/null 2>&1 \
  || { echo "✗ 057 failed when applied a second time:"; "${PSQL[@]}" --single-transaction -f "$ROOT/supabase/migrations/057_users_last_login_backfill.sql" >/dev/null; exit 1; }
after="$(snapshot)$("${PSQL[@]}" -At -c "$ll_sql")"
if [ "$before" != "$after" ]; then
  echo "✗ applying 057 a second time changed the database:"
  diff <(echo "$before") <(echo "$after") || true
  exit 1
fi
"${PSQL[@]}" -At -c "DELETE FROM public.audit_log WHERE actor_id IN (SELECT id FROM public.users WHERE cognito_sub LIKE 'replay-057-%')" \
  -c "DELETE FROM public.users WHERE cognito_sub LIKE 'replay-057-%'" >/dev/null

step "058: ai.prompt_cache_enabled seeded off, operator-only; applied again keeps an operator's value"
"${PSQL[@]}" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.platform_config
                  WHERE key = 'ai.prompt_cache_enabled' AND value = 'false'::jsonb
                    AND value_type = 'boolean' AND tenant_overridable = false) THEN
    RAISE EXCEPTION '058: ai.prompt_cache_enabled is not seeded off and operator-only';
  END IF;
END $$;
UPDATE public.platform_config SET value = 'true'::jsonb WHERE key = 'ai.prompt_cache_enabled';
SQL
"${PSQL[@]}" --single-transaction -f "$ROOT/supabase/migrations/058_ai_prompt_cache_setting.sql" >/dev/null
[ "$("${PSQL[@]}" -At -c "SELECT value::text FROM public.platform_config WHERE key = 'ai.prompt_cache_enabled'")" = "true" ] \
  || { echo "✗ applying 058 a second time overwrote an operator's value"; exit 1; }
"${PSQL[@]}" -c "UPDATE public.platform_config SET value = 'false'::jsonb WHERE key = 'ai.prompt_cache_enabled'" >/dev/null

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
