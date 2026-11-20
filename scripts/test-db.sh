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

# Workers: a fixed number, never "cores less one" (jest's default) — TASK-229: the Mac test pass ran
# 15 on 16 cores, which needed max_connections raised and showed an order no 2–3-worker run could.
# TEST_DB_WORKERS overrides it (the pass is the same at 2 and at 15: the gate runs both). Each
# worker holds its app and owner pools (DATABASE_POOL_MAX=4 each, __tests__/helpers/db.ts), its
# setup's admin client and the nested runs a suite starts (worker-database.db.test.ts): measured at
# most 9 at once per worker (docs/PORTABILITY.md); 12 per worker and 10 more are asked for here.
workers="${TEST_DB_WORKERS:-4}"
case "$workers" in
  ''|*[!0-9]*) echo "test:db: TEST_DB_WORKERS must be a whole number of workers (1 or more), not '$workers'" >&2; exit 2 ;;
esac
# Leading zeros stripped: bash reads 08 and 09 as octal and fails on them (review B, N-4).
while [ "${#workers}" -gt 1 ] && [ "${workers#0}" != "$workers" ]; do workers="${workers#0}"; done
if [ "$workers" = "0" ]; then
  echo "test:db: TEST_DB_WORKERS must be a whole number of workers (1 or more), not '${TEST_DB_WORKERS}'" >&2
  exit 2
fi
# What this run may use: max_connections less the slots reserved for superusers (and, from
# Postgres 16, for pg_use_reserved_connections) and less the connections already open (N-4).
free="$(psql -X -At -d postgres -c "select current_setting('max_connections')::int - current_setting('superuser_reserved_connections')::int - coalesce(nullif(current_setting('reserved_connections', true), '')::int, 0) - (select count(*)::int from pg_stat_activity where backend_type = 'client backend') || ' ' || current_setting('max_connections')")"
max_conn="${free#* }"
free="${free%% *}"
need=$((workers * 12 + 10))
if [ "$free" -lt "$need" ]; then
  echo "test:db: $workers workers need about $need connections; this server has $free free (max_connections $max_conn, less reserved slots and connections already open)." >&2
  echo "test:db: run fewer (TEST_DB_WORKERS=2 npm run test:db) or raise max_connections on the server (then restart it)." >&2
  exit 1
fi
echo "test:db: $workers jest workers (TEST_DB_WORKERS), $free of max_connections $max_conn free"

# The Valkey suites (in --full) need valkey-server or redis-server and openssl. Present: their
# failure to start is a failure (REQUIRE_VALKEY_TESTS=1), never a skip. Absent: said here, plainly.
if command -v valkey-server >/dev/null 2>&1 || command -v redis-server >/dev/null 2>&1; then
  export REQUIRE_VALKEY_TESTS=1
elif [ "$mode" = "full" ]; then
  echo "test:db: no valkey-server or redis-server on PATH: the Valkey suites are SKIPPED in this run (install one, e.g. brew install valkey, to run them)" >&2
fi

db="pf_test_$(date +%s)_$$"
psql -X -q -d postgres -c "CREATE DATABASE $db" >/dev/null
# With it, the per-worker copies jest makes of it (TASK-218), should a run have been killed before
# its own teardown dropped them.
cleanup() {
  local copies
  copies="$(psql -X -At -d postgres -c "SELECT datname FROM pg_database WHERE datname LIKE '${db}\\_w%'" 2>/dev/null || true)"
  for d in $copies; do
    psql -X -q -d postgres -c "DROP DATABASE IF EXISTS \"$d\" WITH (FORCE)" >/dev/null 2>&1 || true
  done
  psql -X -q -d postgres -c "DROP DATABASE IF EXISTS $db WITH (FORCE)" >/dev/null 2>&1 || true
}
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
  npm run test:coverage -- --silent --maxWorkers="$workers"
  npm run coverage:ratchet
else
  npx jest __tests__/db --silent --maxWorkers="$workers"
fi
# The suites that act on a seeded key run alone, after the parallel ones (TASK-204, N-19).
npm run test:db-serial -- --silent
# Every run dropped its per-worker copies (TASK-223): one left fails here, named, before the exit
# cleanup removes it.
node scripts/check-test-database-copies.mjs
