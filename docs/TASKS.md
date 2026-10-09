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

| Field        | Detail            |
| ------------ | ----------------- |
| **ID**       | TASK-025          |
| **Type**     | Infrastructure    |
| **Severity** | Medium            |
| **Phase**    | Phase 5, Sprint 6 |
| **Target**   | Phase 5, Sprint 7 |
| **Status**   | Open              |
| **Logged**   | 2026-04-16        |

**What:** ECS Fargate public IP changes on task restart.
Add ALB or Elastic IP for stable URL.
Currently using direct IP — acceptable for development,
not production.

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
| **Status**   | Open                                        |
| **Logged**   | 2026-04-24                                  |
| **Source**   | Code: platform/admin/config-approval.ts:425 |

**What:** Add mechanism to expire stale config change
approvals that have not been acted on.

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
Sprint 3d, which added `requireAuthWithStatus` to `/api/process` and `/api/stream`. The
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
own Cognito pool `us-east-1_l5B9bbdFh`, Google client, guest secret and durable stores; `/api/health` 200 at
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

**Resolved (7A A2, PF):** `platform/auth/guest-token.ts` — signed, namespaced, lifetime-bounded guest tokens; PF's Cognito provider delegates to it; `GUEST_TOKEN_SECRET` is in the environment contract (required with a real auth provider). Two obligations carried inside 7A: (1) A3's guest check verifies through `platform/auth/guest-token` directly, never through a provider's `verifyGuestToken`; (2) Playform's own `platform/auth/cognito-services.ts` (sync-excluded; mints `guest_<uuid>_<ms>`, unsigned) delegates to the same module in the Playform commit that follows the v2.7.0 sync — before Playform promotes. `GUEST_TOKEN_SECRET` must be set on `playform-dev` and `playform-staging` before v2.7.0 reaches them.

### TASK-099 — No guest path in the platform auth check, and no guest allowance

| Field        | Detail                                                         |
| ------------ | -------------------------------------------------------------- |
| **ID**       | TASK-099                                                       |
| **Type**     | Auth                                                           |
| **Severity** | Medium — guest mode admits users who then cannot act           |
| **Phase**    | Phase 5                                                        |
| **Target**   | Phase 5, Sprint 7A                                             |
| **Status**   | Resolved — Sprint 7A A3 + B1 (PF); Playform at the v2.7.0 sync |
| **Logged**   | 2026-09-26                                                     |

**What:** `requireAuth` verifies only real-user tokens, so a guest can enter the app but every action is rejected. There is also no bound on what a guest may consume.

**Resolution:** ADR-050 D4: an opt-in guest check for routes that allow guests (translate), namespaced guest actor ids, and a governed per-guest translate allowance (admin-settable, min 1 / default 5 / max 10) enforced before any paid call, with a clear sign-in prompt at the limit.

**Progress (7A A3, PF):** opt-in guest check and namespace done — `requireActor` / `requireActorWithStatus` (`allowGuests` per route; guests verified by `platform/auth/guest-token` only; `sign_in_required` elsewhere; `requireAuth` refuses guest-namespaced subjects). Remaining in 7A: B1 allowance; Playform's `lib/route-guard.ts` adopts `requireActorWithStatus`, and the translate routes opt in together with B1 — never before.

**Resolved (7A B1, PF):** governed `guest.translate_allowance` (migration 037: 1–10, default 5, safety tier, dual control; clamped in code too); `GuestUsageStore` registry slot (`GUEST_USAGE_STORE`, durable required in production, conformance kit); atomic database consume (`guest_allowance_consume`); `enforceGuestAllowance()` before the first paid call, failing closed; `guest.allowance_exhausted` (403, `{limit}`) — the sign-in prompt. PF `/api/process` (was unauthenticated) now authenticates, serves guests and counts them. **Before v2.7.0 reaches Playform:** migration 037 applied to the `playform` database; `GUEST_USAGE_STORE=supabase` on `playform-dev` and `playform-staging`. **Playform commit at the sync:** `lib/route-guard.ts` on `requireActorWithStatus`; its translate routes (`/api/process`, `/api/translate/dispatch`, `/api/translate/session`) opt guests in with `enforceGuestAllowance`; speech, transcription and extraction stay users-only.

### TASK-100 — E2E journey tests pass when the user sees an error

| Field        | Detail                                                    |
| ------------ | --------------------------------------------------------- |
| **ID**       | TASK-100                                                  |
| **Type**     | Test integrity                                            |
| **Severity** | Medium — green CI while users fail                        |
| **Phase**    | Phase 5                                                   |
| **Target**   | Phase 5, Sprint 7A                                        |
| **Status**   | In progress — B2a done (Playform); B2b at the v2.7.0 sync |
| **Logged**   | 2026-09-26                                                |

**What:** The translate journeys wait for the translation card **or any alert**, so they passed while every real user got "Invalid or expired token".

**Resolution:** Assert a real translation result; add explicit error-path and guest-limit journeys (Playform-owned `e2e/`).

**Progress (7A B2a, Playform `ac291cd`, `78efda2`):** journeys assert a real translation (`e2e/helpers/journey.ts` `expectTranslation`: text visible and non-empty, Play button, no app alert); an error-path journey (a coded dispatch failure must show the server message and no result); `__tests__/e2e-journey-integrity.test.ts` fails CI on "result or any alert" or a raw `[role=alert]` locator. Found on the way: a "no error notification" check that looked for a test id no element has (could never fail), and Next.js's route announcer — an always-present, empty `role="alert"` — which any "no alert" check must exclude (`appAlerts()`). **B2b (at the sync):** the guest-limit journey, with the Playform guest wiring.

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

| Field        | Detail                                                  |
| ------------ | ------------------------------------------------------- |
| **ID**       | TASK-102                                                |
| **Type**     | CI integrity                                            |
| **Severity** | High — configuration is untested                        |
| **Phase**    | Phase 5                                                 |
| **Target**   | Phase 5, Sprint 7A                                      |
| **Status**   | In progress — PF done; Playform workflow at the 7A sync |
| **Logged**   | 2026-09-26                                              |

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
| **Status**   | Resolved — Sprint 7A B3 (PF); Playform at the v2.7.0 sync |
| **Logged**   | 2026-09-26                                                |

**What:** Music identification (no provider keys, no audio service) and audio upload are offered on `playform-dev` and fail with "please try again", which can never succeed.

**Resolution:** ADR-050 D3: each optional feature declares its settings; the UI offers it only when they are present.

**Resolved (7A B3, PF):** `platform/features` declares `music_identification` (ACRCloud + a real audio converter), `audio_upload` (speech key + real converter), `speech_input` (speech key) and `teams` (preview); `GET /api/features` returns booleans only; `requireFeature()` answers `feature.not_configured` (501) — retrying cannot succeed. **Playform commit at the sync:** its identify/transcribe routes call `requireFeature`, and the screens hide what `/api/features` reports unavailable. SSO providers join the list in C2.

### TASK-105 — Vercel project-to-branch mapping is undocumented and was wrong

| Field        | Detail                                                                                |
| ------------ | ------------------------------------------------------------------------------------- |
| **ID**       | TASK-105                                                                              |
| **Type**     | Deployment topology                                                                   |
| **Severity** | Medium — the deployed address ran old code                                            |
| **Phase**    | Phase 5                                                                               |
| **Target**   | Phase 5, Sprint 7A                                                                    |
| **Status**   | In progress — topology documented and verified; checked by the smoke test at the sync |
| **Logged**   | 2026-09-26                                                                            |

**What:** `playform-dev` tracked `main`, so its address served v0.5.0 while new code went only to preview addresses. Fixed for `playform-dev` (now `develop`) during 7A; staging and production unverified.

**Resolution:** ADR-050 D6: document and verify `playform-dev` ← develop, `playform-staging` ← staging, production ← main; the smoke test reports the deployed commit.

**Topology (verified 2026-10-08, ADR-050 D6):**

| Vercel project     | Branch    | Address                               | Database (Supabase)                   | Cognito pool          |
| ------------------ | --------- | ------------------------------------- | ------------------------------------- | --------------------- |
| `playform-dev`     | `develop` | `https://playform-dev.vercel.app`     | `playform` (shared with staging)      | `us-east-1_9pRbNsCbE` |
| `playform-staging` | `staging` | `https://playform-staging.vercel.app` | `playform` (shared with dev)          | `us-east-1_9pRbNsCbE` |
| `playform`         | `main`    | `https://playform.datankare.com`      | `playform-prod` (built from baseline) | `us-east-1_l5B9bbdFh` |

`playform-inky.vercel.app` redirects (308) to `playform.datankare.com`. `/api/health` now reports `commit`
(`VERCEL_GIT_COMMIT_SHA`, 12 characters) so the smoke test proves which build each address serves.

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
| **Status**   | Resolved — Sprint 7A A4 (PF); Playform at the v2.7.0 sync |
| **Logged**   | 2026-09-27                                                |

**What:** Every error response is `{ error: "<English sentence>" }` — about 150 distinct messages across PF and Playform routes, plus platform reason strings that reach users. Only `sign_in_required` and `guest_invalid` (7A A3) carry a code; nothing documents any of them. There is no message catalog and no i18n library.

**Resolution:** ADR-051 D1–D3, D5 (a)–(e): catalog infrastructure (`next-intl`, `messages/en.json`, ICU); an error registry (code → status, catalog key, caller guidance); every PF API error on `{ code, message, params }`; `docs/API_ERRORS.md` generated and drift-checked; CI checks that every route error is registered, catalogued and documented; the screen-literal ratchet baseline. Playform's own routes in the Playform commit following the v2.7.0 sync.

**Progress (7A A4a, PF):** `platform/errors` (registry of 39 codes, catalog `messages/en.json`, `apiError`, locale negotiation, ICU rendering), generated `docs/API_ERRORS.md`, CI checks, free-text ratchet at 102. Survey findings carried to A4b: auth failures returned with HTTP 200 (12), 500s echoing internal error text (11), statuses chosen by matching English (7). Playform (sync-excluded `package.json`) must add `intl-messageformat` and the jest ESM transform in the same PR that syncs v2.7.0, or the synced `platform/errors` fails to build there.

**Progress (7A A4b-1, PF):** request-validation, auth-guard (`requireAuth`, `requireActor`, `requirePermission`, admin self-elevation, actor account status), rate-limit, admin and `/api/process` errors on codes; every 500 in them is `internal.error` — the 11 responses that echoed internal error text now log it with a request id and return only the id (`internalError`); the content classifier's reason (which may quote matched terms) goes to the log. Free-text ratchet 102 → 58. Compatibility aliases `success: false` / `error` stay in the body until 7B.

**Progress (7A A4b-2, PF):** moderation and approvals. Services and stores return `errorCode` (+ `errorParams`) with their results (`ReviewResult`, `ConfigApprovalResult`); routes answer with `errorFromResult()`, so no status is chosen by matching English any more (`statusForError`, `appealErrorStatus` removed). Five codes added (`moderation.appeal_not_allowed`, `appeal_reason_too_short`, `appeal_window_expired`, `item_state_conflict`, `approvals.expired`) — 44 in all. A store's database text never reaches a response. Free-text ratchet 58 → 17 (the auth routes, A4b-3).

**Resolved (7A A4b-3, PF):** auth routes on `authResultResponse` — success and challenge steps (MFA, new password, email verification) stay 200; failures return their code and real status (401 wrong credentials, 409 account exists, 429 too many attempts…) instead of HTTP 200; the Cognito provider maps exception types to codes and no Cognito message reaches a client (11 raw-message returns removed); sign-up password failures return `auth.password_policy` with rule ids (`passwordRuleViolations`). Free-text errors: 0, now a hard CI rule. Screen-literal ratchet in place (PF baseline 297). 45 codes in `docs/API_ERRORS.md`.

**At the v2.7.0 sync (Playform commit, in 7A):** `package.json` gains `intl-messageformat` + the jest ESM transform; Playform's own routes (`app/api/auth/**`, translate/tts/transcribe/extract/classify) and `platform/auth/cognito-services.ts` move to codes; its own `screen-literal-baseline.json` (PF's is not synced).

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
| **Target**   | Phase 5, Sprint 7B                                        |
| **Status**   | Open                                                      |
| **Logged**   | 2026-09-29                                                |

**What:** `platform/observability/metrics-sink.ts` reads and writes `ai_metrics` through PostgREST,
but no migration creates `ai_metrics`, and neither the dev database nor the baseline has it. Found
during the TASK-091 audit (the schema-parity script checks store columns, not this sink's table).

**Resolution:** a migration that creates `ai_metrics` (with row-level security and its self-record),
or remove the Supabase sink if metrics stay in Sentry/Langfuse.

### TASK-114 — Every table grants ALL to `anon` and `authenticated`

| Field        | Detail                                                            |
| ------------ | ----------------------------------------------------------------- |
| **ID**       | TASK-114                                                          |
| **Type**     | Security hardening (defense in depth)                             |
| **Severity** | Medium — row-level security is the only barrier for the API roles |
| **Phase**    | Phase 5                                                           |
| **Target**   | Phase 6 (before public launch)                                    |
| **Status**   | Open                                                              |
| **Logged**   | 2026-09-29                                                        |

**What:** Supabase's "automatically expose new tables" grants `ALL` on every `public` table to
`anon` and `authenticated` (the baseline carries dev's grants, and `playform-prod` keeps the option
on for parity). Every table has row-level security, so this is not an open door — but one missing
or wrong policy would be. The platform itself reaches the database only as `service_role`.

**Resolution:** revoke table privileges from `anon` and `authenticated` except where a browser
client needs them (none today), in a migration applied to dev and production alike, then turn the
option off on both projects. The replay job gains a check that no table grants `anon` anything.

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

_Last updated: August 13, 2026 (TASK-083 filed — the sync cannot distinguish an upstream deletion from a Playform-owned file)_
_Last updated: August 4, 2026 (filed TASK-073 — ADR-030 reserved for AUX; recorded before the phase exit gate rather than after)_
