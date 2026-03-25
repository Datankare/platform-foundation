# ADR-011 — Security Headers Policy

**Status:** Accepted
**Date:** 2026-03-25

## Context

Web applications must serve HTTP security headers to defend against common
attack vectors: clickjacking, MIME sniffing, XSS, protocol downgrade, and
cross-origin resource leakage. Without explicit headers, browsers apply
permissive defaults that leave the application exposed.

The platform ships 9 security headers via `next.config.ts` `headers()`
function. These are served on every response, for every route.

## Decision

### Headers Served

| Header                       | Value                                                    | Purpose                                             |
| ---------------------------- | -------------------------------------------------------- | --------------------------------------------------- |
| X-Frame-Options              | DENY                                                     | Prevent clickjacking — no framing allowed           |
| X-Content-Type-Options       | nosniff                                                  | Prevent MIME-type sniffing                          |
| Referrer-Policy              | strict-origin-when-cross-origin                          | Control referrer leakage                            |
| Permissions-Policy           | camera=(), microphone=(self), geolocation=(), payment=() | Restrict browser APIs                               |
| Strict-Transport-Security    | max-age=63072000; includeSubDomains; preload             | Force HTTPS, prevent downgrade                      |
| X-XSS-Protection             | 0                                                        | Deprecated — rely on CSP, disable legacy XSS filter |
| Cross-Origin-Opener-Policy   | same-origin                                              | Isolate browsing context                            |
| Cross-Origin-Resource-Policy | same-origin                                              | Prevent cross-origin resource theft                 |
| Content-Security-Policy      | See below                                                | Master defense against XSS and injection            |

### Content-Security-Policy — Baseline

The platform-foundation template ships a generic CSP with `connect-src 'self'`
only. Projects inheriting the template must tighten `connect-src` to include
only the external domains they actually use.

```
default-src 'self';
script-src 'self' 'unsafe-eval' 'unsafe-inline';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
media-src 'self' blob:;
connect-src 'self';
font-src 'self';
frame-ancestors 'none'
```

### CSP Tightening Schedule

| Phase   | Change                                                           |
| ------- | ---------------------------------------------------------------- |
| Current | `unsafe-eval` and `unsafe-inline` required by Next.js runtime    |
| Phase 2 | Evaluate nonce-based CSP to eliminate `unsafe-inline` (TASK-025) |
| Phase 6 | Add ad network domains to CSP when monetization is implemented   |
| Phase 9 | Final CSP audit — remove any domains no longer in use            |

### CORS Policy

Next.js API routes default to same-origin. Explicit CORS headers will be
added in Phase 2 when WebSocket/real-time communication requires cross-origin
access. Until then, same-origin is correct and sufficient.

## Verification

Headers are verified by:

1. `curl -I <deployment-url>` — manual check, documented in PR
2. OWASP ZAP baseline scan — automated, catches missing headers
3. Browser DevTools Network tab — visual confirmation

## Consequences

- All 9 headers are served on every response from the first deployment
- Projects inheriting platform-foundation get security headers automatically
- CSP is intentionally broad initially and tightened per phase as the
  external dependency surface is understood
- OWASP ZAP baseline scans will flag any regressions in header configuration
