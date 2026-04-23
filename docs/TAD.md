# Technical Architecture Document (TAD)

**Project:** Platform Foundation — Reusable Platform Template
**Version:** 2.0
**Date:** March 2026
**Status:** Approved
**Repository:** github.com/Datankare/platform-foundation

---

## Purpose

Platform Foundation is a reusable platform template. All security
primitives, architectural patterns, and platform infrastructure are
established here first, then propagated to consumer applications.
Never the reverse.

## Stack

| Layer       | Technology           | Notes                             |
| ----------- | -------------------- | --------------------------------- |
| Framework   | Next.js 16.2+        | App Router, serverless API routes |
| Language    | TypeScript           | strict: true                      |
| Styling     | Tailwind CSS         | Utility-first                     |
| LLM         | Anthropic Claude API | Haiku + Sonnet                    |
| Translation | Google Translate API | X-Goog-Api-Key header auth        |
| TTS         | Google Cloud TTS     | Neural2/Wavenet voices            |
| Hosting     | Vercel               | 3 environments                    |
| CI/CD       | GitHub Actions       | 5-layer pipeline                  |

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

| Method | Route        | Description                                |
| ------ | ------------ | ------------------------------------------ |
| GET    | /api/health  | Service liveness — no key presence exposed |
| POST   | /api/process | Text → safety → translate → TTS            |

## ADR Index

| ADR     | Title                                   |
| ------- | --------------------------------------- |
| ADR-001 | Platform and Game Layer Separation      |
| ADR-002 | Next.js + React Stack                   |
| ADR-003 | GenAI-Native Architecture               |
| ADR-004 | Four Governing Principles               |
| ADR-005 | Content Safety Architecture             |
| ADR-006 | Database Architecture                   |
| ADR-007 | Monorepo Structure                      |
| ADR-008 | Input Pipeline Architecture             |
| ADR-009 | Security Standards and OWASP Compliance |

---

_Confidential & Proprietary — Datankare — March 2026_

_Last updated: April 23, 2026 (Sprint 3a close — footer added per L16)_
