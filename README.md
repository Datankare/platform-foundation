# Platform Foundation

> Production-grade Next.js application platform — GenAI-native, RAMPS, AAA, Continuous Confidence
>
> **v6.0.0** — tenancy (one codebase, single or shared; every table under forced row-level security for `app_tenant`; direct Postgres through `platform/data`), the core and optional product modules (an app's own module manifest merged with the platform's), durable background jobs and live/ready health, a container image proven in CI, the October 2026 audit's Wave 2, app migrations that never collide with the platform's, and UTC in every transaction. **Breaking** — deploy with the runbook in [MIGRATION_v5_to_v6](docs/MIGRATION_v5_to_v6.md) §1.
>
> **v5.1.1** — the platform's sign-in page works in a production build (the browser signs in through the server's routes instead of starting every server provider in the browser); Next's lint configuration 16 (flat config) with React's newer hook rules, so no component sets state inside an effect (stale responses dropped, state that follows a prop adjusted during render, the auth session read as an external store); React 19.3, Sentry 11, Prettier 3.9.10 and the rest of the open Dependabot updates; unused `@anthropic-ai/sdk`, `dotenv` and `@eslint/eslintrc` removed. No migration.
>
> **v5.1.0** — held actions decided and resumed only as approved: the durable proposal store keeps the whole proposing identity (migration 046), a resume runs exactly the approved tool and payload as the proposing agent, trajectories are scoped to their user, and the proposing agent or its session can never approve its own action — found by the Playform v0.8.0 release review ([register](docs/audits/2026-10-REGISTER.md)). Apply migration 046 before deploying.

> **v5.0.0** — **Adversarial Validation**: the October 2026 whole-system adversarial review's Critical and High findings fixed — authorization on every path including the AI command bar, audit that fails closed, governed configuration only, durable moderation stores, a daily paid-request quota, a screened `/api/stream` — and, for each pattern behind them, a check that runs on every commit, plus a monkey/fuzz run against the production build ([ASSURANCE](docs/ASSURANCE.md), [register](docs/audits/2026-10-REGISTER.md)). **Breaking** — see [MIGRATION_v4_to_v5](docs/MIGRATION_v4_to_v5.md).
>
> **v4.1.0** — an app declares its own route guards (`platform/route-policy/app-route-policy.ts`) and the route checks verify each one calls a platform verifier or limiter; an app documents its own settings in `docs/APP_ENV_REFERENCE.md`; `PLATFORM_VERSION` names the synced release (TASK-136). Non-breaking — see [RELEASE_NOTES](docs/RELEASE_NOTES.md).
>
> **v4.0.0** — public-repository hardening: rate limiting on every API route through one shared, swappable store (ADR-052), `/api/stream` verifies its caller and bounds every request, CI checks that every route verifies its caller and is rate limited, a secret scan over every commit, a security policy and a component register. **Breaking** (production requires `RATE_LIMIT_STORE`) — see [MIGRATION_v3_to_v4](docs/MIGRATION_v3_to_v4.md).
>
> **v3.1.0** — consumer seams: an app's own API error codes merged into the catalog (ADR-051 D1), consumer migrations replayed after the schema baseline, and guest tokens minted by the platform under any auth provider. Non-breaking — see [RELEASE_NOTES](docs/RELEASE_NOTES.md).
>
> **v3.0.0** — Phase 5 Sprint 7A, deployment & auth readiness: a declared, fail-closed deployment environment contract (ADR-050), signed guest tokens and a governed guest allowance, coded API errors in one translatable catalog (ADR-051), Google sign-in via the hosted identity provider, a schema baseline with migration replay in CI, and a deployed smoke test. **Breaking** — see [MIGRATION_v2_to_v3](docs/MIGRATION_v2_to_v3.md).

A battle-tested foundation for building commercial SaaS products, internal tools,
and application platforms. Clone it, rename it, and start building on solid ground
from day one.

## What You Get

### Governing Principles (pre-wired)

- **RAMPS** — Reliability · Accessibility (WCAG 2.2) · Manageability · Performance · Security
- **AAA** — Authentication · Authorization · Analytics
- **Foundation as Fabric** — Infrastructure woven in, never bolted on
- **Continuous Confidence** — Full test suite, green means nothing is broken
- **Adversarial Validation** — every test carries its hostile cases; every practice relied on is a check that runs

### Adversarial Validation — the highlight for adopters

Green tests prove what a system does, not what it refuses. In October 2026 every test passed while a
moderator could make themselves `super_admin` through the AI command bar. Since v5.0.0 the platform
holds itself — and any app built on it — to this:

| Practice                    | What runs                                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------------------------- |
| Abuse cases per actor       | Every real role (read from the migrations) against every admin permission, with the real guard — no stubs |
| Every second path           | An authorization matrix over every route guard and every AI command-bar action                            |
| Hostile and generated input | Property tests (`fast-check`), searched 5,000 cases deep on every promotion                               |
| Monkey sequences            | Every route, every caller, hostile bodies and random sequences against the production build               |
| Injected failure            | Audit, stores and lookups fail on purpose: the system refuses, never proceeds                             |
| No unused security code     | Every security control has a production caller, or a registered reason                                    |
| Findings become tests       | Every audit finding ships with the test that would have caught it                                         |
| Independent review          | Each release and each phase close reviewed by agents that did not build it                                |

Cadence — every commit: CI; every change: threat model and hostile tests; every release: independent
review plus fuzz and monkey testing on staging; weekly: dependency audit, ZAP scan, migration parity.
See [ASSURANCE.md](docs/ASSURANCE.md).

### Identity & Access (Phase 1 — complete)

- ✅ Auth provider abstraction (Cognito-ready, pluggable to any IdP)
- ✅ RBAC permissions engine with role inheritance
- ✅ Entitlements engine (time-bounded grants)
- ✅ User profiles with per-field visibility (private/friends/public)
- ✅ COPPA age verification + parental consent schema
- ✅ GDPR: data export, cascading deletion
- ✅ Platform config table (runtime key-value settings)
- ✅ super_admin role separation + anti-self-elevation guard
- ✅ Admin UI with GenAI-native command bar
- ✅ Rate limiting on every API route — one shared, swappable store (Postgres, Redis or memory), fail-closed (ADR-052)
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
- ✅ Liveness and readiness (`/api/health/live`, `/api/health/ready`): boot recorded, database and cache required, other dependencies degrade only (ADR-056 D4)
- ✅ Durable background jobs (`platform/jobs`): a Postgres queue with leases, retries with backoff and dead letters, a scheduler, every timed duty a recurring job, a Jobs console for operators (ADR-056 D2/D3)
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
- ✅ Social system — groups, memberships, invites (InMemory + Postgres stores) + 6 social agents
- ✅ Agent runtime — AgentRegistry, ToolRegistry, TrajectoryStore, BudgetTracker, `executeAgent()` loop
- ✅ Input module — InputConductor, classifier, intent resolver, AdaptiveInput component
- ✅ Config-management agent — 10 tools, confirmation gate, two-person approval, impact correlation
- ✅ RAG foundation — chunker, pgvector embedding store, retrieval pipeline, budget-aware context injector
- ✅ Cognitive memory (P16) — per-user episodic/semantic/procedural AI context store
- ✅ AI output explainability — explanation chain for every AI decision
- ✅ **Provider conformance kits (ADR-027)** — an executable behavioral contract (TCK) per abstraction, run against every reference and concrete implementation; a registry-driven meta-test fails CI if any provider slot lacks one

See [GenAI-Native Roadmap](docs/GENAI_ROADMAP.md) for the complete capability map.

### Agent Governance + Identity (Sprint 3c — complete)

- ✅ Agent identity rung 2 (ADR-033) — attested delegation: a governed trusted-agent registry, RS256 delegation tokens (verify + OAuth 2.1/PKCE mint), governed token TTL (per-agent ceiling + global cap), rung-1 header retired. Two-principal check (user gate + agent gate), fail-closed throughout.
- ✅ Per-account feature restriction (ADR-034) — block a specific feature for a specific user, orthogonal to account status, fail-closed.
- ✅ GenAI-native governance admin (ADR-035) — administer the registry, capability map, approval policy, and per-account blocks through the natural-language admin (prompt → AI plan → confirm → execute), not forms. A reusable platform capability: vocabulary-free tools over governed config, inherited by any consumer with agents.

### Infrastructure (ready to use)

- ✅ Next.js 16 + TypeScript strict + Tailwind CSS
- ✅ CI/CD pipeline (GitHub Actions) — format, typecheck, lint, test:coverage, build, dependency audit, migration replay on real Postgres
- ✅ CodeQL + Semgrep SAST, Dependabot dependency scanning
- ✅ Branch protection (develop → staging → main with required CI)
- ✅ ESLint + Prettier — zero warnings
- ✅ 265 suites, 3,414 tests (1 skipped), 91.84% statement / 80.27% branch / 90.98% function coverage
- ✅ Conformance kits for all 26 platform abstractions, self-policing via meta-test
- ✅ Self-policing doc gates — roadmap-consistency test, conflict-marker test
- ✅ Lighthouse baseline: 97/100/100/100
- ✅ 22-point sustainability gate + 8-point accessibility gate (A1-A8) + phase boundary protocol (E1-E15)
- ✅ Versioned releases (v4.1.0)
- ✅ WCAG AA accessibility: `aria-live`, `aria-busy`, `role="alert"`, contrast compliance

### Database (Supabase)

- ✅ 54 migrations (001–053), tracked in `applied_migrations`; new databases start from the schema baseline
- ✅ Social (groups/memberships/invites), pgvector embeddings, review queue + appeals tables
- ✅ Forced row-level security on every tenant-owned table; every server query runs through `platform/data` as `app_tenant`, which cannot bypass it (ADR-053)
- ✅ Generic roles: guest, registered, admin, super_admin (inheritance chain)

### Documentation

| Document                                      | Purpose                                                                            |
| --------------------------------------------- | ---------------------------------------------------------------------------------- |
| `docs/adr/ADR-001–056`                        | 56 Architecture Decision Records                                                   |
| `docs/TAD.md`                                 | Technical Architecture Document                                                    |
| `docs/ROADMAP.md`                             | 10-phase product roadmap with versioned changelog                                  |
| `docs/GENAI_ROADMAP.md`                       | GenAI-native capability map — accomplished and forthcoming                         |
| `docs/SPRINT3C_UX_GOVERNANCE_ADMIN_DESIGN.md` | GenAI-native governance admin — the reusable governance-panel capability (ADR-035) |
| `docs/RELEASE_NOTES.md`                       | Release notes — new platform capabilities per release                              |
| `docs/GENAI_MANIFESTO.md`                     | The 18 GenAI-native principles — what "GenAI-native" means                         |
| `docs/ENGINEERING_LEARNINGS.md`               | Adopted engineering principles (L1–L21) and learning log                           |
| `docs/PHASE4_PLAN.md`                         | Phase 4 sprint plan — Content Safety + Social + Agent Runtime                      |
| `docs/RAMPS_PHASE4_ASSESSMENT.md`             | Phase 4 RAMPS assessment (all 5 pillars GREEN)                                     |
| `docs/RAMPS_PHASE1–3_ASSESSMENT.md`           | Earlier phase baselines                                                            |
| `docs/SECURITY_DEBT.md`                       | Tracked deferrals with phase assignments                                           |
| `docs/OWASP_CONTROLS.md`                      | Verified OWASP Top 10 controls                                                     |
| `docs/COMPONENT_REGISTER.md`                  | Dependencies and hosted services — licence verdicts and exit paths                 |
| `SECURITY.md`                                 | How to report a vulnerability privately; supported versions                        |
| `docs/SUSTAINABILITY_CHECKLIST.md`            | 22-point gate + 8-point accessibility gate + phase boundary protocol               |
| `CONTRIBUTING.md`                             | Branch workflow, seed separation, standing rules                                   |

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
├── platform/data/          ← The one way server code reaches Postgres — tenant, platform, owner transactions (ADR-053)
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
├── platform/tenancy/       ← Tenants, request scope (`tenantRoute`), directory, lifecycle (ADR-053)
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
├── __tests__/contract/     ← Conformance kits (TCK) for all 26 abstractions (ADR-027)
├── supabase/migrations/    ← 54 database migrations
├── docs/adr/               ← 56 ADRs
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
npm run test:coverage  # 218 suites, 2,730 tests, 90.19% coverage
npm run build          # Clean build
```

## Using This as a Template

1. Click **"Use this template"** on GitHub
2. Clone and follow Quick Start above
3. Add `.github/sync-config.json` + the sync workflow to inherit future updates — copy [`docs/templates/`](docs/templates/) (anchored excludes, inputs through `env:`), and add your own `platform/modules/app-manifest.json` ([SETUP_AND_INTEGRATION](docs/SETUP_AND_INTEGRATION.md) §6)
4. Add your app-specific roles via a migration of your own, named `NNN<letter>_<app>_<name>.sql` (see `CONTRIBUTING.md`)
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

_Platform Foundation v4.1.0 — Datankare_
_Phase 5 Sprint 7R · 270 suites · 3,474 tests · 92.18% statement coverage · 56 ADRs · 18 GenAI principles · 27 conformance kits · 21 provider slots_
_Built with Foundation as Fabric · Continuous Confidence_

_Last updated: September 24, 2026 (v2.5.0 — Phase 5 Sprint 6 close: multimodal AI — multimodal provider interface (ADR-044), screenModality safety seam (ADR-046), screened multimodal input, governed image generation (ADR-045), and provenance + synthetic-media detection (ADR-047); all fail-closed on one shared substrate, with L21 conformance kits)_
