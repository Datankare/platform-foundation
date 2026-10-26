# Environment Variable Reference

Every environment variable Platform Foundation reads, why it exists, whether you need it, its
default, and its valid values. If you are standing the platform up for the first time, start
with [Minimum to run](#minimum-to-run); reach for the full tables when you switch a provider
from its mock default to a real one.

A consuming app documents the settings of its own, and which provider it selects in each of its
environments, in [APP_ENV_REFERENCE.md](APP_ENV_REFERENCE.md) (consumer-owned; a template here). The
docs check reads both files.

Platform Foundation follows one rule everywhere: **every external dependency is a swappable
provider, and every provider defaults to a safe in-memory or mock implementation.** That means
the platform boots and every test passes with _no_ configuration at all — you only set a
variable when you want to connect a real backend (a database, an LLM, an auth system). Nothing
fails closed for lack of a key at boot; a provider you did not configure simply serves its
mock. This is what makes local development and CI frictionless, and it is why the tables below
lean heavily on "optional — defaults to mock."

> Security note, up front: variables prefixed `NEXT_PUBLIC_` are exposed to the browser by
> Next.js and must contain only non-secret values (public URLs, pool IDs). Everything else is
> server-side only. Never put a database URL, a service-role key, an API secret, or a private
> signing key behind a `NEXT_PUBLIC_` name, and never commit a filled
> `.env.local`.

---

## Minimum to run

You can run the platform and the full test suite with **no environment variables** — every
provider falls back to a mock or in-memory implementation. This is the intended local/CI
default.

To do anything real you will typically set, at minimum:

```bash
# A real database (most features that persist need this) — then set each *_STORE=postgres
DATABASE_URL=postgresql://app_tenant:<password>@<pooler-host>:<port>/<database>   # server-side only
DATABASE_OWNER_URL=postgresql://<owner>:<password>@<host>:<port>/<database>       # server-side only

# A real LLM (safety, moderation, agents, admin AI all use it)
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=your-anthropic-key
```

Everything below is layered on top of that as you turn features on.

---

## How provider selection works

Most subsystems pick their implementation from a single `*_PROVIDER` or `*_STORE` variable,
resolved once at startup in `platform/providers/registry.ts`. The pattern is always the same:

- The variable names _which_ implementation to use (e.g. `AI_PROVIDER=anthropic`).
- If unset, it defaults to `mock` (external services) or `memory` (stores).
- The chosen implementation then reads its _own_ credential variables (e.g. selecting
  `anthropic` makes `ANTHROPIC_API_KEY` required).

So configuring a real backend is always two steps: **select the provider**, then **supply its
credentials**.

---

## Core infrastructure

### Database

The database is Postgres, reached directly through `platform/data`: see
[Database connections](#database-connections-adr-053-d4) (`DATABASE_URL`, `DATABASE_OWNER_URL`,
`DATABASE_SSL`, …). Selecting any store `postgres` (or `supabase`, the same store) makes
`DATABASE_URL` required, and `DATABASE_OWNER_URL` with it; in production boot refuses without them.

### Supabase (Realtime only)

No data path uses the Supabase REST API or the service-role key. These settings serve
`REALTIME_PROVIDER=supabase` only.

| Variable                    | Required                          | Default | Notes                                                                                                                     |
| --------------------------- | --------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_URL`              | With `REALTIME_PROVIDER=supabase` | —       | Project URL — the single source (ADR-050 D2). Shape `https://<ref>.supabase.co`: no path, no trailing slash.              |
| `NEXT_PUBLIC_SUPABASE_URL`  | No (alias)                        | —       | Alias of `SUPABASE_URL`, read only when it is unset. In production it must not be set alone or disagree.                  |
| `SUPABASE_SERVICE_ROLE_KEY` | With `REALTIME_PROVIDER=supabase` | —       | **Server-side only.** Never expose to the browser. Must be the legacy service_role JWT (`eyJ…`), not an `sb_secret_` key. |

Selecting `REALTIME_PROVIDER=supabase` makes `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
required; in production boot refuses without them (ADR-050 D2).

### Logging

| Variable    | Required | Default | Values                                 |
| ----------- | -------- | ------- | -------------------------------------- |
| `LOG_LEVEL` | No       | `warn`  | `error` `warn` `info` `debug` `silent` |

### Runtime

| Variable                   | Required                                                 | Default | Notes                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------- | -------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                 | No (set by tooling)                                      | —       | `development` / `production` / `test`. Usually set by your host or test runner, not by hand.                                                                                                                                                                                                                                                                                                    |
| `DEPLOYMENT_HOST`          | No                                                       | —       | Names the host: `vercel`, `container`, `aws`, … (lower case). `local` and `ci` mark a run that is not a deployment, and only they let production accept the test-harness switches (`E2E_*`, `ADMIN_DEV_BYPASS`); any other value, or none, refuses them (ADR-055 D2, TASK-140).                                                                                                                 |
| `GIT_COMMIT_SHA`           | No (set by the image build)                              | —       | The commit a container image was built from (the `GIT_COMMIT_SHA` build argument, baked into the image). 7–40 hex characters; boot refuses anything else. `/api/health/live` and `/api/health/ready` report it as `commit`, else `VERCEL_GIT_COMMIT_SHA` (ADR-055 D2).                                                                                                                          |
| `NEXT_MANUAL_SIG_HANDLE`   | Yes with `DEPLOYMENT_HOST=container` (the image sets it) | —       | `true`: the app, not Next.js, handles SIGTERM and SIGINT — readiness flips, the instance drains, telemetry is flushed and the cache and pools close before it exits (ADR-055 D5, `docs/DEPLOY_CONTAINER.md` §5). Unset, Next.js exits at once. Only `true` is accepted (Next.js treats any value, `false` included, as set).                                                                    |
| `SHUTDOWN_DRAIN_SECONDS`   | No                                                       | `5`     | 0–300. How long a stopping instance keeps answering requests while `/api/health/ready` says not ready (`draining`), so the load balancer takes it out first. At least the load balancer's deregistration delay or readiness-probe window.                                                                                                                                                       |
| `SHUTDOWN_TIMEOUT_SECONDS` | No                                                       | `9`     | 1–600, greater than the drain. The bound on the whole stop from the first signal: requests still running after the drain (a job tick included) are waited for until the bound less up to 2 s, then the pools close; past the bound the process exits 1. Keep it inside the host's grace period (Docker 10 s — `docker stop -t`, ECS `stopTimeout`, Kubernetes `terminationGracePeriodSeconds`). |
| `VERCEL`                   | No (set by the host)                                     | —       | Vercel sets `1` on every deployment. The platform no longer reads it to decide anything; `DEPLOYMENT_HOST` does (TASK-140).                                                                                                                                                                                                                                                                     |
| `VERCEL_GIT_COMMIT_SHA`    | No (set by the host)                                     | —       | The commit a Vercel deployment was built from. `/api/health` reports its first 12 characters as `commit` so the deployed smoke test can prove which code is live (ADR-050 D6).                                                                                                                                                                                                                  |

### Production environment contract (ADR-050 D1/D2)

With `NODE_ENV=production`, boot checks the contract in `platform/providers/environment-contract.ts`
before any provider initializes and refuses to start, naming every violation: test-double auth
(`AUTH_PROVIDER` unset or `mock`), a declared setting that is mis-shaped, set only under an alias
or set under two disagreeing names, a missing required setting, or a harness switch on a hosted
deployment. The declared settings are `AUTH_PROVIDER`, `NEXT_PUBLIC_COGNITO_USER_POOL_ID`,
`NEXT_PUBLIC_COGNITO_CLIENT_ID`, `COGNITO_CLIENT_SECRET`, `NEXT_PUBLIC_COGNITO_REGION`, `NEXT_PUBLIC_COGNITO_HOSTED_UI_DOMAIN`,
`SSO_PROVIDERS`, `AUTH_TRUSTED_EMAIL_IDPS`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GUEST_TOKEN_SECRET`, `RATE_LIMIT_STORE`,
`TENANCY_MODE`, `TENANT_ID`, `DATABASE_URL`, `DATABASE_OWNER_URL`, `DATABASE_POOL_MAX`,
`DATABASE_STATEMENT_TIMEOUT_MS`, `DATABASE_SSL`, `DATABASE_SSL_CA`, `TENANT_DIRECTORY_STORE`,
`COGNITO_ADMIN_ACCESS_KEY_ID`, `COGNITO_ADMIN_SECRET_ACCESS_KEY`, `COGNITO_ADMIN_SESSION_TOKEN`,
`CACHE_PROVIDER`, `DEPLOYMENT_HOST`, `GIT_COMMIT_SHA`, `NEXT_MANUAL_SIG_HANDLE`, `SHUTDOWN_DRAIN_SECONDS`,
`SHUTDOWN_TIMEOUT_SECONDS`, `TRUSTED_PROXY_HOPS`, `TENANT_HOST_HEADER`, `CRON_SECRET`, `ERASURE_HASH_KEY`, `ERASURE_HASH_KEY_PREVIOUS`, `REFRESH_COOKIE_KEY`, `REFRESH_COOKIE_KEY_PREVIOUS`, `PROVENANCE_SIGNING_KEY` and `PROVENANCE_SIGNING_KEY_PREVIOUS`, each with the aliases
listed in this reference.

---

## Authentication

| Variable                                      | Required          | Default | Values                                                                                                                                  |
| --------------------------------------------- | ----------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_PROVIDER` / `NEXT_PUBLIC_AUTH_PROVIDER` | Yes in production | `mock`  | `cognito` `mock` — `mock` is a test double, refused in production (ADR-050 D1)                                                          |
| `E2E_TEST_DOUBLE_AUTH`                        | No                | —       | `true` (E2E harness only — permits the mock auth provider under a production build; honoured only with `DEPLOYMENT_HOST=local` or `ci`) |

Selecting `cognito` requires the AWS Cognito settings. The `NEXT_PUBLIC_COGNITO_*` names are the
single source, read by both browser and server; the non-prefixed `COGNITO_*` names are aliases,
accepted only when unset or equal (ADR-050 D2). `AWS_REGION` is not read — hosts set it to the
function's region, not the pool's.

| Variable                           | Required                               | Default                                                                   | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------- | -------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NEXT_PUBLIC_COGNITO_USER_POOL_ID` | With `cognito`                         | —                                                                         | e.g. `us-east-1_ABC123`. Browser-safe.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `NEXT_PUBLIC_COGNITO_CLIENT_ID`    | With `cognito`                         | —                                                                         | App client ID. Browser-safe.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `COGNITO_CLIENT_SECRET`            | With `cognito` (production)            | —                                                                         | The app client's secret: the client must be **confidential** (audit A-7). Every call to the pool that is not made with a user's token carries a `SECRET_HASH` only the server can compute, so nobody can sign up, sign in or reset a password around the platform's routes, policy, rate limits and audit. **Server-side only. Secret.**                                                                                                                                                                                                                                                                                                                                                               |
| `NEXT_PUBLIC_COGNITO_REGION`       | No                                     | pool id's region                                                          | e.g. `us-east-1`. Must match the pool id's region prefix.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `COGNITO_REGION`                   | No (alias)                             | —                                                                         | Alias of `NEXT_PUBLIC_COGNITO_REGION`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `COGNITO_USER_POOL_ID`             | No (alias)                             | —                                                                         | Alias of `NEXT_PUBLIC_COGNITO_USER_POOL_ID`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `COGNITO_CLIENT_ID`                | No (alias)                             | —                                                                         | Alias of `NEXT_PUBLIC_COGNITO_CLIENT_ID`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `ADMIN_DEV_BYPASS`                 | No                                     | unset                                                                     | **Development only.** When set, bypasses admin permission checks for local work. Never set in production.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `GUEST_TOKEN_SECRET`               | With a real auth provider (production) | per-process random (non-production)                                       | HMAC-SHA256 key that signs guest tokens (ADR-050 D4). At least 32 random bytes, base64 — `openssl rand -base64 48`. **Server-side only.** One per environment; rotating it signs every guest out. An E2E harness on the production build with the mock provider sets it to test guests.                                                                                                                                                                                                                                                                                                                                                                                                                |
| `ERASURE_HASH_KEY`                 | With a real auth provider (production) | a fixed development key (local, tests, a CI harness on the mock provider) | HMAC-SHA256 key of the address hash kept for an account erased while banned (audit A-11, review 7 L4), so the ban follows the address without the address being recoverable from a list of addresses. At least 32 random characters — `openssl rand -hex 32`. **Server-side only. Secret.** Each hash records the key's id (review 8 L6). To rotate: move the old key to `ERASURE_HASH_KEY_PREVIOUS` and set a new one — bans the old key hashed still match, and each is rehashed under the new key when it matches. A ban recorded before v6.0.0 (an unsalted SHA-256) is still recognised, and the retention job (`gdpr.retention-purge`) upgrades it to the current key.                           |
| `ERASURE_HASH_KEY_PREVIOUS`        | No (rotation)                          | —                                                                         | The erasure-hash key before the current one (review 8 L6): bans it hashed still match and are rehashed under `ERASURE_HASH_KEY` when they match; nothing new is hashed with it. Remove it once no erased ban under the old key matters — those it alone matches stop matching. **Server-side only. Secret.**                                                                                                                                                                                                                                                                                                                                                                                           |
| `REFRESH_COOKIE_KEY`               | With a real auth provider (production) | per-process random (non-production)                                       | HMAC-SHA256 key that makes the refresh cookie (`pf_refresh`, `<user id>.<mac>.<refresh token>`) tamper-evident (review 17 M1): a cookie whose MAC fails — forged, edited, or issued before v6.0.0's review 17 — is refused by `/api/auth/refresh` and ignored by `/api/auth/sign-out` (the user signs in again). At least 32 random characters — `openssl rand -hex 32`. **Server-side only. Secret.** One per environment, the same on every instance. To rotate: move the old key to `REFRESH_COOKIE_KEY_PREVIOUS` and set a new one — cookies the old key signed still verify; new ones are signed with the new key. Rotating without the previous key signs every browser out at its next refresh. |
| `REFRESH_COOKIE_KEY_PREVIOUS`      | No (rotation)                          | —                                                                         | The refresh-cookie key before the current one: verifies, never signs. Must differ from `REFRESH_COOKIE_KEY` and needs it set. Remove it 30 days (the refresh-token lifetime) after the rotation. **Server-side only. Secret.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

### Single sign-on (TASK-101)

SSO runs through the Cognito hosted sign-in (authorization code with PKCE and `state`). A provider
is offered only when all of this is true (ADR-050 D3, `GET /api/features` → `sso_<provider>`):
`AUTH_PROVIDER=cognito` with its pool and client ids, `NEXT_PUBLIC_COGNITO_HOSTED_UI_DOMAIN` set, and
the provider listed in `SSO_PROVIDERS`. Listing a provider declares that it is enabled on the Cognito
app client — the platform cannot see that. Register `<origin>/auth/callback` as an allowed callback
URL on the app client for every address the app is served from.

| Variable                               | Required                           | Default | Notes                                                                                                                    |
| -------------------------------------- | ---------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| `NEXT_PUBLIC_COGNITO_HOSTED_UI_DOMAIN` | With `SSO_PROVIDERS` and `cognito` | —       | Hosted sign-in host name only — no `https://`, no path — e.g. `<prefix>.auth.us-east-1.amazoncognito.com`.               |
| `SSO_PROVIDERS`                        | No                                 | none    | Comma-separated, no spaces: `google`, `apple`, `microsoft`. Only those listed are offered. Apple and Microsoft: Phase 6. |

`AUTH_TRUSTED_EMAIL_IDPS` (review 16 L8) — No; default `Google`. A comma-separated list (spaces
around the commas allowed; names matched case-insensitively, so `google` names the pool's `Google`
— review 17 L3) of the pool's identity provider names (as the user's `identities` attribute names them: `Google`,
`SignInWithApple`, a SAML/OIDC provider's own name) whose `email_verified` claim is believed. A
user the pool itself verified (a native user who entered the code) is always believed; a federated
user from a provider not listed never counts as verified — not when provisioning stores
`users.email_verified`, not in the TASK-176 sync, not in the identity re-link
(`docs/TENANCY_OPERATIONS.md` §6). List only a provider whose claim means the provider itself
verified the address (Google; Sign in with Apple). **Never Microsoft Entra ID**: its `email` is an
attribute the account's own Entra tenant can set to any address, unverified ("nOAuth"). A malformed
value trusts no federated provider (fail closed; production boot refuses it, and so does the
identity re-link command — exit 2).

### Cognito pool shape (review 17 L2/L4)

The platform's Cognito provider requires a pool of this shape — no setting carries it:

- **Users sign in by email address** — the pool's _sign-in identifiers_ are the email address
  (`UsernameAttributes` includes `email`; a phone number beside it is fine). A native user's pool
  username is then its `sub`: a session refresh (`REFRESH_TOKEN_AUTH`) is hashed with the `sub`
  (`SECRET_HASH`), and a user whose pool username is its `sub` and who lists no federated identity
  is taken as native (the pool verified their address). A pool that signs in by a chosen
  **username** (with or without an email alias) cannot refresh a session. The shape is fixed when
  the pool is created: such a pool must be replaced (TENANCY_OPERATIONS.md §6 moves accounts).
- **`identities` readable by the app client** — the client's readable attributes are all
  (unset) or include `identities`. Hidden, it is absent for every user; once the platform learns
  this, no user is taken as native and no address is marked verified from the pool.
- A native user linked to a federated identity (`AdminLinkProviderForUser`) lists that provider
  in `identities`, and is treated as that provider's user (trusted only if listed in
  `AUTH_TRUSTED_EMAIL_IDPS`).
- **Authenticator-app MFA enabled** — software-token MFA on, MFA `OPTIONAL` (`ON` would demand a
  second factor from every user). Staff must set up an authenticator app (audit A-9, the admin
  console's setup screen); with software tokens off the pool refuses that setup. Readiness does not
  check this — set and check it by hand (below).

Readiness checks it (probe `identity-pool`, `platform/auth/pool-shape-probe.ts`) with the
administrative credentials (`DescribeUserPool`, `DescribeUserPoolClient` — already in their
policy): a username-sign-in pool makes the instance **not ready** (the deployment is refused before
it serves); `identities` hidden, or a pool that does not answer, reports **degraded**. Without
administrative credentials the probe cannot ask — it logs once
`Identity pool shape not checked: check it by hand` — and the operator checks it:

```sh
aws cognito-idp describe-user-pool --user-pool-id "$NEXT_PUBLIC_COGNITO_USER_POOL_ID" \
  --query UserPool.UsernameAttributes          # must include "email"
aws cognito-idp describe-user-pool-client --user-pool-id "$NEXT_PUBLIC_COGNITO_USER_POOL_ID" \
  --client-id "$NEXT_PUBLIC_COGNITO_CLIENT_ID" \
  --query UserPoolClient.ReadAttributes        # null, or must include "identities"
```

Authenticator-app MFA (not checked by readiness):

```sh
aws cognito-idp set-user-pool-mfa-config --user-pool-id "$NEXT_PUBLIC_COGNITO_USER_POOL_ID" \
  --software-token-mfa-configuration Enabled=true --mfa-configuration OPTIONAL
aws cognito-idp get-user-pool-mfa-config --user-pool-id "$NEXT_PUBLIC_COGNITO_USER_POOL_ID" \
  --query '[MfaConfiguration, SoftwareTokenMfaConfiguration.Enabled]' --output text   # OPTIONAL True
```

---

## Tenancy (ADR-053)

A tenant is the unit of isolation: its users, data, configuration, limits, budgets, audit and
metrics. A deployment declares how many tenants it serves.

| Variable                          | Required                                          | Default                                                          | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TENANCY_MODE`                    | Yes in production                                 | `single` outside production                                      | `single` — one tenant (`TENANT_ID`), a dedicated deployment; `shared` — each request's tenant comes from the verified identity, or for anonymous requests from the address (`tenant_domains`).                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `TENANT_ID`                       | With `TENANCY_MODE=single`; refused with `shared` | the default tenant                                               | The one tenant a single deployment serves, a lower-case UUID. Existing data belongs to the default tenant `00000000-0000-4000-8000-000000000001`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `TENANT_DIRECTORY_STORE`          | With `TENANCY_MODE=shared`                        | `memory` outside production                                      | Where tenants and their domains are kept: `postgres`. `memory` is refused in production.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `TENANT_HOST_HEADER`              | With `TENANCY_MODE=shared`                        | — (unset, a shared deployment answers `503 service.unavailable`) | Where a request's address — which decides the tenant before sign-in — is read; chosen, never inferred. `x-forwarded-host`: the entry the outermost proxy added (`TRUSTED_PROXY_HOPS` from the right), else `Host` — for a proxy that always sets it (**Vercel**). `host`: the `Host` header only, `X-Forwarded-Host` ignored — for a load balancer that forwards `Host` and does not set `X-Forwarded-Host` (**AWS ALB**, a container behind it), where that header is whatever the caller sent. `next start` fills `X-Forwarded-Host` from `Host` only when a request has none, so it never replaces a caller's. |
| `COGNITO_ADMIN_ACCESS_KEY_ID`     | With `TENANCY_MODE=shared` and Cognito            | —                                                                | AWS access key the platform uses to set each user's tenant (`custom:tenant_id`, which users cannot change). Allow it only the Cognito actions named in the contract, on this pool. Secret.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `COGNITO_ADMIN_SECRET_ACCESS_KEY` | With `COGNITO_ADMIN_ACCESS_KEY_ID`                | —                                                                | The secret key that pairs with it. Secret.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `COGNITO_ADMIN_SESSION_TOKEN`     | With temporary (`ASIA…`) credentials only         | —                                                                | The session token of temporary credentials. Secret.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

### Database connections (ADR-053 D4)

Every durable store reaches Postgres directly through `platform/data` — the request connection
as `app_tenant` (cannot bypass row-level security), the owner connection only on operator paths.
Setting them up: [TENANCY_OPERATIONS.md](TENANCY_OPERATIONS.md) §1.

| Variable                        | Required                                     | Default       | Description                                                                                                                                                                                   |
| ------------------------------- | -------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                  | With any store on `postgres`/`supabase`      | —             | The request connection: a transaction pooler URL signing in as `app_tenant`. Secret.                                                                                                          |
| `DATABASE_OWNER_URL`            | With `DATABASE_URL`, in a deployment         | —             | The owner connection, for platform defaults and tenant lifecycle only. Must not be the same user as `DATABASE_URL`. Secret.                                                                   |
| `DATABASE_SSL`                  | No                                           | `verify-full` | `verify-full` (certificate checked; give `DATABASE_SSL_CA` for a provider CA) or `disable` (local and CI only). There is no encrypted-but-unverified mode. Never put TLS options in the URLs. |
| `DATABASE_SSL_CA`               | With `verify-full` when the CA is not public | —             | The database's CA certificate, PEM; line breaks may be written `\n`.                                                                                                                          |
| `DATABASE_POOL_MAX`             | No                                           | `3`           | Connections per instance, 1–50. Serverless: 1–3; the pooler multiplexes.                                                                                                                      |
| `DATABASE_STATEMENT_TIMEOUT_MS` | No                                           | `10000`       | Longest a statement — or an idle transaction — may take, 100–600000.                                                                                                                          |

A shared deployment's Cognito pool needs a mutable String attribute `tenant_id`; the app client
must be able to read `custom:tenant_id` and must not be able to write it, and no federated sign-in
may map a claim into it. The operator console's tenancy check reports each of these.

---

## AI / LLM

| Variable                          | Required                         | Default     | Values                                                                                                                                                                                                                                                                           |
| --------------------------------- | -------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AI_PROVIDER`                     | No                               | `anthropic` | `anthropic` `mock`. `mock` echoes every prompt (the safety classifier's too) and is accepted only with `DEPLOYMENT_HOST` `local` or `ci` (audit G-13: the setting had no effect before).                                                                                         |
| `ANTHROPIC_API_KEY`               | With `anthropic`                 | —           | Powers safety classification, moderation, agent reasoning, and the admin AI command bar.                                                                                                                                                                                         |
| `OPENAI_API_KEY`                  | With `EMBEDDING_PROVIDER=openai` | —           | Used only by the OpenAI embedding provider (RAG).                                                                                                                                                                                                                                |
| `EMBEDDING_PROVIDER`              | No                               | `mock`      | `openai` `mock`                                                                                                                                                                                                                                                                  |
| `PROVENANCE_SIGNING_KEY`          | With image generation            | —           | At least 32 random characters (`openssl rand -hex 32`). The HMAC key of the provenance credential on generated images (ADR-047, audit X-18); the credential names it by a fingerprint (`keyId`). Unset, credentials are unsigned and never verify. **Server-side only. Secret.** |
| `PROVENANCE_SIGNING_KEY_PREVIOUS` | No (rotation)                    | —           | The key before the current one (review 7 L6): credentials it signed still verify, nothing new is signed with it. To rotate: set the old key here, the new one as `PROVENANCE_SIGNING_KEY`; remove this once the old credentials no longer matter. **Server-side only. Secret.**  |

---

## Language & voice providers

All default to `mock`; each real selection reads the shared `GOOGLE_API_KEY` (except song ID
and audio conversion, which have their own). These are product modules' slots (ADR-054): read only
when the app registers the module — translation (`TRANSLATION_PROVIDER`), voice (`TTS_PROVIDER`,
`STT_PROVIDER`), song-id (`SONG_ID_PROVIDER`, `ACRCLOUD_*`), audio-convert (`AUDIO_CONVERTER*`).

| Variable                 | Required                   | Default | Values                                                                                                                                                                                                  |
| ------------------------ | -------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TRANSLATION_PROVIDER`   | No                         | `mock`  | `google` `mock`                                                                                                                                                                                         |
| `TTS_PROVIDER`           | No                         | `mock`  | `google` `mock`                                                                                                                                                                                         |
| `STT_PROVIDER`           | No                         | `mock`  | `google` `mock`                                                                                                                                                                                         |
| `GOOGLE_API_KEY`         | With any `google` provider | —       | Shared Google Cloud key for translate/TTS/STT. **Server-side only.** `NEXT_PUBLIC_GOOGLE_API_KEY` is no longer read and is refused at boot: a `NEXT_PUBLIC_` value is shipped to browsers (audit G-13). |
| `SONG_ID_PROVIDER`       | No                         | `mock`  | `acrcloud` `mock`                                                                                                                                                                                       |
| `ACRCLOUD_HOST`          | With `acrcloud`            | —       | e.g. `identify-us-west-2.acrcloud.com`.                                                                                                                                                                 |
| `ACRCLOUD_ACCESS_KEY`    | With `acrcloud`            | —       |                                                                                                                                                                                                         |
| `ACRCLOUD_ACCESS_SECRET` | With `acrcloud`            | —       |                                                                                                                                                                                                         |
| `AUDIO_CONVERTER`        | No                         | `mock`  | `ffmpeg-service` `passthrough` `mock`                                                                                                                                                                   |
| `AUDIO_CONVERTER_URL`    | With `ffmpeg-service`      | —       | Endpoint of the conversion service.                                                                                                                                                                     |
| `AUDIO_CONVERTER_KEY`    | With `ffmpeg-service`      | —       | Auth key for the conversion service.                                                                                                                                                                    |

---

## Caching & realtime

| Variable                   | Required                      | Default                     | Values                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------- | ----------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CACHE_PROVIDER`           | Yes in production             | `memory` outside production | `upstash` (Upstash REST — Vercel, or any host) or `valkey` (a Valkey or Redis server over TLS — a container host's own, review 9 M5) — chosen, never inferred: a Redis URL alone selects nothing, and either without its connection refuses to boot (TASK-139). `memory` (per instance, bounded and swept) is for local and CI runs only (`DEPLOYMENT_HOST` `local`/`ci`): a deployment refuses it (review 8 L3), since sign-outs, role and MFA changes and permission invalidations are published through the cache to every instance. The boot error names exactly what to set                                                                                                                                                                                                                                                                                                                                               |
| `UPSTASH_REDIS_REST_URL`   | With `CACHE_PROVIDER=upstash` | —                           | Upstash Redis REST endpoint (the database's REST API panel). Pasted straight into the host's secret store (Vercel → Settings → Environment Variables, per environment), never displayed or committed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `UPSTASH_REDIS_REST_TOKEN` | With `CACHE_PROVIDER=upstash` | —                           | Upstash Redis REST token. Server-side secret, handled as the URL.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `VALKEY_URL`               | With `CACHE_PROVIDER=valkey`  | —                           | `rediss://[user:password@]host:port[/db]` of a Valkey or Redis server (ElastiCache, Memorystore, your own): TLS, the certificate verified against the system CAs and its name against the host (verify-full). `redis://` (clear text) only for a local or CI run. No query string or fragment — refused at boot (review 10 M6: the client read `?tls=`, `?commandTimeout=` as options overriding TLS and the timeout); the path, if any, is the database number. A user name needs its password (`rediss://user:password@host`, or a password alone, `rediss://:password@host`), and a literal `%` in either is written `%25`: a malformed percent-escape or a user without a password is refused at boot with `config.valkey_url_invalid` (review 11 L-6). A secret (it holds the password): in the container platform's secret store (ECS task secret from Secrets Manager, Kubernetes Secret), never in the image or a log. |
| `VALKEY_CA_CERT`           | No                            | —                           | A PEM bundle of the CA that signed the Valkey server's certificate — only for a private CA (the system CAs are used otherwise).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `REALTIME_PROVIDER`        | No                            | `mock`                      | `supabase` `mock`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `TRUSTED_PROXY_HOPS`       | No                            | `1`                         | `1`–`5` — proxies in front of the app that append to `X-Forwarded-For`; the client address is that many entries from the right (ADR-052). Vercel, or one load balancer: `1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

Selecting `CACHE_PROVIDER=upstash` or `RATE_LIMIT_STORE=upstash` requires the two `UPSTASH_REDIS_REST_*` variables;
`CACHE_PROVIDER=valkey` requires `VALKEY_URL` (`rediss://` in a deployment). Selecting
`REALTIME_PROVIDER=supabase` requires `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (above).

---

## Observability

| Variable         | Required      | Default | Values              |
| ---------------- | ------------- | ------- | ------------------- |
| `ERROR_REPORTER` | No            | `noop`  | `sentry` `noop`     |
| `SENTRY_DSN`     | With `sentry` | —       | Sentry project DSN. |

---

## Stores (persistence backends)

Each store selects between an in-memory implementation (default, ephemeral) and Postgres
(durable, through `platform/data`). `postgres` is the name; `supabase` is still accepted and selects
the same Postgres store. Selecting either for any of these requires `DATABASE_URL` and
`DATABASE_OWNER_URL` ([Database connections](#database-connections-adr-053-d4)).

| Variable                | Required          | Default  | Values                                                                                                                                                                                                                                       |
| ----------------------- | ----------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MODERATION_STORE`      | Yes in production | `memory` | `postgres` (or `supabase`) `memory` — moderation decisions (the record appeals are judged from); production refuses `memory`; `postgres` without `DATABASE_URL` is an error (Sprint 7X)                                                      |
| `STRIKE_STORE`          | Yes in production | `memory` | `postgres` (or `supabase`) `memory` — strikes toward the ban ladder; production refuses `memory`; `postgres` without `DATABASE_URL` is an error (Sprint 7X, audit X-3)                                                                       |
| `REVIEW_QUEUE_STORE`    | Yes in production | `memory` | `postgres` (or `supabase`) `memory` — the human review queue (escalations, ban reviews, appeals); production refuses `memory` (Sprint 7X, audit X-3)                                                                                         |
| `SOCIAL_STORE`          | Yes in production | `memory` | `postgres` (or `supabase`) `memory` — groups and memberships; production refuses `memory`, and `postgres` without `DATABASE_URL` is an error (TASK-107). The social module's slot: required only when the app registers the module (ADR-054) |
| `APP_STATE_STORE`       | Yes in production | `memory` | `postgres` (or `supabase`) `memory` — activity sessions; production refuses `memory` (ADR-049 D1)                                                                                                                                            |
| `TRAJECTORY_STORE`      | Yes in production | `memory` | `postgres` (or `supabase`) `memory` — agent trajectories; production refuses `memory` (ADR-048 D3)                                                                                                                                           |
| `BUDGET_STORE`          | Yes in production | `memory` | `postgres` (or `supabase`) `memory` — agent budget accumulation; production refuses `memory` (ADR-048 D3)                                                                                                                                    |
| `PROPOSAL_STORE`        | Yes in production | `memory` | `postgres` (or `supabase`) `memory` — held actions awaiting approval; production refuses `memory` (Sprint 7X, audit X-21)                                                                                                                    |
| `EFFECT_LEDGER`         | Yes in production | `memory` | `postgres` (or `supabase`) `memory` — at-most-once external effects; production refuses `memory` (Sprint 7X, audit X-21)                                                                                                                     |
| `APPROVAL_POLICY_STORE` | Yes in production | `memory` | `postgres` (or `supabase`) `memory` — who approves held actions; production refuses `memory` (Sprint 7X, audit X-21)                                                                                                                         |
| `GUEST_USAGE_STORE`     | Yes in production | `memory` | `postgres` (or `supabase`) `memory` — counts the guest translate allowance (ADR-050 D4); production refuses `memory`; `postgres` needs migration 037                                                                                         |
| `RATE_LIMIT_STORE`      | Yes in production | `memory` | `postgres` (or `supabase`) `upstash` `memory` — where the shared rate-limit counters live (ADR-052); production refuses `memory`; `postgres` needs migration 039; `upstash` needs the two `UPSTASH_REDIS_REST_*` variables                   |
| `JOB_STORE`             | Yes in production | `memory` | `postgres` (or `supabase`) `memory` — background jobs and their schedules (ADR-056 D2); production refuses `memory`; `postgres` needs migration 050                                                                                          |
| `E2E_IN_MEMORY_STORES`  | No                |          | `true` (E2E harness only — permits in-memory stores under a production build; honoured only with `DEPLOYMENT_HOST=local` or `ci`; never set on a deployment)                                                                                 |

Every store above is `postgres` in production: a production build refuses to start on an
in-memory store (and `instrumentation.ts` lets that refusal stop the server — Sprint 7X). In-memory
is correct for tests and local exploration.

---

## Background jobs (ADR-056 D2)

| Variable                       | Required                  | Default | Values                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------ | ------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CRON_SECRET`                  | Yes, in every deployment  | —       | At least 32 random characters (`openssl rand -hex 32`). The bearer secret of `/api/internal/jobs/tick`: Vercel Cron sends `Authorization: Bearer $CRON_SECRET` (`vercel.json`, every five minutes — a Pro plan; Hobby allows once a day); the CLI worker sends the same. Unset, a deployment refuses to boot (every tick would be refused and no timed duty would run); a `local` or `ci` run may leave it unset, and its ticks are refused (503). Server-side secret. |
| `JOBS_WORKER_URL`              | For `npm run jobs:worker` | —       | The app's origin the CLI worker ticks (`scripts/jobs-worker.mjs`): https, or http for localhost. For hosts without a scheduler (a container, Vercel Hobby).                                                                                                                                                                                                                                                                                                            |
| `JOBS_WORKER_INTERVAL_SECONDS` | No                        | `60`    | `5`–`3600` — seconds between the worker's ticks (it ticks again at once while work remains).                                                                                                                                                                                                                                                                                                                                                                           |
| `JOBS_WORKER_TIMEOUT_MS`       | No                        | `70000` | Per tick request, in milliseconds (a tick runs for at most 45 s).                                                                                                                                                                                                                                                                                                                                                                                                      |
| `JOBS_WORKER_ONCE`             | No                        | —       | `1` — one tick, then exit (0 when it succeeded) — for a host scheduler that runs the worker itself (EventBridge, Kubernetes CronJob).                                                                                                                                                                                                                                                                                                                                  |

The job store is `JOB_STORE` ([Stores](#stores-persistence-backends)). What runs, how often, and
how operators pause, replay or discard: [runbooks/jobs.md](runbooks/jobs.md).

---

## Operator commands

`scripts/relink-identity.mjs` (re-linking accounts to a new identity pool, TASK-174 —
[TENANCY_OPERATIONS.md](TENANCY_OPERATIONS.md) §6) runs on an operator's machine, not in a
deployment. It reads, from the shell's environment only (each secret read by a prompt, never a
file): `DATABASE_OWNER_URL` with `DATABASE_SSL` / `DATABASE_SSL_CA` — checked as the contract
checks them, stricter for a workstation (no TLS option in the URL; `DATABASE_SSL=disable` only for
a database on that machine; `DATABASE_SSL_CA` required with `verify-full`); the pool —
`NEXT_PUBLIC_COGNITO_USER_POOL_ID` or `COGNITO_USER_POOL_ID`, its region from the id (or
`NEXT_PUBLIC_COGNITO_REGION` / `COGNITO_REGION`); a key allowed `cognito-idp:ListUsers` on that
pool in `COGNITO_ADMIN_ACCESS_KEY_ID` / `COGNITO_ADMIN_SECRET_ACCESS_KEY` (+
`COGNITO_ADMIN_SESSION_TOKEN` for temporary credentials) — the operator's own key, not the app's;
and the shared cache's settings (`CACHE_PROVIDER` and its own), so its invalidation reaches every
instance. A missing or wrong setting is named, never its value. The pool move time is an
argument (`--created-before`), not a setting.

---

## Agent delegation keys (rung-2 attested delegation)

If your consumer application uses **agent delegation** (ADR-033) — where an agent acts on a
user's behalf under a short-lived signed token — you must configure an RS256 key pair. Without
it, delegation verification is **disabled and fails closed**: no agent can present a delegation
token, so agent-on-behalf-of-user calls are denied. (Direct, non-delegated calls are
unaffected.)

| Variable                     | Required                    | Default                                   | Notes                                                                                            |
| ---------------------------- | --------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `DELEGATION_JWT_PUBLIC_KEY`  | To VERIFY delegation tokens | unset → delegation disabled (fail-closed) | SPKI PEM. Set wherever tokens are verified (i.e. every service that honors an agent delegation). |
| `DELEGATION_JWT_PRIVATE_KEY` | To MINT delegation tokens   | unset → the token endpoint cannot mint    | PKCS8 PEM. Set **only** where the consent/token endpoint runs. Treat as a top secret.            |

### Generating the key pair

Generate an RSA key pair and export both halves in the PEM formats the platform expects:

```bash
# 1. Private key (PKCS8) — keep secret; set as DELEGATION_JWT_PRIVATE_KEY
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out delegation_private.pem

# 2. Public key (SPKI) — set as DELEGATION_JWT_PUBLIC_KEY
openssl rsa -in delegation_private.pem -pubout -out delegation_public.pem
```

### Putting PEMs into environment variables

A PEM is multi-line; environment variables are single-line. Encode the newlines as literal
`\n` so the value fits on one line — the platform restores them when it imports the key:

```bash
# Produces a single-line value with \n in place of real newlines
awk 'NF {sub(/\r/, ""); printf "%s\\n", $0;}' delegation_private.pem
awk 'NF {sub(/\r/, ""); printf "%s\\n", $0;}' delegation_public.pem
```

Then, in `.env.local` (or your host's secret manager):

```bash
DELEGATION_JWT_PRIVATE_KEY="<PKCS#8 PEM private key, newlines written as \n>"
DELEGATION_JWT_PUBLIC_KEY="<SPKI PEM public key, newlines written as \n>"
```

### Where each key goes

- **Verification services** (anything that receives an agent request bearing a delegation
  token): set `DELEGATION_JWT_PUBLIC_KEY` only. They should never hold the private key.
- **The consent/token endpoint** (the single place that mints tokens): set **both**, since it
  signs with the private key and may verify with the public one.

### Rotation

Rotating is a public-key swap: deploy the new public key to verifiers first (they can be given
multiple keys during a window if you extend the loader), then switch the minting endpoint to
the new private key. Because tokens are short-lived (minutes), a rotation window need only be
as long as the maximum token lifetime.

---

## Full alphabetical index

`ACRCLOUD_ACCESS_KEY` · `ACRCLOUD_ACCESS_SECRET` · `ACRCLOUD_HOST` · `ADMIN_DEV_BYPASS` ·
`AI_PROVIDER` · `ANTHROPIC_API_KEY` · `APPROVAL_POLICY_STORE` · `APP_STATE_STORE` ·
`AUDIO_CONVERTER` · `AUDIO_CONVERTER_KEY` · `AUDIO_CONVERTER_URL` · `AUTH_PROVIDER` · `AUTH_TRUSTED_EMAIL_IDPS` · `BUDGET_STORE` ·
`CACHE_PROVIDER` · `CRON_SECRET` · `COGNITO_ADMIN_ACCESS_KEY_ID` · `COGNITO_ADMIN_SECRET_ACCESS_KEY` ·
`COGNITO_ADMIN_SESSION_TOKEN` · `COGNITO_CLIENT_ID` · `COGNITO_CLIENT_SECRET` · `COGNITO_REGION` · `COGNITO_USER_POOL_ID` ·
`DATABASE_OWNER_URL` · `DATABASE_POOL_MAX` · `DATABASE_SSL` · `DATABASE_SSL_CA` ·
`DATABASE_STATEMENT_TIMEOUT_MS` · `DATABASE_URL` · `DELEGATION_JWT_PRIVATE_KEY` · `DELEGATION_JWT_PUBLIC_KEY` · `DEPLOYMENT_HOST` ·
`E2E_IN_MEMORY_STORES` · `E2E_TEST_DOUBLE_AUTH` · `EFFECT_LEDGER` · `EMBEDDING_PROVIDER` ·
`ERASURE_HASH_KEY` · `ERASURE_HASH_KEY_PREVIOUS` · `ERROR_REPORTER` · `GIT_COMMIT_SHA` · `GOOGLE_API_KEY` · `GUEST_TOKEN_SECRET` · `GUEST_USAGE_STORE` ·
`JOBS_WORKER_INTERVAL_SECONDS` · `JOBS_WORKER_ONCE` · `JOBS_WORKER_TIMEOUT_MS` · `JOBS_WORKER_URL` · `JOB_STORE` ·
`LOG_LEVEL` · `MODERATION_STORE` · `NEXT_PUBLIC_AUTH_PROVIDER` · `NEXT_PUBLIC_COGNITO_CLIENT_ID` ·
`NEXT_PUBLIC_COGNITO_HOSTED_UI_DOMAIN` · `NEXT_PUBLIC_COGNITO_REGION` ·
`NEXT_PUBLIC_COGNITO_USER_POOL_ID` · `NEXT_PUBLIC_GOOGLE_API_KEY` ·
`NEXT_MANUAL_SIG_HANDLE` · `NEXT_PUBLIC_SUPABASE_URL` · `NODE_ENV` · `OPENAI_API_KEY` · `PROPOSAL_STORE` · `PROVENANCE_SIGNING_KEY` · `PROVENANCE_SIGNING_KEY_PREVIOUS` · `RATE_LIMIT_STORE` ·
`REALTIME_PROVIDER` · `REFRESH_COOKIE_KEY` · `REFRESH_COOKIE_KEY_PREVIOUS` · `REVIEW_QUEUE_STORE` · `SENTRY_DSN` · `SHUTDOWN_DRAIN_SECONDS` ·
`SHUTDOWN_TIMEOUT_SECONDS` · `SOCIAL_STORE` · `SONG_ID_PROVIDER` ·
`SSO_PROVIDERS` · `STRIKE_STORE` · `STT_PROVIDER` · `SUPABASE_SERVICE_ROLE_KEY` · `SUPABASE_URL` · `TENANCY_MODE` ·
`TENANT_DIRECTORY_STORE` · `TENANT_HOST_HEADER` · `TENANT_ID` · `TRAJECTORY_STORE` ·
`TRANSLATION_PROVIDER` · `TRUSTED_PROXY_HOPS` · `TTS_PROVIDER` · `UPSTASH_REDIS_REST_TOKEN` ·
`UPSTASH_REDIS_REST_URL` · `VALKEY_CA_CERT` · `VALKEY_URL` · `VERCEL` · `VERCEL_GIT_COMMIT_SHA`

---

_Keep this reference in sync with `platform/providers/registry.ts` (provider defaults) and
`.env.example` (the copyable template). The docs-integrity test guards that every variable the
code reads appears here._
