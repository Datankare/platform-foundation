# Task Registry

Non-security functional tasks: refactors, features, infrastructure, technical debt.
Security-specific items live in SECURITY_DEBT.md.

---

## Open Items

---

### CI-001 — GitHub Actions Node.js 24 deprecation warning

| Field          | Detail                                                     |
| -------------- | ---------------------------------------------------------- |
| **ID**         | CI-001                                                     |
| **Type**       | External dependency                                        |
| **Severity**   | Warning only — not a failure                               |
| **Component**  | actions/checkout, actions/setup-node                       |
| **Status**     | Blocked on GitHub releasing Node.js 24 compatible versions |
| **Logged**     | 2026-03-19                                                 |
| **Resolve by** | Before June 2nd 2026                                       |

**What:** GitHub's own actions have not yet released versions
that natively run on Node.js 24. We have already set
node-version: 24 and FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true.

**Resolution plan:**
Monitor GitHub Actions changelog. When updated versions ship,
bump action versions in ci.yml and remove this entry.

**Migrated from:** SECURITY_DEBT.md (Sprint 3c — not security-related)

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

**What:** Directory `platform/game-engine/` should be
`platform/app-framework/` to reflect PF's consumer-agnostic nature.

**Migrated from:** SECURITY_DEBT.md (Sprint 3c — not security-related)

---

### TASK-024 — Social Login (Google, Apple, Microsoft SSO)

| Field        | Detail                                                  |
| ------------ | ------------------------------------------------------- |
| **ID**       | TASK-024                                                |
| **Type**     | Feature deferral                                        |
| **Severity** | Medium                                                  |
| **Phase**    | 8–9 (Production Hardening)                              |
| **Status**   | Deferred — infrastructure ready, console config pending |
| **Logged**   | 2026-04-06                                              |

**What:** Code is complete: SsoButtons.tsx, initiateSso(),
handleSsoCallback(), provider interface all built.
Requires: (1) OAuth credentials from Google Cloud, Apple Developer,
Azure AD; (2) Cognito identity provider configuration;
(3) Custom domain on Cognito for callback URLs;
(4) Privacy policy URLs and app review (Apple).
Zero code changes needed.

**Tracking:** ADR-012, platform/auth/provider.ts,
components/auth/SsoButtons.tsx

**Migrated from:** SECURITY_DEBT.md (Sprint 3c — not security-related)

---

### TASK-025 — ALB for ffmpeg-service (stable URL)

| Field        | Detail         |
| ------------ | -------------- |
| **ID**       | TASK-025       |
| **Type**     | Infrastructure |
| **Severity** | Medium         |
| **Phase**    | 5              |
| **Status**   | Open           |
| **Logged**   | 2026-04-16     |

**What:** ECS Fargate public IP changes on task restart.
Add ALB or Elastic IP for stable URL.
Currently using direct IP — acceptable for development,
not production.

**Migrated from:** SECURITY_DEBT.md (Sprint 3c — not security-related)

---

### TASK-031 — File-level docstrings on SongMatchCard + useAudioRecorder

| Field        | Detail                 |
| ------------ | ---------------------- |
| **ID**       | TASK-031               |
| **Type**     | Documentation          |
| **Severity** | Low                    |
| **Phase**    | Phase 4                |
| **Status**   | Open                   |
| **Logged**   | 2026-04-18             |
| **Source**   | PHASE4_PLAN.md line 88 |

**What:** Add file-level docstrings to SongMatchCard and
useAudioRecorder components in Playform.

---

### TASK-032 — Language picker hidden during identification

| Field        | Detail                 |
| ------------ | ---------------------- |
| **ID**       | TASK-032               |
| **Type**     | UX — contextual UI     |
| **Severity** | Low                    |
| **Phase**    | Phase 4                |
| **Status**   | Open                   |
| **Logged**   | 2026-04-18             |
| **Source**   | PHASE4_PLAN.md line 85 |

**What:** Language picker should be hidden during song
identification mode (contextual UI behavior).

---

### TASK-033 — Song language displayed on SongMatchCard

| Field        | Detail                 |
| ------------ | ---------------------- |
| **ID**       | TASK-033               |
| **Type**     | Feature                |
| **Severity** | Low                    |
| **Phase**    | Phase 4                |
| **Status**   | Open                   |
| **Logged**   | 2026-04-18             |
| **Source**   | PHASE4_PLAN.md line 86 |

**What:** Display the identified song's language on the
SongMatchCard component.

---

### TASK-035 — Streaming service search links

| Field        | Detail                 |
| ------------ | ---------------------- |
| **ID**       | TASK-035               |
| **Type**     | Feature                |
| **Severity** | Low                    |
| **Phase**    | Phase 4                |
| **Status**   | Open                   |
| **Logged**   | 2026-04-18             |
| **Source**   | PHASE4_PLAN.md line 87 |

**What:** Add search links to streaming services
(Spotify, Apple Music, YouTube Music) on song identification
results.

---

### TASK-036 — Expire stale config approvals

| Field        | Detail                                      |
| ------------ | ------------------------------------------- |
| **ID**       | TASK-036                                    |
| **Type**     | Feature enhancement                         |
| **Severity** | Low                                         |
| **Phase**    | Phase 4+                                    |
| **Status**   | Open                                        |
| **Logged**   | 2026-04-24                                  |
| **Source**   | Code: platform/admin/config-approval.ts:425 |

**What:** Add mechanism to expire stale config change
approvals that have not been acted on.

---

### TASK-038 — Verify useAudioRecorder records ≥10s

| Field        | Detail                                 |
| ------------ | -------------------------------------- |
| **ID**       | TASK-038                               |
| **Type**     | Reliability verification               |
| **Severity** | Medium                                 |
| **Phase**    | Sprint 3c                              |
| **Status**   | Open                                   |
| **Logged**   | 2026-04-25                             |
| **Source**   | TASK-026 rotation — Gotcha G-VOICE-001 |

**What:** ACRCloud requires ≥10s of audio for reliable
fingerprint matching. Verify that `useAudioRecorder` in
Playform enforces a minimum recording duration of 10s
before triggering the identify call. If it records <10s,
users will get `code: 1001 No Result` on valid songs.

---

### TASK-039 — Evaluate ACRCloud Humming Identification

| Field        | Detail                       |
| ------------ | ---------------------------- |
| **ID**       | TASK-039                     |
| **Type**     | Feature evaluation           |
| **Severity** | Low                          |
| **Phase**    | Phase 5+                     |
| **Status**   | Open — ADR-021 candidate     |
| **Logged**   | 2026-04-25                   |
| **Source**   | TASK-026 rotation discussion |

**What:** ACRCloud offers humming/Cover Song Identification.
Fits Playform's language-learning UX. Requires: new
`IdentifyMode` enum, split provider interface, mode-aware UI,
confidence display, separate test fixtures.
Estimated ~1.5 sprints. Write ADR-021 before implementation.

---

### TASK-040 — Add ACRCLOUD placeholders to .env.example

| Field        | Detail                                  |
| ------------ | --------------------------------------- |
| **ID**       | TASK-040                                |
| **Type**     | Documentation / dev experience          |
| **Severity** | Low                                     |
| **Phase**    | Sprint 3c                               |
| **Status**   | Open                                    |
| **Logged**   | 2026-04-25                              |
| **Source**   | TASK-026 rotation pre-flight finding F2 |

**What:** `.env.example` in both PF and Playform lacks
`ACRCLOUD_HOST`, `ACRCLOUD_ACCESS_KEY`,
`ACRCLOUD_ACCESS_SECRET` placeholders.

---

### TASK-041 — Verify song-ID health probe is registered

| Field        | Detail                                  |
| ------------ | --------------------------------------- |
| **ID**       | TASK-041                                |
| **Type**     | Gotcha #27 verification                 |
| **Severity** | Medium                                  |
| **Phase**    | Sprint 3c                               |
| **Status**   | Open                                    |
| **Logged**   | 2026-04-25                              |
| **Source**   | TASK-026 rotation pre-flight finding F3 |

**What:** `platform/voice/health-probe.ts` defines a health
probe for `SongIdentificationProvider`, but pre-flight grep
found no registration call in `initObservability()`.
If unregistered, the probe is dead code (Gotcha #27).

---

### TASK-042 — Refactor dual ACRCloud env-var read sites

| Field        | Detail                                  |
| ------------ | --------------------------------------- |
| **ID**       | TASK-042                                |
| **Type**     | Refactor                                |
| **Severity** | Low                                     |
| **Phase**    | Sprint 4b                               |
| **Status**   | Open                                    |
| **Logged**   | 2026-04-25                              |
| **Source**   | TASK-026 rotation pre-flight finding F1 |

**What:** Both `platform/providers/registry.ts` (lines 211–213)
and `platform/voice/acrcloud-identify.ts` (lines 87–89)
independently read `process.env.ACRCLOUD_*`.
Single source of truth violation.

---

### TASK-043 — Commit known-good audio test fixtures

| Field        | Detail                                    |
| ------------ | ----------------------------------------- |
| **ID**       | TASK-043                                  |
| **Type**     | Testing infrastructure                    |
| **Severity** | Low                                       |
| **Phase**    | Sprint 3c                                 |
| **Status**   | Open                                      |
| **Logged**   | 2026-04-25                                |
| **Source**   | TASK-026 rotation — no fixtures available |

**What:** No `test-fixtures/audio/` directory exists. Future
rotations and song-ID testing need committed, known-good
audio samples (≥10s each).

---

## Unverified — Session Handoff Only

> The following tasks appear in session handoff documents but
> were not found in any repo doc or code. Raman to verify
> descriptions and add to Open Items if valid.

| ID       | Handoff description (unverified) |
| -------- | -------------------------------- |
| TASK-029 | (not found in repo — verify)     |
| TASK-037 | (not found in repo — verify)     |

---

## Known Issue — TASK-020 numbering collision

TASK-020 is used for two different items:

- **SECURITY_DEBT resolved table:** "Redis CacheProvider
  (deferred from Phase 1)" — resolved Phase 2, Sprint 4
- **PHASE3_PLAN + code:** "Google Cloud TTS 5,000-byte limit
  — needs chunking" — resolved Phase 3, Sprint 2

Both are resolved. Pre-existing collision, not introduced by
Sprint 3c. Flagged for awareness.

---

## Resolved Items

| ID       | Description                        | Resolved In        | Date       |
| -------- | ---------------------------------- | ------------------ | ---------- |
| TASK-014 | Admin module coverage exclusions   | Phase 1, Sprint 7a | 2026-04-01 |
| TASK-015 | Platform config table              | Phase 1, Sprint 7b | 2026-04-02 |
| TASK-016 | Repo inheritance model             | Phase 1, Sprint 7b | 2026-04-02 |
| TASK-017 | Seed data separation               | Phase 1, Sprint 7b | 2026-04-02 |
| TASK-018 | Rename player → user               | Phase 2, Sprint 3  | 2026-04-06 |
| TASK-020 | Redis CacheProvider                | Phase 2, Sprint 4  | 2026-04-07 |
| TASK-020 | TTS chunking (numbering collision) | Phase 3, Sprint 2  | 2026-04-10 |
| TASK-021 | Redis rate limiter                 | Phase 2, Sprint 4  | 2026-04-07 |
| TASK-022 | Password enforcement               | Phase 2, Sprint 4  | 2026-04-07 |
| TASK-023 | GDPR hard purge                    | Phase 2, Sprint 4  | 2026-04-07 |
| TASK-027 | Narrow IAM permissions             | Phase 4, Sprint 0  | 2026-04-17 |
| TASK-028 | Install @sentry/nextjs             | Phase 4, Sprint 0  | 2026-04-17 |
| TASK-030 | (resolved per PHASE4_PLAN ln 16)   | Phase 4, Sprint 0  | 2026-04-18 |
| TASK-034 | UX review — adaptive UI approved   | Phase 4, Sprint 0  | 2026-04-18 |

---

_Last updated: April 25, 2026 (Sprint 3c — initial creation,
migrated from SECURITY_DEBT.md, consolidated from
PHASE4_PLAN.md and code references)_
