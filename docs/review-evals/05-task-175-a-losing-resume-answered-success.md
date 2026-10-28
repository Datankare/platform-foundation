# Concurrent re-approvals of a workflow step answered the loser with success

| Field        | Detail                                                                                          |
| ------------ | ----------------------------------------------------------------------------------------------- |
| Case         | `task-175-a-losing-resume-answered-success`                                                     |
| Source       | TASK-175                                                                                        |
| Area (tier)  | auth (High) — held actions (`platform/agents`)                                                  |
| Review input | `platform/agents/workflow-loop.ts` `resumeApprovedAction`, as of `9e577bf` (added in `d203e6b`) |
| Fixed in     | `3994dcf`; review 16's follow-up in `3994dcf`                                                   |

## What the diff did

`resumeApprovedAction` checked the proposal was `approved` and its step next, then handed off to the loop, which read the trajectory again.

## The defect

A call that passed the checks before another call's run, and read the trajectory after it, found the step committed and answered `completed` — success for work it did not do; with a step after it, it ran that step. Status moves had the same read-then-write shape.

## Where

`platform/agents/workflow-loop.ts:1052–1069` (check, then `advance(...)` on a fresh read), as of `9e577bf`.

## How it was caught

A flaky test: `held-action-retry.db` "concurrent re-approvals resume it once" failed intermittently, once under `test:coverage`.

## The finding a reviewer should have produced

**Important** — `platform/agents/workflow-loop.ts:1058` — the approval and step are checked, then the loop re-reads the trajectory; a concurrent resume can run in between, and this call then reports `completed` for a step it did not run. Bind the resume to the approval and step it checked and let the claim's compare-and-set decide; make every status move a compare-and-set (`updateStatus({ from })`). Same class: withdraw, end, resolve and the continuation's waiting move.

## Scoring

- **Caught (2):** Names the check-then-act race and the false success.
- **Partial (1):** Names a race without the false-success outcome.
- **Missed (0):** neither; findings elsewhere in the input are counted as noise (README).
