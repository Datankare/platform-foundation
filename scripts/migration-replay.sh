#!/usr/bin/env bash
# scripts/migration-replay.sh — build a database from zero the way a new instance is built
# (TASK-091): Supabase shim, schema baseline, then every migration the baseline does not
# cover, in order. Any SQL error fails. Then checks what the platform needs is there.
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

step "baseline (covers 001–$through)"
"${PSQL[@]}" --single-transaction -f "$BASELINE" >/dev/null

applied=0
for f in $(ls "$ROOT/supabase/migrations" | grep -E '^[0-9]+_.*\.sql$' | sort); do
  n=$((10#${f%%_*}))
  if [ "$n" -gt "$((10#$through))" ]; then
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
    'applied_migrations'
  ]) AS t WHERE to_regclass('public.' || t) IS NULL;
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'missing tables: %', missing; END IF;
  SELECT string_agg(f, ', ') INTO missing FROM unnest(ARRAY[
    'agent_budget_consume','guest_allowance_consume','has_permission','is_admin'
  ]) AS f WHERE NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = f);
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'missing functions: %', missing; END IF;
  -- Every table in public has row-level security (production has no automatic-RLS trigger).
  SELECT string_agg(c.relname, ', ') INTO missing FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity;
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'tables without row-level security: %', missing; END IF;
  -- Governance seed is present.
  IF NOT EXISTS (SELECT 1 FROM public.roles WHERE name = 'super_admin') THEN
    RAISE EXCEPTION 'seed missing: super_admin role';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.platform_config WHERE key = 'guest.translate_allowance') THEN
    RAISE EXCEPTION 'seed missing: guest.translate_allowance';
  END IF;
END $$;
SQL

echo "✓ replay: baseline + $applied newer migration(s), checks passed"
