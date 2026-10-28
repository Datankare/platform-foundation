# CLAUDE.md — platform-foundation

Loaded by every agent working or reviewing here. Kept short; the detail is in the docs it points to.

## What this is

A Next.js application platform that apps (Playform first) take by sync: identity and access,
tenancy, governed AI and agents, moderation, jobs, observability. It is pre-launch: no
deployment of its own serves users. Map: [docs/README.md](docs/README.md); architecture:
[docs/TAD.md](docs/TAD.md); the assurance model: [docs/ASSURANCE.md](docs/ASSURANCE.md); how a
change is reviewed: [docs/AI_ENGINEERING.md](docs/AI_ENGINEERING.md) and [REVIEW.md](REVIEW.md).

## Stack

Next.js 16 (App Router), React 19, TypeScript; Node `>=22.12` (CI uses 24). Postgres (Supabase
hosted) reached directly through `platform/data` with `pg`; Amazon Cognito for identity; Valkey
or Upstash for the shared cache; Jest with ts-jest; Semgrep, CodeQL and gitleaks in CI.

## Conventions

- **Platform first:** a capability is built here as a generic abstraction; an app adds its own
  implementation through the consumer seams ([SETUP_AND_INTEGRATION](docs/SETUP_AND_INTEGRATION.md) §6).
- **Data:** only `platform/data` reaches Postgres; values are bound parameters, never SQL text;
  every route handler runs in its tenant scope (`tenantRoute`). The tests in ASSURANCE §2 hold this.
- **Errors and text:** every refusal is a coded error from the catalog
  ([API_ERRORS](docs/API_ERRORS.md), generated); every word on a screen comes from `messages/`.
- **Registers:** work and defects go in [TASKS](docs/TASKS.md), deferred security items in
  [SECURITY_DEBT](docs/SECURITY_DEBT.md), every new doc in the [docs index](docs/README.md).

## Standing rules

- **Branches:** develop → staging → main. The owner promotes, in the GitHub GUI. An agent never
  pushes to staging or main, merges, or approves.
- **Secrets:** never display, request or echo a secret. A value the owner must enter goes into a
  hidden prompt (`read -rs`), never a chat or a command line.
- **Commands are zsh-paste-safe:** no `#` comment lines, no unquoted parentheses or `!`, one
  step at a time, each with the command that checks it worked.
- **Every change ships with hostile tests** — abuse per role, second paths, malformed and
  hostile input, injected failure ([CONTRIBUTING](CONTRIBUTING.md), Adversarial Validation).
- **Every refusal has a screen:** a code a route can return is handled by its callers' screens
  (`__tests__/refusal-coverage.test.ts`; the baseline may only shrink).
- **Migrations** are applied by the owner in the Supabase SQL Editor, from the files in
  `supabase/migrations/`; each replays cleanly twice (`scripts/migration-replay.sh`).
- **No hand edits of data.** The one exception is the documented first-super-admin bootstrap
  ([ADR-013](docs/adr/ADR-013-role-hierarchy.md): `super_admin` is assigned in the database only).
- **Verify before claiming.** Show the command and its output; say plainly what was not run.
- **Match effort to stakes.** The platform is pre-launch: before building new machinery, ask
  whether the problem matters now, and say what the simpler path would be.

## Non-goals

- Not an app: the screens here are reference implementations for apps to adopt or replace.
- No deployment of its own: it is proven in CI and through the apps that deploy it
  ([ASSURANCE](docs/ASSURANCE.md) §6).
- No feature built for a single app: an app's own behaviour lives in the app.

## Before handing a change to the owner

Run the per-change review protocol ([AI_ENGINEERING](docs/AI_ENGINEERING.md) §3) at the depth
its risk tier sets (`node scripts/risk-tier.mjs --base origin/develop`), then the gates:

```zsh
npm run format:check && npm run typecheck && npx eslint . --max-warnings 0 && npm test
node scripts/module-manifest.cjs --check
```
