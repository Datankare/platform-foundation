# Technical Architecture Document (TAD)

**Project:** Platform Foundation — GenAI-Native Cross-Platform Application Platform  
**Version:** 1.0  
**Date:** March 2026  
**Status:** Approved  
**Repository:** github.com/Datankare/platform-foundation

---

See Platform Foundation_TAD_v1.0.docx for the full formatted version.

## Quick Reference

### Stack

- **Web:** Next.js 15+ + TypeScript + Tailwind CSS
- **Mobile:** React Native (Phase 3+)
- **Database:** PostgreSQL (Supabase) + JSONB + pgvector + Redis
- **Auth:** Supabase Auth (Google, Apple SSO)
- **LLM:** Anthropic Claude API (Haiku + Sonnet)
- **Voice:** Web Speech API + Google STT + Google Cloud TTS
- **Translation:** Google Translate API + Claude
- **Payments:** Stripe
- **Ads:** Google AdMob + Ad Manager
- **Hosting:** Vercel (3 environments) + AWS (Phase 3+)
- **CI/CD:** GitHub Actions (5-layer test pipeline)

### Environments

| Environment | Branch  | URL                                    |
| ----------- | ------- | -------------------------------------- |
| Local       | any     | localhost:3000                         |
| Dev         | develop | platform-foundation-dev.vercel.app     |
| Staging     | staging | platform-foundation-staging.vercel.app |
| Production  | main    | platform-foundation-inky.vercel.app    |

### Current API

| Method | Endpoint     | Description                           |
| ------ | ------------ | ------------------------------------- |
| GET    | /api/health  | Platform health check                 |
| POST   | /api/process | Text/voice → safety → translate → TTS |

### ADR Index

- ADR-001: Platform and Game Layer Separation
- ADR-002: Next.js + React Stack
- ADR-003: GenAI-Native Architecture
- ADR-004: Four Governing Principles
- ADR-005: Content Safety Architecture
- ADR-006: Database Architecture

---

_Confidential & Proprietary — Datankare — March 2026_
