# Portability — PostgreSQL, architectures, stacks and core counts

What the platform and its tests assume about the machine they run on, and what was measured to
show each assumption holds. Started with batch 56e-3a (platform TASK-229, ADR-058), after the
owner's Mac (Apple silicon arm64, 16 cores, PostgreSQL 17 in Docker) failed two database tests
that passed on every x86-64 CI runner.

## 1. PostgreSQL

- **PostgreSQL 17 or later.** Migration 074 refuses an older server: the bound reads
  `pg_column_toast_chunk_id` (new in 17). Production and CI run 17.6.
- **The owner role sees every row.** 075 reads every stored row once; it needs a role that is a
  superuser or has BYPASSRLS (`postgres` on Supabase; the pre-check's `sees_every_row`).
- **A different deparse fails loudly.** `json_bound_install` compares the trigger PostgreSQL stores
  with the text `json_bound_ddl` writes; a server that prints it otherwise fails the install at
  once (and readiness could never agree with it) rather than running unchecked.

## 2. The stack and stored JSON (ADR-058)

PostgreSQL reads, walks and builds JSON recursively and checks each level against
`max_stack_depth` (100 kB at least; 2 MB by default). How many levels fit depends on the build's
stack frames, which differ by architecture and compiler. So no stored value may be deeper than
**128** levels (074: every jsonb column, every role), and every operation the erasure uses was
driven at the least stack any PostgreSQL allows. The shallowest failing depth at
`max_stack_depth = 100kB` (bisection; design 56e-3a §2.4):

| Build                   | Shallowest failing operation              | Margin over 128 |
| ----------------------- | ----------------------------------------- | --------------- |
| x86-64, PostgreSQL 17.6 | `@>` at 419 (lax `$.**` 512; parse 731)   | 3.3×            |
| arm64, PostgreSQL 17.6  | `@>` at 385 (lax `$.**` 460) (under qemu) | 3.0×            |

At the default 2 MB each figure is ~20× larger. `__tests__/db/erasure-stack.db.test.ts` drives
every operation (and the bound's own walks) on 128-deep arrays, objects and alternations at
100 kB with a superuser test owner; without one it fails rather than skips. It runs on CI
(x86-64) and on the owner's Mac gate (arm64) — that run, not the qemu figures, is the arm64 proof.

## 3. Locks

Every lock the bound takes (074's install, the emergency off and its repair) goes through
`public.json_bound_lock`: the tables in order, within one budget per attempt — half of
`deadlock_timeout`, at most 100 ms — giving way to the application and trying again for up to
30 s, then failing with the table and its holders named. An application transaction never waits on
it longer than the budget, so the deadlock detector never picks the application
(`__tests__/db/migration-074-075.db.test.ts`, scripted with sessions and `pg_locks`).

## 4. Core counts and jest workers

| Assumption                                    | Where it broke, or could                                                                                 | Now                                                                                                                   |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Worker order = name order                     | `_w1 … _w9` sort as numbered; from 10 workers on, `_w10` sorts before `_w2` (collation C) — the Mac's 15 | Copy names compared as sets; a guard with 16 synthetic workers; the killed-run probe runs 12 workers on every machine |
| A nested jest run's worker count              | It took the machine's cores less one                                                                     | Every nested run names `--maxWorkers` (a guard)                                                                       |
| `test:db`'s worker count vs `max_connections` | Cores less one × the connections a worker holds; the Mac needed the server's limit raised                | `TEST_DB_WORKERS` (default 4) on every machine; `max_connections` checked first, in plain words                       |
| A wall-clock bound in a database test         | r13's "under 10 s" on a machine running 15 workers                                                       | Bounded in work (three audited batches), not time                                                                     |
| Database-wide statistics                      | Another worker's queries change them                                                                     | A test reads only its own transaction's counters (`pg_stat_get_xact_*`)                                               |

The database pass runs at 2, 4 and 12 workers in each batch's gates (`max_connections` raised for
the 12-worker run); all must pass.

## 5. macOS userland

- Shell executed by tests: bash 3.2 and BSD tools (`__tests__/shell-portability.test.ts`).
- **Ports.** macOS lets any process listen on a low port (since 10.14): a test of "unreachable"
  uses a port the kernel has just released (`__tests__/helpers/closed-port.ts`), never 1, 9 or
  9999 (`__tests__/closed-port-guard.test.ts`).
- **OpenSSL.** macOS's `openssl` is LibreSSL with its own `openssl.cnf`: the Valkey tests' CA and
  server certificate carry every extension themselves (`CA:TRUE`, `keyCertSign`; `CA:FALSE`,
  `serverAuth`, `DNS:localhost`).
- **Valkey.** Without `valkey-server` or `redis-server` the Valkey suites skip; `npm run test:db`
  says so plainly, and requires them when one is installed (CI requires them always).

_Sources: PostgreSQL documentation, "Runtime Config: max_stack_depth", "Explicit Locking"; Jest,
`--maxWorkers`; Apple, `openssl(1)` (LibreSSL)._
