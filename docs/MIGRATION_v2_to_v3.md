# Migrating from v2.x to v3.x

v3.0.0 is Phase 5 Sprint 7A — deployment and auth readiness. The first real deployment showed that
configuration nothing tested could break every user (mock auth, unsigned guest tokens, no database,
the wrong branch live). v3.0.0 makes those failures impossible to ship silently: a production
deployment now **refuses to boot** on a missing or mis-shaped setting, guests are signed and
bounded, every API error carries a code, and a deployed smoke test checks the deployment itself.

Most of this is breaking for a consumer that **deploys**: the production boot is stricter by design.
Work through the sections in order; each says who is affected.

---

## 1. Production settings (ADR-050 D1/D2) — every deploying consumer

With `NODE_ENV=production`, boot runs the environment contract and stops, naming every violation.

| Required now                                                                                            | Notes                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AUTH_PROVIDER=cognito`                                                                                 | Unset or `mock` is refused (the mock is a test double).                                                                                                                                                      |
| `NEXT_PUBLIC_COGNITO_USER_POOL_ID`, `NEXT_PUBLIC_COGNITO_CLIENT_ID`                                     | The `NEXT_PUBLIC_` names are the single source; a non-prefixed alias alone, or one that disagrees, is refused. `NEXT_PUBLIC_COGNITO_REGION` must match the pool id's region. `AWS_REGION` is no longer read. |
| `GUEST_TOKEN_SECRET`                                                                                    | At least 32 random bytes, base64 (`openssl rand -base64 48`), different per environment, server-only.                                                                                                        |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`                                                             | `SUPABASE_URL` is canonical (`https://<ref>.supabase.co`, no path); `NEXT_PUBLIC_SUPABASE_URL` must be unset or equal. The key must be the legacy `service_role` JWT.                                        |
| `APP_STATE_STORE`, `TRAJECTORY_STORE`, `BUDGET_STORE`, `GUEST_USAGE_STORE`, `SOCIAL_STORE` = `supabase` | In-memory stores are refused in production.                                                                                                                                                                  |
| `NEXT_PUBLIC_COGNITO_HOSTED_UI_DOMAIN` + `SSO_PROVIDERS`                                                | Only if you offer single sign-on (§6). Listing providers without the domain is refused.                                                                                                                      |

Harness switches (`E2E_*`, `ADMIN_DEV_BYPASS`) are refused on a hosted deployment (`VERCEL=1`).
Full reference: [ENV_REFERENCE.md](ENV_REFERENCE.md).

## 2. Database — every consumer with a Supabase project

| Situation             | Action                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **New database**      | Run `supabase/baseline/000_baseline.sql` once on the empty project, then every migration the baseline does not record — the platform's newer ones and **all** of the app's own, whatever their number (corrected in v3.1.0, TASK-119). The numbered chain cannot build a database from zero (TASK-091) — see [`supabase/baseline/README.md`](../supabase/baseline/README.md). |
| **Existing database** | Apply **037** (guest allowance) before deploying v3.0.0. Apply **038** (retires the guest lifecycle) only **after** the code that no longer uses the dropped objects is live — drop the schema after the code, never before.                                                                                                                                                  |

## 3. Guests (ADR-050 D4) — consumers with guest access

- Guest tokens are now **signed** (`guest.<payload>.<mac>`, platform-owned). Tokens issued before
  the upgrade are invalid; those guests simply start a new guest session.
- Routes refuse guests unless they opt in: `requireActorWithStatus(request, feature, { allowGuests: true })`.
  PF's `/api/process` opts in and bounds guests with `enforceGuestAllowance` (the governed
  `guest.translate_allowance`, 1–10, default 5).
- **Removed** (TASK-111 — it never worked: wrong columns, nothing called it): `getGuestConfig`,
  `resolveGuestPhase`, `getGuestStatus`, `incrementGuestSession`, `convertGuestToRegistered`,
  `cleanupExpiredGuests` and the `GuestConfig` / `GuestPhase` / `GuestStatus` types from
  `@/platform/auth`; `/api/admin/guest-config`; the admin AI tool `update_guest_config`; the Guest
  Config admin panel and data view. The sync does not delete files (TASK-083): delete
  `platform/auth/guest-lifecycle.ts` and `app/api/admin/guest-config/route.ts` yourself.

## 4. API errors (ADR-051) — every client of the API

- Every error body is `{ code, message, params }`; act on `code` (stable), show `message` (rendered
  in the request's locale). `success: false` and `error` remain as deprecated aliases until Sprint 7B.
- Auth routes return their **real status** on failure (401, 409, 429, …) instead of 200 with
  `success: false`.
- The request proxy's 401 is coded (`auth.required`), and an API call that carries credentials is
  passed to the route — it is **no longer redirected to `/auth`** when the browser session cookie
  is absent. If your `proxy.ts` is your own copy (Playform's is), take both changes.
- All codes: [API_ERRORS.md](API_ERRORS.md).

## 5. Accounts (TASK-117) — every consumer

The platform `users` row is now created on a user's first authenticated request (default role
`free`). Previously nothing created it and a new user on a fresh database was refused as
"suspended". If provisioning fails, the request is refused with `account.not_provisioned` (503),
never as banned. `checkAccountStatus` accepts an optional profile (email) to seed the row.

## 6. Single sign-on (TASK-101) — consumers that offer SSO

SSO runs through the Cognito hosted sign-in with `state` and PKCE. Set
`NEXT_PUBLIC_COGNITO_HOSTED_UI_DOMAIN` (host name only) and `SSO_PROVIDERS` (e.g. `google`), and
register `<origin>/auth/callback` on the app client. `SsoButtons` and `LoginForm` now show **no**
provider by default — only those `GET /api/features` reports available.

## 7. Deployment checks (ADR-050 D5/D6) — every deploying consumer

Run `scripts/deploy-smoke.mjs` after each deploy (`SMOKE_BASE_URL`, `SMOKE_EXPECTED_COMMIT`):
health and the deployed commit, features, a coded refusal, a signed guest token and a real
translation. `/api/health` now reports `commit`. Workflows are consumer-owned (`.github/` does not
sync).

## References

- ADR-050 — deployment environment contract (Accepted in v3.0.0).
- ADR-051 — codes and messages catalog (Proposed; screens follow in Sprint 7B).
- [`RELEASE_NOTES.md`](RELEASE_NOTES.md) — the full v3.0.0 contents.

_Last updated: October 9, 2026 (v3.0.0 — Phase 5 Sprint 7A)_
