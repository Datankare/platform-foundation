# Platform Foundation

> Production-grade Next.js application platform — GenAI-native, RAMPS, AAA, Continuous Confidence

A battle-tested foundation for building commercial SaaS products, internal tools,
and application platforms. Clone it, rename it, and start building on solid ground
from day one.

## What You Get

### Governing Principles (pre-wired)

- **RAMPS** — Reliability · Accessibility (WCAG 2.2) · Manageability · Performance · Security
- **AAA** — Authentication · Authorization · Analytics
- **Foundation as Fabric** — Infrastructure woven in, never bolted on
- **Continuous Confidence** — Full test suite, green means nothing is broken

### Infrastructure (ready to use)

- ✅ Next.js 16 + TypeScript strict + Tailwind CSS
- ✅ 5-layer CI/CD pipeline (GitHub Actions)
- ✅ Branch protection + PR workflow enforced
- ✅ Three-environment strategy (dev/staging/prod — Vercel)
- ✅ ESLint + Prettier — zero warnings out of the box
- ✅ Jest testing (39 tests passing)
- ✅ Lighthouse baseline: 97/100/100/100
- ✅ Security debt register
- ✅ Architecture Decision Records (ADRs 001-007)
- ✅ Technical Architecture Document (TAD)
- ✅ CONTRIBUTING.md — new developer onboarded in 15 minutes

### Reference Implementation (working spike)

- Voice + text input pipeline
- Multilingual translation (EN/HI/ES) via Google Translate
- Text-to-speech in 3 languages via Google Cloud TTS
- Content safety screening via Claude API (SFW enforcement, fail-closed)
- Character limit enforcement with full component behavior tests

### Monorepo Structure (scaffolded)

```
platform-foundation/
├── platform/          ← Shared infrastructure modules
│   ├── auth/
│   ├── realtime/
│   ├── voice/
│   ├── translation/
│   ├── moderation/
│   ├── monetization/
│   ├── analytics/
│   └── game-engine/
├── apps/              ← Your applications
├── shared/            ← Shared components, types, utils
├── infra/             ← Infrastructure as Code
├── docs/              ← ADRs, TAD, runbooks
└── prompts/           ← Versioned LLM prompts
```

## Quick Start

### Prerequisites

- Node.js 24 (via NVM: `nvm install 24 && nvm use 24`)
- Anthropic API key (console.anthropic.com)
- Google Cloud API key (Translation + TTS APIs enabled)

### Setup

```bash
git clone https://github.com/YOUR_ORG/YOUR_REPO.git
cd YOUR_REPO
npm install
cp .env.example .env.local
# Fill in your API keys in .env.local
npm run dev
```

Open http://localhost:3000 — the reference implementation should be running.

### Verify Everything Works

```bash
npm run typecheck    # Zero errors
npm run lint         # Zero warnings
npm run format:check # All formatted
npm test             # All tests passing
```

## Using This as a Template

1. Click **"Use this template"** on GitHub
2. Name your new repository
3. Clone and follow Quick Start above
4. Replace the reference implementation with your application
5. Update the ADRs with your own decisions
6. Update the TAD with your stack choices

## Included Documentation

| Document                | Purpose                                 |
| ----------------------- | --------------------------------------- |
| `docs/TAD.md`           | Technical Architecture Document         |
| `docs/adr/`             | Architecture Decision Records (001-007) |
| `docs/LIGHTHOUSE.md`    | Performance baseline                    |
| `docs/SECURITY_DEBT.md` | Known deferred items tracker            |
| `CONTRIBUTING.md`       | Developer onboarding guide              |

## API Keys Required

| Service          | Purpose                     | Get It                   |
| ---------------- | --------------------------- | ------------------------ |
| Anthropic Claude | Content safety, AI features | console.anthropic.com    |
| Google Cloud     | Translation + TTS           | console.cloud.google.com |

## Governing Principles

This foundation is built around four non-negotiable principles.
Read `docs/adr/ADR-004-four-governing-principles.md` for full detail.

---

_Platform Foundation — Datankare_
_Built with Foundation as Fabric · Continuous Confidence_

## Phase 1 Assessment

See [RAMPS Phase 1 Assessment](docs/RAMPS_PHASE1_ASSESSMENT.md) for the complete reliability, accessibility, maintainability, performance, and security report.
