# Platform Providers

Central provider configuration for platform-foundation. Every external service is abstracted behind an interface with a pluggable implementation.

## Quick Start

```typescript
// App startup (layout.tsx, instrumentation.ts, or similar)
import { initProviders } from "@/platform/providers/registry";
await initProviders();
```

## Provider Slots

| Slot               | Env Var          | Options             | Default  |
| ------------------ | ---------------- | ------------------- | -------- |
| **Auth**           | `AUTH_PROVIDER`  | `cognito`, `mock`   | `mock`   |
| **Cache**          | `CACHE_PROVIDER` | `upstash`, `memory` | `memory` |
| **AI**             | `AI_PROVIDER`    | `anthropic`, `mock` | `mock`   |
| **Error Reporter** | `ERROR_REPORTER` | `sentry`, `noop`    | `noop`   |

## Zero Config = Working Demo

Set no env vars → every slot runs on its fallback. The app runs, the UI works, the demo is functional. This is by design — PF is a template that must work out of the box.

## Real Providers

Set env vars to activate real providers. Each provider has its own required configuration:

### Auth: Cognito

```bash
AUTH_PROVIDER=cognito
COGNITO_REGION=us-east-1
COGNITO_USER_POOL_ID=us-east-1_XXXXXXXXX
COGNITO_CLIENT_ID=your-app-client-id
```

**Requirements:** AWS Cognito User Pool with USER_PASSWORD_AUTH flow enabled on the app client.

### Auth: Adding Your Own (e.g., Auth0, Firebase, Clerk)

```typescript
// my-app/platform/providers/auth/auth0.ts
import type { AuthProvider } from "@/platform/auth/provider";

export function createAuth0AuthProvider(config: Auth0Config): AuthProvider {
  return {
    signUp: async (email, password) => {
      /* Auth0 SDK calls */
    },
    signIn: async (email, password) => {
      /* Auth0 SDK calls */
    },
    // ... implement all AuthProvider methods
  };
}
```

Then register in your app's startup:

```typescript
import { registerAuthProvider } from "@/platform/auth/config";
import { createAuth0AuthProvider } from "./providers/auth/auth0";

registerAuthProvider(createAuth0AuthProvider({ domain: "...", clientId: "..." }));
```

### Cache: Upstash Redis

```bash
CACHE_PROVIDER=upstash
UPSTASH_REDIS_REST_URL=https://your-instance.upstash.io
UPSTASH_REDIS_REST_TOKEN=your-token
```

### AI: Anthropic

```bash
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
```

### Error Reporter: Sentry

```bash
ERROR_REPORTER=sentry
SENTRY_DSN=https://xxx@sentry.io/yyy
```

## How It Works

`initProviders()` reads the `*_PROVIDER` env vars, instantiates the matching implementation, and registers it with the platform. Every module uses the registered provider via its `getXxx()` function — never imports a provider directly.

```
Environment                  Registry                    Modules
─────────────────────────   ─────────────────────────   ─────────────────────
AUTH_PROVIDER=cognito    →  initProviders() registers → getAuthProvider()
CACHE_PROVIDER=memory    →  InMemoryCacheProvider     → getCache()
AI_PROVIDER=anthropic    →  AnthropicProvider          → getOrchestrator()
ERROR_REPORTER=noop      →  NoopErrorReporter          → getObservability()
```

## Consumer Inheritance

PF provides the registry + reference implementations. Consumers:

1. Inherit via auto-sync
2. Set env vars for their chosen providers
3. Optionally add custom providers (Auth0, Firebase, Redis Cloud, etc.)

Playform-specific note: Playform has its own `cognito-config.ts` and `cognito-*.ts` files (excluded from sync). Playform does NOT use the provider registry — it registers Cognito directly.

## See Also

- `AUTH_INTEGRATION_GUIDE.md` — detailed auth provider guide
- `.env.example` — all env vars with descriptions
- `platform/auth/provider.ts` — AuthProvider interface
- `platform/cache/types.ts` — CacheProvider interface
- `platform/ai/types.ts` — AIProvider interface
- `platform/observability/types.ts` — ErrorReporter interface
