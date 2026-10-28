# An account's address was never recorded after it was provisioned without one

| Field        | Detail                                                                                                                                    |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Case         | `task-185-an-address-never-recorded`                                                                                                      |
| Source       | TASK-185                                                                                                                                  |
| Area (tier)  | Auth — the account's identity as the platform records it (High)                                                                           |
| Review input | `platform/auth/email-verification.ts`, `platform/auth/user-provisioning.ts`, `platform/auth/account-status-guard.ts`, as of `308b5b1`     |
| Fixed in     | TASK-185 (on develop after `308b5b1`); `__tests__/db/email-verification.db.test.ts`, `platform/auth/__tests__/email-verification.test.ts` |

## What the diff did

TASK-176 kept `users.email_verified` in step with the identity provider: on each signed-in
request through `requireActor`, the provider's answer for the token is compared with the stored
address, and a verified claim of the same address marks the row verified, once.

## The defect

The address itself is written only once — when provisioning creates the row, from the profile
its caller passed — and never afterwards. A row created without one (a first request whose caller
passed no profile, such as `isInGoodStanding`, or a token whose address was empty at the time)
keeps `email` NULL for good: the sync returns `no_address` when the row has none, and states that
`users.email` is never rewritten "not when the row has none". On playform-dev, accounts created by
a first sign-in on a new pool and by Google sign-in all listed "—" in the admin console, with no
way to fill them short of a hand edit. A row without its address also escapes the ban carry-over
(A-11), which matches by address.

## Where

`platform/auth/email-verification.ts:113–114` (`stored.email === null` → `no_address`, nothing
written) and `:26–34` (the header's "never rewritten — not when the row has none");
`platform/auth/user-provisioning.ts:352` (an existing row is returned unchanged) and `:371` (the
address taken only from the caller's profile); `platform/auth/account-status-guard.ts:748`
(`isInGoodStanding` provisions through `loadAccountState(userId)` with no profile), as of
`308b5b1`.

## How it was caught

The owner tested the admin console's Users screen live on playform-dev: accounts made by a
first sign-in on a new pool, and every Google sign-in, showed "—" for their address; the users
table held `email` NULL for them.

## The finding a reviewer should have produced

**Important** — `platform/auth/email-verification.ts:113` — a row with no address is left with
none: the provider's verified, trusted claim is in hand on every request, but only the flag is
ever written, and provisioning (`user-provisioning.ts:352`, `:371`) writes the address only at
creation from its caller's profile, which `account-status-guard.ts:748` does not pass. Any
account first provisioned without one lists no address forever and is not matched by the ban
carry-over. Record the trusted verified address when the row has none (and, on an active
account, when it changed), applying the ban carry-over to it; pass the token's profile wherever
provisioning can happen. Same class: a value captured only at creation from an optional input,
with nothing that fills it later.

## Scoring

- **Caught (2):** Names that a row provisioned without an address never gets one, with the sync's
  `no_address` branch or a provisioning caller that passes no profile.
- **Partial (1):** Says the address is never kept in step with the provider, without the NULL
  case or its cause.
- **Missed (0):** neither; findings elsewhere in the input are counted as noise (README).
