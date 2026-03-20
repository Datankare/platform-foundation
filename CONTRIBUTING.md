# Contributing to Platform Foundation

Welcome to Platform Foundation. This guide gets you from zero to productive as fast as possible.

---

## Prerequisites

Install these before you start:

| Tool    | Version    | Install                                                                   |
| ------- | ---------- | ------------------------------------------------------------------------- | ----- |
| Node.js | 24.x       | Via NVM (see below)                                                       |
| NVM     | Latest     | `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash` |
| Git     | Any recent | Pre-installed on Mac                                                      |

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
├── app/                     ← Next.js App Router
│   ├── api/                 ← API routes (serverless functions)
│   │   ├── health/          ← GET /api/health
│   │   └── process/         ← POST /api/process
│   ├── layout.tsx           ← Root layout
│   └── page.tsx             ← Home page
├── components/              ← React components
│   └── SpikeApp.tsx         ← Main UI component
├── lib/                     ← Pure business logic (testable, no JSX)
│   ├── safety.ts            ← Claude API content moderation
│   ├── translate.ts         ← Google Translate integration
│   ├── tts.ts               ← Google Cloud TTS integration
│   └── inputValidation.ts   ← Input validation logic
├── types/                   ← Shared TypeScript types
├── __tests__/               ← Unit and component tests
├── docs/                    ← Architecture docs
│   ├── adr/                 ← Architecture Decision Records
│   ├── TAD.md               ← Technical Architecture Document
│   └── SECURITY_DEBT.md     ← Known deferred security items
├── prompts/                 ← Versioned LLM prompts (coming Phase 3)
└── .env.example             ← Environment variable template
```

### The Two-Layer Rule

Every file you create belongs to one of two layers:

**Platform layer** — game-agnostic, lives in `lib/`, `platform/` (coming), `shared/`
**Game layer** — game-specific, lives in `games/app-01/` (coming)

Before adding any code, ask: _"Is this platform-level or game-level?"_
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

---

## Governing Principles

All code must honor these four principles. Read the ADRs for full detail.

| Principle                 | Meaning                                                              | ADR     |
| ------------------------- | -------------------------------------------------------------------- | ------- |
| **RAMPS**                 | Reliability · Accessibility · Manageability · Performance · Security | ADR-004 |
| **AAA**                   | Authentication · Authorization · Analytics                           | ADR-004 |
| **Foundation as Fabric**  | Infrastructure woven in — never bolted on                            | ADR-004 |
| **Continuous Confidence** | Green means nothing is broken — anywhere                             | ADR-004 |

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
