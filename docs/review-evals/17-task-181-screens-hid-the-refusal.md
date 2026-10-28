# Screens hid or misreported the API's refusals

| Field        | Detail                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------ |
| Case         | `task-181-screens-hid-the-refusal`                                                                     |
| Source       | TASK-181 items 2–4                                                                                     |
| Area (tier)  | UI (Medium); the sign-up route is auth (High)                                                          |
| Review input | `components/auth/AuthPage.tsx`, `app/admin/page.tsx`, `app/api/auth/sign-up/route.ts`, as of `43d14c0` |
| Fixed in     | `8944cfe`; the standing check `__tests__/refusal-coverage.test.ts`                                     |

## What the diff did

Sign-in, the admin console and sign-up, each handling the server's refusals its own way.

## The defect

An unconfirmed account's sign-in showed "Sign-in failed" (`success` checked before `emailVerificationRequired`); the admin console showed one "refused" for `auth.permission_denied`, `account.restricted` and a 503 alike; an under-13 date of birth created an account that waited for a parental consent nobody could give yet.

## Where

`components/auth/AuthPage.tsx:90–95`; `app/admin/page.tsx:166` (every non-MFA code to `"refused"`); `app/api/auth/sign-up/route.ts:74` (the account created, its age recorded, consent not available), as of `43d14c0`.

## How it was caught

The user-facing gap audit (batch 2).

## The finding a reviewer should have produced

**Important** — `components/auth/AuthPage.tsx:90` — `!result.success` returns before `emailVerificationRequired` (`:95`) is read, so an unconfirmed account is told "Sign-in failed" and never offered verification. Same class: `app/admin/page.tsx:166` collapses every refusal code into one text. Handle each code the route can return, from one shared handler.

## Scoring

- **Caught (2):** Names a refusal the screen hides or misreports, with the code.
- **Partial (1):** Says error messages are generic.
- **Missed (0):** neither; findings elsewhere in the input are counted as noise (README).
