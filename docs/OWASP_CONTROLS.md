# OWASP Top 10 (2021) — Control Mapping

**Last updated:** 2026-03-25
**ADR:** ADR-010

This document maps each OWASP Top 10 category to the specific controls
implemented in this platform. It is a living document updated with every
phase. No category may be left unaddressed.

---

## A01 — Broken Access Control

**Risk:** Users act outside their intended permissions.

| Control                   | Implementation                                                   | Status                           |
| ------------------------- | ---------------------------------------------------------------- | -------------------------------- |
| Authentication middleware | Auth provider integration on all protected routes                | Template — implement per project |
| Row-Level Security        | Database RLS policies enforce data isolation                     | Template — implement per project |
| Server-side authorization | Tier/role checks in API routes, never client-only                | Template — implement per project |
| Default deny              | Routes are protected by default; public routes explicitly marked | Template — implement per project |

**Verification:** Auth integration tests, RLS policy tests, manual penetration testing.

---

## A02 — Cryptographic Failures

**Risk:** Exposure of sensitive data due to weak or missing encryption.

| Control                   | Implementation                                             | Status    |
| ------------------------- | ---------------------------------------------------------- | --------- |
| HTTPS everywhere          | HSTS header with preload (max-age=63072000)                | ✅ Active |
| No custom crypto          | JWT handled by auth provider, not hand-rolled              | ✅ Active |
| Secrets management        | Environment variables, never in code; .env.example pattern | ✅ Active |
| No sensitive data in URLs | API keys in headers, not query parameters                  | ✅ Active |

**Verification:** HSTS header check, code review for hardcoded secrets, SAST scan.

---

## A03 — Injection

**Risk:** Hostile data sent to an interpreter as part of a command or query.

| Control                | Implementation                                               | Status                           |
| ---------------------- | ------------------------------------------------------------ | -------------------------------- |
| TypeScript strict mode | Eliminates entire classes of type-confusion injection        | ✅ Active                        |
| Input validation       | All API routes validate input shape and size                 | ✅ Active                        |
| Parameterized queries  | ORM/query builder with parameterized queries (when DB added) | Template — implement per project |
| SAST                   | CodeQL scans for injection patterns                          | Implement per Sprint 2           |
| LLM input sanitization | sanitizeForPrompt() on all LLM input surfaces                | ✅ Active                        |

**Verification:** CodeQL SAST, unit tests for input validation, sanitization tests.

---

## A04 — Insecure Design

**Risk:** Missing or ineffective security controls due to flawed design.

| Control                   | Implementation                                                   | Status    |
| ------------------------- | ---------------------------------------------------------------- | --------- |
| ADR framework             | All architecture decisions documented with security implications | ✅ Active |
| Four governing principles | RAMPS, AAA, Foundation as Fabric, Continuous Confidence          | ✅ Active |
| Threat modeling           | Security review per phase before implementation                  | ✅ Active |
| Definition of Done        | Includes security and fabric obligations                         | ✅ Active |

**Verification:** ADR review, phase completion gate checklist.

---

## A05 — Security Misconfiguration

**Risk:** Missing or incorrect security configuration.

| Control                | Implementation                                                                                                        | Status                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 9 security headers     | CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, X-XSS-Protection, COOP, CORP | ✅ Active              |
| DAST scanning          | OWASP ZAP baseline scan catches misconfigurations                                                                     | Implement per Sprint 2 |
| No default credentials | Auth provider handles credential management                                                                           | ✅ Active              |
| Error handling         | Structured errors, no stack traces in production responses                                                            | ✅ Active              |

**Verification:** OWASP ZAP scan, curl header check, code review.

---

## A06 — Vulnerable and Outdated Components

**Risk:** Using components with known vulnerabilities.

| Control          | Implementation                                      | Status                 |
| ---------------- | --------------------------------------------------- | ---------------------- |
| npm audit        | Dependency vulnerability scanning                   | ✅ Active (manual)     |
| npm audit in CI  | Fail build on critical/high vulnerabilities         | Implement per Sprint 4 |
| Dependabot       | Automated dependency update PRs                     | Implement per Sprint 4 |
| SECURITY_DEBT.md | Known vulnerabilities tracked with resolution plans | ✅ Active              |

**Verification:** CI pipeline npm audit step, Dependabot PR review cadence.

---

## A07 — Identification and Authentication Failures

**Risk:** Weak authentication allowing identity compromise.

| Control            | Implementation                                 | Status                           |
| ------------------ | ---------------------------------------------- | -------------------------------- |
| Auth provider      | Battle-tested provider (not hand-rolled)       | Template — implement per project |
| Session management | Short-lived JWTs + refresh tokens              | Template — implement per project |
| Rate limiting      | Per-endpoint throttling to prevent brute force | Template — implement per project |
| COPPA compliance   | Age verification for under-13 users            | Template — implement per project |

**Verification:** Auth integration tests, rate limit tests, session expiry tests.

---

## A08 — Software and Data Integrity Failures

**Risk:** Code and infrastructure lacking integrity verification.

| Control                      | Implementation                                             | Status    |
| ---------------------------- | ---------------------------------------------------------- | --------- |
| CI quality gates             | TypeScript, ESLint, Prettier, tests must pass before merge | ✅ Active |
| Branch protection            | PRs required, CI must pass, no force pushes                | ✅ Active |
| Code review                  | All changes reviewed before merge to main                  | ✅ Active |
| No untrusted deserialization | JSON.parse on validated shapes only; fail-closed           | ✅ Active |

**Verification:** GitHub branch protection settings, CI pipeline logs.

---

## A09 — Security Logging and Monitoring Failures

**Risk:** Insufficient logging to detect and respond to breaches.

| Control                | Implementation                                  | Status             |
| ---------------------- | ----------------------------------------------- | ------------------ |
| Structured logging     | lib/logger.ts with error/warn/info/debug levels | ✅ Active          |
| Request correlation    | requestId on all API log entries                | ✅ Active          |
| APM                    | Application performance monitoring (Datadog)    | Deferred — Phase 3 |
| Error tracking         | Real-time error aggregation (Sentry)            | Deferred — Phase 3 |
| Moderation audit trail | All content safety decisions logged             | Deferred — Phase 4 |

**Verification:** Log output review, APM dashboard (when implemented).

---

## A10 — Server-Side Request Forgery (SSRF)

**Risk:** Server fetches attacker-controlled URLs.

| Control                         | Implementation                                                  | Status                   |
| ------------------------------- | --------------------------------------------------------------- | ------------------------ |
| No user-controlled URL fetching | Platform does not fetch user-supplied URLs currently            | ✅ N/A                   |
| Allowlist when needed           | When URL fetching is added, allowlist-based validation required | Not yet needed           |
| Network segmentation            | Backend services isolated from public internet                  | Deferred — Phase 3 (AWS) |

**Verification:** Code review for fetch/axios/http calls with user input, SAST scan.

---

## Update History

| Date       | Phase       | Changes                                       |
| ---------- | ----------- | --------------------------------------------- |
| 2026-03-25 | Pre-Phase 1 | Initial mapping — all 10 categories addressed |

_Last updated: April 23, 2026 (Sprint 3a close — footer added per L16)_
