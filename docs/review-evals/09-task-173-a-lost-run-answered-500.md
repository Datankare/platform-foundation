# A workflow whose run was lost answered its continuation with a 500

| Field        | Detail                                                                 |
| ------------ | ---------------------------------------------------------------------- |
| Case         | `task-173-a-lost-run-answered-500`                                     |
| Source       | TASK-173 (found adopting the v6.0.0 candidate (`908d64a`) in Playform) |
| Area (tier)  | auth (High) — the held-action recovery job (`platform/admin`)          |
| Review input | `platform/admin/hold-expiry.ts` `recoverStaleRuns`, as of `908d64a`    |
| Fixed in     | `9e577bf`                                                              |

## What the diff did

The recovery job moved a lost run's approval to `indeterminate` (or back to `approved` for an atomic run).

## The defect

It left the run's trajectory `running`. The agent's continuation re-proposed the step; the proposal store's one-live rule refused it with a plain error — a 500 from Playform's `process-content`, not `held` with `awaiting: "outcome"`.

## Where

`platform/admin/hold-expiry.ts:150` (`recoverStaleRuns`; the update at `:187` moves the approval only), as of `908d64a`.

## How it was caught

Playform's adoption.

## The finding a reviewer should have produced

**Important** — `platform/admin/hold-expiry.ts:187` — the recovery moves the approval but not its trajectory, which stays `running`; the next continuation re-proposes the step and the one-live rule throws. Move the trajectory to the matching waiting state in the same statement, and make continuations read the step's proposal whatever the status.

## Scoring

- **Caught (2):** Names the trajectory left `running` after recovery.
- **Partial (1):** Says recovery and continuation can disagree, without the state.
- **Missed (0):** neither; findings elsewhere in the input are counted as noise (README).
