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

_Last updated: 2026-03-19_
