# The job claim's tenant probe could walk every row a tenant had

| Field        | Detail                                                               |
| ------------ | -------------------------------------------------------------------- |
| Case         | `jobs-the-claim-read-every-row`                                      |
| Source       | TASK-156 finding 5 (423 ms at 300 000 rows), then CI run 40098437851 |
| Area (tier)  | jobs (High) — performance                                            |
| Review input | `git show 0e7d25a -- supabase/migrations/050_jobs.sql`               |
| Fixed in     | `57eae32`                                                            |

## What the diff did

`job_claim` found the tenants with queued work by skipping through `jobs_queued_idx`, one probe per tenant, ordering by `tenant_id` only.

## The defect

An order by `tenant_id` alone can be served by `jobs_tenant_created_idx`, which holds a tenant's parked and finished rows too: the claim read all 300 000 rows of one tenant. The bound the design relied on held only when the planner chose the intended index.

## Where

`supabase/migrations/050_jobs.sql:356` and `:360` (`order by j.tenant_id limit 1`), as of `0e7d25a`.

## How it was caught

CI: the database suite timed out in run 40098437851. The test now counts rows read from the executed plans (`auto_explain`), not time.

## The finding a reviewer should have produced

**Important** — `supabase/migrations/050_jobs.sql:356` — the probe orders by `tenant_id` only, so any index leading with `tenant_id` serves it — `jobs_tenant_created_idx` includes parked and finished rows, and the probe walks them. Order by the whole key of `jobs_queued_idx` (`tenant_id, kind, run_at, id`) so only that index fits, and bound the test by rows read, not milliseconds.

## Scoring

- **Caught (2):** Says the order by does not pin the intended index and the probe can scan non-queued rows.
- **Partial (1):** Says the claim may be slow at scale, without the index.
- **Missed (0):** neither; findings elsewhere in the input are counted as noise (README).
