# Platform Foundation — Product Roadmap

**Owner:** Raman Sud, CTO
**Canonical location:** `docs/ROADMAP.md` (both platform-foundation and playform repos)
**Versioning:** Every change to this document is logged in the Changelog at the bottom.
**Rule:** This document is updated at the start and end of every phase. Changes between phases are logged with date, author, and rationale.

---

## Phase Summary

| Phase | Name                         | Status         | PF Release | Started    | Completed  |
| ----- | ---------------------------- | -------------- | ---------- | ---------- | ---------- |
| 0     | Platform Scaffolding         | ✅ Complete    | —          | 2026-03-15 | 2026-03-18 |
| 0.5   | Input Reliability Sprint     | ✅ Complete    | —          | 2026-03-18 | 2026-03-20 |
| 0.75  | E2E Test Suite               | ✅ Complete    | —          | 2026-03-20 | 2026-03-22 |
| 1     | Identity & Access Foundation | ✅ Complete    | v1.1.0     | 2026-03-22 | 2026-04-02 |
| 2     | Communication Foundation     | 🔄 In Progress | —          | 2026-04-03 | —          |
| 3     | Language & Voice Foundation  | ⏳ Upcoming    | —          | —          | —          |
| 4     | Content Safety Foundation    | ⏳ Upcoming    | —          | —          | —          |
| 5     | Application Framework        | ⏳ Upcoming    | —          | —          | —          |
| 6     | Monetization Foundation      | ⏳ Upcoming    | —          | —          | —          |
| 7     | Analytics Foundation         | ⏳ Upcoming    | —          | —          | —          |
| 8     | Consumer App Integration     | ⏳ Upcoming    | —          | —          | —          |
| 9     | Hardening & Launch           | ⏳ Upcoming    | —          | —          | —          |

### Cross-Phase Fabric

Four architectural commitments span all phases (see ADR-014, ADR-015, ADR-016, ADR-017):

| Fabric             | Principle                                                                                  | Starts  |
| ------------------ | ------------------------------------------------------------------------------------------ | ------- |
| Observability      | Woven in, not bolted on. Every phase adds its observability layer.                         | Phase 2 |
| GenAI-Native       | Infrastructure, not a feature. Every AI interaction goes through orchestration.            | Phase 2 |
| Content Safety     | Multi-layer defense. Every input AND output surface screened from day one.                 | Phase 2 |
| GenAI Completeness | No GenAI capability discovered late. Complete surface map in ADR-017, verified at Phase 9. | Phase 2 |

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

## Phase 2 — Communication Foundation 🔄

**Objective:** WebSocket/real-time infrastructure, plus the three cross-phase fabric foundations (observability, GenAI-native stack, content safety).

**Prerequisites:** Phase 1 complete, Redis infrastructure available.

### Sprint Plan

| Sprint | Scope                               | Depends On                          | Status      |
| ------ | ----------------------------------- | ----------------------------------- | ----------- |
| 1      | LLM Orchestration + Prompt Registry | —                                   | ✅ Complete |
| 2      | Content Safety Refactor             | Sprint 1 (uses orchestrator)        | ✅ Complete |
| 3      | Observability Fabric + TASK-018     | Sprint 1 (instruments orchestrator) | ✅ Complete |
| 4      | Redis + Infrastructure Hardening    | External: Upstash Redis             | ✅ Complete |
| 4b     | Auth Wiring — Live Login Screen     | Sprint 4 (auth components exist)    | ⏳ Next     |
| 5      | Real-Time / WebSocket               | Sprint 4 (Redis for pub/sub)        | ⏳ Upcoming |
| 6      | Integration Tests + Phase Gate      | All prior sprints                   | ⏳ Upcoming |

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

## Phase 3 — Language & Voice Foundation ⏳

**Objective:** Advanced language processing and voice interaction.

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

## Phase 4 — Content Safety Foundation ⏳

**Objective:** Full COPPA implementation, content moderation engine, and human review.

### Content Safety (ADR-016)

| Deliverable                                                      | Rationale                                               |
| ---------------------------------------------------------------- | ------------------------------------------------------- |
| `platform/moderation/` — full moderation engine                  | Placeholder README since Phase 0                        |
| COPPA full implementation (enforcement, not just schema)         | coppa.ts: schema in Phase 1, enforcement in Phase 4     |
| Parental consent workflows (email verification, status tracking) | coppa.ts                                                |
| Age-gated content delivery based on content rating levels        | Content rating levels (1/2/3) exist but aren't enforced |
| Human review queue — admin UI for edge cases and moderation      | No moderation queue exists                              |
| Account consequences — strike counter: warn → suspend → ban      | Only response today is 422                              |
| User reporting — report button, feeds moderation queue           | No reporting mechanism                                  |
| Appeal workflow — user submits appeal, human reviewer decides    | No appeal path                                          |

### Observability (ADR-014)

| Deliverable                                                                                                         | Rationale                                    |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Content safety audit trail — every moderation decision with full classifier output, confidence, action, user rating | Legal defensibility for moderation decisions |

### GenAI-Native (ADR-015, ADR-017)

| Deliverable                                                                          | Rationale                                                                                       |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| RAG foundation — document chunking, context injection, retrieval pipeline            | Domain knowledge and user history need to feed into AI interactions                             |
| Embedding store — pgvector extension on Supabase                                     | Semantic search and personalization foundation                                                  |
| User AI context store — per-user interaction history, learning patterns, preferences | Each AI interaction starts cold today; personalization requires persistent context (ADR-017 §5) |
| AI output explainability — explanation chain for every AI decision                   | Audit trail logs what, not why; human review queue needs explainability (ADR-017 §6)            |

### Social

| Deliverable                                               | Rationale                         |
| --------------------------------------------------------- | --------------------------------- |
| Friends/groups system (profile "friends" visibility tier) | profile.ts: deferred from Phase 3 |

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

| Version | Date       | Author    | Change                                                                                                                                                                                                                                                                                                                        |
| ------- | ---------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.0.0   | 2026-04-03 | Raman Sud | Initial roadmap — all 10 phases defined. Phase 0–1 complete. Deferred items assigned to Phases 2–9.                                                                                                                                                                                                                           |
| 1.1.0   | 2026-04-03 | Raman Sud | Pre-Phase 2 architectural review. Added ADR-014 (Observability), ADR-015 (GenAI-Native Stack), ADR-016 (Content Safety). All three woven into Phases 2–9 as cross-phase fabric with detailed per-phase deliverables. Added standing rules 9–11.                                                                               |
| 2.0.0   | 2026-04-03 | Raman Sud | Phase 2 started. 6-sprint plan added. Entry gate N1–N8 passed. Sprint order: LLM orchestration → content safety → observability → Redis hardening → real-time → integration tests.                                                                                                                                            |
| 2.1.0   | 2026-04-05 | Raman Sud | GenAI-native surface map audit (ADR-017). 10 gaps identified and placed: output screening (P2), streaming (P2), multi-language AI (P3), eval framework (P3), user context (P4), explainability (P4), agentic framework (P5), multimodal (P5), A/B testing (P6), feedback loop (P7). Standing rules 11 updated, rule 12 added. |
| 2.2.0   | 2026-04-06 | Raman Sud | Sprint 3 complete: Observability fabric (platform/observability/ — error tracking, tracing, metrics, health). TASK-018 resolved (player→user rename, 52 files + migration 008). Docs generalized. PF tests: 473→545.                                                                                                          |
