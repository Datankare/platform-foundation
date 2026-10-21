# ADR-052: Rate Limiting — One Shared, Swappable Limiter on Every Route

Status: Accepted (Phase 5 Sprint 7A, 2026-10-20). Decision maker: Raman Sud.
Related: ADR-027 (conformance kits), ADR-032 (singletons), ADR-048 D3 (production refuses in-memory stores), ADR-050 (environment contract), ADR-051 (coded errors), TASK-133, TASK-134. `platform/rate-limit/**`, `app/api/**`, `supabase/migrations/039_rate_limit.sql`.

---

## 1. Context

`platform/rate-limit` has offered a sliding-window limiter with in-memory and Redis (Upstash) stores since Phase 2, and the documentation said routes were limited. A route survey in October 2026 found that **no route called it**. The only limiter in use was a separate in-memory one on admin routes, which counts per serverless instance and so does not hold. Public routes — sign-in and every account flow, guest minting, the AI routes — had no limit at all, and no environment configured a shared store. SEC-002 ("no rate limiting on API routes") had been marked resolved since Phase 1 on the strength of the admin limiter. Cost was capped elsewhere (the guest allowance, governed AI budgets, account-level spend limits); what was missing was protection against abuse and brute force.

## 2. Decisions

**D1 — Every API route is rate limited, through one call.** A route calls `enforceRateLimit(request, rule, subject?)` before any work; admin routes do so through `adminGuard`. Over the limit it answers `429 rate.limited` with `Retry-After` and `X-RateLimit-*`. A CI test (`__tests__/api-route-rate-limit.test.ts`) fails any route handler without a limit unless the route is listed as exempt with its reason. The only exemption is `/api/health`: liveness must not depend on the limiter's own store.

**D2 — The store is a provider slot.** `RATE_LIMIT_STORE` selects where the shared counters live: `supabase` (Postgres, migration 039), `upstash` (Redis over REST) or `memory` (tests and local work). Every store implements the same `RateLimiter` interface and passes the same conformance kit (`__tests__/contract/rate-limiter-contract.ts`): admit up to the limit, refuse after with a wait, peek without counting, independent callers and rules, no over-admission under concurrency, ageing out of the window, reset. A replacement store (Valkey in Sprint 7P, or any other) is proven by passing the kit, not assumed.

The Postgres store is an exact sliding window: one row per counted request, serialised per bucket with a transaction-scoped advisory lock, using the database clock so every instance agrees. The migration replay exercises it on real Postgres, including twenty concurrent requests against a limit of five (exactly five admitted; without the lock, eleven were). Expired rows are deleted per bucket on each call and globally after a day.

Postgres was chosen as the default deployment store because it is already run, adds no vendor or credentials, and reuses the atomic-function pattern of the guest allowance and agent budget. Its cost is a database round trip per limited request; the Valkey store in 7P is the faster option on the same interface.

**D3 — A limit that does not hold is refused.** Production refuses `RATE_LIMIT_STORE=memory` (unset included) at boot, as it refuses in-memory stores (ADR-048 D3); the E2E harness opts out with `E2E_IN_MEMORY_STORES`. A shared store selected without its credentials throws instead of falling back to memory, and the environment contract reports a missing Upstash credential.

**D4 — Fail closed.** If the store cannot answer, the request is refused with `503 service.unavailable` (`service: "rate_limit"`) and logged. Protection against abuse must not disappear silently when its store does. The platform's other durable stores live in the same database, so this adds no new failure mode to routes that already depend on it.

**D5 — Who is counted.** After verification, a route counts against the verified actor id (user or guest): the AI routes. Before verification, it counts against the network address. The address is taken from `X-Forwarded-For` at `TRUSTED_PROXY_HOPS` entries from the right (default 1: Vercel, or one load balancer), since entries further left are supplied by the caller and can be forged. A request with no address shares the bucket `unknown`.

**D6 — The rules.**

| Rule            | Limit        | Counted by | Routes                                                                  |
| --------------- | ------------ | ---------- | ----------------------------------------------------------------------- |
| `AUTH_LOGIN`    | 10 / 15 min  | address    | sign-in, MFA challenge, new-password challenge                          |
| `AUTH_ACCOUNT`  | 10 / hour    | address    | sign-up, forgot and confirm password, verify email, resend verification |
| `AUTH_GUEST`    | 20 / hour    | address    | guest token minting                                                     |
| `AUTH_SESSION`  | 30 / minute  | address    | hosted sign-in start and callback, sign-out                             |
| `AI_PER_USER`   | 20 / minute  | actor      | `/api/process`, `/api/stream`                                           |
| `ADMIN_OPS`     | 30 / minute  | address    | every admin and moderation-review route (through `adminGuard`)          |
| `API_GLOBAL`    | 100 / minute | address    | features, agent capabilities, GDPR requests, appeals                    |
| `SONG_IDENTIFY` | 10 / hour    | actor      | provided for a consumer's identification route                          |

## 3. Consequences

- A consumer sets `RATE_LIMIT_STORE` (and applies migration 039 for `supabase`) on every deployment; production will not boot without it.
- A consumer's own routes are checked by the same CI test after sync; each calls `enforceRateLimit` or is exempted with a reason. A consumer's `jest.setup` resets the limiter before each test, as the platform's does.
- The previous `platform/auth/rate-limit.ts` (per-instance, admin only) is removed. `createRateLimiter({ provider: "redis" })` becomes `{ provider: "upstash" }`, and the Upstash store is no longer selected implicitly by the presence of its variables.
