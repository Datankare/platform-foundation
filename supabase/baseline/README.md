# Schema baseline (TASK-091)

`000_baseline.sql` builds a **new** database with everything migrations `001`–`037` produce. A new
instance (a production database, another consumer app, CI) runs:

1. `000_baseline.sql` — once, on an empty Supabase project, as `postgres` (SQL Editor or `psql`);
2. then only the migrations numbered **after** its `baseline-covers-through` line, in order.

An existing database built from the numbered chain (the `playform` dev project) does not run the
baseline. It already has the schema.

## Why a baseline and not the chain

The numbered chain cannot build a database from zero. Several early migrations were edited after
they were applied, and some were never applied as written: `001` creates `player_role` without
`registered`, `002` seeds `registered`, `004` drops the enum, `008` renames the enum `004` dropped
and rebuilds functions against tables and columns that never existed. The live database was built
as the files changed, so it is correct; the files no longer compose. Rewriting applied migrations is
rejected — it changes what a live database claims to have run.

## How it was made (2026-09-29)

| Step                                                                     | Result                                                       |
| ------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Schema-only export of `public` from the `playform` dev project (PG 17.6) | 429 objects                                                  |
| Seed export of the governance tables                                     | 166 rows                                                     |
| Ownership audit against PF migrations and code                           | Exclusions below                                             |
| Replay on a fresh Postgres shaped like Supabase                          | Applies; refuses a second run                                |
| Object-by-object comparison with dev                                     | Differs only by the exclusions — nothing lost, nothing added |
| Tables and functions PF calls                                            | All present; every table has row-level security              |

**Excluded from dev (not PF's):**

| Object                                             | Owner                                             |
| -------------------------------------------------- | ------------------------------------------------- |
| `agent_delegation_grant`, `agent_delegation_audit` | Playform (`034_agent_delegation.sql` in Playform) |
| `rls_auto_enable()`                                | Supabase — the project's automatic-RLS option     |
| schema `public`, default privileges                | Supabase — every project has them                 |
| role `tester` and its one permission               | Hand-made on dev, used by no code                 |

**Included although no numbered migration creates it:** `user_devices` (`001` created
`player_devices`; the rename was applied by hand) and the `vector` extension (`017` needs it; it was
enabled by hand).

## Rules for newer migrations

- **Every table enables row-level security in the migration that creates it.** Dev has
  Supabase's automatic-RLS trigger; production does not. `__tests__/schema-baseline.test.ts`
  enforces this for every migration after the baseline, and the replay job checks every table.
- **Every migration records itself** in `applied_migrations` (TASK-065), as before.

## Checks

| Where                                                       | What                                                                                                                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CI job **Migration replay** (`scripts/migration-replay.sh`) | Shim, baseline, newer migrations on Postgres 17 + pgvector; fails on any SQL error, a missing table or function, or a table without row-level security |
| `__tests__/schema-baseline.test.ts`                         | The refusal guard, the migration record, no consumer-owned or Supabase-generated objects                                                               |

Run the replay locally against an empty database: `PGDATABASE=replay scripts/migration-replay.sh`.
`supabase-shim.sql` makes plain Postgres look like a fresh Supabase project — never apply it to
Supabase.

## Regenerating

Only when a new baseline is deliberately cut (for example, to fold in a long run of migrations):
export the schema and governance seed from a database known to be current, repeat the ownership
audit, raise `baseline-covers-through`, and prove it with the replay and the comparison above.

_Last updated: September 29, 2026 (Phase 5 Sprint 7A C4 — baseline cut from the dev schema)_
