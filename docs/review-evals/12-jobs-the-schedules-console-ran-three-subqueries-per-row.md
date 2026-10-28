# The jobs console counted each schedule's jobs with three subqueries per row

| Field        | Detail                                                                  |
| ------------ | ----------------------------------------------------------------------- |
| Case         | `jobs-the-schedules-console-ran-three-subqueries-per-row`               |
| Source       | CI run 40146887706                                                      |
| Area (tier)  | jobs (High) — performance                                               |
| Review input | `git show 0e7d25a -- platform/jobs/postgres-store.ts` (`listSchedules`) |
| Fixed in     | `3d8c23d`                                                               |

## What the diff did

`listSchedules` returned each schedule with its queued, running and dead counts.

## The defect

Each count was a correlated subquery per schedule. With statistics gathered while one kind held most of the table, the planner chose a sequential scan for each, and the console ran past the statement timeout.

## Where

`platform/jobs/postgres-store.ts:352–354`, as of `0e7d25a`.

## How it was caught

CI (the database suite).

## The finding a reviewer should have produced

**Important** — `platform/jobs/postgres-store.ts:352` — three `count(*)` subqueries per schedule: work grows with schedules × table size, and the plan depends on statistics. Count once, grouped by kind over the open and dead jobs of the scheduled kinds, and join.

## Scoring

- **Caught (2):** Names the per-row subqueries as an unbounded fan-out.
- **Partial (1):** Says the query may be slow without the shape.
- **Missed (0):** neither; findings elsewhere in the input are counted as noise (README).
