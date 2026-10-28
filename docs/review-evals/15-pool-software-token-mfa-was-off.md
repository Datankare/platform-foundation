# The identity pool had software-token MFA off; nothing said it was needed

| Field        | Detail                                                                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Case         | `pool-software-token-mfa-was-off`                                                                                                                  |
| Source       | TASK-180 (configuration miss)                                                                                                                      |
| Area (tier)  | Low (docs); a configuration miss outside the repository — config "misroutes"                                                                       |
| Review input | `docs/ENV_REFERENCE.md` "Cognito pool shape" and `platform/auth/pool-shape-probe.ts`, as of `c4771be`                                              |
| Fixed in     | `43d14c0` (documented: ENV_REFERENCE "Cognito pool shape", SETUP §4d); checked by Playform's `scripts/check-cognito-pool.mjs` (live journey check) |

## What the diff did

The staff second factor (the October 2026 audit's item A-9) depends on the pool allowing software-token MFA.

## The defect

The dev pool had it off, so setup failed; the documented pool shape did not list it, and the platform's readiness probe does not check it.

## Where

`docs/ENV_REFERENCE.md` ("Cognito pool shape", without MFA) and `platform/auth/pool-shape-probe.ts` (reads `UsernameAttributes` and the client's readable attributes, not MFA), as of `c4771be`.

## How it was caught

The owner signing in to playform-dev.

## The finding a reviewer should have produced

**Important** — `docs/ENV_REFERENCE.md` (Cognito pool shape) — the staff second factor needs software-token MFA enabled (`OPTIONAL`), but neither the pool shape nor the readiness probe says so; a pool without it fails at enrolment, in front of a user. Document it with the command to set and check it, and check it where the pool is checked.

## Scoring

- **Caught (2):** Names the undocumented, unchecked MFA setting the feature depends on.
- **Partial (1):** Says pool settings should be checked, in general.
- **Missed (0):** neither; findings elsewhere in the input are counted as noise (README).
