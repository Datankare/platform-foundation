# ADR-010 — OWASP Top 10 Control Mapping

**Status:** Accepted
**Date:** 2026-03-25

## Context

The OWASP Top 10 (2021) is the industry-standard classification of the most
critical web application security risks. The platform specification commits
to "OWASP Top 10 addressed" under the RAMPS Security pillar. This ADR
formalizes how each category is addressed and ensures no category is left
unaccounted for.

## Decision

Every OWASP Top 10 category is mapped to one or more specific platform
controls. The mapping is maintained as a living document at
`docs/OWASP_CONTROLS.md` and updated with every phase. No category may
be left as "intent only" — each must have either an active control or a
formally deferred item with a phase assignment.

## Mapping Summary

| #   | Category                  | Primary Control                                         |
| --- | ------------------------- | ------------------------------------------------------- |
| A01 | Broken Access Control     | Auth middleware + RLS (Phase 1)                         |
| A02 | Cryptographic Failures    | HTTPS, JWT via auth provider, no custom crypto          |
| A03 | Injection                 | Input validation, TypeScript strict, SAST (CodeQL)      |
| A04 | Insecure Design           | ADR framework, threat modeling per phase                |
| A05 | Security Misconfiguration | Security headers (9 headers), DAST (OWASP ZAP)          |
| A06 | Vulnerable Components     | npm audit in CI, Dependabot                             |
| A07 | Auth Failures             | Auth provider (battle-tested), rate limiting            |
| A08 | Data Integrity Failures   | CI quality gates, branch protection                     |
| A09 | Logging & Monitoring      | Structured logging, APM (deferred to Phase 3)           |
| A10 | SSRF                      | No user-controlled URLs currently; allowlist when added |

See `docs/OWASP_CONTROLS.md` for full detail on each control including
implementation status, verification method, and phase assignment.

## Consequences

- Every OWASP category has a named owner (a control, a tool, or a deferred
  item with a phase)
- Phase completion gates include OWASP compliance verification
- New features are evaluated against the OWASP mapping before merge
- The mapping document is updated with every phase — never allowed to drift
