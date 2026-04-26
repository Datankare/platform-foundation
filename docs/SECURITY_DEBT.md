# Security & Technical Debt Register

Security-specific consciously deferred items only.
Non-security tasks (refactors, features, infrastructure) live in TASKS.md.
These are NOT ignored — each has a resolution plan and a hard deadline.

---

## Open Items

---

### SEC-001 — CSP Allows unsafe-eval and unsafe-inline

| Field        | Detail                               |
| ------------ | ------------------------------------ |
| **ID**       | SEC-001                              |
| **Type**     | Security — XSS protection            |
| **Severity** | HIGH                                 |
| **OWASP**    | A05 — Security Misconfiguration      |
| **Status**   | Deferred — Phase 9 (nonce-based CSP) |
| **Logged**   | 2026-03-24 (Phase 0.9)               |
| **Deadline** | Phase 9 — Hardening & Launch         |

**What:** Content-Security-Policy in next.config.ts includes
'unsafe-eval' and 'unsafe-inline' for scripts and styles. These weaken
XSS protection. Next.js requires unsafe-eval in dev mode but not production.

**Resolution plan:**

1. Remove 'unsafe-eval' from production CSP
2. Replace 'unsafe-inline' with nonce-based CSP using Next.js headers()
3. Test all pages render correctly with tightened CSP
4. Remove this entry when deployed

---

### TASK-044 — Per-environment ACRCloud projects for security isolation

| Field        | Detail                          |
| ------------ | ------------------------------- |
| **ID**       | TASK-044                        |
| **Type**     | Security — credential isolation |
| **Severity** | Medium                          |
| **Phase**    | When staging traffic begins     |
| **Status**   | Open                            |
| **Logged**   | 2026-04-25                      |
| **Source**   | TASK-026 rotation               |

**What:** All Vercel environments (Production, Preview, Development) currently share the same ACRCloud credentials (`playform-prod-songid`). This means: (1) preview/dev API calls consume production paid quota, (2) staging bugs that hammer the identify endpoint affect production rate limits, (3) compromised dev env credential exposes production usage. Best practice: create `playform-staging-songid` and `playform-dev-songid` projects with separate credentials scoped per Vercel environment.

**Resolution plan:**

1. Create `playform-staging-songid` ACRCloud project
2. Create `playform-dev-songid` ACRCloud project (or use mock provider for dev)
3. Scope Vercel env vars per environment
4. Update ROTATION_RUNBOOK.md with per-env rotation procedures
5. Remove this entry when complete

---

## Resolved Items

_Items below have been resolved and are retained for audit trail only._

| ID       | Description                                     | Resolved In                                                                                         | Date       |
| -------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------- |
| DS-001   | next/image disk cache vulnerability             | Phase 0 (Next.js 16 upgrade)                                                                        | 2026-03-18 |
| SEC-002  | No rate limiting on API routes                  | Phase 1, Sprint 6                                                                                   | 2026-03-31 |
| SEC-003  | No retry logic for external API calls           | Phase 1, Sprint 7a (fetchWithTimeout retry)                                                         | 2026-04-01 |
| SEC-004  | No E2E tests — Playwright not integrated        | Phase 0.75                                                                                          | 2026-03-22 |
| SEC-005  | SpeechRecognition hardcoded to en-US            | Phase 1                                                                                             | 2026-04-02 |
| SEC-006  | Placeholder READMEs lack interface contracts    | Phase 1 (auth) + Phase 2 start (moderation, prompts)                                                | 2026-04-03 |
| TASK-026 | Rotate ACRCloud access secret                   | Sprint 3c — paid project `playform-prod-songid`, trial 99216 deprovisioned. See ROTATION_RUNBOOK.md | 2026-04-25 |
| TASK-027 | Narrow IAM permissions (scoped from FullAccess) | Phase 4 entry (confirmed via CLI)                                                                   | 2026-04-17 |

---

## Migration Note (April 25, 2026)

The following items were migrated to TASKS.md (Sprint 3c) as they are not security-related:

- CI-001 → TASKS.md (build/CI category)
- TASK-019 → TASKS.md (refactor)
- TASK-024 → TASKS.md (feature deferral)
- TASK-025 → TASKS.md (infrastructure)
- TASK-014 through TASK-023 resolved items → TASKS.md resolved table
- TASK-028 resolved → TASKS.md resolved table

---

_Last updated: April 25, 2026 (Sprint 3c — scope narrowed to security-only, non-security items migrated to TASKS.md, TASK-026 closed, TASK-044 added)_
