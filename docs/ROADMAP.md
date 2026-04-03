# Playform — Product Roadmap

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
| 2     | Communication Foundation     | ⏳ Upcoming | —          | —          | —          |
| 3     | Language & Voice Foundation  | ⏳ Upcoming | —          | —          | —          |
| 4     | Content Safety Foundation    | ⏳ Upcoming | —          | —          | —          |
| 5     | Game Engine Abstraction      | ⏳ Upcoming | —          | —          | —          |
| 6     | Monetization Foundation      | ⏳ Upcoming | —          | —          | —          |
| 7     | Analytics Foundation         | ⏳ Upcoming | —          | —          | —          |
| 8     | Game 1 Implementation        | ⏳ Upcoming | —          | —          | —          |
| 9     | Hardening & Launch           | ⏳ Upcoming | —          | —          | —          |

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
| 4      | Player profiles, devices, consent, COPPA, password policy         | +16         |
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
| Player profiles with per-field visibility             | ✅     |
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

## Phase 2 — Communication Foundation ⏳

**Objective:** WebSocket/real-time infrastructure for multiplayer and live features.
**Prerequisites:** Phase 1 complete, Redis infrastructure available.

### Planned Deliverables

| Deliverable                                              | Source/Rationale                      |
| -------------------------------------------------------- | ------------------------------------- |
| `platform/realtime/` — WebSocket engine                  | ADR-007 Phase 2 roadmap               |
| Redis-backed permissions cache (CacheProvider interface) | permissions-cache.ts deferred comment |
| Redis-backed rate limiter (multi-instance)               | rate-limit.ts deferred comment        |
| Password policy enforcement (runtime, not just schema)   | password-policy.ts deferred comment   |
| GDPR hard purge implementation                           | gdpr-deletion.ts Phase 2 comment      |
| Integration tests against live Supabase + Cognito        | TASK-014 (Sprint 7 deferred)          |
| Cross-origin WebSocket CSP rules                         | ADR-011 Phase 2 note                  |

### Carried Forward from Phase 1

| Item                              | ID       | Severity                  |
| --------------------------------- | -------- | ------------------------- |
| CacheProvider interface (Redis)   | TASK-015 | Medium                    |
| CI-001: GitHub Actions Node.js 24 | CI-001   | Low (deadline: June 2026) |

---

## Phase 3 — Language & Voice Foundation ⏳

**Objective:** Advanced language processing and voice interaction.

### Planned Deliverables

| Deliverable                               | Source/Rationale                |
| ----------------------------------------- | ------------------------------- |
| `platform/voice/` — Voice pipeline engine | ADR-007 Phase 3 roadmap         |
| Song identification (ACRCloud/AudD.io)    | TASK-013                        |
| Advanced translation features             | platform/translation/ README    |
| Vercel security headers (SEC-007)         | SECURITY_DEBT.md — low severity |

---

## Phase 4 — Content Safety Foundation ⏳

**Objective:** Full COPPA implementation and content moderation.

### Planned Deliverables

| Deliverable                                               | Source/Rationale              |
| --------------------------------------------------------- | ----------------------------- |
| `platform/moderation/` — Content moderation engine        | moderation/ README            |
| COPPA full implementation (enforcement, not just schema)  | coppa.ts Phase 4 comment      |
| Parental consent workflows (email verification)           | coppa.ts                      |
| Age-gated content delivery                                | Content rating levels (1/2/3) |
| Friends/groups system (profile "friends" visibility tier) | profile.ts Phase 3/4 comment  |

---

## Phase 5 — Game Engine Abstraction ⏳

**Objective:** Generic game engine that supports multiple game types.

### Planned Deliverables

| Deliverable                                       | Source/Rationale    |
| ------------------------------------------------- | ------------------- |
| `platform/game-engine/` — Game engine abstraction | game-engine/ README |
| Game state management                             | —                   |
| Turn-based and real-time game support             | —                   |
| Game session lifecycle                            | —                   |

---

## Phase 6 — Monetization Foundation ⏳

**Objective:** Subscription tiers, payments, and ad integration.

### Planned Deliverables

| Deliverable                                                 | Source/Rationale                    |
| ----------------------------------------------------------- | ----------------------------------- |
| `platform/monetization/` — Monetization engine              | monetization/ README                |
| Subscription tier permission differentiation (free vs paid) | 007_playform_subscription_tiers.sql |
| Payment integration                                         | —                                   |
| Ad network integration                                      | ADR-011 Phase 6 note                |
| CSP updates for ad domains                                  | ADR-011                             |

---

## Phase 7 — Analytics Foundation ⏳

**Objective:** Player analytics, engagement metrics, and monitoring.

### Planned Deliverables

| Deliverable                              | Source/Rationale             |
| ---------------------------------------- | ---------------------------- |
| `platform/analytics/` — Analytics engine | analytics/ README            |
| APM / structured monitoring              | ADR-010 Phase 3→7 reassigned |
| Player engagement metrics                | —                            |
| Game performance analytics               | —                            |
| Admin analytics dashboard                | —                            |

---

## Phase 8 — Game 1 Implementation ⏳

**Objective:** First complete game built on the platform.

### Planned Deliverables

| Deliverable                                  | Source/Rationale      |
| -------------------------------------------- | --------------------- |
| `games/game-01/` — First game implementation | games/game-01/ README |
| Full gameplay loop                           | —                     |
| Leaderboards                                 | —                     |
| Social sharing                               | —                     |
| Game-specific content                        | —                     |

---

## Phase 9 — Hardening & Launch ⏳

**Objective:** Production hardening, security audit, and public launch.

### Planned Deliverables

| Deliverable                                 | Source/Rationale   |
| ------------------------------------------- | ------------------ |
| Nonce-based CSP (eliminate `unsafe-inline`) | ADR-011 TASK-025   |
| Full security audit                         | —                  |
| Performance optimization                    | —                  |
| Load testing at scale                       | k6 pipeline exists |
| Documentation finalization                  | —                  |
| Public launch                               | —                  |

---

## Deferred Items Registry

All items deferred from their original phase are tracked here with reassignment rationale.

| Item                            | Original Phase     | Reassigned To    | Rationale                                                     | Date       |
| ------------------------------- | ------------------ | ---------------- | ------------------------------------------------------------- | ---------- |
| Redis CacheProvider             | Phase 1            | Phase 2          | Need Redis infrastructure first                               | 2026-03-28 |
| Redis rate limiter              | Phase 1            | Phase 2          | Need Redis infrastructure first                               | 2026-03-28 |
| Password enforcement            | Phase 1            | Phase 2          | Schema done, runtime enforcement needs Phase 2 auth hardening | 2026-03-28 |
| GDPR hard purge                 | Phase 1            | Phase 2          | Soft delete in Phase 1, hard purge needs careful validation   | 2026-03-28 |
| Live Supabase integration tests | Phase 1 (Sprint 7) | Phase 2          | Mocked tests cover logic; live tests need staging DB          | 2026-04-01 |
| COPPA full implementation       | Phase 1            | Phase 4          | Schema + age gate done; full enforcement is content safety    | 2026-03-30 |
| APM / monitoring                | Phase 3 (ADR-010)  | Phase 7          | Better fit with analytics foundation                          | 2026-04-03 |
| Nonce-based CSP                 | Phase 2 (ADR-011)  | Phase 9          | Not blocking; hardening-appropriate                           | 2026-04-03 |
| SEC-007 Vercel headers          | Phase 1            | Phase 3          | Low severity, needs Vercel config investigation               | 2026-03-24 |
| TASK-013 Song ID                | Phase 1            | Phase 3          | Language & voice is the right context                         | 2026-03-28 |
| CI-001 Node.js 24               | Phase 1            | Before June 2026 | GitHub deprecation deadline                                   | 2026-04-01 |

---

## Standing Rules

These rules apply across all phases and are never deferred:

1. **Platform-foundation hardened first** — Playform inherits via auto-sync
2. **22-point sustainability gate** at every sprint boundary
3. **RAMPS assessment** at every phase boundary
4. **Tests written alongside code** — never after
5. **Full quality gate** (format, typecheck, lint, test:coverage, build) before every merge
6. **No Critical/High/Medium findings** enter a new phase unless formally deferred in SECURITY_DEBT.md
7. **Branch workflow:** feature/\* → develop → staging → main via PRs with CI required
8. **Versioned releases** on platform-foundation at every phase boundary (vX.Y.Z)

---

## Changelog

All changes to this roadmap are logged here. Each entry includes date, author, and what changed.

| Version | Date       | Author    | Change                                                                                              |
| ------- | ---------- | --------- | --------------------------------------------------------------------------------------------------- |
| 1.0.0   | 2026-04-03 | Raman Sud | Initial roadmap — all 10 phases defined. Phase 0–1 complete. Deferred items assigned to Phases 2–9. |
