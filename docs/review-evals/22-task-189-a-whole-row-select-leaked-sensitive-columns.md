# The command bar's search selected whole rows: every column of every account, shown and recorded

| Field        | Detail                                                                                                                                         |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Case         | `task-189-a-whole-row-select-leaked-sensitive-columns`                                                                                         |
| Source       | TASK-189 (a live check of the admin command bar on playform-dev, 2026-10-28)                                                                   |
| Area (tier)  | Tenancy and personal data — billing and consent (High): a child's date of birth and a parent's address were exposed                            |
| Review input | `app/api/admin/ai/handlers/search.ts`, `app/api/admin/ai/tool-schemas/index.ts`, `components/admin/ExecutionResultsPanel.tsx`, as of `621e9fc` |
| Fixed in     | TASK-189; `__tests__/task-189-search.test.ts`, `__tests__/db/task-189-search.db.test.ts`, `__tests__/task-189-search-panel.test.tsx`           |

## What the diff did

The command bar's `search` action read one of seven allowlisted tables under its page's
permission (TASK-145), in the tenant's transaction (ADR-053), and returned the newest 20 rows.

## The defect

Two, in the same statement. **Over-exposure:** each table was read with `select to_jsonb(t) … from
<table> t` — every column. A search of `users` returned each account's date of birth, the
identity provider's subject, the real name, the ban reason, who changed the standing and the
parental consent address — none of which the Users screen shows under the same permission — as
one JSON text on screen, and recorded it in the action's step (agent_trajectories), a second copy
outside the account's own retention and erasure. `audit_log` returned the IP address and user agent
the Audit log page does not show. Any column a later migration adds would have been exposed the
same way, unreviewed. **The input was not read:** the schema required `query`, the handler never
used it, so "users who signed in this week" listed every user — an answer that looks filtered and
is not.

## Where

`app/api/admin/ai/handlers/search.ts:24`–`:35` (`SEARCH_SQL`: `to_jsonb(t)` for every table),
`:58` (the rows passed through whole) and `:63` (shown and returned as the recorded result);
`app/api/admin/ai/tool-schemas/index.ts:31` (`query`, required and never read), as of `621e9fc`.

## How it was caught

A live check of the deployed command bar: the result of "show users who signed in this week" was
every user, with every column. No reviewer had raised it in the reviews since `91d65e4`.

## The finding a reviewer should have produced

**Important** — `app/api/admin/ai/handlers/search.ts:24` — `to_jsonb(t)` returns every column of
`users` (date_of_birth, cognito_sub, real_name, ban_reason, parental_consent_email…), shown in the
command bar and persisted in the step, where the Users screen under the same permission shows ten
columns. Name the columns each table shows, mirroring its page; never select a whole row into a
result a person sees or a record keeps. Also **Important** — `:63` with
`tool-schemas/index.ts:31` — the required `query` is never read, so every search answers the
newest 20 rows as if they matched. Same class: any `select *`, `to_jsonb(<row>)` or
`row_to_json` whose result leaves the server or is recorded.

## Scoring

- **Caught (2):** Names that the search selects whole rows (`to_jsonb(t)`), so columns the admin
  pages do not show — personal data among them — are shown and recorded.
- **Partial (1):** Names only that `query` is ignored, or names the whole-row select as a Nit or a
  performance concern without the exposure.
