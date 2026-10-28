# Sign-out revoked whoever the unsigned refresh cookie named

| Field        | Detail                                                                                                                                                                                          |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Case         | `r17-m1-sign-out-trusts-the-refresh-cookie`                                                                                                                                                     |
| Source       | TASK-178, review 17 finding M1                                                                                                                                                                  |
| Area (tier)  | auth (High)                                                                                                                                                                                     |
| Review input | `app/api/auth/sign-out/route.ts` as of `908d64a` (the cookie-derived subject was added there, by the October 2026 audit's second batch of fixes — "Wave 2" — for item X-17, session revocation) |
| Fixed in     | `3994dcf`                                                                                                                                                                                       |

## What the diff did

Sign-out revoked the session's remembered token verifications and recorded a `logout` audit record. It took the subject to revoke, and the actor to record, from the refresh cookie `<user id>.<refresh token>`.

## The defect

The cookie's user id was not bound to anything: an attacker's own refresh token behind a victim's id voided the victim's remembered verifications and recorded the victim's `logout`; a bearer A with a cookie naming B voided B only.

## Where

`app/api/auth/sign-out/route.ts:50` (`refresh?.userId ?? …` as the subject) and `:55` (`auditableUserId(refresh?.userId)`, the same id as the audit actor), as of `908d64a`.

## How it was caught

Review 17 — an independent hostile review of TASK-177 — with a proof, kept as `__tests__/r17-hostile-signout.test.ts`.

## The finding a reviewer should have produced

**Important** — `app/api/auth/sign-out/route.ts:51` — the subject revoked is the cookie's unsigned user id, not a subject the provider proved. A caller can put any user id before their own refresh token and void that user's verifications; `:56` records that user's `logout`. Revoke and record only a proven subject (the verified bearer, or the subject a refresh of the cookie's token returns), and authenticate the cookie (a MAC). Same class: any other route that reads an identity from `readRefreshCookie`.

## Scoring

- **Caught (2):** Names the sign-out route and the cookie's user id as untrusted input deciding whose session is revoked.
- **Partial (1):** Names the route but only the missing MAC, or only the audit actor.
- **Missed (0):** neither; findings elsewhere in the input are counted as noise (README).
