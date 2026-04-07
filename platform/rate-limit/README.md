# Rate Limiter

Distributed rate limiting with sliding window algorithm. Interface-first — swap between in-memory (dev) and Redis (production) via environment config.

## Quick Start

```typescript
import { getRateLimiter, DEFAULT_RULES } from "@/platform/rate-limit";

const limiter = getRateLimiter();

// Check rate limit
const result = await limiter.check(userId, DEFAULT_RULES.AI_PER_USER);
if (!result.allowed) {
  return new Response("Too Many Requests", {
    status: 429,
    headers: {
      "Retry-After": String(result.retryAfterSeconds),
      "X-RateLimit-Limit": String(result.limit),
      "X-RateLimit-Remaining": String(result.remaining),
    },
  });
}
```

## Pre-configured Rules

| Rule          | Max Requests | Window |
| ------------- | ------------ | ------ |
| `API_GLOBAL`  | 100          | 60s    |
| `AI_PER_USER` | 20           | 60s    |
| `AUTH_LOGIN`  | 10           | 15min  |
| `ADMIN_OPS`   | 30           | 60s    |

## Custom Rules

```typescript
const customRule: RateLimitRule = {
  id: "my-app:heavy-endpoint",
  maxRequests: 5,
  windowSeconds: 300,
};
```

## Architecture

```
platform/rate-limit/
├── types.ts            ← RateLimiter interface, rules, results
├── memory-limiter.ts   ← InMemoryRateLimiter (dev/test)
├── redis-limiter.ts    ← RedisRateLimiter (Upstash, sliding window ZSET)
├── index.ts            ← Barrel exports, factory, singleton
└── README.md           ← This file
```

## See Also

- ROADMAP.md Phase 2 Sprint 4 — rate limiter upgrade
