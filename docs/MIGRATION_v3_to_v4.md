# Migrating from v3.x to v4.x

v4.0.0 closes two gaps found while preparing the repository for public use (Sprint 7A, October 2026):
a rate limiter that existed but that no route called, and a streaming route that verified nothing past
the proxy's presence check. Both are fixed so that they cannot silently recur — each has a CI test over
every API route — and the first makes a new setting **required in production**, which is why this is a
major version.

Work through the sections in order; each says who is affected.

---

## 1. Rate limiting (ADR-052) — every deploying consumer

| Required now                                 | Notes                                                                                                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RATE_LIMIT_STORE=supabase` (or `upstash`)   | Production refuses to boot when it is unset or `memory`. `supabase` uses the database you already run; `upstash` needs `UPSTASH_REDIS_REST_URL` and `_TOKEN`. |
| Migration **039** on every database          | Before deploying v4 with `RATE_LIMIT_STORE=supabase`. Additive: one table and two functions, service role only.                                               |
| `TRUSTED_PROXY_HOPS` (optional, default `1`) | How many proxies in front of the app append to `X-Forwarded-For`. Vercel or one load balancer: leave unset.                                                   |

If the store cannot answer, limited routes answer `503 service.unavailable` (the limiter fails closed).
Full reference: [ENV_REFERENCE.md](ENV_REFERENCE.md), [ADR-052](adr/ADR-052-rate-limiting.md).

## 2. Your own routes — every consumer with routes in `app/api`

Two tests arrive with the sync and scan **every** route under `app/api`, including yours:

- `__tests__/api-route-rate-limit.test.ts` — each handler calls `enforceRateLimit` (or `adminGuard`), or the
  route is listed as exempt with a reason. Before verification, count by address:
  `enforceRateLimit(request, DEFAULT_RULES.API_GLOBAL)`; after it, by actor:
  `enforceRateLimit(request, DEFAULT_RULES.AI_PER_USER, { actorId: actor.id })`.
- `__tests__/api-route-auth.test.ts` — each route calls a verifier (`requireActorWithStatus`,
  `requireActor`, `requireAuth`, `adminGuard`), or is listed as public by design with a reason. A
  presence check in a proxy is not verification.

From v4.1.0, an app that verifies or limits through its own wrappers declares them, and its own
public or exempt routes, in `platform/route-policy/app-route-policy.ts` (consumer-owned: add it to the
sync exclude list). Each declared wrapper must call a platform verifier or `enforceRateLimit` itself;
the checks confirm it. Also from v4.1.0, document your own settings in `docs/APP_ENV_REFERENCE.md`
(consumer-owned) rather than excluding the synced `docs/ENV_REFERENCE.md` — see the v4.1.0 release notes.

## 3. Tests — consumers with their own `jest.setup.ts` (sync-excluded)

Routes are now rate limited, and tests in one file share an address, so counts carry between tests. Add,
as the platform's `jest.setup.ts` does:

```ts
import { resetSingleton } from "@/platform/kernel/singleton";
beforeEach(() => {
  resetSingleton("platform.rateLimit.limiter");
});
```

## 4. `/api/stream` (TASK-133) — consumers that stream

- Signed-in users only (guests receive `auth.sign_in_required`), governed by account status under the
  feature `stream`: add `stream` to `account_status.known_features` to offer it — until then the route
  answers `account.restricted` (an unknown feature fails closed).
- Requests are bounded: prompt ≤ 4,000 characters, system prompt ≤ 2,000, `maxTokens` 1–1,024, `tier`
  `fast` or `standard`, `temperature` 0–1. Out-of-range values are refused with a coded 400, not clamped.
- `useRealtimeStream({ getAccessToken })` sends the bearer token.

## 5. Removed and renamed — consumers importing these

| Before (v3)                                         | Now (v4)                                                                                                       |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `platform/auth/rate-limit.ts` (`checkRateLimit`, …) | `enforceRateLimit` from `@/platform/rate-limit`. The sync does not delete files: remove the old file yourself. |
| `createRateLimiter({ provider: "redis" })`          | `createRateLimiter({ provider: "upstash" })`                                                                   |
| Upstash used whenever its variables were set        | Chosen explicitly with `RATE_LIMIT_STORE=upstash`                                                              |
| `POST /api/auth/guest` with no request (tests)      | The handler takes the request                                                                                  |

## 6. Recommended, not required

- `.github/workflows/secret-scan.yml` (gitleaks over every commit) and Semgrep's upload to code scanning
  are platform workflows; `.github` is sync-excluded, so copy them if you want them.
- [`docs/COMPONENT_REGISTER.md`](COMPONENT_REGISTER.md) records each dependency's licence verdict and exit
  path; keep your own the same way.
