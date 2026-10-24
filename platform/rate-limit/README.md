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
| `postgres`         | Postgres, `rate_limit_hit` (migration 039) | Default for deployments; needs `DATABASE_URL`     |
| `supabase`         | The same Postgres store                    | Kept so existing settings need no change          |
| `upstash`          | Redis over REST (sorted sets)              | Needs `UPSTASH_REDIS_REST_URL` and `_TOKEN`       |
| `memory`           | In-process                                 | Tests and local work only — refused in production |

The provider registry installs the store at boot. A selected shared store with missing credentials
(or, for `postgres`, no `DATABASE_URL`) throws rather than falling back to memory. A new store implements `RateLimiter` and must pass the
conformance kit (`__tests__/contract/rate-limiter-contract.ts`).

The caller's address is read from `X-Forwarded-For` at `TRUSTED_PROXY_HOPS` entries from the right
(default 1), so a caller cannot choose its own bucket by sending the header.

Counts are per tenant (ADR-053 D6). `enforceRateLimit` puts the tenant in every identifier, and
each store keeps tenants apart on its own: the Postgres store's events are under row-level security
(no tenant: the check throws, and the route answers 503), and the Redis and in-memory stores put
the current tenant in every key.

## Rules

| Rule           | Limit        | Counted by |
| -------------- | ------------ | ---------- |
| `AUTH_LOGIN`   | 10 / 15 min  | address    |
| `AUTH_ACCOUNT` | 10 / hour    | address    |
| `AUTH_GUEST`   | 20 / hour    | address    |
| `AUTH_SESSION` | 30 / minute  | address    |
| `AI_PER_USER`  | 20 / minute  | actor      |
| `ADMIN_OPS`    | 30 / minute  | address    |
| `API_GLOBAL`   | 100 / minute | address    |

These are the core's rules. A product module declares the rules its routes enforce in its
definition (ADR-054 D4) — the song-id module's `SONG_IDENTIFY_RULE` (10 / hour per actor, exported by
`@/platform/voice/song-id`), formerly `DEFAULT_RULES.SONG_IDENTIFY`. `listRateRules()` (`rules.ts`) is
the whole inventory, core first, with each rule's owner; `getRateRule(id)` resolves an id against it
and refuses an unknown one. Two rules may not share an id (one id is one set of counters).

Which route uses which rule is recorded in ADR-052 D6. A custom rule is a `RateLimitRule`
(`{ id, maxRequests, windowSeconds }`, window at most one day for the Postgres store).

## Layout

```
platform/rate-limit/
├── types.ts             ← RateLimiter interface, the core's rules, results
├── rules.ts             ← listRateRules / getRateRule — core and module rules
├── enforce.ts           ← enforceRateLimit — the one call routes make
├── client-ip.ts         ← spoof-resistant caller address
├── factory.ts           ← store factory and the shared instance
├── postgres-limiter.ts  ← PostgresRateLimiter (Postgres, exact sliding window)
├── redis-limiter.ts     ← RedisRateLimiter (Upstash, sorted sets)
├── memory-limiter.ts    ← InMemoryRateLimiter (tests, local)
├── token-aware.ts       ← token-budget extension
└── index.ts             ← exports
```
