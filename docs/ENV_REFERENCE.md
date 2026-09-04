# Environment Variable Reference

Every environment variable Platform Foundation reads, why it exists, whether you need it, its
default, and its valid values. If you are standing the platform up for the first time, start
with [Minimum to run](#minimum-to-run); reach for the full tables when you switch a provider
from its mock default to a real one.

Platform Foundation follows one rule everywhere: **every external dependency is a swappable
provider, and every provider defaults to a safe in-memory or mock implementation.** That means
the platform boots and every test passes with _no_ configuration at all — you only set a
variable when you want to connect a real backend (a database, an LLM, an auth system). Nothing
fails closed for lack of a key at boot; a provider you did not configure simply serves its
mock. This is what makes local development and CI frictionless, and it is why the tables below
lean heavily on "optional — defaults to mock."

> Security note, up front: variables prefixed `NEXT_PUBLIC_` are exposed to the browser by
> Next.js and must contain only non-secret values (public URLs, pool IDs, anon keys protected
> by row-level security). Everything else is server-side only. Never put a service-role key, an
> API secret, or a private signing key behind a `NEXT_PUBLIC_` name, and never commit a filled
> `.env.local`.

---

## Minimum to run

You can run the platform and the full test suite with **no environment variables** — every
provider falls back to a mock or in-memory implementation. This is the intended local/CI
default.

To do anything real you will typically set, at minimum:

```bash
# A real database (most features that persist need this)
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key   # server-side only

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

### Database — Supabase

| Variable                        | Required                             | Default                                  | Notes                                                                                                             |
| ------------------------------- | ------------------------------------ | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`      | When using any Supabase-backed store | —                                        | Project URL. Browser-safe.                                                                                        |
| `SUPABASE_URL`                  | Optional server-side alias           | falls back to `NEXT_PUBLIC_SUPABASE_URL` | Some server paths read the non-public name; set it if your host separates server config.                          |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | When using any Supabase-backed store | —                                        | Anon key. Browser-safe; row-level security enforces isolation.                                                    |
| `SUPABASE_SERVICE_ROLE_KEY`     | When using any Supabase-backed store | —                                        | **Server-side only.** Bypasses RLS; used for admin ops, migrations, background jobs. Never expose to the browser. |

Selecting any `*_STORE=supabase` (below) makes these three required.

### Logging

| Variable    | Required | Default | Values                                 |
| ----------- | -------- | ------- | -------------------------------------- |
| `LOG_LEVEL` | No       | `error` | `error` `warn` `info` `debug` `silent` |

### Runtime

| Variable   | Required            | Default | Notes                                                                                        |
| ---------- | ------------------- | ------- | -------------------------------------------------------------------------------------------- |
| `NODE_ENV` | No (set by tooling) | —       | `development` / `production` / `test`. Usually set by your host or test runner, not by hand. |

---

## Authentication

| Variable                                      | Required | Default | Values           |
| --------------------------------------------- | -------- | ------- | ---------------- |
| `AUTH_PROVIDER` / `NEXT_PUBLIC_AUTH_PROVIDER` | No       | `mock`  | `cognito` `mock` |

Selecting `cognito` requires the AWS Cognito settings. The `NEXT_PUBLIC_` variants are read by
the browser client; the non-prefixed ones by the server. Set both to the same value.

| Variable                           | Required                | Default | Notes                                                                                                     |
| ---------------------------------- | ----------------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_COGNITO_USER_POOL_ID` | With `cognito`          | —       | e.g. `us-east-1_ABC123`. Browser-safe.                                                                    |
| `NEXT_PUBLIC_COGNITO_CLIENT_ID`    | With `cognito`          | —       | App client ID. Browser-safe.                                                                              |
| `COGNITO_REGION`                   | With `cognito` (server) | —       | e.g. `us-east-1`.                                                                                         |
| `COGNITO_USER_POOL_ID`             | With `cognito` (server) | —       | Server-side pool id.                                                                                      |
| `COGNITO_CLIENT_ID`                | With `cognito` (server) | —       | Server-side client id.                                                                                    |
| `AWS_REGION`                       | With `cognito`          | —       | AWS region for the Cognito SDK.                                                                           |
| `ADMIN_DEV_BYPASS`                 | No                      | unset   | **Development only.** When set, bypasses admin permission checks for local work. Never set in production. |

---

## AI / LLM

| Variable             | Required                         | Default | Values                                                                                   |
| -------------------- | -------------------------------- | ------- | ---------------------------------------------------------------------------------------- |
| `AI_PROVIDER`        | No                               | `mock`  | `anthropic` `mock`                                                                       |
| `ANTHROPIC_API_KEY`  | With `anthropic`                 | —       | Powers safety classification, moderation, agent reasoning, and the admin AI command bar. |
| `OPENAI_API_KEY`     | With `EMBEDDING_PROVIDER=openai` | —       | Used only by the OpenAI embedding provider (RAG).                                        |
| `EMBEDDING_PROVIDER` | No                               | `mock`  | `openai` `mock`                                                                          |

---

## Language & voice providers

All default to `mock`; each real selection reads the shared `GOOGLE_API_KEY` (except song ID
and audio conversion, which have their own).

| Variable                                        | Required                   | Default | Values                                         |
| ----------------------------------------------- | -------------------------- | ------- | ---------------------------------------------- |
| `TRANSLATION_PROVIDER`                          | No                         | `mock`  | `google` `mock`                                |
| `TTS_PROVIDER`                                  | No                         | `mock`  | `google` `mock`                                |
| `STT_PROVIDER`                                  | No                         | `mock`  | `google` `mock`                                |
| `GOOGLE_API_KEY` / `NEXT_PUBLIC_GOOGLE_API_KEY` | With any `google` provider | —       | Shared Google Cloud key for translate/TTS/STT. |
| `SONG_ID_PROVIDER`                              | No                         | `mock`  | `acrcloud` `mock`                              |
| `ACRCLOUD_HOST`                                 | With `acrcloud`            | —       | e.g. `identify-us-west-2.acrcloud.com`.        |
| `ACRCLOUD_ACCESS_KEY`                           | With `acrcloud`            | —       |                                                |
| `ACRCLOUD_ACCESS_SECRET`                        | With `acrcloud`            | —       |                                                |
| `AUDIO_CONVERTER`                               | No                         | `mock`  | `ffmpeg-service` `passthrough` `mock`          |
| `AUDIO_CONVERTER_URL`                           | With `ffmpeg-service`      | —       | Endpoint of the conversion service.            |
| `AUDIO_CONVERTER_KEY`                           | With `ffmpeg-service`      | —       | Auth key for the conversion service.           |

---

## Caching & realtime

| Variable                   | Required                      | Default  | Values                                        |
| -------------------------- | ----------------------------- | -------- | --------------------------------------------- |
| `CACHE_PROVIDER`           | No                            | `memory` | `upstash` `memory`                            |
| `UPSTASH_REDIS_REST_URL`   | With `CACHE_PROVIDER=upstash` | —        | Upstash Redis REST endpoint.                  |
| `UPSTASH_REDIS_REST_TOKEN` | With `CACHE_PROVIDER=upstash` | —        | Upstash Redis REST token. Server-side secret. |
| `REALTIME_PROVIDER`        | No                            | `mock`   | `supabase` `mock`                             |

Selecting `CACHE_PROVIDER=upstash` requires the two `UPSTASH_REDIS_REST_*` variables. Selecting
`REALTIME_PROVIDER=supabase` reuses the Supabase connection variables above.

---

## Observability

| Variable         | Required      | Default | Values              |
| ---------------- | ------------- | ------- | ------------------- |
| `ERROR_REPORTER` | No            | `noop`  | `sentry` `noop`     |
| `SENTRY_DSN`     | With `sentry` | —       | Sentry project DSN. |

---

## Stores (persistence backends)

Each store selects between an in-memory implementation (default, ephemeral) and Supabase
(durable). Selecting `supabase` for any of these requires the three Supabase variables above.

| Variable                | Required | Default  | Values              |
| ----------------------- | -------- | -------- | ------------------- |
| `MODERATION_STORE`      | No       | `memory` | `supabase` `memory` |
| `SOCIAL_STORE`          | No       | `memory` | `supabase` `memory` |
| `APP_STATE_STORE`       | No       | `memory` | `supabase` `memory` |
| `TRAJECTORY_STORE`      | No       | `memory` | `supabase` `memory` |
| `BUDGET_STORE`          | No       | `memory` | `supabase` `memory` |
| `PROPOSAL_STORE`        | No       | `memory` | `supabase` `memory` |
| `EFFECT_LEDGER`         | No       | `memory` | `supabase` `memory` |
| `APPROVAL_POLICY_STORE` | No       | `memory` | `supabase` `memory` |

For anything agentic that must survive a restart (trajectories, budgets, proposals, the effect
ledger, the approval policy), set these to `supabase` in production. In-memory is correct for
tests and local exploration.

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
DELEGATION_JWT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n"
DELEGATION_JWT_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\nMIIB...\n-----END PUBLIC KEY-----\n"
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
`AI_PROVIDER` · `ANTHROPIC_API_KEY` · `APP_STATE_STORE` · `APPROVAL_POLICY_STORE` ·
`AUDIO_CONVERTER` · `AUDIO_CONVERTER_KEY` · `AUDIO_CONVERTER_URL` · `AUTH_PROVIDER` ·
`AWS_REGION` · `BUDGET_STORE` · `CACHE_PROVIDER` · `COGNITO_CLIENT_ID` · `COGNITO_REGION` ·
`COGNITO_USER_POOL_ID` · `DELEGATION_JWT_PRIVATE_KEY` · `DELEGATION_JWT_PUBLIC_KEY` ·
`EFFECT_LEDGER` · `EMBEDDING_PROVIDER` · `ERROR_REPORTER` · `GOOGLE_API_KEY` · `LOG_LEVEL` ·
`MODERATION_STORE` · `NEXT_PUBLIC_AUTH_PROVIDER` · `NEXT_PUBLIC_COGNITO_CLIENT_ID` ·
`NEXT_PUBLIC_COGNITO_USER_POOL_ID` · `NEXT_PUBLIC_GOOGLE_API_KEY` ·
`NEXT_PUBLIC_SUPABASE_ANON_KEY` · `NEXT_PUBLIC_SUPABASE_URL` · `NODE_ENV` · `OPENAI_API_KEY` ·
`PROPOSAL_STORE` · `REALTIME_PROVIDER` · `SENTRY_DSN` · `SOCIAL_STORE` · `SONG_ID_PROVIDER` ·
`STT_PROVIDER` · `SUPABASE_SERVICE_ROLE_KEY` · `SUPABASE_URL` · `TRAJECTORY_STORE` · `TRANSLATION_PROVIDER` ·
`TTS_PROVIDER` · `UPSTASH_REDIS_REST_TOKEN` · `UPSTASH_REDIS_REST_URL`

---

_Keep this reference in sync with `platform/providers/registry.ts` (provider defaults) and
`.env.example` (the copyable template). The docs-integrity test guards that every variable the
code reads appears here._
