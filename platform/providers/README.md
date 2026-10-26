# Platform Providers

Central provider configuration for platform-foundation. Every external service is abstracted behind an interface with a pluggable implementation.

## Quick Start

```typescript
// App startup (instrumentation.ts)
import { registerModules } from "@/platform/modules";
import { APP_MODULES } from "@/platform/modules/app-modules"; // the app's module list (a seam)
import { initProviders } from "@/platform/providers/registry";

registerModules(APP_MODULES); // before the providers: module slots are installed with the core's
initProviders();
```

## Provider Slots

| Slot               | Env Var          | Options             | Default  |
| ------------------ | ---------------- | ------------------- | -------- |
| **Auth**           | `AUTH_PROVIDER`  | `cognito`, `mock`   | `mock`   |
| **Cache**          | `CACHE_PROVIDER` | `upstash`, `memory` | `memory` |
| **AI**             | `AI_PROVIDER`    | `anthropic`, `mock` | `mock`   |
| **Error Reporter** | `ERROR_REPORTER` | `sentry`, `noop`    | `noop`   |

These are the core's slots (`CoreProviderSelections`). A product module declares its own slots in
its definition (`ModuleProviderSlot` — ADR-054 D4): translation (`TRANSLATION_PROVIDER`), voice
(`TTS_PROVIDER`, `STT_PROVIDER`), song-id (`SONG_ID_PROVIDER`), audio-convert (`AUDIO_CONVERTER`),
social (`SOCIAL_STORE`, durable). The app registers its modules before `initProviders()`
(`platform/modules/app-modules.ts`), and the registry then selects, refuses and resets module slots
exactly as its own — a durable module slot is refused without `DATABASE_URL`, refused as memory in
production, required by the environment contract's database check, and cleared by
`resetProviders()` (its `singletonKeys`). `getActiveProviders()` lists the core's slots, then the
modules'. The registry names no module.

## Zero Config = Working Demo

Set no env vars → every slot runs on its fallback. The app runs, the UI works, the demo is functional. This is by design — PF is a template that must work out of the box.

## Real Providers

Set env vars to activate real providers. Each provider has its own required configuration:

### Auth: Cognito

```bash
AUTH_PROVIDER=cognito
NEXT_PUBLIC_COGNITO_USER_POOL_ID=us-east-1_XXXXXXXXX
NEXT_PUBLIC_COGNITO_CLIENT_ID=your-app-client-id
NEXT_PUBLIC_COGNITO_REGION=us-east-1   # optional — defaults to the pool id's region
```

The `COGNITO_*` names without the prefix are accepted aliases; in production an alias must not be
set on its own or disagree with the prefixed name (ADR-050 D2).

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

## Production: the environment contract (ADR-050)

Zero-config fallbacks are for tests and local work. In a production context (`NODE_ENV=production`)
`initProviders()` first runs `assertEnvironmentContract()` (`environment-contract.ts`) and refuses to
boot, naming every violation at once, when:

- auth is a test double — `AUTH_PROVIDER` unset or `mock` (D1). An E2E harness running the production
  build may opt in with `E2E_TEST_DOUBLE_AUTH=true`; `E2E_IN_MEMORY_STORES` does not cover auth;
- a declared setting is mis-shaped, set only under an alias, or set under two names that disagree (D2) —
  `AUTH_PROVIDER`, the Cognito ids, `SUPABASE_URL` (`https://<ref>.supabase.co`), and
  `SUPABASE_SERVICE_ROLE_KEY` (the legacy JWT), `GUEST_TOKEN_SECRET` (≥ 32 random bytes — required with a
  real auth provider: guest tokens are signed, D4), `ERASURE_HASH_KEY` and `REFRESH_COOKIE_KEY` (each
  ≥ 32 characters, required with a real auth provider — the refresh cookie is HMAC-signed, review 17
  M1), the `DATABASE_*` connection settings, `TENANCY_MODE`,
  `TENANT_ID`, `TENANT_DIRECTORY_STORE`, `COGNITO_ADMIN_*`, `CACHE_PROVIDER`, `RATE_LIMIT_STORE`,
  `DEPLOYMENT_HOST` and `TRUSTED_PROXY_HOPS`;
- a required setting is missing:
  - Cognito ids with `cognito`;
  - `DATABASE_URL` when any durable store (`DATABASE_SELECTORS`: every `*_STORE`, `EFFECT_LEDGER`) selects
    `postgres` or `supabase` — the same Postgres store, reached through `platform/data` as `app_tenant`
    (ADR-053 D4) — and `DATABASE_OWNER_URL` with it;
  - `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` only with `REALTIME_PROVIDER=supabase` (`SUPABASE_SELECTORS`):
    Realtime is the one Supabase service left; no data path uses the REST API or the service-role key;
  - `TENANCY_MODE`: `single` needs `TENANT_ID`; `shared` needs `TENANT_DIRECTORY_STORE=postgres` and, with
    `cognito`, `COGNITO_ADMIN_ACCESS_KEY_ID` + `COGNITO_ADMIN_SECRET_ACCESS_KEY`;
  - `CACHE_PROVIDER`, and the two `UPSTASH_REDIS_REST_*` settings with `upstash` (cache or rate limit);
- a database or tenancy setting contradicts another — `DATABASE_URL` and `DATABASE_OWNER_URL` with the same
  user, TLS options in either URL (set `DATABASE_SSL` / `DATABASE_SSL_CA`), `DATABASE_SSL=disable` on a
  deployment, or `TENANT_ID` with `TENANCY_MODE=shared`;
- a harness switch (`E2E_*`, `ADMIN_DEV_BYPASS`) is set where `DEPLOYMENT_HOST` is not `local` or `ci` — the switches are accepted only on a positive non-deployment marker, so a deployment that forgets the setting still refuses them (TASK-140). A `local` or `ci` run may also leave `TENANCY_MODE`, `CACHE_PROVIDER` and `DATABASE_OWNER_URL` unset.

Every reader of these settings goes through the contract's resolvers (`getSupabaseUrl()`,
`getCognitoSettings()`, `getAuthProviderSetting()`, `getDatabaseSettings()`, `getTenancySettings()`), so
what boot validates is what runs.

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
