# The platform's Cognito provider named an identity by its username, not its sub

| Field        | Detail                                              |
| ------------ | --------------------------------------------------- |
| Case         | `task-177-subject-named-by-username`                |
| Source       | TASK-177 (found in the review 16 fixes)             |
| Area (tier)  | auth (High)                                         |
| Review input | `platform/auth/cognito-provider.ts` as of `908d64a` |
| Fixed in     | `3994dcf`                                           |

## What the diff did

The provider took a verified token's subject from the `username` claim (GetUser's `Username`), while sign-in, SSO and MFA sessions used the `sub`.

## The defect

A federated user's username is `Google_…`, not a UUID: provisioning (UUID subjects only) refused every brand-new Google user, a sign-out revoked the `sub` while verifications were stamped by username (not voided), and the re-link needed an operator flag that could be set wrong.

## Where

`platform/auth/cognito-provider.ts:510–511` (`decoded.username` as the subject) and `:562` (`sub: result.Username`), as of `908d64a`.

## How it was caught

While fixing review 16's federated-subject finding on the re-link (TASK-174).

## The finding a reviewer should have produced

**Important** — `platform/auth/cognito-provider.ts:529` — the token's subject is its `username` claim, but sessions, sign-out and provisioning use the `sub`; for a federated user they differ (`Google_…`), so its verifications are stamped under one name and revoked under another, and provisioning (UUID only) refuses it. Name the identity by the signed `sub` everywhere, and refuse a GetUser answer whose `sub` differs.

## Scoring

- **Caught (2):** Identifies the username/sub mismatch for federated users and one concrete consequence.
- **Partial (1):** Notes the inconsistency without a consequence.
- **Missed (0):** neither; findings elsewhere in the input are counted as noise (README).
