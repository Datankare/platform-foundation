# Contributing to Platform Foundation

> **AI-Assisted Codebase:** This project was built in partnership with
> [Claude](https://claude.ai) by Anthropic as primary engineering partner.
> Architecture, code, tests, and documentation were developed collaboratively
> with Claude. New contributors are welcome to use AI tools in their workflow.

Welcome to Platform Foundation. This guide gets you from zero to productive as fast as possible.

---

## Prerequisites

Install these before you start:

| Tool | Version | Install |
| ------- | ---------- | ------------------------------------------------------------------------- | ----- |
| Node.js | 24.x | Via NVM (see below) |
| NVM | Latest | `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash` |
| Git | Any recent | Pre-installed on Mac |

### Install Node.js via NVM

```bash
nvm install 24
nvm use 24
nvm alias default 24
node --version  # should show v24.x.x
```

---

## Getting Started

### 1. Clone the repo

```bash
git clone https://github.com/Datankare/platform-foundation.git
cd platform-foundation
```

### 2. Install dependencies

```bash
npm install
```

### 3. Set up environment variables

```bash
cp .env.example .env.local
```

Open `.env.local` and fill in your API keys:

| Key                 | Where to get it                                          |
| ------------------- | -------------------------------------------------------- |
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys                         |
| `GOOGLE_API_KEY`    | console.cloud.google.com → APIs & Services → Credentials |

Google Cloud requires two APIs enabled on your key:

- Cloud Translation API
- Cloud Text-to-Speech API

### 4. Run the app

```bash
npm run dev
```

Open http://localhost:3000 — you should see the Platform Foundation UI.

### 5. Verify the pipeline works

Type "Hello, welcome to Platform Foundation!" and click Translate & Speak.
You should see and hear English, Hindi, and Spanish translations.

### 6. Run the tests

```bash
npm test
```

All tests should pass. If any fail, check your Node version and dependencies.

---

## Development Workflow

### Branch Strategy

```
main        ← production — PROTECTED, PRs required, CI must pass
staging     ← pre-production — auto-deploys to platform-foundation-staging.vercel.app
develop     ← integration — auto-deploys to platform-foundation-dev.vercel.app
feature/*   ← your work — branch from develop
fix/*       ← bug fixes — branch from develop (or main for hotfixes)
chore/*     ← maintenance — branch from develop
```

### Starting New Work

Always branch from `develop`:

```bash
git checkout develop
git pull origin develop
git checkout -b feature/your-feature-name
```

### Before You Commit

Run the full Layer 0 check:

```bash
npm run typecheck    # TypeScript — must be zero errors
npm run format       # Prettier — auto-fixes formatting
npm run lint         # ESLint — must be zero warnings
npm test             # Jest — all tests must pass
```

Or run them all at once:

```bash
npm run typecheck && npm run format && npm run lint && npm test
```

Everything must be green before you push.

### Commit Message Format

We use conventional commits:

```
type: short description

- Detail 1
- Detail 2

Tests: X passing
```

Types:

- `feat` — new feature
- `fix` — bug fix
- `chore` — maintenance, dependencies, config
- `docs` — documentation only
- `style` — formatting, no logic change
- `refactor` — code change, no feature or fix
- `test` — adding or updating tests

Examples from our history:

```
feat: add clear button with full test coverage
fix: enforce character limit in UI + add component behavior tests
chore: upgrade CI to Node.js 24, add .nvmrc
docs: add Technical Architecture Document v1.0
style: fix prettier formatting across all files
```

### Opening a Pull Request

1. Push your branch: `git push origin feature/your-feature-name`
2. Go to https://github.com/Datankare/platform-foundation/pulls
3. Click "New pull request"
4. Base: `develop` ← Compare: `feature/your-feature-name`
5. Title: follow the commit message format
6. Description: what changed and why
7. CI must go green before merge — no exceptions

---

## Project Structure

```
platform-foundation/
├── app/                     ← Next.js App Router: screens, and API routes under app/api/
│   ├── api/                 ← Route handlers, each wrapped in tenantRoute (ADR-053)
│   └── admin/               ← Admin console (tenant settings, operators' tenants console)
├── components/              ← React components (admin, auth, review dashboard, …)
├── hooks/                   ← React hooks
├── platform/                ← The foundation's modules, one folder each, with a README
│   ├── data/                ← The only database access: withTenantTx / withPlatformTx / withOwnerTx
│   ├── tenancy/             ← Tenant context, directory, operator service (ADR-053)
│   ├── auth/ admin/ moderation/ agents/ rate-limit/ errors/ providers/ …
├── lib/                     ← Small shared helpers (logger, fetchWithTimeout, sanitize, …)
├── shared/                  ← Types, config and UI utilities shared with consumers
├── messages/                ← Message catalog (errors.*, screens.*) — ADR-051
├── prompts/                 ← Versioned LLM prompts
├── supabase/migrations/     ← Numbered SQL migrations (applied in the SQL Editor)
├── scripts/                 ← Migration replay, monkey run, checks
├── __tests__/               ← Tests; __tests__/db runs against the replayed Postgres
├── docs/                    ← Architecture, operations, ADRs (docs/adr/), TASKS
└── .env.example             ← Environment variable template
```

### The Two-Layer Rule

Every file you create belongs to one of two layers:

**Platform layer** — consumer-agnostic, lives in `lib/`, `platform/`, `shared/`
**Application layer** — consumer-specific, lives in consumer repos (not in PF)

Before adding any code, ask: _"Is this platform-level or application-level?"_
If you're unsure, read ADR-001.

---

## Testing

### Running Tests

```bash
npm test                  # Run all tests
npm run test:watch        # Watch mode — re-runs on file change
npm run test:coverage     # With coverage report
npm run typecheck         # TypeScript type checking
npm run lint              # ESLint
npm run format:check      # Prettier check (no writes)
npm run format            # Prettier fix (auto-writes)
```

### Test Layers

| Layer   | What                               | Speed    |
| ------- | ---------------------------------- | -------- |
| Layer 0 | TypeScript + ESLint + Prettier     | < 30s    |
| Layer 1 | Unit tests — pure logic            | < 2 min  |
| Layer 2 | Component behavior tests           | < 2 min  |
| Layer 3 | Integration tests (coming Phase 2) | < 15 min |
| Layer 4 | E2E tests (coming Phase 2)         | < 30 min |

### The Continuous Confidence Standard

- A feature is not done until its tests are done
- Green main always — never merge a failing test
- Every bug gets a regression test before it gets a fix
- Flaky tests are bugs — fix them immediately, never mute them
- Every test category validates adversarially (below)

### Adversarial Validation — a core tenet

Tests that only confirm specified behaviour prove what the system does; they do not prove what it
refuses. In October 2026 a moderator could make themselves `super_admin` through the AI command bar,
and role changes left no audit record, while every unit, integration and end-to-end test passed: the
route tests stubbed the admin guard, a self-elevation check was tested but never called, and no test
ever acted as the wrong role (TASK-145, learning 116). From that point, **every category of test** —
unit, component, integration, conformance kits, end-to-end, prompt evals and load tests — is written
with its hostile counterpart, at the time it is written:

| #   | Practice                    | What the tests must do                                                                                                                                                                              |
| --- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Abuse cases per actor       | Each actor — anonymous, guest, user, moderator, safety approver, admin, agent, another tenant — attempts what it must not do; the test asserts the refusal and that nothing changed.                |
| 2   | Every second path           | An effect reachable by more than one path (route, AI command bar, agent tool, job, database function) is tested on every path with the same expectations.                                           |
| 3   | Hostile and generated input | Malformed, oversized, wrong-typed, filter and SQL syntax, prompt injection, internal URLs (SSRF), control characters — generated (property-based with `fast-check`, fuzzing), not only hand-picked. |
| 4   | Monkey sequences            | Random actors performing random actions, with invariants checked after every step: no uncoded 5xx, no privilege change, no other user's or tenant's data, coded errors only, limits hold.           |
| 5   | Real guards, real stores    | A test that asserts authorization never stubs the guard it asserts; privileged and data-isolation paths run against a database that evaluates filters, and against real Postgres (TASK-146).        |
| 6   | Injected failure            | Each dependency errors, times out or partly writes; the system fails closed, records what happened, and a security-relevant write that fails fails the action.                                      |
| 7   | Findings become tests       | Every review, audit or incident finding ships with the executable test that would have caught it, so its protection outlives the review.                                                            |
| 8   | No unused security code     | A guard, check or rule that nothing calls is a failure, not a safeguard.                                                                                                                            |

**Enforcement.** CI runs the authorization matrix (every route and command-bar action mapped to its
permission), the per-role abuse suite with real guards, the no-unused-security-code check, and — on every
promotion PR and weekly — the fuzz and monkey job against the production build (`fuzz.yml`); the
sustainability checklist (A9, B11) and the L15 sprint-close review ask for the hostile cases explicitly;
each release and each phase close has an independent adversarial review by agents that did not build
the code ([docs/audits/BRIEF.md](docs/audits/BRIEF.md)). The full list, the cadence and what is not yet
done: [docs/ASSURANCE.md](docs/ASSURANCE.md). A change that adds behaviour without its hostile tests is
not done.

---

## Governing Principles

All code must honor these five principles. Read the ADRs for full detail.

| Principle                      | Meaning                                                              | ADR     |
| ------------------------------ | -------------------------------------------------------------------- | ------- |
| **RAMPS**                      | Reliability · Accessibility · Manageability · Performance · Security | ADR-004 |
| **AAA**                        | Authentication · Authorization · Analytics                           | ADR-004 |
| **Foundation as Fabric**       | Infrastructure woven in — never bolted on                            | ADR-004 |
| **Continuous Confidence**      | Green means nothing is broken — anywhere                             | ADR-004 |
| **Platform-First Abstraction** | Every capability evaluated for PF before building in a consumer      | ADR-001 |

### Platform-First Abstraction Rule

Before building any capability in a consumer repo, ask:

> _"Does the generic abstraction belong in platform-foundation?"_

If yes, build the abstraction in PF first — with interfaces, documentation, and
instructions for how consumers extend it. Then build the consumer-specific
implementation on top. This is the auth/Cognito pattern applied everywhere:

| PF provides                                    | Consumer provides                     |
| ---------------------------------------------- | ------------------------------------- |
| Auth provider interface + RBAC + permissions   | Cognito concrete provider             |
| Moderation middleware + blocklist + classifier | App-specific blocklist patterns       |
| AI orchestrator + prompt registry              | App-specific prompts and AI behavior  |
| WebSocket engine + room abstractions           | App-specific room types and protocols |
| Application framework + lifecycle              | Concrete application implementation   |
| Token budgets + cost attribution               | Subscription plans and pricing        |

PF must remain **consumer-agnostic** — no consumer-specific code, terminology,
or business logic in PF. PF uses "user" not "player", "application" not "game".

---

## Environments

| Environment | URL                                    | Branch  | Purpose        |
| ----------- | -------------------------------------- | ------- | -------------- |
| Local       | localhost:3000                         | any     | Your machine   |
| Dev         | platform-foundation-dev.vercel.app     | develop | Integration    |
| Staging     | platform-foundation-staging.vercel.app | staging | Pre-production |
| Production  | platform-foundation-inky.vercel.app    | main    | Live           |

---

## Security Debt

Known deferred items are tracked in `docs/SECURITY_DEBT.md`.
Before starting any work, check this file. Never add to it silently —
every deferral must be documented with a resolution plan.

---

## Getting Help

1. Read the relevant ADR in `docs/adr/`
2. Read the TAD at `docs/TAD.md`
3. Check `docs/SECURITY_DEBT.md` for known issues
4. Ask — no question is too small

---

_Platform Foundation — Foundation as Fabric · Continuous Confidence_
_Confidential & Proprietary — Datankare_

## Engineering Standards Checklist (Required for Every PR)

Every pull request must pass this checklist before merge. This prevents
the accumulation of sustainability debt.

**Single Source of Truth (Standard 5: Redundancy)**

- [ ] No hardcoded numbers in routes or components — all limits from shared/config/limits.ts
- [ ] No duplicated utility functions — check shared/config/apiKeys.ts before adding a new key getter
- [ ] Grep for existing implementations before adding a new utility

**Function/Component Size (Standard 8: SRP)**

- [ ] No function exceeds 200 lines (ESLint max-lines-per-function enforces this)
- [ ] If a component has more than 5 useState hooks, consider extracting custom hooks
- [ ] Each file has a single clear responsibility

**Error Handling (Standard 7: Resilience)**

- [ ] Error handling is fail-CLOSED, not fail-open (when in doubt, reject)
- [ ] Every error path has a test
- [ ] Every unlikely path has a test (unexpected response types, null, undefined)

**Logging Pattern (Standard 5: Auditability)**

- [ ] Every API route: generateRequestId() at top, logger.request() on entry, logger.response() on each exit
- [ ] Timing: const start = Date.now() at top, Date.now() - start on each exit
- [ ] No console.log/error/warn — use logger exclusively

**Configuration**

- [ ] New configurable values added to shared/config/limits.ts
- [ ] New API keys accessed via shared/config/apiKeys.ts
- [ ] No inline magic numbers

## Sprint & Phase Sustainability Gate (22-Point Combined Checklist)

This gate runs at the end of every sprint AND every phase boundary.
No sprint or phase is declared complete until all items pass or are
formally deferred with justification.

### Part A — Professional Engineering Standards Matrix (11 points)

1. Naming — Intent-based names, no generic names (data, info, x)
2. Documentation — Comments explain why, not what. ADR references where applicable
3. Placement — Variables declared near use, constants at module top
4. Control Flow — Guard clauses, early returns, no more than 2 levels of nesting
5. Redundancy — No duplicated logic. Shared config for repeated values
6. Formatting — Prettier + ESLint clean, zero warnings, automated in CI
7. Error Handling — Fail-closed, structured logging, every error path tested, nothing swallowed
8. SRP — No function over 200 lines, single responsibility, hooks extracted at 5+ useState
9. Testing — All paths tested including unlikely ones, coverage thresholds met
10. State/Immutability — No direct mutation, pure functions preferred, explicit side effects
11. Performance — No N+1 patterns, parallel where possible, timeouts on external calls

### Part B — Generated Code Engineering Principles (11 points)

1. Nesting depth — One level deep where possible. Two levels require justification
2. Loop/retry caps — Every loop, poll, retry has a maximum. What happens when we hit it?
3. Resource cleanup — Follow every exit path. Confirm it closes what it opened
4. Function length — No function longer than 40-60 lines. Decompose upfront
5. Input validation — Preconditions before, postconditions after. Assumptions visible and loud
6. Empty catch blocks — Every error logged, raised, or explicitly returned. Nothing swallowed
7. Module-level state — Scope locally, pass dependencies explicitly, data flow visible
8. Side effect separation — Pure computation vs side-effectful operations clearly separated
9. Abstraction depth — Can this be written more directly? Linear over elegant
10. Linting/static analysis — In CI, failing on violations, set up before code not after
11. Edge case tests — Tests force reasoning about failure modes

### Process

- Run both matrices against all code changed in the sprint
- Rate findings: Critical, High, Medium, Low
- Critical/High: must fix before sprint ships
- Medium: fix or formally defer with justification + phase assignment + debt entry
- Low: track, fix opportunistically
- Generate updated sustainability report with sprint results
- No sprint is complete until the gate passes

## Security Checklist (Required for Every PR)

Every pull request must pass this checklist before merge. See ADR-009 for details.

**API Credentials (OWASP A02)**

- [ ] No API keys in URL query parameters (`?key=`)
- [ ] Google APIs use `X-Goog-Api-Key` header only
- [ ] Anthropic API key injected via SDK constructor from `process.env`

**Input Sanitization (OWASP A03)**

- [ ] All user text passes `sanitizeForPrompt()` before embedding in LLM prompts
- [ ] Language codes pass `sanitizeLanguageCode()` before use in API calls

**Structured Logging (OWASP A09)**

- [ ] Every new API route imports `logger` from `@/lib/logger`
- [ ] No `console.error`, `console.log`, or `console.warn` in API routes or lib/
- [ ] Error logs include `requestId`, `route`, and `error` fields
- [ ] No sensitive data (API keys, user content, PII) in any log entry

**Security Configuration (OWASP A05)**

- [ ] New routes do not expose internal state or API key presence
- [ ] next.config.ts security headers are not weakened

**Testing**

- [ ] New API routes have tests verifying no `?key=` in URLs
- [ ] Coverage thresholds still pass after changes (`npm run test:coverage`)

**Security Debt**

- [ ] Any deferred security item is logged in `docs/SECURITY_DEBT.md`

---
