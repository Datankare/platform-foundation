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

### TASK-018 — Rename "player" → "user" in PF codebase

| Field          | Detail                                              |
| -------------- | --------------------------------------------------- |
| **ID**         | TASK-018                                            |
| **Type**       | Technical debt — platform-game separation (ADR-001) |
| **Severity**   | Medium                                              |
| **Status**     | Tracked — docs generalized, code pending            |
| **Logged**     | 2026-04-06                                          |
| **Resolve by** | Phase 3 start                                       |

**What:** PF is a consumer-agnostic platform template, but the codebase uses
game-specific terminology ("player") throughout. Docs have been generalized
to "user"; code needs to follow.

**Files requiring rename:**

- Database: `players` table, `player_entitlements`, `player_content_rating`
- Supabase migrations: all references to `player_id`, `player_*` columns
- Types: `types/index.ts` — any player-specific interfaces
- Platform: `platform/auth/profile.ts`, `coppa.ts`, `devices.ts`, `gdpr-deletion.ts`
- Components: `components/auth/ProfilePage.tsx`
- API routes: `app/api/admin/players/`
- Tests: all `*player*` references in test files

**Resolution plan:**

1. Create migration 008 to rename `players` → `users`, `player_*` → `user_*`
2. Update all TypeScript types and interfaces
3. Update all component and API route references
4. Update all test files
5. Run full quality gate on both repos
6. Remove this entry when complete

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

---

_Last updated: 2026-04-06 (Generalization: player→user, game→application in docs. TASK-018/019 logged for code renames.)_
