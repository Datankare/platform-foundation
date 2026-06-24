# Platform Foundation

> Production-grade Next.js application platform — GenAI-native, RAMPS, AAA, Continuous Confidence

A battle-tested foundation for building commercial SaaS products, internal tools,
and application platforms. Clone it, rename it, and start building on solid ground
from day one.

## What You Get

### Governing Principles (pre-wired)

- **RAMPS** — Reliability · Accessibility (WCAG 2.2) · Maintainability · Performance · Security
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

### GenAI-Native Communication Stack (Phase 2 — complete)

- ✅ LLM orchestration layer — provider abstraction, model tiering (Haiku/Sonnet), circuit breaker
- ✅ AI streaming — `provider.stream()` + `orchestrator.stream()`, TTFT instrumentation, fallback to `complete()`
- ✅ AI call instrumentation — every call tracked: model, tokens, latency, cost, time-to-first-token
- ✅ Versioned prompt registry — prompts are first-class tested artifacts, not inline strings
- ✅ Content safety middleware — multi-layer defense: blocklist → LLM classifier → audit trail
- ✅ Input AND output screening — AI-generated content screened before reaching users
- ✅ safe-regex2 validated blocklist patterns — pre-compiled, ReDoS-safe
- ✅ Observability fabric — distributed tracing, metrics sink, health registry, error reporting
- ✅ Realtime foundation — provider-abstracted WebSocket layer (Supabase first, swappable)
- ✅ Agentic-native message schema — agent identity (P15), intent enforcement (P17), trajectories (P18), memory hints (P16)
- ✅ AI cache — prompt-hash keying, TTL by use case, hit/miss metrics, cost savings tracking
- ✅ SSE streaming endpoint (`/api/stream`) + React hooks (`useRealtimeStream`, `useRealtimeChannel`)

### Language & Voice Foundation (Phase 3 — complete)

- ✅ TranslationProvider abstraction (Google, mock, env-var swap)
- ✅ 10-language config: codes, flags, RTL, voice settings
- ✅ TTSProvider + STTProvider (Google Cloud, mock)
- ✅ TTS chunker — handles Google's 5,000-byte limit automatically
- ✅ VoicePipeline orchestrator — STT → safety screen → translate → TTS
- ✅ Agentic voice pipeline — P15-P18 (agent identity, intent, trajectory, memory)
- ✅ SongIdentificationProvider (ACRCloud, mock) — audio fingerprint matching
- ✅ AudioFormatConverter (ffmpeg-service, passthrough, mock)
- ✅ Canonical audio format — all audio normalized to WAV 16kHz mono s16 PCM
- ✅ Privacy by design — metadata stripping, clip limits, no audio in logs
- ✅ Health probes for all voice providers

### Content Safety + Social + Agents (Phase 4 — complete)

- ✅ Guardian agentic moderation — blocklist → LLM classifier → context-aware agent, fail-closed
- ✅ Sentinel strike ladder — warn → suspend → ban, persisted, async off the request path
- ✅ COPPA consent gate — structural safety (P4), config-driven feature blocking
- ✅ Human review queue + appeals (P10) — claim/resolve workflow, overturn side-effects, advisory AI reviewer-assist
- ✅ Account-status guard ordered auth → status → COPPA → Guardian; auth enforced on all API routes
- ✅ Social system — groups, memberships, invites (InMemory + Supabase stores) + 6 social agents
- ✅ Agent runtime — AgentRegistry, ToolRegistry, TrajectoryStore, BudgetTracker, `executeAgent()` loop
- ✅ Input module — InputConductor, classifier, intent resolver, AdaptiveInput component
- ✅ Config-management agent — 10 tools, confirmation gate, two-person approval, impact correlation
- ✅ RAG foundation — chunker, pgvector embedding store, retrieval pipeline, budget-aware context injector
- ✅ Cognitive memory (P16) — per-user episodic/semantic/procedural AI context store
- ✅ AI output explainability — explanation chain for every AI decision
- ✅ **Provider conformance kits (ADR-027)** — an executable behavioral contract (TCK) per abstraction, run against every reference and concrete implementation; a registry-driven meta-test fails CI if any provider slot lacks one

See [GenAI-Native Roadmap](docs/GENAI_ROADMAP.md) for the complete capability map.

### Infrastructure (ready to use)

- ✅ Next.js 16 + TypeScript strict + Tailwind CSS
- ✅ CI/CD pipeline (GitHub Actions) — format, typecheck, lint, test:coverage, build, dependency audit
- ✅ CodeQL + Semgrep SAST, Dependabot dependency scanning
- ✅ Branch protection (develop → staging → main with required CI)
- ✅ ESLint + Prettier — zero warnings
- ✅ 154 suites, 2,089 tests, 88.54% statement / 75.9% branch coverage
- ✅ Conformance kits for all 16 platform abstractions, self-policing via meta-test
- ✅ Self-policing doc gates — roadmap-consistency test, conflict-marker test
- ✅ Lighthouse baseline: 97/100/100/100
- ✅ 22-point sustainability gate + 8-point accessibility gate (A1-A8) + phase boundary protocol (E1-E15)
- ✅ Versioned releases (v1.6.0)
- ✅ WCAG AA accessibility: `aria-live`, `aria-busy`, `role="alert"`, contrast compliance

### Database (Supabase)

- ✅ 21 migrations (001–021)
- ✅ Social (groups/memberships/invites), pgvector embeddings, review queue + appeals tables
- ✅ Row-Level Security policies throughout; service-role gating at the API layer
- ✅ Generic roles: guest, registered, admin, super_admin (inheritance chain)

### Documentation

| Document                            | Purpose                                                              |
| ----------------------------------- | -------------------------------------------------------------------- |
| `docs/adr/ADR-001–027`              | 27 Architecture Decision Records                                     |
| `docs/TAD.md`                       | Technical Architecture Document                                      |
| `docs/ROADMAP.md`                   | 10-phase product roadmap with versioned changelog                    |
| `docs/GENAI_ROADMAP.md`             | GenAI-native capability map — accomplished and forthcoming           |
| `docs/GENAI_MANIFESTO.md`           | The 18 GenAI-native principles — what "GenAI-native" means           |
| `docs/ENGINEERING_LEARNINGS.md`     | Adopted engineering principles (L1–L21) and learning log             |
| `docs/PHASE4_PLAN.md`               | Phase 4 sprint plan — Content Safety + Social + Agent Runtime        |
| `docs/RAMPS_PHASE4_ASSESSMENT.md`   | Phase 4 RAMPS assessment (all 5 pillars GREEN)                       |
| `docs/RAMPS_PHASE1–3_ASSESSMENT.md` | Earlier phase baselines                                              |
| `docs/SECURITY_DEBT.md`             | Tracked deferrals with phase assignments                             |
| `docs/OWASP_CONTROLS.md`            | Verified OWASP Top 10 controls                                       |
| `docs/SUSTAINABILITY_CHECKLIST.md`  | 22-point gate + 8-point accessibility gate + phase boundary protocol |
| `CONTRIBUTING.md`                   | Branch workflow, seed separation, standing rules                     |

### Consumer Inheritance

Platform-foundation is designed for consumers to inherit via automated sync:

- Consumer repos pull from PF on a schedule or manually (SHA-pinned, provenance recorded in the sync PR)
- Versioned releases (tags) allow consumers to pin to a specific version
- Exclude list protects consumer-specific files
- Pull-based model — PF has no knowledge of consumers
- **Conformance kits cross the sync boundary**: a consumer that reimplements an abstraction (e.g. auth) wires its implementation into the same synced kit in a repo-owned arm — tightening the contract in PF re-tests every consumer automatically (ADR-027)

See `CONTRIBUTING.md` for the inheritance model.

## Monorepo Structure

```
platform-foundation/
├── platform/ai/            ← LLM orchestration, streaming, provider + mock (Phase 2/4 ✅)
├── platform/auth/          ← Identity, permissions, RBAC, GDPR, COPPA, Cognito (Phase 1 ✅)
├── platform/cache/         ← Cache provider abstraction, Redis, AI cache (Phase 2 ✅)
├── platform/moderation/    ← Guardian, Sentinel, review + appeals, blocklist (Phase 2/4 ✅)
├── platform/observability/ ← Error tracking, tracing, metrics, health registry (Phase 2 ✅)
├── platform/providers/     ← Provider registry — 13 swappable slots (Phase 2–4 ✅)
├── platform/rate-limit/    ← Rate limiting — per-user, token-aware (Phase 2 ✅)
├── platform/realtime/      ← Realtime provider, agentic messaging, health (Phase 2 ✅)
├── platform/translation/   ← Translation provider (Phase 3 ✅)
├── platform/voice/         ← Voice pipeline — TTS, STT, song ID (Phase 3 ✅)
├── platform/input/         ← Input conductor, classifier, intent (Phase 4 ✅)
├── platform/agents/        ← Agent runtime — registry, tools, trajectories, budgets (Phase 4 ✅)
├── platform/social/        ← Groups, memberships, invites + social agents (Phase 4 ✅)
├── platform/rag/           ← RAG — chunker, embeddings, retrieval, memory (Phase 4 ✅)
├── platform/admin/         ← Config-management agent (Phase 4 ✅)
├── platform/app-framework/   ← Application framework (Phase 5)
├── platform/monetization/  ← Monetization (Phase 6)
├── platform/analytics/     ← Analytics engine (Phase 7)
├── prompts/                ← Versioned LLM prompt library with tests (Phase 2 ✅)
├── components/admin/       ← Admin UI (GenAI command bar, data views)
├── components/auth/        ← Auth UI (login, register, profile, age gate, review/appeals)
├── hooks/                  ← React hooks (realtime stream, channel, profile)
├── app/api/                ← API routes (admin, auth, health, process, stream, review)
├── __tests__/contract/     ← Conformance kits (TCK) for all 16 abstractions (ADR-027)
├── supabase/migrations/    ← 21 database migrations
├── docs/adr/               ← 27 ADRs
├── k6/                     ← Load test scripts
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
npm run test:coverage  # 154 suites, 2089 tests, 88.5% coverage
npm run build          # Clean build
```

## Using This as a Template

1. Click **"Use this template"** on GitHub
2. Clone and follow Quick Start above
3. Add `.github/sync-config.json` + sync workflow to inherit future updates
4. Add your app-specific roles via a custom migration (see `CONTRIBUTING.md`)
5. If you reimplement a platform abstraction, wire it into the matching conformance kit in a repo-owned arm (see ADR-027)
6. Update ADRs and TAD with your stack choices

## API Keys Required

| Service          | Purpose                        | Get It                   |
| ---------------- | ------------------------------ | ------------------------ |
| Anthropic Claude | Content safety, GenAI features | console.anthropic.com    |
| Google Cloud     | Translation + TTS              | console.cloud.google.com |

## Quality Assessments

See [RAMPS Phase 4 Assessment](docs/RAMPS_PHASE4_ASSESSMENT.md) for the latest reliability, accessibility, maintainability, performance, and security report (all 5 pillars GREEN).

Earlier baselines: [Phase 3](docs/RAMPS_PHASE3_ASSESSMENT.md) · [Phase 2](docs/RAMPS_PHASE2_ASSESSMENT.md) · [Phase 1](docs/RAMPS_PHASE1_ASSESSMENT.md)

## Roadmap

See [Product Roadmap](docs/ROADMAP.md) for all 10 phases, deferred items, and versioned change history.

See [GenAI-Native Roadmap](docs/GENAI_ROADMAP.md) for the complete GenAI capability map — what's been delivered, what's forthcoming, and the 18-point verification checklist.

See [GenAI-Native Systems Manifesto](docs/GENAI_MANIFESTO.md) for the 18 principles that define what "GenAI-native" means.

See [Engineering Learnings](docs/ENGINEERING_LEARNINGS.md) for adopted principles from industry articles, our own failures, and patterns we discover.

---

_Platform Foundation v1.6.0 — Datankare_
_Phase 4 Complete · 154 suites · 2,089 tests · 88.54% coverage · 27 ADRs · 18 GenAI principles · 16 conformance kits · 12+ agents_
_Built with Foundation as Fabric · Continuous Confidence_
