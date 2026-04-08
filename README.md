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

### Identity & Access (Phase 1 — complete)

- ✅ Auth provider abstraction (Cognito-ready, pluggable to any IdP)
- ✅ RBAC permissions engine with role inheritance
- ✅ Entitlements engine (time-bounded grants)
- ✅ User profiles with per-field visibility (private/friends/public)
- ✅ COPPA age verification + parental consent schema
- ✅ GDPR: data export, cascading deletion, guest lifecycle
- ✅ Platform config table (runtime key-value settings)
- ✅ super_admin role separation + anti-self-elevation guard
- ✅ Admin UI with GenAI-native command bar
- ✅ Rate limiting (per-IP sliding window)
- ✅ Password policy (12 char, rotation, history)
- ✅ Immutable audit log
- ✅ CognitoAuthProvider (full AuthProvider implementation, fetch-based)
- ✅ Auth routing (/auth login screen, protected routes, middleware)
- ✅ 9 server-side auth API routes (sign-in, sign-up, sign-out, MFA, guest, etc.)

### GenAI-Native Stack (Phase 2 — in progress)

- ✅ LLM orchestration layer — provider abstraction, model tiering (Haiku/Sonnet), circuit breaker
- ✅ AI call instrumentation — every call tracked: model, tokens, latency, cost
- ✅ Versioned prompt registry — prompts are first-class tested artifacts, not inline strings
- ✅ Content safety middleware — multi-layer defense: blocklist → LLM classifier → audit trail
- ✅ Input AND output screening — AI-generated content screened before reaching users
- ✅ safe-regex2 validated blocklist patterns — pre-compiled, ReDoS-safe
- ⏳ Streaming responses, multi-language AI, eval framework (Phase 2–3)
- ⏳ RAG pipeline, user context, agentic framework, multimodal (Phase 4–5)

See [GenAI-Native Roadmap](docs/GENAI_ROADMAP.md) for the complete capability map.

### Infrastructure (ready to use)

- ✅ Next.js 16 + TypeScript strict + Tailwind CSS
- ✅ CI/CD pipeline (GitHub Actions) — format, typecheck, lint, test:coverage, build
- ✅ CodeQL SAST + Dependabot dependency scanning
- ✅ Branch protection (develop → staging → main with required CI)
- ✅ ESLint + Prettier — zero warnings
- ✅ 790 unit + integration tests, 84%+ line coverage
- ✅ Lighthouse baseline: 97/100/100/100
- ✅ 22-point automated sustainability gate
- ✅ Versioned releases (v1.1.0)

### Database (Supabase)

- ✅ 9 migrations (001–009)
- ✅ 14 tables
- ✅ 20 Row-Level Security policies
- ✅ Generic roles: guest, registered, admin, super_admin
- ✅ Role inheritance chain: guest → registered → admin → super_admin

### Documentation

| Document                           | Purpose                                                        |
| ---------------------------------- | -------------------------------------------------------------- |
| `docs/adr/ADR-001–017`             | 17 Architecture Decision Records                               |
| `docs/TAD.md`                      | Technical Architecture Document                                |
| `docs/ROADMAP.md`                  | 10-phase product roadmap with versioned changelog              |
| `docs/GENAI_ROADMAP.md`            | GenAI-native capability map — accomplished and forthcoming     |
| `docs/GENAI_MANIFESTO.md`          | The 14 GenAI-native principles — what "GenAI-native" means     |
| `docs/RAMPS_PHASE1_ASSESSMENT.md`  | Phase 1 quality baseline (tests, coverage, OWASP, GDPR, COPPA) |
| `docs/SECURITY_DEBT.md`            | Tracked deferrals with phase assignments                       |
| `docs/OWASP_CONTROLS.md`           | 23 verified OWASP Top 10 controls                              |
| `docs/SUSTAINABILITY_CHECKLIST.md` | 22-point gate definitions                                      |
| `CONTRIBUTING.md`                  | Branch workflow, seed separation, standing rules               |

### Consumer Inheritance

Platform-foundation is designed for consumers to inherit via automated sync:

- Consumer repos pull from PF on a schedule or manually
- Versioned releases (tags) allow consumers to pin to a specific version
- 53-file exclude list protects consumer-specific files
- Pull-based model — PF has no knowledge of consumers

See `CONTRIBUTING.md` for the inheritance model.

## Monorepo Structure

```
platform-foundation/
├── platform/ai/            ← LLM orchestration, provider abstraction, instrumentation (Phase 2 ✅)
├── platform/auth/          ← Identity, permissions, RBAC, GDPR, COPPA (Phase 1 ✅)
├── platform/moderation/    ← Content safety — blocklist, classifier, middleware (Phase 2 ✅)
├── platform/observability/ ← Error tracking, tracing, metrics, health (Phase 2 ✅)
├── platform/realtime/      ← WebSocket engine (Phase 2)
├── platform/voice/         ← Voice pipeline (Phase 3)
├── platform/game-engine/   ← Application framework (Phase 5) — rename tracked in SECURITY_DEBT.md
├── platform/monetization/  ← Monetization (Phase 6)
├── platform/analytics/     ← Analytics engine (Phase 7)
├── prompts/                ← Versioned LLM prompt library with tests (Phase 2 ✅)
├── components/admin/       ← Admin UI (GenAI command bar, data views)
├── components/auth/        ← Auth UI (login, register, profile, age gate)
├── app/api/admin/          ← Admin API routes (roles, users, config, audit)
├── supabase/migrations/    ← 8 database migrations
├── docs/adr/               ← 17 ADRs
├── scripts/                ← Sustainability gate
└── shared/                 ← Shared components, types, utils
```

## Quick Start

### Prerequisites

- Node.js 24+
- Anthropic API key (console.anthropic.com)
- Google Cloud API key (Translation + TTS APIs enabled)

### Setup

```bash
git clone https://github.com/Datankare/platform-foundation.git
cd platform-foundation
npm install
cp .env.example .env.local
# Fill in your API keys in .env.local
npm run dev
```

### Verify

```bash
npm run format:check   # All formatted
npm run typecheck      # Zero errors
npm run lint           # Zero warnings
npm run test:coverage  # 790 tests, 84%+ coverage
npm run build          # Clean build
./scripts/sustainability-gate.sh  # 22-point gate
```

## Using This as a Template

1. Click **"Use this template"** on GitHub
2. Clone and follow Quick Start above
3. Add `.github/sync-config.json` + sync workflow to inherit future updates
4. Add your app-specific roles via a custom migration (see `CONTRIBUTING.md`)
5. Update ADRs and TAD with your stack choices

## API Keys Required

| Service          | Purpose                        | Get It                   |
| ---------------- | ------------------------------ | ------------------------ |
| Anthropic Claude | Content safety, GenAI features | console.anthropic.com    |
| Google Cloud     | Translation + TTS              | console.cloud.google.com |

## Phase 1 Assessment

See [RAMPS Phase 1 Assessment](docs/RAMPS_PHASE1_ASSESSMENT.md) for the complete reliability, accessibility, maintainability, performance, and security report.

## Roadmap

See [Product Roadmap](docs/ROADMAP.md) for all 10 phases, deferred items, and versioned change history.

See [GenAI-Native Roadmap](docs/GENAI_ROADMAP.md) for the complete GenAI capability map — what's been delivered, what's forthcoming, and the 14-point Phase 9 verification checklist. See [GenAI-Native Systems Manifesto](docs/GENAI_MANIFESTO.md) for the 14 principles that define what "GenAI-native" means.

---

_Platform Foundation v1.1.1 — Datankare_
_Built with Foundation as Fabric · Continuous Confidence_
