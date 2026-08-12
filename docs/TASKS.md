# Task Registry

Non-security functional tasks: refactors, features, infrastructure, technical debt.
Security-specific items live in SECURITY_DEBT.md.

---

## Open Items

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
| **Target**   | Phase 5, Sprint 6 |
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

| Field        | Detail                                |
| ------------ | ------------------------------------- |
| **ID**       | TASK-058                              |
| **Type**     | CI / supply-chain process             |
| **Severity** | Medium — recurring manual toil + risk |
| **Phase**    | Phase 5, Sprint 2                     |
| **Target**   | Phase 5, Sprint 4                     |
| **Status**   | Open                                  |
| **Logged**   | 2026-07-24                            |

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

| Field        | Detail                                                       |
| ------------ | ------------------------------------------------------------ |
| **ID**       | TASK-070                                                     |
| **Type**     | Dependency hygiene                                           |
| **Severity** | Medium — the failure mode is silent and points the wrong way |
| **Phase**    | Phase 5, Sprint 2                                            |
| **Target**   | Phase 5, Sprint 4                                            |
| **Status**   | Open                                                         |
| **Logged**   | 2026-08-04                                                   |

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
| **Status**   | Open — reserved                            |
| **Logged**   | 2026-08-04                                 |

**What:** `docs/adr/` runs 029 → 031. ADR-030 is reserved for AUX (Agent-Usable eXperience),
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

### TASK-075 — Durable stores are not switched on

| Field        | Detail                                                        |
| ------------ | ------------------------------------------------------------- |
| **ID**       | TASK-075                                                      |
| **Type**     | Deployment configuration                                      |
| **Severity** | High — Sprint 2's durability work is inert until this is done |
| **Phase**    | Phase 5, Sprint 3a                                            |
| **Target**   | Phase 5, Sprint 3a                                            |
| **Status**   | Open                                                          |
| **Logged**   | 2026-08-11                                                    |

**What:** `TRAJECTORY_STORE`, `BUDGET_STORE`, `PROPOSAL_STORE`, `EFFECT_LEDGER` and
`APP_STATE_STORE` are unset, so every one falls back to its in-memory implementation.
Trajectories, budgets, held proposals and the effect ledger do not survive a request.

Until ADR-032 this could not have been fixed by setting them: the registry was writing to a
bundle copy no route read, so the value would have been ignored anyway. Now it can.

**Consequence while open:** agent runs leave no durable trace, the daily spend cap resets on
every request rather than accumulating (the exposure TASK-063 was filed for, reintroduced by
a different route), and held proposals cannot be approved by a later request.

**Resolution:** set the five variables to `supabase` in the deployment environment, redeploy,
and verify against the running build rather than the dashboard:

```
curl -s https://<host>/api/health | python3 -m json.tool
```

with the startup self-check from commit 2 logging the resolved provider for each slot.

**Close when:** a trajectory written by one request is readable by another.

---

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

_Last updated: August 12, 2026 (TASK-081 filed — CodeQL on Playform deferred on cost at $30/month, not overlooked)_
_Last updated: August 4, 2026 (filed TASK-073 — ADR-030 reserved for AUX; recorded before the phase exit gate rather than after)_
