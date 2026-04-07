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

### InMemoryCacheProvider (default fallback)

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

## Architecture

```
platform/cache/
├── types.ts          ← CacheProvider interface, CacheEntry, options
├── memory-cache.ts   ← InMemoryCacheProvider (dev/test)
├── redis-cache.ts    ← RedisCacheProvider (Upstash production)
├── index.ts          ← Barrel exports, factory, singleton
└── README.md         ← This file
```

## See Also

- ADR-015: GenAI-Native Stack (cache layer)
- ROADMAP.md Phase 2 Sprint 4
