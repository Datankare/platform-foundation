# The reviewer's eval set

One case per real miss in this repository's history (TASK-183, [AI_ENGINEERING](../AI_ENGINEERING.md)
§6): what the diff did, the defect, where it was, how it was caught, and the finding a reviewer
should have produced. A change to the reviewer — CLAUDE.md, REVIEW.md, the review protocol, or the
model or tools — is scored against every case before it is kept. Each new incident, revert or
late finding adds a case.

Commit references are public develop commits. As of: a public develop commit at which the defect stands (the file:line is given there).
Of the 17 cases, 14 reproduce from public history. Cases 02, 04 and 08 do not: their pre-fix code
was never public, so their review input is a patch in [`inputs/`](inputs/), reconstructed from
pre-release history, and their lines are the patch's.

A consuming app keeps its own cases in a folder of its own (Playform: `playform/`), sync-excluded.

## Cases

| Case                                                                                                                           | Miss                                                                                      | Area (tier)                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [01-r17-m1-sign-out-trusts-the-refresh-cookie.md](01-r17-m1-sign-out-trusts-the-refresh-cookie.md)                             | Sign-out revoked whoever the unsigned refresh cookie named                                | auth (High)                                                                  |
| [02-r17-m2-a-kit-case-that-cannot-fail.md](02-r17-m2-a-kit-case-that-cannot-fail.md)                                           | A conformance-kit assertion that passed whatever the provider did (input reconstructed)   | Medium (a test file); the failure is "it lies"                               |
| [03-task-177-subject-named-by-username.md](03-task-177-subject-named-by-username.md)                                           | The platform's Cognito provider named an identity by its username, not its sub            | auth (High)                                                                  |
| [04-task-174-r15-h1-re-link-target-by-address.md](04-task-174-r15-h1-re-link-target-by-address.md)                             | The identity re-link chose its target account by address alone (input reconstructed)      | auth (High)                                                                  |
| [05-task-175-a-losing-resume-answered-success.md](05-task-175-a-losing-resume-answered-success.md)                             | Concurrent re-approvals of a workflow step answered the loser with success                | auth (High) — held actions (`platform/agents`)                               |
| [06-task-176-email-verified-never-updated.md](06-task-176-email-verified-never-updated.md)                                     | `users.email_verified` was never updated after the person confirmed their address         | auth (High)                                                                  |
| [07-task-168-provisioning-race-on-the-subject-key.md](07-task-168-provisioning-race-on-the-subject-key.md)                     | First-request provisioning arbitrated only the id, not the subject key                    | auth (High)                                                                  |
| [08-task-164-an-approval-capability-skipped-the-key-hold.md](08-task-164-an-approval-capability-skipped-the-key-hold.md)       | A fix's new capability let an approved action skip a key's own hold (input reconstructed) | auth (High) — dual control (`platform/action-pipeline`)                      |
| [09-task-173-a-lost-run-answered-500.md](09-task-173-a-lost-run-answered-500.md)                                               | A workflow whose run was lost answered its continuation with a 500                        | auth (High) — the held-action recovery job (`platform/admin`)                |
| [10-jobs-the-claim-read-every-row.md](10-jobs-the-claim-read-every-row.md)                                                     | The job claim's tenant probe could walk every row a tenant had                            | jobs (High) — performance                                                    |
| [11-jobs-migration-ddl-in-a-parallel-suite-deadlocked.md](11-jobs-migration-ddl-in-a-parallel-suite-deadlocked.md)             | A database test re-applied a migration's DDL beside the other suites and deadlocked       | Medium (a test file); the jobs and migrations failure modes                  |
| [12-jobs-the-schedules-console-ran-three-subqueries-per-row.md](12-jobs-the-schedules-console-ran-three-subqueries-per-row.md) | The jobs console counted each schedule's jobs with three subqueries per row               | jobs (High) — performance                                                    |
| [13-task-179-the-sync-template-could-revert-an-app.md](13-task-179-the-sync-template-could-revert-an-app.md)                   | The sync template synced the configured ref whatever the app already had                  | workflows (High)                                                             |
| [14-task-180-authenticator-setup-showed-no-qr-code.md](14-task-180-authenticator-setup-showed-no-qr-code.md)                   | Authenticator setup showed only the key, on screen by default                             | UI — dead-ends or hides the reason (Medium)                                  |
| [15-pool-software-token-mfa-was-off.md](15-pool-software-token-mfa-was-off.md)                                                 | The identity pool had software-token MFA off; nothing said it was needed                  | Low (docs); a configuration miss outside the repository — config "misroutes" |
| [16-task-181-password-reset-reported-success-on-refusal.md](16-task-181-password-reset-reported-success-on-refusal.md)         | Password reset showed "Password Reset" when the server refused it                         | UI — dead-ends or hides the reason (Medium)                                  |
| [17-task-181-screens-hid-the-refusal.md](17-task-181-screens-hid-the-refusal.md)                                               | Screens hid or misreported the API's refusals                                             | UI (Medium); the sign-up route is auth (High)                                |

## How to run a case

Give the reviewer under test the case's **review input** (a diff, or files as of a commit), the
repository's CLAUDE.md and REVIEW.md, and read access to the tree at that commit — never the case
file itself. Collect its findings as it would post them, after its own verifier step.

## Scoring rubric

| Score       | When                                                                                                                               |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 2 — caught  | A finding names the case's file (and a line within the stated location), describes the defect's mechanism, and is tagged Important |
| 1 — partial | The case's "Partial" line holds, or the right defect is tagged Nit or Pre-existing                                                 |
| 0 — missed  | Neither                                                                                                                            |

- **Score** = the sum over the cases; the maximum is twice the number of cases.
- **Noise** = findings on a case's input that are not the case's defect and that a second
  verifier judges not real. Reported beside the score, never netted against it.
- **Keep rule:** a change to the reviewer is kept when the score does not fall and the noise does
  not rise; otherwise it is reverted. Catching real defects comes first; fewer rounds second.
- **Planned, not yet done:** runs on known-clean changes, to count false alarms on their own.

## Runs

| Date | Reviewer (model, protocol, CLAUDE.md/REVIEW.md commit) | Score | Noise | Kept |
| ---- | ------------------------------------------------------ | ----- | ----- | ---- |

No run is recorded yet; the first scored run is planned (TASK-183).
