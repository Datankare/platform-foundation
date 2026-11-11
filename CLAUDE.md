# CLAUDE.md — platform-foundation

Loaded by every agent working or reviewing here. Kept short; the detail is in the docs it points to.

## What this is

A Next.js application platform that apps (Playform first) take by sync: identity and access,
tenancy, governed AI and agents, moderation, jobs, observability; pre-launch, with no deployment of
its own. Map: [docs/README.md](docs/README.md); architecture: [TAD](docs/TAD.md); assurance:
[ASSURANCE](docs/ASSURANCE.md); review: [AI_ENGINEERING](docs/AI_ENGINEERING.md), REVIEW.md.

## Stack

Next.js 16 (App Router), React 19, TypeScript; Node `>=22.12` (CI uses 24). Postgres (Supabase
hosted) reached directly through `platform/data` with `pg`; Amazon Cognito for identity; Valkey
or Upstash for the shared cache; Jest with ts-jest; Semgrep, CodeQL and gitleaks in CI.

## Conventions

- **Platform first:** a capability is built here as a generic abstraction; an app adds its own
  implementation through the consumer seams ([SETUP_AND_INTEGRATION](docs/SETUP_AND_INTEGRATION.md) §6).
- **Data:** only `platform/data` reaches Postgres; values are bound parameters, never SQL text;
  every route handler runs in its tenant scope (`tenantRoute`). The tests in ASSURANCE §2 hold this.
- **Errors and text:** every refusal is a coded error ([API_ERRORS](docs/API_ERRORS.md), generated);
  every screen word comes from `messages/` and a caught error's text is only logged — except the
  sites in `screen-literal-baseline.json` (R-75) and the `platform/` dirs R-77's guard skips yet.
- **Registers:** work and defects go in [TASKS](docs/TASKS.md), deferred security items in
  [SECURITY_DEBT](docs/SECURITY_DEBT.md), every new doc in the [docs index](docs/README.md).
- **Width:** code is formatted by Prettier at its `printWidth` (`.prettierrc`); comments and
  Markdown prose, which Prettier leaves as written, wrap at 100 characters — except a line that
  is one command, URL or table row, kept whole.

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
- **No hand edits of data** but the documented first-super-admin bootstrap (ADR-013) and, in
  TENANCY_OPERATIONS, first safety approver, second super admin, reconciling the migration record.
- **Verify before claiming.** Show the command and its output; say plainly what was not run.
- **Match effort to stakes.** The platform is pre-launch: before building new machinery, ask
  whether the problem matters now, and say what the simpler path would be.

## The engineering process — enforced, not optional (TASK-200)

CI fails on each; REVIEW.md blocks on the rest ([AI_ENGINEERING](docs/AI_ENGINEERING.md) §3a).

- **Design check first.** A commit (or a merge's own change) touching `platform/`, `app/`, `lib/`,
  `components/`, `hooks/`, `proxy.ts`, workflows or the check's files ends its subject with its
  task group, `(TASK-nnn)` — a `TASK-nnn` elsewhere names nothing; a pushed one is adopted by a
  `**Commits:** <sha>` line — and edits that [TASKS](docs/TASKS.md) entry: **Design check**,
  **Self-review** and, when it touches a high-tier path ([risk-tiers](scripts/risk-tiers.json)
  `high`, and always `.github/`, CLAUDE.md, REVIEW.md, `.gitattributes`, the risk tiers and the
  check's files), a **Threat model** (`scripts/process-check.mjs`).
- **Callers move with a response;** an error status is the registry's. **Screen tests** answer
  fetch from `__tests__/fixtures/route-responses`, not bodies written by hand. **Bodies** are read
  with `readJsonBody(request, SCHEMA)`. **Route tests** carry `[hostile:role]`, `[hostile:self]`,
  `[hostile:store-down]`, `[hostile:id-spelling]` in test titles, or a reasoned waiver. **Every
  guard** is `@guard` with a `[self-test]` that runs its scan. **Baselines** never rise.
- **Review of a gate** (REVIEW.md 18–24): threat model before code, naming only actors that exist
  (one owner pushes; a finding needing an absent actor is out of scope); three lenses with coverage
  tables; fix the class; attack your fix; `npm run test:mutation` by hand (≥90%); stop when clean.

## Non-goals

- Not an app: the screens here are reference implementations for apps to adopt or replace.
- No deployment of its own: proven in CI and in the apps ([ASSURANCE](docs/ASSURANCE.md) §6).
- No feature built for a single app: an app's own behaviour lives in the app.

## Before handing a change to the owner

Run the per-change review protocol ([AI_ENGINEERING](docs/AI_ENGINEERING.md) §3) at the depth
its risk tier sets (`node scripts/risk-tier.mjs --base origin/develop`); walk an admin change in a
browser on a production build first (REVIEW.md 25); then the gates:

```zsh
npm run format:check && npm run typecheck && npm run lint && npm run test:db -- --full
node scripts/module-manifest.cjs --check
node scripts/process-check.mjs --base origin/develop
```
