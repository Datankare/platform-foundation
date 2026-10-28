# `users.email_verified` was never updated after the person confirmed their address

| Field        | Detail                                                                                                                                              |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Case         | `task-176-email-verified-never-updated`                                                                                                             |
| Source       | TASK-176 (found in the review 15 fixes)                                                                                                             |
| Area (tier)  | auth (High)                                                                                                                                         |
| Review input | `platform/auth/user-provisioning.ts` and `app/api/auth/sign-up/route.ts` as of `9e577bf` (provisioning on first use dates from TASK-117, `c2894fb`) |
| Fixed in     | `3994dcf`                                                                                                                                           |

## What the diff did

Sign-up provisions the account's row before the person confirms the address, so it is stored `email_verified = false`.

## The defect

Nothing set it to true after the person confirmed and signed in: most real accounts read "unverified", the re-link needed an override for nearly every staff account, and `makeTenantAdmin` refused a confirmed first administrator.

## Where

An absence: the flag's only writer is the provisioning insert, `platform/auth/user-provisioning.ts:364`, as of `9e577bf`; no path updates it.

## How it was caught

Fixing review 15 of the re-link, which began trusting only verified accounts.

## The finding a reviewer should have produced

**Important** — `platform/auth/user-provisioning.ts:436` — `email_verified` is written once, `false`, before confirmation, and no path updates it; every confirmed account stays unverified, and the re-link's new verified-only rule refuses them. Sync it from the token's verified claim for the same address, once, never downgrading.

## Scoring

- **Caught (2):** Says the flag is written before confirmation and never updated.
- **Partial (1):** Flags the re-link rule as too strict without the stale flag.
- **Missed (0):** neither; findings elsewhere in the input are counted as noise (README).
