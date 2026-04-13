# Security & Technical Debt Register

All known, consciously deferred items.
These are NOT ignored — each has a resolution plan and a hard deadline.

---

## Open Items

---

### CI-001 — GitHub Actions Node.js 24 deprecation warning

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

---

### TASK-019 — Rename `platform/game-engine/` → `platform/app-framework/`

| Field          | Detail                                              |
| -------------- | --------------------------------------------------- |
| **ID**         | TASK-019                                            |
| **Type**       | Technical debt — platform-game separation (ADR-001) |
| **Severity**   | Low                                                 |
| **Status**     | Tracked — placeholder directory, no code yet        |
| **Logged**     | 2026-04-06                                          |
| **Resolve by** | Phase 5 start                                       |

**What:** Directory `platform/game-engine/` should be `platform/app-framework/`
to reflect PF's consumer-agnostic nature. Currently a placeholder with README only.

**Resolution plan:**

1. Rename directory and update README
2. Update all references in ROADMAP.md, ADRs, TAD.md
3. Update consumer sync exclude list if needed
4. Remove this entry when complete

---

## Resolved Items

_Items below have been resolved and are retained for audit trail only._

| ID       | Description                                  | Resolved In                                          | Date       |
| -------- | -------------------------------------------- | ---------------------------------------------------- | ---------- |
| DS-001   | next/image disk cache vulnerability          | Phase 0 (Next.js 16 upgrade)                         | 2026-03-18 |
| SEC-002  | No rate limiting on API routes               | Phase 1, Sprint 6                                    | 2026-03-31 |
| SEC-003  | No retry logic for external API calls        | Phase 1, Sprint 7a (fetchWithTimeout retry)          | 2026-04-01 |
| SEC-004  | No E2E tests — Playwright not integrated     | Phase 0.75                                           | 2026-03-22 |
| SEC-005  | SpeechRecognition hardcoded to en-US         | Phase 1                                              | 2026-04-02 |
| SEC-006  | Placeholder READMEs lack interface contracts | Phase 1 (auth) + Phase 2 start (moderation, prompts) | 2026-04-03 |
| TASK-014 | Admin module coverage exclusions             | Phase 1, Sprint 7a (integration tests)               | 2026-04-01 |
| TASK-015 | Platform config table                        | Phase 1, Sprint 7b                                   | 2026-04-02 |
| TASK-016 | Repo inheritance model                       | Phase 1, Sprint 7b (auto-sync)                       | 2026-04-02 |
| TASK-017 | Seed data separation                         | Phase 1, Sprint 7b                                   | 2026-04-02 |
| TASK-018 | Rename player → user in PF codebase          | Phase 2, Sprint 3 (52 files + migration 008)         | 2026-04-06 |
| TASK-020 | Redis CacheProvider (deferred from Phase 1)  | Phase 2, Sprint 4 (platform/cache/)                  | 2026-04-07 |
| TASK-021 | Redis rate limiter (deferred from Phase 1)   | Phase 2, Sprint 4 (platform/rate-limit/)             | 2026-04-07 |
| TASK-022 | Password enforcement (deferred from Phase 1) | Phase 2, Sprint 4 (password-policy.ts enhanced)      | 2026-04-07 |
| TASK-023 | GDPR hard purge (deferred from Phase 1)      | Phase 2, Sprint 4 (platform/gdpr/)                   | 2026-04-07 |

---

_Last updated: 2026-04-07 (Sprint 4b: Auth wiring complete — CognitoAuthProvider, route protection, 9 auth API routes, live login screen.)_

### TASK-024: Social Login (Google, Apple, Microsoft SSO)

- **Priority:** Medium
- **Phase:** 8–9 (Production Hardening)
- **Status:** Deferred — infrastructure ready, console configuration pending
- **Description:** Code is complete: SsoButtons.tsx, initiateSso(), handleSsoCallback(), provider interface all built. Requires: (1) OAuth credentials from Google Cloud, Apple Developer, Azure AD; (2) Cognito identity provider configuration; (3) Custom domain on Cognito for callback URLs; (4) Privacy policy URLs and app review (Apple). Zero code changes needed.
- **Tracking:** ADR-012, platform/auth/provider.ts, components/auth/SsoButtons.tsx
