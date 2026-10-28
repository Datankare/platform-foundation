# First-request provisioning arbitrated only the id, not the subject key

| Field        | Detail                                                   |
| ------------ | -------------------------------------------------------- |
| Case         | `task-168-provisioning-race-on-the-subject-key`          |
| Source       | TASK-168 (found adopting v6.0.0 in Playform)             |
| Area (tier)  | auth (High)                                              |
| Review input | `git show 91d65e4 -- platform/auth/user-provisioning.ts` |
| Fixed in     | `908d64a`                                                |

## What the diff did

Account provisioning on first use inserted with `on conflict (id) do nothing`.

## The defect

The row has a second unique key, `cognito_sub`. Of two or three concurrent first requests, one could pass the id check before the winner's row reached the index and then fail on the subject key: refused `account.not_provisioned` (about 2 in 900 attempts).

## Where

`platform/auth/user-provisioning.ts:108` (`on conflict (id) do nothing`), as of `91d65e4`.

## How it was caught

Playform's adoption, as an intermittent `account.not_provisioned`; proved by `__tests__/db/provisioning-race.db.test.ts`.

## The finding a reviewer should have produced

**Important** — `platform/auth/user-provisioning.ts:350` — `on conflict (id)` arbitrates one of the row's two unique keys; a concurrent first request can raise a unique violation on `cognito_sub`. Use `on conflict do nothing` (every key arbitrates) and read back which row holds the identity.

## Scoring

- **Caught (2):** Names the second unique key and the concurrent-insert failure.
- **Partial (1):** Says the insert is not race-safe without the key.
- **Missed (0):** neither; findings elsewhere in the input are counted as noise (README).
