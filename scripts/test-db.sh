#!/usr/bin/env bash
# scripts/test-db.sh — the database suites, locally, as CI runs them (TASK-204, N-10)
#
#   npm run test:db              the __tests__/db suites on a fresh replayed database, then the
#                                serial pass (__tests__/db-serial)
#   npm run test:db -- --full    the whole suite with coverage on it, the coverage ratchet, then
#                                the serial pass
#
# `npm test` alone skips every dbDescribe suite (no TEST_DATABASE_URL), so a change that breaks
# one passes locally. This builds a throwaway database the way CI does — scripts/migration-replay.sh
# into an empty database, app_tenant given a random password for this run — runs the suites with
# REQUIRE_DB_TESTS=1 (a missing database fails, never skips), and drops the database at the end.
#
# Needs a local Postgres (17, as CI; 16 works) with the pgvector extension, reached through the
# standard PG* settings: PGHOST (default localhost), PGPORT (5432), PGUSER (postgres) and, if the
# server asks for one, PGPASSWORD — set it with `read -rs PGPASSWORD` and `export PGPASSWORD`,
# never on a command line. The user must be able to create databases and alter roles.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PGHOST="${PGHOST:-localhost}" PGPORT="${PGPORT:-5432}" PGUSER="${PGUSER:-postgres}"

mode="db"
case "${1:-}" in
  "") ;;
  --full) mode="full" ;;
  *) echo "usage: npm run test:db [-- --full]" >&2; exit 2 ;;
esac

command -v psql >/dev/null || { echo "test:db: psql is not installed (a Postgres client is needed)" >&2; exit 1; }
psql -X -q -d postgres -c "select 1" >/dev/null || {
  echo "test:db: cannot reach Postgres at $PGHOST:$PGPORT as $PGUSER (see the header of scripts/test-db.sh)" >&2
  exit 1
}

db="pf_test_$(date +%s)_$$"
psql -X -q -d postgres -c "CREATE DATABASE $db" >/dev/null
cleanup() { psql -X -q -d postgres -c "DROP DATABASE IF EXISTS $db WITH (FORCE)" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "test:db: replaying the migrations into $db"
PGDATABASE="$db" bash scripts/migration-replay.sh >/dev/null
pw="local-$(openssl rand -hex 16)"
PGDATABASE="$db" psql -X -q -v ON_ERROR_STOP=1 -c "ALTER ROLE app_tenant LOGIN PASSWORD '$pw'" >/dev/null

enc() { node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"; }
owner_auth="$(enc "$PGUSER")"
if [ -n "${PGPASSWORD:-}" ]; then owner_auth="$owner_auth:$(enc "$PGPASSWORD")"; fi
export TEST_DATABASE_URL="postgresql://app_tenant:$pw@$PGHOST:$PGPORT/$db"
export TEST_DATABASE_OWNER_URL="postgresql://$owner_auth@$PGHOST:$PGPORT/$db"
export REQUIRE_DB_TESTS=1

if [ "$mode" = "full" ]; then
  npm run test:coverage -- --silent
  npm run coverage:ratchet
else
  npx jest __tests__/db --silent
fi
# The suites that act on a seeded key run alone, after the parallel ones (TASK-204, N-19).
npm run test:db-serial -- --silent
