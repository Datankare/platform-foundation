# Task Registry

Non-security functional tasks: refactors, features, infrastructure, technical debt.
Security-specific items live in SECURITY_DEBT.md.

---

## Open Items

---

### FEAT-090 — Admin-authored workflow composition (governed)

| Field          | Detail                                       |
| -------------- | -------------------------------------------- |
| **ID**         | FEAT-090                                     |
| **Type**       | Feature — agent governance                   |
| **Severity**   | Enhancement                                  |
| **Component**  | platform/agents (run loop), admin governance |
| **Status**     | Deferred — revisit after Sprint 3c UX        |
| **Logged**     | 2026-08-31 (Sprint 3c UX)                    |
| **Resolve by** | Own ADR before build                         |

**What:** Let an admin compose a new workflow from EXISTING step primitives (goal,
description, ordered step intents, cost estimates, required capability, endpoint) through the
governance admin, without new per-workflow code. Raised during Sprint 3c UX (U2): capabilities
are derived from the code-registered workflow registry, so U2 shipped read-only — but the
question is whether workflows themselves could become admin-governed.

**Viability (assessed):** the execution model supports it. Steps run generically through
`invokeTool` keyed off the step-level `intent` (ADR-030 D1), not a per-goal switch — so a
workflow assembled from existing intents would run with no new step code.

**Why it is NOT a small change (the honest scope):**

1. PF's run loop reads workflows only from the code-populated registry (`registerWorkflow`).
   Admin-authored workflows require the loop to MERGE an authored-workflow governed store
   (config or table) with the code-registered definitions.
2. Consumers (not PF) register workflows and own their endpoints, so the authoring panel and
   the invocation/endpoint path are consumer-side — this spans both repos.
3. A composed workflow is EXECUTABLE AUTHORITY: an admin assembling "invoke tool X then Y"
   authors something with real effects. It needs a safety model — which tools a composed
   workflow may invoke, under what risk tier, and whether authoring itself needs approval.

**Resolution plan:**

1. Write an ADR for admin-authored workflow composition (the safety model is the crux:
   what may a composed workflow invoke, and under what governance).
2. PF: merge an authored-workflow store into the run-loop registry read.
3. Consumer: the authoring governance panel + the invocation path for authored workflows.
4. Remove this entry when delivered.

---

### CI-001 — GitHub Actions Node.js 24 deprecation warning

| Field          | Detail                                               |
| -------------- | ---------------------------------------------------- |
| **ID**         | CI-001                                               |
| **Type**       | External dependency                                  |
| **Severity**   | Warning only — not a failure                         |
| **Component**  | actions/checkout, actions/setup-node                 |
| **Status**     | Open — UNBLOCKED, compatible versions have shipped   |
| **Logged**     | 2026-03-19                                           |
| **Resolve by** | 2026-09-16 (Node 20 removed from runners) — Sprint 1 |

**What:** Our workflows pin action majors that still run on Node.js 20
(checkout v4.2.2, setup-node v4.4.0, upload-artifact v4, codeql-action v3).
Node 24 became the default runtime on 2026-06-02; **Node 20 is removed from
GitHub runners on 2026-09-16**, after which these actions stop working.

**Unblocked (verified 2026-07-12):** Node 24-compatible majors have shipped —
`actions/checkout` v6/v7, `actions/setup-node` v6, `actions/upload-artifact` v5+/v7,
`github/codeql-action` v4. Dependabot has already opened PRs for checkout 7.0.0
and upload-artifact 7.0.1.

**Resolution plan:**

1. Bump the action majors in both repos, keeping the SHA-pin + `# vX` comment convention
2. Verify each workflow still passes (ci, codeql, semgrep, load-test, zap-scan, sync)
3. Drop the `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24` shim once everything is on Node 24
4. Remove this entry

**Close when:** no workflow runs a Node 20 action; no deprecation warning in CI output.

**Migrated from:** SECURITY_DEBT.md (Sprint 3c — not security-related)

---

### TASK-024 — Social Login (Google, Apple, Microsoft SSO)

| Field        | Detail                                                  |
| ------------ | ------------------------------------------------------- |
| **ID**       | TASK-024                                                |
| **Type**     | Feature deferral                                        |
| **Severity** | Medium                                                  |
| **Phase**    | 8–9 (Production Hardening)                              |
| **Target**   | Phase 8-9 (Production Hardening)                        |
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

**Retargeted Phase 8-9 (Production Hardening):** Target recorded explicitly; Phase already named it.

### TASK-025 — ALB for ffmpeg-service (stable URL)

| Field        | Detail                 |
| ------------ | ---------------------- |
| **ID**       | TASK-025               |
| **Type**     | Infrastructure         |
| **Severity** | Medium                 |
| **Phase**    | Phase 5, Sprint 6      |
| **Target**   | Phase 5, Sprint 7P     |
| **Status**   | Open — service retired |
| **Logged**   | 2026-04-16             |

**What:** ECS Fargate public IP changes on task restart.
Add ALB or Elastic IP for stable URL.
Currently using direct IP — acceptable for development,
not production.

**Update (2026-10-20):** the service no longer runs. Its load balancer and the AWS account it ran in are gone,
and the `ffmpeg` DNS record was removed in the 2026-10 hardening. Song identification cannot convert
audio until the service is back. Decision deferred to Sprint 7P: rebuild it as a container on the AWS
environment (TASK-128), or retire server-side conversion for client-side WAV capture.

**Migrated from:** SECURITY_DEBT.md (Sprint 3c — not security-related)

---

**Retargeted Phase 5, Sprint 6:** Target recorded explicitly; Phase already named it.

### TASK-031 — File-level docstrings on SongMatchCard + useAudioRecorder

| Field        | Detail                 |
| ------------ | ---------------------- |
| **ID**       | TASK-031               |
| **Type**     | Documentation          |
| **Severity** | Low                    |
| **Phase**    | Phase 5, Sprint 7      |
| **Target**   | Phase 5, Sprint 7      |
| **Status**   | Open                   |
| **Logged**   | 2026-04-18             |
| **Source**   | PHASE4_PLAN.md line 88 |

**What:** Add file-level docstrings to SongMatchCard and
useAudioRecorder components in Playform.

---

**Retargeted Phase 5, Sprint 7:** Target recorded explicitly; Phase already named it.

### TASK-032 — Language picker hidden during identification

| Field        | Detail                 |
| ------------ | ---------------------- |
| **ID**       | TASK-032               |
| **Type**     | UX — contextual UI     |
| **Severity** | Low                    |
| **Phase**    | Phase 5, Sprint 7      |
| **Target**   | Phase 5, Sprint 7      |
| **Status**   | Open                   |
| **Logged**   | 2026-04-18             |
| **Source**   | PHASE4_PLAN.md line 85 |

**What:** Language picker should be hidden during song
identification mode (contextual UI behavior).

---

**Retargeted Phase 5, Sprint 7:** Target recorded explicitly; Phase already named it.

### TASK-033 — Song language displayed on SongMatchCard

| Field        | Detail                 |
| ------------ | ---------------------- |
| **ID**       | TASK-033               |
| **Type**     | Feature                |
| **Severity** | Low                    |
| **Phase**    | Phase 5, Sprint 7      |
| **Target**   | Phase 5, Sprint 7      |
| **Status**   | Open                   |
| **Logged**   | 2026-04-18             |
| **Source**   | PHASE4_PLAN.md line 86 |

**What:** Display the identified song's language on the
SongMatchCard component.

---

**Retargeted Phase 5, Sprint 7:** Target recorded explicitly; Phase already named it.

### TASK-035 — Streaming service search links

| Field        | Detail                 |
| ------------ | ---------------------- |
| **ID**       | TASK-035               |
| **Type**     | Feature                |
| **Severity** | Low                    |
| **Phase**    | Phase 5, Sprint 7      |
| **Target**   | Phase 5, Sprint 7      |
| **Status**   | Open                   |
| **Logged**   | 2026-04-18             |
| **Source**   | PHASE4_PLAN.md line 87 |

**What:** Add search links to streaming services
(Spotify, Apple Music, YouTube Music) on song identification
results.

---

**Retargeted Phase 5, Sprint 7:** Target recorded explicitly; Phase already named it.

### TASK-036 — Expire stale config approvals

| Field        | Detail                                      |
| ------------ | ------------------------------------------- |
| **ID**       | TASK-036                                    |
| **Type**     | Feature enhancement                         |
| **Severity** | Low                                         |
| **Phase**    | Phase 5, Sprint 2                           |
| **Target**   | Phase 5, Sprint 6                           |
| **Status**   | Fixed on develop (Sprint 7R R5)             |
| **Logged**   | 2026-04-24                                  |
| **Source**   | Code: platform/admin/config-approval.ts:425 |

**What:** Add mechanism to expire stale config change
approvals that have not been acted on.

**Fixed (Sprint 7R R5):** `expireStaleApprovals` (platform/admin/config-approval.ts) marks every
pending approval past its expiry as expired — each tenant's and the platform's own — run hourly by
the `config.expire-approvals` platform job (ADR-056 D3, migration 050).

---

**Retargeted Phase 5, Sprint 6:** Low severity, no dependency, no urgency. Grouped with the other Sprint 6 housekeeping.

### TASK-037 — Config-AI conversational endpoint is a keyword stub

| Field        | Detail                                                  |
| ------------ | ------------------------------------------------------- |
| **ID**       | TASK-037                                                |
| **Type**     | Feature — agentic surface                               |
| **Severity** | Medium                                                  |
| **Phase**    | Phase 5 (Sprint 2/3, on the agentic workflow framework) |
| **Target**   | Phase 5, Sprint 4                                       |
| **Status**   | Open                                                    |
| **Logged**   | 2026-06-21                                              |
| **Source**   | app/api/admin/config-ai/route.ts:179                    |

**What:** The conversational config-AI endpoint (`config-ai/route.ts`)
still returns `buildAcknowledgment()`, a keyword-matching stub — not
LLM-driven. The `/execute` sub-route does real tool dispatch, but the
conversational layer on top does not. The route comment cites "Sprint 4b",
but 4b wired the social and input agents, not this surface.

**Resolution:** build it ON the Phase 5 agentic workflow framework
(`platform/ai/agent.ts`, ADR-029) — system prompt → LLM with the config
tool definitions → tool calls via `executeAgent()` → response. Do not
extend the keyword approach. Verified still-open Phase 5 Sprint 0.

---

**Retargeted Phase 5, Sprint 4:** Depends on the agentic framework, which now exists. Sprint 4 is the first sprint it can be done properly.

### TASK-038 — Verify useAudioRecorder records ≥10s

| Field        | Detail                                 |
| ------------ | -------------------------------------- |
| **ID**       | TASK-038                               |
| **Type**     | Reliability verification               |
| **Severity** | Medium                                 |
| **Phase**    | Phase 5, Sprint 7                      |
| **Target**   | Phase 5, Sprint 7                      |
| **Status**   | Open                                   |
| **Logged**   | 2026-04-25                             |
| **Source**   | TASK-026 rotation — Gotcha G-VOICE-001 |

**What:** ACRCloud requires ≥10s of audio for reliable
fingerprint matching. Verify that `useAudioRecorder` in
Playform enforces a minimum recording duration of 10s
before triggering the identify call. If it records <10s,
users will get `code: 1001 No Result` on valid songs.

---

**Retargeted Phase 5, Sprint 7:** Target recorded explicitly; Phase already named it.

### TASK-039 — Evaluate ACRCloud Humming Identification

| Field        | Detail                       |
| ------------ | ---------------------------- |
| **ID**       | TASK-039                     |
| **Type**     | Feature evaluation           |
| **Severity** | Low                          |
| **Phase**    | Phase 6+ (needs ADR)         |
| **Target**   | Phase 6+ (needs ADR)         |
| **Status**   | Open — ADR-021 candidate     |
| **Logged**   | 2026-04-25                   |
| **Source**   | TASK-026 rotation discussion |

**What:** ACRCloud offers humming/Cover Song Identification.
Fits Playform's language-learning UX. Requires: new
`IdentifyMode` enum, split provider interface, mode-aware UI,
confidence display, separate test fixtures.
Estimated ~1.5 sprints. Write ADR-021 before implementation.

---

**Retargeted Phase 6+ (needs ADR):** Target recorded explicitly; Phase already named it.

### TASK-041 — Verify song-ID health probe is registered

| Field        | Detail                                                                     |
| ------------ | -------------------------------------------------------------------------- |
| **ID**       | TASK-041                                                                   |
| **Type**     | Gotcha #27 verification                                                    |
| **Severity** | Medium                                                                     |
| **Phase**    | Phase 5, Sprint 1                                                          |
| **Target**   | Phase 5, Sprint 3                                                          |
| **Status**   | Resolved — verified registered in PF instrumentation; Playform is TASK-074 |
| **Logged**   | 2026-04-25                                                                 |
| **Source**   | TASK-026 rotation pre-flight finding F3                                    |

**What:** `platform/voice/health-probe.ts` defines a health
probe for `SongIdentificationProvider`, but pre-flight grep
found no registration call in `initObservability()`.
If unregistered, the probe is dead code (Gotcha #27).

**Verified (Phase 5 Sprint 0):** confirmed unregistered — `health-probe.ts` defines the probe (type + class) but no registration call exists in `observability/`, `registry.ts`, or `instrumentation.ts`. Gotcha #27 confirmed; fix still Open.

---

**Retargeted Phase 5, Sprint 3:** Same endpoint as TASK-057, which leads Sprint 3. Verifying a probe is registered while fixing the thing that runs probes is one piece of work, not two.

### TASK-042 — Refactor dual ACRCloud env-var read sites

| Field        | Detail                                  |
| ------------ | --------------------------------------- |
| **ID**       | TASK-042                                |
| **Type**     | Refactor                                |
| **Severity** | Low                                     |
| **Phase**    | Phase 5, Sprint 1                       |
| **Target**   | Phase 5, Sprint 6                       |
| **Status**   | Open                                    |
| **Logged**   | 2026-04-25                              |
| **Source**   | TASK-026 rotation pre-flight finding F1 |

**What:** Both `platform/providers/registry.ts` (lines 226–228)
and `platform/voice/acrcloud-identify.ts` (lines 87–89)
independently read `process.env.ACRCLOUD_*`.
Single source of truth violation.

**Verified (Phase 5 Sprint 0):** both read sites confirmed present (registry.ts:226-228, acrcloud-identify.ts:87-89). Still Open.

---

**Retargeted Phase 5, Sprint 6:** Tidiness with no correctness or timing pressure. Grouped with TASK-025, the same subject area.

### TASK-045 — Rebase + maintain Playform GENAI_ROADMAP overlay

| Field        | Detail                       |
| ------------ | ---------------------------- |
| **ID**       | TASK-045                     |
| **Type**     | Documentation / process      |
| **Severity** | Medium                       |
| **Phase**    | Phase 5, Sprint 7            |
| **Target**   | Phase 5, Sprint 7            |
| **Status**   | Open                         |
| **Logged**   | 2026-06-21                   |
| **Source**   | Phase 5 entry gate N3 review |

**What:** Playform's docs/GENAI_ROADMAP.md is a sync-excluded
overlay frozen at Sprint 3d (2026-04-27) — missing Sprints 4-7
and the Phase 4 close. Rebase it on PF's current content as the
base layer, then add Playform-specific GenAI content
(AdaptiveInput intent resolution, song ID, translation pipeline,
social-agent wiring, any Playform-only GenAI surfaces). Keep it
sync-excluded.

**Don't-rot guard:** extend the D3/D4 documentation gate so it
runs against both GENAI_ROADMAPs whenever a consumer overlay
exists. D3/D4 only ever ran against PF, which is why the overlay
froze.

---

**Retargeted Phase 5, Sprint 7:** Target recorded explicitly; Phase already named it.

### TASK-046 — Auth-enable k6 + live moderation/agent re-baseline

| Field        | Detail                                        |
| ------------ | --------------------------------------------- |
| **ID**       | TASK-046                                      |
| **Type**     | Testing infrastructure / performance baseline |
| **Severity** | Medium                                        |
| **Phase**    | Phase 5, Sprint 7 (phase-exit expectation)    |
| **Target**   | Phase 5, Sprint 7                             |
| **Status**   | Open                                          |
| **Logged**   | 2026-06-21                                    |
| **Source**   | Phase 5 Sprint 0 k6 re-baseline finding       |

**What:** `k6/api-load.js`'s `DRY_RUN=0` ("live, ~$5") profile is stale — it predates
Sprint 3d, which added `requireAuthWithStatus` to `/api/process` (and, in Playform, guarded `/api/stream` — in platform-foundation that route was unguarded until TASK-133). The
script sends no auth header, so every live request 401s at the guard before reaching
moderation, translate/classify, or the orchestrator. A live run today costs ~$0 and
measures only 401-rejection latency.

**Resolution:** add auth to the k6 script — acquire a test-user JWT (sign in via
`/api/auth/sign-in` or mint a token) and send it as `Authorization: Bearer …` on the
`/process` and `/stream` calls. Then run `DRY_RUN=0` against **staging** for the first real
moderation + agent latency baseline. Phase-exit expectation — do not close Phase 5 without it.

**Dry baseline (Phase 5 Sprint 0, for reference):** prod, 10 VUs, 1221 reqs, 0% errors;
process p95 76.9ms, stream p95 71.4ms, health p95 149ms (health p99 tripped on a single ~2s
Vercel cold start).

---

**Retargeted Phase 5, Sprint 7:** Phase-exit expectation; target recorded explicitly.

### TASK-047 — Next 16 middleware → proxy file-convention deprecation

| Field        | Detail                                                         |
| ------------ | -------------------------------------------------------------- |
| **ID**       | TASK-047                                                       |
| **Type**     | Tech debt — framework deprecation                              |
| **Severity** | Low (warning now; hard error in a future Next major)           |
| **Phase**    | Phase 5, Sprint 1                                              |
| **Target**   | Phase 5, Sprint 3                                              |
| **Status**   | Resolved — was already done in Sprint 1; verified, not assumed |
| **Logged**   | 2026-06-21                                                     |
| **Source**   | Sprint 0 dev-server warning (Next 16.2.6)                      |

**What:** Next 16 deprecated the `middleware.ts` file convention in favor of `proxy.ts` —
the dev server logs the deprecation on startup, and request logs already show `proxy.ts`
timings. PF-synced file, so both repos are affected. Becomes a hard error in a future Next major.

**Resolution:** rename `middleware.ts` → `proxy.ts` per the Next 16 migration guide; verify
auth + rate-limit middleware still applies on all routes; run the full gate. PF first (syncs
to Playform).

**Close when:** `middleware.ts` renamed to `proxy.ts` in PF, gate green, and the dev-server
deprecation warning no longer appears.

---

**Retargeted Phase 5, Sprint 3:** The only open item with an external clock: a warning today, a build failure in a future Next release. The cost of deferring rises without us choosing it.

### TASK-048 — Promote Playform Phase-5-open ROADMAP overlay to main

| Field        | Detail                                                             |
| ------------ | ------------------------------------------------------------------ |
| **ID**       | TASK-048                                                           |
| **Type**     | Process — release                                                  |
| **Severity** | Low                                                                |
| **Phase**    | Phase 5 (Sprint 0 carry)                                           |
| **Target**   | Phase 5, Sprint 3                                                  |
| **Status**   | Resolved — commit 2033172 verified as an ancestor of Playform main |
| **Logged**   | 2026-06-21                                                         |
| **Source**   | Phase 5 entry — Playform N7/N8 overlay edits                       |

**What:** Playform's Phase-5-open ROADMAP overlay edits (Phase 5 → In Progress, changelog)
were committed to Playform `develop` (commit `2033172`) during the entry gate but not yet
promoted. `ROADMAP.md` is a sync-excluded overlay, so it does NOT arrive via PF sync — it
needs its own Playform develop → staging → main promotion.

**Close when:** commit `2033172` (and any follow-on overlay edits) is merged to Playform
`main` via the standard PR flow.

---

**Retargeted Phase 5, Sprint 3:** Cheapest item open, and a documentation inconsistency between repos — the class this sprint spent a day on. Done while the habit is fresh.

### TASK-050 — Jest worker crashes with stack overflow in soft-delete warning

| Field        | Detail                                               |
| ------------ | ---------------------------------------------------- |
| **ID**       | TASK-050                                             |
| **Type**     | Test infrastructure — latent crash                   |
| **Severity** | Medium (does not fail the gate — exit code stays 0)  |
| **Phase**    | Phase 5, Sprint 1                                    |
| **Target**   | Phase 5, Sprint 4                                    |
| **Status**   | Open                                                 |
| **Logged**   | 2026-07-06                                           |
| **Source**   | Playform `npx jest` output during the audit-fix gate |

**What:** A Jest worker process hard-crashes with `RangeError: Maximum call stack size
exceeded` inside `jest-util`'s soft-deleted-global warning path (`emitAccessWarning` →
`originalSetter` → infinite recursion, jest-util/build/index.js:531-541). It is preceded by
`[JEST-01] DeprecationWarning: 'version' property was accessed on [Object] after it was soft
deleted` — something accesses a global after Jest tears it down between test files.

**Why it matters:** the suite still reports all tests passing and jest exits 0, so **CI does
not catch this**. A crashing worker can mask failures and will get worse: Jest has announced
the soft-delete behavior becomes "on" (hard failure) in a future version.

**Confirmed pre-existing (2026-07-06):** NOT caused by the `npm audit fix` OTel/Sentry bump —
reproduced on the pre-bump lockfile (`865fedc`, 2 occurrences) and the post-bump lockfile
(`d54163e`, 1 occurrence).

**Resolution:** run with `--detect-open-handles` / `--runInBand` to isolate the offending
suite; identify what accesses a global post-teardown (likely a module registering global
instrumentation); fix the leak or set the Jest config option that controls soft-delete
behavior. Check whether PF exhibits it too.

**Close when:** `npx jest` in both repos completes with zero `Maximum call stack size
exceeded` occurrences.

---

**Retargeted Phase 5, Sprint 4:** Does not fail the suite; it is noise in the output. Real, because noise hides signal, but nothing depends on it.

### TASK-056 — CI-signal parity for platform-foundation (the less-watched repo)

| Field        | Detail                                                                       |
| ------------ | ---------------------------------------------------------------------------- |
| **ID**       | TASK-056                                                                     |
| **Type**     | CI / build-model resilience                                                  |
| **Severity** | Medium-High — silent drift, both repos                                       |
| **Phase**    | Phase 5, Sprint 1                                                            |
| **Target**   | Phase 5, Sprint 3                                                            |
| **Status**   | Resolved — CodeQL, thresholds and sprint:check brought to parity in Playform |
| **Logged**   | 2026-07-21                                                                   |
| **Source**   | PF audit drift + coverage-margin, 2026-07-21                                 |

**What:** PF's CI failure/warning signals do not reach the maintainer the way Playform's do,
so PF drifts silently. Two instances surfaced the same day:

1. **Audit drift.** PF's `npm audit` had accumulated **9 advisories (2 high, 6 moderate, 1 low)**
   while Playform showed 1 — because dependency audit-fix was only ever run on Playform, and the
   two lockfiles are sync-excluded (independent). PF's `Layer 0d — Dependency audit` CI step was
   presumably red without anyone watching.
2. **Coverage margin.** After the fix PF sits at **88.59% vs its 88.54% floor — 0.05% headroom**.
   One small untested addition breaches the floor, with no proximity warning.

Same class as the sync outage (L22): a signal that fails silently fails indefinitely. Playform
now has sync-failure alerting (TASK-052); PF has no equivalent for its own CI health.

**Resolution:**

1. **Audit alerting parity** — PF CI notifies on `Layer 0d` failure (issue-on-failure like the
   sync alert, or GitHub Actions failure notification confirmed to reach the maintainer).
2. **Coverage-proximity warning** — warn (not fail) when coverage is within a small margin
   (e.g. <0.5%) of the floor, so a near-breach is visible before it becomes a hard failure.
3. **Both-repo audit sweep** — a scheduled `npm audit` canary across BOTH repos (lockfiles are
   sync-excluded, so "fixed in one" never means "fixed in both"), or a documented cadence.
4. Confirm PF CI failures actually notify the maintainer at all — the root gap is that PF red
   states were invisible.

**Close when:** a PF CI failure (audit or gate) produces a notification that reaches the
maintainer, and coverage-floor proximity emits a visible warning.

---

**Retargeted Phase 5, Sprint 3:** Silent CI drift in the less-watched repo; same class as TASK-057 and older.

### TASK-057 — /api/health returns a static payload; registered probes never run

| Field        | Detail                                                           |
| ------------ | ---------------------------------------------------------------- |
| **ID**       | TASK-057                                                         |
| **Type**     | Observability / reliability defect                               |
| **Severity** | High — fails open (silent-failure pattern)                       |
| **Phase**    | Phase 5, Sprint 2                                                |
| **Target**   | Phase 5, Sprint 3                                                |
| **Status**   | Resolved — route runs the registry; detail to the error reporter |
| **Logged**   | 2026-07-24                                                       |

**What:** `/api/health` returns a static `{ status: "ok", service, timestamp }` and never
executes the probes registered in the observability `HealthRegistry`. TASK-041 registered the
song-ID probe correctly, but nothing _runs_ it — the endpoint reports healthy regardless of
whether ACRCloud, Supabase, the LLM provider, cache, or realtime are actually reachable. This
is the same fail-open pattern as the dead sync, the frozen READMEs, and the audit drift: a
signal that is a constant.

**Consequences:**

1. Deployment/uptime readiness gates are meaningless — the endpoint reports ready before
   providers are functional.
2. The k6 baseline is invalid — recorded `health_latency` measured a static JSON response with
   no I/O, so it says nothing about system health. Affects the TASK-046 re-baseline premise.
3. Every future probe inherits the problem — registered, never executed.

**Resolution (correct + complete — no half-fix):**

1. Split liveness from readiness: `/api/health` stays cheap/static (process up — for LB polling);
   `/api/health/ready` (or `?deep=1`) runs the registered probes.
2. Deep endpoint: per-probe timeout (a slow dependency must not hang the endpoint) + a short
   result cache (15–30s) so frequent polls don't hammer providers (e.g. ACRCloud rate limits).
3. Wire the existing `HealthRegistry` consumers — the abstraction exists; the endpoint must use it.
4. Re-baseline k6 against the deep endpoint (fold into TASK-046).

**Close when:** the deep endpoint executes all registered probes with per-probe timeouts and a
result cache; a failing provider makes it report unhealthy; k6 re-baselined against it.

---

**Retargeted Phase 5, Sprint 3:** Highest-severity open item: the health endpoint reports healthy without running its probes, in production, today. Leads Sprint 3.

### TASK-058 — Dependency-advisory handling is a CI tripwire, not a process

| Field        | Detail                                                                                                                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ID**       | TASK-058                                                                                                                                                                                                                              |
| **Type**     | CI / supply-chain process                                                                                                                                                                                                             |
| **Severity** | Medium — recurring manual toil + risk                                                                                                                                                                                                 |
| **Phase**    | Phase 5, Sprint 2                                                                                                                                                                                                                     |
| **Target**   | Phase 5, Sprint 7                                                                                                                                                                                                                     |
| **Status**   | Open — code/CI half resolved (Sprint 6.5 M6a: scheduled audit sweep + override register); process half: PF reaudit cadence + cross-repo reconciliation documented (Sprint 7 m2); the Playform-side wiring gap it surfaced is TASK-090 |
| **Logged**   | 2026-07-24                                                                                                                                                                                                                            |

**What:** Four high-severity advisories in three days (brace-expansion, sharp/fast-uri,
postcss, plus the Next middleware CVE) were each discovered only when CI went red, and each
needed manual judgment because `npm audit fix --force` proposed a destructive downgrade
(Next → 14, or 9.3.3) every time. The audit gate is a tripwire, not a managed process.

**Contributing factors:**

- `package-lock.json` is sync-excluded, so the two repos' lockfiles drift independently —
  "fixed in one" never means "fixed in both".
- `--force` is almost always wrong here (it satisfies a transitive advisory by downgrading a
  top-level framework); the correct move is usually an `overrides` entry, but that pattern is
  undocumented and rediscovered each time.

**Resolution:**

1. Scheduled both-repo `npm audit` sweep (canary) so advisories surface proactively, not at the
   next unrelated push.
2. Document the "override the transitive, don't --force the framework" procedure with the
   verify-before-patching step (check the registry for the patched version) as a runbook.
3. Consider a shared/synced overrides baseline so a fix in one repo is not silently absent in
   the other.

**Close when:** advisories surface via a scheduled sweep before they block an unrelated PR, and
the override procedure is documented.

---

**Retargeted Phase 5, Sprint 4:** Three advisories in three days cost roughly a day. Real, but it needs a process design rather than a code fix.

### TASK-059 — Prettier version drift between repos; every sync PR fails format:check

| Field        | Detail                                                    |
| ------------ | --------------------------------------------------------- |
| **ID**       | TASK-059                                                  |
| **Type**     | CI / repo-inheritance process defect                      |
| **Severity** | Medium — red-by-default sync PRs mask real failures       |
| **Phase**    | Phase 5, Sprint 2                                         |
| **Status**   | Resolved — prettier pinned to exactly 3.9.6 in both repos |
| **Logged**   | 2026-07-26                                                |

**What:** Every PF→Playform sync re-triggers `format:check` failures on the same shared files.
The Sprint 1 handoff attributed this to `.prettierrc` drift. It is not: the two configs are
**byte-identical**. The drift is in the **formatter binary** — PF resolves prettier 3.8.2,
Playform 3.9.6. Same config, different version, different output on the same input.

Root cause is the mechanism TASK-058 identified for lockfiles: `package*.json` is
sync-excluded, so each repo owns its devDependency ranges and a caret range lets the two
resolve to different minors. Playform sync PR #390 is currently red on `Continuous Confidence`
for exactly this.

**Consequences:**

1. Sync PRs are red by default, so red stops carrying information — the same fail-open,
   constant-signal pattern as TASK-057's health endpoint.
2. Manual reformat churn on every sync, which is how the 13-PR backlog in Sprint 1 grew.
3. Any formatter-version-sensitive change silently reformats large diffs on the next sync.

**Resolution (correct + complete — no half-fix):**

1. Pin prettier to an identical **exact** version (no caret) in both repos.
2. Add a check that fails when the two repos' resolved formatter versions diverge — the
   sync-excluded manifest means nothing else can catch it.
3. Run one convergence format pass across both repos so the shared files agree.
4. Extend the same treatment to the rest of the shared toolchain (eslint, typescript), which
   has identical exposure and has simply not bitten yet.

**Close when:** a PF→Playform sync PR passes `format:check` with no manual reformatting, and a
divergence in formatter version between the repos fails a check rather than a sync PR.

---

### TASK-060 — PR backlog accumulates unmerged; branch staleness goes unnoticed

| Field        | Detail                                     |
| ------------ | ------------------------------------------ |
| **ID**       | TASK-060                                   |
| **Type**     | Repo hygiene / process defect              |
| **Severity** | Medium — stale bases and hidden sync state |
| **Phase**    | Phase 5, Sprint 2                          |
| **Target**   | Phase 5, Sprint 4                          |
| **Status**   | Open                                       |
| **Logged**   | 2026-07-26                                 |

**What:** Two related accumulations, neither of which anything alerts on.

_Unmerged PRs._ PF carries 11 open Dependabot PRs, the oldest from 2026-04-20 — over three
months. At least two are already superseded by CI-001 (#229 actions/checkout 7.0.0, #163
setup-node 6.4.0), so merging them would reintroduce changes that landed by another route.
Playform carries a red sync PR (#390) plus a Dependabot PR. Sprint 1 cleared a 13-PR sync
backlog; the backlog re-formed because nothing prevents it, only periodic manual attention.

_Branch staleness._ Separately, PF `develop` sat 38 commits behind `main` with a divergent
`package.json` / `package-lock.json`, and Playform `staging` sat 439 behind. Promotions run
develop→staging→main and nothing back-merges, so the lower branches trail indefinitely. This
session had to cut a fix branch from `main` rather than `develop` as a result.

**Consequences:**

1. Superseded PRs consume review attention and can revert completed work if merged.
2. A red sync PR sitting past its supersede window hides the next real sync failure.
3. New work branched from `develop` starts on a stale base — a defect waiting to happen, and
   the reason the branch base had to be overridden this session.

**Resolution:**

1. Auto-close-on-supersede in the sync workflow, so only the newest sync PR is ever open.
2. Staleness alert when any sync PR ages past N days.
3. Scheduled Dependabot triage cadence, with auto-close for bumps already satisfied elsewhere.
4. Back-merge `main` → `develop` after every promotion so `develop` never trails `main`.
5. A check that reports branch divergence, so trailing branches are visible without asking.

**Close when:** no PR is older than N days without an explicit hold label; `develop` equals
`main` after each promotion; superseded bumps close automatically.

---

**Retargeted Phase 5, Sprint 4:** Partly addressed — 30 stale sync branches deleted. What remains is the Dependabot backlog, which is review time rather than engineering.

### TASK-061 — Function coverage is a target, not a floor; the gap widens by default

| Field        | Detail                                                             |
| ------------ | ------------------------------------------------------------------ |
| **ID**       | TASK-061                                                           |
| **Type**     | Quality gate                                                       |
| **Severity** | Medium — Phase 5 exit-gate risk                                    |
| **Phase**    | Phase 5, Sprint 2                                                  |
| **Target**   | Phase 5, Sprint 4                                                  |
| **Status**   | Resolved — floor raised to 84 by decision; the ratchet is TASK-080 |
| **Logged**   | 2026-07-26                                                         |

**What:** PF function coverage is 80.68% against the ≥84% Phase 5 exit target. Statement
coverage has an enforced floor; function coverage has only a target, and nothing fails when it
drops. The Sprint 1 handoff recorded it as a watch item.

A watch item is the wrong instrument. Sprints 2–6 add the largest function counts of the phase
— agentic workflows, AUX endpoints, adaptive behavior, application RAG, multimodal — so the gap
widens by default, and the correction arrives at the Sprint 7 exit gate where it is most
expensive and most likely to be waived. That is precisely the shape **L22** exists to prevent:
an item that outlives every sprint because no sprint owns it.

**Resolution:**

1. Treat functions exactly like statements: record a per-repo function floor (PF 80.68%,
   Playform 81.18%) and fail the gate on any decrease.
2. Ratchet the floor up at each sprint close to whatever the sprint actually achieved, so
   progress cannot be clawed back.
3. Require each sprint's **new** modules to land at or above 84%, so the average climbs rather
   than holding — a floor alone prevents regression, it does not close a 3.3-point gap.
4. Enforce in the same gate step as statements, not as a separate manual reading.

**Close when:** function floors are enforced and ratcheted per sprint, and PF is ≥84% at the
Phase 5 exit gate.

---

**Retargeted Phase 5, Sprint 4:** Thresholds are now 84/75 and enforced. The auto-ratchet is the remaining piece and no longer urgent.

**Closed with a decision, not silently.** The title admits two readings. _Raise the floor_ is
done: 80 → 84, enforced in CI. _Stop the gap reopening_ is not, and cannot be closed by
changing a number — function coverage now sits at 91.9% against a gate of 84%, and that slack
can absorb a genuine regression without failing.

The slack is deliberate. 84 was chosen over 90 so that ordinary variation does not turn the
gate into noise. What the title actually asks for is a mechanism that lifts the floor as
coverage rises, which is different work: **TASK-080**.

### TASK-064 — ToolBoundary duplicates StepBoundary, and the boundary lookup fails open

| Field        | Detail                                                    |
| ------------ | --------------------------------------------------------- |
| **ID**       | TASK-064                                                  |
| **Type**     | Duplicate vocabulary + fail-open default                  |
| **Severity** | Medium — misclassified P17 boundary in the audit record   |
| **Phase**    | Phase 5, Sprint 2                                         |
| **Target**   | Phase 5, Sprint 3                                         |
| **Status**   | Resolved — one vocabulary, fail closed, coverage asserted |
| **Logged**   | 2026-07-29                                                |

**What:** `platform/admin/types.ts` declares `ToolBoundary = "cognition" | "commitment"` plus a
`TOOL_BOUNDARIES: Record<string, ToolBoundary>` map. `platform/agents/types.ts` declares
`StepBoundary` with the identical union. `config-handlers.ts` bridges the two by annotation:
`const boundary: StepBoundary = TOOL_BOUNDARIES[toolId] ?? "cognition"`. That single line
carries two defects.

_Duplicate vocabulary._ Two declarations of one union in two modules, with nothing tying them
together — they agree today by coincidence, and a future member added to one will not appear in
the other. This is the shape ADR-029 D1 rules out for `EffectType` and `RiskLevel`, and Sprint 2
step 1 collapsed those to a single declaration for exactly this reason. The boundary union was
left because D1 sanctions three additions to `Tool` and `boundary` is not among them.

_Fail-open default._ A tool id absent from `TOOL_BOUNDARIES` records as `cognition` — the
revisable, non-durable side of the P17 boundary. A commitment misfiled as cognition is an
action that looks reversible in the audit record and is not. The default is silent, so the
misclassification is indistinguishable from a correct classification at every point downstream.
Same fail-open shape as TASK-057's health endpoint and the pre-Sprint-2 `resolveTools`.

**Why step 1 did not fix it:** ADR-029 D2 assembles an `ActionContext` per tool invocation and
the boundary belongs there, not on the `Tool` declaration. Fixing it in step 1 would have meant
inventing a field the ADR does not specify and then removing it two steps later.

**Resolution:**

1. Delete `ToolBoundary`; use `StepBoundary` from `platform/agents/types.ts` as the one union.
2. When D2 lands, the boundary is carried on the `ActionContext` — delete `TOOL_BOUNDARIES`
   rather than repointing it.
3. Until D2, make the lookup fail closed: an unmapped tool id is a misconfiguration, not a
   cognition step.
4. Add a conformance arm asserting every `CONFIG_TOOLS` id resolves a boundary without falling
   through to a default, so the map and the roster cannot drift apart unnoticed.

**Close when:** one boundary union exists in the codebase, and no tool id resolves its boundary
via a default.

---

**Retargeted Phase 5, Sprint 3:** ADR-029 surface, and the boundary lookup fails open. Sprint 3 touches the agent runtime again — cheaper with the context loaded than on a cold return.

### TASK-062 — Trajectories are not durable; nothing writes to agent_trajectories

| Field        | Detail                                                      |
| ------------ | ----------------------------------------------------------- |
| **ID**       | TASK-062                                                    |
| **Type**     | Durability gap — unbacked principle                         |
| **Severity** | High — P18 is claimed and not implemented                   |
| **Phase**    | Phase 5, Sprint 2                                           |
| **Status**   | Resolved — SupabaseTrajectoryStore, migration 022, slot #15 |
| **Logged**   | 2026-07-29                                                  |

**What:** `InMemoryTrajectoryStore` is the only implementation, no non-test caller of
`setTrajectoryStore` exists, there is no registry slot for trajectories, and live introspection
confirms `agent_trajectories` holds zero rows. Trajectories live in process memory; on Vercel
serverless they do not reliably survive a request boundary, let alone a crash.

P18 "durable execution trajectories" is asserted in the manifesto readiness table and in the
module header, and is not implemented. ADR-029 D5 (resume) and ADR-031 D6 (crash-window repair)
are unimplementable until it is — resume against an in-memory store is theatre.

**Resolution:** `SupabaseTrajectoryStore` behind registry slot #15, with an ADR-027 conformance
kit. Migration 022 reshapes the table; the store follows in Sprint 2 step 2b.

**Close when:** a trajectory survives a process restart, and the conformance kit asserts it.

---

### TASK-063 — Budgets are not durable, and the daily cap is not a daily cap

| Field        | Detail                                                       |
| ------------ | ------------------------------------------------------------ |
| **ID**       | TASK-063                                                     |
| **Type**     | Cost-control defect + durability gap                         |
| **Severity** | High — unbounded-spend exposure                              |
| **Phase**    | Phase 5, Sprint 2                                            |
| **Status**   | Resolved — SupabaseBudgetStore, migrations 023/024, slot #16 |
| **Logged**   | 2026-07-29                                                   |

**What:** Three defects that compound.

_Not durable._ `BudgetTracker` holds a `Map` and `agent_budgets` has zero rows, so nothing
accumulates across instances. On serverless each invocation starts at zero spend, which means
`maxCostPerDay` is effectively unenforced in production.

_The period is monthly, the cap is daily._ `getCurrentPeriod()` returns `YYYY-MM`, and that
monthly accumulator is compared against `config.maxCostPerDay`. The field name and the
enforcement window disagree by roughly thirty times.

_The step cap counts the wrong thing._ `usedSteps` accumulates per agent per scope per period
and is compared against `maxStepsPerTrajectory`. With the seeded `agent.trajectory.max_steps`
of 50, an agent gets 50 steps per period in total rather than per trajectory, then is blocked
until the period rolls. A per-trajectory limit belongs to the runtime, which is where the
trajectory is.

**Resolution:** budget persistence behind registry slot #16 with atomic increment
(`used_usd = used_usd + $1`, never read-modify-write); period becomes `YYYY-MM-DD`; the step
cap moves out of the budget tracker to the runtime.

**Close when:** spend accumulates across instances, the cap window matches the config field
name, and the step limit is enforced per trajectory.

---

### TASK-067 — Nothing checks that the schema a store writes actually exists

| Field        | Detail                                                               |
| ------------ | -------------------------------------------------------------------- |
| **ID**       | TASK-067                                                             |
| **Type**     | Test-coverage gap / schema drift                                     |
| **Severity** | Medium — passes green, fails at first real call                      |
| **Phase**    | Phase 5, Sprint 2                                                    |
| **Target**   | Phase 5, Sprint 3                                                    |
| **Status**   | Resolved — npm run schema:check, derived from source, enforced in CI |
| **Logged**   | 2026-07-29                                                           |

**What:** Migration 023 shipped a Postgres function referencing `agent_budgets.used_steps`,
a column that did not exist. The full gate was green, both conformance arms passed, and the
failure appeared on the first real call. Migration 024 fixes it forward.

The gate could not have caught it. Each Supabase conformance arm fakes `global.fetch` with an
in-memory PostgREST that stores whatever keys the store sends and returns them — it validates
the store against itself. Column existence, column types, constraints, enum membership and
function signatures are all structurally invisible to it. That is a real bound on what the
Supabase arms of `socialStore`, `realtime`, `trajectoryStore` and `budgetStore` prove: they
prove the store's URL building, filter construction and row mapping are self-consistent, not
that the schema on the other end matches.

Compounding it, there is no migration-tracking table (TASK-065), so "the migration applied"
is itself only knowable by introspection.

Two dead columns are the standing evidence: `agent_budgets.used_tokens` and `budget_tokens`
came from migration 016 and nothing has ever written either. The code counts steps and spend;
the table was built for tokens and spend. Nothing flagged the divergence for three phases.

**Resolution:**

1. A schema-parity check that asserts, against the live database, that every column and
   function each Supabase store references exists with the expected type — the introspection
   done by hand this sprint, automated.
2. Decide `used_tokens` / `budget_tokens`: populate them from trajectory cost, or drop them.
   A column nothing writes is a claim the schema makes and the code does not honour.
3. Consider generating the row types from the live schema so a missing column is a compile
   error rather than a runtime one.

**Close when:** a referenced-but-absent column or function fails a check rather than a
production call, and no budget column is unwritten.

---

**Retargeted Phase 5, Sprint 3:** The gap that let migration 023 ship a column that did not exist. Four durable stores landed in Sprint 2, so the exposure grew rather than held.

### TASK-070 — Overrides are unaudited; one of them pinned us to a vulnerable version

| Field        | Detail                                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **ID**       | TASK-070                                                                                                                                         |
| **Type**     | Dependency hygiene                                                                                                                               |
| **Severity** | Medium — the failure mode is silent and points the wrong way                                                                                     |
| **Phase**    | Phase 5, Sprint 2                                                                                                                                |
| **Target**   | Phase 5, Sprint 7                                                                                                                                |
| **Status**   | Open — register + drift guard landed (Sprint 6.5 M6a); reaudit cadence landed (Sprint 7 m2: scripts/override-reaudit.mjs on the scheduled sweep) |
| **Logged**   | 2026-08-04                                                                                                                                       |

**What:** `package.json` currently overrides `postcss`, `sharp` and `brace-expansion@5`.
Nothing records why any of them exist, when they were added, or what would allow their
removal.

That is not academic: `"brace-expansion@5": "5.0.8"` was added as the fix for
CVE-2026-14257, and when GHSA-rgw5-rvv9-x895 disclosed that 5.0.8 bypasses that mitigation,
the override held the tree at the vulnerable version. The audit gate failed for a day and the
override read as inert, because a second broader override added alongside it was silently
losing to the more specific entry.

An override is a claim that a dependency's own choice is wrong. Claims expire, and an expired
override is worse than none: it is invisible, it survives `npm update`, and it points
diagnosis away from itself.

**Resolution:**

1. Annotate each override with why it exists and what would let it go — a comment block above
   the `overrides` key, or a short section in the security docs.
2. Give each one a removal task, as TASK-069 does for `brace-expansion`.
3. Add a periodic check that every override is still necessary: remove it, install, audit,
   and see whether anything breaks.

**Close when:** every override in `package.json` has a recorded reason and a removal
condition.

---

**Retargeted Phase 5, Sprint 4:** Filed during Sprint 2 as follow-on hygiene, not as Sprint 2 work.

### TASK-066 — SupabaseActivityStateStore is built on the JS client and cannot be conformance-tested

| Field        | Detail                                                    |
| ------------ | --------------------------------------------------------- |
| **ID**       | TASK-066                                                  |
| **Type**     | Test-coverage gap / pattern divergence                    |
| **Severity** | Medium — it shipped dead for a sprint and nothing said so |
| **Phase**    | Phase 5, Sprint 2                                         |
| **Status**   | Resolved — realigned to raw fetch, conformance arm added  |
| **Logged**   | 2026-07-29                                                |

**What:** Two Supabase transport patterns exist in this codebase. The social, moderation,
trajectory, budget, proposal and effect-ledger stores use raw `fetch` against `/rest/v1/`,
and each has a conformance arm that runs the real class against an in-memory PostgREST fake
— the mapper, filters and URL building all execute. `SupabaseActivityStateStore` uses
`createClient` from `@supabase/supabase-js`, and is the only registry slot with no Supabase
conformance arm.

That is not a coincidence. A fetch-level fake cannot intercept the JS client, so the arm was
never written, so nothing exercised the store — and it shipped in Sprint 1 against a table
(`app_sessions`) that had never been created, staying dead for a full sprint behind a green
gate. Migration 022 created the table; the store still has no arm.

**Resolution:** realign `SupabaseActivityStateStore` to raw `fetch`, matching its six
siblings, and add the missing conformance arm. The CAS commit maps to
`PATCH ?id=eq.X&version=eq.N` with `Prefer: return=representation`, exactly as
`SupabaseTrajectoryStore` does — zero rows returned is the conflict signal.

**Close when:** every registry slot with a Supabase implementation has a Supabase
conformance arm.

---

### TASK-068 — Decide whether compensation should unwind automatically

| Field        | Detail                                             |
| ------------ | -------------------------------------------------- |
| **ID**       | TASK-068                                           |
| **Type**     | Deferred design decision                           |
| **Severity** | Low — a decision to make on evidence, not a defect |
| **Phase**    | Phase 5, Sprint 2                                  |
| **Target**   | Phase 5, Sprint 4                                  |
| **Status**   | Open — deliberately                                |
| **Logged**   | 2026-07-29                                         |

**What:** ADR-029 D6 says rollback appends compensating actions but does not say who triggers
it. Sprint 2 implemented `compensateTrajectory()` as an **invoked** entry point: a caller
decides to unwind. The alternative — the runtime unwinding automatically when a workflow
fails — is more useful and considerably larger, and needs semantics no current use case
constrains: what happens when a compensation itself fails, whether unwinding is ordered or
parallel, whether a partially-unwound trajectory is `failed` or something new.

Deferring is deliberate. This entry exists so that decision is made on evidence rather than
on the feeling that the system ought to do it by itself.

**Signals that automatic unwinding is now needed**, roughly in order of likelihood:

1. **Callers wrapping every workflow in the same try/catch.** Consumer code doing
   `catch { await compensateTrajectory(id) }` at every call site is the invoked path being
   used as if it were automatic, duplicated per consumer. Visible in code review.
2. **Failed trajectories that were never compensated.** Query `status = 'failed'` intersected
   with trajectories having commitment-boundary steps and no step carrying `compensates`. A
   growing set means someone forgot, and forgetting is what automation prevents. Measurable
   today.
3. **A compensation that itself needs a policy.** The first time a compensation fails,
   someone decides ad hoc: retry, escalate, mark indeterminate. Once two callers decide
   differently for the same situation, the policy belongs in the platform.

**Not a signal:** "it feels like the system should do this itself." That is how unwinding
semantics nobody asked for get built.

**Close when:** one of the three signals is observed and the decision is recorded, or Phase 5
ends without any of them and the entry is closed as "invoked is sufficient".

---

**Retargeted Phase 5, Sprint 4:** Open by decision. Target is when the trigger criteria are re-reviewed, not when it must be built.

### TASK-071 — There is no session load path, so crash repair must be called explicitly

| Field        | Detail                                                    |
| ------------ | --------------------------------------------------------- |
| **ID**       | TASK-071                                                  |
| **Type**     | Missing lifecycle hook                                    |
| **Severity** | Medium — repair exists and nothing calls it               |
| **Phase**    | Phase 5, Sprint 2                                         |
| **Status**   | Resolved — loadSession calls repairSession; migration 029 |
| **Logged**   | 2026-08-04                                                |

**What:** ADR-031 D6 specifies crash-window repair "on session load". `repairSession()` now
implements the repair, but there is no session load path to call it from: `createSession()`
creates, and nothing in the framework loads an existing session. `ActivityStateStore.load()`
exists on the contract and only the stores themselves call it.

Rather than invent a lifecycle hook to satisfy the ADR's wording, `repairSession` is an
explicit entry point. That is honest but incomplete: a repair nothing calls repairs nothing,
and the crash window stays open in practice.

**Resolution:** add `loadSession()` to the app framework — reconstructing an ActivitySession
from persisted state plus its trajectory — and call `repairSession` from it before returning.
That is where the ADR intends the check, and it is also the natural home for the reconstruct
path the framework currently lacks.

**Close when:** a session loaded after an interrupted commit has its trajectory tail
completed without the caller asking.

---

### TASK-072 — Turn advancement is not durable until the coordinator owns it

| Field        | Detail                                                |
| ------------ | ----------------------------------------------------- |
| **ID**       | TASK-072                                              |
| **Type**     | Partial durability                                    |
| **Severity** | Low — correct when callers cooperate, silent when not |
| **Phase**    | Phase 5, Sprint 2                                     |
| **Target**   | Phase 5, Sprint 4                                     |
| **Status**   | Open                                                  |
| **Logged**   | 2026-08-04                                            |

**What:** Migration 029 and `SessionMeta` make turn state durable, so a turn-based session no
longer loses whose turn it is on restart. But `dispatch()` only CHECKS turn order — it does
not advance it. Advancement lives in `turn.ts` and is the caller's to invoke, so the caller
must also call `updateSessionMeta()` afterwards or the persisted turn goes stale.

Durability that depends on the caller remembering is durability only when they remember.

**Resolution:** move turn advancement into the coordinator, so `dispatch()` advances the turn
and persists it in the same sequence that commits the state. That is where ADR-028 D6's
turn-based core belongs; it sits outside today because turn advancement predates the pipeline
extraction.

**Close when:** a turn-based session advanced through `dispatch()` and reloaded reports the
correct current actor without the caller persisting anything.

---

**Retargeted Phase 5, Sprint 4:** Filed during Sprint 2 as what Sprint 2 deliberately left; the fix belongs with the coordinator work.

### TASK-073 — ADR-030 is reserved for AUX and not yet written

| Field        | Detail                                     |
| ------------ | ------------------------------------------ |
| **ID**       | TASK-073                                   |
| **Type**     | Documentation reservation                  |
| **Severity** | Low — a known hole, not a missing decision |
| **Phase**    | Phase 5                                    |
| **Target**   | Phase 5, Sprint 7                          |
| **Status**   | Closed 2026-08-14                          |
| **Logged**   | 2026-08-04                                 |

**What:** `docs/adr/` runs 029 → 031. ADR-030 is reserved for AUX (Agent User Experience),
named in the ROADMAP changelog entry that opened Phase 5 alongside ADR-028 and ADR-029.
ADR-031 (action identity and lifecycle) was written ahead of it because Sprint 2 needed the
protocol, so the number was consumed before the document existed.

The phase exit gate E6 asks for ADRs "committed and numbered sequentially" and will find this
hole. It is a reservation, not an omission: no decision is undocumented, and AUX is scheduled
later in Phase 5.

**Not renumbering.** ADR-031 is cited in roughly forty places across code comments, tests,
commit messages and docs. Moving it would break every one of those references to tidy a
number, and a broken citation is worse than a gap in a sequence.

**Resolution:** write ADR-030 when AUX is designed, which closes the gap in the natural order.
If Phase 5 reaches its exit gate with AUX still unbuilt, record the reservation against E6
rather than treating it as a failure — the gate's intent is that no decision goes
undocumented, and none has.

**Close when:** ADR-030 exists, or Phase 5 exits with the reservation explicitly recorded.

**Closed 2026-08-14:** ADR-030 written in full at `docs/adr/ADR-030-agent-user-experience.md`, ratifying the AUX_DESIGN Sprint 3b
rewrite. The 029 → 031 gap is filled. This entry is retained (not deleted) so the
ADR-030 reference that keeps the sequence explained stays in place (GOTCHA-70).

---

**Retargeted Phase 5, Sprint 7:** Reserved. Target is the phase exit, where E6 will encounter the ADR gap.

### TASK-069 — Remove the brace-expansion override once upstream ships a clean tree

| Field        | Detail                                      |
| ------------ | ------------------------------------------- |
| **ID**       | TASK-069                                    |
| **Type**     | Dependency stopgap                          |
| **Severity** | Low — correct today, and should not persist |
| **Phase**    | Phase 5, Sprint 2                           |
| **Target**   | Phase 5, Sprint 4                           |
| **Status**   | Open                                        |
| **Logged**   | 2026-08-04 (backfilled — see below)         |

**What:** Both repos override `brace-expansion@5` to `5.0.9` to clear GHSA-rgw5-rvv9-x895,
which reaches production through `@sentry/nextjs` → `@sentry/bundler-plugin-core` → `glob` →
`minimatch`. Sprint 2 added four more override entries for the 1.x and 2.x lines and for
`js-yaml`, clearing the dev audit.

Every cleaner option was checked: `npm audit fix` re-reports the advisory because npm will
not replace a nested pin; `@sentry/nextjs` 10.68 and 10.69 both still require
`bundler-plugin-core ^5.3.0`, the only published release; and moving Sentry to
devDependencies would silence the gate while misrepresenting a dependency that
`platform/observability/error-reporting.ts` imports at runtime.

An override forces a version a dependency did not choose. Acceptable for a package this
small with a stable API; not acceptable indefinitely, because an override left in place
quietly pins a transitive dependency long after the reason has gone.

**Backfill note:** this entry is dated 2026-08-04 but describes work done on 08-03. The
commit that would have filed it aborted at the audit gate, the rerun filed TASK-070 only, and
"TASK-069/070, the override hygiene pair" then appeared in three commit messages and in
SPRINT2_ASSESSMENT.md referring to a task that did not exist. Recorded here rather than
renumbering TASK-070, and noted rather than quietly backdated.

**Resolution:** watch for a `@sentry/bundler-plugin-core` release whose `glob`/`minimatch`
chain resolves `brace-expansion` outside the vulnerable range, upgrade, and delete the
override. Same for the jest and istanbul toolchain entries.

**Close when:** `npm audit --audit-level=high` passes with no `brace-expansion` or `js-yaml`
entry in `overrides`.

---

**Retargeted Phase 5, Sprint 4:** Filed during Sprint 2 as a stopgap to remove later, not as Sprint 2 work.

### TASK-074 — Playform's song-ID probe reports on an instance nothing serves traffic from

| Field        | Detail                                                             |
| ------------ | ------------------------------------------------------------------ |
| **ID**       | TASK-074                                                           |
| **Type**     | Observability defect (consumer repo)                               |
| **Severity** | Medium — the probe can report healthy while traffic fails          |
| **Phase**    | Phase 5, Sprint 3a                                                 |
| **Target**   | Phase 5, Sprint 3a                                                 |
| **Status**   | Resolved — Playform probes getSongIdProvider(), with a drift guard |
| **Logged**   | 2026-08-04                                                         |

**What:** Playform's `instrumentation.ts` calls `initProviders()`, then constructs a **second**
`ACRCloudIdentifier` and registers the health probe around that new instance. The probe
therefore reports on an object nothing is using. If the live provider is misconfigured and
the freshly constructed one happens to work, the probe says healthy while every request
fails.

platform-foundation already fixed exactly this and left the reason in a comment: the probe
must wrap "the LIVE provider stored by `initProviders()` — not a freshly constructed
duplicate — so the probe reports on the instance actually serving traffic" (TASK-041,
Gotcha 27). `instrumentation.ts` does not sync between repos, so the fix did not travel.

**Resolution:** use `getSongIdProvider()` in Playform as platform-foundation does, and add a
guard so the consumer cannot drift back — a test asserting `instrumentation.ts` constructs no
provider directly.

**Close when:** Playform's probe wraps the registered provider, with a test that fails if a
provider is constructed inside `instrumentation.ts`.

---

### TASK-075 — Superseded by TASK-075a and TASK-075b

| Field        | Detail                   |
| ------------ | ------------------------ |
| **ID**       | TASK-075                 |
| **Type**     | Deployment configuration |
| **Severity** | Superseded               |
| **Phase**    | Phase 5, Sprint 3a       |
| **Target**   | Phase 5, Sprint 3b       |
| **Status**   | Superseded 2026-08-14    |
| **Logged**   | 2026-08-11               |

Split on 2026-08-14 after investigation found its premise wrong. The store-arm verification
became TASK-075a and closed; the cross-request durability check became TASK-075b and carries
to Sprint 3b.

This entry is retained rather than deleted because the id is cited elsewhere — ADR-032 among
them — and a cited id with no entry is a dangling reference the register-integrity suite
fails on. Recording the supersession where the gate looks is cheaper than editing every
citation (Gotcha 70).

---

### TASK-075a — Supabase store arms had never executed

| Field        | Detail                                                   |
| ------------ | -------------------------------------------------------- |
| **ID**       | TASK-075a                                                |
| **Type**     | Verification                                             |
| **Severity** | Medium — five code paths with no execution outside stubs |
| **Phase**    | Phase 5, Sprint 3a                                       |
| **Target**   | Phase 5, Sprint 3b                                       |
| **Status**   | Closed 2026-08-14                                        |
| **Logged**   | 2026-08-11                                               |

**What:** TASK-075 was filed as "five variables are unset in the deployment environment."
Investigation on 2026-08-14 found the premise wrong in three ways.

`TRAJECTORY_STORE`, `BUDGET_STORE`, `PROPOSAL_STORE`, `EFFECT_LEDGER` and `APP_STATE_STORE`
are set in **no** environment — not production, not `.env.local`. The registry has therefore
never selected a Supabase arm anywhere, localhost included. What has run on localhost is the
voice pipeline (`/api/extract`, `/api/identify`, `/api/process`, `/api/transcribe`,
`/api/tts` in Playform), which calls providers directly and touches no store.

Nor were the credentials present: no Supabase variable existed in any of the four Vercel
projects. The stores could not have been switched on had the variables been set.

And nothing serves traffic. The four Vercel projects are build targets; the only running
instance has ever been localhost.

**What was actually at risk:** the five Supabase store implementations had executed only
against conformance kits, which verify stores rather than wiring — the same gap that hid the
ADR-032 defect for twenty-one singleton families.

**Resolution:** each of the five exercised against the live database, writing then reading
back through a **second instance** of the store, which is cross-instance evidence without
needing an HTTP layer. All five pass.

| Store                        | Proof                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| `SupabaseTrajectoryStore`    | `create` then `getById` and `query` from a fresh instance                             |
| `SupabaseBudgetStore`        | `increment` then `read`; `usedSteps` advanced by exactly 1                            |
| `SupabaseProposalStore`      | `create` then `getById` from a fresh instance                                         |
| `SupabaseEffectLedger`       | `begin` twice on one (operationId, effectKey); same `entryId`, `attempts` incremented |
| `SupabaseActivityStateStore` | `create` then `load` and `delete` from a fresh instance                               |

Schema confirmed first by introspection rather than from the migration ledger: all five
tables present, every `NOT NULL` column without a default supplied by its insert body, the
`agent_budget_consume` RPC present with its six arguments, and `trajectory_status` carrying
the `running` label the code writes.

**Close condition (met):** every Supabase store arm completes a write-then-read round trip
against the live database from a separate instance.

**Out of scope, deliberately:** `MODERATION_STORE` and `SOCIAL_STORE` are also
durable-capable and also unset. They are not agent stores and Sprint 3b does not need them.
Recorded here so the omission is a decision rather than an oversight.

**Decision — Vercel provisioning deferred.** Nothing serves traffic, and four projects would
each need credentials. Provisioning happens when a deployment first serves a request, not
before. `lib/supabase/server.ts` requires `NEXT_PUBLIC_SUPABASE_URL` specifically and
`getSupabaseBrowserClient` requires `NEXT_PUBLIC_SUPABASE_ANON_KEY`, which TASK-075 never
mentioned and which PF's `.env.local` still lacks.

---

### TASK-075b — Cross-request durability is unprovable until an agent endpoint exists

| Field        | Detail                                                        |
| ------------ | ------------------------------------------------------------- |
| **ID**       | TASK-075b                                                     |
| **Type**     | Verification                                                  |
| **Severity** | Medium — the demo's premise depends on it                     |
| **Phase**    | Phase 5, Sprint 3a                                            |
| **Target**   | Phase 5, Sprint 3b — with the B-layer endpoint, not before it |
| **Status**   | Open                                                          |
| **Logged**   | 2026-08-14                                                    |

**What:** TASK-075's close condition — a trajectory written by one request is readable by
another — cannot be run today. Nothing in `app/` calls `executeAgent`, and nothing in `app/`
imports `platform/app-framework`. The agent runtime and the session lifecycle are both
platform code with no HTTP caller in either repo.

`/api/health` cannot substitute: `instrumentation.ts` registers one probe, for song
identification. No probe reports a store. The only slot-level signal in existence is the
`Platform providers initialized` log line.

**Why this is not a blocker for Sprint 3b:** the store arms are proven (TASK-075a). What is
unproven is the path from a request to a store, and that path is precisely what the B-layer
builds. Filing it as a prerequisite made a piece of the work look like a predecessor to it.

**Resolution:** when `/api/agent/process-content` lands, set the five variables in
`.env.local`, run one agent call, then confirm the trajectory is readable by a second
request. That is the same curl the demo depends on.

**Close when:** an agent invoked over HTTP writes a trajectory that a subsequent request
reads back.

### TASK-076 — Nothing detects sustained silence from telemetry

| Field        | Detail                                                     |
| ------------ | ---------------------------------------------------------- |
| **ID**       | TASK-076                                                   |
| **Type**     | Operational monitoring                                     |
| **Severity** | Medium — the failure mode is indistinguishable from health |
| **Phase**    | Phase 5, Sprint 3a                                         |
| **Target**   | Phase 5, Sprint 4                                          |
| **Status**   | Open                                                       |
| **Logged**   | 2026-08-11                                                 |

**What:** Sentry has been configured and receiving nothing, because observability was
initialised on a bundle copy no route read. Nobody noticed, because an absence of errors looks
exactly like an absence of problems.

An application that cannot report is also unable to report that it cannot. The check therefore
has to live outside the process.

**Resolution:** two alerts, both console configuration rather than code.

1. A Sentry alert rule on "no events received in 24 hours" for the production project.
2. An uptime monitor polling `/api/health` and alerting on a 503 or a non-200, now that the
   endpoint reports the truth (TASK-057).

**Close when:** stopping telemetry produces an alert within a day, verified by test rather
than assumed.

---

### TASK-077 — Provider accessors do not warn when configuration did not arrive

| Field        | Detail                                                       |
| ------------ | ------------------------------------------------------------ |
| **ID**       | TASK-077                                                     |
| **Type**     | Observability of configuration                               |
| **Severity** | Medium — this is the property that let ADR-032's defect hide |
| **Phase**    | Phase 5, Sprint 3a                                           |
| **Target**   | Phase 5, Sprint 4                                            |
| **Status**   | Open                                                         |
| **Logged**   | 2026-08-11                                                   |

**What:** ADR-032 D5 says a fallback that fires because configuration did not arrive is an
error, not a default. The startup self-check now logs what each slot resolved to, which
catches the common case at boot — but the twenty accessors themselves still return an
in-memory default silently when nothing was registered.

That silence is what made the bundle-split defect invisible for months: `getTrajectoryStore()`
returning an in-memory store when `TRAJECTORY_STORE=supabase` is set is not graceful
degradation, it is a silent substitution of something the operator did not ask for.

**Not folded into the conversion commit** because it is twenty more edits on top of twenty
conversions, and the combined diff would not be reviewable.

**Resolution:** each accessor consults the resolved-provider map. If the environment selected
a provider for that slot and the registry holds nothing, warn once with the slot name and the
requested provider. Once, not per call — a per-request warning becomes noise and noise is
another way to be invisible.

**Close when:** setting `TRAJECTORY_STORE=supabase` without a working Supabase config produces
a warning naming the slot, rather than silent in-memory behaviour.

---

### TASK-078 — sustainability-gate.sh is wired into neither CI

| Field        | Detail                                              |
| ------------ | --------------------------------------------------- |
| **ID**       | TASK-078                                            |
| **Type**     | Automation that is not automated                    |
| **Severity** | Medium — the gate runs only when somebody remembers |
| **Phase**    | Phase 5, Sprint 3a                                  |
| **Target**   | Phase 5, Sprint 4                                   |
| **Status**   | Open                                                |
| **Logged**   | 2026-08-11                                          |

**What:** `scripts/sustainability-gate.sh` exists in both repositories and is referenced by
neither `ci.yml`. The 22-point sustainability gate — the one the closure checklist says no
sprint ships without — is a script nobody runs.

At Sprint 2 closure it was executed by hand, via a Python script written for the occasion that
re-implemented much of what this shell script already does. Nobody noticed the script existed,
which is the ordinary outcome for automation that no pipeline invokes.

**Why not fixed alongside the CI parity work:** the gate's 22 points are not all machine
checkable. Roughly half are judgement — whether names are intent-based, whether an
abstraction earns its place — so wiring it in as a hard gate would either fail constantly or
have to be reduced to the countable subset. Which of those it should be is a decision, not a
mechanical fix.

**Resolution:** decide whether the script gates or reports. If it gates, split the countable
points into a blocking step and leave the judged ones as an artifact a reviewer reads. If it
reports, run it on a schedule and publish the output somewhere a human sees it.

**Close when:** the sustainability gate runs without anyone remembering to run it.

---

### TASK-079 — platform/input is imported by nothing; decide what it is

| Field        | Detail                                                                  |
| ------------ | ----------------------------------------------------------------------- |
| **ID**       | TASK-079                                                                |
| **Type**     | Unresolved module status                                                |
| **Severity** | Low — nothing is broken; nothing is using it either                     |
| **Phase**    | Phase 5, Sprint 3a                                                      |
| **Target**   | Phase 5, Sprint 4                                                       |
| **Status**   | Resolved — a public surface; five callers across both repos, documented |
| **Logged**   | 2026-08-11                                                              |

**What:** `grep -rn "@/platform/input" platform/` returns nothing. Seven files — rule-based and
LLM-backed classification, rule-based and LLM-backed intent resolution, and a conductor that
orchestrates them — and no module in the platform imports any of it.

That is either fine or a problem, and which one it is has never been decided:

- **A public surface.** A consuming application calls `platform/input` directly to classify an
  inbound request before dispatching it. If so, the module needs a consumer example in its
  README and at least one integration test proving the path works end to end.
- **Unreached.** It was built for a pipeline that took a different shape. If so, it is
  ~1,400 lines carrying maintenance cost, appearing in coverage figures, and syncing to
  Playform on every run.

Playform does not import it either, which is the stronger signal: the one consuming
application does not use the module built for consuming applications.

**Resolution:** determine whether anything is meant to call it. If yes, document the entry
point and add the integration test. If no, remove it — and record what it was for, so the next
person solving that problem finds the prior attempt rather than repeating it.

**Close when:** `platform/input` has a documented caller, or is gone.

---

### TASK-080 — Nothing stops coverage slack from re-accumulating

| Field        | Detail                                                    |
| ------------ | --------------------------------------------------------- |
| **ID**       | TASK-080                                                  |
| **Type**     | Quality-gate mechanism                                    |
| **Severity** | Low — the gate works today; it degrades quietly over time |
| **Phase**    | Phase 5, Sprint 3a                                        |
| **Target**   | Phase 5, Sprint 4                                         |
| **Status**   | Open                                                      |
| **Logged**   | 2026-08-11                                                |

**What:** platform-foundation holds 89.2% statements and 91.9% functions against gates of 80
and 84. Playform holds 89.9 and 91.5 against the same. That is five to eight points of slack on
every axis, and slack is what a gate cannot see: a sprint that adds untested code and drops
function coverage from 91.9% to 85% passes.

TASK-061 named this and was closed by raising the floor once, which fixes the instance and not
the mechanism. The gap it described has already begun re-accumulating from a higher base.

**Why it is not simply "set the gate to 90":** a gate immediately below the current figure
fails on ordinary variation — a refactor that removes covered lines, a dependency bump that
changes what instruments. The gate then gets raised, lowered, or ignored, and an ignored gate
is worse than a loose one.

**Resolution:** a ratchet with hysteresis. Record the achieved figure per axis when a sprint
closes; if the next run exceeds it by more than a margin, raise the floor to the achieved
figure minus that margin. Never lower it automatically — a fall is a finding, not a new
baseline.

Where it lives is part of the decision: a committed baseline file that CI compares against, or
a step in the closure script. The first is enforced on every commit; the second only when a
sprint closes.

**Close when:** slack above the margin raises the floor without anyone editing package.json.

---

### TASK-081 — CodeQL on Playform is deferred on cost, not overlooked

| Field        | Detail                                                          |
| ------------ | --------------------------------------------------------------- |
| **ID**       | TASK-081                                                        |
| **Type**     | Security tooling — deferred spend                               |
| **Severity** | Low while nobody deploys from Playform; Medium once anyone does |
| **Phase**    | Phase 5, Sprint 3a                                              |
| **Target**   | When Playform carries real traffic                              |
| **Status**   | Open — deferred by decision                                     |
| **Logged**   | 2026-08-12                                                      |

**What:** CodeQL SAST runs on platform-foundation and not on Playform. The CI-parity work
(TASK-056) copied the workflow across, and it fails at its upload step: GitHub Code Security
must be enabled for the repository, which is free for public repos and billed per active
committer for private ones — **$30/month** here.

The workflow has been removed rather than left failing. A permanently red check trains everyone
to ignore a failing pipeline, and the next genuine failure then looks the same.

**Why deferred rather than paid:**

- Playform's source is overwhelmingly synced from platform-foundation, which has CodeQL and
  scans the same code. The Playform-only surface is the UI, `lib/` and the route handlers.
- Semgrep runs on both repos, so neither is unscanned — this is a second opinion, not the
  only one.
- Nothing deploys from Playform yet.

**Why it should not stay deferred forever:** Playform is the repo that handles authentication,
user content and API keys. Once it carries traffic, the argument reverses — the deployed
application is exactly where a second SAST opinion earns its cost.

**Resolution:** enable Code Security on the Playform repository and restore
`.github/workflows/codeql.yml` from platform-foundation, which is where the working copy
lives.

**Close when:** CodeQL runs green on Playform, or the repo is public and it costs nothing.

---

### TASK-082 — Six major-version bumps, each needing work rather than a merge

| Field        | Detail                                      |
| ------------ | ------------------------------------------- |
| **ID**       | TASK-082                                    |
| **Type**     | Dependency upgrades                         |
| **Severity** | Low for most; Medium for eslint-config-next |
| **Phase**    | Phase 5, Sprint 3a                          |
| **Target**   | Phase 5, Sprint 4                           |
| **Status**   | Open                                        |
| **Logged**   | 2026-08-12                                  |

**What:** the Dependabot triage separated patches and minors — merged — from majors, which
change behaviour by definition and may pass CI while doing so.

| Bump                                                                                              | Repos    | Note                                                                                                              |
| ------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `eslint-config-next` 15 → 16                                                                      | both     | **Both repos run Next 16 and pin the v15 config.** The linter's rules lag the framework by a major. Not optional. |
| `eslint` 9 → 10                                                                                   | both     | Flat-config changes likely; `eslint.config.mjs` will need review                                                  |
| `typescript` 5.9 → 6                                                                              | PF       | **Already fails PF's type-check.** Code work, not a merge                                                         |
| `typescript` 5.9 → 7                                                                              | Playform | Two majors ahead; do PF's 6 first                                                                                 |
| `@types/node` 20 → 26                                                                             | Playform | Six majors; likely surfaces type errors the runtime never hits                                                    |
| `dotenv` 16 → 17, `@napi-rs/canvas` 0.1 → 1.0, `jest-dom` 6 → 7, `@anthropic-ai/sdk` 0.98 → 0.115 | Playform | Pass CI. `0.x` packages break at any version by convention                                                        |

**Sequence, and why it matters:** one at a time, each in its own commit. A major that breaks
something subtle needs to be identifiable — six merged together produce a failure nobody can
attribute. Start with `eslint-config-next`, which is a real mismatch rather than an optional
upgrade, then ESLint 10 (they interact), then TypeScript, then the rest.

**Why not now:** this is a day of work, not a merge session. TypeScript 6 alone means fixing
whatever it flags across 190 test suites.

**Close when:** each bump is merged or explicitly declined with a reason, and no major sits
open untriaged.

---

### TASK-083 — Sync cannot tell an orphan from a Playform file

| Field        | Detail                                                |
| ------------ | ----------------------------------------------------- |
| **ID**       | TASK-083                                              |
| **Type**     | Sync tooling                                          |
| **Severity** | Low — the sync is correct; the reviewer is uninformed |
| **Phase**    | Phase 5, Sprint 3a                                    |
| **Target**   | Phase 5, Sprint 4                                     |
| **Status**   | Open                                                  |
| **Logged**   | 2026-08-13                                            |

**What:** the sync runs `rsync` without `--delete` by design (Sprint 7, item D), so a file
platform-foundation deletes stays in Playform indefinitely. That has cost a debugging cycle
once already: `__tests__/auth-config-lazy-init.test.ts` was removed upstream, the orphan
remained, and it failed the sync PR's own CI.

An attempt to report those files via `rsync --dry-run --delete` was made and reverted. It
listed roughly forty files on its first run, nearly all of them Playform's own application —
`lib/usePlayformConductor.ts`, `components/SongMatchCard.tsx`, `app/api/profile/`,
`supabase/migrations/007_playform_subscription_tiers.sql`. That is not a bug in the flag: a
dry run compares the whole target against the whole source, and for a PARTIAL sync a
consumer-owned file is byte-for-byte the same observation as an upstream deletion.

**Why no filter fixes it:** the two cases are indistinguishable from a single snapshot. The
question "did this exist upstream last time?" needs last time's answer.

**Resolution:** have the workflow record the source's file list on each successful sync — a
committed manifest, or an artifact keyed by the synced SHA. The next run diffs against it, and
the difference IS the deletion set. Genuine orphans, no noise.

Roughly: `git -C source ls-files > .github/sync-manifest.txt` written on each sync, and the
next run reporting `comm -23 previous current`.

**Close when:** a file deleted in platform-foundation appears in the next sync PR, and nothing
else does.

---

### TASK-084 — The L21 response kit has no arm until the workflow loop exists

| Field        | Detail                                                  |
| ------------ | ------------------------------------------------------- |
| **ID**       | TASK-084                                                |
| **Type**     | Conformance coverage                                    |
| **Severity** | Medium — an unrun kit is the checklist ADR-027 replaced |
| **Phase**    | Phase 5, Sprint 3b                                      |
| **Target**   | Phase 5, Sprint 3b                                      |
| **Status**   | Closed — arm landed, all eight requirements run         |
| **Closed**   | 2026-08-15                                              |
| **Logged**   | 2026-08-15                                              |

**What:** `__tests__/contract/agent-response-contract.ts` ships with eight arms and nothing
invokes it. Its fixtures require both entry points of the PF-B workflow loop —
`runOrchestrated` and `runChoreographed` — and that loop is the next commit. The manifest
entry exists, so `conformance-coverage.test.ts` is satisfied; that test asserts a kit is
present and callable, not that anything calls it.

**Why this is a real gap and not bookkeeping:** ADR-027 exists because
`auth-provider.test.ts` described a contract and instructed a human to run it against the
real provider, and nobody ever did. A kit with no arm is that same artifact. Every assertion
in it is unexecuted, so a typo in an arm typechecks and never fires.

**Resolution:** the workflow loop commit adds `__tests__/agent-response-conformance.test.ts`,
wiring the kit against the in-memory trajectory store and the loop's two entry points, in the
shape `agentic-workflow-conformance.test.ts` already uses. Arms R6 (gate parity) and R7
(budget) are the ones that only become meaningful there — both compare or constrain real
runs, and neither can be satisfied by a stub.

**Close when:** `agent-response-conformance.test.ts` exists, runs all eight arms green, and
R6 compares two trajectories with at least two gated steps each.

**Resolution (2026-08-15):** `__tests__/agent-response-conformance.test.ts` wires the kit to
the workflow loop over `InMemoryTrajectoryStore`, registering a two-step `full-pipeline` and a
one-step `translate`. All eight requirements run. R6 compares a `runGoal` trajectory against
the `advanceGoal` sequence for the same input: two gated steps each, identical signatures.

Writing the arm found a defect in the kit itself, fixed in the same commit: `getTrajectory`
was typed `Promise<TrajectoryRecord | null>` and asserted with `not.toBeNull()`, but
`TrajectoryStore.getById` returns `undefined` for a miss — so R5 would have passed against a
trajectory that never persisted, which is the exact condition it exists to detect. GOTCHA-78's
rule two (read the returned interface, not the prose describing it) applied one commit after
that gotcha was cited in the same file.

---

### TASK-085 — Declared step cost and provider-reported cost are not reconciled

| Field        | Detail                                             |
| ------------ | -------------------------------------------------- |
| **ID**       | TASK-085                                           |
| **Type**     | Cost accounting                                    |
| **Severity** | Medium — budget decisions are made on the estimate |
| **Phase**    | Phase 5, Sprint 3b                                 |
| **Target**   | Phase 5, Sprint 4                                  |
| **Status**   | Open                                               |
| **Logged**   | 2026-08-15                                         |

**What:** `WorkflowStep.estimatedCostUSD` is a static declaration, and it is what the budget
ceiling is checked against and what the trajectory records. The providers already emit their
own `estimatedCostUsd` per call (`platform/voice/identify-types.ts`), and nothing compares the
two. A step declared at $0.002 that actually costs $0.02 passes a $0.005 ceiling and records
$0.002 in the trajectory.

**Why the estimate exists:** the pipeline checks the ceiling BEFORE the step runs
(`executeActionPipeline` step 2, before `perform()` at step 6), which is the correct order —
a refused call must not execute. So a pre-execution figure is structurally required; the gap
is that no post-execution figure ever replaces it.

**Consequence today:** ADR-030 requirement 4 — `cost.estimatedCostUSD` is the sum of the
steps' cost — passes trivially, because both sides come from the same declaration. The arm is
real only once the recorded cost is the provider's.

**Resolution:** have `invokeTool` accept a post-execution cost from the tool's output and
record that on the Step, with the declared figure kept for the pre-check. Then requirement 4
compares two independently produced numbers, and a declaration that drifts from reality
surfaces as a failing conformance arm rather than as a quiet underbill.

**Close when:** a step whose tool reports a cost different from its declaration records the
reported figure in the trajectory, and the conformance arm still passes.

---

### TASK-086 — Capabilities reports configured providers, not the full D8 list

| Field        | Detail                                           |
| ------------ | ------------------------------------------------ |
| **ID**       | TASK-086                                         |
| **Type**     | Discovery completeness                           |
| **Severity** | Low — the endpoint is honest about what it omits |
| **Phase**    | Phase 5, Sprint 3b                               |
| **Target**   | Phase 5, Sprint 4                                |
| **Status**   | Open                                             |
| **Logged**   | 2026-08-15                                       |

**What:** ADR-030 D8 lists capabilities as reporting goals, params, cost AND latency
ranges, languages, limits, and resolved provider names. The shipped endpoint reports the
first set (goals, steps, per-goal estimated cost, provider selection names) and names the
rest in a `notReported` array rather than inventing empty fields for them:
`latencyMsRange`, `languages`, `limits`, `providerLiveness`.

**Why reported this way and not filled with nulls:** a field present but always empty is
the `nextActions: ["$0"]` shape — it looks complete and lies. `notReported` lets a
discovering agent distinguish absent-by-design from absent-by-omission.

**The three deferrals, each a real decision the next planner must keep:**

1. **latencyMsRange / languages / limits** — not on `WorkflowDefinition` today. Adding
   them is additive; they populate where known (languages from the translation/TTS
   provider capability lists) and stay omitted where not.

2. **providerLiveness — deferred deliberately, not overlooked.** D8's prose says
   capabilities feeds off "the registry and health probes." The endpoint reports the
   configured provider per slot but runs NO health probe. `health.check()` runs live
   network probes at 5s timeout each; behind an unauthenticated discovery GET that is a
   DoS lever, and it couples discovery to dependency liveness. An agent learns
   reachability at call time through the trajectory and nextActions (P11), where the
   answer is current rather than stale-at-discovery. If liveness is wanted here later, it
   goes through a CACHED probe result with an explicit max-age, never a live check on the
   request path. This option is recorded so it stays available; it was weighed and
   deferred, not missed (GOTCHA-70).

**Close when:** capabilities reports latency, languages and limits for goals that have
them, `notReported` shrinks accordingly, and any liveness added is served from a cached
probe result, not a live check.

---

### TASK-087 — Admin-governed approval policy, capability definition, AND agent identity rung 2 (Sprint 3c)

| Field        | Detail                                                  |
| ------------ | ------------------------------------------------------- |
| **ID**       | TASK-087                                                |
| **Type**     | Feature / sprint                                        |
| **Severity** | Medium — the seam exists; governance of it does not yet |
| **Phase**    | Phase 5, Sprint 3c                                      |
| **Target**   | Phase 5, Sprint 3c                                      |
| **Status**   | Open                                                    |
| **Logged**   | 2026-08-15                                              |

**What:** Sprint 3b shipped the approval-policy SEAM — approvalPolicy() in gating.ts returns
a human approver by default, and HeldAction.approver is a typed identity so an agent approver
is expressible without an envelope change. What does not yet exist is the governance: a
durable policy store, a privileged mutation to change it, and an admin surface to drive that
mutation.

**Why a sprint, not a task line:** it is two-repo (PF-B abstraction + PF admin surface;
Playform-A extension) with its own security and accessibility gates. Folding it into a task
would repeat the L22 failure — a task outliving its sprint. Filed as Sprint 3c in
PHASE5_PLAN with the full breakdown and GenAI anchors (P10/P17/P4/P13/P3/P18). The Sprint 3b demo UI + A1-A8, deferred here, is 3c's acceptance gate (see PHASE5_PLAN Sprint 3c).

**Close when:** Sprint 3c completes — policy store + kit + privileged audited mutation + PF
admin route/panel behind admin_manage_approval_policy, and the agent-approver path proven
reachable and governed end to end.

---

### TASK-088 — Three Phase-5 modules are outside coverage measurement

| Field        | Detail                                                     |
| ------------ | ---------------------------------------------------------- |
| **ID**       | TASK-088                                                   |
| **Type**     | Coverage integrity                                         |
| **Severity** | Medium — the reported floor does not cover the newest code |
| **Phase**    | Phase 5                                                    |
| **Target**   | Phase 5, Sprint 4 (with TASK-080)                          |
| **Status**   | Open                                                       |
| **Logged**   | 2026-08-15                                                 |

**What:** `collectCoverageFrom` lists lib, app/api, components, and four platform modules
(auth, agents, input, moderation). It does NOT list platform/kernel, platform/app-framework
or platform/action-pipeline — the three modules Phase 5 Sprints 1-2 built. Everything in
them (session coordinator, action pipeline, state stores, the kernel types and the risk
floor) is unmeasured, and the ~89% floor reported per sprint is computed without them.

**Why it matters now:** the gating contract (32a0598) put safety-critical logic — the
approved-commit path that must never bypass the gate — partly in platform/action-pipeline,
which is unmeasured. Its guard is tested (kit R10, and the reconcile paths in
gating.test.ts), but the coverage NUMBER does not reflect that module, so the tool cannot
catch a future untested branch there.

**Why it is a task, not a one-line fix:** adding the three trees to collectCoverageFrom
surfaces their real coverage, which may fall below the global floor and turn the gate red
across three mature modules at once. That is a ratchet effort — measure, then raise the
floor to the measured level, then hold it — which is exactly TASK-080's scope. Doing it
inside an unrelated commit would be the coverage-on-red hazard the sprint already documented.

**Close when:** the three modules are in collectCoverageFrom, the global floor is re-derived
to include them, and CI is green at the new floor (coordinated with TASK-080).

---

### TASK-089 — PF CI never boots the production build, so the D3 store guard only fails downstream

| Field        | Detail                                                                                                                                               |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ID**       | TASK-089                                                                                                                                             |
| **Type**     | CI integrity                                                                                                                                         |
| **Severity** | Medium — a class of production-boot regression is invisible to PF's own gate                                                                         |
| **Phase**    | Phase 5                                                                                                                                              |
| **Target**   | Phase 5, Sprint 7                                                                                                                                    |
| **Status**   | Open — option (b) simulated-boot test landed (Sprint 7 m1: `__tests__/production-boot-guard.test.ts`); option (a) full CI E2E layer remains the goal |
| **Logged**   | 2026-09-25                                                                                                                                           |

**What:** PF's `ci.yml` (Layers 0d/0a/0b/0c/0e/1/1b/2) runs typecheck, lint, format, unit tests +
coverage, the ratchet, the override audit, and build — but never starts the production build
under an E2E harness. PF has an `e2e/` directory and a `test:e2e` script; no CI layer invokes it.
Only Playform runs Playwright (its Layer 3).

**Why it matters now:** the ADR-048 D3 store guard (v2.5.0 M2) throws in `instrumentation.register()`
when a production build boots on in-memory agent stores. The guard _decision_ is unit-tested, but
the **boot cascade** — `register()` swallows the throw, so observability and agents never
initialize, health returns 503, and Guardian fails closed on every request — only appears
end-to-end. PF released v2.5.0 green because PF's gate never boots the production build; the
interaction surfaced only when Playform's Layer 3 went red on the sync, forcing the v2.5.1 patch
(`E2E_IN_MEMORY_STORES`). Any future production-boot regression in shared platform code is invisible
to PF and caught one repo downstream, after a sync.

**Why it is a task, not a one-line fix:** two defensible fixes, to be chosen in Sprint 7. (a) Add an
E2E layer to PF's CI that starts the production build (`next start`) and runs a minimal platform
boot/health smoke — highest fidelity, but PF has no app-specific E2E specs, so it needs a small
platform-level smoke suite. (b) Add an integration test driving `instrumentation.register()` through
a simulated production boot that asserts the fail-closed behavior _and_ that the `E2E_IN_MEMORY_STORES`
opt-out lets boot complete (agents register, health OK) — cheaper, no server, but not a true
end-to-end boot. Recommend (b) as the floor (guaranteed catch) and (a) as the eventual goal.

### TASK-090 — Playform inherits the guard scripts but never runs them (sync excludes package.json + .github)

| Field        | Detail                                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| **ID**       | TASK-090                                                                                                                             |
| **Type**     | Cross-repo CI integrity                                                                                                              |
| **Severity** | Medium — a guard that is present but never invoked gives false assurance                                                             |
| **Phase**    | Phase 5                                                                                                                              |
| **Target**   | Phase 5, Sprint 7                                                                                                                    |
| **Status**   | Resolved — Sprint 7 m2: Playform package.json + ci.yml wired (Layers 0e/1b), coverage-baseline.json sync-excluded; Playform CI green |
| **Logged**   | 2026-09-25                                                                                                                           |

**What:** the coverage + dependency guards ship as two parts — the script files
(`coverage-baseline.json`, `scripts/coverage-ratchet.mjs`, `scripts/override-audit.mjs`,
`scripts/override-reaudit.mjs`) and their wiring (npm scripts in `package.json`; CI steps in
`.github/workflows/ci.yml` and `dependency-audit.yml`). The sync brings the script files
(`scripts/` and repo-root sync), but `package.json` and `.github/**` are sync-excluded, so Playform
inherits the scripts as **dormant files**: nothing in Playform's `package.json` or `ci.yml` invokes
them. The coverage ratchet and the override audit do not run in Playform.

**Why it matters now:** TASK-058's intent is a both-repo posture. Playform has the files but not the
enforcement — worse than not having them, because it reads as covered when it is not. The same
exclusion is why M5's promotion-guard needed a separate Playform commit.

**Why it is a task, not a one-line fix:** the wiring must be authored in Playform's OWN
`package.json` (add the `coverage:ratchet` + `overrides:audit` scripts) and Playform's OWN
`ci.yml` / `dependency-audit.yml` (add the ratchet, override-audit, and sweep steps), because those
files are consumer-owned and diverge from PF by design. Playform's ratchet also needs its own
coverage numbers for its baseline. Pairs with TASK-058.

### TASK-091 — The migration chain cannot rebuild a database from scratch, and no CI runs migration SQL

| Field        | Detail                                                                    |
| ------------ | ------------------------------------------------------------------------- |
| **ID**       | TASK-091                                                                  |
| **Type**     | Schema integrity                                                          |
| **Severity** | High — blocks a fresh production database; a broken migration ships green |
| **Phase**    | Phase 5                                                                   |
| **Target**   | Phase 5, Sprint 7A (C4)                                                   |
| **Status**   | Resolved (7A C4, 2026-09-29)                                              |
| **Logged**   | 2026-09-26                                                                |

**What:** replaying `supabase/migrations/001`–`036` in order on an empty Postgres fails at the start:
`001` creates `player_role` without `registered`, `002` seeds `registered`, `004` drops the enum, `008`
renames the enum `004` dropped. The early files were edited after being applied; the live database
was built as they changed, so it is correct, but the files no longer compose. Separately, nothing in
CI executes migration SQL: `036_governed_agent_budget.sql` shipped in v2.5.0 with a jsonb/text cast
bug (`SET value = (...)::text` on a jsonb column) that failed only when first applied to the live
database (Sprint 7, fixed in v2.6.2).

**Why it is a task:** the fix is a schema **baseline** — a dump of the live, known-good schema used as
the starting point for any fresh database, with newer migrations replayed on top — plus a CI layer
that stands up Postgres 16 (+ pgvector and a small Supabase `auth`/roles shim), applies the baseline
and every newer migration, and fails on any error. Rewriting applied historical migrations is
rejected: it changes what the live database claims to have run. Prerequisite for TASK-092.

**Resolved:** `supabase/baseline/000_baseline.sql` (covers 001–037) is cut from the dev schema and
seed, after an ownership audit that excluded Playform's `agent_delegation_*` tables, Supabase's
`rls_auto_enable()` and default privileges, and a hand-made `tester` role; it includes
`user_devices` and the `vector` extension, which no numbered migration creates. Proved on a fresh
Supabase-shaped Postgres: it applies, refuses a second run, and differs from dev only by the
exclusions. CI job **Migration replay** (`scripts/migration-replay.sh`, Postgres 17 + pgvector)
builds shim → baseline → newer migrations on every push and fails on a SQL error, a missing table or
function, or a table without row-level security; `__tests__/schema-baseline.test.ts` guards the
baseline's contract. See `supabase/baseline/README.md`.

### TASK-092 — Production shares the dev/staging Supabase project

| Field        | Detail                                                       |
| ------------ | ------------------------------------------------------------ |
| **ID**       | TASK-092                                                     |
| **Type**     | Environment isolation                                        |
| **Severity** | Medium — harmless pre-launch; must not carry into real users |
| **Phase**    | Phase 5                                                      |
| **Target**   | Phase 5, Sprint 7A (C4)                                      |
| **Status**   | Resolved (7A C4, 2026-10-07)                                 |
| **Logged**   | 2026-09-26                                                   |

**What:** ADR-048 D3 / ADR-049 D1 require durable stores in production, so `playform-dev` and
`playform-staging` on Vercel now point at the single `playform` Supabase project (both boot, health
200). Dev and staging sharing one database is acceptable pre-launch — all test data — but the
production deployment must get its own Supabase project so real user data never mixes with test data
and a staging migration cannot touch production.

**Why it is a task:** a new project needs its schema built from the TASK-091 baseline, its own
service-role key, and the five Vercel variables (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`TRAJECTORY_STORE`, `BUDGET_STORE`, `APP_STATE_STORE`) on the production project.

**Progress (2026-09-29):** Supabase project `playform-prod` created (Pro organization, Micro,
`us-east-1`, Data API on, new tables exposed as on dev, automatic RLS off). Its schema is built from
the TASK-091 baseline.

**Resolved (2026-10-07):** `playform-prod` built from the baseline (39 migrations recorded, 36 tables, all
with row-level security); Vercel `playform` production settings point at it (Production scope only), with its
own Cognito pool, Google client, guest secret and durable stores; `/api/health` 200 at
`https://playform.datankare.com`; first real sign-up and sign-in verified (which found TASK-117).

### TASK-093 — Language lists are not in alphabetical order

| Field        | Detail            |
| ------------ | ----------------- |
| **ID**       | TASK-093          |
| **Type**     | Enhancement       |
| **Severity** | Low — usability   |
| **Phase**    | Phase 5           |
| **Target**   | Phase 5, Sprint 7 |
| **Status**   | Open              |
| **Logged**   | 2026-09-26        |

**What:** The _Add languages_ picker and the translation card's _Also:_ row list languages in a fixed, non-alphabetical order.

**Resolution:** Sort both lists A→Z by display name through one shared helper so they cannot drift; a test pins the order.

### TASK-094 — Each language click re-translates — no batch multi-language selection

| Field        | Detail                    |
| ------------ | ------------------------- |
| **ID**       | TASK-094                  |
| **Type**     | Enhancement               |
| **Severity** | Medium — cost and latency |
| **Phase**    | Phase 5                   |
| **Target**   | Phase 5, Sprint 7         |
| **Status**   | Open                      |
| **Logged**   | 2026-09-26                |

**What:** Toggling a language chip after a translation immediately dispatches a new translate turn: one paid request (and 2–5 s) per click.

**Resolution:** Chips should only toggle selection; one Translate covers every selected language. Acceptance: N languages selected produce exactly one dispatch and the card shows all of them.

### TASK-095 — Translate turns take 2–5 s

| Field        | Detail                   |
| ------------ | ------------------------ |
| **ID**       | TASK-095                 |
| **Type**     | Performance              |
| **Severity** | Medium — perceived speed |
| **Phase**    | Phase 5                  |
| **Target**   | Phase 5, Sprint 7        |
| **Status**   | Open                     |
| **Logged**   | 2026-09-26               |

**What:** Measured on `playform-dev` (Vercel `iad1`, 2026-09-26): translate turn median 2.6 s server-side (1.7–5.4 s); every other session action median 0.26 s; text-to-speech 0.22 s. The session/governance path costs ≈ 0.25 s; the rest is the safety check (an LLM call) completing before detection, classification (a second LLM call) and translation start.

**Resolution:** Run safety and classification as one call, or concurrently, and re-measure. Target set from the new measurement.

### TASK-096 — PDF upload fails in deployment — `@napi-rs/canvas` is a devDependency

| Field        | Detail                               |
| ------------ | ------------------------------------ |
| **ID**       | TASK-096                             |
| **Type**     | Bug                                  |
| **Severity** | Medium — a visible feature is broken |
| **Phase**    | Phase 5                              |
| **Target**   | Phase 5, Sprint 7                    |
| **Status**   | Open                                 |
| **Logged**   | 2026-09-26                           |

**What:** `/api/extract` fails with `DOMMatrix is not defined`: the PDF parser needs `@napi-rs/canvas` at runtime, but Playform lists it under devDependencies, so the deployment never installs it.

**Resolution:** Move it to dependencies and declare it a server external package in `next.config.ts`; verify a PDF extract on the deployed address (Playform-owned files).

### TASK-097 — Production accepts the mock auth provider

| Field        | Detail                                |
| ------------ | ------------------------------------- |
| **ID**       | TASK-097                              |
| **Type**     | Deployment integrity                  |
| **Severity** | High — no real token can pass; silent |
| **Phase**    | Phase 5                               |
| **Target**   | Phase 5, Sprint 7A                    |
| **Status**   | Resolved — Sprint 7A A1               |
| **Logged**   | 2026-09-26                            |

**What:** With `AUTH_PROVIDER` unset the server registers the mock provider, which accepts one hard-coded test token. `playform-dev` ran this way until 7A; every signed-in call failed with "Invalid or expired token".

**Resolution:** ADR-050 D1: refuse test-double auth in a production context, as ADR-048 D3 does for in-memory stores, with a named error at boot.

**Resolved (7A A1):** `assertEnvironmentContract()` runs first in `initProviders()`; production refuses `AUTH_PROVIDER` unset/`mock`. E2E harnesses opt in with `E2E_TEST_DOUBLE_AUTH=true`, which — like every harness switch — is refused when `VERCEL=1`. Covered by `platform/providers/__tests__/environment-contract.test.ts`, `__tests__/provider-registry.test.ts` and the TASK-089 boot check. Consumers add `E2E_TEST_DOUBLE_AUTH` to their own E2E harness before syncing this release.

### TASK-098 — Guest tokens are unsigned

| Field        | Detail                    |
| ------------ | ------------------------- |
| **ID**       | TASK-098                  |
| **Type**     | Security                  |
| **Severity** | High — forgeable identity |
| **Phase**    | Phase 5                   |
| **Target**   | Phase 5, Sprint 7A        |
| **Status**   | Resolved — Sprint 7A A2   |
| **Logged**   | 2026-09-26                |

**What:** `createGuestToken` returns `guest.` + base64 JSON (`sub`, `type`, `iat`, `exp`) with no signature, and `verifyGuestToken` only decodes it and checks expiry. Anyone can mint a guest token for any id and any expiry. Nothing relies on it yet.

**Resolution:** ADR-050 D4: HMAC-sign guest tokens under `GUEST_TOKEN_SECRET` and verify the signature; must land before any route accepts guests.

**Resolved (7A A2, PF):** `platform/auth/guest-token.ts` — signed, namespaced, lifetime-bounded guest tokens; PF's Cognito provider delegates to it; `GUEST_TOKEN_SECRET` is in the environment contract (required with a real auth provider). Two obligations carried inside 7A: (1) A3's guest check verifies through `platform/auth/guest-token` directly, never through a provider's `verifyGuestToken`; (2) Playform's own `platform/auth/cognito-services.ts` (sync-excluded; mints `guest_<uuid>_<ms>`, unsigned) delegates to the same module in the Playform commit that follows the v3.0.0 sync — before Playform promotes. `GUEST_TOKEN_SECRET` must be set on `playform-dev` and `playform-staging` before v3.0.0 reaches them.

### TASK-099 — No guest path in the platform auth check, and no guest allowance

| Field        | Detail                                                         |
| ------------ | -------------------------------------------------------------- |
| **ID**       | TASK-099                                                       |
| **Type**     | Auth                                                           |
| **Severity** | Medium — guest mode admits users who then cannot act           |
| **Phase**    | Phase 5                                                        |
| **Target**   | Phase 5, Sprint 7A                                             |
| **Status**   | Resolved — Sprint 7A A3 + B1 (PF); Playform at the v3.0.0 sync |
| **Logged**   | 2026-09-26                                                     |

**What:** `requireAuth` verifies only real-user tokens, so a guest can enter the app but every action is rejected. There is also no bound on what a guest may consume.

**Resolution:** ADR-050 D4: an opt-in guest check for routes that allow guests (translate), namespaced guest actor ids, and a governed per-guest translate allowance (admin-settable, min 1 / default 5 / max 10) enforced before any paid call, with a clear sign-in prompt at the limit.

**Progress (7A A3, PF):** opt-in guest check and namespace done — `requireActor` / `requireActorWithStatus` (`allowGuests` per route; guests verified by `platform/auth/guest-token` only; `sign_in_required` elsewhere; `requireAuth` refuses guest-namespaced subjects). Remaining in 7A: B1 allowance; Playform's `lib/route-guard.ts` adopts `requireActorWithStatus`, and the translate routes opt in together with B1 — never before.

**Resolved (7A B1, PF):** governed `guest.translate_allowance` (migration 037: 1–10, default 5, safety tier, dual control; clamped in code too); `GuestUsageStore` registry slot (`GUEST_USAGE_STORE`, durable required in production, conformance kit); atomic database consume (`guest_allowance_consume`); `enforceGuestAllowance()` before the first paid call, failing closed; `guest.allowance_exhausted` (403, `{limit}`) — the sign-in prompt. PF `/api/process` (was unauthenticated) now authenticates, serves guests and counts them. **Before v3.0.0 reaches Playform:** migration 037 applied to the `playform` database; `GUEST_USAGE_STORE=supabase` on `playform-dev` and `playform-staging`. **Playform commit at the sync:** `lib/route-guard.ts` on `requireActorWithStatus`; its translate routes (`/api/process`, `/api/translate/dispatch`, `/api/translate/session`) opt guests in with `enforceGuestAllowance`; speech, transcription and extraction stay users-only.

### TASK-100 — E2E journey tests pass when the user sees an error

| Field        | Detail                                 |
| ------------ | -------------------------------------- |
| **ID**       | TASK-100                               |
| **Type**     | Test integrity                         |
| **Severity** | Medium — green CI while users fail     |
| **Phase**    | Phase 5                                |
| **Target**   | Phase 5, Sprint 7A                     |
| **Status**   | Resolved (Playform v0.6.0, 2026-10-20) |
| **Logged**   | 2026-09-26                             |

**What:** The translate journeys wait for the translation card **or any alert**, so they passed while every real user got "Invalid or expired token".

**Resolution:** Assert a real translation result; add explicit error-path and guest-limit journeys (Playform-owned `e2e/`).

**Progress (7A B2a, Playform `ac291cd`, `78efda2`):** journeys assert a real translation (`e2e/helpers/journey.ts` `expectTranslation`: text visible and non-empty, Play button, no app alert); an error-path journey (a coded dispatch failure must show the server message and no result); `__tests__/e2e-journey-integrity.test.ts` fails CI on "result or any alert" or a raw `[role=alert]` locator. Found on the way: a "no error notification" check that looked for a test id no element has (could never fail), and Next.js's route announcer — an always-present, empty `role="alert"` — which any "no alert" check must exclude (`appAlerts()`). **B2b (at the sync):** the guest-limit journey, with the Playform guest wiring.

**Closed (2026-10-20):** B2b shipped in Playform v0.6.0 — four guest journeys, including the allowance refused at the limit + 1, run in Playform's CI; the production smoke test translates as a guest.

### TASK-101 — SSO buttons are never wired to the identity provider

| Field        | Detail             |
| ------------ | ------------------ |
| **ID**       | TASK-101           |
| **Type**     | Auth               |
| **Severity** | Medium — dead UI   |
| **Phase**    | Phase 5            |
| **Target**   | Phase 5, Sprint 7A |
| **Status**   | Resolved (PF)      |
| **Logged**   | 2026-09-26         |

**What:** Playform's browser auth provider returns "SSO not available" for every provider. Cognito's hosted sign-in (domain, callbacks, Google identity provider) is configured as of 7A step 0.4.

**Resolution:** Start SSO through Cognito's hosted sign-in, add `/auth/callback` to exchange the code, and show only configured providers (ADR-050 D3). Google in 7A. Apple and Microsoft moved to Phase 6 (TASK-112); until then their buttons are not offered (ADR-050 D3 — only configured providers show).

**Resolved (7A C2, PF):** SSO runs through the Cognito hosted sign-in with the authorization-code
flow, `state` and PKCE S256. `GET /api/auth/sso/[provider]` starts it (attempt in an httpOnly cookie
scoped to `/api/auth/sso`, ten minutes, single use); the provider returns the browser to
`/auth/callback`, which posts `{ code, state }` to `POST /api/auth/sso/callback` (state compared in
constant time, code exchanged with the verifier; the ID token is not returned). The hosted domain is
now a declared setting, `NEXT_PUBLIC_COGNITO_HOSTED_UI_DOMAIN` — it had been derived from the pool id,
which is not the domain Cognito assigns, so SSO could never reach Cognito. `SSO_PROVIDERS` lists the
providers a deployment offers; `GET /api/features` reports `sso_google` / `sso_apple` /
`sso_microsoft`, and the sign-in screen shows only those (none by default). `/api/features` and
`/auth/callback` are now public in the proxy — the sign-in screen is unauthenticated and could not read
the feature list. **Playform at the sync:** its browser auth provider and sign-in screen use the
platform flow (TASK-101 remainder); set `NEXT_PUBLIC_COGNITO_HOSTED_UI_DOMAIN` and `SSO_PROVIDERS=google`
on dev and staging.

### TASK-102 — No test runs against a deployed environment

| Field        | Detail                                 |
| ------------ | -------------------------------------- |
| **ID**       | TASK-102                               |
| **Type**     | CI integrity                           |
| **Severity** | High — configuration is untested       |
| **Phase**    | Phase 5                                |
| **Target**   | Phase 5, Sprint 7A                     |
| **Status**   | Resolved (Playform v0.6.0, 2026-10-20) |
| **Logged**   | 2026-09-26                             |

**What:** Unit, integration and E2E tests all run on CI-built code with test settings; nothing checked `playform-dev` itself, so a missing database, mock auth and the wrong deployed branch all went unnoticed.

**Resolution:** ADR-050 D5: after each dev/staging deploy, check health, report the deployed commit, and perform a real translate against the deployed address.

**Resolved in PF (7A C3, 2026-10-08):** `scripts/deploy-smoke.mjs` (synced to consumers) runs against a
deployed address: health 200 and the deployed commit (polls until the address serves the expected build),
`/api/features`, an anonymous request refused with a registered code, a signed guest token, and a real guest
translation. One line per step; exit 1 names the failing step. Tested end to end against a local server
standing in for a deployment (`__tests__/deploy-smoke.test.ts`: healthy, wrong commit, health 503, uncoded
401, mock guest token, empty translation, bad settings). Writing it found two proxy defects, fixed:
the proxy's 401 was free text (outside ADR-051 — the free-text scan did not cover root files; it now scans
`proxy.ts`), and **an API call with a bearer token but no session cookie was redirected to `/auth`** —
every non-browser client (agents, this smoke test, k6) got a 307 instead of the API's answer. **Playform at
the sync:** its own `proxy.ts` (sync-excluded) takes both fixes, and its `.github/workflows/deploy-smoke.yml`
runs the script on every successful Vercel deployment of `playform-dev`, `playform-staging` and `playform`
with the deployment's commit as `SMOKE_EXPECTED_COMMIT`.

**Closed (2026-10-20):** Playform's `deploy-smoke.yml` runs on every production deployment of dev, staging and production. On the v0.6.0 release it caught a malformed `SUPABASE_URL` in production before any user (production refused to boot; fixed in settings, redeployed, smoke passed) — learning 114.

### TASK-103 — Deployment settings are unvalidated and can shadow each other

| Field        | Detail                                                       |
| ------------ | ------------------------------------------------------------ |
| **ID**       | TASK-103                                                     |
| **Type**     | Deployment integrity                                         |
| **Severity** | Medium — misconfiguration surfaces as obscure runtime errors |
| **Phase**    | Phase 5                                                      |
| **Target**   | Phase 5, Sprint 7A                                           |
| **Status**   | Resolved — Sprint 7A A1                                      |
| **Logged**   | 2026-09-26                                                   |

**What:** Stores read `NEXT_PUBLIC_SUPABASE_URL ?? SUPABASE_URL`, so a stray public variable silently overrides the server one; setting shapes (URL with a path, trailing characters) are never checked, surfacing later as errors like PostgREST `PGRST125`.

**Resolution:** ADR-050 D2: declare each setting once with its shape, validate at boot, fail on disagreeing duplicates.

**Resolved (7A A1):** `ENVIRONMENT_CONTRACT` declares each setting with one canonical name, aliases and shape; all readers use its resolvers. `SUPABASE_URL` is canonical — which also connects `lib/supabase/server`, the account-status guard and the metrics sink, which read only `NEXT_PUBLIC_SUPABASE_URL` and so had no database on `playform-dev`. `AWS_REGION` is no longer read for Cognito. Documented in `docs/ENV_REFERENCE.md`; `__tests__/docs-integrity.test.ts` checks every declared name is documented.

### TASK-104 — Optional features are offered when not configured

| Field        | Detail                                                    |
| ------------ | --------------------------------------------------------- |
| **ID**       | TASK-104                                                  |
| **Type**     | UX / deployment integrity                                 |
| **Severity** | Medium — dead ends                                        |
| **Phase**    | Phase 5                                                   |
| **Target**   | Phase 5, Sprint 7A                                        |
| **Status**   | Resolved — Sprint 7A B3 (PF); Playform at the v3.0.0 sync |
| **Logged**   | 2026-09-26                                                |

**What:** Music identification (no provider keys, no audio service) and audio upload are offered on `playform-dev` and fail with "please try again", which can never succeed.

**Resolution:** ADR-050 D3: each optional feature declares its settings; the UI offers it only when they are present.

**Resolved (7A B3, PF):** `platform/features` declares `music_identification` (ACRCloud + a real audio converter), `audio_upload` (speech key + real converter), `speech_input` (speech key) and `teams` (preview); `GET /api/features` returns booleans only; `requireFeature()` answers `feature.not_configured` (501) — retrying cannot succeed. **Playform commit at the sync:** its identify/transcribe routes call `requireFeature`, and the screens hide what `/api/features` reports unavailable. SSO providers join the list in C2.

### TASK-105 — Vercel project-to-branch mapping is undocumented and was wrong

| Field        | Detail                                     |
| ------------ | ------------------------------------------ |
| **ID**       | TASK-105                                   |
| **Type**     | Deployment topology                        |
| **Severity** | Medium — the deployed address ran old code |
| **Phase**    | Phase 5                                    |
| **Target**   | Phase 5, Sprint 7A                         |
| **Status**   | Resolved (2026-10-20)                      |
| **Logged**   | 2026-09-26                                 |

**What:** `playform-dev` tracked `main`, so its address served v0.5.0 while new code went only to preview addresses. Fixed for `playform-dev` (now `develop`) during 7A; staging and production unverified.

**Resolution:** ADR-050 D6: document and verify `playform-dev` ← develop, `playform-staging` ← staging, production ← main; the smoke test reports the deployed commit.

**Topology (verified 2026-10-08, ADR-050 D6):**

| Vercel project     | Branch    | Address                          | Database (Supabase)                   | Cognito pool     |
| ------------------ | --------- | -------------------------------- | ------------------------------------- | ---------------- |
| `playform-dev`     | `develop` | the project's default address    | `playform` (shared with staging)      | dev/staging pool |
| `playform-staging` | `staging` | the project's default address    | `playform` (shared with dev)          | dev/staging pool |
| `playform`         | `main`    | `https://playform.datankare.com` | `playform-prod` (built from baseline) | production pool  |

The production project's default address redirects (308) to `playform.datankare.com`. Resource identifiers (pool ids, project refs) are kept out of the repository. `/api/health` now reports `commit`
(`VERCEL_GIT_COMMIT_SHA`, 12 characters) so the smoke test proves which build each address serves.

**Closed (2026-10-20):** the smoke test confirmed each address serves its branch's commit — dev and staging on `797496a`, production on `045ae8b` (Playform v0.6.0).

### TASK-106 — Refresh-token rotation is off

| Field        | Detail             |
| ------------ | ------------------ |
| **ID**       | TASK-106           |
| **Type**     | Security hardening |
| **Severity** | Low                |
| **Phase**    | Phase 5            |
| **Target**   | Phase 5, Sprint 7  |
| **Status**   | Open               |
| **Logged**   | 2026-09-26         |

**What:** Cognito's refresh-token rotation requires disabling `ALLOW_REFRESH_TOKEN_AUTH` and refreshing via `GetTokensFromRefreshToken`; the provider uses `REFRESH_TOKEN_AUTH`, so rotation stays off.

**Resolution:** Switch the provider's refresh call, then enable rotation on the app client.

### TASK-107 — Teams panel uses a hard-coded demo user and an in-memory social store

| Field        | Detail                                                         |
| ------------ | -------------------------------------------------------------- |
| **ID**       | TASK-107                                                       |
| **Type**     | Identity / durability                                          |
| **Severity** | Medium — all users share one membership                        |
| **Phase**    | Phase 5                                                        |
| **Target**   | Phase 5, Sprint 7A                                             |
| **Status**   | Resolved — Sprint 7A B3 (store); real Teams data with TASK-108 |
| **Logged**   | 2026-09-26                                                     |

**What:** The panel requests groups for the literal user `current-user`, not the signed-in user, and the social store is in memory on deployments, so joins are shared across users and lost on restart.

**Resolution:** Use the signed-in user's id; make the social store durable in production like ADR-048/049 stores.

**Resolved (7A B3):** the social store fails closed (missing credentials are an error, not a silent memory fallback) and is required durable in production (`SOCIAL_STORE=supabase`; tables from migration 015). Found: the Teams panel never reaches the store — `useGroupMembership` is client-side sample data (`DEMO_GROUPS`, `"current-user"` ignored). Decision (Raman, 2026-09-27): Teams stays visible, labelled **"Preview — sample data"** (Playform commit), until TASK-108 defines participation; signed-in-user wiring is part of TASK-108.

### TASK-108 — Teams has no participation surface and shows invented group data

| Field        | Detail            |
| ------------ | ----------------- |
| **ID**       | TASK-108          |
| **Type**     | Product           |
| **Severity** | Medium            |
| **Phase**    | Phase 5           |
| **Target**   | Phase 5, Sprint 7 |
| **Status**   | Open              |
| **Logged**   | 2026-09-26        |

**What:** Group names and member counts are derived from ids and scores (marked demo-only in code), and there is no posting, chat or activity view, so groups cannot be used.

**Resolution:** Product decision on what participation means, then real group data and a participation surface.

### TASK-109 — API errors have no codes and are not documented

| Field        | Detail                                                    |
| ------------ | --------------------------------------------------------- |
| **ID**       | TASK-109                                                  |
| **Type**     | API contract                                              |
| **Severity** | High — clients must match English text; untranslatable    |
| **Phase**    | Phase 5                                                   |
| **Target**   | Phase 5, Sprint 7A (A4, before B1)                        |
| **Status**   | Resolved — Sprint 7A A4 (PF); Playform at the v3.0.0 sync |
| **Logged**   | 2026-09-27                                                |

**What:** Every error response is `{ error: "<English sentence>" }` — about 150 distinct messages across PF and Playform routes, plus platform reason strings that reach users. Only `sign_in_required` and `guest_invalid` (7A A3) carry a code; nothing documents any of them. There is no message catalog and no i18n library.

**Resolution:** ADR-051 D1–D3, D5 (a)–(e): catalog infrastructure (`next-intl`, `messages/en.json`, ICU); an error registry (code → status, catalog key, caller guidance); every PF API error on `{ code, message, params }`; `docs/API_ERRORS.md` generated and drift-checked; CI checks that every route error is registered, catalogued and documented; the screen-literal ratchet baseline. Playform's own routes in the Playform commit following the v3.0.0 sync.

**Progress (7A A4a, PF):** `platform/errors` (registry of 39 codes, catalog `messages/en.json`, `apiError`, locale negotiation, ICU rendering), generated `docs/API_ERRORS.md`, CI checks, free-text ratchet at 102. Survey findings carried to A4b: auth failures returned with HTTP 200 (12), 500s echoing internal error text (11), statuses chosen by matching English (7). Playform (sync-excluded `package.json`) must add `intl-messageformat` and the jest ESM transform in the same PR that syncs v3.0.0, or the synced `platform/errors` fails to build there.

**Progress (7A A4b-1, PF):** request-validation, auth-guard (`requireAuth`, `requireActor`, `requirePermission`, admin self-elevation, actor account status), rate-limit, admin and `/api/process` errors on codes; every 500 in them is `internal.error` — the 11 responses that echoed internal error text now log it with a request id and return only the id (`internalError`); the content classifier's reason (which may quote matched terms) goes to the log. Free-text ratchet 102 → 58. Compatibility aliases `success: false` / `error` stay in the body until 7B.

**Progress (7A A4b-2, PF):** moderation and approvals. Services and stores return `errorCode` (+ `errorParams`) with their results (`ReviewResult`, `ConfigApprovalResult`); routes answer with `errorFromResult()`, so no status is chosen by matching English any more (`statusForError`, `appealErrorStatus` removed). Five codes added (`moderation.appeal_not_allowed`, `appeal_reason_too_short`, `appeal_window_expired`, `item_state_conflict`, `approvals.expired`) — 44 in all. A store's database text never reaches a response. Free-text ratchet 58 → 17 (the auth routes, A4b-3).

**Resolved (7A A4b-3, PF):** auth routes on `authResultResponse` — success and challenge steps (MFA, new password, email verification) stay 200; failures return their code and real status (401 wrong credentials, 409 account exists, 429 too many attempts…) instead of HTTP 200; the Cognito provider maps exception types to codes and no Cognito message reaches a client (11 raw-message returns removed); sign-up password failures return `auth.password_policy` with rule ids (`passwordRuleViolations`). Free-text errors: 0, now a hard CI rule. Screen-literal ratchet in place (PF baseline 297). 45 codes in `docs/API_ERRORS.md`.

**At the v3.0.0 sync (Playform commit, in 7A):** `package.json` gains `intl-messageformat` + the jest ESM transform; Playform's own routes (`app/api/auth/**`, translate/tts/transcribe/extract/classify) and `platform/auth/cognito-services.ts` move to codes; its own `screen-literal-baseline.json` (PF's is not synced).

### TASK-110 — Screen strings are English literals

| Field        | Detail                                |
| ------------ | ------------------------------------- |
| **ID**       | TASK-110                              |
| **Type**     | UX / i18n                             |
| **Severity** | Medium — screens cannot be translated |
| **Phase**    | Phase 5                               |
| **Target**   | Phase 5, Sprint 7B                    |
| **Status**   | Open                                  |
| **Logged**   | 2026-09-27                            |

**What:** About 430 user-visible strings (text, labels, placeholders, `aria-label`, `title`, `alt`) across about 50 components in PF and Playform are English literals.

**Resolution:** ADR-051 D4: every screen string through `t(key)`, until the literal ratchet (set in 7A A4) reaches zero; remaining platform reason strings into the catalog. Decided 2026-09-27: a dedicated sprint (7B) after Sprint 7 closes; the ratchet keeps new UI work compliant in the meantime.

### TASK-111 — Guest lifecycle thresholds never load (column mismatch)

| Field        | Detail                                             |
| ------------ | -------------------------------------------------- |
| **ID**       | TASK-111                                           |
| **Type**     | Defect                                             |
| **Severity** | Low — defaults apply silently; admin edits ignored |
| **Phase**    | Phase 5                                            |
| **Target**   | Phase 5, Sprint 7A (before close)                  |
| **Status**   | Resolved (PF, 7A 2026-10-07)                       |
| **Logged**   | 2026-09-27                                         |

**What:** Migration 002 seeds `guest_config` with `nudge_after_seconds`, `grace_period_seconds` and `lockout_after_seconds`, while `getGuestConfig()` reads `nudge_after_sessions`, `grace_after_sessions`, `lockout_after_sessions`, `guest_token_ttl_hours` and `max_guest_sessions`. Every read falls back to the defaults, and an admin's change to the guest lifecycle has no effect — with nothing saying so.

**Resolution:** reconcile against the live schema (TASK-091 baseline): one migration aligning columns with the code, or the code with the columns, plus a test that reads the seeded row; `getGuestConfig()` logs when it falls back.

**Resolved (decision A — retire, 2026-10-07):** worse than logged — the code also counted sessions in a
`users.guest_session_count` column that never existed, the admin route and AI tool wrote an `is_active`
column that never existed, and no route called the lifecycle. Guests are bounded by the governed translate
allowance (7A B1) and carry signed tokens never stored on `users` (ADR-050 D4). Removed:
`platform/auth/guest-lifecycle.ts` and its exports, `/api/admin/guest-config`, the admin AI tool
`update_guest_config` and its handler, the Guest Config admin panel, data view and confirm text, and their
tests. Migration **038** drops `guest_config`, `users.guest_token` / `guest_play_seconds` /
`guest_nudge_shown_at` / `guest_locked_out_at` (with their constraint and index) and the dead config keys
`guest_session_limit` / `guest_nudge_after`; idempotent, proven on the baseline twice. **Apply 038 to the
`playform` and `playform-prod` databases.** **Playform at the sync:** the sync does not delete files
(TASK-083) — delete `platform/auth/guest-lifecycle.ts` and `app/api/admin/guest-config/route.ts` in
Playform by hand. Screen-literal baseline 297 → 287.

### TASK-112 — Apple and Microsoft sign-in

| Field        | Detail                                  |
| ------------ | --------------------------------------- |
| **ID**       | TASK-112                                |
| **Type**     | Auth / feature                          |
| **Severity** | Low — Google and email sign-in cover 7A |
| **Phase**    | Phase 6                                 |
| **Target**   | Phase 6                                 |
| **Status**   | Deferred (decided 2026-09-28)           |
| **Logged**   | 2026-09-28                              |

**What:** Apple and Microsoft identity providers in the Cognito hosted sign-in (originally 7A steps 0.5 and 0.6). Moved out of 7A by decision (Raman, 2026-09-28).

**Resolution (Phase 6):** Apple: App ID, Services ID, key `.p8`, Team ID, return URL on the Cognito domain (steps drafted). Microsoft: an Entra / Azure account (not yet created — Raman's decision), app registration, client secret. Each added as a Cognito identity provider; its button appears only once configured (ADR-050 D3, `platform/features`). Supersedes the Apple and Microsoft parts of TASK-024.

### TASK-113 — `SupabaseMetricsSink` writes a table no migration creates

| Field        | Detail                                                    |
| ------------ | --------------------------------------------------------- |
| **ID**       | TASK-113                                                  |
| **Type**     | Schema integrity                                          |
| **Severity** | Low — the sink is opt-in; selecting it fails on first use |
| **Phase**    | Phase 5                                                   |
| **Target**   | Phase 5, Sprint 7R                                        |
| **Status**   | Fixed in v6.0.0 (Sprint 7R R2)                            |
| **Logged**   | 2026-09-29                                                |

**What:** `platform/observability/metrics-sink.ts` reads and writes `ai_metrics` through PostgREST,
but no migration creates `ai_metrics`, and neither the dev database nor the baseline has it. Found
during the TASK-091 audit (the schema-parity script checks store columns, not this sink's table).

**Resolution:** a migration that creates `ai_metrics` (with row-level security and its self-record),
or remove the Supabase sink if metrics stay in Sentry/Langfuse.

**Fixed (Sprint 7R R2):** migration `048_ai_metrics.sql` creates the table, server-only (row-level security on, no policy, no grants to `anon` or `authenticated`); the replay checks both. The schema-parity check now fails on any file that reaches a table through the REST API but whose columns it cannot read — the gap that hid this — and reads row builders (`batch.map(() => ({…}))`), `URLSearchParams` filters and quoted identifiers.

### TASK-114 — Every table grants ALL to `anon` and `authenticated`

| Field        | Detail                                                            |
| ------------ | ----------------------------------------------------------------- |
| **ID**       | TASK-114                                                          |
| **Type**     | Security hardening (defense in depth)                             |
| **Severity** | Medium — row-level security is the only barrier for the API roles |
| **Phase**    | Phase 5                                                           |
| **Target**   | Phase 5, Sprint 7T (moved from Phase 6 by ADR-053 D6)             |
| **Status**   | Resolved in v6.0.0 (Sprint 7R R3, migration 049)                  |
| **Logged**   | 2026-09-29                                                        |

**What:** Supabase's "automatically expose new tables" grants `ALL` on every `public` table to
`anon` and `authenticated` (the baseline carries dev's grants, and `playform-prod` keeps the option
on for parity). Every table has row-level security, so this is not an open door — but one missing
or wrong policy would be. The platform itself reaches the database only as `service_role`.

**Resolution:** revoke table privileges from `anon` and `authenticated` except where a browser
client needs them (none today), in a migration applied to dev and production alike, then turn the
option off on both projects. The replay job gains a check that no table grants `anon` anything.

**Resolved (Sprint 7R R3):** migration `049_tenancy.sql` drops every policy for `anon` and
`authenticated` and revokes their table, sequence and function privileges; nothing reads tables
with the public key (Realtime uses private broadcast channels). The replay checks that the public
key reaches no table. Remaining at deploy (docs/TENANCY_OPERATIONS.md): turn off "automatically
expose new tables" on both projects, so a table created later is not exposed before its migration
revokes it.

### TASK-115 — Legal review of Privacy Policy and Terms of Service

| Field        | Detail                            |
| ------------ | --------------------------------- |
| **ID**       | TASK-115                          |
| **Type**     | Legal / compliance                |
| **Severity** | High at launch — real users' data |
| **Phase**    | Phase 5                           |
| **Target**   | Phase 6 (launch gate)             |
| **Status**   | Open                              |
| **Logged**   | 2026-10-07                        |

**What:** Drafts published 2026-10-01 at `datankare.com/privacy` and `datankare.com/terms` (Datankare LLC,
13+ only, Massachusetts law) so Google sign-in could leave Testing. They were written from what the platform
does, but not reviewed by counsel.

**Resolution:** counsel reviews both against the launch feature set — COPPA (the 13+ gate must actually
hold), GDPR/UK GDPR and CCPA if those users are admitted, AI-vendor disclosure terms, liability limits.

### TASK-116 — Account and production hardening before launch

| Field        | Detail                |
| ------------ | --------------------- |
| **ID**       | TASK-116              |
| **Type**     | Security hardening    |
| **Severity** | High at launch        |
| **Phase**    | Phase 5               |
| **Target**   | Phase 6 (launch gate) |
| **Status**   | Open                  |
| **Logged**   | 2026-10-07            |

**What:** found during 7A C4 setup:

- AWS console used as **root** — create an IAM Identity Center admin, keep root for break-glass with MFA.
- Vercel team has no **required 2FA**.
- Older Vercel secrets (Anthropic, ACRCloud, audio converter) are not marked **Sensitive**.
- Production provider keys are shared with dev/staging — issue production-only keys.
- Cognito sends email with its built-in sender (~50/day) — move to SES with a `datankare.com` sender
  (SPF/DKIM/DMARC).
- `www.datankare.com` serves the site instead of redirecting to `datankare.com`.

**Resolution:** each item done and checked off here before public launch.

### TASK-117 — New accounts are refused as "permanently suspended" (no platform user row)

| Field        | Detail                                       |
| ------------ | -------------------------------------------- |
| **ID**       | TASK-117                                     |
| **Type**     | Defect — authorization                       |
| **Severity** | High — every new account on a fresh database |
| **Phase**    | Phase 5                                      |
| **Status**   | Resolved (PF; Playform at the 7A sync)       |
| **Logged**   | 2026-10-07                                   |

**What:** sign-up creates the identity in Cognito only; nothing created the platform's `users` row that the
account-status guard, COPPA gate, permissions and RLS read (`id = cognito_sub = sub`). The guard read with
`.single()`, which returns an **error** for zero rows, so its "no row → active" branch was dead and a new
user failed closed as `banned`. Hidden because unit tests mocked `{ data: null, error: null }` (which
`.single()` never returns) and dev's rows were made by hand. Found on `playform-prod` 2026-10-07:
`users rows: 0`; Raman's first sign-in was refused.

**Resolved:** `platform/auth/user-provisioning.ts` — `ensureUserProvisioned()` creates the row on first use
(default role `free`, `cognito_sub`, email from the token, `account_created` audit), idempotent and
race-safe (insert ignores an existing id), never changes an existing row. The guard reads with
`maybeSingle()`: a DB error still fails closed; no row → provision → re-read; provisioning failure → refused
with the new code `account.not_provisioned` (503), never reported as banned. `requireActorWithStatus` passes
the token's email and maps the code. Insert shape proven on the baseline schema (defaults: `active`, COPPA
off, consent not required). **Playform at the sync:** its own `lib/route-guard.ts` moves to
`requireActorWithStatus` (already listed for the 7A sync); verify on staging with a brand-new account (C3),
then production after promotion.

### TASK-118 — Dependabot version-update backlog

| Field        | Detail                     |
| ------------ | -------------------------- |
| **ID**       | TASK-118                   |
| **Type**     | Maintenance — dependencies |
| **Severity** | Low                        |
| **Phase**    | Phase 5                    |
| **Target**   | Sprint 7                   |
| **Status**   | Open                       |
| **Logged**   | 2026-10-09                 |

**What:** Dependabot version-update pull requests have accumulated. Those opened against `main`
(#335, #337, #423, #426) were closed at v3.0.1 — every change goes develop → staging → production,
so none merges into `main` directly. Those against `develop` are kept.

**Resolution:** take each `develop` update on its own branch through the full gate (typecheck,
lint, format, tests, migration replay, production audit), majors with their migration notes;
reconfigure Dependabot to target `develop` only. Done when no update PR is older than one sprint.

### TASK-119 — Consumer migrations were never replayed after the baseline (`playform-prod` lacks Playform's schema)

| Field        | Detail                                                             |
| ------------ | ------------------------------------------------------------------ |
| **ID**       | TASK-119                                                           |
| **Type**     | Defect — schema integrity                                          |
| **Severity** | High — production is missing a consumer's tables and configuration |
| **Phase**    | Phase 5                                                            |
| **Target**   | Phase 5, Sprint 7A                                                 |
| **Status**   | Resolved (2026-10-20)                                              |
| **Logged**   | 2026-10-09                                                         |

**What:** `scripts/migration-replay.sh` and `__tests__/schema-baseline.test.ts` treated every migration
numbered at or below `baseline-covers-through` (037) as inside the baseline. Playform's own migrations
share that range — `007_playform_subscription_tiers`, `031_known_features`, `032_capability_features`,
`033_trusted_agents`, `034_agent_delegation`, `035_trusted_agents_ttl`, `036_known_features_agent_delegate`
— and the baseline (correctly) does not contain them, so the replay skipped them and `playform-prod`, built
from the baseline in 7A C4, never received them. Found 2026-10-09 by querying `applied_migrations` on
`playform-prod`: all seven missing, `agent_delegation_grant` absent. Gotcha 109.

**Resolved (PF v3.1.0):** "covered" means recorded in the baseline's `applied_migrations` seed. The replay
applies every migration the baseline does not record, in filename order (a consumer's ≤037 migrations
first, then newer ones); the test checks the baseline records only files that exist and none past its
number, that platform-foundation itself has no unrecorded migration in its range, and that every unrecorded
migration enables row-level security on its tables. Verified: Playform's seven apply cleanly after the
baseline on Postgres 16 + pgvector, and the replay checks pass.

**Playform (v0.6.0):** the CI replay job runs on Playform; the seven migrations, then 038, are applied to
`playform-prod` in replay order from the files (SQL Editor), and `applied_migrations` is compared with the
files afterwards. Close when that comparison shows nothing missing.

**Closed (2026-10-20):** `playform-prod` holds 007 and 031–036 (compared with the files, nothing missing) and, after v0.6.0 went live, 038 — 47 recorded migrations.

### TASK-120 — ADR-051 consumer error codes were specified but not built; guest tokens depended on the auth provider

| Field        | Detail                                                       |
| ------------ | ------------------------------------------------------------ |
| **ID**       | TASK-120                                                     |
| **Type**     | Defect — platform contract                                   |
| **Severity** | High — a consumer could not comply with the synced hard rule |
| **Phase**    | Phase 5                                                      |
| **Target**   | Phase 5, Sprint 7A                                           |
| **Status**   | Resolved (PF v3.1.0)                                         |
| **Logged**   | 2026-10-09                                                   |

**What:** (1) ADR-051 D1 says an app adds its own error codes and messages in a consumer-owned file merged
at load. Nothing merged anything, so after the v3.0.1 sync the synced no-free-text rule failed on 52
Playform error sites, many needing codes only Playform has (file too large, recording too short, profile
not found …). (2) `/api/auth/guest` asked the auth provider for a guest token. Under the test double that is
a fixed string the platform never accepts, and in the browser the provider would sign with a secret it
does not have — so no E2E harness could exercise a guest (TASK-100 B2b). (3) The deployed smoke test read
translations only from `text`. Gotchas 110–111.

**Resolved (PF v3.1.0):** `platform/errors/app-codes.ts` (`APP_ERROR_CODES`, `app.<area>.<name>`),
`messages/app/en.json` (under `errors.app` / `screens.app` only) and `docs/APP_API_ERRORS.md` (generated) —
consumer-owned, shipped empty; the registry and catalog merge them at load and refuse a key outside the app
namespaces or one the platform defines. `/api/auth/guest` mints the platform-signed token itself, and the
sign-in screen calls it. `SMOKE_TRANSLATION_FIELD` names the field a consumer's translate route uses.

### TASK-121 — The Playform sync failed for 12 days and nothing said so

| Field        | Detail                                           |
| ------------ | ------------------------------------------------ |
| **ID**       | TASK-121                                         |
| **Type**     | Defect — operations                              |
| **Severity** | Medium — platform changes silently not inherited |
| **Phase**    | Phase 5                                          |
| **Target**   | Phase 5, Sprint 7A                               |
| **Status**   | Resolved (Playform v0.6.0, 2026-10-20)           |
| **Logged**   | 2026-10-09                                       |

**What:** `sync-from-foundation` failed on every run from 2026-09-28 (`could not read Username`, exit 128):
the stored `FOUNDATION_SYNC_TOKEN` was not the token's current value. Its failure alert never fired — the
step runs `gh issue` with no checkout and no repository named, so it failed too (`not a git repository`).
A fresh value, tested against both repositories before storing, fixed the sync on 2026-10-09.

**Resolution (Playform v0.6.0):** the alert step names its repository (`GH_REPO`) and is exercised once; the
platform-foundation checkout uses its own read-only token (`FOUNDATION_READ_TOKEN`, platform-foundation
only, Contents read) so the token that writes to Playform no longer reaches platform-foundation; both tokens'
expiry dates are recorded in `ROTATION_RUNBOOK.md` with a reminder before each.

**Closed (2026-10-20), as built:** platform-foundation is public, so the sync reads it with the workflow's own `github.token`; no second token was needed. `FOUNDATION_SYNC_TOKEN` is used only to open the sync pull request in Playform and is scoped to Playform alone (Contents and Pull requests). The alert was exercised: a deliberate failure opened issue #573 (closed). The token was replaced on 2026-10-20 and its expiry is recorded in `ROTATION_RUNBOOK.md`.

### TASK-122 — The migration replay depended on an anonymous Docker Hub pull

| Field        | Detail                                      |
| ------------ | ------------------------------------------- |
| **ID**       | TASK-122                                    |
| **Type**     | CI reliability                              |
| **Severity** | Medium — a release blocked by a third party |
| **Phase**    | Phase 5                                     |
| **Target**   | Phase 5, Sprint 7A                          |
| **Status**   | Resolved (2026-10-20)                       |
| **Logged**   | 2026-10-09                                  |

**What:** the Migration replay job ran Postgres as a `pgvector/pgvector:pg17` service container. On the v3.1.0
develop → staging promotion, Docker Hub refused the pull (`toomanyrequests`, the anonymous rate limit) on the
run and on its re-run; the code had passed on develop.

**Resolved:** the job installs `postgresql-17` and `postgresql-17-pgvector` from apt.postgresql.org on the
runner, creates the `17/main` cluster when the image has not (GitHub's runner image turns off automatic cluster
creation — the first attempt failed on exactly that), and uses whichever port the cluster gets; nothing is
pulled from Docker Hub. Playform's replay job
(added at v0.6.0) takes the same form.

**Closed (2026-10-20):** Playform's replay job ran green on the v0.6.0 promotion.

### TASK-123 — Playform UX polish: visible defaults and listening feedback

| Field        | Detail                                        |
| ------------ | --------------------------------------------- |
| **ID**       | TASK-123                                      |
| **Type**     | Feature — user experience (Playform)          |
| **Severity** | Low — users are left guessing, nothing breaks |
| **Phase**    | Phase 5                                       |
| **Target**   | Phase 5, Sprint 8                             |
| **Status**   | Open                                          |
| **Logged**   | 2026-10-12                                    |

**What:** found in manual testing on dev (Raman, 2026-10-12). (1) The default translation languages
(Spanish, French) are not shown anywhere; show them next to **Add languages**. (2) Music/microphone input
gives no feedback: while listening, the input area is blank. Explain how the microphone works and show live
feedback while listening (a level meter or waveform and a "Listening…" status). More items may be added
before the sprint opens.

### TASK-124 — One API key per environment, each with its own spend limit

| Field        | Detail                                                     |
| ------------ | ---------------------------------------------------------- |
| **ID**       | TASK-124                                                   |
| **Type**     | Operations — credential hygiene                            |
| **Severity** | Medium — production cannot be revoked or capped on its own |
| **Phase**    | Phase 5                                                    |
| **Target**   | Phase 5, Sprint 7O                                         |
| **Status**   | Open                                                       |
| **Logged**   | 2026-10-20                                                 |

**What:** dev, staging and production (and CI) share one Anthropic key and one Google key, so a leak in any
environment exposes all of them, and production cannot be revoked or rate-capped separately. Found during the
2026-10 account hardening, which put organisation-level caps in place (Anthropic monthly limit with prepaid
credit only; Google keys restricted to the three APIs used, daily quotas, unused premium voice models
disabled, and a billing budget with alerts).

**Plan:** one Anthropic workspace per environment, each with its own key and spend limit; one Google key per
environment, each restricted to the same three APIs; a separate CI key; keys recorded by name (never value)
in `ROTATION_RUNBOOK.md`, with rotation dates. Each key is created as a **Sensitive** environment variable, scoped to its one environment (Vercel flags the current shared keys "Needs attention" because they are not).

### TASK-125 — Register Datankare as an LLC and assign the platform's copyright to it

| Field        | Detail                                                             |
| ------------ | ------------------------------------------------------------------ |
| **ID**       | TASK-125                                                           |
| **Type**     | Governance — legal                                                 |
| **Severity** | Medium — needed before the platform is showcased or monetised      |
| **Phase**    | Phase 5                                                            |
| **Target**   | Before the platform is publicly showcased; required before Phase 6 |
| **Status**   | Open                                                               |
| **Logged**   | 2026-10-20                                                         |

**What:** the copyright notice named "RKS"; it now names the owner, Raman K. Sud. Once Datankare is
registered as an LLC, a written IP assignment transfers the platform to it and the notice in `LICENSE` is
updated. The MIT terms are unchanged either way.

### TASK-126 — Tenancy model: one codebase, shared or dedicated deployment

| Field        | Detail                                                                                         |
| ------------ | ---------------------------------------------------------------------------------------------- |
| **ID**       | TASK-126                                                                                       |
| **Type**     | Architecture                                                                                   |
| **Severity** | High — the most expensive change to make late; blocks monetisation                             |
| **Phase**    | Phase 5                                                                                        |
| **Target**   | Phase 5, Sprint 7R (decision and groundwork), Sprint 7T (implementation)                       |
| **Status**   | Implemented in v6.0.0 (Sprint 7R R3; ADR-053 Accepted 2026-10-24); Playform adopts with v0.9.0 |
| **Logged**   | 2026-10-20                                                                                     |

**What:** the platform has no tenant concept. No table carries a tenant or organisation; row-level security
is written for users and admins; roles are global; config, rate limits, AI budgets, caches, audit and metrics
are global; there is no tenant lifecycle. Server code reaches the database with the service-role key, so
row-level security does not protect server paths. Raised by an independent engineering assessment
(2026-10-17).

**Decision (2026-10-17):** both models from one codebase. A dedicated per-client deployment is the shared
deployment running with exactly one tenant — one code path, two deployment shapes.

**Plan:** an ADR in Sprint 7R covering tenant identity (one Cognito pool with a tenant claim, or a pool per
tenant), tenant admin roles, row-level security under a database role that cannot bypass it, per-tenant
config, limits, budgets, cache keys, audit and metrics, the tenant lifecycle, and taking service-role access
off request paths. Sprint 7R plumbs a tenant context through requests and agents (one default tenant) and adds
a cross-tenant isolation conformance kit; Sprint 7T carries tenancy through every table, policy and cache.

**Sprint 7R entry gate (2026-10-21):** ADR-053 (Proposed). Server code reaches Postgres directly through one data
layer and a transaction-mode pooler, under a role that cannot bypass row-level security (D4; the REST-API
alternative is recorded in its §3).

**Sprint 7R R3 (2026-10-23), on develop:** tenancy through every table, store, route and cache. Migration
`049_tenancy.sql` (tenants and their addresses; `tenant_id` with forced row-level security on every
tenant-owned table; composite foreign keys; per-tenant keys; layered configuration; tenant lifecycle records;
the request role `app_tenant`); one data layer (`platform/data`) with tenant, platform and owner transactions;
every store on Postgres; every route in a tenant scope (`tenantRoute`); the tenant from the verified identity
(Cognito `custom:tenant_id`, set only by the platform) or, before sign-in, the address; per-tenant rate limits,
agent budgets with a tenant cap, cache keys, Realtime topics, audit and metrics; an operator console and API
(provision, addresses, suspend, two-operator deletion with a 30-day purge, restore, export, first
administrator, readiness). CI replays the migrations and runs every store's isolation kit against real
Postgres. Operating guide: [TENANCY_OPERATIONS.md](TENANCY_OPERATIONS.md); ADR-053 §6 records the amendments.
**Remaining:** Playform's adoption and the deployment steps (R7).

### TASK-127 — Split the foundation from product modules

| Field        | Detail                                                                                                                        |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| **ID**       | TASK-127                                                                                                                      |
| **Type**     | Architecture                                                                                                                  |
| **Severity** | Medium — every consumer inherits, patches and tests features it may not use                                                   |
| **Phase**    | Phase 5                                                                                                                       |
| **Target**   | Phase 5, Sprint 7R (decision), Sprint 7S (implementation)                                                                     |
| **Status**   | Boundary implemented in v6.0.0 (Sprint 7R R4; the app manifest R7, TASK-157; ADR-054 Accepted 2026-10-24); the move out is 7S |
| **Logged**   | 2026-10-20                                                                                                                    |

**What:** games, social groups and agents, song identification, audio conversion and the voice pipeline live
in the foundation, so every consumer inherits them. Raised by the 2026-10-17 assessment.

**Plan:** an ADR in Sprint 7R defining the core (identity and roles, errors and catalogs, config, agents and
AI governance, content safety, consent) and optional modules; sync becomes "core plus the modules a consumer
opts into"; a lint rule stops the core importing a module. Sprint 7S moves the modules out.

**Sprint 7R entry gate (2026-10-21):** ADR-054 (Proposed): six modules, self-registration, module migrations and a
sync that selects modules; 22 boundary imports to remove before the lint rule (R4).

**Sprint 7R R4 (2026-10-24), on develop:** the core/module boundary (ADR-054 §5). `platform/modules`:
`definePlatformModule` (validated, frozen), `registerModules` (once at boot, idempotent, duplicates and missing
or cyclic dependencies refused), and the app's list `app-modules.ts` (a consumer seam; instrumentation
registers it before the providers). Every core registry is the core's list plus the registered modules':
provider slots (the six module slots keep their settings and refusals, the durable social store included),
agents (the five social agents moved to the social module; Guardian's `guardian-social` stays core), prompts and
evals, the curator content type, features, workflow goals (`AgentGoal` open, validated at `registerWorkflow`),
rate rules (`SONG_IDENTIFY_RULE` moved to song-id), the consent and account-status fallbacks, moderation content
kinds, health probes (the song-ID probe), and the conformance manifest (per-module kit manifests). The voice
index is split (voice, `song-id`, `audio-convert` entries); the home page renders the `app-home.tsx` seam. The
production boundary imports went from 16 core → module (and the voice index's re-exports of song-id and
audio-convert) to none outside the two composition roots; the 6 test-manifest imports and every core test
importing a module are gone or listed as the module's tests. `import/no-restricted-paths` is on, its zones
generated from `platform/modules/manifest.json` (every module file listed, checked both ways); module migrations
are `NNN_<module>_<name>.sql` and replay after the core's. CI: the boundary, manifest, lint-fixture and
migration tests, and `npm run test:core` — every core test with no module registered.
**Remaining (7S):** moving the modules out of the core directories, superseding the core migrations that seed or
alter module data (002, 005, 007, 010, 012, 014, 037, 049), retiring `lib/translate.ts` and `lib/tts.ts`, the
guest-usage rename, the sync's `modules` selection, and Playform opting in.

### TASK-128 — Deploy anywhere: a container image, infrastructure as code, a second host

| Field        | Detail                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------- |
| **ID**       | TASK-128                                                                                           |
| **Type**     | Architecture — deployability                                                                       |
| **Severity** | High — portability off the current hosts is designed for but untested                              |
| **Phase**    | Phase 5                                                                                            |
| **Target**   | Phase 5, Sprint 7R (decision, container build), Sprint 7P (AWS environment)                        |
| **Status**   | Open — the container image in v6.0.0 (Sprint 7R R6; ADR-055 Accepted 2026-10-24); AWS is Sprint 7P |
| **Logged**   | 2026-10-20                                                                                         |

**What:** only Vercel has been deployed to; `infra/` holds placeholders; the environment contract detects a
hosted deployment through `VERCEL=1`; the cache provider speaks Upstash's REST protocol only.

**Decision (2026-10-17):** Vercel stays a first-class host, and AWS, GCP and Azure become supported targets.
AWS first (the account and identity pool already exist), built after Sprint 7T so it is provisioned once on
the final schema.

**Plan:** Sprint 7R — the container image as the portable unit, a host-agnostic environment contract, the
deploy smoke test passing against a container build. Sprint 7P — OpenTofu modules for AWS (network, ECS,
RDS Postgres with point-in-time recovery, Valkey, load balancer, DNS and certificates); CI deploys the same
commit to Vercel and AWS and the smoke test must pass on both; a Valkey provider over the standard Redis
protocol. GCP and Azure follow with the same image.

**Sprint 7R entry gate (2026-10-21):** ADR-055 (Proposed); host-neutral detection closes TASK-140 before any
other host exists (R2); the image and its CI smoke run are R6.

**Fixed on develop (Sprint 7R R6):** the 7R part (ADR-055 §5). `output: "standalone"`; a three-stage
`Dockerfile` on Node 24 (`ARG BASE_IMAGE`, pinned release, digest pinning documented), running as
`10001:10001` with a read-only root filesystem (writes `/tmp` and `/app/.next/cache` only),
`STOPSIGNAL SIGTERM`, a liveness `HEALTHCHECK`, `GIT_COMMIT_SHA` baked from a build argument and no
secret baked in; `.dockerignore`; the job worker from the same image. The contract declares
`GIT_COMMIT_SHA`, `NEXT_MANUAL_SIG_HANDLE` (required with `DEPLOYMENT_HOST=container`),
`SHUTDOWN_DRAIN_SECONDS` and `SHUTDOWN_TIMEOUT_SECONDS`. Graceful shutdown
(`platform/observability/shutdown.ts`): readiness 503 `draining` first, the drain, metrics and error
reporter flushed, the cache and the database pools closed, exit 0 — bounded, idempotent on a second
signal. CI job **Container image** builds it, runs it against the replayed database, passes the
deploy smoke test against it, runs the worker, checks the user and the stop. Guide:
`docs/DEPLOY_CONTAINER.md`. **Remaining (7P):** OpenTofu for AWS, runtime browser settings, the
Valkey provider, CI deploying to both hosts with the smoke test on both.

### TASK-129 — Operations baseline: recovery, alerting, objectives, background work

| Field        | Detail                                                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **ID**       | TASK-129                                                                                                                                 |
| **Type**     | Operations                                                                                                                               |
| **Severity** | High — required for any mission-critical claim                                                                                           |
| **Phase**    | Phase 5                                                                                                                                  |
| **Target**   | Phase 5, Sprint 7R (decision), Sprint 7O (implementation)                                                                                |
| **Status**   | Open — background work and health in v6.0.0 (Sprint 7R R5; ADR-056 Accepted 2026-10-24); recovery, alerting and objectives are Sprint 7O |
| **Logged**   | 2026-10-20                                                                                                                               |

**What:** no backup or restore design (recovery relies on the database plan's defaults), no RPO or RTO, no
alerting or on-call runbooks, no service-level objectives, and no durable queue or scheduler (retries and
timed jobs run as API routes or CI schedules). These were Phase 9 items; brought forward.

**Plan:** an ADR in Sprint 7R; Sprint 7O delivers point-in-time recovery with a tested restore drill, RPO
and RTO targets, alerting and runbooks, and SLO monitoring across both hosts.

**Sprint 7R entry gate (2026-10-21):** ADR-056 (Proposed) sets RPO ≤ 5 minutes and RTO ≤ 1 hour, the job queue
and scheduler design, health, telemetry, objectives and runbooks. The queue and scheduler move into 7R (R5),
because timed duties that exist today never run (TASK-141).

**Sprint 7R R5:** the durable queue and scheduler are delivered (TASK-141, ADR-056 §5), with the first
runbook (`docs/runbooks/jobs.md`), and health tells liveness from readiness (TASK-142). Recovery
(point-in-time recovery and the restore drill), telemetry export, objectives and alerting remain 7O.

### TASK-130 — Security assurance: dynamic testing, compliance mapping, data residency

| Field        | Detail               |
| ------------ | -------------------- |
| **ID**       | TASK-130             |
| **Type**     | Security — assurance |
| **Severity** | Medium               |
| **Phase**    | Phase 5              |
| **Target**   | Phase 5, Sprint 7O   |
| **Status**   | Open                 |
| **Logged**   | 2026-10-20           |

**What:** static analysis, dependency audit and secret scanning run in CI, but there is no dynamic testing
(DAST) against a deployed environment, no mapping to SOC 2, ISO 27001, India's DPDP Act or GDPR processor
obligations, and no data-residency control. Raised by the 2026-10-17 assessment. SEC-001 (CSP) remains
tracked in `SECURITY_DEBT.md`.

**Plan:** DAST against staging in CI; a compliance control map; data residency as part of the tenancy
placement decision (TASK-126).

### TASK-131 — More Indian languages and locale-aware formats

| Field        | Detail                   |
| ------------ | ------------------------ |
| **ID**       | TASK-131                 |
| **Type**     | Feature — multi-language |
| **Severity** | Low                      |
| **Phase**    | Phase 5                  |
| **Target**   | Phase 5, Sprint 7B       |
| **Status**   | Open                     |
| **Logged**   | 2026-10-20               |

**What:** Hindi, Bengali, Kannada, Malayalam and Telugu are supported; Marathi, Tamil and Gujarati are not.
Dates, numbers and currency are not yet locale-formatted. Tenant- and user-level language settings belong to
TASK-126.

### TASK-132 — A second maintainer with merge rights

| Field        | Detail                         |
| ------------ | ------------------------------ |
| **ID**       | TASK-132                       |
| **Type**     | Governance                     |
| **Severity** | Medium — key-person risk       |
| **Phase**    | Phase 5                        |
| **Target**   | Before the Phase 9 launch gate |
| **Status**   | Open                           |
| **Logged**   | 2026-10-20                     |

**What:** one person authors almost every commit. The ADRs, task register and engineering learnings keep the
platform legible; a second maintainer with merge rights removes the single point of failure.

### TASK-133 — /api/stream ran any prompt for any request carrying a bearer header

| Field        | Detail                                                        |
| ------------ | ------------------------------------------------------------- |
| **ID**       | TASK-133                                                      |
| **Type**     | Security — authentication                                     |
| **Severity** | High — unauthenticated, unbounded model calls on the platform |
| **Phase**    | Phase 5                                                       |
| **Target**   | Phase 5, Sprint 7A                                            |
| **Status**   | Resolved (platform-foundation develop); consumer action below |
| **Logged**   | 2026-10-20                                                    |

**What:** `proxy.ts` checks only that credentials are _present_ on `/api/*` and leaves verification
to the route handler. `/api/stream` (added Phase 2, Sprint 5) never verified them, so any request
with `Authorization: Bearer <anything>` — or a `pf_has_session=true` cookie — reached the orchestrator
with a caller-chosen prompt, system prompt, tier and `maxTokens`, with no screening and no limit.
Found by the route survey for B-2 (rate limiting). TASK-046's note that Sprint 3d had guarded the route
was true of Playform, whose own `proxy.ts` verifies tokens; Playform's dev, staging and production
were probed on 2026-10-20 and refused both forms with 401.

**Resolved:** the route verifies its caller (`requireActorWithStatus`, signed-in users only, account
status under the `stream` feature); every field is bounded server-side (`platform/ai/stream-policy.ts`:
prompt ≤ 4,000 characters, system ≤ 2,000, `maxTokens` 1–1,024, tier `fast` or `standard`,
temperature 0–1) and refused with a coded error when out of bounds; prompt and system prompt are
screened before any model call; an upstream failure reaches the client by code only. A new test,
`__tests__/api-route-auth.test.ts`, fails CI for any API route that neither calls a verifier nor is
listed as public by design with a reason. `useRealtimeStream` takes an access-token getter.

**Consumer action:** add `stream` to `account_status.known_features` to offer streaming (the
account-status check fails closed on an unknown feature, so the route answers `account.restricted`
until then). Routes in a consumer's own `app/api` are checked by the same test after sync.

### TASK-134 — The rate limiter existed, but no route used it

| Field        | Detail                                                               |
| ------------ | -------------------------------------------------------------------- |
| **ID**       | TASK-134                                                             |
| **Type**     | Security — abuse protection                                          |
| **Severity** | High — sign-in and account flows open to brute force and email abuse |
| **Phase**    | Phase 5                                                              |
| **Target**   | Phase 5, Sprint 7A                                                   |
| **Status**   | Resolved (platform-foundation develop); consumer action below        |
| **Logged**   | 2026-10-20                                                           |

**What:** `platform/rate-limit` (sliding window, memory and Redis stores) had shipped since Phase 2, and
ADR-020, two READMEs and SEC-002 described routes as limited. No route called it. The only limiter in
use was a separate per-instance one on admin routes (`platform/auth/rate-limit.ts`), which does not hold
across serverless instances. Sign-in, every account flow, guest minting and the AI routes had no limit,
and no environment configured a shared store. Found by the B-2 route survey; raised in part by the
2026-10-17 engineering assessment (the admin limiter).

**Resolved (ADR-052):** every API route calls `enforceRateLimit` (or `adminGuard`), checked by
`__tests__/api-route-rate-limit.test.ts`; the store is a provider slot (`RATE_LIMIT_STORE`: `supabase`,
`upstash`, `memory`) with one conformance kit for all three; the Postgres store (migration 039) is an exact
sliding window serialised per bucket, exercised on real Postgres in the migration replay, concurrency
included; production refuses the in-memory store; the limiter fails closed; the caller's address comes
from `X-Forwarded-For` at `TRUSTED_PROXY_HOPS` from the right. The per-instance admin limiter is removed;
the documents that claimed enforcement are corrected; SEC-002's resolution is restated.

**Consumer action (at the next sync):** apply migration 039 to every database; set
`RATE_LIMIT_STORE=supabase` on every deployment (production will not boot without a shared store); call
`enforceRateLimit` in the consumer's own routes (the synced test checks them); reset the limiter
singleton (`platform.rateLimit.limiter`) before each test in the consumer's `jest.setup.ts`.

### TASK-135 — Check a deployment's settings against the contract before promoting

| Field        | Detail                                                 |
| ------------ | ------------------------------------------------------ |
| **ID**       | TASK-135                                               |
| **Type**     | Operations — release safety                            |
| **Severity** | Medium — a bad setting is caught only after the deploy |
| **Phase**    | Phase 5                                                |
| **Target**   | Phase 5, Sprint 7P                                     |
| **Status**   | Open                                                   |
| **Logged**   | 2026-10-20                                             |

**What:** on the Playform v0.6.0 release, production's `SUPABASE_URL` carried `/rest/v1/`. The manual
pre-promotion review compared only the project reference, so it passed; the environment contract refused
the boot and the smoke test failed, before any user (production had none). The contract worked; the
review did not. Learning 114.

**Plan:** environment settings as code (with TASK-128): non-secret settings declared per environment in
the repository and checked by `checkEnvironmentContract` in CI before promotion; secrets checked for
presence and shape by the deploy pipeline without being displayed.

### TASK-136 — The route checks could not recognise a consumer's own guards

| Field        | Detail                                          |
| ------------ | ----------------------------------------------- |
| **ID**       | TASK-136                                        |
| **Type**     | Platform extension point                        |
| **Severity** | Medium — blocks a consumer from adopting v4.0.0 |
| **Phase**    | Phase 5                                         |
| **Target**   | Phase 5, Sprint 7A                              |
| **Status**   | Resolved (PF v4.1.0); Playform at v0.7.0        |
| **Logged**   | 2026-10-21                                      |

**What:** a simulation of the v4.0.0 sync into Playform failed the two new route checks for twelve
Playform routes that do verify their callers — through `requireAuthWithStatus` (its route guard) and
`resolveAgentRouteContext` (two-principal agent context), which the checks did not know. The checks are
synced files, so a consumer could not extend them. Learning 110's class: a contract that a consumer must
satisfy has to ship the consumer's extension point.

**Resolved (PF v4.1.0):** `platform/route-policy/app-route-policy.ts` (consumer-owned, shipped empty)
declares an app's verifier and limiter wrappers and its own public or exempt routes. The checks locate
each wrapper's definition and accept it only if it calls a platform verifier or `enforceRateLimit`,
directly or through another accepted wrapper; self-tests cover the transitive case, a wrapper that
verifies nothing, and one that cannot be found. Definitions are looked for in source only: a Jest manual
mock (`lib/__mocks__/route-guard.ts`) re-declares a wrapper's name, and counting it made Playform's real
guard look ambiguous — found by the v4.1.0 sync simulation, fixed with a self-test.

**Same class, docs (PF v4.1.0):** Playform excluded `docs/ENV_REFERENCE.md` and
`__tests__/docs-integrity.test.ts` as "app-owned" but never wrote its own, so nothing checked Playform's
docs, and its TAD still described March 2026. The check needed two consumer seams:
`docs/APP_ENV_REFERENCE.md` (the app's own settings, read with ENV_REFERENCE) and `PLATFORM_VERSION`
(the release-notes check had compared the platform's notes with the app's `package.json`). Playform now
inherits both files and the check, and owns its README, docs index and TAD. An audit of every Playform
exclusion (learning 115) also found its twelve auth routes byte-identical to the platform's yet excluded —
now inherited, with the platform's `auth-routes` test — one exclusion naming a file that no longer existed
(removed), and an orphaned `components/admin/styles.ts` left by a sync (removed). On Playform's first secret
scan, the synced `.gitleaksignore` could not cover a Playform commit: the list names commits, so it is a
consumer seam too. SETUP_AND_INTEGRATION now lists every consumer seam.

### TASK-137 — Anyone with the public key could reset or exhaust an agent's budget

| Field        | Detail                                                                   |
| ------------ | ------------------------------------------------------------------------ |
| **ID**       | TASK-137                                                                 |
| **Type**     | Security — database privilege                                            |
| **Severity** | High — defeats the governed AI cost cap, or stops Guardian (fail-closed) |
| **Phase**    | Phase 5                                                                  |
| **Target**   | Phase 5, Sprint 7R                                                       |
| **Status**   | Fixed on develop (migration 040); applied to each database by hand       |
| **Logged**   | 2026-10-21                                                               |

**What:** `agent_budget_consume()` runs as its owner (`SECURITY DEFINER`, so it bypasses row-level
security on `agent_budgets`) and was executable by `anon` and `authenticated` — the database's default
grant, never revoked. Through the REST API, anyone holding the project's public key could call it: a
negative delta resets an agent's daily spend and defeats the governed cap (ADR-048); a large positive one
exhausts the budget, and Guardian, which fails closed, then refuses all content. Found by the Sprint 7R
tenancy survey. The platform calls it only with the service role.

**Fixed (migration 040):** execute revoked from `public`, `anon` and `authenticated`, granted to
`service_role` (the pattern of 037 and 039); the function refuses negative or non-finite deltas. The
migration replay now fails on any function that writes, runs as its owner and is executable by `anon` or
`authenticated`, so the class cannot return — verified to fail before 040 and pass after, on the
platform's and Playform's migration sets.

### TASK-138 — Admin audit records name a placeholder, not the admin

| Field        | Detail                                      |
| ------------ | ------------------------------------------- |
| **ID**       | TASK-138                                    |
| **Type**     | Audit integrity                             |
| **Severity** | Medium — admin actions cannot be attributed |
| **Phase**    | Phase 5                                     |
| **Target**   | Phase 5, Sprint 7X                          |
| **Status**   | Fixed in v5.0.0 (Sprint 7X)                 |
| **Logged**   | 2026-10-21                                  |

**What:** `adminGuard` verifies the caller and then returns `null`, so routes cannot name the admin who acted. `getAdminActorId` (`platform/auth/admin-guard.ts`) returns the placeholder `"authenticated-admin"` (or `"dev-admin"`), and admin audit records carry it. Three routes recover the actor with a second `optionalAuth` call. Found by the Sprint 7R tenancy survey.

**Plan:** `adminGuard` returns the verified admin (user and tenant); `getAdminActorId` is removed; every admin audit write names the admin; a test fails any admin audit record without a real actor (R2).

**Fixed (Sprint 7X):** `requireAdmin` returns the verified admin (`userId`, `sub`, role, permissions); `getAdminActorId` is removed; every admin audit record names the admin, and the audit module refuses a non-UUID actor, so a placeholder can no longer be written (`audit-fail-closed`). The tenant joins the admin identity with R3.

### TASK-139 — The cache falls back to memory in production without saying so

| Field        | Detail                                                       |
| ------------ | ------------------------------------------------------------ |
| **ID**       | TASK-139                                                     |
| **Type**     | Reliability — configuration                                  |
| **Severity** | Medium — a misconfigured cache silently becomes per instance |
| **Phase**    | Phase 5                                                      |
| **Target**   | Phase 5, Sprint 7R                                           |
| **Status**   | Fixed in v6.0.0 (Sprint 7R R2)                               |
| **Logged**   | 2026-10-21                                                   |

**What:** `platform/cache/index.ts` selects Redis only when `UPSTASH_REDIS_REST_URL` is present and otherwise uses an in-memory cache, in production too, silently (it warns only when the URL is set without its token). `CACHE_PROVIDER=upstash` with missing credentials also warns and falls back, and `getCache` otherwise ignores `CACHE_PROVIDER`. The cache is not in the environment contract. Found by the Sprint 7R deploy-anywhere survey.

**Plan:** The cache becomes an explicit `CACHE_PROVIDER` selection, honoured by `getCache` and declared in the contract; production refuses an in-memory cache unless the E2E harness opts out, as for every durable store (ADR-048 D3, ADR-055 D4) (R2).

**Fixed (Sprint 7R R2):** `CACHE_PROVIDER` is declared in the environment contract and read through one resolver by the cache, the registry and the contract. A deployment must set it; a Redis URL alone no longer selects Redis; `upstash` without its credentials refuses to boot, in the cache and the registry alike. Decision, against the plan's wording: `memory` is accepted when declared, because the cache holds nothing authoritative (losing it costs hits, not correctness) — the defect was the silence, not the in-memory cache. Deploy prerequisite: `CACHE_PROVIDER` in every Vercel project before the 7R promotion.

**Revised (review 8 L3, TASK-162):** `memory` is no longer accepted in a deployment. The cache now carries token revocations (sign-out, role and MFA changes) and permission invalidations to every instance, so a per-instance cache is a correctness defect, not lost hits: only a local or CI run (`DEPLOYMENT_HOST` `local`/`ci`) may use it. Deploy prerequisite: `CACHE_PROVIDER=upstash` with its credentials in every Vercel project (MIGRATION_v5_to_v6 step 3).

### TASK-140 — Off Vercel, production would accept the test-harness switches

| Field        | Detail                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------- |
| **ID**       | TASK-140                                                                                    |
| **Type**     | Security — configuration                                                                    |
| **Severity** | High — on any other host, mock sign-in and in-memory stores would be accepted in production |
| **Phase**    | Phase 5                                                                                     |
| **Target**   | Phase 5, Sprint 7R                                                                          |
| **Status**   | Fixed in v5.0.0 (Sprint 7X)                                                                 |
| **Logged**   | 2026-10-21                                                                                  |

**What:** The environment contract treats a deployment as hosted only when `VERCEL=1`, and only a hosted deployment refuses `E2E_IN_MEMORY_STORES` and `E2E_TEST_DOUBLE_AUTH` (and reports `ADMIN_DEV_BYPASS`, which `adminGuard` separately ignores in any production build). A container or any other host would accept the first two in production. The deployed commit is read only from `VERCEL_GIT_COMMIT_SHA` and the version from `npm_package_version`. Not exploitable today (only Vercel is deployed); must be closed before any other host. Found by the Sprint 7R deploy-anywhere survey.

**Plan:** Inverted, so forgetting a setting cannot reopen it: the harness switches are accepted only with a positive non-hosted marker (`DEPLOYMENT_HOST=local` or `ci`); any other value, or none, refuses them. The commit from `GIT_COMMIT_SHA` then `VERCEL_GIT_COMMIT_SHA`; the version from the `platform/version.ts` constant (ADR-055 D2) (R2).

**Fixed (Sprint 7X):** as planned — `DEPLOYMENT_HOST` in the contract; the harness switches are accepted in production only with `local` or `ci`; the commit from `GIT_COMMIT_SHA` then `VERCEL_GIT_COMMIT_SHA`; the version from `PLATFORM_VERSION` (`environment-contract` tests). The monkey run (`fuzz.yml`) starts the production build with `DEPLOYMENT_HOST=ci`.

### TASK-141 — Timed duties have no trigger

| Field        | Detail                                                                   |
| ------------ | ------------------------------------------------------------------------ |
| **ID**       | TASK-141                                                                 |
| **Type**     | Operations — background work                                             |
| **Severity** | High — the escalation SLA (ADR-041) and retention rules are not enforced |
| **Phase**    | Phase 5                                                                  |
| **Target**   | Phase 5, Sprint 7R                                                       |
| **Status**   | Fixed in v6.0.0 (Sprint 7R R5)                                           |
| **Logged**   | 2026-10-21                                                               |

**What:** The escalation-SLA reaper is a route nothing calls; `releaseExpiredClaims` and `expireStrikes` have no caller; the GDPR retention purge is manual; the analyst and curator agents have budgets but no schedule. There is no queue, outbox or dead-letter handling. Found by the Sprint 7R operations survey.

**Plan:** `platform/jobs` (ADR-056 D2): a Postgres-backed queue and scheduler, host ticks from Vercel Cron and (7P) EventBridge, each timed duty a registered recurring job, and a CI check that a function documented as scheduled has a registered job (R5).

**Fixed (Sprint 7R R5):** as planned (ADR-056 §5). Migration 050: `jobs` (per-tenant, forced row-level security; platform jobs owner-only; idempotent by tenant, kind and key), `job_schedules`, and `job_claim` (`FOR UPDATE SKIP LOCKED`, leases, owner rights, closed to every public and request role — checked by the replay). `platform/jobs`: a `JOB_STORE` slot (Postgres, in memory for tests), an extensible registry (core duties, modules' `jobs`, `registerJob`), `enqueueJob`, and `runDue` — runs each job in its tenant, retries with backoff and jitter, dead-letters after the last attempt with sanitized wording, recovers lapsed leases, never runs past its budget. The tick is `/api/internal/jobs/tick` (`CRON_SECRET`, constant-time; Vercel Cron every five minutes, or `npm run jobs:worker`). Every timed duty is a recurring job with governed, audited, dual-controlled settings: the escalation reaper, claim release, strike expiry, lapsed restrictions, the GDPR retention purge, trajectory retention, stale approvals (TASK-036), tenant purge, job-history pruning, and the social analyst and curator (migration 051, a tenant opt-out, governed budgets). The uncalled reaper route is removed. `__tests__/jobs-scheduled-coverage.test.ts` fails on a `@scheduled` function without a job, a job without a schedule or seeded settings, and an untagged "scheduled" comment. Operators run, pause, replay and discard in the Jobs console; tenant administrators see their own history.

### TASK-142 — Health does not check the database

| Field        | Detail                                                             |
| ------------ | ------------------------------------------------------------------ |
| **ID**       | TASK-142                                                           |
| **Type**     | Operations — health                                                |
| **Severity** | Medium — a deployment with an unreachable database reports healthy |
| **Phase**    | Phase 5                                                            |
| **Target**   | Phase 5, Sprint 7R                                                 |
| **Status**   | Fixed in v6.0.0 (Sprint 7R R5)                                     |
| **Logged**   | 2026-10-21                                                         |

**What:** `/api/health` runs only the song-identification probe; the database, cache and realtime probes exist but are not registered, and there is no separate readiness check. Found by the Sprint 7R operations survey.

**Plan:** Liveness and readiness split. Readiness requires boot to have completed and the database (and a selected shared cache) to answer; realtime and module probes report degraded without making the instance unready, so one dependency blip cannot take every instance out of rotation. Modules contribute their probes (ADR-054 D4, ADR-056 D4); the deploy smoke test checks readiness (R5).

**Fixed (Sprint 7R R5):** `/api/health/live` (the process answers) and `/api/health/ready` (boot completed — `instrumentation.ts` records each step, so a failed boot is reported with its step — and the required probes answer: the database when configured, the selected cache). Realtime (`createRealtimeServiceProbe`) and the modules' probes are optional: they report degraded, still ready. `HealthRegistry` marks probes required or optional; probes are bounded and answers carry names and statuses only. `/api/health` keeps its shape, adding `required`, `ready` and `boot`. `scripts/deploy-smoke.mjs` checks liveness then readiness.

### TASK-143 — The scheduled load test can never pass

| Field        | Detail                                                      |
| ------------ | ----------------------------------------------------------- |
| **ID**       | TASK-143                                                    |
| **Type**     | CI correctness                                              |
| **Severity** | Low — a scheduled job that always fails hides real failures |
| **Phase**    | Phase 5                                                     |
| **Target**   | Phase 5, Sprint 7R                                          |
| **Status**   | Fixed in v6.0.0 (Sprint 7R R5)                              |
| **Logged**   | 2026-10-21                                                  |

**What:** `.github/workflows/load-test.yml` runs every Monday against `http://localhost:3000` without starting a server. Found by the Sprint 7R operations survey.

**Plan:** Any run whose target is localhost — the schedule, and a manual run left at its default — starts the built app (or the container image, R6) first; a manual run against a deployed address targets it directly (R5).

**Fixed (Sprint 7R R5):** a localhost target builds the app, starts it on the E2E harness (`DEPLOYMENT_HOST=ci`) and waits for `/api/health/ready` before k6; an `https://` target is tested directly; any other input is refused, and the input reaches the shell only as an environment variable. The container image replaces the local build in R6. **R6:** done — a localhost target builds the image and runs it on the harness (read-only, `--network host`).

### TASK-144 — An agent's budget day is the server's local day

| Field        | Detail                                                      |
| ------------ | ----------------------------------------------------------- |
| **ID**       | TASK-144                                                    |
| **Type**     | Correctness — governed budgets                              |
| **Severity** | Low — the daily cap resets at a different hour on each host |
| **Phase**    | Phase 5                                                     |
| **Target**   | Phase 5, Sprint 7R                                          |
| **Status**   | Fixed in v6.0.0 (Sprint 7R R2)                              |
| **Logged**   | 2026-10-21                                                  |

**What:** `BudgetTracker.getCurrentPeriod()` (`platform/agents/budget-tracker.ts`) builds `YYYY-MM-DD` from local time. Vercel runs in UTC; a container or another host may not, so the governed daily cap (ADR-048) would reset at different hours. Found by the Sprint 7R tenancy survey.

**Plan:** Periods computed in UTC, with a test that fixes the time zone (R2).

**Fixed (Sprint 7R R2):** periods are the UTC date (`toISOString`), tested under several host time zones. The same class of defect was found in the COPPA age gate: `calculateAge` used the host's local date, so west of UTC a child was a day older on the day before a birthday — at 13, the day consent stops being required — and the sign-up gate kept its own copy of the rule in the browser's time. Now one client-safe module (`platform/auth/age.ts`) used by both: the age is taken as of the earliest calendar date anywhere (UTC−12), so it is never overstated; impossible and future dates are refused rather than read as an adult.

### TASK-145 — Tests confirmed; nothing proved what the system refuses (October 2026 audit)

| Field        | Detail                                                                                  |
| ------------ | --------------------------------------------------------------------------------------- |
| **ID**       | TASK-145                                                                                |
| **Type**     | Security — assurance (umbrella for the October 2026 whole-system adversarial review)    |
| **Severity** | Critical — privilege escalation and missing audit in production while every test passed |
| **Phase**    | Phase 5                                                                                 |
| **Target**   | Phase 5, Sprint 7X (Wave 1: v5.0.0; Waves 2 and 3 follow)                               |
| **Status**   | Wave 1 fixed in v5.0.0; Wave 2 fixed in v6.0.0 (Sprint 7R close); Wave 3 open (X-25)    |
| **Logged**   | 2026-10-21                                                                              |

**What:** A moderator could make themselves `super_admin` through the AI command bar, any admin could assign any role, and role changes left no audit record — while unit, integration and end-to-end tests, CodeQL, Semgrep and every sprint-close review passed. Route tests stubbed the admin guard; a self-elevation check was tested but never called; no test acted as the wrong role (learning 116). The independent whole-system review that followed found 7 Critical and 18 High findings and many Medium and Low ones; the register is [audits/2026-10-REGISTER.md](audits/2026-10-REGISTER.md).

**Wave 1 (Sprint 7X, v5.0.0):** every Critical and High finding in platform code, and the Medium and Low ones on the same paths, each with the test that would have caught it; Adversarial Validation adopted as a core tenet with the checks that enforce it ([ASSURANCE.md](ASSURANCE.md)): authorization matrix, real guards, security wiring, coverage-ignore policy, paid-route quota, JSON bodies, REST URL encoding, property-test depth, the monkey run, weekly migration parity and ZAP.

**Release review (2026-10-22):** three independent reviewers of the v5.0.0 diff found 2 High, 9 Medium and 14 Low issues (RR-1–RR-25 in the register); every High and most of the rest are fixed in v5.0.0 with their tests, including a pre-existing defect that stored governed config values as JSON text (migration 045).

**Wave 2:** runtime holds (X-10), purge handlers and export/erasure routes (X-15), age consent (X-16), sessions (X-17), multimodal safety and provenance (X-18), guest continuation (X-20), remaining fire-and-forget writes (X-22), and the Medium and Low items the register marks Wave 2 (including RR-8, RR-15, RR-17, RR-19, RR-23). **Wave 3:** latent modules (X-25) before any route reaches them. Consumer-owned findings (X-9 and others) are fixed in the consumer's adoption.

**Wave 2 fixed on develop (Sprint 7R close, for v6.0.0):** every item, one by one, with its true state and its test, in the register's [Wave 2](audits/2026-10-REGISTER.md#wave-2-sprint-7x-on-develop-for-v600) section; migration 052 (idempotent, applied twice by the replay). Found while fixing: `/api/stream`'s feature was in neither governed list, so every user was refused it on a database deployment (052 adds it); the provider registry built the Cognito provider without its hosted-UI domain, admin credentials or secret; a number setting accepted `null`, `""`, `true` and `[]` and stored them as given, a text setting accepted objects, and an object without a prototype made validation throw (TASK-147's property tests); `AI_PROVIDER` had no effect. Accepted with reasons: G-14 (the health report's commit, ADR-050 D6) and H-13 (identifiers in public history). Wave 3 (X-25) stays open; `latent-modules-unreached` fails as soon as a route reaches those modules.

### TASK-146 — Privileged and isolation paths are not yet tested against real Postgres

| Field        | Detail                                                                        |
| ------------ | ----------------------------------------------------------------------------- |
| **ID**       | TASK-146                                                                      |
| **Type**     | Assurance — test fidelity                                                     |
| **Severity** | Medium — a database-only behaviour (a constraint, a grant, a type) can differ |
| **Phase**    | Phase 5                                                                       |
| **Target**   | Phase 5, Sprint 7X Wave 2                                                     |
| **Status**   | Fixed in v6.0.0 (Sprint 7X Wave 2)                                            |
| **Logged**   | 2026-10-22                                                                    |

**What:** Adversarial Validation practice 5 asks that privileged and data-isolation paths run against real Postgres. Today the routes run against `FakeDatabase` (filters evaluated, unique constraints, failures injected, filter strings refused) and the SQL runs against real Postgres only in the migration replay. Uuid and enum column semantics — the cause of X-8 and E-15 — are exactly what an in-memory database does not reproduce. Recorded in [ASSURANCE.md](ASSURANCE.md) §3.

**Plan:** The migration-replay database serves a route-level suite in CI: the role-change, config, moderation and audit paths run as each role against it, with the same hostile cases.

**Progress (Sprint 7R R3):** CI now replays the migrations into Postgres and runs `__tests__/db` against it as
the request role: every store (moderation, review queue, strikes, social, app state, trajectories, budgets,
proposals, effect ledger, approval policy, guest usage, rate limits, embeddings), configuration and its
approvals, the role and entitlement catalog, users, consent and deletion records, the tenant directory and
lifecycle — each with the cross-tenant isolation kit — and every SQL statement in the sources is planned
against the schema (`sql-schema-parity.db.test.ts`). Remaining for Wave 2: the route-level role matrix itself
against that database.

**Done (Sprint 7X Wave 2):** `__tests__/db/route-role-matrix.db.test.ts` runs every privileged route — the 34
administration, moderation and account route handlers, with a check that fails when a new route file is not
in the matrix — as every role of the real catalog, as nobody, as a suspended `super_admin` and as a
`super_admin` without a second factor, in a test tenant on the replayed database: refused exactly when the
role lacks the permission, never a 500, hostile bodies answered with a 4xx, and generated bodies (TASK-147)
never a 500. `__tests__/db/user-data-coverage.db.test.ts` proves erasure and export over every table.

### TASK-147 — Generated hostile input covers few suites; the monkey run is bounded by rate limits

| Field        | Detail                                                       |
| ------------ | ------------------------------------------------------------ |
| **ID**       | TASK-147                                                     |
| **Type**     | Assurance — test breadth                                     |
| **Severity** | Medium — hand-picked hostile cases miss what nobody imagined |
| **Phase**    | Phase 5                                                      |
| **Target**   | Phase 5, Sprint 7X Wave 2                                    |
| **Status**   | Fixed in v6.0.0 (Sprint 7X Wave 2)                           |
| **Logged**   | 2026-10-22                                                   |

**What:** Property tests cover sanitization, output screening, paging and search; most suites use hand-picked hostile cases only. The monkey run sweeps every route as every caller first, but from one address most of its random steps are then refused with 429 — correctly, since it must not bypass the limits. Recorded in [ASSURANCE.md](ASSURANCE.md) §3.

**Plan:** Property tests for every validator and every route's body schema (generated bodies, `fast-check`); the monkey run gains a sequence mode that paces itself under each route's limit, and invariants after each step on the data it may see (no other user's records).

**Done (Sprint 7X Wave 2):** `__tests__/validator-properties.test.ts` drives every validator at an input boundary (birth dates, config values, passwords, tenant slugs, names, hosts and ids, language codes, stream bodies, refresh cookies, JSON bodies, text fields, avatar addresses, address buckets, tool schemas) with generated values of every shape; it found four defects, fixed with it (a number setting stored `null`/`""`/`true`/`[]`, a text setting objects; validation threw on an object without a prototype; `isValidSchema` threw; language codes were unbounded). Every privileged route's body is fuzzed against Postgres in the role matrix (TASK-146). The monkey run's `MONKEY_MODE=sequence` takes paced sequences through each family of routes (it waits out a 429's `Retry-After`, never bypasses the limiter), reuses the ids the server returned, and checks I6 — no response to one caller carries another caller's identity (`__tests__/monkey-sequence.test.ts`); the fuzz workflow runs it after the sweep. Provenance, guest continuation and admin search keep their property tests.

### TASK-148 — Migration records claimed what never happened (the role model)

| Field        | Detail                                                                              |
| ------------ | ----------------------------------------------------------------------------------- |
| **ID**       | TASK-148                                                                            |
| **Type**     | Schema integrity — migration records                                                |
| **Severity** | Medium — a record that claims an effect hides a database that differs from the code |
| **Phase**    | Phase 5                                                                             |
| **Target**   | Phase 5, Sprint 7R                                                                  |
| **Status**   | Fixed in v6.0.0 (Sprint 7R R2, platform part); Playform records its own with v0.9.0 |
| **Logged**   | 2026-10-23                                                                          |

**What:** The first live run of the migration-parity check (2026-10-23, with credentials) failed on both
Playform databases. Production records `000_baseline.sql`, which the check did not know (it reads only
`supabase/migrations/`); dev never recorded Playform's `007_playform_subscription_tiers.sql`. Looking
closer: `007_seed_separation.sql` creates a generic `registered` default role with an inheritance
chain, and Playform's 007 makes the paid tiers inherit from it — but no database has `registered`,
`role_inheritance` is empty everywhere, and `free` is the default. Dev records PF's 007 as "assumed",
production (through the baseline) as "verified", and production records Playform's 007 as "verified"
with no effect. The role model in force is flat — each role holds its permissions directly — and the
code (`DEFAULT_USER_ROLE = "free"`) reads exactly that, so nothing was wrong for users.

**Fixed (platform):** decision — keep the flat model that runs and the code reads; correct the
records, change no role or permission. Migration `047_role_model_records.sql` marks
`007_seed_separation.sql` "absent" wherever `registered` does not exist. The parity check accepts the
baseline's own record. The replay checks that the default role the code provisions is the database's
only default, and that 007 is never recorded as applied without its role.

**Remaining (Playform, with its 7R adoption):** a Playform migration recording its own
`007_playform_subscription_tiers.sql` the same way in both databases. Until then the weekly parity
check reports it.

### TASK-149 — ESLint 9 is out of support; ESLint 10 waits on Next's plugins

| Field        | Detail                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------- |
| **ID**       | TASK-149                                                                                 |
| **Type**     | Dependency hygiene                                                                       |
| **Severity** | Low — development tooling only; nothing it checks reaches users                          |
| **Phase**    | Phase 5                                                                                  |
| **Target**   | Phase 5, Sprint 7R close (re-checked each dependency batch)                              |
| **Status**   | Open — re-checked 2026-10-24 (Sprint 7R close): the plugins still declare ESLint up to 9 |
| **Logged**   | 2026-10-23                                                                               |

**What:** `npm` reports `eslint@9.39.5` as no longer supported. ESLint 10 is held back (Dependabot
ignores its major) because the React, accessibility and import plugins in `eslint-config-next` 16.4
declare ESLint up to 9 and install only by overriding their peer range.

**Plan:** at each dependency batch, check the three plugins' declared ESLint range; move both
repositories to ESLint 10 together the batch they declare it, and lift the Dependabot ignore.

**Re-checked 2026-10-24 (Sprint 7R close dependency batch).** `eslint-config-next` 16.4.3 (latest)
depends on `eslint-plugin-react` ^7.37.0, `eslint-plugin-jsx-a11y` ^6.10.0 and
`eslint-plugin-import` ^2.32.0. The latest of each — `eslint-plugin-react` 7.37.5 (peer `eslint`
`^3 || … || ^9.7`), `eslint-plugin-jsx-a11y` 6.10.2 (`^3 || … || ^9`) and `eslint-plugin-import`
2.32.0 (`^2 || … || ^9`) — still declare ESLint up to 9 (`eslint-plugin-react-hooks` 7.1.1 already
declares `^10.0.0`). ESLint stays on 9.39.5 (latest 10.13.0) and the Dependabot ignore stays.

### TASK-150 — Two reviewers could act on one review item at once

| Field        | Detail                                                               |
| ------------ | -------------------------------------------------------------------- |
| **ID**       | TASK-150                                                             |
| **Type**     | Correctness — concurrency                                            |
| **Severity** | Medium — a resolution could overwrite another reviewer's, unrecorded |
| **Phase**    | Phase 5                                                              |
| **Target**   | Phase 5, Sprint 7R R3                                                |
| **Status**   | Fixed in v6.0.0 (Sprint 7R R3)                                       |
| **Logged**   | 2026-10-23                                                           |

**What:** a claim, release or resolution of a review-queue item read the item, checked its state and wrote
it back unconditionally, so two reviewers acting together both succeeded and the later write won. Releasing
a claim left `claimed_by` set. Found converting the review store to SQL.

**Fixed:** every update is compare-and-set on the state it was read in (`moderation.item_state_conflict`
otherwise), in both the Postgres and in-memory stores; a release clears the claim. The review-queue
conformance kit covers both races.

### TASK-151 — A soft deletion always reported failure

| Field        | Detail                                                                   |
| ------------ | ------------------------------------------------------------------------ |
| **ID**       | TASK-151                                                                 |
| **Type**     | Correctness — GDPR erasure                                               |
| **Severity** | Medium — the erasure ran, but its record did not, and callers saw errors |
| **Phase**    | Phase 5                                                                  |
| **Target**   | Phase 5, Sprint 7R R3                                                    |
| **Status**   | Fixed in v6.0.0 (Sprint 7R R3)                                           |
| **Logged**   | 2026-10-23                                                               |

**What:** `softDeleteUser` recorded each erasure in a table no migration created, so every soft deletion
returned `success: false`, and a deletion of a user who did not exist was not distinguished.

**Fixed:** migration 049 creates `user_deletions` (per tenant, under row-level security); an erasure is
recorded in it and succeeds; a missing user answers `users: no such user`; a hard purge marks the record
purged.

### TASK-152 — `signups_enabled` was declared but never enforced

| Field        | Detail                                                                 |
| ------------ | ---------------------------------------------------------------------- |
| **ID**       | TASK-152                                                               |
| **Type**     | Correctness — configuration                                            |
| **Severity** | Medium — an administrator who closed sign-ups still received new users |
| **Phase**    | Phase 5                                                                |
| **Target**   | Phase 5, Sprint 7R R3                                                  |
| **Status**   | Fixed in v6.0.0 (Sprint 7R R3)                                         |
| **Logged**   | 2026-10-23                                                             |

**What:** the setting existed in `platform_config` and the admin console, but sign-up never read it.

**Fixed:** sign-up, and the first sign-in of an identity with no tenant (including SSO), refuse with
`auth.signups_closed` when the tenant's `signups_enabled` is false — read per tenant, so each tenant of a
shared deployment decides for itself.

### TASK-153 — The AI response cache keyed responses on a 32-bit hash

| Field        | Detail                                                           |
| ------------ | ---------------------------------------------------------------- |
| **ID**       | TASK-153                                                         |
| **Type**     | Correctness — caching                                            |
| **Severity** | Medium — two different requests could share a key and one answer |
| **Phase**    | Phase 5                                                          |
| **Target**   | Phase 5, Sprint 7R R3                                            |
| **Status**   | Fixed in v6.0.0 (Sprint 7R R3)                                   |
| **Logged**   | 2026-10-23                                                       |

**What:** the cache key was a 32-bit string hash of the prompt, so collisions were likely at volume (and
could be constructed): a request could be answered with another's cached response. Keys were also global.

**Fixed:** the key is `ai:<tenant>:<SHA-256 of the canonical request>` — collision-resistant, and never
shared between tenants.

### TASK-154 — Screens called the API without the signed-in user's token

| Field        | Detail                                                              |
| ------------ | ------------------------------------------------------------------- |
| **ID**       | TASK-154                                                            |
| **Type**     | Correctness — authentication on the client                          |
| **Severity** | High — the admin console and three screens could not work signed in |
| **Phase**    | Phase 5                                                             |
| **Target**   | Phase 5, Sprint 7R R3                                               |
| **Status**   | Fixed in v6.0.0 (Sprint 7R R3)                                      |
| **Logged**   | 2026-10-24                                                          |

**What:** the server authenticates every API call by its `Authorization: Bearer` header, but the admin
console (every panel, the command bar, held actions, dual-control keys), the review dashboard, the appeal
form and the main screen called `fetch` without it, so each authenticated call was refused with 401. Route
tests called the handlers with a token and never saw it; found by driving the production build in a browser,
signed in.

**Fixed:** `apiFetch` (`platform/auth/api-fetch.ts`) attaches the session's token to calls to this origin only
(never another site), unless the caller set its own header, and never an expired one. Every screen uses it;
`__tests__/client-api-auth.test.ts` refuses a bare `fetch` in browser code outside a reviewed list (calls made
before a session exists, or that set the header themselves).

### TASK-155 — An approved dual-control config change was never applied

| Field        | Detail                                                                          |
| ------------ | ------------------------------------------------------------------------------- |
| **ID**       | TASK-155                                                                        |
| **Type**     | Correctness — governed configuration                                            |
| **Severity** | High — a dual-controlled change approved by a second admin silently did nothing |
| **Phase**    | Phase 5                                                                         |
| **Target**   | Phase 5, Sprint 7R R3                                                           |
| **Status**   | Fixed in v6.0.0 (Sprint 7R R3)                                                  |
| **Logged**   | 2026-10-24                                                                      |

**What:** a change to a key in `config.dual_control_keys` is held at runtime (ADR-039 F2b-2) and approved
through `POST /api/admin/approvals/[id]`. Approving recorded the decision, but nothing ran the held change
again on its approval — the config page and the assistant are one-shot callers, and only a workflow loop
resumes a held step. The admin saw "approved"; the setting never changed. Found by the operators' per-tenant
settings test against Postgres.

**Fixed:** the decision applies an approved held config change at once (`resumeApprovedConfigChange`: the
held tool on its approved proposal — the approved payload, the same operation, as the proposer; the pipeline
consumes the approval, so it releases one change once). Under two-person approval the change then waits for
that approval. A change that cannot be applied answers 503 and is logged.

### TASK-156 — R4–R6 adversarial review: jobs, shutdown, health and the image

| Field        | Detail                                                                           |
| ------------ | -------------------------------------------------------------------------------- |
| **ID**       | TASK-156                                                                         |
| **Type**     | Security and correctness — background work, shutdown, health, CI supply chain    |
| **Severity** | High — pools closed under requests; a deployment without CRON_SECRET ran no duty |
| **Phase**    | Phase 5                                                                          |
| **Target**   | Phase 5, Sprint 7R (before R4–R6 are released)                                   |
| **Status**   | Fixed in v6.0.0 (Sprint 7R, before release)                                      |
| **Logged**   | 2026-10-24                                                                       |

**What:** an adversarial review of the unreleased R4–R6 commits found sixteen defects, each proved by a test
(now `__tests__/jobs-hostile.test.ts` and the module registry's tests, inverted to assert the fix).

**Fixed (all sixteen; ADR-056 §6 has the detail):**

| #   | Sev  | Finding                                                        | Fix                                                                                                                                                                                       | Proof                                                                              |
| --- | ---- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1   | High | pools closed under requests in flight; runDue claimed draining | every API route counted in flight (`tenantRoute`); the stop waits for them up to its deadline; the runner stops claiming, aborts the attempt, releases the rest; the worker stops at once | `shutdown.test.ts` (work in flight), `jobs-hostile.test.ts`, the container re-test |
| 2   | High | production booted ready without `CRON_SECRET`, running no duty | the contract requires `CRON_SECRET` on every deployment host; a `job-schedules` probe reports stale schedules (degraded)                                                                  | `environment-contract.test.ts`, `jobs-schedule-probe.test.ts`                      |
| 3   | Med  | a timed-out handler ran beside its own retry                   | duties check `ctx.signal` between items; a handler still running keeps its lease (extended, ≤ 15 min) and is settled when it settles                                                      | `jobs-hostile.test.ts`, `jobs-runner.test.ts`, `jobs-duties.test.ts`               |
| 4   | Med  | enqueue bound to neither tenant nor scope                      | `enqueueJob`: current tenant only unless a minted `JobAuthority`; scope enforced; unknown kinds refused; `app_tenant` inserts no job (050)                                                | `jobs-hostile.test.ts`, `jobs.db.test.ts`, the replay                              |
| 5   | Med  | `job_claim` scanned the table (423 ms at 300 000 rows)         | parked status for non-active tenants; `jobs_queued_idx (tenant_id, kind, run_at, id)`; lapsed and queued branches; batch claims — 2–7 ms at 900 000 rows                                  | `jobs.db.test.ts` (300 000 + 300 000 rows)                                         |
| 6   | Med  | no fairness; backdated jobs accepted                           | the claim takes tenants round-robin; `run_at` clamped to now (queue and database)                                                                                                         | `job-store-contract.ts` (both stores), `jobs-hostile.test.ts`, `jobs.db.test.ts`   |
| 7   | Med  | suspended tenants' GDPR erasures stopped                       | `runsForSuspended` per kind (the GDPR purge, trajectory retention): claimed and scheduled for suspended tenants; deleted tenants never                                                    | `jobs-hostile.test.ts`, `jobs.db.test.ts`, the replay                              |
| 8   | Med  | the last tenant to finish overwrote the schedule's status      | `job_schedule_outcomes`, one row per tenant; the console shows the worst and "failing for N of M tenants"                                                                                 | `job-store-contract.ts`, `jobs.db.test.ts`, `jobs-panels.test.tsx`                 |
| 9   | Low  | re-running 050 re-added removed dual-control keys              | seeded on 050's first application only                                                                                                                                                    | the replay (second and third application), `jobs.db.test.ts`                       |
| 10  | Low  | `load-test.yml` target check bypassed with a newline           | `scripts/load-test-target.sh`: whole-value `[[ =~ ]]`, newline and CR refused                                                                                                             | `load-test-target.test.ts`                                                         |
| 11  | Low  | the mirror fallback pulled an unpinned tag                     | `pull-base-image.sh` resolves the digest on Docker Hub, pulls that digest (mirror too), checks it; `ARG BASE_IMAGE_DIGEST` must match when pinned                                         | `pull-base-image.test.ts`                                                          |
| 12  | Low  | module fingerprint omitted jobs                                | jobs (kind, schedule, timeout, attempts, backoff, scope, suspended rule) in the fingerprint                                                                                               | `platform/modules/__tests__/registry.test.ts`                                      |
| 13  | Low  | a kind longer than a tick was never claimed                    | boot refuses it in a deployment, naming the kind (`checkJobsFitTick`)                                                                                                                     | `jobs-hostile.test.ts`                                                             |
| 14  | Low  | "run now" enqueued tenant by tenant inside the request         | one `insert … select` fan-out; a second audit record carries the outcome                                                                                                                  | `jobs-operator-routes.test.ts`, `job-store-contract.ts`                            |
| 15  | Low  | a shortened interval waited for the old slot                   | a slot is due at `least(next_run_at, last_run_at + interval now)` — in the claim of the slot itself, so however the change was approved                                                   | `job-store-contract.ts` (both stores)                                              |
| 16  | Low  | health routes ran every probe and reported per request         | one shared run per 3 s (single flight); problems reported on change of state                                                                                                              | `health-readiness.test.ts`, `health-route.test.ts`                                 |

### TASK-157 — A consumer could not add its own files to a module, or declare a module

| Field        | Detail                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------ |
| **ID**       | TASK-157                                                                                   |
| **Type**     | Consumer seam — module manifest (ADR-054 D6)                                               |
| **Severity** | Medium — consumers rewrote a platform file after every sync; the tests assumed six modules |
| **Phase**    | Phase 5                                                                                    |
| **Target**   | Phase 5, Sprint 7R R7                                                                      |
| **Status**   | Fixed in v6.0.0 (Sprint 7R R7)                                                             |
| **Logged**   | 2026-10-24                                                                                 |

**What:** `platform/modules/manifest.json` (the lint zones, the manifest tests, `test:core`, the
replay order) is the platform's and synced unchanged, so an app had no place for its own files that
belong to a module or for a module of its own. Playform appended its paths to the platform's file
after every sync (an overlay script); the platform's tests hard-coded the six module ids.

**Fix:** `platform/modules/app-manifest.json`, a consumer seam (sync-excluded; empty in the
platform), merged by `scripts/module-manifest.cjs` for every reader. An app adds paths to a
platform module or declares a module (definition, entry, dependencies, path lists, migrations).
The merge refuses a path claimed by two modules (or by a module and a composition root), a
platform module's `dependsOn`/`definition`/`entry`/`kitManifest` redefined, an unknown list, an
unknown dependency and a cycle, each message naming the file and what to change.
`node scripts/module-manifest.cjs --check` runs it on its own. The module manifest, lint and
migration tests derive the ids from the merge. Tests: `__tests__/module-app-manifest.test.ts`.
Documented in SETUP_AND_INTEGRATION §6, MIGRATION_v5_to_v6 §1b, ADR-054 §5.

### TASK-158 — Consumer migrations collided with the platform's numbers

| Field        | Detail                                                                 |
| ------------ | ---------------------------------------------------------------------- |
| **ID**       | TASK-158                                                               |
| **Type**     | Consumer seam — migration naming                                       |
| **Severity** | Medium — two migrations with one number apply in an order nobody chose |
| **Phase**    | Phase 5                                                                |
| **Target**   | Phase 5, Sprint 7R R7                                                  |
| **Status**   | Fixed in v6.0.0 (Sprint 7R R7)                                         |
| **Logged**   | 2026-10-24                                                             |

**What:** Playform's own 052 and 053 took numbers the platform then used (`052_audit_wave2.sql`).

**Fix:** the platform's migrations are `NNN_<name>.sql`, listed in
`supabase/platform-migrations.json`; an app's are `NNN<letter>_<app>_<name>.sql` (`052a_playform_…`),
sorting after the platform's NNN and before NNN+1 (an app module's name the module next). The
replay, `migration-parity.mjs`, the role catalog, the baseline and tracking checks accept the form;
`migrationNameProblems` (`__tests__/migration-naming.test.ts`, and the replay before it applies
anything) refuses an app migration with a bare number — naming the file to rename it to — unless
the app applied it before the convention and lists it (`migrationsBeforeTheConvention`), a
letter-form file without the app's prefix or sharing a letter, the letter form in the platform,
and an unlisted platform migration. Documented in SETUP_AND_INTEGRATION §6, MIGRATION_v5_to_v6,
CONTRIBUTING ("Writing a migration").

### TASK-159 — Tests and day arithmetic depended on the time zone

| Field        | Detail                                                                       |
| ------------ | ---------------------------------------------------------------------------- |
| **ID**       | TASK-159                                                                     |
| **Type**     | Correctness — time zones                                                     |
| **Severity** | Medium — a 30-day purge window was 30 days and an hour in a New York session |
| **Phase**    | Phase 5                                                                      |
| **Target**   | Phase 5, Sprint 7R R7                                                        |
| **Status**   | Fixed in v6.0.0 (Sprint 7R R7)                                               |
| **Logged**   | 2026-10-24                                                                   |

**What:** the operator-deletion test (`purge_after` within 30 days) failed with the database
session in America/New_York across the US DST change: `now() + interval '30 days'` is calendar
arithmetic in the session's time zone. The age tests compared with the host's local year and date.

**Fix:** every `platform/data` transaction sets `TimeZone` to UTC with its other settings
(`platform/data/tx.ts`); a DB test proves a New York session computes 30.0417 days raw and exactly
30 inside each kind of transaction. The age tests use a fixed instant (Date only faked in the
component test). The unit suite and DB suites pass under `TZ=America/New_York`, `Asia/Kolkata` and
`UTC`, the DB suites also with the session time zone set to New York per connection; CI runs the
suite again under `TZ=America/New_York` with New York database sessions (ci.yml).

The repeated runs also surfaced two failures that were not the zone's, both fixed: the route role
matrix gave its callers' `users` rows a `cognito_sub` other than their identity's, so a well-formed
appeal was answered 403 `account.not_found` (fast-check counterexample; the rows now carry the
identity's sub, with a regression case); and the birth-date property generated an invalid `Date`
about once in 2000, which threw in the generator (`fc.date({ noInvalidDate: true })`).

### TASK-160 — The workflow-hygiene check failed consumers without saying what to change

| Field        | Detail                                                                   |
| ------------ | ------------------------------------------------------------------------ |
| **ID**       | TASK-160                                                                 |
| **Type**     | Consumer experience — assurance checks                                   |
| **Severity** | Low — a synced check failed with a bare list of patterns and expressions |
| **Phase**    | Phase 5                                                                  |
| **Target**   | Phase 5, Sprint 7R R7                                                    |
| **Status**   | Fixed in v6.0.0 (Sprint 7R R7)                                           |
| **Logged**   | 2026-10-24                                                               |

**What:** `__tests__/workflow-hygiene.test.ts` (H-3, H-9) failed Playform's sync — excludes without
a `/`, step outputs interpolated inside `run:` — and the platform had no compliant sync to copy.

**Fix:** each failure names the file and line and what to write instead (`env:` and `"$NAME"`; a
leading `/` for a root file); `exclude_patterns` are checked too. `docs/templates/sync-from-foundation.yml`
and `docs/templates/sync-config.json` are the compliant form, held to the same checks in the platform.

### TASK-161 — Review 7 of the v6.0.0 candidate

| Field        | Detail                                          |
| ------------ | ----------------------------------------------- |
| **ID**       | TASK-161                                        |
| **Type**     | Security, privacy, scalability — release review |
| **Severity** | High (H1, H2) to Low                            |
| **Phase**    | Phase 5                                         |
| **Target**   | Phase 5, Sprint 7R close                        |
| **Status**   | Fixed in v6.0.0                                 |
| **Logged**   | 2026-10-24                                      |

**What:** an adversarial review of the unreleased Wave 2 and close-out changes (H1–H2, M1–M7,
L1–L6), and three items found adopting it in Playform (P1 the user-data coverage test failed every
consumer, P2 a flaky logger assertion, P3 one Cognito GetUser per request under a rate quota).

**Fix:** every finding, each with its regression test — the
[register](audits/2026-10-REGISTER.md#found-by-review-7-of-the-unreleased-wave-2-and-close-out-2026-10-24-fixed-in-v600)
lists them. New settings: `ERASURE_HASH_KEY` (required in production), `PROVENANCE_SIGNING_KEY_PREVIOUS`
(optional), the governed `auth.token_cache_seconds` and `auth.token_stale_grace_seconds` (052).

### TASK-162 — Review 8 of the v6.0.0 candidate

| Field        | Detail                                          |
| ------------ | ----------------------------------------------- |
| **ID**       | TASK-162                                        |
| **Type**     | Security, privacy, scalability — release review |
| **Severity** | High (H-A to H-D) to Low                        |
| **Phase**    | Phase 5                                         |
| **Target**   | Phase 5, Sprint 7R close                        |
| **Status**   | Fixed in v6.0.0                                 |
| **Logged**   | 2026-10-24                                      |

**What:** a second adversarial review of the candidate (H-A to H-D, M1–M5, L1–L6): a signed-out
token served from the token cache after a racing GetUser; partly readable classifier answers
clearing level 3; the address replacement at erasure corrupting and then deleting another
account's proposal; glob and case-variant paths in the app manifest; a new user's tenant missing
for the token cache's window; power settings outside dual control; the user-data coverage test
seeing only some columns and trusting claims; unjudged answers flooding the review queue; account
and MFA routes on the stale grace, and forged tokens draining the GetUser quota; and six low
findings.

**Fix:** every finding, each with its regression test — the
[register](audits/2026-10-REGISTER.md#found-by-review-8-of-the-v600-candidate-2026-10-24-fixed-in-v600)
lists them. New: `ERASURE_HASH_KEY_PREVIOUS` (optional, rotation); `CACHE_PROVIDER=memory` refused
in a deployment; the `yaml` dev dependency and `jose` transformed for Jest (a consumer's own
`package.json`, MIGRATION §5); 052 seeds more keys under dual control (first application) and
adds `jsonb_replace_text_value` and `user_deletions.email_hash_key`;
`supabase/optional/redact_orphan_addresses.sql` (operator step for accounts erased before
v6.0.0).

### TASK-163 — Review 9 of the v6.0.0 candidate

| Field        | Detail                                          |
| ------------ | ----------------------------------------------- |
| **ID**       | TASK-163                                        |
| **Type**     | Security, privacy, scalability — release review |
| **Severity** | High (H1, H2) to Low                            |
| **Phase**    | Phase 5                                         |
| **Target**   | Phase 5, Sprint 7R close                        |
| **Status**   | Fixed in v6.0.0                                 |
| **Logged**   | 2026-10-24                                      |

**What:** a third adversarial review of the candidate (H1–H2, M3–M6, L7–L11): an approved
command-bar action whose write is itself dual-controlled was held a second time and reported
applied; the erasure's JSON rewrite recursed, so one deep document failed another account's whole
erasure (and a large one took seconds a row); a classifier answer with `"reason": null` was
unjudged; a cold instance's one failed JWKS fetch refused every token for 30 s and bypassed the
stale grace; `CACHE_PROVIDER=memory` was refused while the container guide said to use it; the
erased-ban key ring read a review 7 row as the unkeyed form and "upgraded" it into a hash matching
nothing; an address as an object key survived erasure; workflow hygiene missed `with: *alias` and
mixed-case `uses:`; a made-up `kid` spent the refresh cooldown so a rotated one was a 401; app
manifest lookalike paths (`platform./auth`, zero-width, fullwidth slash, `%2F`) were accepted; an
outage answer after a revocation stood on the pre-revocation entry.

**Fix:** every finding, each with its regression test — the
[register](audits/2026-10-REGISTER.md#found-by-review-9-of-the-v600-candidate-2026-10-24-fixed-in-v600)
lists them. New: a held result everywhere (`held: true`, never success) and an approval
capability (`platform/action-pipeline/approval-capability.ts`) minted when an approval is used;
a non-recursive `jsonb_replace_text_value` that replaces keys too, `jsonb_may_mention_text`, and
`user_deletions.email_hash_scheme` (052); stored-JSON limits with `request.json_too_deep` /
`request.json_too_large`; `CACHE_PROVIDER=valkey` (`VALKEY_URL`, `VALKEY_CA_CERT`) on `ioredis`
5.11.1 (pinned); the CI test layer installs `redis-server` and sets `REQUIRE_VALKEY_TESTS=1`.

### TASK-164 — Review 10 of the v6.0.0 candidate

| Field        | Detail                                 |
| ------------ | -------------------------------------- |
| **ID**       | TASK-164                               |
| **Type**     | Security, reliability — release review |
| **Severity** | High (H1–H3) to Low                    |
| **Phase**    | Phase 5                                |
| **Target**   | Phase 5, Sprint 7R close               |
| **Status**   | Fixed in v6.0.0                        |
| **Logged**   | 2026-10-24                             |

**What:** a fourth adversarial review of the candidate (H1–H3, M4–M6, L7–L12): the command bar's
agent and capability actions were held twice — as an action and by their key — and the action's
approval carried a capability that let the write skip the key's hold, so an approver without
`config_manage_safety` cleared a safety-tier change, and a claim from any approval could write
`config.dual_control_keys`; an approval was consumed before its run, so a transient failure burned
it; a cold instance slept up to 30 s per request during a JWKS outage; stored-JSON limits were met
after the effect; `VALKEY_URL` query parameters overrode TLS; the erasure rewrite could change a
document's type or lose a colliding key; `jsonDepth` undercounted shared sub-objects; trajectories
grew without bound; wall-clock test assertions; a CHECK passed on NULL.

**Fix:** every finding, each with its regression test — the
[register](audits/2026-10-REGISTER.md#found-by-review-10-of-the-v600-candidate-2026-10-24-fixed-in-v600)
lists them. Simplified rather than patched: one hold per change — config-writing actions
(`COMMAND_BAR_CONFIG_WRITES`) are held only by their key, under the key's rules; the approval
capability is removed; a test-enforced invariant keeps the two lists apart. New: proposal status
`executing` with `claim` / `complete` / `release` and `atomically` (052: `proposals.last_run_error`),
`approvals.run_failed`, the run-recovery job step; `ApprovedRunFailedError`,
`ActionNotRecordedError`, `Tool.reportsFailure`, `Tool.atomic`, `ActivityStateStore.validate`,
`TrajectoryStore.assertRoomForStep`, `request.trajectory_full`.

### TASK-165 — Review 11 of the v6.0.0 candidate

| Field        | Detail                                 |
| ------------ | -------------------------------------- |
| **ID**       | TASK-165                               |
| **Type**     | Security, reliability — release review |
| **Severity** | High (H-1, H-2) to Low                 |
| **Phase**    | Phase 5                                |
| **Target**   | Phase 5, Sprint 7R close               |
| **Status**   | Fixed in v6.0.0                        |
| **Logged**   | 2026-10-24                             |

**What:** a fifth adversarial review of the candidate (H-1, H-2, M-1, M-2, L-1–L-6): a run slower
than its 10-minute lease applied twice — the recovery gave its approval back and its completion
was swallowed; the trajectory cap refused an app session's 1 001st move; an approved run that
failed after its work was released as "not applied"; suspending an agent waited for a second
safety admin; a shared large string defeated the JSON size pre-check; erasure's redaction wiped
whole documents; one oversized search row hid the rest; the in-memory byte count reset on a status
change; a DB test's job swept parallel suites' rows; and six smaller gaps (atomic audit records
rolled back, a retry in an aborted transaction, a constraint re-added on every application, a 10 s
JWKS join, two `VALKEY_URL` forms).

**Fix:** every finding, each with its regression test — the
[register](audits/2026-10-REGISTER.md#found-by-review-11-of-the-v600-candidate-2026-10-24-fixed-in-v600)
lists them. New: a claim's run token and the `indeterminate` proposal status with
`ProposalStore.resolveIndeterminate` and the decisions `mark_executed` / `reapprove`
(`approvals.indeterminate`); trajectory continuations (`segment`, `previous_trajectory_id`,
`step_offset`; `addStep(…, { rollover })`, `invokeTool({ rolloverTrajectory })`,
`readTrajectoryChain`); strictly power-reducing config changes applied by one admin
(`platform/admin/power-reduction.ts`) and the operator kill switch
(`POST /api/operator/tenants/[id]/agents/suspend`, `admin.kill_switch_failed`);
`setConfigWithHistory`'s compare-and-set; `withSeparateTenantTx`, `withSavepoint`,
`inTransaction` (platform/data); `raiseAlert` (platform/observability/alert.ts);
`platform/cache/valkey-url.ts`; runbook `docs/runbooks/approvals-and-agents.md`.

### TASK-166 — Review 12 of the v6.0.0 candidate

| Field        | Detail                                 |
| ------------ | -------------------------------------- |
| **ID**       | TASK-166                               |
| **Type**     | Security, reliability — release review |
| **Severity** | High (H1, H2) to Low                   |
| **Phase**    | Phase 5                                |
| **Target**   | Phase 5, Sprint 7R close               |
| **Status**   | Fixed in v6.0.0                        |
| **Logged**   | 2026-10-24                             |

**What:** a sixth adversarial review of the candidate (H1, H2, M1, M2, L1–L7): removing a
capability mapping was taken for a power reduction and applied by one admin, though a consumer
reading an absent capability as needing no features is widened by it; an older held change to the
agent registry, approved after the kill switch, applied its whole value and re-activated every
agent; a rollover appended first-fit, so a later small step went back into an earlier segment;
session chains grew without bound and `loadSession` read every segment; an audited act inside a
transaction that rolled back left only "attempted"; a `toJSON` value passed the size pre-check as
one byte; the kill switch audited before its compare-and-set; one-admin reductions were audited
best-effort after the write; a tenant's compare-and-set was not serialised against a platform
default write; a cyclic chain could hang the recovery; and the kill switch reached other instances
only after the 60-second config cache, did not exist for a single-tenant deployment, and
`mark_executed` needed no independence.

**Fix:** every finding, each with its regression test — the
[register](audits/2026-10-REGISTER.md#found-by-review-12-of-the-v600-candidate-2026-10-24-fixed-in-v600)
lists them. New: `platform/agents/capability-features.ts` (`evaluateCapabilityFeatures`, the
consumer contract: an absent capability is not allowed) and its kit
`__tests__/contract/capability-features-contract.ts`; a held change's recorded previous value
(`heldPrevious`) with `approvals.stale` and `platform/admin/stale-change.ts`;
`platform/admin/hold-withdrawal.ts` (`withdrawSupersededHolds`) and
`withdrawPendingApprovalsForKey`; `TrajectoryStore.chainTail` / `chainSegment`,
`TrajectoryQuery.withoutSteps`, `trajectoryChainPages`, `agent_trajectories.chain_root_id` and the
chain guard trigger (052), `agent.trajectory_max_segments` with `request.trajectory_chain_full`;
`onRollback` (platform/data) and `platform/kernel/audit-correlation.ts`; `audited(…, { recordSuccess })`;
`clearTenantConfig`'s compare-and-set; `publishConfigInvalidation`; `POST /api/admin/agents/suspend`.

### TASK-167 — Review 13 of the v6.0.0 candidate

| Field        | Detail                                 |
| ------------ | -------------------------------------- |
| **ID**       | TASK-167                               |
| **Type**     | Security, reliability — release review |
| **Severity** | Medium (M1, M2, P) to Low              |
| **Phase**    | Phase 5                                |
| **Target**   | Phase 5, Sprint 7R close               |
| **Status**   | Fixed in v6.0.0                        |
| **Logged**   | 2026-10-24                             |

**What:** a seventh adversarial review of the candidate (M1, M2, P, L1–L7 and a test gap; no
Critical or High): an approved reset was compare-and-set on the tenant's value only, not on the
platform default it resets to; every read of a stamped key (and every permission check) waited on
the shared cache with no bound of its own; the capability contract kit did not fit a consumer's
decision, and its "malformed allows nothing" contradicted consumers' built-in fallback map; a
superseded-hold withdrawal ignored scope; the runbook's recovery for an unpublished invalidation
did nothing when every agent was already suspended; the chain guard did not serialise a
continuation's insert with an update of its predecessor; a database that had run an earlier 052
never got `agent.trajectory_max_segments` under dual control; `rolled_back` could be recorded for a
commit whose outcome was unknown; ABA on a compare-and-set was undocumented; the kill switch's
withdrawal was unbounded; and the kill switch's H2 scenarios had no Postgres test.

**Fix:** every finding, each with its regression test — the
[register](audits/2026-10-REGISTER.md#found-by-review-13-of-the-v600-candidate-2026-10-24-fixed-in-v600)
lists them. New: `clearTenantConfig({ expectInherited })` and `HeldPrevious.inherited`;
`platform/cache/stamp-reader.ts` (`readStamp`, the stamp breaker, alert `cache.stamp_breaker_open`);
the consumer-shaped capability kit (`consumerEvaluator`) and
`platform/agents/governed-agent-config.ts` (`readTrustedAgents`, `readCapabilityFeatures`,
`evaluateGovernedCapability`); `holdScope` and scoped `withdrawSupersededHolds` /
`withdrawPendingApprovalsForKey`; the kill switch's `republished`; the chain guard's predecessor
lock; `config_dual_control_seeded` (052); `TxEndOutcome` / `onCommit` (platform/data), `audited`'s
`indeterminate` outcome and `{ external: true }` (`AuditedExternalActError`); `ProposalQuery`
filters and `ProposalStore.supersede`; alert `approvals.withdrawal_incomplete`.

### TASK-168 — Two defects found adopting v6.0.0 in Playform

| Field        | Detail                                   |
| ------------ | ---------------------------------------- |
| **ID**       | TASK-168                                 |
| **Type**     | Reliability, consumer correctness        |
| **Severity** | Medium (provisioning race) to Low (test) |
| **Phase**    | Phase 5                                  |
| **Target**   | Phase 5, Sprint 7R close                 |
| **Status**   | Fixed in v6.0.0                          |
| **Logged**   | 2026-10-24                               |

**What:** found while Playform adopted the candidate, each carried there as a sync-excluded copy.
(1) `__tests__/migration-naming.test.ts`'s numbering-range case checked this repository's own
migration files against a hand-made manifest with no `migrationsBeforeTheConvention`, so it failed
in any consumer with grandfathered migrations (Playform's `007_playform_…`, 031–036). (2)
`ensureUserProvisioned`'s account insert said `on conflict (id) do nothing`, which does not
arbitrate the `cognito_sub` key (`players_cognito_sub_key`): of two or three first requests for one
user at once, one could pass the id check before the winner's row reached the index, then fail on
the subject key with a unique violation — refused as `account.not_provisioned` (about 2 in 900
concurrent attempts).

**Fix:** (1) the test reads the merged manifest (`scripts/module-manifest.cjs`, the app's
grandfather list included) and checks the repository's migrations three ways — the platform's
against `supabase/platform-migrations.json`, the app's own against the convention and the
001-to-latest range, the grandfathered ones for existence and replay order only; constructed cases
use the platform's list, or this repository's files with its own manifest; a fixture app repository
with grandfathered migrations is its self-test. Consumers inherit it unchanged. (2) the insert says
`on conflict do nothing` (no target: every unique key of the row arbitrates — Postgres waits for a
concurrent writer of either key and inserts nothing, never a unique violation), then, in the same
tenant transaction, reads which row holds the identity: this id → `existing`; this subject under
another id → `failed`; nothing visible (held in another tenant) → `failed` (it answered `existing`
before, which no row of the tenant backed; the guard refused either way). No retry is needed.
`__tests__/db/provisioning-race.db.test.ts` injects the interleaving with a second connection
holding the conflicting row (waiting on `pg_blocking_pids`), and stresses 150 rounds of three
concurrent first requests.

### TASK-169 — Review 14 of the v6.0.0 candidate (final verification)

| Field        | Detail                                 |
| ------------ | -------------------------------------- |
| **ID**       | TASK-169                               |
| **Type**     | Security, reliability — release review |
| **Severity** | Medium (M-1, M-2) to Low               |
| **Phase**    | Phase 5                                |
| **Target**   | Phase 5, Sprint 7R close               |
| **Status**   | Fixed in v6.0.0                        |
| **Logged**   | 2026-10-24                             |

**What:** the final verification review of the candidate (M-1, M-2, L-1–L-6; no Critical or High):
DB tests ran under jest's default 5 s bound in parallel workers on one shared database, with
route-role-matrix properties of 200 round trips each; event-loop lag on a CPU-saturated instance
opened the stamp breaker against a healthy cache, and a flapping cache raised an alert per opening;
the agent-registry and capability-mapping panels showed a 503 as an empty list and the routes
answered `[]` for a malformed stored value; a commit lost with its connection dropped the
invalidation of a change that may stand, and the non-joined config and role write paths called it
"failed"; a withdrawal's `skip locked` left an approval held by a concurrent reviewer pending,
unreported; a platform-scope withdrawal reached only the current tenant; the capability contract
kit used fixed capability names; the audited-external guard was a per-file hand count, and the
audit note on `auditedResponse` was untrue of the purge route.

**Fix:** every finding, each with its regression test — the
[register](audits/2026-10-REGISTER.md#found-by-review-14-of-the-v600-candidate-2026-10-24-fixed-in-v600)
lists them. New: a 30 s bound for every DB test (`jest.setup.ts` by path, `DB_TEST_TIMEOUT_MS` in
`__tests__/helpers/db.ts`) and `fuzzParamsPart`; the stamp reader's yield, per-read lag measure,
`STAMP_LAG_BOUND_MS`, metric and alert `cache.stamp_read_lag`, rate-limited alerts with a count
(`STAMP_ALERT_INTERVAL_MS`), `stampReadsLostToLag`, `instanceLoopDelay`;
`platform/observability/metric-event.ts`; `PanelUnavailable` / `PANEL_UNAVAILABLE`,
`isWellFormedTrustedAgents`, `isWellFormedCapabilityMap`; `onCommit(hook, { idempotent })`,
`CommitOutcomeUnknownError`, `isCommitOutcomeUnknown`, `indeterminate` on `WriteResult` and the
command bar's `ActionResult`; `withdrawPendingApprovalsForKey`'s `remaining`, the cross-tenant
platform-scope withdrawal (`SupersededWithdrawal.tenants`, `remaining`); the kit's `names`
(`PF_CAPABILITY_NAMES`, `contractNames`, `capabilityContractCases`, `capabilityContractViolations`);
`__tests__/helpers/audited-external-scan.ts`, the JSDoc tag `@external`, and `{ external }` on
`auditedResponse`, `runAudited` and the other wrappers.

### TASK-170 — An agent workflow could not be retried by approving its step again

| Field        | Detail                            |
| ------------ | --------------------------------- |
| **ID**       | TASK-170                          |
| **Type**     | Reliability, consumer correctness |
| **Severity** | Medium                            |
| **Phase**    | Phase 5                           |
| **Target**   | v6.0.0 (RC)                       |
| **Status**   | Fixed on develop (v6.0.0 RC)      |
| **Logged**   | 2026-10-25                        |

**What:** found adopting v6.0.0 in Playform. An approved step whose run fails before taking effect
keeps its approval (`ApprovedRunFailedError`, released — review 10 H2: "approve it again to
retry"), but the workflow loop marked its trajectory `failed`, and a failed trajectory is never
continued. For an agent workflow the kept approval could only lapse or be withdrawn; Playform's
approval route reopened the trajectory (`failed` → `running`) itself.

**Fix:** the loop leaves such a trajectory `awaiting_retry` (migration 053, a new
`trajectory_status` value; retention keeps it) — or `indeterminate` when the approval could not be
given back (the run's outcome unknown). A continuation by the workflow's own agent runs nothing in
either: it answers `held` with `awaiting: "retry"` or `"outcome"` (`HeldAction.awaiting`,
`lastRunError`), and settles a decision made elsewhere — a withdrawn or rejected step, or one
marked executed (its output never recorded), ends the workflow `failed` with the decision recorded
(`endHeldTrajectory`) and is refused as over. `resumeApprovedAction` on the kept approval is
"approve again": it resumes the trajectory at that step; concurrent ones run it once (the run's
claim), the others are refused. `withdrawHeldAction` withdraws a kept approval and ends its
workflow; `resolveUndecidedHeldAction` decides an undecided run (`approved` → `awaiting_retry`,
then resumed; `executed` → ended). Tests: `platform/agents/__tests__/held-action-retry.test.ts`
(memory), `__tests__/db/held-action-retry.db.test.ts` (Postgres: concurrent re-approvals, the job's
recovery, retention); the replay checks 053 and its second application.

### TASK-171 — The token-verification tests could not run against an app's own provider

| Field        | Detail                               |
| ------------ | ------------------------------------ |
| **ID**       | TASK-171                             |
| **Type**     | Test assurance, consumer correctness |
| **Severity** | Low                                  |
| **Phase**    | Phase 5                              |
| **Target**   | v6.0.0 (RC)                          |
| **Status**   | Fixed on develop (v6.0.0 RC)         |
| **Logged**   | 2026-10-25                           |

**What:** `__tests__/jwt-verification.test.ts` and `__tests__/rv9-jwks-outage.test.ts` (reviews 8
M5, 9 M4/L9/L11) drove the platform's `CognitoAuthProvider` class, so an app with its own
AuthProvider kept sync-excluded copies with its provider spliced in (Playform's are on the AWS SDK).

**Fix:** their cases are a provider-level kit, `__tests__/contract/auth-token-verification-contract.ts`
— `runAuthTokenVerificationContract(name, { makeProvider, makeKeyStore?, verifySignature?, cleanup? })`:
the provider is built over the kit's signing-key store (a JWKS fake it controls), `TokenVerifier`
and user lookup (`user` / `unavailable` / `invalid`). Every case of the two files is in it, the
revocation-during-lookup ones (L11) now through the provider, plus a refused lookup.
`__tests__/auth-token-verification-conformance.test.ts` runs it against the platform's provider and
keeps the pool-helper cases (JWKS address, one store per pool, pinned keys); the two files are
removed. A provider that skips the signature check fails 23 of the kit's cases.

### TASK-172 — The admin console did not offer the kill switch its own guide asks for

| Field        | Detail                       |
| ------------ | ---------------------------- |
| **ID**       | TASK-172                     |
| **Type**     | Operability, security UX     |
| **Severity** | Low                          |
| **Phase**    | Phase 5                      |
| **Target**   | v6.0.0 (RC)                  |
| **Status**   | Fixed on develop (v6.0.0 RC) |
| **Logged**   | 2026-10-25                   |

**What:** `POST /api/admin/agents/suspend` (review 12 L7) is the kill switch for a single-tenant
deployment's administrators, and the migration guide asks admin UIs to offer it to
`config_manage_safety` holders — the platform's console did not (Playform built
`/agent/kill-switch`); the operators' console had no per-tenant one either.

**Fix:** `components/admin/AgentKillSwitchPanel.tsx`: `AgentKillSwitch` (a route, an optional
tenant) — a required reason, an explicit confirmation step (inline; never `window.prompt` or
`window.confirm`), `apiFetch`, and the answer: agents suspended, holds withdrawn, `republished`
(or not), 503 as unavailable. The admin console's **Agent kill switch** section is shown to
`config_manage_safety` holders only; the operators' Tenants console opens it per tenant
(`platform_operate`). Every word from `screens.kill_switch`. The operators' route also answers
`withdrawn` (and bounds the reason at 500 characters, as the admin route). Tests:
`__tests__/agent-kill-switch-panel.test.tsx` (jsdom, axe WCAG 2.2 AA), the operators' route in
`__tests__/rv12-killswitch.test.ts`.

### TASK-173 — A workflow whose run was lost answered its continuation with a 500

| Field        | Detail                            |
| ------------ | --------------------------------- |
| **ID**       | TASK-173                          |
| **Type**     | Reliability, consumer correctness |
| **Severity** | Medium                            |
| **Phase**    | Phase 5                           |
| **Target**   | v6.0.0 (RC)                       |
| **Status**   | Fixed on develop (v6.0.0 RC)      |
| **Logged**   | 2026-10-25                        |

**What:** found adopting `908d64a` in Playform. When an approved workflow step's run never ended
(an instance lost mid-run), `config.expire-approvals` (`recoverStaleRuns`) moved its approval to
`indeterminate` — or, for an atomic run, back to `approved` — but left its trajectory `running`.
The agent's own continuation then re-proposed the step, and the proposal store's one-live rule
refused it with a plain error (`operation … already has an open, approved or used proposal`): a 500
from Playform's `process-content`, not `held` with `awaiting: "outcome"`. Nothing ran twice.

**Fix:** the recovery moves the run's trajectory to the matching waiting state in the same
statement — `indeterminate` (from `running`, `paused` or `awaiting_retry`) for an undecided run,
`awaiting_retry` (from `running` or `paused`) for an atomic run approved again; a finished
trajectory is left as it is. Its audit record (`approval_run_recovered`) carries `trajectoryId`,
`trajectoryFrom`, `trajectoryStatus` (null when none moved). `RECOVERED_TRAJECTORY` holds the
mapping; the in-memory recovery takes the trajectory store (`recoverStaleRuns(before,
trajectories)`, `InMemoryTrajectoryStore.moveStatus`). Defence in depth, for any other path to the
state: every continuation (`runGoal`, `advanceGoal`) reads its next step's proposal whatever the
trajectory's status — undecided answers `held`/`awaiting: "outcome"`, approved after a failed run
(`lastRunError`) `held`/`awaiting: "retry"`, the trajectory moved to match; a fresh approval still
runs. A hold refused for such a proposal answers the same, and `proposeOnce` refuses an
`indeterminate` operation as decided (`approval-used`) instead of reaching the store. Tests:
`platform/agents/__tests__/held-action-retry.test.ts` (memory) and
`__tests__/db/held-action-retry.db.test.ts` (Postgres, the job's statement and its audit): lost
mid-run → recovery → held awaiting outcome; `resolveUndecidedHeldAction` then resumed once; atomic
→ `awaiting_retry`; a trajectory left `running` still answered held. No migration.

### TASK-174 — Accounts could not be re-linked to their identity in a new user pool

| Field        | Detail                                                |
| ------------ | ----------------------------------------------------- |
| **ID**       | TASK-174                                              |
| **Type**     | Identity, operations, data integrity                  |
| **Severity** | High                                                  |
| **Phase**    | Phase 5                                               |
| **Target**   | v6.0.0 (RC)                                           |
| **Status**   | Fixed on develop (v6.0.0 RC); reviews 15 and 16 fixed |
| **Logged**   | 2026-10-25                                            |

**What:** found deploying Playform v0.9.0. Playform's dev/staging Cognito pool was replaced (the
old one was deleted with its AWS account). Every `users` row carried the old pool's subject in
`users.cognito_sub` — and as its `id` (`id = cognito_sub = sub`). Lookups are by `cognito_sub`,
provisioning by `id = sub` with a follow-up read that answered `failed` for a subject held by
another account, and the address is not unique: a sign-in with the new pool's subject was given a
second, ordinary account; the staff accounts (super_admin, admin) were unreachable, and nobody
could sign in as `super_admin` to repair it. The owner's rule forbids fixing it by hand in the
database; production will hit the same when it moves to its own pool.

**Fix (ADR-012 amendment):** an account is bound to its identity by `users.cognito_sub` and keeps
its id. `platform/auth/account-identity.ts` (`resolveAccount`, `bindingOf`, `auditableAccountId`)
is the one rule; `requireActor`'s `actor.id` is the bound account (a subject whose id is another
identity's account is refused, `account.identity_conflict` since review 15; an unreadable binding 503); provisioning
(`provisionAccount`) recognises an account by its subject before inserting and answers its id; the
account guard refuses a re-linked account's subject passed as its id (fail closed); the guest
route's standing check and the sign-in, sign-out and MFA audit records resolve the account. The
erasure record keeps the subject (`user_deletions.cognito_sub`, migration 054), so a re-linked
account is never provisioned again once purged. The operator command
`node scripts/relink-identity.mjs` (`platform/auth/identity-relink.ts`,
`identity-relink-command.ts`, `identity-directory.ts`; `scripts/ts-paths-hook.mjs` runs the
platform's TypeScript in Node with no build step) re-links an address — or every staff account, or
every account — after checking the pool (one user, enabled, confirmed or federated, verified) and
the database (one live account; not another tenant's identity; not an erased one; a new subject
already held only by a stray first-sign-in account that is safe to merge, and merged only when
named); the subject changes with its audit record (`identity_relinked`: operator, OS user, host,
reason, subjects as hashes) in one owner transaction; a dry run is read-only; both subjects'
caches are voided after the commit. Runbook: `docs/TENANCY_OPERATIONS.md` §6. Tests:
`__tests__/identity-relink.test.ts` (the binding rule, the pool client against a local stand-in,
the pool's answer, arguments, output, exit codes), `__tests__/relink-identity-script.test.ts` (the
script as an operator starts it), `platform/auth/__tests__/actor-account.test.ts`,
`__tests__/db/identity-relink.db.test.ts` (Postgres: dry run changes nothing; applied; afterwards
the new subject reaches the staff account through permissions, the admin guard, the actor and
account guards, provisioning — no second row —, the identity's tenant, the export route and
erasure; unverified, two pool users, two accounts, a stray merged or refused, hostile case and
whitespace, SQL-ish and wildcard characters, another tenant's identity, a subject whose id is
another identity's account; bulk), `__tests__/db/provisioning-race.db.test.ts` (a concurrent
re-link: `existing` under its id), migration 054 in the replay (applied twice, backfill).

**Review 15 (hostile review of the re-link; every finding fixed, proofs kept as regression tests in
`__tests__/db/identity-relink-hostile.db.test.ts`):**

| Finding | What was wrong                                                                                                                                                                     | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Test                                                                        |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| H1      | The target was chosen by `users.email` alone: a later run moved an already-linked account to whoever now holds its old address in the pool (address changed there, mailbox reused) | A target must be unbound in the current pool: refused `account.bound_in_pool` when ListUsers finds its current subject (`IdentityDirectory.findBySub`), `account.relinked_in_pool` when an `identity_relinked` record names it and this pool; `--created-before <pool move time>` is required and an account made at or after it is never a target; replacing a current-pool identity is refused with guidance (account recovery)                                                                                                                                                                                                                                                                                                | hostile H1 ×5                                                               |
| M1      | Every live row with the address counted: an unconfirmed sign-up (or a Kelvin sign U+212A, which `toLowerCase()` makes "k") blocked a re-link as `account.many`                     | Only rows made before the move count; one verified row is the target whatever unverified rows exist; an unverified target only by id (`--unverified-account`, bulk `--accept-unverified`, `account.unverified` offers it); non-ASCII addresses refused (`address.unsupported`); provisioning stores an address with only ASCII letters lower-cased (`storedEmail`), a lookalike stays itself; the ban carry-over still matches it folded                                                                                                                                                                                                                                                                                         | hostile M1 ×6; unit normalisation property                                  |
| M2      | A post-commit invalidation error made the command say "Nothing was changed" (exit 3): `revokeTokenVerification`'s `getCache()` default parameter threw outside its try             | `getCache()` resolved inside the try (`revokeTokenVerification`, `forgetTokenVerification`); each subject's invalidation caught and reported (`notInvalidated`); the command prints "Applied" with a warning naming what was not voided and the bound (≤ 60 s), exit 5                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `token-revocation-cache-misconfigured.test.ts`; hostile M2 ×2; command unit |
| M3      | Bulk across tenants planned two accounts onto one subject; the run died on a unique violation                                                                                      | Plans binding one subject twice are both refused `subject.contested` (dry run too); the rest proceed only with `--skip-ambiguous`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | hostile M3                                                                  |
| M4      | `--all` read users unindexed per address in one long transaction                                                                                                                   | Migration 055 (`users_tenant_email_lookup_idx` on `(tenant_id, lower(btrim(email)))`); set-based lookups (one statement per chunk; tenants expanded so every probe is an index scan); chunks of 500 addresses, each one owner transaction planned again under lock; the report and output say which chunks applied; a rerun completes (applied ones read `linked`); exit 6 for partly applied. Measured at 100,000 accounts (local Postgres 16, fake pool): dry run 6.7 s, apply 20.2 s (200 chunks), rerun 6.2 s; a chunk's lookup 3 ms (index scan) vs 85–141 ms (sequential scan) without 055, where the 100,000 run hit the statement timeout; the index builds in 0.15 s at 100,000 rows (SHARE lock: writes to users wait) | hostile M4 ×4; replay step 055                                              |
| L1      | Sentinel revoked token verifications by account id                                                                                                                                 | `returning cognito_sub`, revoked by the subject (no other revoke/invalidate call is keyed by an account id)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `moderation-account-status.db.test.ts` L1                                   |
| L2      | The command did not apply the contract's database checks                                                                                                                           | `databaseConnectionViolations` (environment contract) used by the contract and `missingSettings`: no TLS option in the URL, `DATABASE_SSL=disable` only for a local database, the CA with verify-full, shapes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | unit ×10                                                                    |
| L3      | On conflict, a sign-in event was recorded under the account the old subject no longer names                                                                                        | `auditableAccountId` records no actor on a conflict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | hostile L3; unit                                                            |
| L4      | Conflict answered 503 `account.not_provisioned` (retryable)                                                                                                                        | `403 account.identity_conflict` (catalog, API_ERRORS)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `actor-account.test.ts`; `identity-relink.db.test.ts`                       |
| L5      | `--apply --skip-ambiguous` with changes exited like nothing changed                                                                                                                | Exit 4 (applied, some skipped) distinct from 1 (nothing changed); codes in `EXIT`, the usage, the runbook                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | command unit                                                                |
| L6      | Bulk asked the pool only in lower case                                                                                                                                             | Each address asked in lower case and as stored                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | hostile L6                                                                  |
| L7      | A stray's data was counted without a lock on tables lacking a foreign key to users; GovCloud pool ids refused                                                                      | Counted again after the delete in the same transaction (a gain undoes that merge, under a savepoint); `COGNITO_POOL_ID` from the contract accepts `us-gov-*`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | hostile L7; unit                                                            |

**Review 16 (every finding fixed; the reviewer's proofs kept, asserting the fixed behaviour, in
`__tests__/db/identity-relink-r16.db.test.ts`, `__tests__/identity-relink.test.ts` and
`platform/agents/__tests__/held-action-resume-budget-race.test.ts`):**

| Finding               | What was wrong                                                                                                                                                                           | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Test                                                                                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D4f (High)            | A pre-move account whose own address was never verified went to whoever verifies that address in the new pool, with only a printed note (bulk too)                                       | Re-linked only on the operator's confirmation for that account: `--confirm-unverified <id>` (repeatable; `--unverified-account <id>` is also its confirmation), recorded `unverifiedConfirmed`; otherwise `account.needs_confirmation`, and the dry run lists each account with its flag; an unused confirmation is reported. The old pool's own status is out of reach once it is deleted (runbook §6.6)                                                                                                                | r16 D4f ×2; hostile TASK-176 ×2 (updated); command unit                                                                                                                         |
| M (federated subject) | The re-link wrote the pool's `sub`; the platform's verifier names a request by the Cognito username (`Google_…` for a federated user) — a re-linked Google staff account was unreachable | `--subject username\|sub` (required, never guessed): `DirectoryUser.subject` is the verifier's subject — `username` for the platform's provider, `sub` for one that binds the token's sub (Playform's) — used to bind, to ask the pool whether an account is bound there (ListUsers `username = "…"` / `sub = "…"`, exact), to detect contested subjects and strays; recorded `subjectAttribute`. Fakes give every user a username ≠ sub. _Superseded by TASK-177: the subject is always the `sub`; the flag is removed_ | r16 federated ×5 (requireActor, permissions, requireAdmin, account guard; sub mode; bound-in-pool by username; contested); directory unit (both filters); cognito-provider unit |
| M2                    | `invalidatePermissions` / `revokeTokenVerification` swallowed failures, so `notInvalidated` never filled and the report said "on every instance"                                         | Strict variants report the outcome: `publishInvalidation` (each stamp), `publishTokenRevocation`; the command's invalidation throws per subject when either was not published; exit 5 names each subject and why                                                                                                                                                                                                                                                                                                         | r16 M2 ×2 (a cache that fails the publish, then answers the probe; one subject of two); `token-revocation-cache-misconfigured.test.ts`                                          |
| L1                    | `--unverified-account X` was ignored when another pre-move account Y was verified                                                                                                        | Refused `account.unverified` naming Y                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | r16 L1                                                                                                                                                                          |
| L2                    | `--skip-ambiguous` applied an address the dry run refused, once the data changed                                                                                                         | An address not `relink` in the preview stays refused in the locked plan (its preview reason; `account.changed` for one that was absent or linked)                                                                                                                                                                                                                                                                                                                                                                        | r16 L2                                                                                                                                                                          |
| L3                    | The bound-in-pool check was skipped for a legacy row (no `cognito_sub`)                                                                                                                  | Asked by `cognito_sub ?? id`; a legacy row also holds a subject equal to its id; its old subject (its id) is voided                                                                                                                                                                                                                                                                                                                                                                                                      | r16 L3 ×2                                                                                                                                                                       |
| L4                    | An unconfirmed or unverified squatter in the pool made the address `pool.many`                                                                                                           | When exactly one enabled, confirmed, verified (trusted) user has the address, the others are ignored; two that prove it, or the one disabled, still `pool.many`                                                                                                                                                                                                                                                                                                                                                          | unit (reviewer's proof + 3 cases)                                                                                                                                               |
| L5                    | A dry run with `--skip-ambiguous` and a refusal exited 0                                                                                                                                 | Exit 1 for any dry run that refused anything (the safer reading); table, usage and runbook say so                                                                                                                                                                                                                                                                                                                                                                                                                        | r16 L5; command unit                                                                                                                                                            |
| L6                    | A custom `TrajectoryStore` ignoring `{ from }` failed open                                                                                                                               | `TrajectoryStore.supportsStatusCas` (MUST be `true`): `resumeApprovedAction` refuses a store without it (`TrajectoryStoreCasError`); the conformance kit tests the declaration and the compare-and-set (incl. concurrent writers)                                                                                                                                                                                                                                                                                        | kit (memory + Postgres); `held-action-resume-budget-race.test.ts`                                                                                                               |
| L7                    | A connection lost at a chunk's COMMIT printed "Nothing was changed"                                                                                                                      | Classified `indeterminate` (`isCommitOutcomeUnknown`): the chunk is reported "may have committed", its subjects voided, the run stops; exit 7 — run the verify command                                                                                                                                                                                                                                                                                                                                                   | r16 L7 (a commit killed at COMMIT by a deferred trigger); command unit                                                                                                          |
| L8                    | The `pool.unverified` hint told operators to map any provider's `email_verified`; the TASK-176 sync believed any provider                                                                | Hint restricted to Google / Sign in with Apple, warns against Microsoft Entra ID (nOAuth); `AUTH_TRUSTED_EMAIL_IDPS` (default `Google`) governs the re-link, provisioning and the sync; `TokenPayload.identityProviders` (the platform's provider fills it from `identities`) — absent is never trusted                                                                                                                                                                                                                  | unit (rule, allow-list); `email-verification.db.test.ts` (Google marks; Entra, mixed, unsaid never; listed explicitly); identity-providers-claim unit                           |
| L9                    | The hostile M3 test ran `--all-staff --apply` across the shared database                                                                                                                 | Scoped to its own tenants (`RelinkDeps.onlyTenants`, a test seam)                                                                                                                                                                                                                                                                                                                                                                                                                                                        | hostile M3                                                                                                                                                                      |

### TASK-175 — Concurrent re-approvals of a workflow step could answer a loser with success

| Field        | Detail                            |
| ------------ | --------------------------------- |
| **ID**       | TASK-175                          |
| **Type**     | Concurrency, contract correctness |
| **Severity** | Medium                            |
| **Phase**    | Phase 5                           |
| **Target**   | v6.0.0 (RC)                       |
| **Status**   | Fixed on develop (v6.0.0 RC)      |
| **Logged**   | 2026-10-25                        |

**What:** `__tests__/db/held-action-retry.db.test.ts` "concurrent re-approvals resume it once"
failed intermittently (once under `test:coverage`). `resumeApprovedAction` checked the proposal
was `approved` and its step next, then handed off to the loop, which read the trajectory again. A
call that passed the checks before another call's run and read the trajectory after it found the
step committed and answered `completed` — success for work it did not do — instead of
`HeldActionNotApprovedError`; with a step after it, it went on to run that step. The approved step
itself ran once (the pipeline's claim, approved -> executing, is a compare-and-set). The same
read-then-write shape moved trajectory statuses: `withdrawHeldAction` / `endHeldTrajectory` (open ->
`failed`), `resolveUndecidedHeldAction` (`indeterminate` -> `awaiting_retry`), a continuation's
move to a waiting status (TASK-173) and a resume's move back to `running` could each overwrite a
status a concurrent run had just recorded (a completed workflow made `awaiting_retry` or `failed`).

**Fix:** a resume is bound to the approval and step it checked (`ResumeBinding`): the loop refuses
it (`HeldActionNotApprovedError`) unless that step is still next and still approved under that
proposal when it runs, and a pipeline refusal of its approval is a refusal too — so a resume
succeeds only by its own claim of the approval; the claim's compare-and-set decides, never an
earlier read. `TrajectoryStore.updateStatus` takes `{ from }`, a compare-and-set (Postgres: under
the row lock; memory: no await between check and write), used by every one of those status moves;
one that finds the status moved leaves it (a continuation that saw a decision since acted on is
refused). The approval-decision route needed no change (its decisions are the store's
compare-and-sets; a lost claim is `approvals.decision_conflict`); `resumeFailure` maps
`HeldActionNotApprovedError` to `in_use` for an authority that resumes a workflow. Tests, with the
interleavings forced by hooks (`__tests__/helpers/interleave.ts`), memory
(`platform/agents/__tests__/held-action-retry.test.ts`) and Postgres
(`__tests__/db/held-action-retry.db.test.ts`): checked then overtaken — refused, with a step after
it the next step not run; both at the claim — one runs, one refused; a withdrawal, a re-approval
and a continuation overtaken by a run leave its status; the status compare-and-set under
concurrent writers; the concurrent test 50 times in a loop. No migration.

**Review 16:** the budget check (and an approval mismatch) wrote `paused` / `failed`
unconditionally before the claim, so a resume that passed its checks and then lost to a
concurrent resume overwrote the winner's `completed`. Every status a resume's own path writes —
budget refusal, mismatch, hold, failure, completion — is now a compare-and-set from the open
statuses (`settle`); one that does not apply refuses the call (`HeldActionNotApprovedError`; an
approved run's own failure still reports its `ApprovedRunFailedError`). A store must declare
`supportsStatusCas: true` or no held action is resumed on it (`TrajectoryStoreCasError`). Tests:
`platform/agents/__tests__/held-action-resume-budget-race.test.ts` (the reviewer's interleaving;
a budget pause of an open workflow; a mismatch over a settled workflow; a store without the
declaration), the conformance kit's compare-and-set case.

### TASK-176 — `users.email_verified` was never updated after the person confirmed their address

| Field        | Detail                                 |
| ------------ | -------------------------------------- |
| **ID**       | TASK-176                               |
| **Type**     | Data correctness, identity             |
| **Severity** | Medium                                 |
| **Phase**    | Phase 5                                |
| **Target**   | v6.0.0 (RC)                            |
| **Status**   | Fixed on develop (v6.0.0 RC)           |
| **Logged**   | 2026-10-25 (review 15 fixes, TASK-174) |

**What:** an account made through `/api/auth/sign-up` is provisioned before the person confirms
the address, so it is stored `users.email_verified = false`; nothing updated it after they
confirmed with Cognito and signed in. Most real accounts said "unverified": the re-link command
(which since review 15 trusts only verified accounts) needed `--unverified-account` for nearly
every legitimate staff account, and `makeTenantAdmin` refused a confirmed first administrator.

**Fix:** `requireActor` reads the bound account's `email` / `email_verified` in the statement
that resolves its binding (`resolveAccountRecord`) and hands them, with the provider's answer for
the token, to `syncEmailVerification` (`platform/auth/email-verification.ts`): false → true when
the claim's `emailVerified` is exactly `true` for the same stored address — one conditional
update with its `profile_updated` (`field: email_verified`) record in one transaction; nothing
otherwise, never a downgrade, never a write per request, a failure logged and retried next
request. `users.email` is never rewritten (ban carry-over and re-link matching depend on it;
superseded by TASK-185: a missing or changed address is now recorded from the same trusted claim).
The re-link rule: the current pool's verified user is the evidence for the address's one
pre-move account, whatever its old flag (`accountUnverified` in the plan and record); the flag
breaks ties; several unverified pre-move accounts need `--unverified-account`;
`--accept-unverified` removed; post-move accounts still never counted or chosen. No migration;
no backfill possible (a person's next sign-in marks them). Docs: ADR-012 amendment,
TENANCY_OPERATIONS §6.6. Tests: `platform/auth/__tests__/email-verification.test.ts` (the rule,
failures), `platform/auth/__tests__/actor-account.test.ts` (wiring; provider outage touches
nothing), `__tests__/db/email-verification.db.test.ts` (sign-up → confirm → sign-in: verified,
one record, no write on later requests; unverified claim, other address, outage, no downgrade,
concurrent requests), `__tests__/db/identity-relink-hostile.db.test.ts` (unverified pre-move
account re-linked without override, single and bulk; pool must verify; post-move unverified
sign-up neither blocks, is chosen nor can be named; several unverified need naming; tie-break).

**Review 16:** the re-link's tie to this flag is tightened (TASK-174 review 16 D4f): an account
whose flag is false is re-linked only on the operator's confirmation for it. The sync, and
provisioning's initial flag, believe a federated provider's `email_verified` only from
`AUTH_TRUSTED_EMAIL_IDPS` (default `Google`; never Microsoft Entra ID — mutable email, nOAuth); a
token that does not say who verified it (`identityProviders`) is not believed; the audit record
says `verifiedBy`. Tests: `platform/auth/__tests__/email-verification.test.ts`,
`__tests__/db/email-verification.db.test.ts`, `__tests__/identity-providers-claim.test.ts`.

### TASK-177 — The platform's own Cognito provider named an identity by its username, not its sub

| Field        | Detail                                    |
| ------------ | ----------------------------------------- |
| **ID**       | TASK-177                                  |
| **Type**     | Defect, identity                          |
| **Severity** | High                                      |
| **Phase**    | Phase 5                                   |
| **Target**   | v6.0.0 (RC)                               |
| **Status**   | Fixed on develop (v6.0.0 RC)              |
| **Logged**   | 2026-10-26 (found in the review 16 fixes) |

**What:** `platform/auth/cognito-provider.ts` named a verified token by the pool's username (the
token's `username` claim, GetUser's `Username` — `Google_1093…` for a federated user), while
Playform's provider (`cognito-auth.ts` there) names it by the token's `sub`, and the platform's own
sign-in, SSO and MFA sessions already used the `sub`. Consequences: (1) the re-link command needed
review 16's `--subject username|sub`, which an operator could get wrong; (2) provisioning accepts
only a UUID subject, so on the platform's own provider a brand-new Google user could never be
provisioned (`account.not_provisioned` on every request); (3) a sign-out revoked the session's
`sub` while a federated user's verifications were stamped by the username, so they were not voided.

**Decision:** the subject is the Cognito `sub` (ADR-012 amendment TASK-177, D10) — stable, unique
in the pool, a UUID, never reused, the same form for native and federated users.

**Fix:** the provider names the token by its signed `sub` (`TokenPayload.sub`) and refuses a
GetUser answer whose `sub` attribute differs; `getUserInfo`, `tokenSubject` (sign-out), the
revocation after an address is verified (AdminGetUser's `sub`), refresh, MFA and SSO all name the
`sub`. Administrative calls (`assignTenant`, `getUserTenant`) address the user by its pool
username — Cognito accepts no federated user's `sub` there — learnt from the signature-checked
`username` claim of the user's own token (and GetUser) in a bounded per-instance map; a subject not
seen is addressed by its `sub` (every native user). The re-link binds the `sub` always:
`IdentityDirectory` is `findByEmail` + `findBySub` (`subjectAttribute`, `SUBJECT_ATTRIBUTES`,
`findBySubject`, `filterSafeUsername`, `DirectoryUser.subject` removed); the report and audit
record drop `subjectAttribute`. `--subject` removed: `--subject sub` accepted for one release as a
no-op with a deprecation note on stderr; `--subject username` (or anything else) refused, exit 2.
`identityProvidersOf` (`@/platform/auth/identity-directory`) documented for consumers
(MIGRATION_v5_to_v6 §1b example). No data migration: platform-foundation has no deployment with
existing users; Playform's provider always bound the `sub`.

**Tests:** `__tests__/db/subject-is-sub.db.test.ts` (the real provider over a Cognito stand-in,
native and Google alike: the token names the sub, first-request provisioning, requireActor,
permissions, account guard, requireAdmin; shared-mode identity tenant assigned by the pool
username and read back; Cognito's federated-sub rule; re-link to the sub and reach afterwards),
the conformance kit's new TASK-177 cases (`__tests__/contract/auth-token-verification-contract.ts`:
a federated token is named by its sub; a revocation by the sub voids it, by the username nothing;
a lookup for another sub), `__tests__/cognito-provider.test.ts`, `__tests__/cognito-tenancy.test.ts`
(administrative calls by the learnt username), `__tests__/cognito-provider-extended.test.ts`
(`getUserInfo`), `__tests__/token-verification.test.ts` (`tokenSubject`),
`__tests__/db/identity-relink-r16.db.test.ts` (federated staff bound to the sub; native and Google
re-link identically; bound-in-pool asked by sub), `__tests__/identity-relink.test.ts` (directory,
`--subject` deprecation/refusal), `__tests__/relink-identity-script.test.ts`, and every
`IdentityDirectory` fake (`identity-relink*.db.test.ts`). Docs: ADR-012, TENANCY_OPERATIONS §6,
RELEASE_NOTES, MIGRATION_v5_to_v6 §1b.

### TASK-178 — Review 17: sign-out trusted the refresh cookie's user id; the Cognito provider's evidence unchecked

| Field        | Detail                             |
| ------------ | ---------------------------------- |
| **ID**       | TASK-178                           |
| **Type**     | Defect, security (identity)        |
| **Severity** | Medium                             |
| **Phase**    | Phase 5                            |
| **Target**   | v6.0.0 (RC)                        |
| **Status**   | Fixed on develop (v6.0.0 RC)       |
| **Logged**   | 2026-10-26 (review 17 of TASK-177) |

**Review 17 (every finding fixed; the reviewer's proofs kept, asserting the fixed behaviour, in
`__tests__/r17-hostile-signout.test.ts` and `__tests__/r17-hostile-cognito.test.ts`):**

| Finding | What was wrong                                                                                                                                                                                                                                                                                                   | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Tests                                                                                                                                                                                                                                                                                                                                                                         |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1      | Sign-out took the subject to revoke and the `logout` actor from the unsigned refresh cookie (`<user id>.<refresh token>`): an attacker's own refresh token behind a victim's id voided the victim's remembered verifications and recorded the victim's `logout`; a bearer A with a cookie naming B voided B only | Sign-out revokes and records only a subject the provider proved: the bearer, verified (`verifyToken`) before its sign-out; else the cookie's user, proven by a refresh the provider issues for the cookie's id (its access token is then the one signed out everywhere). The cookie's id counts only when it equals a proven subject; `RevokeToken` proves nothing. The cookie is `<user id>.<mac>.<refresh token>`, HMAC-SHA256 under the new required `REFRESH_COOKIE_KEY` (rotation `REFRESH_COOKIE_KEY_PREVIOUS`, verify-only); refresh and sign-out refuse a cookie whose MAC fails | r17 sign-out ×10 (forgeries refused — unsigned, id swapped, made-up MAC; refresh route refuses them; an unproven refresh voids nobody; A+B voids and records A only; an unverified bearer; legitimate sign-out); `auth-sessions` (signed cookie, MAC refusals, rotation, cookie-only sign-out proven by refresh); `sso-flow`; environment contract (required, rotation rules) |
| M2      | The conformance kit's last `subjectCases` case (`payload === null \|\| payload.sub === …`) could not fail                                                                                                                                                                                                        | Asserts `null` for a GetUser answer naming another user, and a new case for an answer without `sub`; verified the kit fails when the provider's check is removed (either half)                                                                                                                                                                                                                                                                                                                                                                                                           | kit (`auth-token-verification-conformance`)                                                                                                                                                                                                                                                                                                                                   |
| L1      | A GetUser answer without `sub` was accepted and its `Username` remembered for administrative calls                                                                                                                                                                                                               | A missing `sub` is invalid; the username is remembered only after the `sub` check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | r17 cognito (assignTenant still addressed by the sub); kit; every GetUser fixture now carries the `sub`                                                                                                                                                                                                                                                                       |
| L2      | The native-user rule (`Username === sub`, no `identities`) assumed `identities` readable; nothing checked it                                                                                                                                                                                                     | `checkPoolShape` (DescribeUserPoolClient `ReadAttributes`, administrative credentials): hidden → the provider takes no user as native, and readiness probe `identity-pool` reports degraded; without credentials the operator's check is logged once and documented (ENV_REFERENCE "Cognito pool shape", SETUP §4d). A user whose `identities` lists any provider (a linked native user) is that provider's                                                                                                                                                                              | r17 cognito (rule with `identitiesReadable`; linked native; verifyToken after the check; checkPoolShape shapes; probe statuses, caching, budget)                                                                                                                                                                                                                              |
| L3      | `AUTH_TRUSTED_EMAIL_IDPS` matched case-sensitively and refused spaces after commas (`google` trusted no Google user; `Google, SignInWithApple` trusted none)                                                                                                                                                     | Names trimmed and matched case-insensitively; the shape allows spaces around commas; a malformed value is refused by the contract and by the re-link command's `missingSettings` (exit 2, even with the pool given in code)                                                                                                                                                                                                                                                                                                                                                              | email-verification unit (table); environment contract; identity-relink (`missingSettings`, exit 2); r17 cognito                                                                                                                                                                                                                                                               |
| L4      | A refresh's `SECRET_HASH` is always computed with the `sub`: wrong for a pool that signs in by username, and nothing said so                                                                                                                                                                                     | Required pool shape documented (sign in by email address); `checkPoolShape` reads `UsernameAttributes` and the required `identity-pool` probe makes a username-sign-in pool unready (detectable only with the administrative credentials; otherwise the documented operator check)                                                                                                                                                                                                                                                                                                       | r17 cognito (username pools, phone-only, alias)                                                                                                                                                                                                                                                                                                                               |

Docs: ADR-012 amendment (review 17, D11), RELEASE_NOTES, MIGRATION_v5_to_v6 (review 17 row, §1
step 3, §1b), ENV_REFERENCE (`REFRESH_COOKIE_KEY`, `REFRESH_COOKIE_KEY_PREVIOUS`, pool shape,
`AUTH_TRUSTED_EMAIL_IDPS`), SETUP_AND_INTEGRATION §4d/§5, `.env.example`, CI workflows.

### TASK-187 — Haiku 4.5 (the fast tier) may be retired at any time: move to Haiku 5.5

| Field        | Detail                                               |
| ------------ | ---------------------------------------------------- |
| **ID**       | TASK-187                                             |
| **Type**     | Maintenance (model lifecycle)                        |
| **Severity** | High — every fast-tier call fails the day it retires |
| **Phase**    | Phase 5                                              |
| **Target**   | Before Haiku 4.5 retires (v6.x)                      |
| **Status**   | Open — the owner's decision; not switched            |
| **Logged**   | 2026-10-28 (TASK-186, the review of #461/#462)       |

**What.** `MODEL_REGISTRY.fast` is `claude-haiku-4-5-20251001`. Anthropic's model-deprecations
page (platform.claude.com/docs/en/about-claude/model-deprecations, read 2026-10-28) lists it
Active with a tentative retirement "not sooner than October 15, 2026" — a date already passed, so
it can be retired at any time, as Sonnet 4 was (#461). The weekly model registry check
(`.github/workflows/model-registry-check.yml`, TASK-186) fails once it stops resolving; this task
is to move before that.

**Proposed (verified, not applied).** `claude-haiku-5-5` (platform.claude.com/docs/en/models and
its Haiku 5.5 migration guide: "a fixed model ID with no date suffix and no separate alias";
deprecations page: retirement not sooner than October 7, 2027). Prices (pricing page,
2026-10-28), per 1M tokens: prompts up to 100,000 tokens — input $0.10, output $0.50, 5-minute
cache write $0.125, cache hit $0.01; over 100,000 — $0.50, $2.50, $0.625, $0.05 (the threshold
counts cache reads and writes). What the switch needs, from the migration guide:

- `acceptsTemperature: false` — Haiku 5.5 takes no `temperature`, `top_p` or `top_k`; the fast
  tier's prompts lean on low temperatures (moderation, classification), so their outputs need a
  re-check (`prompts/`, the moderation suites).
- **Long-prompt pricing:** `ModelConfig` has one price per kind; either add the >100k tier or
  document that the fast tier's prompts stay far below it (they do today).
- No assistant prefill (a 400); a forced `tool_choice` returns the tool call with no thinking.
  Whether it takes `thinking: { type: "between_tools" }` is not stated: query
  `GET /v1/models/claude-haiku-5-5` (`thinking.types`) before deciding the `thinking` setting.
- The prompt-cache minimum drops from 4,096 tokens to 512.

**Done when** the fast tier names a model the registry check resolves, its prompts pass their
suites on it, and the README's tier table and prices are updated.

### TASK-188 — A fallback when a tier's model is retired or unavailable (planned, not built)

| Field        | Detail                                           |
| ------------ | ------------------------------------------------ |
| **ID**       | TASK-188                                         |
| **Type**     | Feature (resilience) — planned                   |
| **Severity** | Medium                                           |
| **Phase**    | Phase 5                                          |
| **Target**   | After launch (v6.x)                              |
| **Status**   | Planned — not built; decide after launch traffic |
| **Logged**   | 2026-10-28 (TASK-186)                            |

**What happens today.** A tier whose model is retired fails every call routed to it: the API
answers 404 / `not_found_error`, the provider classes it permanent, the circuit breaker does not
open (it counts only transient errors), and each route answers `service.unavailable`. Detection is
the weekly registry check (TASK-186); recovery is a code change of `MODEL_REGISTRY`.

**What a fallback would be.** A per-tier ordered list of model IDs; on a model-not-found answer
(not a refusal, not a 400 of our own making) the orchestrator retries once on the next, records
`ai.model_fallback` in metrics and raises an alert. Open questions: per-model request settings
differ (temperature, thinking, prefill), so the fallback must carry its own `ModelConfig`; cost
and quality change silently unless the alert is acted on. Not built now: pre-launch, the weekly
check plus a one-line registry change is the proportionate path.

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

| ID       | Description                                                | Resolved In        | Date       |
| -------- | ---------------------------------------------------------- | ------------------ | ---------- |
| TASK-014 | Admin module coverage exclusions                           | Phase 1, Sprint 7a | 2026-04-01 |
| TASK-015 | Platform config table                                      | Phase 1, Sprint 7b | 2026-04-02 |
| TASK-016 | Repo inheritance model                                     | Phase 1, Sprint 7b | 2026-04-02 |
| TASK-017 | Seed data separation                                       | Phase 1, Sprint 7b | 2026-04-02 |
| TASK-018 | Rename player → user                                       | Phase 2, Sprint 3  | 2026-04-06 |
| TASK-020 | Redis CacheProvider                                        | Phase 2, Sprint 4  | 2026-04-07 |
| TASK-020 | TTS chunking (numbering collision)                         | Phase 3, Sprint 2  | 2026-04-10 |
| TASK-021 | Redis rate limiter                                         | Phase 2, Sprint 4  | 2026-04-07 |
| TASK-022 | Password enforcement                                       | Phase 2, Sprint 4  | 2026-04-07 |
| TASK-023 | GDPR hard purge                                            | Phase 2, Sprint 4  | 2026-04-07 |
| TASK-027 | Narrow IAM permissions                                     | Phase 4, Sprint 0  | 2026-04-17 |
| TASK-028 | Install @sentry/nextjs                                     | Phase 4, Sprint 0  | 2026-04-17 |
| TASK-030 | (resolved per PHASE4_PLAN ln 16)                           | Phase 4, Sprint 0  | 2026-04-18 |
| TASK-034 | UX review — adaptive UI approved                           | Phase 4, Sprint 0  | 2026-04-18 |
| TASK-019 | Rename game-engine → app-framework                         | Phase 5, Sprint 0  | 2026-06-21 |
| TASK-051 | Drop semgrep --config auto (both repos)                    | Phase 5, Sprint 0  | 2026-07-12 |
| TASK-052 | Sync-failure alerting (GitHub Issue on failure)            | Phase 5, Sprint 0  | 2026-07-12 |
| TASK-053 | Stale game-engine refs in Playform overlays                | Phase 5, Sprint 0  | 2026-07-12 |
| TASK-054 | platform/rag + platform/agents READMEs                     | Phase 5, Sprint 0  | 2026-07-12 |
| TASK-055 | Prune stale auto-sync branches (14 removed)                | Phase 5, Sprint 0  | 2026-07-12 |
| TASK-040 | ACRCLOUD placeholders in .env.example                      | Phase 5, Sprint 0  | 2026-06-21 |
| TASK-043 | Known-good audio test fixtures                             | Phase 5, Sprint 0  | 2026-06-21 |
| TASK-029 | Sentry/middleware build-warning tracking (dup of TASK-028) | Phase 5, Sprint 0  | 2026-06-21 |
| TASK-065 | Migration tracking table (applied_migrations)              | Phase 5, Sprint 2  | 2026-07-29 |

---

### TASK-179 — The sync template could revert an app; the assurance record of GitHub security tooling

| Field        | Detail                                    |
| ------------ | ----------------------------------------- |
| **ID**       | TASK-179                                  |
| **Type**     | Defect (consumer template), documentation |
| **Severity** | Medium                                    |
| **Phase**    | Phase 5                                   |
| **Target**   | v6.0.0 (RC)                               |
| **Status**   | Fixed on develop (v6.0.0 RC)              |
| **Logged**   | 2026-10-26 (found in Playform)            |

**What was wrong.** `docs/templates/sync-from-foundation.yml` synced the configured ref (normally
`main`) whatever the app already had. An app that adopts the platform from `develop` ahead of its
release (Playform did) got a scheduled pull request syncing an older platform over a newer one, which
would revert that work if merged; its branch also carried a test fixture into the app's history scan.

**Fix.** A **Version guard** step and `docs/templates/sync-version-guard.sh`, which the app copies to
`.github/scripts/`: the sync proceeds only when `PLATFORM_VERSION` in the source is strictly newer
than the app's, compared field by field; a missing or malformed version fails the run, so the
template's failure alert fires. SETUP_AND_INTEGRATION §6 says to copy it.

**Also.** `docs/ASSURANCE.md` §6: every security check on GitHub (tool, when, whether it blocks,
where it runs and where it skips, and the repository settings a private consuming app needs), and
the Cadence row noting CodeQL runs on public repositories only.

**Tests.** `__tests__/sync-version-guard-template.test.ts`: strictly newer proceeds; older and equal do not;
numeric, not text, order (6.10.0 after 6.9.0) and leading zeros; a missing file, a pre-release
suffix, no or two version lines, an unquoted value, a malformed target version and wrong arguments
fail closed with nothing on stdout; the template runs the guard before the sync and both later steps
depend on it; the platform's own version is in the shape the guard reads.

### TASK-180 — Authenticator setup showed no QR code

| Field        | Detail                                  |
| ------------ | --------------------------------------- |
| **ID**       | TASK-180                                |
| **Type**     | Defect (UX)                             |
| **Severity** | Low                                     |
| **Phase**    | Phase 5                                 |
| **Target**   | v6.0.0 (RC)                             |
| **Status**   | Fixed on develop (v6.0.0 RC)            |
| **Logged**   | 2026-10-26 (signing in to playform-dev) |

**What was wrong.** `components/admin/MfaEnrollment.tsx` showed only the base32 key and the
otpauth:// text, on screen by default: nothing to scan, and the secret visible to anyone nearby. A
setup call that could not reach the server was an unhandled rejection with no message. Separately,
the dev pool had software-token MFA off, so setup failed; the pool shape did not say it is needed.

**Fix.** The URI is drawn as a QR code client-side — one SVG path built from the encoder's modules,
no markup injection — with `qrcode-generator` 2.0.4 (MIT, no dependencies, pinned exactly; listed
in COMPONENT_REGISTER). The key and the URI text are behind "Can't scan? Show key"; if the code
cannot be drawn the screen says so and points to the key. Nothing leaves the page beyond the
existing setup call. ENV_REFERENCE "Cognito pool shape" and SETUP §4d: software-token MFA,
`OPTIONAL`, with the command to set it and the check.

**Tests.** `__tests__/mfa-enrollment.test.tsx`: the drawn modules are the encoder's for exactly the
URI setup returned; the secret is in neither the screen nor the markup until toggled, and hidden
again on "Hide key"; one network call, no console output carrying the secret; an encoder failure
falls back to the key; no URI draws nothing; a refused setup shows the server's message and an
unreachable one "Setup failed.".

### TASK-181 — Screens hid or misreported the API's refusals (user-facing gap audit, batch 2)

| Field        | Detail                                      |
| ------------ | ------------------------------------------- |
| **ID**       | TASK-181                                    |
| **Type**     | Defect (UX) + Test infrastructure           |
| **Severity** | Medium                                      |
| **Phase**    | Phase 5                                     |
| **Target**   | v6.0.0 (RC)                                 |
| **Status**   | Fixed on develop (v6.0.0 RC)                |
| **Logged**   | 2026-10-26 (user-facing gap audit, batch 2) |

**What was wrong.** (1) Password reset showed "Password Reset" when the server refused it (a wrong
or expired code, the password policy, a rate limit), and "send code" advanced when refused —
`ForgotPasswordForm` ignored the result. (2) An unconfirmed account's sign-in showed "Sign-in
failed": `AuthPage` checked `success` before `emailVerificationRequired`; resending the code said
nothing either way. (3) Every screen handled refusals its own way, mostly as one fixed text — the
admin console showed "refused" for `auth.permission_denied`, `account.restricted` and a 503 alike.
(4) An under-13 date of birth created an account that waited for a parental consent nobody can
give yet. (5) Tests read the operator's shell: run in a terminal with a deployment's settings
exported (DATABASE_SSL_CA, COGNITO__, UPSTASH__, CACHE_PROVIDER), 46 tests failed.

**Fix.** (1, 2) Both reset steps advance only on the server's success and show its message; sign-in
checks `emailVerificationRequired` first and opens verification; resend says a code was sent, or
shows the refusal (no cooldown then). (3) **One shared handler**, `platform/errors/refusal.ts`:
`REFUSAL_HANDLERS` decides every platform code's kind — age-gate, consent-wait, restricted,
signed-out-erased, not-provisioned, tenant-unavailable, retry-after, service-unavailable, sign-in,
message — exhaustively (tsc refuses a new code without one); `handleRefusal` / `readRefusal` give
the screen its kind, message, retry delay and account status; `fetchWithProvisioningRetry`
retries `account.not_provisioned` with backoff; `announceSessionEnd` + `useRefusalSessionEnd`
end the session for an erased or unmatched account. `components/refusal/RefusalNotice.tsx`
renders each kind (and `TenantUnavailable`, full page). The admin console, review dashboard,
appeal form, SSO callback and guest sign-in use it. (4) **Under-13 switch**:
`UNDER_13_ACCOUNTS_AVAILABLE = false` in `platform/auth/age.ts`; `isUnder13Unavailable` refuses the
date at the age gate, `POST /api/auth/sign-up` and `POST /api/account/age` with the new
`account.child_accounts_unavailable` (403) before anything is created or recorded. **Batch 4** (parental
consent: a 7-day window, email plus) removes the constant, the function and its three checks. (5)
`__tests__/helpers/isolate-env.ts`, imported first by `jest.setup.ts`, clears every setting the
environment references document and the environment contract declares; `TEST_*` and `REQUIRE_*`
(the DB and Valkey suites) and the runner's own are kept.

**Standing check.** `__tests__/refusal-coverage.test.ts`: for each route, the codes it can return
(its `apiError` literals and the codes of the guards it calls — each guard module exports
`REFUSAL_GUARDS`, and the test checks the module's own literals are listed); for each UI caller
of the route, every code must be handled by the shared handler or the caller's `HANDLED_CODES`.
Today's gaps are in `refusal-coverage-baseline.json` (per repository, not synced), which may only
shrink — 305 pairs, all in the staff consoles' panels, the reference SpikeApp, `useRealtimeStream`
and `useSsoProviders`. The same file bans `if (!res.ok) return { error: "<literal>" }` in screens
and hooks. The deployed smoke test can also open a session and dispatch into it as the guest
(`SMOKE_SESSION_PATH`, `SMOKE_DISPATCH_PATH`, `SMOKE_DISPATCH_INTENT`) — an app whose screen
translates through a session proves that path on every deploy.

**Tests.** `refusal-handler` (every kind, the backoff, the components, the session end once),
`refusal-coverage`, `env-isolation` (a real jest run started with a polluted shell sees none of
it), `auth-page` / `forgot-password-form` / `age-gate` / `admin-console-refused` / `account-age`
(the new cases), `deploy-smoke` (the session step).

### TASK-182 — Formal verification of the job queue, dual control, tenant isolation and sessions

| Field        | Detail                                                           |
| ------------ | ---------------------------------------------------------------- |
| **ID**       | TASK-182                                                         |
| **Type**     | Assurance                                                        |
| **Severity** | —                                                                |
| **Phase**    | Phase 5                                                          |
| **Target**   | After the real-user journey check and the account page (batch 5) |
| **Status**   | Planned                                                          |
| **Logged**   | 2026-10-26                                                       |

Following Anthropic's _LLMs are making formal software verification feasible at a much larger
scale_ (Frontier Red Team with Theorem, 2026-10-22; [ASSURANCE](ASSURANCE.md) §7 has the full
acknowledgement): machine-checked specifications, kept in CI, for the job queue's claim protocol,
held-action dual control, row-level tenant isolation (a model generated from `pg_policies`, checked
with an SMT solver) and the refresh-cookie and sign-out protocol. The job queue first. Each new
concurrent or security-critical state machine gets a specification as part of being done.

### TASK-183 — A documented, acknowledged AI-engineering review process

| Field        | Detail                                                          |
| ------------ | --------------------------------------------------------------- |
| **ID**       | TASK-183                                                        |
| **Type**     | Assurance, process                                              |
| **Severity** | —                                                               |
| **Phase**    | Phase 5                                                         |
| **Target**   | Phase 5, with the next promotion                                |
| **Status**   | In place on develop; the parts listed under "Not done" are open |
| **Logged**   | 2026-10-27                                                      |

Following _How the Claude Code team does code review_ (Addy Osmani, Morgan Westlee Lunt and Qing
Wang, claude.dev Blog, 2026-10-15; [AI_ENGINEERING](AI_ENGINEERING.md) §1 has the full
acknowledgement). **Why:** in October 2026 server-side tests passed while real users could not
finish (TASK-180, TASK-181, Playform's date-of-birth screen), and the identity re-link (TASK-174)
ran three review rounds before its approach was questioned.

**Done.** `CLAUDE.md` and `REVIEW.md` (each repository's own); `docs/AI_ENGINEERING.md` — the
article's practices adopted, adapted or declined, the per-change review protocol the AI engineer
runs before handover, risk tiers set from the change, the evidence a change carries, metrics;
`scripts/risk-tier.mjs` with its patterns in `scripts/risk-tiers.json` (an app adds
`scripts/risk-tiers.app.json`); the `review-tier` job (`.github/workflows/review-tier.yml`,
running the base branch's classifier and patterns; `.github/`, `scripts/risk-tier*`, `REVIEW.md`,
`CLAUDE.md` and any `.gitattributes` always High; a refusal labelled `risk:high`); the
Claude Code security review (`.github/workflows/security-review.yml`, the action pinned to a
commit, failing its check while findings are reported, skipped with a notice without
`ANTHROPIC_API_KEY` — failing instead for a fork's PR, or when the repository variable
`SECURITY_REVIEW_REQUIRED` is `true`); the PR template's Risk tier, Testing, Security, Performance,
How to revert
and Review rounds; the reviewer eval set `docs/review-evals/` (17 cases from this register and
the October 2026 CI failures, with a scoring rubric: 14 reproduce from public history; cases 02,
04 and 08 have their input reconstructed from pre-release history, in `docs/review-evals/inputs/`). ASSURANCE §1, §3 and §6 updated.

**Tests.** `__tests__/risk-tier.test.ts` (tiers by path and by changed lines; a removed line and a
removed SQL comment count; tests' content does not raise a tier; renames keep the old path; an
app's areas merge; the hard rule; `--patterns`; upper-case tenancy SQL; names with spaces, quotes
or glob characters; a `.gitattributes` cannot hide content; output over 64 KB through a pipe; unsafe, quoted paths and refs refused; in an app, its real paths classify High); `__tests__/review-process.test.ts` (CLAUDE.md's
standing rules, REVIEW.md's failures and rules, every eval case indexed and complete, the review
workflows on `pull_request` only, pinned, without credentials and least-privileged, the tier
from the base's classifier, a skipped security review failing for a fork or when required, the PR
template's sections, the acknowledgements).

**Not done.** A PR that changes a workflow runs its own copy of it, so its tier and security
result are not trustworthy (ASSURANCE §3): the owner runs the base classifier locally
(AI_ENGINEERING §4.2); the `pull_request_target` job that would read the head only as data is
planned. The `ANTHROPIC_API_KEY` secret in platform-foundation (the security review skips
until it is set), and then `SECURITY_REVIEW_REQUIRED=true` there and in Playform, which has the
key; `security-review` and `review-tier` as required checks in branch protection
(owner settings); the first scored run of the eval set; the first milestone's metrics; circuit
breakers (declined for now, AI_ENGINEERING §8).

### TASK-184 — The admin console read a panel before it knew the admin could open it

| Field        | Detail                                                   |
| ------------ | -------------------------------------------------------- |
| **ID**       | TASK-184                                                 |
| **Type**     | Defect (UX, access shown)                                |
| **Severity** | Medium                                                   |
| **Phase**    | Phase 5                                                  |
| **Target**   | v6.0.0 (RC)                                              |
| **Status**   | Fixed on develop (v6.0.0 RC)                             |
| **Logged**   | 2026-10-27 (Playform's live staff journey, playform-dev) |

**What was wrong.** `app/admin/page.tsx` opened the console on `"roles"` and read
`/api/admin/roles` in an effect that did not wait for `GET /api/admin/session`; while the session
loaded, `AdminShell` was rendered with no permissions, fell back to `"users"` and reported it, so
`/api/admin/users` was read too. A moderator (`can_access_admin`, `can_moderate`) was refused both
(403) and shown a section heading over data it could not load; an admin without a second factor
saw all three reads refused (the session, roles and users). Found by Playform's Journey B, which asserts the first section's
data read is 200. Review eval case 18.

**Fix.** `AdminShell` exports `permittedSections(hasPermission)` — its own section-to-permission
mapping, in its order, the one source for both the shell and the page; the shell no longer falls
back to a section the admin may not open. The page opens no panel and reads nothing until the
session answers "admin", then opens the first permitted section (a moderator: Approvals; `*`:
Users), and reads only a permitted one. While the session loads it shows "Loading…", not the
shell. A "no sections available for your role" screen (`screens.admin_console.no_sections`,
through `RefusalNotice`, with sign-out) is kept as a safety net: the platform's server cannot
produce it today, since `/api/admin/session` requires `can_access_admin`, which always opens
Approvals and Tenant. The server's permission checks are unchanged.

**Also fixed (pre-existing, found in review).** The console's own "Sign Out" only left for `/`
with a full load: the access token and user stayed in storage and the refresh cookie stayed live,
so the next page was still signed in. It now awaits the auth context's `signOut()` (the server's
sign-out with the access token, then the stored session forgotten) and then loads `/auth`
(`components/admin/leave-console.ts`). Playform's Journey B signs out with that button.

**Tests.** `__tests__/admin-console-first-section.test.tsx`, against a mock server that answers
each panel route 403 without its permission: a moderator opens on Approvals, reads only
`/api/admin/approvals` (then `/api/admin/tenant` on click), never `roles` or `users`, and no read
is refused; no panel read starts before the session answers; the dev-bypass admin (`*`) opens on
Users, read once; a role whose first section is Roles opens there; non-string permissions are
dropped; a loading session reads no panel; `auth.mfa_required` and a refused session each reach
their own screen (so a session that never answered fails them) and read no panel; no permissions,
or only ones no section uses, show the no-sections message and sign out; the shell with no section
renders and reports nothing. `__tests__/admin-console-sign-out.test.tsx`, with the real auth
context: Sign Out posts `/api/auth/sign-out` with the bearer token, clears the stored token, user,
legacy refresh token and session cookie, and only then leaves for `/auth`; with the server's
sign-out unreachable or answering 500 the session still ends and the console still leaves.

### TASK-185 — The admin console's Users screen: addresses never recorded, and a list to act on

| Field        | Detail                                                       |
| ------------ | ------------------------------------------------------------ |
| **ID**       | TASK-185                                                     |
| **Type**     | Defect (auth — the recorded identity) and feature (admin UI) |
| **Severity** | High (auth, admin)                                           |
| **Phase**    | Phase 5                                                      |
| **Target**   | v6.0.0 (RC)                                                  |
| **Status**   | Fixed on develop (v6.0.0 RC); migrations 056 and 057         |
| **Logged**   | 2026-10-28 (the owner's live test of Users, playform-dev)    |

**What was wrong.** (1) **Addresses never recorded.** `users.email` was written only when
provisioning created the row, from the profile its caller passed; nothing filled it afterwards.
The TASK-176 sync (`platform/auth/email-verification.ts`) wrote only `email_verified` and, by
design, never `email` — "not when the row has none". A row provisioned without an address (a
first request whose caller passed no profile — `isInGoodStanding` from `/api/auth/guest`, a
consumer's own `checkAccountStatus(userId, feature)` — or a token whose address was empty, such
as a federated sign-in before the pool mapped its address) kept `email` NULL for good, and also
escaped the ban carry-over (A-11), which matches by address. On playform-dev every account made by
a first sign-in on the new pool and every Google sign-in listed "—". Review eval case 19.
(2) **The Users screen** showed only email, name, raw role and a locale date: no standing, no
verification, no last sign-in (`users.last_login_at` existed and nothing wrote it), no way to open
an account or act on it, no server sort. (3) **Hints and headings.** The command bar showed a
second, fixed hint line ("Create a moderator role with can_play and admin_view_audit") under every
section, to roles that cannot create a role, and a section the page's own title table did not
list was headed by its raw id ("approvals"). (4) **Pre-existing, found in review:**
`lib/pagination.ts likeTerm` stripped `%`, `_` and `\` from a search instead of escaping them, so
`john_doe` searched for `johndoe` and found neither.

**Fix.**

- **The address follows the provider** (`email-verification.ts`, ADR-012 amendment TASK-185,
  superseding D5a): from a trusted verified claim only (`emailVerified` exactly true; the pool
  itself or providers all in `AUTH_TRUSTED_EMAIL_IDPS`, default Google — never Microsoft Entra ID
  or a token that does not say), a missing address is recorded, verified; a changed one too, but
  only on an active or warned account and only from the provider's own answer to that request
  (`TokenPayload.addressFresh`, set by `token-verification.ts` on a GetUser answered now, never on
  a remembered verification or an outage stand-in — two devices whose remembered answers differ
  would otherwise flip the address between them for the cache window). A banned account's address
  is never moved (the ban follows it), a restricted or suspended one waits, an erased one is never
  written. The ban carry-over applies to the recorded address (`banFollowsAddress`, shared with
  provisioning). One conditional update naming the value read, with its `profile_updated` record
  (`field: email`, `change: absent | changed`, never the address) in one transaction; best effort.
  It runs on every request through `requireActor` and on the admin console's
  `GET /api/admin/session` (staff requests otherwise go through `requireAdmin`).
  `isInGoodStanding` takes the token's profile and the guest route passes it, so a row it first
  provisions has its address. No administrative backfill: an account whose person signs in again
  through a trusted, verifying provider fills itself; one that never signs in again keeps none.
- **The last sign-in is recorded** — cheap and exact: each sign-in that hands out a session
  (password, MFA, new password, SSO; not a refresh) sets `last_login_at`, best effort
  (`auth-events.ts recordLastSignIn`); provisioning takes a first sign-in's time from its
  `login_success` record (written before the row existed); migration 057 fills the column once
  from the sign-ins the audit log already holds.
- **`GET /api/admin/users`**: `status` (the guard's reading: an expired restriction or suspension
  is active; `deleted` for an erased account awaiting its purge) with `statusUntil`,
  `emailVerified`, `lastSignInAt`, `roleId`, `roleDisplayName` and the page's current
  `entitlements` (unrevoked, unexpired, of an active group; one bounded query); `sort=created|
last_sign_in`, `dir=desc|asc` — one of four fixed statements chosen by name, anything else
  `request.invalid_value`; `page: { limit, offset, hasMore }` from one row of look-ahead (no
  count). Migration 056 indexes both orders, `(tenant_id, created_at desc, id)` and `(tenant_id,
last_login_at desc nulls last, id)`; the ascending statements break ties by `id desc`, so a
  backward index scan serves them with no sort. **Search is a bounded scan of one tenant**, not
  indexed: as the request role, under row-level security, `ilike` (not leakproof) is applied
  after the tenant policy, so a trigram index is never used (measured: used only by the owner
  role); it is bounded by the statement timeout (`DATABASE_STATEMENT_TIMEOUT_MS`), the page size
  and the offset cap (900). `likeTerm` now escapes `%`, `_` and `\`.
- **The Users screen** (`components/admin/UsersPanel.tsx`, replacing `UsersDataView`): search,
  sort and paging on the server (paging off while a page is read; a refused re-read hides the rows
  read before); status, verified, created and last sign-in columns; a display name falls back to
  the address, then "—"; a missing address reads "Unknown (never signed in since <created>)" only
  when no sign-in is recorded — an account that signs in without one reads "Unknown: address not
  received from the sign-in provider (last sign-in <date>)"; roles are readable ("Super admin")
  with the stored name in a tooltip and the detail panel; dates "26 Oct 2026". A row opens a
  detail panel (focus moves to its heading; the row is `aria-current`; closing returns focus to the
  row) with id, address, name, role, stored role name, status, verified, created, last sign-in,
  entitlements, and the actions the admin's permissions allow, from `USER_ROW_ACTION_PERMISSIONS`
  (`tool-permissions.ts` — the matrix test checks each against its route's guard): change role
  (`PATCH /api/admin/users`; a 202 `held` is shown as "Held for approval", never as done) and erase
  account data (`POST /api/admin/gdpr`, after an `alertdialog` confirmation that takes focus and
  returns it to Erase). Neither is offered on the admin's own row or a `super_admin` row (the
  routes refuse both); the panel says why. Every refusal is shown by its code through the shared
  handler.
- **Hints and headings.** The second hint line is gone; each section's examples are derived from
  the server's permission map (`components/admin/section-hints.ts`: `toolPermission`, and a
  search's table permission) and an example the role cannot run is not offered — the moderator
  sees the generic prompt. Every section's heading and navigation label come from one source,
  `sectionTitle` in `AdminShell` (`screens.admin_console.sections`).

**Left out, and why.** Suspend / restore: no route changes an account's standing outside
moderation decisions, so no action is shown (the panel says so). Authenticator enrolled: the
platform does not record it (`users.mfa_enabled` is never written; the pool holds it) — not shown
rather than faked. "Identity from a previous pool": not determinable — `users.cognito_sub` does not
say which pool issued it, and only the pool can answer, with operator credentials
(`identity-directory.ts findBySub`) — so not shown.

**Review round 1 (two independent reviewers).** Important: trigram indexes unusable under RLS —
dropped, search documented as a bounded scan; 056's index locks held through the audit-log
backfill — the backfill is 057, its own transaction (measured: 056 0.19 s at 100,000 accounts; 057
4.5 s at 2,000,000 `login_success` rows and 100,000 accounts (about 1 s per 440,000 rows; 2 vCPU, Postgres 16)); the address could flip between two cached answers — the `addressFresh` flag;
"never signed in" could be false — the two texts above; focus management — as above. Nits fixed:
ascending tie-breaks, the re-link refusal's stale text, a search test that could not fail, the
role choice following a re-read, the same-role answer neutral, loading and stale rows, test
titles, actions hidden where refused, an unused catalog key, the live check made to compare with
the permission map. Pre-existing: `likeTerm` (above). Playform's Journey C added (an `admin` test
account, read-only).

**Owner steps.** Migrations 056, then 057, in the SQL Editor
([MIGRATION_v5_to_v6.md](MIGRATION_v5_to_v6.md) §1 step 2), before the code. The two old-pool
staff accounts (created 2026-06-07) can never sign in again: change the `admin` one's role in the
console (held for a second admin's approval); the `super_admin` one can change only in the
database (ADR-013) — the owner's decision.

**Tests.** `__tests__/token-verification.test.ts` (only an answer asked now is `addressFresh`; never
stored, never from memory or a stand-in); `platform/auth/__tests__/email-verification.test.ts` (the
rule: absent, changed per status and freshness, banned kept, untrusted and unverified never, not
an address, erased never, the update's own checks, ban carried, failures);
`__tests__/db/email-verification.db.test.ts` (on Postgres: filled once and audited without the
address, never from an unverified or untrusted claim, two devices never flip it, a banned holder's
address bans the account, concurrent requests write once, an erased account untouched; a first
sign-in becomes the new account's last sign-in, a refresh does not count);
`__tests__/db/admin-tenant-data.db.test.ts` (status, verification, sign-in and active entitlements
per row; both sorts and directions; look-ahead paging; limit and offset bounds; a hostile
`sort`/`dir` refused by name; a hostile term bound as text; `_` and `%` match themselves; a
moderator's role change and an admin's erasure refused by the routes);
`__tests__/admin-list-search.test.ts` (`likeTerm` against a LIKE oracle);
`__tests__/admin-users-panel.test.tsx` (display and the two Unknown texts, search/sort/paging,
loading, stale rows, the detail panel, focus, `aria-current`, the alertdialog, actions only with
their permission and never on the own or a super_admin row, held shown as held, every platform
refusal code for the list, the role change and the erasure); `__tests__/admin-section-hints.test.ts`;
`__tests__/admin-authorization-matrix.test.ts`; `__tests__/admin-session.test.ts`,
`__tests__/guest-continuation.test.ts`; the replay checks 056 and 057.

### TASK-186 — PRs #461 and #462 reviewed after merge: cache pricing, the cache gate, thinking blocks, refusals

| Field        | Detail                                                                 |
| ------------ | ---------------------------------------------------------------------- |
| **ID**       | TASK-186                                                               |
| **Type**     | Defect (AI cost and governance) — a review after merge                 |
| **Severity** | Medium (cost misreported; an ungoverned cache flag; a tool-loop break) |
| **Phase**    | Phase 5                                                                |
| **Target**   | v6.0.0 (RC)                                                            |
| **Status**   | Fixed on develop (v6.0.0 RC); migration 058                            |
| **Logged**   | 2026-10-28 (an independent review of #461 and #462, merged unreviewed) |

**What was wrong.** #461 (standard tier on Sonnet 5.5) and #462 (opt-in prompt caching) were
merged without the review protocol. An independent review found:

1. **Cache reads mispriced.** `estimateCost` billed reads at a fixed 0.1x of input
   (`platform/ai/instrumentation.ts:23` at `6540699`); Sonnet 5.5 bills them at 0.05x ($0.10/1M,
   not $0.20). The test asserted the multiplier, not the price. And nine callers priced their own
   calls from input and output alone, dropping cache tokens entirely: the five social agents, the
   moderation classifier, `agent-intent`, `agent-classifier` and the adaptive loop. Review eval
   case 20.
2. **Cache tokens never reached persistent metrics:** `obs.metrics.record` and `MetricsSummary`
   carried input and output only, and `input_tokens` excludes cached tokens, so a cached call's
   prompt looked small.
3. **No gate on prompt caching:** a per-request flag only, and it cached the whole system prompt —
   which on the admin command bar carries the tenant's context.
4. **Thinking blocks dropped:** the provider filtered them out under a comment that calls were
   "single-turn"; Sonnet 5.5 thinks between tool calls, and a tool loop must pass the signed
   blocks back unmodified.
5. **Model retirement undetected:** nothing noticed Sonnet 4's retirement until calls failed.
6. **Pre-existing:** the admin command bar answered a model refusal with `service.unavailable`
   (`app/api/admin/ai/route.ts:184-191`), which reads as an outage and invites a retry.
7. **Nit:** the registry comment said `between_tools` "turns extended thinking off"; it turns off
   up-front thinking only (Sonnet 5.5 cannot disable thinking).

**Fix.**

- **Prices per model.** `ModelConfig` gains `cacheReadCostPer1M` and `cacheWriteCostPer1M`
  (5-minute TTL): Sonnet 5.5 $0.10 / $2.50, Haiku 4.5 $0.10 / $1.25 (platform.claude.com pricing
  and prompt-caching pages, read 2026-10-28). `estimateCost(tier, usage)` takes the whole
  `AIUsage`; every caller passes `response.usage`, so leaving the cache out is a type error, and
  `__tests__/ai-cache-governance.test.ts` holds each call site to it.
- **Metrics.** `ai.call` values carry `cacheReadTokens` and `cacheWriteTokens` (0 when none);
  `MetricsSummary` adds `totalCacheReadTokens`, `totalCacheWriteTokens` and `totalPromptTokens`
  (input + reads + writes). `ai_metrics.values` is `jsonb`: no column, no migration.
- **The gate.** Migration 058 seeds `ai.prompt_cache_enabled` (boolean, default false,
  operator-only). The orchestrator drops a request's `promptCache` unless the setting is true
  (read only when a request asks; unreadable is off). The provider caches only an explicit
  `cacheablePrefix` — fixed, tenant-free text sent as its own block before `system` — never
  `system`, the tools alone or the messages. Without a prefix nothing is cached, so a system
  prompt carrying a tenant's context cannot enable it.
- **Thinking blocks** are kept as an opaque `AIContentBlock` (`{ type: "thinking", raw }`), passed
  back exactly as they arrived (complete and stream) and never rendered.
- **Retirement detection.** `.github/workflows/model-registry-check.yml` (weekly, and by hand)
  runs `scripts/check-model-ids.mjs`: `GET /v1/models/{id}` for every registry ID with the
  `ANTHROPIC_API_KEY` secret; fails on any that does not resolve, prints a reported `retires_at`,
  skips with a notice without the key, never prints the key or a response body. Haiku 4.5's
  retirement: TASK-187; a fallback: TASK-188 (planned).
- **Refusals** throw `AIRefusalError` (an `AIProviderError`, permanent); the command bar answers
  it with the new code `ai.request_declined` (422, kind `message`), and `AdminPromptBar` shows
  refusals through the shared handler (`readRefusal`), which removed its 16 refusal-coverage gaps.

**Review round 1 (two independent reviewers; every finding fixed).**

| Finding                                                                                                                       | Tag          | Fix                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A refusal lost its billed usage: thrown before usage was read; failure metrics and the classifier recorded 0                  | Important    | `AIRefusalError` carries `usage` and `model`; `recordFailureMetrics` records a refusal's tokens and cost (complete and stream); the classifier's and the content loop's results carry it                                                                                                                                                                                     |
| `instanceof AIRefusalError` fails across bundle copies (ADR-032)                                                              | Important    | `isAIRefusalError` (also by `name` and `kind: "permanent"`, as `isJsonLimitError`) and `refusalUsage` (numbers or 0); used everywhere; a test holds that no source uses `instanceof`                                                                                                                                                                                         |
| The model check passed a retired model; a missing key was silent                                                              | Important    | `lifecycle: "retired"` fails, `deprecated` / `deprecated_at` warns, `retires_at` printed only when an ISO date; a step summary; `MODEL_CHECK_REQUIRED` = `true` fails a keyless run; a `pull_request` trigger on the registry and the script (fork-safe)                                                                                                                     |
| The response cache's key omitted `cacheablePrefix`                                                                            | Important    | In the key; a guard test lists every `AIRequest` field and fails on one neither in the key nor listed out (`promptCache`, billing only)                                                                                                                                                                                                                                      |
| A thinking block's `raw` was sent unchecked                                                                                   | Important    | Sent only as `thinking` / `redacted_thinking` in an assistant turn; anything else (an image in `raw`, a user turn) refuses the request before it is sent                                                                                                                                                                                                                     |
| (Playform) the classify model test could not fail                                                                             | Important    | A sentinel `fast.modelId` through the real orchestrator and provider; a source check that no file outside `platform/ai/types.ts` names a `claude-` model ID, in both repositories                                                                                                                                                                                            |
| No live check of the request shape Sonnet 5.5 takes                                                                           | Important    | The check sends one `max_tokens: 1` Messages call per tier with the registry's `thinking` and `temperature` settings; only HTTP statuses are printed                                                                                                                                                                                                                         |
| `estimateSavedCost` used fixed old prices; the content loop reported a paid call as `costUsd: 0`; the caller list was by hand | Pre-existing | `estimateCost(tier, usage)` in both; the caller test finds every `estimateCost` call with the TypeScript parser and refuses a hand-built usage without both cache counts                                                                                                                                                                                                     |
| A refusal from the safety classifier was treated as an outage                                                                 | Pre-existing | The owner's decision (round 3): `declined: true`, **withheld for human review** at every rating level before thresholds or context reductions — escalated (never shown, ADR-041; submitted to the review queue), never allowed, and no strike: the Sentinel runs only on a block, so a strike follows only if a reviewer decides it was a violation. The billed cost is kept |
| (Playform) `lib/classify.ts` called the SDK directly                                                                          | Pre-existing | Through the orchestrator, fast tier: cost, metrics, the breaker and typed refusals (a refusal is `TYPED`)                                                                                                                                                                                                                                                                    |
| `AdminPromptBar` ignored the refusal's kind; "not charged" was wrong; `/api/stream` dropped `temperature` silently            | Nit          | Kinds other than `message` shown by `RefusalNotice` (an erased session ends); "billed as ordinary input, no write premium"; documented on `StreamRequestInput` and in the README                                                                                                                                                                                             |

**Review rounds 2 and 3.** Round 2's verifier passed every round-1 answer. Round 3 (the last):
a classifier refusal is withheld for review with no strike (above, the owner's decision);
`refusalUsage` caps each count at 10,000,000 so a recorded cost stays finite; the registry
workflow says a fork's PR skips the probe and fails once `MODEL_CHECK_REQUIRED` is `true`; and,
asked by the owner, the held-actions panel (`components/admin/HeldActionsPanel.tsx`) says what a
decision did — "Approved: <label> took effect", "… now waits for a second approval", "<label>: <reason>"
(the reason itself says it was approved and could not be applied), "Rejected: <label>" — in an announced status region above the
refreshed list (or its empty message), for six seconds or until dismissed; refusals go through the
shared handler (its 15 refusal-coverage gaps went). Tests: `outage-every-level` (withheld at every
level, direction and kind; queued; no Sentinel run; never allowed), `ai-cache-governance` (the
cap), `held-actions-panel` (confirmation then the empty list, auto-dismiss, a pending second
approval, the run-failed reason with the row kept).

**Owner steps.** Migration 058 in the SQL Editor (one row; no lock beyond it). The setting stays
off: nothing uses `cacheablePrefix` yet. Run the new workflow once by hand (Actions → Model
registry check → Run workflow) to see both IDs resolve and both tiers accept their request; then
set the repository variable `MODEL_CHECK_REQUIRED` to `true`. After the deploy, one admin
command-bar prompt on playform-dev must return a plan (the standard tier's live request shape).

**Tests.** `__tests__/ai-instrumentation.test.ts` (cost from the price table, each part of the
usage; the published prices pinned); `__tests__/ai-cache-governance.test.ts` (the gate: off by
default, both needed, unreadable off, a non-boolean off; metrics values and summary totals; every
caller passes the usage); `__tests__/anthropic-provider-model-settings.test.ts` (only the prefix
is marked; a tenant-context system prompt cannot enable it; thinking kept opaque and passed back
unmodified in a tool loop and a stream; refusals are `AIRefusalError`);
`__tests__/admin-ai-command-bar.test.ts` (refusal → 422 `ai.request_declined`, other permanent
errors still 503); `__tests__/admin-ui-components.test.tsx` (the declined message shown);
`__tests__/check-model-ids.test.ts` (against a local stand-in API: pass, a missing ID fails naming
it, unreachable fails, no key skips; the key is never printed); the replay check of 058.

### TASK-189 — The command bar's search showed and recorded every column, and ignored its query

| Field        | Detail                                                           |
| ------------ | ---------------------------------------------------------------- |
| **ID**       | TASK-189                                                         |
| **Type**     | Defect (personal data — data minimisation) and defect (admin AI) |
| **Severity** | High (over-exposure); Medium (the query ignored)                 |
| **Phase**    | Phase 5                                                          |
| **Target**   | v6.0.0 (RC)                                                      |
| **Status**   | Fixed on develop (v6.0.0 RC); no migration                       |
| **Logged**   | 2026-10-28 (a live check of the admin command bar, playform-dev) |

**What was wrong.** (1) **Over-exposure.** `app/api/admin/ai/handlers/search.ts` read every
searchable table with `select to_jsonb(t) … from <table> t`: every column of every row. A search
of `users` returned each account's date of birth, identity-provider subject, real name, ban reason,
who changed its standing and the parental consent address — none of which the Users screen shows
under the same permission (`admin_manage_users`) — as one JSON text in the results panel, and
recorded it in the action's step (agent_trajectories), a second copy outside the account's own
retention and erasure. `audit_log` returned the IP address and user agent the Audit log page does
not show; a column added by a later migration would have been exposed unreviewed. (2) **The query
was ignored.** The tool's schema required `query`; the handler never read it, so "show users who
signed in this week" listed every user. (3) **The panel** showed the result as one JSON string.
Review eval case 22.

**Fix.**

- **A column allowlist per table** (`SEARCH_COLUMNS`), each mirroring the admin page that requires
  the same permission, the reason for each in the file: `users` — id, email, display name, role
  name, status (as the Users screen reads it: an expired restriction is active, an erased account
  deleted) and until when, email verified, created, last sign-in; `roles` — id, name, display
  name, description, created; `permissions` — id, code, display name, category;
  `role_permissions` — id, role name, permission code, created (not `granted_by`);
  `entitlement_groups` — id, code, display name, active (not `created_by`); `audit_log` — id,
  action, actor, target, when (not the IP address or user agent; **not `details`**: free-form, up
  to 1 MiB, may carry personal data — the Audit log page shows it under the same permission, but a
  search records its result, so a search names the entry and the page shows the rest);
  `platform_config` — key, the value in effect for the tenant, category, description, tier,
  overridden, updated (retired settings left out, not `updated_by`, as the Platform config page).
  Each statement selects exactly those columns by name, and the result is built from the list.
- **Typed filters, bound** (`SEARCH_FILTERS`): `text` (a substring, LIKE-escaped by `likeTerm`,
  the Users screen's helper) on every table; `users` also `role`, `status`,
  `signed_in_within_days`, `created_within_days`; `audit_log` `action`, `actor_id`, `target_id`,
  `within_days` (and `text` as the action names containing it, as the Audit log page);
  `platform_config` `category`. One fixed statement per table; each filter is a bound parameter
  that is null when absent. Each value is validated and a bad one refused
  (`request.invalid_value`), as is a filter the table does not take — never ignored. Periods are
  days back from now, not dates: the planner has no clock. The 20-row limit and the stable order
  are kept. The old `query` is read as `text` (an older plan that searched for a name still
  works); both given is refused (round 2); it is gone from the schema, which now lists the filters, requires only
  `table` (an enum of the allowlist) and allows nothing else.
- **A table, not a JSON text.** The action returns `table: { table, columns, rows }` and a one-line
  `result` from the catalog ("3 rows of users.", "Showing 20 of 57 matching rows of users."); the
  recorded step holds less (round 1, below). The 256 KiB
  cut is kept (`fitSearchRows`: whole rows, an oversized one skipped and named). The results panel
  shows the rows as a compact, scrolling table (`SearchResultGrid`), headings and yes/no from
  `messages/en.json` (`screens.admin_console.search`); other actions are unchanged.

**Left as it was (the owner's decision).** Steps recorded by searches before this change still
hold the whole rows wherever trajectories are stored (`agent_trajectories`, tool `search`). This
change does not rewrite or purge them; whether to, per environment, is the owner's call.

**Review round 1** (two independent finders; no Critical or High; the owner decided each answer).

| Finding                                                                                                                                           | Tag    | Resolution                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The recorded step outlives erasure: display names, addresses and the admin's free text kept in `agent_trajectories`, which erasure does not scrub | Medium | The admin's screen gets the whole table; the step records `searchStepRecord` — the table, its columns, the shown rows' ids (first column), shown and matched counts, and the filters with `text` / `query` as "[redacted: N chars]" (`command-bar.ts` `runtimeToolFor`: the tool's return is the step) |
| Role filter took codes only                                                                                                                       | Medium | Any name up to 64 characters, no control characters, trimmed; matched case-insensitively on the role's name or display name ("Support Lead", "Moderator")                                                                                                                                              |
| A capped result read as every match                                                                                                               | Medium | `count(*) over ()` in every statement; "Showing 20 of 57 matching rows of users." (ICU plural, catalog)                                                                                                                                                                                                |
| `text` over 100 characters was cut silently                                                                                                       | Low    | Refused (`request.invalid_value`)                                                                                                                                                                                                                                                                      |
| The database's error message was returned and recorded                                                                                            | Low    | Logged (`logger.error`, "Admin command search failed"); the admin sees a plain failure from the catalog                                                                                                                                                                                                |
| Every row over the size cut said "No rows match"                                                                                                  | Low    | The line counts matches, then says which rows were left out for size                                                                                                                                                                                                                                   |
| Signed-in-within searches listed by account age                                                                                                   | Low    | A second fixed statement: `last_login_at desc nulls last, id` when `signed_in_within_days` is given                                                                                                                                                                                                    |
| The confirm panel said only "Search users table"                                                                                                  | Low    | `describeSearch` (catalog): "Search users where role is Moderator, signed in within the last 7 days"                                                                                                                                                                                                   |
| A null for a key the table does not take was refused                                                                                              | Low    | A null (or undefined) key is absent, before the allowlist check                                                                                                                                                                                                                                        |
| Long cells were not cut (a table cell ignores max-width)                                                                                          | Low    | An inner block with `max-w-xs truncate`, the whole value in its `title`                                                                                                                                                                                                                                |
| A config `true` was shown as "Yes"                                                                                                                | Low    | A JSON column is sent as its JSON text (`true`, `5`, `"true"`); yes/no only for a true boolean column                                                                                                                                                                                                  |
| `.every` over a possibly empty list; restricted and suspended not covered                                                                         | Low    | Non-empty asserted first; accounts with an active restriction and suspension seeded, with their ends                                                                                                                                                                                                   |

**Review round 2** (an independent verifier of the round-1 diff; tier High — personal data of
minors, `billing-consent`). Items 2–13 verified; item 1 partial:

| Finding                                                                                                                                                                   | Tag       | Resolution                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| N1: `searchStepRecord` copied every input key but `text` / `query` verbatim — a refused `email: "kid@example.com"`, a free-text `role` and any object value were recorded | Important | An allowlist: `table` only when searchable; for a search that ran, each filter of `SEARCH_FILTERS[table]` as parsed and validated, `text` / `query` / `role` as "[redacted: N chars]"; any other key — unknown, invalid, or every key of a refused search — by name only (`ignored_keys`; a name that is not a plain identifier as "[redacted key]"), never its value                                        |
| `text` and `query` together: `query` silently dropped                                                                                                                     | Nit       | Refused (`request.invalid_value`, field `query`, "give one of text or query, not both"); the confirm panel says so                                                                                                                                                                                                                                                                                           |
| `describeSearch` rendered the raw ICU template for a non-numeric day count                                                                                                | Nit       | No raw template: a day count is shown only as a whole number 1–3650, and a key the table does not take is named as "an invalid value: the search will be refused", never with its value (the panel's copy of the filters held equal to `SEARCH_FILTERS` by a test). Round 3: a string the server will refuse (an unknown status, a non-UUID id, over-long text) is still shown as given — follow-up TASK-190 |

**Review round 3** (final; an independent verifier of the round-2 diff, with the TASK-189 database suites run in both repos: 371 passed each). N1 and the text-and-query refusal verified; verdict SHIP. Two residuals, accepted and filed as **TASK-190**: (a) the confirm panel shows a string value the server will refuse as if valid (Nit; the admin's own panel, nothing recorded); (b) an unknown filter key whose name is itself identifier-shaped (e.g. `jane_doe`, ≤40 characters of `[a-z0-9_]`) is kept by name in `ignored_keys` and would outlive an erasure (Low; the planner's schema allows no extra keys) — TASK-190 records only their count.

**Tests.** `__tests__/task-189-search.test.ts` (no statement reads a whole row, each selects
exactly its allowlist, the users and audit allowlists hold no sensitive column, a row carrying
them puts none in the result or the step; each filter's bound values; LIKE escaping, the 100-
character bound, injection attempts as bound values; 20 malformed or hostile inputs refused before
any statement; the permission per table, before the filters; the schema);
`__tests__/db/task-189-search.db.test.ts` (on Postgres: each statement's row keys are the
allowlist; stored sensitive values never returned; each filter; `_` and `%` as themselves; another
tenant never read; the config value in effect and no retired setting);
`__tests__/task-189-search-panel.test.tsx` (the table, headings, yes/no and none, no empty table;
round 1: long values cut with the whole in the title, JSON values as JSON, the confirm panel's
filters). Round 1 adds: the recorded step through the governed runtime holds no address, name or
text; a database error logged, never returned; "Showing 20 of N"; 101 characters refused; a role by
display name; null keys absent; on Postgres, the match count, an active restriction and suspension,
sign-ins ordered by the last, a boolean setting as `false`. Round 2 adds: a refused search
with `email`, `display_name`, a role and an object, through the governed runtime, leaves no value
in the stored trajectory; a search that ran records only validated filters, the role as its
length; text with query refused; a non-numeric or out-of-range day count and a filter the table
does not take described without a value or a template;
`r10-search-truncation`, `rv11-hostile` L-3, `admin-ai-handlers`, `admin-tenant-data.db` updated.

### TASK-190 — One list on the Users screen; ids behind "Show details"; the confirm panel and ignored key names

| Field        | Detail                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------ |
| **ID**       | TASK-190                                                                                   |
| **Type**     | Defect (admin UX) and hardening (personal data)                                            |
| **Severity** | Medium (two lists that disagree); Low (residuals of TASK-189)                              |
| **Phase**    | Phase 5                                                                                    |
| **Target**   | v6.0.0 (RC)                                                                                |
| **Status**   | Fixed on develop (v6.0.0 RC); no migration                                                 |
| **Logged**   | 2026-10-29 (TASK-189 review round 3, accepted residuals; the owner's live check, same day) |

**What was wrong.** (1) **Two lists.** In the owner's live check of /admin → Users, the command
bar's "show moderators" drew its own table in the results box — with an Id column, raw ISO dates
and the role as its stored name, "moderator" — while the Users screen's list below it still showed
every account. (2) **Ids shown to everyone** who could run a search. (3) **Values not readable**:
dates as ISO text, the role by its code, the standing in lower case. (4) **Residual (a) of TASK-189
round 3**: the confirm panel (`components/admin/search-description.ts`) showed a string value the
server will refuse — an unknown status, a non-UUID id, text over 100 characters, a role over 64 —
as if the search would run. (5) **Residual (b)**: `searchStepRecord` kept an unknown key's name in
`ignored_keys` when it was identifier-shaped (`jane_doe`), so a name could outlive an erasure.

**The owner's decisions.**

1. **One list, not two.** On the Users screen, a command-bar `search` of `users` that succeeds
   filters the Users screen's own list with the same filters (role, status, signed in within,
   created within, text), shown as removable chips ("Role: Moderator ✕", "Signed in within 7 days
   ✕", "Clear all"); the search's results row says "1 user matches — shown in the list below." and
   draws no second table. A search of any other table — or of users from another section — keeps
   the compact results table.
2. **Ids hidden by default**, behind a "Show details" toggle offered only to admins and
   super-admins (roles `admin` and `super_admin`); moderators and every other role never see it.
   The id stays in the recorded step.
3. **Readable values** in search results and chips: dates as the Users screen writes them ("29 Oct
   2026", the whole timestamp in a tooltip), the role by its display name ("Moderator"), the
   standing capitalised ("Active").
4. Residual (a): the confirm panel mirrors the server's checks — by sharing them.
5. Residual (b): the step records only the number of ignored keys.

**Fix.**

- **One check, three callers** (`app/api/admin/ai/search-filters.ts`, new, client-safe):
  `SEARCH_FILTERS`, the limits (role ≤64 characters, no control characters, trimmed; status one of
  the six standings; day windows whole numbers 1–3650; text ≤100 after control characters are
  dropped and it is trimmed; category a code; action an audit action; ids UUIDs) and
  `checkSearchFilter`, which returns the value as it is used — text unescaped (the binder escapes
  it with `likeTerm`). The command bar's search (`handlers/search.ts`, which re-exports them), the
  Users list and the confirm panel all call it, so none can accept what another refuses
  (`__tests__/task-190-filters.test.ts` runs the same values through all three). The audit action
  names moved to `platform/auth/audit-actions.ts` (client-safe; re-exported by `audit.ts`;
  `scripts/migration-replay.sh` reads them there).
- **The Users list takes the users filters** (`GET /api/admin/users?text=&role=&status=
&signed_in_within_days=&created_within_days=`, `parseUserListFilters`): checked as the search
  checks them (a day count from its digits; anything else stays text and is refused; an empty
  parameter is absent, as `q=`; a repeated one is refused), each a bound parameter of the four fixed
  statements, with the same conditions as the search's users statement — the role matched on its
  name or display name in any case, the standing as `listedStatus` reads it (now also in SQL,
  `USER_STATUS_SQL` in `listing.ts`, shared by both). Its own search box (`q`), sort, paging and
  look-ahead are unchanged; with any filter the offset cap is the search's (900). Same permission
  (`admin_manage_users`) and tenant scope; refused values `request.invalid_value`, already handled
  by the screen.
- **How the page learns the filters.** From the execute response, never the planner's input: a
  search's `table.filters` carries the filters as the server validated and applied them (trimmed,
  the text unescaped). On the Users screen the console (`app/admin/page.tsx` through
  `components/admin/users-search-handoff.ts applyUsersSearch`) takes the last users search that
  succeeded, keeps only the users filters, applies them to the list (`UsersPanel filters`) and
  marks that row `listed`. The list re-reads them through the route, which checks them again. The
  filters stay until a chip is removed, "Clear all" or a newer users search; elsewhere nothing is
  handed over. `searchStepRecord` never records `table.filters`.
- **"Show details"** (`components/admin/ShowDetailsToggle.tsx`): offered when the console's
  session says the caller's role is `admin` or `super_admin` — `GET /api/admin/session`'s
  `roleName`, the verified admin's role as `requireAdmin` reads it, which the page already holds
  (the development bypass, `dev-bypass`, is not offered it). An `aria-pressed` button beside each
  section's heading; its state is the console page's, in memory for the session (no storage: a
  reload hides the ids again). It reveals the id columns of a search's table (`id` and every
  `*_id`: an audit entry's actor and target), an Id column on the Users list, and the detail
  panel's account id (also hidden by default now). Round 1 narrowed and hardened this: only `id`
  is hidden (an actor or target id shows its first 8 characters, as on the Audit log page), and a
  search's `id` column is sent only to admins and super-admins (S-L1 below).
- **Readable values** (`components/admin/admin-format.ts`, shared with the Users screen):
  `created_at`, `last_sign_in_at`, `status_until` and `updated_at` as "29 Oct 2026" with the whole
  timestamp ("29 Oct 2026, 09:15:00 UTC") in the tooltip; a users row's role cell is now the
  role's display name (else its name; the statement's `role` column) in sentence case, the stored
  value in the tooltip; the standing capitalised. A JSON config value is still its JSON text. The
  Users list's dates gain the same tooltip.
- **Residual (a).** `describeSearch` shows a filter's value only when the table takes the filter
  and `checkSearchFilter` accepts the value — and then as the server will use it (trimmed, an id
  lower-cased); otherwise "<name> (an invalid value: the search will be refused)". A text of only
  spaces is no filter, to both. The panel's copy of the filters is gone: it reads `SEARCH_FILTERS`.
- **Residual (b).** The step records `ignored_key_count` (absent when none), never a key's name;
  the "[redacted key]" text is gone from the catalog.

**Review round 1** (two independent finders, correctness and security; no Critical or High). The
coordinator's decisions, implemented as stated:

| Finding                                                                                                                                             | Severity        | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S-L1: ids hidden on the screen only — a moderator's browser still received every row's id                                                           | Low (security)  | A data control: `searchResultFor` (handlers/search.ts) leaves a search's `id` column out of the execute response unless the caller's verified role (`requireAdmin`'s `roleName`, the source of GET /api/admin/session) is admin or super_admin (`maySeeIds`, `ID_DETAIL_ROLES` in search-filters.ts — the console's "Show details" roles are the same list); the result line never names a row left out for size by an id the caller may not see. The step still records the rows' ids. The Users list keeps its ids (its row actions need them; under admin_manage_users) |
| 1: removing a chip or "Clear all" left the search's row saying "shown in the list below"                                                            | Medium          | Dismissed: any change of the list's filters from its chips removes that row (`afterFiltersChanged`), and a "kept the previous filters" note with it                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2: the panel's own search box stayed applied after a hand-off, so the list showed less than the search; the row's count was the planner's `matched` | Medium (+ S-L2) | A hand-off clears the box (draft and query; the `handoff` prop). The row has no count of its own: "The matching users are shown in the list below." — the list (which reads no total, by design) is the one answer, and its "No users match these filters." stays accurate                                                                                                                                                                                                                                                                                                 |
| 3: a role with no display name read "Qa_lead" in the results grid                                                                                   | Low             | `readableRole(value, null)`: "Qa lead", as the Users list writes it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 4: `actor_id` and `target_id` were hidden with `id`                                                                                                 | Low             | Only `id` is behind "Show details"; a `*_id` reference shows its first 8 characters with the whole id in the tooltip, as on the Audit log page                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 5: "Show details" was shown on every section                                                                                                        | Low             | Only where it changes something: the Users screen, and a section showing a search table with an `id` column                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 6: every users search of a multi-step plan drew its table; only the last drives the list                                                            | Low             | Earlier users searches are one line: "3 users matched (an earlier search in this plan)."                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 7: a refused users search left the list's filters with nothing saying so                                                                            | Low             | The list keeps them, and the row adds "The list still shows the previous filters." (when the list shows any; the refused action is known by its index in the plan, the execute route's order)                                                                                                                                                                                                                                                                                                                                                                              |
| 8: the tooltip's comment said UTC; the timestamp was in the browser's zone                                                                          | Nit             | `timeZone: "UTC"`: "29 Oct 2026, 09:15:00 UTC" everywhere                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 9: a role chip read "moderator" until the roles loaded, then "Moderator"                                                                            | Nit             | An unmatched role is written `readableRole(value lower-cased, null)`: the same words before and after the roles load                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

Noted, not changed (security finder's nits): development steps recorded before this change may
still hold `ignored_keys` names (no production steps exist; nothing reads them); an empty filter
parameter on the Users list counts as absent, as the search treats a null filter — kept as the
designed semantics.

**Review round 2** (an independent verifier of the round-1 diff): **SHIP**; every round-1 item
verified (item 9 partially). Applied:

| Finding                                                                                                     | Severity | Resolution                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N-1: a hand-off of the same filters, from page 2 or with a row open, stayed there                           | Low      | The hand-off is part of the panel's reset key with the filters: any hand-off goes back to page 1 with nothing open                                                                                                                                    |
| N-2: searching the panel's own box after a hand-off left the row saying the list shows the search's matches | Low      | Applying the box reports through `onFiltersChange` (filters unchanged), so the row is dismissed on the same path as a chip (`afterFiltersChanged`)                                                                                                    |
| N-3: "the previous filters" was wrong when an earlier users search of the same plan had run                 | Nit      | `keptFilters` says which: "previous" (as before the plan) or "earlier" — "The list shows the filters of the earlier search in this plan." Round 3: correct only when the refused search comes after the successful one; the reverse order is TASK-192 |
| 9 (partial): a role chip named from its value could still change once the catalog's display name arrived    | Nit      | Choice: a role chip reads "Role: …" until the first page (and its roles) is read, then its catalog name; a first read that fails names it from the value. The value-only form is no longer shown before the roles                                     |

**Review round 3** (final; an independent verifier of the round-2 diff). N-1, N-2, item 9 and the coverage baselines verified; verdict SHIP. One residual, accepted and filed in **TASK-192**: when a refused users search comes _before_ a successful one in the same plan, its row says "the filters of the earlier search" though the list shows a later search's filters (Low; the later search's own row is correct).

The coverage baselines' small steps (+0.01, +0.02) are what `npm run coverage:ratchet` writes: when
an axis is above `baseline + margin` it sets that axis to `actual − margin`, so an actual just over
the band raises it by a hundredth. Never hand-edited; each committed value is the tool's output
from the final full run.

**Tests.** `__tests__/task-190-filters.test.ts` (one check: 25 values through the search, the list
and the panel, accepted or refused alike and with the same refusal; the list's filters as bound
values of an unchanged statement, the text escaped; empty and repeated parameters; the offset cap;
every sort; a moderator refused before any read; `table.filters` validated and unescaped, never in
the step; residual (b) with `jane_doe`; residual (a) for every filter of every table against the
server); `__tests__/task-190-one-list.test.tsx` (chips sent and named, a chip removed, Clear all,
the filtered empty text, dates with their tooltip, ids only with showIds; the results row's one
line, plural and none; another section's table readable with ids hidden, shown with Show details;
the hand-off; the toggle per role on the console; end to end, "show moderators" → confirm → the
list re-read with the validated filter, not the planner's); `__tests__/db/task-190-users-filters.db.test.ts`
(on Postgres: the list and the search find the same accounts for each filter and combination, every
sort, the search box with a text filter, another tenant never listed, a hostile role bound as text,
the hand-off filters taken by the list as they are). Round 1 added `__tests__/task-190-search-ids.test.ts`
(through `runCommandBarAction` and the real handler: admin and super_admin get `id`; moderator,
safety_approver and free do not, anywhere in the response, while the step keeps every id; an audit
entry's actor and target stay; the result line names no hidden id) and, in the files above: the box
cleared on a hand-off (panel and end to end), the row dismissed on Clear all and on the last chip,
earlier searches as one line, the kept-filters note, "Qa lead" in the grid and the chip, actor and
target as 8-character prefixes, the toggle absent from Approvals, the UTC tooltip, a chip's words
unchanged when the roles load (round 2: "Role: …" until then, the value's form after a failed
read), a same-filter hand-off back to page 1 with nothing open, the panel's own box dismissing the
row, the "earlier search" wording; on Postgres, a role with a blank display name read by its name in
both and written alike, and a user with no role refused by the schema (NOT NULL, foreign key).
Updated: `task-189-search` (`ignored_key_count`;
the role's display-name column), `db/task-189-search` (the role shown as "Moderator"),
`admin-users-panel` (the detail id hidden by default).

### TASK-191 — Playform CI: "Layer 1 — Core without modules" failed once on `5435623`

| Field        | Detail                                                    |
| ------------ | --------------------------------------------------------- |
| **ID**       | TASK-191                                                  |
| **Type**     | Defect (CI — an intermittent test)                        |
| **Severity** | Low                                                       |
| **Phase**    | Phase 5                                                   |
| **Target**   | v6.0.0 (RC)                                               |
| **Status**   | Closed by TASK-198 (likeliest cause reproduced and fixed) |
| **Logged**   | 2026-10-29 (Playform CI on `5435623`, the TASK-189 sync)  |

Playform's CI step "Layer 1 — Core without modules (ADR-054)" (`npm run test:core`, with the
database) failed once on `5435623` and passed on a re-run of the same commit. The failed run's logs
are no longer available, so the failing test is not known. Next: when it recurs, keep the run's log
(the failing test's name and its assertion), then run that suite repeatedly under the core config
(`PF_TEST_MODULES=none npx jest -c jest.core.config.cjs <suite>`, and the database suites at
`--maxWorkers=4`, as PLAYFORM_SYNC step 4) to reproduce it. Not to be fixed by guessing.

**Closed by TASK-198.** The audit's suspects (D-failure-tests.md) were run as TASK-198 describes:
under two CPU burners on a 2-vCPU machine, `r13-hostile` "opens after 5 failures" failed 1 run in 8
(`Expected: "open"`, `Received: "closed"`) — a heartbeat more than 100 ms late made a cache failure
read as event-loop lag. That suite is in the core pass, so it is the likeliest cause; the log being
gone, it cannot be proved the same failure. Fixed with the other suspects' root causes (TASK-198);
the next failure keeps its seed and results (the step summary and the `jest-results-*` artifact).

### TASK-192 — Admin screens: a logical order for roles and permissions; one wording residual

| Field        | Detail                                                                 |
| ------------ | ---------------------------------------------------------------------- |
| **ID**       | TASK-192                                                               |
| **Type**     | Defect (admin UX)                                                      |
| **Severity** | Low                                                                    |
| **Phase**    | Phase 5                                                                |
| **Target**   | v6.0.0 (RC)                                                            |
| **Status**   | Fixed on develop (v6.0.0 RC); migration 059                            |
| **Logged**   | 2026-10-29 (owner, a live check of the Roles screen; TASK-190 round 3) |

(1) **Roles** are listed by `sort_order, name`, but the seeded `sort_order` values never lined up
across migrations, so the list reads as arbitrary. Owner decision: staff roles first (Super Admin,
Admin, Moderator, Safety Approver), then plans smallest to largest (Guest, Free, Daily, Monthly,
Annual, Lifetime), then the rest; a migration corrects the values and a new role gets a sensible
default. (2) **A role's permissions** are shown in the order the database returns
`role_permissions`: group them by category with a heading, sorted by display name. (3) The Roles
screen's dates in the admin format ("29 Oct 2026"). (4) TASK-190 round 3 residual: in
`components/admin/users-search-handoff.ts`, say "the filters of the earlier search" only when the
refused search comes after the last successful one; test the reverse order.

**Fix.**

- **One definition of the order** (`platform/auth/catalog-order.ts`, new, client-safe):
  `SEEDED_ROLE_SORT_ORDER` (super_admin 10, admin 20, moderator 30, safety_approver 40, guest 50,
  free 60, daily 70, monthly 80, annual 90, lifetime 100 — gaps of 10 leave room for a role between
  two), `NEW_ROLE_SORT_ORDER` (1000) and `roleSortOrder(name)`; `PERMISSION_CATEGORY_ORDER`
  (admin, moderation, gameplay, social, profile, privacy — staff capabilities first, as the roles
  are, then what a player does; any other category after them, alphabetically),
  `compareCategories`, `comparePermissions` (category, then display name ignoring case, then code:
  a total order), `compareRoles` and `groupPermissions`; round 1 added `compareNames`
  (case-insensitively, then exactly — round 2: by code point), `normalCategory` (a category's case
  and surrounding whitespace ignored) and the SQL each statement orders by, `roleOrderSql` and `permissionOrderSql`
  (`lower(x) collate "C", x collate "C"`, so Postgres's linguistic collation — Supabase's
  en_US.UTF-8 — cannot order names otherwise than the browser).
- **Migration 059** (`059_roles_sort_order.sql`): one `update … where name = '<role>' and
sort_order <> <value>` per seeded role (a role a database lacks matches no row), any other role
  still at an old default — 0 or 99 (dev's `tester`; a console-made role) — to 1000, a value a
  consumer chose kept (round 1), and, first, `alter column sort_order set default 1000`, under
  `set local lock_timeout = '5s'` (round 1).
  Idempotent: an update touches only a row whose value differs, so a re-run changes no row and no
  `updated_at` (the roles trigger sets it on every update). The first run moves each reordered
  role's Modified date to that day — accepted, said in the migration guide. The replay
  (`scripts/migration-replay.sh`, step "059") reads both constants from `catalog-order.ts` and
  checks the database against them, runs 059 over a database with roles of its own at 55 (kept),
  99 and 0 (moved), one inserted with the default, `lifetime` missing and `admin` out of place
  (rolled back), and applies it again expecting no change.
- **A new role's place.** The column default and the command bar's `create_role` and
  `duplicate_role` (`handlers/roles.ts`, a bound `NEW_ROLE_SORT_ORDER`; they wrote 99) both give
  1000, so a new role follows the seeded ones and sorts among the rest by name — the owner's "then
  the rest by name", which a computed max+10 would not give (it orders by creation). The value is
  written by the code as well as defaulted, so it holds even before 059 is applied. There is no
  other create path (`/api/admin/roles` is GET only).
- **Every list of roles by `sort_order`, then name** (round 1: `roleOrderSql`): the Roles screen (`GET /api/admin/roles`,
  already), the Users screen's role picker (`GET /api/admin/users` `roles`, unordered before), the
  command bar's search of `roles` (was newest first) and the planner's context for the Roles and
  Users panels (`app/api/admin/ai/route.ts`; round 1: the Roles and Entitlements contexts'
  permissions in the screen's category order). The search's `permissions` (round 1) and
  `role_permissions` follow the Roles screen: role (`sort_order, name`), then category in
  `PERMISSION_CATEGORY_ORDER` — bound as `$2`, never SQL text — then display name and code.
  Entitlements list no roles; the users search's `role` column is a value, not a list.
- **A role's permissions, grouped.** `GET /api/admin/roles` sorts each role's permissions (read
  from `role_permissions` in no order) and `availablePermissions` with `comparePermissions`. The
  Roles screen's expanded row (`components/admin/AdminDataViews.tsx`) shows one section per
  category (round 1: a `<section aria-labelledby>` named by its `<h3>`), headed by its catalog name (`screens.admin_console.roles.category_*`: Administration,
  Moderation, Gameplay, Social, Profile, Privacy; any other category by its stored name, readable:
  `permissionCategoryLabel` in `admin-format.ts`), its permissions by display name. No other
  screen lists a role's permissions.
- **Dates.** The Roles screen's Created and Modified columns read "29 Oct 2026", the expanded
  "Created: … Modified: …" "29 Oct 2026, 14:05" (it showed the time), each a `<time>` with the
  whole UTC timestamp in its tooltip (`formatDate`, `formatDateTime`, `fullTimestamp`, as TASK-190).
  Also converted, the same way: the Audit log view's Time (`AuditDataView`, the console's `audit`
  section). Not converted: `components/admin/AdminDataPanels.tsx` and `AdminConfigPanels.tsx`
  (imported by nothing — dead in both repositories) and `components/auth/ProfilePage.tsx` (not an
  admin screen).
- **Residual (4).** `applyUsersSearch`: a refused users search that comes before the last
  successful one gets no kept-filters note — the list shows the later search's filters and that
  search's own row says so ("shown in the list below"). After it, still "the filters of the
  earlier search in this plan"; with none, "the previous filters".
- **Tests.** `__tests__/task-192-order.test.tsx` (the seeded order and its gaps, `roleSortOrder`
  for an unknown or inherited name, categories and permissions in a total order whatever the input
  order, the groups, the headings; the Roles screen's dates and tooltips, the groups under their
  headings by name, a missing or unreadable date, the roles in the server's order, the Audit log's
  time; the search statements' order and the bound category order; the hand-off before, between
  and after successful searches, and on screen). `__tests__/db/task-192-catalog-order.db.test.ts`
  (on Postgres: each seeded role's value and the column default against the code; a role created
  and one duplicated through the command bar at 1000; `GET /api/admin/roles` in the owner's order
  then the rest by name, each role's permissions by category then name, an unknown category last,
  `availablePermissions` in order; the Users route's roles; the search's roles and role
  permissions). `__tests__/helpers/db-admin.ts` creates its test roles with the column's default
  (was 98, between annual and lifetime). Playform's live admin journey checks the Users route's
  roles order on playform-dev, which also shows whether 059 was applied there.

**Review round 1** (two independent finders: SHIP, nothing Medium or above). Every finding fixed. Tags are REVIEW.md's (Important: a defect this change introduced, its severity in brackets; Nit; Pre-existing):

| Finding                                                                                                           | Tag                      | Resolution                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1: 059's `alter … set default` took ACCESS EXCLUSIVE after the row updates, with no bound on the wait             | Important (Low)          | `set local lock_timeout = '5s'` first, then the default, then the updates; the migration guide says a timeout changed nothing and to run it again                                                                                                                            |
| 2: 059 moved every non-seeded role to 1000, clobbering a consumer's chosen values                                 | Important (Low)          | Only a value at an old default (0, 99, or null) moves to 1000; any other is kept. Replay step and DB test: a role at 55 kept, at 99 and 0 moved. Release notes' consumer step reworded                                                                                       |
| 3: journey C ordered every role by name-derived places, and its role-picker check could pass by finding no picker | Important (Low)          | It checks the seeded roles present are in catalog order and before every other role (the API has no `sort_order`, so the rest's order is not asserted); the picker check opens a row that is neither the admin's own nor a protected role and requires the picker (Playform) |
| 4: the command bar's `permissions` search was newest first                                                        | Nit                      | Category order, then display name, then code (`permissionOrderSql`, the category order bound as `$2`)                                                                                                                                                                        |
| 5 + B-3: name tie-breaks in SQL followed the database's collation, the comparator `localeCompare`                 | Nit                      | Both compare case-insensitively, then exactly, by code unit: `lower(x) collate "C", x collate "C"` in every statement ordered here, `compareNames` in the code. DB test with mixed-case names (`a_b`, `AB`, `Ab`, `ab`) through both routes and the search                   |
| B-1: each category group was an `aria-label` region beside an `<h4>`: duplicate landmark names                    | Nit                      | `<section aria-labelledby>` named by its own `<h3>`; RTL test                                                                                                                                                                                                                |
| B-2: the planner's context listed permissions by category name                                                    | Nit                      | The screen's category order (Roles and Entitlements contexts)                                                                                                                                                                                                                |
| Pre-existing: a role's row opened only by a pointer click                                                         | Pre-existing (fixed now) | A disclosure button in the Permissions cell (`aria-expanded`, `aria-controls` when open, named "5 permissions of Moderator"); the row click stays as a pointer shortcut, the button's click not also toggling it; RTL test from the keyboard's focus                         |
| B: runbook's `column_default` query had no `table_schema`                                                         | Nit                      | `table_schema = 'public'` added (here and in Playform's runbook)                                                                                                                                                                                                             |
| B: a category stored in another case ("Admin") was its own group                                                  | Nit                      | `normalCategory`: grouped, ordered and headed as the known category, in the code and in SQL (`lower(btrim(category))`)                                                                                                                                                       |

**Review round 2** (a verifier of round 1's diff: SHIP; every item verified but #5, partial — its
wording). Every finding fixed:

| Finding                                                                                                                             | Tag             | Resolution                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2-1: journey C required every seeded role before every other role, so a role an app placed among them (at 55) would fail it        | Important (Low) | It checks only that the seeded roles present are in catalog order relative to each other; the picker check stays. Spec header and LIVE_JOURNEY_CHECK updated (Playform)                                                                                           |
| R2-2: the consumer step did not say a role an app placed at 1–9 now sorts ahead of super_admin                                      | Nit             | Release notes and migration guide: the seeded roles use 10–100 in steps of 10; a value below 10 now sorts first — move it                                                                                                                                         |
| R2-3 / #5: "matches the database" was stated without its limits; the code compared by UTF-16 code unit, `collate "C"` by code point | Nit             | `compareNames` compares by code point (an astral "😀" after "～", as the database); the comment and release notes state the residual — case mapping (`toLowerCase` against the database's `lower()`, e.g. "İ", final sigma). Unit and DB tests with "😀" and "～" |
| R2-category: SQL `btrim(category)` trimmed spaces only, `normalCategory` all whitespace                                             | Nit             | Both trim the same six (space, `\t`, `\n`, `\r`, `\f`, vertical tab): `btrim(category, E' \t\n\r\f\x0B')` — Postgres has no `\v` escape — and the same set in the code. Unit and DB tests with "admin\t"                                                          |
| R2-4: the planner context's new constants sat between `contextRows` and its JSDoc                                                   | Nit             | The JSDoc is back on `contextRows`                                                                                                                                                                                                                                |
| R2-5: the guide did not say `set local lock_timeout` needs 059 to run in one transaction                                            | Nit             | Migration guide: one batch in the SQL Editor (or `psql --single-transaction -f`); outside a transaction `set local` has no effect                                                                                                                                 |

### TASK-198 — Test reliability and coverage: the D-13…D-21 audit findings; TASK-191 closed

| Field        | Detail                                                                 |
| ------------ | ---------------------------------------------------------------------- |
| **ID**       | TASK-198                                                               |
| **Type**     | Defect (test quality, CI) and coverage                                 |
| **Severity** | Medium                                                                 |
| **Phase**    | Phase 5                                                                |
| **Target**   | v6.0.0 (RC)                                                            |
| **Status**   | Fixed (one residual allowance, below)                                  |
| **Logged**   | 2026-10-29 (whole-codebase sweep, audit D: failure handling and tests) |

Each class has a repository-wide guard, shown failing on the code before the fix:

| Finding | What was wrong                                                                                                                                         | Fixed                                                                                                                                                                                                                                                   | Guard                                                                                                                                                 |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-13    | r13/r14 breaker verdicts and elapsed bounds on a real clock (reproduced 1 in 8 under load: TASK-191)                                                   | The breaker and bound cases on jest's fake clock; the "answer during the stall" case with the answer queued behind the bound's timer (deterministic); the child-process and responsive-real-loop proofs moved to `__tests__/soak/`, run by the fuzz job | `real-clock-bounds.test.ts`: no real elapsed upper bound outside the fake clock; busy loops only where listed with a reason                           |
| D-14    | `data-layer` ran the whole suite with a 500 ms statement (and idle-in-transaction) timeout on the shared database                                      | The suites' 10 s; the timeout proved in one test (`300ms`, restored in `finally`), and every transaction's settings read back                                                                                                                           | `db-suite-hygiene.test.ts`: no DB suite shortens the timeout outside one test's `finally`                                                             |
| D-15    | the claim's row bound depended on a sampled `analyze` (and autovacuum mid-test)                                                                        | Measured after `analyze` with a sample larger than the table, in the measuring transaction (holds the analyze lock; rolled back)                                                                                                                        | `db-suite-hygiene`: a suite that reads plans sets `default_statistics_target`                                                                         |
| D-16    | a fresh fast-check seed each pass, known only from the log                                                                                             | `FC_SEED` from the commit SHA in every CI pass, in the step summary; `fuzzParamsPart(parts, part)` gives each part its own; every pass writes `jest-results-<pass>.json`, uploaded on failure                                                           | `property-tests-configured.test.ts` (no own seed, parts named); `workflow-hygiene.test.ts` (every CI jest pass seeded, keeps and uploads its results) |
| D-17    | the Valkey helper's port race; readiness only "something listens"                                                                                      | A start whose port is taken retries on another; ready only when its server answers AUTH with its own password over TLS with its own CA; the child's exit watched                                                                                        | `valkey-server-helper.test.ts`: a squatter and another worker's server on the port are never handed back                                              |
| D-18    | `r13.db` rewrote the seeded `agent.trusted_agents` row                                                                                                 | Not fixed: the kill switch's platform scope acts only on that key (fixed in agent-kill-switch.ts and power-reduction.ts); allowed with its reason, restored in `finally`. Needs a serial DB pass to leave the list                                      | `db-suite-hygiene`: no DB suite writes a key the migrations seed (the list may only shrink)                                                           |
| D-19    | `expect(xs.every(…)).toBe(true)` on lists that could be empty (40 sites); pending-approvals fixtures expired                                           | A non-empty assertion at each site; fixtures expire in 2099                                                                                                                                                                                             | ESLint `pf-tests/every-needs-nonempty` (`eslint-rules/`), with its RuleTester suite                                                                   |
| D-20    | the promotion-guard test skipped when the file was missing; the core pass without `REQUIRE_VALKEY_TESTS`; skipped checks without a `*_REQUIRED` switch | The guard required; `REQUIRE_VALKEY_TESTS` in every pass; `MIGRATION_PARITY_REQUIRED` (and Playform's `JOURNEY_REQUIRED`)                                                                                                                               | `workflow-hygiene`: every CI jest pass requires both, every skip notice has a switch (one by-design skip listed)                                      |
| D-21    | no record of which screens and routes no journey covers                                                                                                | `journey-coverage.test.ts` + `journey-exemptions.json` (per repository, a ratchet that only shrinks); Playform's Journey C adds the command bar's plan (POST `/api/admin/ai`, cancelled, never run) and every read section                              | The manifest test itself                                                                                                                              |

A full run without the database (the commit scripts' path) under two CPU burners found two more
load-sensitive tests, fixed the same way: `ai-orchestrator` "closes from half-open" (a 10 ms
recovery time on the real clock: now on the fake clock) and `held-action-retry` "the concurrent
test, 50 times" (jest's 5 s default for 50 rounds: now 30 s — its timeout also failed the next test,
which shared its `executed` list); 0 failures in 6 runs of both under the same load afterwards.
No static guard catches that class (a real timer in a test's own wait); the burner run is the
check, and TASK-191's method in PLAYFORM_SYNC step 4.

**Review round 1** (two independent finders, test integrity and CI; both SHIP, no Medium or
higher). Every finding applied:

| Finding                                                                                                                       | Tag          | Resolution                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1: the soak step ran only when the property step passed; nothing noticed a scheduled failure                                 | Nit          | `if: !cancelled()`; the scheduled run's failure opens or comments on a `fuzz-failure` issue (sync-from-foundation's pattern); `workflow-hygiene` requires both                                                                                        |
| L2: the short timeout was proved with two statements, the idle bound as short as the statement's                              | Nit          | One statement, in `withOwnerSnapshot` with its own 10 s idle bound (the settings read back: `300ms` / `10s`)                                                                                                                                          |
| L3: the plan comment overstated what exact statistics prove, and claimed the rollback restores `reltuples`                    | Nit          | The comment says what it proves and does not; `pg_class` is written in place and stays                                                                                                                                                                |
| L4: one seed for every pass and every file                                                                                    | Nit          | Each pass its own (+0, +1, +2, in the step summary); each file adds a hash of its path (`seedOffsetFor`)                                                                                                                                              |
| L5: the seeded-write allowance covered a whole file; writes through `setConfigWithHistory` were not seen                      | Nit          | Allowed by file and key; platform-scope `setConfigWithHistory` on a seeded key is caught                                                                                                                                                              |
| L6: "may only shrink" was a convention                                                                                        | Nit          | CI writes the base branch's exemptions and app files to `$JOURNEY_BASE`; a unit that had a journey there may not be exempted now. `journey-exemptions.json` and `eslint-rules/**` are High in `scripts/risk-tiers.json`                               |
| L7: any path literal counted, comments and prefix checks included                                                             | Nit          | Only paths inside a request call (`goto`, `waitForResponse`, `fetch`, `page.on("response")`, …) and the constants and lists those calls use, parsed as TypeScript                                                                                     |
| L8: Journey C passed over sections silently                                                                                   | Nit          | It derives the expected sections from the session's permissions, requires each present and read and every other absent; Playform's `e2e-live-admin-sections` test holds its list equal to the nav's permissions and the page's reads                  |
| Command-bar step: a mock provider would pass                                                                                  | Nit          | It refuses the mock's `[MOCK]` mark and an echo of the question; with no proposal, the plan's message must be on the screen                                                                                                                           |
| Nits: `timed()` doc; the "read again once idle" proof; two exemption reasons; `toBeGreaterThan(-1)` passed the lint rule      | Nit          | `timed()` fails at its limit; r14 reads the same cache again (a few tries, no clock bound); `/api/stream`, `/api/profile` (and `/api/features`, `/api/process`, `/api/identify`) say why; the rule requires `> n ≥ 0`, `≥ n ≥ 1`, literal lengths ≥ 1 |
| The fuzz job's DB property suite ran with no database; `jestPassProblems` saw only `ci.yml`                                   | Pre-existing | The deep job leaves `__tests__/db` out (said so; it runs with the database in CI's passes) and sets `REQUIRE_DB_TESTS`; every workflow's jest steps are checked                                                                                       |
| CI 1: the container smoke's translation skip was reworded to pass, and `silentSkips` saw only "skipped" in notices            | Nit          | The honest wording back, listed in `SKIPS_BY_DESIGN` with its reason; the pattern takes skip/skipping/not run/does not run, in notices and warnings                                                                                                   |
| CI 2: retries checked in `ci.yml` only                                                                                        | Nit          | Every workflow (and template): Playform's fuzz and deploy-smoke `npm ci`, dependency-audit `npm ci`, secret-scan `curl`, load-test `apt-get`                                                                                                          |
| CI 3: no seed or results in the fuzz job                                                                                      | Nit          | A fresh seed from the commit and the run, in the summary; results uploaded on failure                                                                                                                                                                 |
| CI 4: the seed was not required to come from the SHA, the upload not required after the passes, jest through scripts not seen | Nit          | All three required; `npm run <script>` resolved through package.json                                                                                                                                                                                  |

**Review round 2** (an independent verifier of round 1; SHIP, no Medium or higher). Applied:

| Finding                                                                                                                                     | Tag | Resolution                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------- | --- | ------------------------------------------------------------------------------------------------------------------ |
| L5: `setConfigWithHistory` with its target left out, `undefined` or `PLATFORM_DEFAULT_TARGET` writes the platform scope too                 | Nit | Each counts as the platform scope (`db-suite-hygiene`, with self-test cases); the guard names only the real writer |
| The base comparison passed silently when CI did not set `JOURNEY_BASE`                                                                      | Nit | It fails in CI (`CI` set) or with `JOURNEY_BASE_REQUIRED=1` when the base is missing                               |
| Playform's section test checked one direction                                                                                               | Nit | It also requires the page's `ENDPOINTS` (but Users, Tenants and Jobs) to be exactly Journey C's sections           |
| An allowed skip was required in every repository                                                                                            | Nit | Checked only where this repository has the step                                                                    |
| A push was compared with HEAD's parent                                                                                                      | Nit | With the push's `before` (`github.event.before`), HEAD's parent only for a new branch                              |
| Nits: a mention of a writer that does not exist; Playform's seed comment above the wrong step; the command-bar message compared as raw text | Nit | Removed; moved back; compared as plain text (Markdown marks and whitespace aside)                                  |

**Review round 3** (final; an independent verifier of round 2): **SHIP**, 0 Important. Accepted
residuals (Nit): a force-push to a protected branch leaves `github.event.before` unreachable, so the
journey-base step fails closed until the next ordinary push (main and staging refuse force-pushes);
the seeded-key guard matches writers and platform targets by text, so a variable or spread target
or an aliased call is not seen; `CI=false` is read as CI by the base comparison.

Infrastructure (TASK-191 suspect 7): `npm ci` in a three-try loop, `curl --retry`, apt
`Acquire::Retries` in every CI job (held by `workflow-hygiene`). Not done here: live journeys on
staging or production (they run on dev only), and the S7/S8 journeys the exemptions name.

**Follow-up (first run on develop, 8316436):** CI's core pass failed — the coverage pass, in the
same job, had written `jest-results-coverage.json` to the working tree, and the tree check
(`module-app-manifest`: `platform-paths.json` lists every file the platform ships) counts untracked,
non-ignored files. Playform's passes run in separate jobs, so it passed there. Fixed: `.gitignore`
ignores `/jest-results-*.json` (both repos), and `workflow-hygiene` now requires every results file
a workflow writes to be ignored by git (it failed on the old `.gitignore`, naming all five files).
Not caught before shipping because the gates ran each pass on its own, never two passes in one
working tree as CI's single job does.

_Last updated: October 30, 2026 (TASK-198 review round 3: SHIP; CI follow-up)_

_Previously updated: October 30, 2026 (TASK-198 review round 1 applied)_

_Previously updated: October 29, 2026 (TASK-198: the D-13…D-21 findings; TASK-191 closed)_

_Previously updated: October 29, 2026 (TASK-192 fixed; review rounds 1 and 2 applied)_

_Previously updated: October 29, 2026 (TASK-190 fixed, review rounds 1 and 2 applied; TASK-191 filed; round 3, TASK-192 filed)_

_Previously updated: October 29, 2026 (TASK-189 review round 3)_

_Previously updated: October 28, 2026 (TASK-189 filed and fixed)_

_Previously updated: October 28, 2026 (TASK-185 filed and fixed)_

_Previously updated: October 27, 2026 (TASK-184 filed and fixed)_

_Previously updated: October 27, 2026 (TASK-183 — the AI-engineering review process)_

_Previously updated: October 26, 2026 (TASK-182 planned)_

_Previously updated: October 26, 2026 (TASK-180 filed and fixed)_

_Previously updated: October 26, 2026 (TASK-179 filed and fixed)_

_Previously updated: October 26, 2026 (the subject is the Cognito sub — TASK-177 filed and fixed)_

_Previously updated: October 26, 2026 (review 16 of TASK-174/175/176 — every finding fixed)_

_Previously updated: October 25, 2026 (users.email_verified never updated — TASK-176 filed and fixed)_

_Previously updated: October 25, 2026 (a flaky concurrent-resume test — TASK-175 filed and fixed)_

_Previously updated: October 25, 2026 (found deploying Playform v0.9.0 — TASK-174 filed and fixed)_

_Previously updated: October 25, 2026 (gaps found adopting v6.0.0 in Playform — TASK-170–173 filed and fixed)_

_Previously updated: October 24, 2026 (review 14 of the v6.0.0 candidate — TASK-169 filed and fixed)_

_Previously updated: October 24, 2026 (Playform adoption defects — TASK-168 filed and fixed)_

_Previously updated: October 24, 2026 (review 13 of the v6.0.0 candidate — TASK-167 filed and fixed)_

_Previously updated: October 24, 2026 (review 12 of the v6.0.0 candidate — TASK-166 filed and fixed)_

_Previously updated: October 24, 2026 (review 11 of the v6.0.0 candidate — TASK-165 filed and fixed)_

_Previously updated: October 24, 2026 (review 10 of the v6.0.0 candidate — TASK-164 filed and fixed)_

_Previously updated: October 24, 2026 (review 9 of the v6.0.0 candidate — TASK-163 filed and fixed)_

_Previously updated: October 24, 2026 (review 8 of the v6.0.0 candidate — TASK-162 filed and fixed)_

_Previously updated: October 24, 2026 (review 7 of the v6.0.0 candidate — TASK-161 filed and fixed)_

_Previously updated: October 24, 2026 (Sprint 7R close, v6.0.0 — TASK-157–160 filed and fixed; TASK-149 re-checked; every 7R and 7X task's status reconciled to the release)_

_Previously updated: October 24, 2026 (Sprint 7X Wave 2 — TASK-145 Wave 2, TASK-146 and TASK-147 fixed on develop)_

_Previously updated: October 23, 2026 (Sprint 7R R3 — tenancy: TASK-126 implemented, TASK-114 resolved, TASK-146 progress; TASK-150–155 found and fixed)_

_Previously updated: October 23, 2026 (Sprint 7R R2 — integrity fixes: role-model records, ai_metrics, chosen cache, UTC budget day and age; TASK-148, TASK-149)_

_Previously updated: October 22, 2026 (TASK-145 Wave 1 fixed; TASK-138 and TASK-140 fixed in Sprint 7X; TASK-146 and TASK-147 filed — the gaps ASSURANCE.md records)_
_Last updated: August 13, 2026 (TASK-083 filed — the sync cannot distinguish an upstream deletion from a Playform-owned file)_
_Last updated: August 4, 2026 (filed TASK-073 — ADR-030 reserved for AUX; recorded before the phase exit gate rather than after)_
