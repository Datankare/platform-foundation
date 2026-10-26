# Setup & Integration Guide

This guide takes you from an empty machine to a running Platform Foundation, and then explains
how a downstream application ("a consumer") adopts the platform and stays in sync with it. It
is deliberately step-by-step and assumes no prior familiarity.

If you only want the variable list, see [`ENV_REFERENCE.md`](ENV_REFERENCE.md). If you are
building agents, read this, then [`AGENT_DELEGATION_GUIDE.md`](AGENT_DELEGATION_GUIDE.md).

---

## 1. What Platform Foundation is (and is not)

Platform Foundation is a **GenAI-native application platform** — a shared foundation of
governed capabilities (auth, safety, agents, moderation, an admin surface, a provider layer)
that downstream applications build on. It is not a deployed product on its own; it is inherited
by consumer applications, which add their own product code on top.

Two things follow from that:

- **You run it locally like any Next.js app**, and everything works with zero configuration
  because every external dependency defaults to a mock. You add real backends incrementally.
- **Consumers adopt it by inheritance + sync**, not by copying files. Platform code lives in
  `platform/**` and is kept current in each consumer via an automated sync (Section 6).

---

## 2. Prerequisites

- **Node.js** — 24, the version in `.nvmrc` and in CI; at least 22.12 (`engines` in
  `package.json`). The operator commands (`scripts/relink-identity.mjs`) run the platform's
  TypeScript directly and refuse older Node with exit 2. Check with `node -v`.
- **npm** — comes with Node.
- **A Supabase project** — only when you want durable storage (most real features). Free tier
  is fine to start.
- **Provider accounts** — only for the providers you switch on (Anthropic for AI, Google for
  language/voice, AWS Cognito for auth, etc.). None are needed to boot with mocks.

---

## 3. First run (zero configuration)

```bash
git clone <your-fork-or-template-of-platform-foundation>
cd platform-foundation
npm install
npm run dev
```

The app starts. Every provider is a mock, so nothing external is called. Run the test suite the
same way the platform gates itself:

```bash
npm run format:check   # formatting
npx tsc --noEmit       # types
npx eslint .           # lint
npx jest               # unit + integration tests
```

All green with no configuration is the expected baseline.

---

## 4. Turning on real backends

Create `.env.local` (never commit it) and add variables as you enable features. The pattern is
always **select a provider, then supply its credentials** — see
[`ENV_REFERENCE.md`](ENV_REFERENCE.md) for every variable, default, and valid value.

### 4a. A database (Supabase)

The stores reach the project's Postgres directly through `platform/data`, as the role
`app_tenant` under row-level security — not through the Supabase REST API. After applying the
migrations (4b), give `app_tenant` a password and take the two connection strings as
[`TENANCY_OPERATIONS.md`](TENANCY_OPERATIONS.md) §1 describes:

```bash
DATABASE_URL=postgresql://app_tenant.<project-ref>:<password>@<pooler-host>:6543/postgres
DATABASE_OWNER_URL=postgresql://postgres.<project-ref>:<db-password>@<pooler-host>:6543/postgres
DATABASE_SSL=verify-full
DATABASE_SSL_CA=<the project's CA certificate, one line with \n for each line break>
```

Then point the stores you want to persist at Postgres (they default to in-memory; `supabase` is
still accepted and selects the same store):

```bash
MODERATION_STORE=postgres
TRAJECTORY_STORE=postgres
PROPOSAL_STORE=postgres
BUDGET_STORE=postgres
EFFECT_LEDGER=postgres
APPROVAL_POLICY_STORE=postgres
```

### 4b. Apply migrations

The SQL schema lives in `supabase/migrations/`. Apply them to your Supabase project in order
(via the Supabase CLI or the SQL editor). Each migration is idempotent and self-records into an
`applied_migrations` table, so re-running is safe. Migrations that seed governed config (the
trusted-agent registry, the capability map, known-features) are consumer-owned; a consumer
applies the full set for the features it uses.

### 4c. A real LLM

```bash
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=<key>
```

This powers safety classification, moderation, agent reasoning, and the admin AI command bar.

### 4d. Real auth (Cognito)

The pool must have the shape the platform requires ([`ENV_REFERENCE.md`](ENV_REFERENCE.md#cognito-pool-shape-review-17-l2l4),
review 17 L2/L4): **users sign in by email address** (the pool's sign-in identifier is the email
address — fixed when the pool is created; a pool that signs in by username cannot refresh
sessions), and the app client is **confidential** (it has a secret) and may **read `identities`**
(readable attributes unset, or including `identities`).

```bash
AUTH_PROVIDER=cognito
NEXT_PUBLIC_COGNITO_USER_POOL_ID=<pool>
NEXT_PUBLIC_COGNITO_CLIENT_ID=<client>
COGNITO_CLIENT_SECRET=<the app client's secret>
GUEST_TOKEN_SECRET=$(openssl rand -base64 48)
ERASURE_HASH_KEY=$(openssl rand -hex 32)
REFRESH_COOKIE_KEY=$(openssl rand -hex 32)   # the refresh cookie's HMAC (review 17 M1)
```

The `COGNITO_*` aliases are accepted only when equal to the `NEXT_PUBLIC_` names; `AWS_REGION` is
not read. Check the pool shape (with the AWS CLI; readiness checks it too when the app has the
administrative credentials):

```bash
aws cognito-idp describe-user-pool --user-pool-id "$NEXT_PUBLIC_COGNITO_USER_POOL_ID" \
  --query UserPool.UsernameAttributes          # must include "email"
aws cognito-idp describe-user-pool-client --user-pool-id "$NEXT_PUBLIC_COGNITO_USER_POOL_ID" \
  --client-id "$NEXT_PUBLIC_COGNITO_CLIENT_ID" \
  --query UserPoolClient.ReadAttributes        # null, or must include "identities"
aws cognito-idp get-user-pool-mfa-config --user-pool-id "$NEXT_PUBLIC_COGNITO_USER_POOL_ID" \
  --query '[MfaConfiguration, SoftwareTokenMfaConfiguration.Enabled]' --output text   # OPTIONAL True
```

Staff need an authenticator app, so the pool must allow software-token MFA (`OPTIONAL`); set it
with `set-user-pool-mfa-config` as in
[`ENV_REFERENCE.md`](ENV_REFERENCE.md#cognito-pool-shape-review-17-l2l4).

### 4e. Agent delegation keys (if you use agents on-behalf-of users)

Generate an RS256 key pair and set `DELEGATION_JWT_PUBLIC_KEY` / `DELEGATION_JWT_PRIVATE_KEY` —
full instructions in
[`ENV_REFERENCE.md`](ENV_REFERENCE.md#agent-delegation-keys-rung-2-attested-delegation).
Without them, delegation is disabled and fails closed.

---

## 5. Verify a real setup

After configuring a database + LLM + auth:

1. `npm run build` — a production build must succeed (this catches SSR/prerender issues that
   dev mode hides).
2. Sign in through the auth flow. With Cognito, `curl -s <origin>/api/health/ready` answers
   `200` with the `identity-pool` check `healthy` (the pool's shape — §4d).
3. Hit `/api/agent/capabilities` — it returns the goals the platform exposes.
4. Open the admin surface and run a natural-language command (e.g. view the trusted-agent
   registry) — the prompt → plan → confirm → execute loop should round-trip.

---

## 6. How a consumer stays in sync with the platform

Consumers do not copy platform code — they **inherit** it and pull updates through an automated
sync.

- **Ownership boundary.** Files under `platform/**` (and the shared admin surface, provider
  registry, migrations that back platform features) are platform-owned. A consumer's own code
  lives elsewhere and is never overwritten.
- **The sync.** A scheduled/dispatchable workflow opens a pull request into the consumer's
  `develop` that brings platform-owned files up to a chosen Platform Foundation ref (usually
  `main`). The consumer reviews the diff and merges.
- **What the consumer keeps private.** A `.github/sync-config.json` `exclude` list names the
  files the consumer owns even if they share a path with the platform (its own agent
  vocabulary, product pages, product-specific tests). Those are never overwritten by the sync.
- **The consumer seams — always excluded, always the consumer's own.** The platform ships these
  empty or as templates; each holds facts only the consumer knows:

  | File                                                                                               | What the consumer puts there                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
  | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `platform/errors/app-codes.ts`, `messages/app/**`, `docs/APP_API_ERRORS.md`                        | Its own error codes and messages (ADR-051 D1)                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
  | `platform/route-policy/app-route-policy.ts`                                                        | Its own route guards, public or exempt routes (TASK-136), and its functions that make paid calls (`paidCalls`)                                                                                                                                                                                                                                                                                                                                                                                |
  | `platform/assurance/unwired-security.ts`                                                           | The security controls it has not wired, each with the reason (v5.0.0; checked by `security-wiring`)                                                                                                                                                                                                                                                                                                                                                                                           |
  | `docs/APP_ENV_REFERENCE.md`                                                                        | Its own settings and per-environment provider choices                                                                                                                                                                                                                                                                                                                                                                                                                                         |
  | `.gitleaksignore`                                                                                  | Its own secret-scan false positives. Each entry names a commit, so the platform's list can never match a consumer's history.                                                                                                                                                                                                                                                                                                                                                                  |
  | `coverage-baseline.json`, `screen-literal-baseline.json`                                           | Its own ratchet baselines, measured on its own tree                                                                                                                                                                                                                                                                                                                                                                                                                                           |
  | `platform/modules/app-modules.ts` (and its test, `platform/modules/__tests__/app-modules.test.ts`) | The product modules it runs with (ADR-054 D4) — none, some or all of social, voice, song-id, audio-convert, translation, games                                                                                                                                                                                                                                                                                                                                                                |
  | `platform/modules/app-home.tsx`                                                                    | What its home page shows inside the signed-in shell (`app/HomeClient.tsx`)                                                                                                                                                                                                                                                                                                                                                                                                                    |
  | `platform/modules/app-manifest.json`                                                               | Its own module manifest (TASK-157): its migration prefix (`app`), the paths it adds to a platform module (its routes, screens, hooks and tests that import the module), its own modules (`definition`, `entry`, `dependsOn`, the path lists, `migrations`) and the bare-numbered migrations it applied before the naming convention (`migrationsBeforeTheConvention`). The platform ships it empty; `scripts/module-manifest.cjs` merges it with the platform's `manifest.json` on every read |
  | `instrumentation.ts`                                                                               | Its boot: `registerModules(APP_MODULES)` before `initProviders()`, `listJobDefinitions()` (validates every job kind), each step recorded (`platform/observability/boot.ts`) so `/api/health/ready` can report it, and the probes into `initObservability` — the database and cache as `healthProbes`, realtime and the modules' as `degradedOnlyProbes` (ADR-056 D4). PF's own is the reference.                                                                                              |

- **Product modules (ADR-054).** The platform is a core plus optional modules; which files are
  each module's is in `platform/modules/manifest.json` (code, prompts and evals, routes,
  components, tests, kits, migrations). Until Sprint 7S adds the sync's `modules` selection, the
  sync copies every module; an app that does not use one leaves it out of `app-modules.ts`, and
  its slots, agents, prompts, features, goals and rules are then absent. The core's own tests pass
  with no module registered — `npm run test:core` runs them that way (CI does too); a module's
  tests, listed in the manifest, test the module as registered, so exclude them with a module you
  do not use. To drop a module's files entirely, exclude its manifest paths and delete them on the
  sync branch (the sync never deletes) — never a core file that imports it: the lint rule
  guarantees there is none outside the two composition roots, which are yours.
- **An app's own module files — the app manifest (TASK-157).** `platform/modules/manifest.json` is
  the platform's and is synced unchanged. Your files that belong to a platform module (a route
  that imports translation, a screen that imports song-id) and your own modules go in your
  `platform/modules/app-manifest.json`; every reader (the lint boundary, the manifest and boundary
  tests, `npm run test:core`, the migration replay) sees the two merged:

  ```json
  {
    "app": "playform",
    "modules": {
      "translation": {
        "routes": ["app/api/translate"],
        "tests": ["__tests__/translate-api.test.ts"]
      },
      "quiz": {
        "definition": "features/quiz/module.ts",
        "entry": "features/quiz/index.ts",
        "dependsOn": ["social"],
        "code": ["features/quiz"],
        "tests": ["__tests__/quiz.test.ts"],
        "migrations": ["supabase/migrations/052a_playform_quiz_scores.sql"]
      }
    },
    "migrationsBeforeTheConvention": []
  }
  ```

  To a platform module you add paths only (`code`, `prompts`, `evals`, `routes`, `components`,
  `tests`, `kits`, `migrations`); its `dependsOn`, `definition`, `entry` and `kitManifest` are the
  platform's. A new module declares all of them. The merge fails loudly — naming the file and what
  to change — on a path claimed by two modules (or by a module and a composition root), a platform
  module's dependencies redefined, an unknown list, an unknown dependency and a dependency cycle.
  It also refuses an entry that takes what is the platform's (review 7 H2): a migration listed in
  `supabase/platform-migrations.json`, anything under `platform/`, a file the platform ships
  (`platform/modules/platform-paths.json`, generated, synced unchanged) or a directory holding one —
  list your own files one by one. Your tables that hold no user's data go in `"noUserData"`
  (`{ "<table>": "<why>" }`); the others are erased by your deletion module, which your migration
  records in `deletion_manifest`. The user-data coverage test classifies your tables by these two
  declarations and fails on one you did not declare. The manifest tests derive the module ids from
  the merge, so your modules are checked like the platform's. `node scripts/module-manifest.cjs --check` runs the merge and the migration-name
  check on their own.

- **Your migrations never take a platform number (TASK-158).** The platform's are `NNN_<name>.sql`,
  listed in `supabase/platform-migrations.json`. Yours are **`NNN<letter>_<app>_<name>.sql`** —
  `052a_playform_subscription_tiers_record.sql` — which sorts after the platform's `052` and before
  `053`, so the replay applies it after the platform migration it builds on; a migration of one of your modules
  names the module next (`052a_playform_quiz_scores.sql` for module `quiz`). Set `"app"` in your app manifest. The replay, `migration-parity.mjs` and `applied_migrations`
  take the letter form as any other file. `migration-naming` (and the replay, before it applies
  anything) refuses an app migration with a bare number and says what to rename it to; one you
  already applied to your databases under a bare number stays as it is — list it in
  `migrationsBeforeTheConvention` (renaming an applied migration re-runs it).
- **A compliant sync (TASK-160).** [`docs/templates/sync-from-foundation.yml`](templates/sync-from-foundation.yml)
  and [`docs/templates/sync-config.json`](templates/sync-config.json) are the sync workflow and
  config to copy: every exclude anchored (`/package.json` for a root file, never `package.json`,
  which matches at any depth), and every input or step output a script uses passed through the
  step's `env:` and quoted (`"$SOURCE_REF"`), never written `${{ … }}` inside `run:`.
  `__tests__/workflow-hygiene.test.ts` checks both in your repository, and each failure names the
  file, the line and what to write instead.
- **Copy the version guard too (TASK-179).** The template's **Version guard** step runs
  `.github/scripts/sync-version-guard.sh` — copy it from
  [`docs/templates/sync-version-guard.sh`](templates/sync-version-guard.sh). If you adopt the
  platform from `develop` ahead of its release, the scheduled sync's source (`main`) can be older
  than what you have; the guard lets the sync proceed only for a strictly newer
  `PLATFORM_VERSION`, so the scheduled pull request never reverts your platform. Scheduled runs use
  the workflow on your default branch, so the guard protects them once it is promoted there.
- **Exclude only what you own or deliberately do not take** (learning 115). An excluded file must
  exist in the consumer, or be a platform file the consumer chose not to take. A file the consumer
  owns that is identical to the platform's should be inherited instead: excluding it silently stops
  platform fixes from reaching it.
- **Deletions are manual.** The sync adds and updates; it does **not** delete. If the platform
  renames or removes a file (e.g. splits a module into a directory), the corresponding stale
  file must be removed in the consumer on the sync branch before merging. Check for orphaned
  files after any platform refactor.

### Assurance comes with the sync

The platform's hostile checks are synced files, and they scan the **consumer's** routes and modules too:
every route verified, rate limited, quota-counted when it makes a paid call, reading JSON safely and
encoding REST filter values; no test stubbing the admin guard; every security control wired or
registered; no security module hidden from coverage. The fuzz and monkey workflow runs against the
consumer's own production build. Treat a failure in a synced check as a finding in your code, not a
check to exclude — excluding it removes the protection it gives you. What runs and when:
[ASSURANCE.md](ASSURANCE.md).

### Adopting a specific version

Consumers pin to a Platform Foundation release tag (e.g. `v2.2.0`) rather than a moving branch,
and bump deliberately. See [`RELEASE_NOTES.md`](RELEASE_NOTES.md) for what each release
contains and the migration guide for each major version that introduces breaking changes — the
latest is [`MIGRATION_v5_to_v6.md`](MIGRATION_v5_to_v6.md).

### Dependencies: what you own, what you inherit

Your `package.json` and lockfile are **yours** — the sync never overwrites them (they are on
your `exclude` list). But adopting Platform Foundation brought its dependencies into your tree, so
many of the packages you depend on originate upstream. That gives one file two update streams:

- **Your own Dependabot** (or equivalent), patching your dependencies on your security timeline.
- **The platform sync**, which delivers the platform's versions of the packages it uses.

These can collide — your Dependabot may bump `next` on Monday; the next sync may deliver a
different `next`. Neither is wrong; **merge order is the thing to get right**:

1. **Merge an open platform-sync PR before your own dependency PRs.** For a package the platform
   also uses, it is the upstream of record; rebasing your bump on top then either drops as
   redundant or surfaces a real delta to resolve deliberately.
2. **For a package the platform also uses, prefer the platform's version** unless you have a
   specific reason to diverge. Pinning ahead of the platform means running a version it does not
   test against.
3. **For a package only your app uses,** you own it outright — bump on your own schedule; the
   sync never touches it.
4. **If a security fix is urgent and the platform has not shipped it,** bump it yourself and carry
   the delta; the next sync reconciles once the platform catches up.

If you would rather your Dependabot not raise PRs for platform-owned packages at all, that is a
valid choice — but it couples your security posture to the platform's release cadence. Running
your own and reconciling per the order above keeps you independent.

---

## 7. Where to go next

- [`ENV_REFERENCE.md`](ENV_REFERENCE.md) — every environment variable.
- [`ASSURANCE.md`](ASSURANCE.md) — Adversarial Validation: the checks, the cadence, and the gaps.
- [`AGENT_DELEGATION_GUIDE.md`](AGENT_DELEGATION_GUIDE.md) — building agents that act on a
  user's behalf.
- [`GENAI_ROADMAP.md`](GENAI_ROADMAP.md) — the capability map, shipped and forthcoming.
- [`KNOWLEDGE_BASES.md`](KNOWLEDGE_BASES.md) — knowledge bases: isolation levels, scoping, and bringing your own store.
- `docs/adr/` — the architecture decisions behind each capability.
- [`PLATFORM_ARCHITECTURE.md`](PLATFORM_ARCHITECTURE.md) / [`AGENT_ARCHITECTURE.md`](AGENT_ARCHITECTURE.md) — how the pieces fit.
