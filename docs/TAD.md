# Technical Architecture Document (TAD)

**Project:** Platform Foundation — Reusable Platform Template
**Version:** 2.0.0
**Date:** September 2026
**Status:** Approved
**Repository:** github.com/Datankare/platform-foundation

---

## Purpose

Platform Foundation is a reusable platform template. All security
primitives, architectural patterns, and platform infrastructure are
established here first, then propagated to consumer applications.
Never the reverse.

## Architecture layers

```
Consumer application (product code, own vocabulary)
        │  inherits + syncs from ▼
┌─────────────────────────────────────────────────────────────┐
│  Application & agentic-workflow framework (ADR-028/029/031)  │
│  durable trajectories · budgets · proposals · held actions   │
│  · approve/resume · effect ledger · three-valued outcomes    │
├─────────────────────────────────────────────────────────────┤
│  Agents (ADR-022/030): input · processing · social clusters  │
├─────────────────────────────────────────────────────────────┤
│  Governed authority (ADR-033/034/035): two-principal check · │
│  trusted-agent registry · attested delegation · per-account  │
│  restriction · GenAI-native governance admin                 │
├─────────────────────────────────────────────────────────────┤
│  Platform services: Auth · AI · Safety/Moderation · Social · │
│  Language/Voice · Embedding/RAG · Realtime — all providers   │
├─────────────────────────────────────────────────────────────┤
│  Observability: traces · metrics · Sentry · append-only audit│
├─────────────────────────────────────────────────────────────┤
│  Data: Supabase · pgvector · ltree · migrations              │
└─────────────────────────────────────────────────────────────┘
```

For the agent and governance layers in depth see `docs/AGENT_ARCHITECTURE.md`; for how a
consumer adopts and syncs, `docs/SETUP_AND_INTEGRATION.md`.

## Stack

| Layer                   | Technology            | Notes                                                              |
| ----------------------- | --------------------- | ------------------------------------------------------------------ |
| Framework               | Next.js 16.2          | App Router, serverless API routes                                  |
| UI                      | React 19              |                                                                    |
| Language                | TypeScript 5 (strict) | strict: true                                                       |
| Styling                 | Tailwind CSS 4        | Utility-first                                                      |
| LLM                     | Anthropic Claude API  | Haiku + Sonnet; provider-swappable                                 |
| Auth                    | AWS Cognito           | provider-swappable (mock default)                                  |
| Data                    | Supabase (Postgres)   | pgvector, ltree, RLS                                               |
| Cache                   | Upstash Redis         | provider-swappable (memory default)                                |
| Translation / TTS / STT | Google Cloud          | provider-swappable (mock default)                                  |
| Song ID                 | ACRCloud              | provider-swappable (mock default)                                  |
| Errors                  | Sentry                | provider-swappable (noop default)                                  |
| Hosting                 | Vercel                | 3 environments (dev/staging/prod)                                  |
| CI/CD                   | GitHub Actions        | Continuous Confidence pipeline (audit/type/lint/format/test/build) |

Every external dependency is a swappable provider defaulting to a mock/in-memory
implementation, so the platform boots and tests pass with no configuration. See
`docs/ENV_REFERENCE.md`.

## Security Architecture

### OWASP Top 10 Compliance — see ADR-009 for full mapping

- **A02** ✅ — X-Goog-Api-Key header only, never URL params
- **A03** ✅ — sanitizeForPrompt() at all LLM input surfaces
- **A05** ✅ — CSP + security headers in next.config.ts
- **A09** ✅ — lib/logger.ts structured logging platform-wide
- **A01, A04, A07** ⏳ — Phase 1

### Security Primitives

- `lib/logger.ts` — structured JSON logging, 5 levels, runtime-configurable
- `lib/sanitize.ts` — prompt injection defense, log sanitization

## API Inventory

Grouped by area (38 routes). All mutating routes are auth-guarded; admin routes require the
relevant admin permission; agent routes are governed by the two-principal check.

**Core**

- `GET /api/health` — liveness (no key presence exposed)
- `POST /api/process` — text → safety → translate → TTS
- `POST /api/stream` — streaming pipeline

**Auth** — `/api/auth/*`: sign-in, sign-up, sign-out, guest, verify-email,
resend-verification, forgot-password, confirm-forgot-password, mfa-challenge,
new-password-challenge

**Agent** — `GET /api/agent/capabilities` (goal discovery); agent invocation flows through the
process/stream routes under the governed authority layer; delegation consent/token endpoints
are consumer-side (see AGENT_DELEGATION_GUIDE)

**Admin (GenAI-native governance)** — `/api/admin/*`:

- AI command bar: `ai`, `ai/execute` (plan → confirm → execute)
- Governance panels: `agent-registry`, `approval-policy`, `capabilities`,
  `capability-mapping`, `per-account`
- Platform: `config`, `config-ai`, `config-ai/execute`, `roles`, `users`, `entitlements`,
  `guest-config`, `password-policy`, `audit`, `gdpr`

**Moderation** — `/api/moderation/*`: `appeals`, `appeals/[id]`, `review`, `review/[id]`,
`review/[id]/assist`

## ADR Index

| ADR     | Title                                         |
| ------- | --------------------------------------------- |
| ADR-001 | Platform / Game Layer Separation              |
| ADR-002 | Next.js + React Stack                         |
| ADR-003 | GenAI-Native Architecture                     |
| ADR-004 | Four Governing Principles                     |
| ADR-005 | Content Safety Architecture                   |
| ADR-006 | Database Architecture                         |
| ADR-007 | Monorepo Structure                            |
| ADR-008 | Input Pipeline Architecture                   |
| ADR-009 | Security Standards & OWASP Compliance         |
| ADR-010 | OWASP Controls                                |
| ADR-011 | Security Headers                              |
| ADR-012 | Auth Architecture                             |
| ADR-013 | Role Hierarchy                                |
| ADR-014 | Observability Architecture                    |
| ADR-015 | GenAI-Native Stack                            |
| ADR-016 | Content Safety Architecture                   |
| ADR-017 | GenAI-Native Surface Map                      |
| ADR-018 | Realtime Architecture                         |
| ADR-019 | Voice Pipeline Architecture                   |
| ADR-020 | Song Identification                           |
| ADR-021 | Social System Architecture                    |
| ADR-022 | Agent Runtime Architecture                    |
| ADR-023 | RAG Architecture                              |
| ADR-024 | Human Review & Appeals                        |
| ADR-025 | Reviewer Assist                               |
| ADR-026 | Database Reconciliation                       |
| ADR-027 | Provider Conformance Kits                     |
| ADR-028 | Application Framework                         |
| ADR-029 | Agentic Workflow Framework                    |
| ADR-030 | Agent User Experience                         |
| ADR-031 | Action Identity & Lifecycle                   |
| ADR-032 | Bundle-Safe Singletons                        |
| ADR-033 | Agent Identity (rung 2 — attested delegation) |
| ADR-034 | Per-Account Feature Restriction               |
| ADR-035 | GenAI-Native Governance Admin                 |

---

_Confidential & Proprietary — Datankare — March 2026_

_Last reviewed: September 2026 (v2.0.0 — Phase 5 agent + governance framework)_
