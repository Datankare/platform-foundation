# Migrating from v5.x to v6.x

**In progress — Sprint 7R.** v6.0.0 ships at the Sprint 7R close (tenancy groundwork, the
core/module boundary, background jobs, a container). This guide grows with each milestone on
`develop`; what is listed here is already there.

---

## 1. Before you deploy — every deploying consumer

| Do                                                                                                                     | Why                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apply migrations **047–048** to every database (SQL Editor, in order)                                                  | 047 records `007_seed_separation.sql` as "absent" where its `registered` role does not exist — no role or permission changes (TASK-148); 048 creates `ai_metrics` for the Supabase metrics sink, server-only (TASK-113)                                                                                        |
| Set `CACHE_PROVIDER` in every deployed environment: `upstash` (with `UPSTASH_REDIS_REST_URL` and `_TOKEN`) or `memory` | Production refuses to start without it (TASK-139). The cache is chosen, never inferred: a Redis URL alone no longer selects Redis, and `upstash` without its credentials refuses to start instead of becoming a per-instance cache. `memory` is accepted when declared — the cache holds nothing authoritative |
| If you keep migrations of your own that a platform migration's effect never reached, record them truthfully            | The migration-parity check compares files with `applied_migrations` and lists "absent" records separately; a record must say what is true of the database (learning 120)                                                                                                                                       |

Full reference: [ENV_REFERENCE.md](ENV_REFERENCE.md).

## 2. Behaviour changes

| Change                                                                                                                                                                                             | Who is affected                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent budget periods are UTC dates (TASK-144)                                                                                                                                                      | Deployments on a host whose time zone is not UTC: the daily cap resets at 00:00 UTC; the first day after deploying may reset early                                    |
| `calculateAge` / `evaluateAge` live in `platform/auth/age.ts` (still exported from `coppa.ts`), take an optional `now`, never overstate age and throw `RangeError` on an impossible or future date | Code that passed timestamps or unchecked strings: pass a `YYYY-MM-DD` calendar date and handle the error; `recordAgeVerification` returns `{ success: false }` for it |
| `scripts/schema-parity.mjs` fails on a REST store whose columns it cannot read                                                                                                                     | Your own Supabase-backed stores: write rows as object literals (or `batch.map((e) => ({ … }))`) and name the table with `const TABLE = "<name>"`                      |
