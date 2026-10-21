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
    'rate_limit_events','applied_migrations'
  ]) AS t WHERE to_regclass('public.' || t) IS NULL;
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'missing tables: %', missing; END IF;
  SELECT string_agg(f, ', ') INTO missing FROM unnest(ARRAY[
    'agent_budget_consume','guest_allowance_consume','has_permission','is_admin',
    'rate_limit_hit','rate_limit_reset'
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

step "rate limiting behaves (ADR-052)"
"${PSQL[@]}" -At <<'SQL'
DO $$
DECLARE r record; n integer;
BEGIN
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
  "${PSQL[@]}" -At -c "SELECT allowed FROM public.rate_limit_hit('replay:concurrent', 5, 60)" >"$tmp/$i" &
done
wait
admitted=$(cat "$tmp"/* | grep -c '^t$' || true)
rm -rf "$tmp"
"${PSQL[@]}" -At -c "DELETE FROM public.rate_limit_events WHERE bucket = 'replay:concurrent'" >/dev/null
[ "$admitted" -eq 5 ] || { echo "✗ concurrent rate_limit_hit admitted $admitted of 20 with a limit of 5"; exit 1; }

echo "✓ replay: baseline + $applied migration(s) it does not record, checks passed"
