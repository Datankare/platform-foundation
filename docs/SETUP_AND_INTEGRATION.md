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

- **Node.js** — a current LTS. (The CI pins specific action versions; match your local Node to
  the version the project's CI uses to avoid engine warnings.)
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

```bash
NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-key>
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
```

Then point the stores you want to persist at Supabase (they default to in-memory):

```bash
MODERATION_STORE=supabase
TRAJECTORY_STORE=supabase
PROPOSAL_STORE=supabase
BUDGET_STORE=supabase
EFFECT_LEDGER=supabase
APPROVAL_POLICY_STORE=supabase
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

```bash
AUTH_PROVIDER=cognito
NEXT_PUBLIC_AUTH_PROVIDER=cognito
NEXT_PUBLIC_COGNITO_USER_POOL_ID=<pool>
NEXT_PUBLIC_COGNITO_CLIENT_ID=<client>
COGNITO_REGION=<region>
COGNITO_USER_POOL_ID=<pool>
COGNITO_CLIENT_ID=<client>
AWS_REGION=<region>
```

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
2. Sign in through the auth flow.
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
- **Deletions are manual.** The sync adds and updates; it does **not** delete. If the platform
  renames or removes a file (e.g. splits a module into a directory), the corresponding stale
  file must be removed in the consumer on the sync branch before merging. Check for orphaned
  files after any platform refactor.

### Adopting a specific version

Consumers pin to a Platform Foundation release tag (e.g. `v2.0.0`) rather than a moving branch,
and bump deliberately. See [`RELEASE_NOTES.md`](RELEASE_NOTES.md) for what each release
contains and [`MIGRATION_v1_to_v2.md`](MIGRATION_v1_to_v2.md) when a major version introduces
breaking changes.

---

## 7. Where to go next

- [`ENV_REFERENCE.md`](ENV_REFERENCE.md) — every environment variable.
- [`AGENT_DELEGATION_GUIDE.md`](AGENT_DELEGATION_GUIDE.md) — building agents that act on a
  user's behalf.
- [`GENAI_ROADMAP.md`](GENAI_ROADMAP.md) — the capability map, shipped and forthcoming.
- `docs/adr/` — the architecture decisions behind each capability.
- [`PLATFORM_ARCHITECTURE.md`](PLATFORM_ARCHITECTURE.md) / [`AGENT_ARCHITECTURE.md`](AGENT_ARCHITECTURE.md) — how the pieces fit.
