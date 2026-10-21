# Rate Limiter

One shared limiter, enforced on every API route, with a swappable store (ADR-052).

## Using it in a route

```typescript
import { DEFAULT_RULES, enforceRateLimit } from "@/platform/rate-limit";

export async function POST(request: NextRequest) {
  // Before verification: counted by network address.
  const limited = await enforceRateLimit(request, DEFAULT_RULES.AUTH_LOGIN);
  if (limited) return limited;
  // …
}

// After verification: counted by the verified actor.
const limited = await enforceRateLimit(request, DEFAULT_RULES.AI_PER_USER, {
  actorId: actor.id,
});
if (limited) return limited;
```

Over the limit the route answers `429 rate.limited` with `Retry-After` and `X-RateLimit-*`. If the
store cannot answer it answers `503 service.unavailable` — the limiter fails closed. Admin routes are
limited through `adminGuard`. `__tests__/api-route-rate-limit.test.ts` fails CI for any route handler
without a limit, unless the route is listed as exempt with its reason.

## Choosing the store

| `RATE_LIMIT_STORE` | Store                                      | Use                                               |
| ------------------ | ------------------------------------------ | ------------------------------------------------- |
| `supabase`         | Postgres, `rate_limit_hit` (migration 039) | Default for deployments; no extra service         |
| `upstash`          | Redis over REST (sorted sets)              | Needs `UPSTASH_REDIS_REST_URL` and `_TOKEN`       |
| `memory`           | In-process                                 | Tests and local work only — refused in production |

The provider registry installs the store at boot. A selected shared store with missing credentials
throws rather than falling back to memory. A new store implements `RateLimiter` and must pass the
conformance kit (`__tests__/contract/rate-limiter-contract.ts`).

The caller's address is read from `X-Forwarded-For` at `TRUSTED_PROXY_HOPS` entries from the right
(default 1), so a caller cannot choose its own bucket by sending the header.

## Rules

| Rule            | Limit        | Counted by |
| --------------- | ------------ | ---------- |
| `AUTH_LOGIN`    | 10 / 15 min  | address    |
| `AUTH_ACCOUNT`  | 10 / hour    | address    |
| `AUTH_GUEST`    | 20 / hour    | address    |
| `AUTH_SESSION`  | 30 / minute  | address    |
| `AI_PER_USER`   | 20 / minute  | actor      |
| `ADMIN_OPS`     | 30 / minute  | address    |
| `API_GLOBAL`    | 100 / minute | address    |
| `SONG_IDENTIFY` | 10 / hour    | actor      |

Which route uses which rule is recorded in ADR-052 D6. A custom rule is a `RateLimitRule`
(`{ id, maxRequests, windowSeconds }`, window at most one day for the Postgres store).

## Layout

```
platform/rate-limit/
├── types.ts             ← RateLimiter interface, rules, results
├── enforce.ts           ← enforceRateLimit — the one call routes make
├── client-ip.ts         ← spoof-resistant caller address
├── factory.ts           ← store factory and the shared instance
├── supabase-limiter.ts  ← SupabaseRateLimiter (Postgres, exact sliding window)
├── redis-limiter.ts     ← RedisRateLimiter (Upstash, sorted sets)
├── memory-limiter.ts    ← InMemoryRateLimiter (tests, local)
├── token-aware.ts       ← token-budget extension
└── index.ts             ← exports
```
