# Platform Foundation — Product Roadmap

**Owner:** Raman Sud, CTO
**Canonical location:** `docs/ROADMAP.md` (both platform-foundation and playform repos)
**Versioning:** Every change to this document is logged in the Changelog at the bottom.
**Rule:** This document is updated at the start and end of every phase. Changes between phases are logged with date, author, and rationale.

---

## Phase Summary

| Phase | Name                         | Status      | PF Release | Started    | Completed  |
| ----- | ---------------------------- | ----------- | ---------- | ---------- | ---------- |
| 0     | Platform Scaffolding         | ✅ Complete | —          | 2026-03-15 | 2026-03-18 |
| 0.5   | Input Reliability Sprint     | ✅ Complete | —          | 2026-03-18 | 2026-03-20 |
| 0.75  | E2E Test Suite               | ✅ Complete | —          | 2026-03-20 | 2026-03-22 |
| 1     | Identity & Access Foundation | ✅ Complete | v1.1.0     | 2026-03-22 | 2026-04-02 |
| 2     | Communication Foundation     | ✅ Complete | v1.3.0     | 2026-04-03 | 2026-04-13 |
| 3     | Language & Voice Foundation  | ✅ Complete | v1.4.0     | 2026-04-14 | 2026-04-16 |
| 4     | Content Safety Foundation    | ✅ Complete | v1.6.0     | 2026-04-18 | 2026-06-11 |
| 5     | Application Framework + AUX  | ⏳ Upcoming | —          | —          | —          |
| 6     | Monetization Foundation      | ⏳ Upcoming | —          | —          | —          |
| 7     | Analytics Foundation         | ⏳ Upcoming | —          | —          | —          |
| 8     | Consumer App Integration     | ⏳ Upcoming | —          | —          | —          |
| 9     | Hardening & Launch           | ⏳ Upcoming | —          | —          | —          |

### Cross-Phase Fabric

Four architectural commitments span all phases (see ADR-014, ADR-015, ADR-016, ADR-017):

| Fabric             | Principle                                                                                                            | Starts  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- | ------- |
| Observability      | Woven in, not bolted on. Every phase adds its observability layer.                                                   | Phase 2 |
| GenAI-Native       | Infrastructure, not a feature. Every AI interaction goes through orchestration.                                      | Phase 2 |
| Content Safety     | Multi-layer defense. Every input AND output surface screened from day one.                                           | Phase 2 |
| GenAI Completeness | No GenAI capability discovered late. Complete surface map in ADR-017, verified at Phase 9.                           | Phase 2 |
| Agentic-Native     | Infrastructure built for agents, not bolted on. Every layer supports delegation, trajectories, and cognitive memory. | Phase 2 |

---

## Phase 0 — Platform Scaffolding ✅

**Objective:** Bootstrap the monorepo, CI/CD, and foundational architecture.

| Deliverable                                                                                       | Status |
| ------------------------------------------------------------------------------------------------- | ------ |
| Next.js 16 app with TypeScript strict mode                                                        | ✅     |
| ESLint + Prettier + Husky                                                                         | ✅     |
| CI pipeline (GitHub Actions)                                                                      | ✅     |
| Vercel deployment                                                                                 | ✅     |
| ADRs 001–007 (platform separation, stack, GenAI-native, principles, content safety, DB, monorepo) | ✅     |
| Lighthouse baseline (97/100/100/100)                                                              | ✅     |
| 10-language translation support                                                                   | ✅     |
| Content type classification (8 types)                                                             | ✅     |
| Voice input with continuous recognition                                                           | ✅     |
| Google STT audio capture                                                                          | ✅     |

---

## Phase 0.5 — Input Reliability Sprint ✅

**Objective:** Harden input pipeline reliability.

| Deliverable                            | Status |
| -------------------------------------- | ------ |
| fetchWithTimeout wrapper (10s default) | ✅     |
| Structured logger with request IDs     | ✅     |
| Input sanitization primitives          | ✅     |
| Safety check (fail-closed)             | ✅     |

---

## Phase 0.75 — E2E Test Suite ✅

**Objective:** End-to-end test coverage for core user journey.

| Deliverable                             | Status |
| --------------------------------------- | ------ |
| Playwright E2E framework                | ✅     |
| WCAG 2.2 accessibility audit (axe-core) | ✅     |
| API contract tests                      | ✅     |
| Translation user journey tests          | ✅     |
| Notification system tests               | ✅     |

---

## Phase 1 — Identity & Access Foundation ✅

**Objective:** Complete identity, access control, and administration layer.
**PF Release:** v1.1.0

### Sprints Completed

| Sprint | Scope                                                             | Tests Added |
| ------ | ----------------------------------------------------------------- | ----------- |
| 1      | Auth provider abstraction, mock provider                          | —           |
| 2      | Auth UI components (LoginForm, RegisterForm, etc.)                | +63         |
| 3      | Permissions engine, entitlements, audit, cache                    | +9          |
| 4      | User profiles, devices, consent, COPPA, password policy           | +16         |
| 5      | GDPR deletion, data export, guest lifecycle                       | +15         |
| 6      | Admin UI (GenAI command bar), rate limiting, Supabase integration | +18         |
| 7a     | Sustainability gate, integration tests, empty catch fixes         | +72         |
| 7b     | Platform config, super_admin, repo inheritance, seed separation   | —           |

### Deliverables

| Deliverable                                           | Status |
| ----------------------------------------------------- | ------ |
| Auth provider interface (Cognito-ready, pluggable)    | ✅     |
| RBAC permissions engine with role inheritance         | ✅     |
| Entitlements engine (time-bounded grants)             | ✅     |
| User profiles with per-field visibility               | ✅     |
| COPPA age verification + parental consent schema      | ✅     |
| GDPR: data export, deletion, guest lifecycle          | ✅     |
| Admin UI with GenAI-native command bar                | ✅     |
| Platform config table (runtime key-value settings)    | ✅     |
| super_admin role separation + anti-self-elevation     | ✅     |
| Rate limiting (per-IP sliding window)                 | ✅     |
| Automated 22-point sustainability gate                | ✅     |
| Pull-based repo inheritance (PF → consumers)          | ✅     |
| Seed data separation (generic PF, app-specific tiers) | ✅     |
| 13 ADRs, 7 migrations, 20 RLS policies                | ✅     |
| RAMPS Phase 1 Assessment                              | ✅     |
| fetchWithTimeout retry (429/503/529 backoff)          | ✅     |
| API transient error handling (503 with user message)  | ✅     |
| Semgrep SAST + ZAP DAST (Playform)                    | ✅     |
| CodeQL SAST (platform-foundation)                     | ✅     |

### Final Metrics

| Metric                   | Platform-Foundation | Playform       |
| ------------------------ | ------------------- | -------------- |
| Unit + integration tests | 367                 | 522            |
| E2E tests                | 2                   | 16             |
| Code coverage (lines)    | 80.6%               | 82.2%          |
| Sustainability gate      | 17/0/5              | 16/0/6         |
| Lighthouse               | 97/100/100/100      | 97/100/100/100 |

---

## Phase 2 — Communication Foundation ✅

**Objective:** WebSocket/real-time infrastructure, plus the three cross-phase fabric foundations (observability, GenAI-native stack, content safety).

**Prerequisites:** Phase 1 complete, Redis infrastructure available.

### Sprint Plan

| Sprint | Scope                               | Depends On                          | Status      |
| ------ | ----------------------------------- | ----------------------------------- | ----------- |
| 1      | LLM Orchestration + Prompt Registry | —                                   | ✅ Complete |
| 2      | Content Safety Refactor             | Sprint 1 (uses orchestrator)        | ✅ Complete |
| 3      | Observability Fabric + TASK-018     | Sprint 1 (instruments orchestrator) | ✅ Complete |
| 4      | Redis + Infrastructure Hardening    | External: Upstash Redis             | ✅ Complete |
| 4b     | Auth Wiring — Live Login Screen     | Sprint 4 (auth components exist)    | ✅ Complete |
| 5      | Real-Time / WebSocket               | Sprint 4 (Redis for pub/sub)        | ✅ Complete |
| 6      | Integration Tests + Phase Gate      | All prior sprints                   | ✅ Complete |

### Real-Time Communication

| Deliverable                             | Source  |
| --------------------------------------- | ------- |
| `platform/realtime/` — WebSocket engine | ADR-007 |
| Cross-origin WebSocket CSP rules        | ADR-011 |

### Observability Foundation (ADR-014)

| Deliverable                                                       | Rationale                                                      |
| ----------------------------------------------------------------- | -------------------------------------------------------------- |
| Error tracking (Sentry) — real-time aggregation                   | Can't build real-time comms without seeing errors              |
| Log aggregation — centralized, searchable                         | Vercel function logs disappear on recycle                      |
| Distributed tracing — trace propagation across external API calls | Voice → safety → translate → TTS pipeline is opaque without it |
| AI call instrumentation — per-call model, tokens, latency, cost   | Unknown AI spend is unacceptable                               |

### GenAI-Native Stack Foundation (ADR-015, ADR-017)

| Deliverable                                                                                                    | Rationale                                                                                 |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `platform/ai/orchestrator.ts` — LLM provider abstraction, model tiering (Haiku/Sonnet), circuit breaker, retry | Raw `fetch()` to Anthropic must be replaced with instrumented orchestration               |
| `platform/ai/provider.ts` — provider interface (Anthropic primary, pluggable fallback)                         | If Anthropic is down, everything fails today                                              |
| `prompts/` — versioned prompt library, prompts extracted from inline strings, prompt tests                     | `prompts/README.md` has been an empty placeholder since Phase 0                           |
| Refactor admin AI + safety to use orchestration layer                                                          | Two call sites today, both raw `fetch()`                                                  |
| Streaming support — `provider.stream()` alongside `complete()`, time-to-first-token instrumentation            | Conversational surfaces (chat, onboarding, admin) need progressive rendering (ADR-017 §2) |

### Content Safety Foundation (ADR-016, ADR-017)

| Deliverable                                                                                                                                                                       | Rationale                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `platform/moderation/blocklist.ts` — keyword/pattern pre-screen (instant, zero-cost)                                                                                              | Reduces AI costs for obvious violations                                                                |
| Refactor `safety.ts` — structured classifier output: categories (harassment, sexual, violence, self-harm, hate, dangerous), confidence (0–1), severity (low/medium/high/critical) | Binary safe/unsafe is insufficient for tiered enforcement                                              |
| Safety middleware — universal, applied at every input AND output surface                                                                                                          | Only `/api/process` inputs are covered today; AI outputs go unscreened (ADR-017 §1)                    |
| AI output screening — every AI-generated response screened before reaching the user                                                                                               | AI-generated content (onboarding, support, admin responses) could contain hallucinated harmful content |
| Audit trail upgrade — full classifier output logged per decision (input hash, categories, confidence, severity, action, direction)                                                | Current audit logs pass/fail only — legally insufficient                                               |

### Infrastructure Hardening (carried from Phase 1)

| Deliverable                                              | Source                             |
| -------------------------------------------------------- | ---------------------------------- |
| Redis-backed permissions cache (CacheProvider interface) | ✅ Sprint 4 (platform/cache/)      |
| Redis-backed rate limiter (multi-instance)               | ✅ Sprint 4 (platform/rate-limit/) |
| Password policy enforcement (runtime, not just schema)   | ✅ Sprint 4 (password-policy.ts)   |
| GDPR hard purge implementation                           | ✅ Sprint 4 (platform/gdpr/)       |
| Integration tests against live Supabase + Cognito        | Sprint 7 deferred                  |

### Carried Forward

| Item                              | ID       | Severity                  |
| --------------------------------- | -------- | ------------------------- |
| CacheProvider interface (Redis)   | TASK-015 | Medium                    |
| CI-001: GitHub Actions Node.js 24 | CI-001   | Low (deadline: June 2026) |

---

## Phase 3 — Language & Voice Foundation ✅

**Objective:** Advanced language processing, voice interaction, and song identification.
**PF Release:** v1.4.0

### Sprints Completed

| Sprint | Scope                            | Tests Added |
| ------ | -------------------------------- | ----------- |
| 1      | Translation provider abstraction | +22         |
| 2      | Voice provider + TTS chunker fix | +30         |
| 3      | Voice pipeline (P1-P18 agentic)  | +31         |
| 4a     | Song ID + Audio format provider  | +67         |
| 4b     | Phase gate + release             | —           |

### Deliverables

| Deliverable                                                    | Status |
| -------------------------------------------------------------- | ------ |
| TranslationProvider interface (Google, mock, env-var swap)     | ✅     |
| 10-language config with codes, flags, RTL, voice settings      | ✅     |
| TTSProvider + STTProvider interfaces (Google, mock)            | ✅     |
| TTS chunker — 5,000-byte Google limit (TASK-020)               | ✅     |
| VoicePipeline orchestrator — STT → safety → translate → TTS    | ✅     |
| Agentic voice pipeline (P15-P18: identity, intent, trajectory) | ✅     |
| SongIdentificationProvider (ACRCloud, mock)                    | ✅     |
| AudioFormatConverter (ffmpeg-service, passthrough, mock)       | ✅     |
| Canonical audio format — WAV 16kHz mono s16 PCM                | ✅     |
| Privacy: metadata stripping, clip limits, no-audio-in-logs     | ✅     |
| Health probes for all voice providers                          | ✅     |
| SONG_IDENTIFY rate limit rule (10/user/hour)                   | ✅     |
| Provider registry: 10 slots (was 8)                            | ✅     |
| ADR-019: Voice Pipeline Architecture                           | ✅     |
| ADR-020: Song Identification Architecture                      | ✅     |
| RAMPS Phase 3 Assessment                                       | ✅     |
| k6 dry run — no regression                                     | ✅     |

### Final Metrics

| Metric                   | Platform-Foundation |
| ------------------------ | ------------------- |
| Unit + integration tests | 1013                |
| Test suites              | 68                  |
| Code coverage (stmts)    | 82.54%              |
| ADRs                     | 20                  |
| Provider slots           | 10                  |

### Voice & Language

| Deliverable                               | Source                       |
| ----------------------------------------- | ---------------------------- |
| `platform/voice/` — Voice pipeline engine | ADR-007                      |
| Song identification (ACRCloud/AudD.io)    | TASK-013                     |
| Advanced translation features             | platform/translation/ README |

### Observability (ADR-014)

| Deliverable                                            | Rationale                                                       |
| ------------------------------------------------------ | --------------------------------------------------------------- |
| APM dashboards (Datadog)                               | Know before users tell you something is slow                    |
| Voice pipeline tracing — multi-API chain observability | Voice is the most complex pipeline; needs end-to-end visibility |
| SLA definition — committed uptime (99.9%? 99.95%?)     | Shapes infrastructure cost and architecture decisions           |

### GenAI-Native (ADR-015, ADR-017)

| Deliverable                                                                      | Rationale                                                                    |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| AI response caching — identical inputs → cached outputs                          | Translation and classification are highly cacheable                          |
| Token tracking — per-request token accounting                                    | Cost visibility before monetization phase                                    |
| Enhanced moderation — multi-model with confidence scores                         | Single binary check is insufficient                                          |
| Multi-language AI — safety classification and AI interactions in user's language | English-only AI in a 10-language platform is not GenAI-native (ADR-017 §3)   |
| AI evaluation framework — `prompts/evals/` with datasets, regression runs in CI  | No way to prove classify-v2 is better than v1 across edge cases (ADR-017 §4) |

### Content Safety (ADR-016)

| Deliverable                                                           | Rationale                                                   |
| --------------------------------------------------------------------- | ----------------------------------------------------------- |
| Content rating integration — COPPA tier adjusts classifier thresholds | Stricter for under-13, moderate for 13-17, standard for 18+ |
| Profile field screening (display name, bio)                           | Unscreened today                                            |
| Vercel security headers (SEC-007)                                     | Low severity, but belongs in security layer                 |

---

## Phase 4 — Content Safety Foundation ✅

**Objective:** Content moderation engine, COPPA enforcement, a user-group social system with autonomous agents, RAG foundation + cognitive memory, and a human review + appeals queue. Expanded scope per `PHASE4_PLAN.md`: Content Safety + Social System + Agent Runtime.
**Start date:** 2026-04-18 — **Completed:** 2026-06-11 — **Releases:** PF v1.5.0 (Sprint 6 close), PF v1.6.0 (phase close)

### Sprints

| Sprint | Scope                                                                                           | Status      |
| ------ | ----------------------------------------------------------------------------------------------- | ----------- |
| 0      | Entry housekeeping — Sentry, CodeQL fixes, Semgrep SAST, pgvector + ltree, intent-driven UX     | ✅ Complete |
| 1a     | PF input module + agent types (conductor, classifier, intent, AdaptiveInput)                    | ✅ Complete |
| 1b     | Playform SpikeApp rewrite on AdaptiveInput; all existing features preserved                     | ✅ Complete |
| 2      | Moderation engine — Guardian agentic content moderation (ADR-016)                               | ✅ Complete |
| 3a     | Config-management agent — 10 tools, confirmation gate, two-person approval                      | ✅ Complete |
| 3b     | Sentinel agent (strike ladder warn → suspend → ban) + COPPA consent gate                        | ✅ Complete |
| 3c     | ACRCloud rotation, recording-duration config, health probes, docs reorg                         | ✅ Complete |
| 3d     | Profile screening, account-status guard, route-guard util, authFetch, auth across all 7 routes  | ✅ Complete |
| 4a     | Social data model + core services + agent runtime (registry, tools, trajectory, budget)         | ✅ Complete |
| 4b     | Agent activation — 5 social agents; AgentClassifier + AgentIntentResolver swap rule-based impls | ✅ Complete |
| 4c     | Playform social wiring — Team panel, social UI components + hooks                               | ✅ Complete |
| 5      | RAG foundation — chunker, embedding store, retrieval, budget-aware context injector, memory     | ✅ Complete |
| 6      | Human review + appeals (P10) on Guardian → Sentinel; Cognito new-password; live DB reconcile    | ✅ Complete |
| 7      | Sync-cron hardening + provider conformance kits (ADR-027) + gate guards                         | ✅ Complete |
| gate   | Phase 4 exit gate (E1-E15)                                                                      | ✅ Complete |

### Delivered

- **Content Safety (ADR-016):** `platform/moderation/` engine, Guardian agentic moderation, COPPA enforcement + consent gate, age-gated content, strike ladder (warn → suspend → ban) via Sentinel, user reporting, human review queue + appeal workflow (P10). ✅
- **Observability (ADR-014):** full content-safety audit trail per moderation decision — classifier output, confidence, action, direction. ✅
- **GenAI-Native (ADR-015, ADR-017):** RAG foundation (chunking, retrieval, budget-aware context injection), pgvector embedding store, per-user AI context store / cognitive memory (P16), AI output explainability chain. ✅
- **Social:** user/group system (groups, memberships, invites) + 6 social agents (Guardian, Matchmaker, Gatekeeper, Concierge, Analyst, Curator). ✅
- **Agent runtime:** AgentRegistry, ToolRegistry, TrajectoryStore, BudgetTracker, `executeAgent()` loop; input agents (Conductor, audio classifier, intent). ✅

### ADRs & migrations

ADR-021 through ADR-026. Supabase migrations through 021 (social 015–016, pgvector 017, review queue 018–021).

### Metrics (Phase 4 close, PF v1.6.0)

| Repo                | Suites | Tests | Coverage (stmts / lines) |
| ------------------- | ------ | ----- | ------------------------ |
| platform-foundation | 154    | 2089  | 88.54% / 89.78%          |
| Playform            | 174    | 2371  | 89.41% / 90.43%          |

### Sprint 7 (delivered)

- **Sprint 7 — sync-cron hardening:** pin sync config + source refs (A), CI drift-detection for hand-ported excluded-shared files (B), exclude-anchor audit incl. ROADMAP.md protection (C), deletion policy (D), ops cleanup (E), Dependabot base branch (F). The `roadmap-consistency` CI check lands here so this section can never silently drift again.
- **Sprint 7 — provider conformance kits (ADR-027):** a provider-agnostic conformance kit (TCK) per abstraction, parametrized by a fixtures adapter, run against every reference impl and every concrete impl — Cognito as a consumer-owned arm; Google translate/TTS/STT, ACRCloud, Anthropic, Redis, and Supabase social/realtime as synced arms. A registry-driven meta-test (`conformance-coverage.test.ts`) fails CI if any provider slot lacks a kit, so the convention is machine-enforced rather than a checklist. Building the concrete arms surfaced and corrected six mock-biased contract assertions; reference impls added where missing (`MockAIProvider`, `createMockHealthProbe`). Standing rule L21 adopted.

---

## Phase 5 — Application Framework ⏳

**Objective:** Extensible application framework — consumers implement their specific app type on top.

### Application Framework

| Deliverable                                                   | Source                |
| ------------------------------------------------------------- | --------------------- |
| `platform/app-framework/` — application lifecycle abstraction | app-framework/ README |
| Application state management                                  | —                     |
| Turn-based and real-time application support                  | —                     |
| Application session lifecycle                                 | —                     |

### GenAI-Native (ADR-015, ADR-017)

| Deliverable                                                                                            | Rationale                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adaptive AI behavior — LLM-driven adaptive behavior framework                                          | GenAI touchpoint: not scripted, driven by AI                                                                                                          |
| Dynamic content generation — AI-generated contextual content                                           | GenAI touchpoint: contextual content                                                                                                                  |
| Application-specific RAG — domain knowledge, context injection                                         | RAG foundation (Phase 4) extended with app-specific knowledge bases                                                                                   |
| User-generated content screening                                                                       | New input surface must integrate safety middleware                                                                                                    |
| Agentic workflow framework — `platform/ai/agent.ts` with tool registry, multi-step execution, rollback | Admin command bar is one pattern; complex workflows (multi-step reasoning, evidence gathering, escalation) need reusable agent framework (ADR-017 §7) |
| Multimodal AI — image/audio input in provider interface, image generation                              | Language-learning needs visual and audio AI, not just text (ADR-017 §8)                                                                               |

---

## Phase 6 — Monetization Foundation ⏳

**Objective:** Subscription tiers, payments, and ad integration.

### Monetization

| Deliverable                                                 | Source                              |
| ----------------------------------------------------------- | ----------------------------------- |
| `platform/monetization/` — monetization engine              | monetization/ README                |
| Subscription tier permission differentiation (free vs paid) | 007_playform_subscription_tiers.sql |
| Payment integration                                         | —                                   |
| Ad network integration                                      | ADR-011                             |
| CSP updates for ad domains                                  | ADR-011                             |

### GenAI-Native (ADR-015, ADR-017)

| Deliverable                                                                      | Rationale                                                                                                |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Token budget system — per-subscription-tier token allowances                     | Free tier gets X tokens/month, paid tiers get more. Enforcement at orchestration layer.                  |
| Cost attribution per subscription tier                                           | Know how much AI each tier actually consumes                                                             |
| AI A/B testing — split-test prompt versions and model tiers against live traffic | Prompt iteration is gut feel without experimentation; essential before scaling monetization (ADR-017 §9) |

---

## Phase 7 — Analytics Foundation ⏳

**Objective:** User analytics, engagement metrics, and full observability.

### Analytics

| Deliverable                              | Source            |
| ---------------------------------------- | ----------------- |
| `platform/analytics/` — analytics engine | analytics/ README |
| User engagement metrics                  | —                 |
| Application performance analytics        | —                 |
| Admin analytics dashboard                | —                 |

### Observability (ADR-014)

| Deliverable                                                                   | Rationale                                              |
| ----------------------------------------------------------------------------- | ------------------------------------------------------ |
| AI quality monitoring — hallucination detection, user satisfaction signals    | Track response quality over time                       |
| User-level cost attribution — token cost per user, per feature, per app       | Business intelligence for AI spend                     |
| Full observability dashboards — error rates, latency percentiles, cost trends | Phase 7 is the analytics phase; dashboards belong here |

### GenAI-Native (ADR-015, ADR-017)

| Deliverable                                                                                                         | Rationale                                                                         |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Analytics intelligence — natural language querying ("how did I do this week?")                                      | GenAI touchpoint: NL interface to analytics                                       |
| Personalization — user experience adapted via behavior, skill, preferences                                          | Needs analytics data to drive personalization AI                                  |
| User feedback loop — thumbs up/down on AI responses, correction tracking, appeal outcomes feeding back into quality | Without closed-loop feedback, AI quality is static after deployment (ADR-017 §10) |

---

## Phase 8 — Consumer App Integration ⏳

**Objective:** Integration testing with first consumer application. Platform provides frameworks; consumer repos implement app-specific features.

### Consumer Integration Points

| Deliverable                              | Source        |
| ---------------------------------------- | ------------- |
| Integration test with first consumer app | Consumer repo |
| Full application lifecycle verification  | —             |

| Consumer-specific content pipeline | — |

### GenAI-Native (ADR-015)

| Deliverable                                                                  | Rationale                                                     |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Conversational onboarding framework — adaptive tutorials, contextual AI help | Platform provides framework; consumer customizes content      |
| Contextual AI support framework — assistant, dispute resolution, help        | Platform provides agent framework; consumer defines tools     |
| Anomaly detection — pattern recognition on user behavior                     | Platform provides detection framework; consumer defines rules |

### Content Safety (ADR-016)

| Deliverable                                       | Rationale                                              |
| ------------------------------------------------- | ------------------------------------------------------ |
| Real-time moderation for live content (sub-100ms) | New input surface; latency-critical for real-time apps |

---

## Phase 9 — Hardening & Launch ⏳

**Objective:** Production hardening, security audit, and public launch.

### Security Hardening

| Deliverable                                 | Source           |
| ------------------------------------------- | ---------------- |
| Nonce-based CSP (eliminate `unsafe-inline`) | ADR-011 TASK-025 |
| Full security audit                         | —                |
| Performance optimization                    | —                |
| Documentation finalization                  | —                |
| Public launch                               | —                |

### Observability (ADR-014)

| Deliverable                                                                             | Rationale                       |
| --------------------------------------------------------------------------------------- | ------------------------------- |
| Alerting & incident response — who gets paged at 2am? Runbooks for all scenarios.       | Launch readiness                |
| Chaos engineering — deliberately break things in staging                                | Find weaknesses before users do |
| Uptime SLA enforcement — monitoring against committed SLA, automated alerting on breach | Operational maturity for launch |

### GenAI-Native (ADR-015)

| Deliverable                                                                  | Rationale                                                 |
| ---------------------------------------------------------------------------- | --------------------------------------------------------- |
| AI hardening — fallback chains, circuit breakers, graceful model degradation | If primary model is down, degrade gracefully, don't crash |

### Content Safety (ADR-016)

| Deliverable                                                                               | Rationale                                              |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Legal audit hardening — full audit trail exportable for legal discovery, retention policy | Launch readiness for content moderation legal exposure |

---

## Deferred Items Registry

All items deferred from their original phase are tracked here with reassignment rationale.

| Item                            | Original Phase     | Reassigned To    | Rationale                                                                                 | Date       |
| ------------------------------- | ------------------ | ---------------- | ----------------------------------------------------------------------------------------- | ---------- |
| Redis CacheProvider             | Phase 1            | Phase 2          | Need Redis infrastructure first                                                           | 2026-03-28 |
| Redis rate limiter              | Phase 1            | Phase 2          | Need Redis infrastructure first                                                           | 2026-03-28 |
| Password enforcement            | Phase 1            | Phase 2          | Schema done, runtime enforcement needs Phase 2 auth hardening                             | 2026-03-28 |
| GDPR hard purge                 | Phase 1            | Phase 2          | Soft delete in Phase 1, hard purge needs careful validation                               | 2026-03-28 |
| Live Supabase integration tests | Phase 1 (Sprint 7) | Phase 2          | Mocked tests cover logic; live tests need staging DB                                      | 2026-04-01 |
| COPPA full implementation       | Phase 1            | Phase 4          | Schema + age gate done; full enforcement is content safety                                | 2026-03-30 |
| APM / monitoring                | Phase 3 (ADR-010)  | Phase 7          | Full dashboards better fit with analytics foundation; basic error tracking starts Phase 2 | 2026-04-03 |
| Nonce-based CSP                 | Phase 2 (ADR-011)  | Phase 9          | Not blocking; hardening-appropriate                                                       | 2026-04-03 |
| SEC-007 Vercel headers          | Phase 1            | Phase 3          | Low severity, needs Vercel config investigation                                           | 2026-03-24 |
| TASK-013 Song ID                | Phase 1            | Phase 3          | Language & voice is the right context                                                     | 2026-03-28 |
| CI-001 Node.js 24               | Phase 1            | Before June 2026 | GitHub deprecation deadline                                                               | 2026-04-01 |

---

## Standing Rules

These rules apply across all phases and are never deferred:

1. **Platform-foundation hardened first** — consumers inherit via auto-sync
2. **22-point sustainability gate** at every sprint boundary
3. **RAMPS assessment** at every phase boundary
4. **Tests written alongside code** — never after
5. **Full quality gate** (format, typecheck, lint, test:coverage, build) before every merge
6. **No Critical/High/Medium findings** enter a new phase unless formally deferred in SECURITY_DEBT.md
7. **Branch workflow:** feature/\* → develop → staging → main via PRs with CI required
8. **Versioned releases** on platform-foundation at every phase boundary (vX.Y.Z)
9. **Observability is fabric** — every new external API integration includes instrumentation from day one (ADR-014)
10. **GenAI goes through orchestration** — no raw `fetch()` to LLM APIs after Phase 2 (ADR-015)
11. **Safety middleware at every input AND output surface** — no input surface ships unscreened; no AI-generated output reaches a user unscreened (ADR-016, ADR-017)
12. **GenAI surface map is complete** — no new GenAI capability is added without placement in ADR-017's surface map. If it's not in the map, add it before building it (ADR-017)

---

## Changelog

All changes to this roadmap are logged here. Each entry includes date, author, and what changed.

| Version | Date       | Author    | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------- | ---------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 6.1.0   | 2026-06-09 | Raman Sud | Sprint 6 formal close + PF v1.5.0 release (annotated tag on d118cab). Cognito NEW*PASSWORD_REQUIRED challenge shipped end-to-end to both repos. Live Supabase reconciliation: permission vocab renamed to admin* prefix, new super_admin role, migrations 009-fix / 015 / 016-fix / 021. NewPasswordForm a11y fix. Playwright bumped to 1.60.0 (CI install-hang fix). ADR-026. Sprint 7 opened (sync-cron hardening). ROADMAP reconciled: Phase 2 marked complete, Phase 4 brought current with sprint table + metrics; Playform game overlay (Phase 5 Game Engine Abstraction, Phase 8 Game 1 Implementation) and title restored after the 2026-04-28 whole-file sync clobber (commit ace9bbf). |
| 1.0.0   | 2026-04-03 | Raman Sud | Initial roadmap — all 10 phases defined. Phase 0–1 complete. Deferred items assigned to Phases 2–9.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 1.1.0   | 2026-04-03 | Raman Sud | Pre-Phase 2 architectural review. Added ADR-014 (Observability), ADR-015 (GenAI-Native Stack), ADR-016 (Content Safety). All three woven into Phases 2–9 as cross-phase fabric with detailed per-phase deliverables. Added standing rules 9–11.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2.0.0   | 2026-04-03 | Raman Sud | Phase 2 started. 6-sprint plan added. Entry gate N1–N8 passed. Sprint order: LLM orchestration → content safety → observability → Redis hardening → real-time → integration tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2.1.0   | 2026-04-05 | Raman Sud | GenAI-native surface map audit (ADR-017). 10 gaps identified and placed: output screening (P2), streaming (P2), multi-language AI (P3), eval framework (P3), user context (P4), explainability (P4), agentic framework (P5), multimodal (P5), A/B testing (P6), feedback loop (P7). Standing rules 11 updated, rule 12 added.                                                                                                                                                                                                                                                                                                                                                                    |
| 3.0.0   | 2026-04-16 | Raman Sud | Phase 3 complete. 4 sprints delivered: translation provider, voice providers + chunker, agentic voice pipeline, song ID + audio format. 150 tests added (863→1013). ADR-019, ADR-020. 10 provider slots. Tagged v1.4.0.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 4.1.0   | 2026-04-24 | Raman Sud | Sprint 3a+3b complete. Config management agent (10 tools, approval, impact). Sentinel agent (strikes, consequence ladder). COPPA consent gate. Migration 011+012. 87 suites, 1428 tests, 84.86% coverage. L19 added. Gotchas 32-37.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 4.0.0   | 2026-04-18 | Raman Sud | Phase 4 started — Content Safety + Social System + Agent Runtime. Sprint 0: Sentry installed, instrumentation.ts wired, TASK-027/028/030 resolved, L14 added. 8 sprints planned, 6 agents, 3 new ADRs (021-023), embedding provider slot #11.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 2.2.0   | 2026-04-06 | Raman Sud | Sprint 3 complete: Observability fabric (platform/observability/ — error tracking, tracing, metrics, health). TASK-018 resolved (player→user rename, 52 files + migration 008). Docs generalized. PF tests: 473→545.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

| 4.2.0 | 2026-04-25 | Raman Sud | Sprint 3c catch-up. TASK-026 closed (ACRCloud rotation to paid project). SECURITY_DEBT.md scope narrowed to security-only; non-security tasks migrated to new TASKS.md. New ROTATION_RUNBOOK.md. Gotchas 38–40 added to ENGINEERING_LEARNINGS. platform/voice/GOTCHAS.md added (L17). 7 follow-up TASKs filed (038–044). |

| 4.3.0 | 2026-04-30 | Raman Sud | Sprint 4b complete. 5 social agent workflows (matchmaker, gatekeeper, concierge, analyst, curator) with versioned prompts. AgentClassifier + AgentIntentResolver (LLM-backed with P11 fallback) swap rule-based impls via conductor DI. scopeKey precedence bug fixed in runtime. 107 suites, 1683 tests, 86.83% coverage. |

| 4.4.0 | 2026-04-30 | Raman Sud | Sprint 4c complete. Playform social UI: 4 components (GroupHealthBadge, GroupCard, GroupRecommendations, TeamPanel), 2 hooks (useSocialAgents, useGroupMembership), SpikeApp wiring. 127 Playform suites, 1962 tests, 89.46% coverage. Gotcha 52 (sync collision rule). |

| 5.0.0 | 2026-05-18 | Raman Sud | Sprint 5 complete. RAG foundation in platform/rag/: document chunker (sliding-window + sentence), EmbeddingProvider interface (registry slot #13), InMemoryEmbeddingStore (cosine similarity), retrieval pipeline, context injector (sanitized, budget-aware), InMemoryUserContextStore (P16 cognitive memory), explainability builder. Migration 017 (pgvector tables). ADR-023. L20 (mid-session checkpoint). Gotchas 52-53. 115 suites, 1754 tests, 86.9% coverage. |

| 6.0.0 | 2026-05-31 | Raman Sud | Sprint 6 complete. Human review + appeals in platform/moderation/: review-types, review-store (InMemory + Supabase), review-service (claim/unclaim/resolve, appeal intake, overturn side-effects restoring the prior account status), API routes (review list/submit, claim/unclaim/resolve, appeal submit/resolve) gated on a new can_moderate permission, and advisory AI reviewer-assist (on-demand, fail-open). UI: ReviewDashboard (reasoning-forward card + assist banner) and AppealForm. Migration 018 (review_queue + RLS/indexes, moderator role + can_moderate granted to moderator/admin/super_admin, appeal config seeds). ADR-024, ADR-025. 127 suites, 1929 tests, 88.73% coverage. |

| 7.0.0 | 2026-06-11 | Raman Sud | Sprint 7 complete. Sync provenance hardening (SHA-pinned auto-sync, verified end-to-end via Playform PR #321) and the roadmap-consistency CI gate (items A/B). Provider conformance kit system per ADR-027 (Accepted): a provider-agnostic conformance kit (TCK) for all 16 abstractions under **tests**/contract/, a value-imported manifest, and a registry-driven meta-test (conformance-coverage) that fails CI if any provider slot lacks a kit. Reference mocks added where missing (MockAIProvider, createMockHealthProbe). Nine concrete-impl arms: Cognito (consumer-owned pattern), Google translate/TTS/STT, ACRCloud, Anthropic, Redis, Supabase social/realtime. Building the arms surfaced and fixed six mock-biased contract assertions; reconciliations: expiresAt pinned to epoch seconds (AuthSession/GuestTokenResult, mock converted, unit documented), challenge signIn now returns success:false consistently (mock aligned to Cognito). jest.setup.ts clears Sentry's version-keyed global carrier between suites, fixing a scheduling-dependent RangeError (roving victim suite). L21 adopted; registry doc fix. 153 suites, 2088 tests, 88.54% stmts / 89.78% lines. PF v1.6.0. |

| 7.1.0 | 2026-06-11 | Raman Sud | Phase 4 closed via exit gate E1-E15. RAMPS_PHASE4_ASSESSMENT.md committed (all 5 pillars GREEN); Sprint 7 22-point gate passed (2 Low findings, justified + tracked). README rewritten to Phase 4 state. GENAI_ROADMAP Phase 4 marked complete. SECURITY_DEBT: TASK-044 assigned Phase 8; SEC-001 remains formally deferred to Phase 9. Phase 4 final metrics recorded. Phase 5 (Application Framework) opens next session with entry gate N1-N8. |

_Last updated: 2026-06-11 (Phase 4 exit gate complete; changelog 7.1.0)_
