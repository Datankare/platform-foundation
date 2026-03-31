# Security & Technical Debt Register

All known, consciously deferred items.
These are NOT ignored — each has a resolution plan and a hard deadline.

---

## DS-001 — next/image disk cache vulnerability

| Field          | Detail                                           |
| -------------- | ------------------------------------------------ |
| **ID**         | DS-001                                           |
| **Advisory**   | GHSA-3x4c-7xq6-9pq8                              |
| **Severity**   | Moderate                                         |
| **Component**  | next/image (Next.js)                             |
| **Fix**        | Upgrade to Next.js 16.2.0+                       |
| **Status**     | Consciously deferred                             |
| **Deferred**   | 2026-03-18                                       |
| **Resolve by** | Phase 0 hardening — before any public deployment |

**Why deferred:**

- Fix requires Next.js 16 which has breaking CLI changes
- We do not use next/image anywhere in our codebase
- App is localhost-only — zero public exposure
- Attack requires network access to a public server

**Resolution plan:**

1. Upgrade to Next.js 16 in Phase 0 hardening
2. Run full regression test suite
3. Verify lint, typecheck, build all pass
4. Remove this entry when resolved

**Hard rule:** This MUST be resolved before first public deployment. No exceptions.

---

## CI-001 — GitHub Actions Node.js 24 deprecation warning

| Field          | Detail                                                                          |
| -------------- | ------------------------------------------------------------------------------- |
| **ID**         | CI-001                                                                          |
| **Type**       | External dependency                                                             |
| **Severity**   | Warning only — not a failure                                                    |
| **Component**  | actions/checkout, actions/setup-node                                            |
| **Status**     | Blocked on GitHub releasing Node.js 24 compatible action versions               |
| **Logged**     | 2026-03-19                                                                      |
| **Resolve by** | Automatically resolves when GitHub ships updated actions — before June 2nd 2026 |

**Why we cannot fix this today:**
GitHub's own actions (checkout, setup-node) have not yet released
versions that natively run on Node.js 24. The warning comes from
GitHub's runner infrastructure, not our workflow configuration.
We have already set node-version: 24 and FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true.
Nothing further can be done until GitHub ships the updated action versions.

**Resolution plan:**
Monitor GitHub Actions changelog. When updated versions ship,
bump action versions in ci.yml and remove this entry.

---

_Last updated: 2026-03-24 (Phase 0.9 Cleanup Sprint)_

---

## Phase 0.9 — Formal Deferrals (Code Review Findings)

_The following items were identified during the Phase 0.9 code review and
explicitly deferred with severity, phase assignment, and hard deadline.
Each must be resolved before the stated deadline — no exceptions._

---

## SEC-001 — CSP Allows unsafe-eval and unsafe-inline

| Field        | Detail                          |
| ------------ | ------------------------------- |
| **ID**       | SEC-001                         |
| **Type**     | Security — XSS protection       |
| **Severity** | HIGH                            |
| **OWASP**    | A05 — Security Misconfiguration |
| **Status**   | Deferred — Phase 1 hardening    |
| **Logged**   | 2026-03-24 (Phase 0.9)          |
| **Deadline** | Before first public deployment  |

**What:** Content-Security-Policy in next.config.ts includes
'unsafe-eval' and 'unsafe-inline' for scripts and styles. These weaken
XSS protection. Next.js requires unsafe-eval in dev mode but not production.

**Resolution plan:**

1. Remove 'unsafe-eval' from production CSP
2. Replace 'unsafe-inline' with nonce-based CSP using Next.js headers()
3. Test all pages render correctly with tightened CSP
4. Remove this entry when deployed

---

## SEC-002 — No Rate Limiting on API Routes

| Field        | Detail                       |
| ------------ | ---------------------------- |
| **ID**       | SEC-002                      |
| **Type**     | Security — cost exposure     |
| **Severity** | HIGH                         |
| **OWASP**    | A04 — Insecure Design        |
| **Status**   | Deferred — Phase 1, Sprint 1 |
| **Logged**   | 2026-03-24 (Phase 0.9)       |
| **Deadline** | Before any public deployment |

**What:** API routes (/api/process, /api/health) are publicly accessible
with no rate limiting. A single caller can trigger unlimited API spend.

**Resolution plan:**

1. Add Upstash Redis with @upstash/ratelimit in Next.js middleware
2. Implement alongside auth — rate limit by IP pre-auth, by user ID post-auth
3. Remove this entry when deployed

---

## SEC-003 — No Retry Logic for External API Calls

| Field        | Detail                       |
| ------------ | ---------------------------- |
| **ID**       | SEC-003                      |
| **Type**     | Reliability                  |
| **Severity** | MEDIUM                       |
| **OWASP**    | —                            |
| **Status**   | Deferred — Phase 1, Sprint 2 |
| **Logged**   | 2026-03-24 (Phase 0.9)       |
| **Deadline** | Before Phase 1 ships         |

**What:** All external API calls (safety, translate, tts) make a single
attempt and throw on failure. Transient 503 or DNS blips fail the pipeline.

**Resolution plan:**

1. Create shared retry utility in lib/ (1 retry, 1s backoff for 5xx only)
2. Apply to safety, translate, tts modules
3. Do not retry 4xx (client errors)
4. Remove this entry when deployed

---

## SEC-004 — No E2E Tests — Playwright Not Integrated

| Field        | Detail                 |
| ------------ | ---------------------- |
| **ID**       | SEC-004                |
| **Type**     | Testing infrastructure |
| **Severity** | MEDIUM                 |
| **OWASP**    | —                      |
| **Status**   | Deferred — Phase 1     |
| **Logged**   | 2026-03-24 (Phase 0.9) |
| **Deadline** | Before Phase 1 ships   |

**What:** CI pipeline has no E2E test layer. Playform has 15 E2E tests
with Playwright. Platform Foundation should follow the same pattern.

**Resolution plan:**

1. Backport Playwright config from Playform
2. Add smoke test: load page, submit text, verify translations
3. Wire into CI as separate job after build
4. Remove this entry when E2E tests pass in CI

---

## SEC-005 — SpeechRecognition Hardcoded to en-US

| Field        | Detail                 |
| ------------ | ---------------------- |
| **ID**       | SEC-005                |
| **Type**     | Functionality — i18n   |
| **Severity** | MEDIUM                 |
| **OWASP**    | —                      |
| **Status**   | Deferred — Phase 1     |
| **Logged**   | 2026-03-24 (Phase 0.9) |
| **Deadline** | Before Phase 1 ships   |

**What:** SpikeApp.tsx line 73: recognition.lang = "en-US" is hardcoded.
Platform is designed for global i18n from day one. Playform solved this
in Phase 0.5 with language-aware recognition.lang binding.

**Resolution plan:**

1. Propagate Playform's RECORDING_LANGUAGES pattern
2. Bind recognition.lang to the user's language selection
3. Remove this entry when deployed

---

## SEC-006 — Platform Placeholder READMEs Lack Interface Contracts

| Field        | Detail                                      |
| ------------ | ------------------------------------------- |
| **ID**       | SEC-006                                     |
| **Type**     | Documentation                               |
| **Severity** | LOW                                         |
| **Status**   | Deferred — Phase 1                          |
| **Logged**   | 2026-03-24 (Phase 0.9)                      |
| **Deadline** | Before implementation of each module begins |

**What:** Eight platform/ subdirectories contain identical boilerplate
READMEs. platform/auth/ is the next module and should have its interface
contract defined before implementation.

**Resolution plan:**

1. Update platform/auth/README.md before auth implementation begins
2. Update other module READMEs as they approach implementation
3. Remove this entry when platform/auth/ contract is documented

---

_Last updated: 2026-03-24 (Phase 0.9 Cleanup Sprint)_

## TASK-014: Admin module coverage exclusions — Sprint 7

**Added:** 2026-03-31 (Sprint 6)
**Severity:** Medium
**Deadline:** Sprint 7

The following files are excluded from unit coverage and require integration tests:
- app/api/admin/** (6 API routes + AI orchestrator + handlers)
- app/admin/page.tsx
- components/admin/ActionConfirmPanel.tsx, AdminConfigPanels.tsx, AdminDataPanels.tsx
- components/admin/AdminDataViews.tsx, AdminPasswordPanel.tsx, AdminPromptBar.tsx
- components/admin/ExecutionResultsPanel.tsx
- platform/auth/admin-guard.ts

These modules depend on Supabase and the Anthropic API. They need integration tests with real database connections in Sprint 7.

## TASK-015: Platform config table (runtime settings) — Sprint 7

**Added:** 2026-03-31 (Sprint 6)
**Severity:** Medium
**Deadline:** Sprint 7

Admin highlight duration and other runtime settings are currently hardcoded in shared/config/limits.ts. Move to a database-backed platform_config table with admin UI. Permission-gated: super_admin, admin, can_change_config.

## TASK-016: Repo inheritance model — Sprint 7

**Added:** 2026-03-31 (Sprint 6)
**Severity:** Medium
**Deadline:** Sprint 7

Platform-foundation → Playform currently uses manual file copy. Evaluate and implement git subtree or monorepo approach.

## TASK-017: Seed data separation — Sprint 7

**Added:** 2026-03-31 (Sprint 6)
**Severity:** Medium
**Deadline:** Sprint 7

Platform-foundation ships 7 Playform-specific roles (guest, free, daily, monthly, annual, lifetime, admin). Should ship only 4 generic roles (guest, registered, admin, super_admin). Subscription tiers belong in Playform-specific seed data.
