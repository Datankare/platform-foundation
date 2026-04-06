# ADR-009 — Security Standards and OWASP Compliance Baseline

**Status:** Accepted
**Date:** 2026-03-24

## Context

Phase 0.75 (Security Hardening Sprint) identified critical and high-priority
security issues through systematic code review against OWASP Top 10 (2021).
These findings — API key exposure, prompt injection surfaces, missing rate
limiting, no security headers, no structured logging — were inherited from
the validation spike and must not recur in Phase 1 or beyond.

This ADR establishes the permanent security baseline that all future phases
build on. It defines what "secure by default" means for the platform and all consumers.

## Decision

### OWASP Top 10 Compliance Baseline

| OWASP Category                | Status     | Implementation                                                          |
| ----------------------------- | ---------- | ----------------------------------------------------------------------- |
| A01 Broken Access Control     | ⏳ Phase 1 | TASK-003 — Supabase Auth wraps all routes                               |
| A02 Cryptographic Failures    | ✅ Fixed   | API keys in Authorization header only (lib/translate, tts, transcribe)  |
| A03 Injection                 | ✅ Fixed   | sanitizeForPrompt() in lib/sanitize.ts wraps all LLM inputs             |
| A04 Insecure Design           | ⏳ Phase 1 | Rate limiting via Upstash Redis (TASK-003)                              |
| A05 Security Misconfiguration | ✅ Fixed   | CSP + security headers in next.config.ts; health endpoint cleaned       |
| A06 Vulnerable Components     | ✅ Clean   | npm audit clean; Next.js 16.2+; DS-001 resolved                         |
| A07 Auth & Session Failures   | ⏳ Phase 1 | TASK-003 — Supabase Auth + session management                           |
| A08 Software Integrity        | ✅ CI      | 6-layer CI pipeline enforces integrity on every push                    |
| A09 Logging & Monitoring      | ✅ Fixed   | lib/logger.ts — structured JSON logging, 5 levels, runtime-configurable |
| A10 SSRF                      | ✅ N/A     | No user-controlled URLs fetched in current architecture                 |

### Security Primitives (Phase 0.75 additions)

**`lib/logger.ts` — Structured Platform Logger**

- Five levels: error | warn | info | debug | silent
- Default: error (production-safe)
- Runtime-configurable via LOG_LEVEL environment variable
- Structured JSON output — every entry has timestamp, level, requestId, route
- Never logs: API keys, user input content, audio data, PII
- All API routes must use logger — raw console.error/log forbidden

**`lib/sanitize.ts` — Input Sanitization**

- sanitizeForPrompt(): strips injection patterns, wraps in XML delimiter
- sanitizeForLog(): truncates + removes control characters for safe log entries
- sanitizeLanguageCode(): validates language code format
- Required at every LLM input surface (enforced by ADR-003)

### Security Requirements for Every PR

The following are non-negotiable for every pull request:

1. **No API keys in URLs** — use Authorization header or X-Goog-Api-Key header
2. **Sanitize before LLM** — all user text must pass sanitizeForPrompt() before embedding
3. **Use structured logger** — import from lib/logger.ts, never use console.error directly
4. **Log errors with context** — include requestId, route, status in every error log
5. **No sensitive data in logs** — never log API keys, user content, audio, or PII
6. **Test the security path** — every new API route needs a test verifying no key exposure

### Security Headers (next.config.ts)

All responses include:

- Content-Security-Policy: restricts script/style/connect sources
- X-Frame-Options: DENY — prevents clickjacking
- X-Content-Type-Options: nosniff — prevents MIME sniffing
- Referrer-Policy: strict-origin-when-cross-origin
- Permissions-Policy: restricts camera/microphone/geolocation
- Strict-Transport-Security: max-age=63072000 — forces HTTPS

### Logging Levels and Behavior

| Level  | When                                                      | Output        |
| ------ | --------------------------------------------------------- | ------------- |
| error  | API failures, security events, uncaught exceptions        | console.error |
| warn   | Degraded behavior, sanitization applied, partial failures | console.warn  |
| info   | Request/response lifecycle, health checks                 | console.log   |
| debug  | Detailed trace for development (never in production)      | console.log   |
| silent | Test environments — suppresses all output                 | none          |

Default: error. Override via LOG_LEVEL environment variable.
Dynamic level change: /api/admin/log-level endpoint (Phase 1, auth-protected).

## Consequences

- API key exposure (OWASP A02) is prevented structurally — getApiKey() never
  appears in URLs; Authorization header is the only allowed pattern
- Prompt injection (OWASP A03) is mitigated at every LLM surface via
  sanitizeForPrompt() — not optional, enforced by PR checklist
- Security misconfiguration (OWASP A05) is addressed via next.config.ts headers
  and cleaned health endpoint
- Security logging (OWASP A09) is platform-wide via lib/logger.ts — every
  security event is traceable via requestId
- Remaining gaps (A01 auth, A04 rate limiting) are blocked on Phase 1 and
  formally tracked in SECURITY_DEBT.md
- The PR security checklist in CONTRIBUTING.md is the enforcement mechanism —
  no PR merges without passing all checklist items
