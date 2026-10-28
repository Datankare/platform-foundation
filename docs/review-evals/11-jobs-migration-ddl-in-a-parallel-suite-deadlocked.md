# A database test re-applied a migration's DDL beside the other suites and deadlocked

| Field        | Detail                                                                                                                             |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Case         | `jobs-migration-ddl-in-a-parallel-suite-deadlocked`                                                                                |
| Source       | CI run 40098437851 (Sprint 7R jobs, TASK-156 finding 9's test)                                                                     |
| Area (tier)  | Medium (a test file); the jobs and migrations failure modes                                                                        |
| Review input | `__tests__/db/jobs.db.test.ts` as of `0e7d25a` ("finding 9: re-applying 050 keeps a dual-control key an operator removed removed") |
| Fixed in     | `57eae32` (the proof moved to the migration replay, `scripts/migration-replay.sh`)                                                 |

## What the diff did

A test proved finding 9 by reading `050_jobs.sql` and running it again inside an owner transaction.

## The defect

The database suites run in parallel on one database. Re-running a migration's DDL takes table locks; with other suites claiming jobs and writing the same tables, the locks deadlocked.

## Where

`__tests__/db/jobs.db.test.ts:706` (finding 9's case), `:721` (`readFileSync(…050_jobs.sql)`) and `:726` (`withOwnerTx(… tx.query(migration))`, the migration's DDL re-applied), as of `0e7d25a`.

## How it was caught

CI.

## The finding a reviewer should have produced

**Important** — `__tests__/db/jobs.db.test.ts` (finding 9) — running `050_jobs.sql` in a test takes table locks while the other database suites use the same tables in parallel: it can deadlock, and it changes the schema under them. Prove re-application in the migration replay, which runs alone.

## Scoring

- **Caught (2):** Names DDL in a parallel suite as a lock or deadlock risk.
- **Partial (1):** Says the test is slow or heavy.
- **Missed (0):** neither; findings elsewhere in the input are counted as noise (README).
