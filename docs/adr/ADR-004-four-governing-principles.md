# ADR-004 — Four Governing Principles

**Status:** Accepted
**Date:** 2026-03-18

## Context

Without explicit governing principles, teams make inconsistent decisions,
defer quality work, and accumulate technical debt silently. We need a small
set of named, non-negotiable principles that every decision is evaluated against.

## Decision

Four principles govern every architectural and engineering decision:

**RAMPS** — Reliability · Accessibility (WCAG 2.2) · Manageability ·
Performance · Security. Built into the fabric from day one — never retrofitted.

**AAA** — Authentication · Authorization · Analytics. First-class platform
citizens that power every feature, every application, and every user interaction.

**Foundation as Fabric** — All infrastructure, compliance, operational, and
platform capabilities are non-negotiable requirements. None are optional.
None are bolt-ons. Each is woven into the platform incrementally, phase by
phase, as a first-class citizen — not retrofitted, not deferred indefinitely,
and never treated as secondary to game features.

**Continuous Confidence** — The test architecture is a first-class platform
citizen. The full suite is runnable at any time, completes within 60 minutes,
and produces a single trustworthy answer: green means nothing is broken —
anywhere, at any layer, on any platform. A change is not done until its tests
are done. No exceptions.

## Security Requirements (RAMPS — Security Pillar)

OWASP Top 10 (2021) compliance is the baseline standard. Every phase must
address all applicable categories before shipping:

- API credentials: X-Goog-Api-Key header only — never in URLs (OWASP A02)
- User input: sanitized before embedding in LLM prompts (OWASP A03)
- Security headers: CSP, X-Frame-Options, HSTS required (OWASP A05)
- Structured logging: every API route must use lib/logger.ts (OWASP A09)
- No silent debt: every security deferral documented in SECURITY_DEBT.md

## Consequences

- Every code review asks: does this honor RAMPS, AAA, Foundation as Fabric,
  and Continuous Confidence?
- Technical debt is never silent — it is always named, documented, and assigned
  a resolution phase
- Accessibility is designed in, not bolted on — WCAG 2.2 as a floor
- Test coverage is a requirement, not a metric
- Security is considered at every layer, not just at deployment
