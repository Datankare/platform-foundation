# Cache Provider

Generic caching abstraction for platform-foundation. Interface-first design — swap Redis for Memcached, DynamoDB, or any other cache without code changes.

## Quick Start

```typescript
import { getCache } from "@/platform/cache";

const cache = getCache(); // Auto-detects: Redis if configured, else in-memory

// Set with TTL
await cache.set("user:123:profile", { name: "Alice" }, { ttlSeconds: 300 });

// Get
const profile = await cache.get<UserProfile>("user:123:profile");

// Delete
await cache.delete("user:123:profile");

// Health check
const health = await cache.health();
```

## Environment Variables

| Variable                   | Required  | Description                              |
| -------------------------- | --------- | ---------------------------------------- |
| `UPSTASH_REDIS_REST_URL`   | For Redis | Upstash Redis REST endpoint              |
| `UPSTASH_REDIS_REST_TOKEN` | For Redis | Upstash Redis auth token                 |
| `CACHE_NAMESPACE`          | No        | Key prefix (default: `pf:`)              |
| `CACHE_DEFAULT_TTL`        | No        | Default TTL in seconds (default: `3600`) |

## Providers

### InMemoryCacheProvider (`CACHE_PROVIDER=memory`)

- Zero dependencies
- Automatic TTL expiry
- Sliding expiry support
- **Not suitable for multi-instance production** (no shared state)

### RedisCacheProvider (production)

- Upstash REST API (fetch-based, serverless-compatible)
- Works in edge/serverless environments (no TCP sockets)
- Pipeline support for batched operations
- SCAN-based namespace cleanup

## How to Add a Custom Provider

```typescript
import type { CacheProvider } from "@/platform/cache";

export class DynamoDBCacheProvider implements CacheProvider {
  readonly name = "dynamodb";

  async get<T>(key: string): Promise<T | null> {
    // Your DynamoDB logic
  }

  async set<T>(key: string, value: T, options?: CacheSetOptions): Promise<void> {
    // Your DynamoDB logic
  }

  // ... implement remaining interface methods
}
```

A provider that holds connections open (a Redis-protocol client, 7P) implements the optional
`close()`: `closeCache()` calls it when the instance stops (ADR-055 D5), after the drain and before
the database pools close. The in-memory provider drops its entries; the Upstash REST provider has
nothing open and does not implement it.

## Architecture

```
platform/cache/
├── types.ts          ← CacheProvider interface, CacheEntry, options
├── memory-cache.ts   ← InMemoryCacheProvider (dev/test)
├── redis-cache.ts    ← RedisCacheProvider (Upstash production)
├── index.ts          ← Barrel exports, factory, singleton
└── README.md         ← This file
```

## Invalidation stamps, bounded (review 13 M2)

`stamp-reader.ts` (`readStamp`) is how the config service and the permissions cache read a shared
invalidation stamp: at most 200 ms per read, and a circuit breaker that stops asking a failing
cache for 30 s after 5 failures in a row (alert `cache.stamp_breaker_open`), then probes once. An
unreadable stamp means the value is read from the database and nothing cached is served.

Event-loop lag is not a cache failure (review 14 M-2): at the bound the reader yields once and
takes an answer that has arrived; a read still unanswered while the instance's event loop was
delayed more than 100 ms (measured per read; the instance's `monitorEventLoopDelay` p99/max is
reported with it) is counted as lag — metric and alert `cache.stamp_read_lag` — and never opens the
breaker. Both alerts are raised at most once per 5 minutes per instance, with a count.

## See Also

- ADR-015: GenAI-Native Stack (cache layer)
- ROADMAP.md Phase 2 Sprint 4
