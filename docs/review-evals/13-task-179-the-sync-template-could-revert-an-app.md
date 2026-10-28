# The sync template synced the configured ref whatever the app already had

| Field        | Detail                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------- |
| Case         | `task-179-the-sync-template-could-revert-an-app`                                              |
| Source       | TASK-179 (found in Playform)                                                                  |
| Area (tier)  | workflows (High)                                                                              |
| Review input | `docs/templates/sync-from-foundation.yml` as of `3994dcf` (the template dates from `908d64a`) |
| Fixed in     | `c4771be`                                                                                     |

## What the diff did

The consumer sync workflow rsyncs the platform's configured ref (normally `main`) onto the app's `develop` and opens a pull request.

## The defect

An app that adopts the platform from `develop` ahead of its release got a scheduled PR syncing an older platform over a newer one — merged, it reverts that work. Its branch also carried a test fixture into the app's history scan.

## Where

`docs/templates/sync-from-foundation.yml:93` (the rsync, with no comparison of versions before it), as of `3994dcf`.

## How it was caught

Playform's scheduled sync opened such a PR (Playform's case `sync-pr-reverts-the-platform`).

## The finding a reviewer should have produced

**Important** — `docs/templates/sync-from-foundation.yml:93` — nothing compares the source's `PLATFORM_VERSION` with the app's before the rsync: a scheduled run from `main` overwrites a newer platform taken from `develop`. Proceed only for a strictly newer version, fail closed on a missing or malformed one.

## Scoring

- **Caught (2):** Says the sync can apply an older platform over a newer one.
- **Partial (1):** Says the sync should be guarded, without the version comparison.
- **Missed (0):** neither; findings elsewhere in the input are counted as noise (README).
