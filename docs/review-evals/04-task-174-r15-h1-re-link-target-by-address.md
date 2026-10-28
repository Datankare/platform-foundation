# The identity re-link chose its target account by address alone

| Field        | Detail                                                                                                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Case         | `task-174-r15-h1-re-link-target-by-address`                                                                                                                             |
| Source       | TASK-174, review 15 finding H1                                                                                                                                          |
| Area (tier)  | auth (High)                                                                                                                                                             |
| Review input | [`inputs/04-task-174-r15-h1-re-link-target-by-address.patch`](inputs/04-task-174-r15-h1-re-link-target-by-address.patch) — input reconstructed from pre-release history |
| Fixed in     | `3994dcf`                                                                                                                                                               |

## What the diff did

Added the operator command that re-links accounts to their identity in a new Cognito pool, matching the account by `users.email`.

## The defect

A later run moved an already-linked account to whoever now holds its old address in the pool (an address changed there, a mailbox reused) — a staff account handed to someone else.

## Where

`platform/auth/identity-relink.ts:279` and `:286` (`where lower(btrim(u.email)) = $1`), in the reconstructed input (a new file, so the lines are the patch's); the pre-fix file was never public.

## How it was caught

Review 15, a hostile review of the re-link, with proofs kept in `__tests__/db/identity-relink-hostile.db.test.ts`.

## The finding a reviewer should have produced

**Important** — `platform/auth/identity-relink.ts:279` — the target is any live account with the address; nothing checks the account is not already bound in the current pool. A second run after an address changes hands re-links that account to the new holder. Require the target to be unbound in the current pool, and refuse accounts made after the move.

## Scoring

- **Caught (2):** Says a re-run can move an already-linked account to a new holder of its address.
- **Partial (1):** Says matching by address is weak, without the re-run scenario.
- **Missed (0):** neither; findings elsewhere in the input are counted as noise (README).
