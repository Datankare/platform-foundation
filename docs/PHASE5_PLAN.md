# Phase 5 — Application Framework + AUX

**Objective:** An extensible application framework (`platform/app-framework/`) on which consumers implement their specific app type; a reusable agentic workflow framework; an Agent User Experience (AUX) surface exposing agent-native contracts; plus the Phase 5 GenAI-Native deliverables (adaptive behavior, dynamic content generation, application-specific RAG, multimodal) and content-safety coverage of the new user-generated-content surface.

**Start date:** 2026-06-21
**PF release target:** v1.7.0 (phase close)

---

## Sprint Plan

### Sprint 0 — Entry housekeeping

- **TASK-019:** rename `platform/game-engine/` → `platform/app-framework/` (ADR-001 platform-agnostic naming; placeholder dir, no code yet).
- GenAI **P1–P18 mapping table** (L12) for the phase.
- **N7/N8 ROADMAP edits:** Phase 5 → In Progress, start date, changelog 8.0.0 (applied this session).
- **k6 re-baseline (dry baseline captured; live deferred → TASK-046, Sprint 7):** dry run vs prod (`playform-inky.vercel.app`, 10 VUs, 1221 reqs) — 0% errors; process p95 76.9ms, stream p95 71.4ms, health p95 149ms; only health p99 tripped on a single ~~2s Vercel cold start (benign). A live `DRY_RUN=0` run can't reach moderation/agent paths today — Sprint 3d auth-guards 401 every k6 request (the script sends no auth header), so its "~~$5 live" note is stale. Live re-baseline needs an auth-enabled k6 script → **TASK-046** (Sprint 7, phase-exit expectation).
- **ACRCloud Edge-Runtime warning fix** in PF — isolate the Node-only `createHmac` import from the Edge bundle (handoff carry-in §1).
- **Doc cleanups (PF):** GENAI_ROADMAP changelog reorder + literal `\u2705`/`\u2014` escape glitch in some Phase 2 rows.
- **TASK-045 scheduled:** Playform GENAI_ROADMAP overlay rebase + D3/D4 dual-repo guard.
- **TASKS.md hygiene (done):** TASK-029 (dup of TASK-028), TASK-040, TASK-043 → Resolved; TASK-037 → Open (Phase 5, on the agentic workflow framework, ADR-029); TASK-041 + TASK-042 verified still-open; TASK-044 confirmed correctly tracked in SECURITY_DEBT (Phase 8).
- **Playform Dependabot:** resolve the moderate vulnerability flagged on Playform's default branch (security/dependabot/34); fits the handoff Dependabot thread (item F).

### Sprint 1 — Application framework core (PF)

- `platform/app-framework/`: application lifecycle abstraction, application state management, application session lifecycle, turn-based + real-time application support.
- Conformance kit per new abstraction (**L21**); provider registry slot(s) as needed.
- **ADR-028** (Application Framework Architecture).
- 18-principle mapping before code.

### Sprint 2 — Agentic workflow framework + action lifecycle protocol (PF)

- `platform/ai/agent.ts`: tool registry (extends the Phase 4 agent runtime), multi-step execution, durable state, rollback (ADR-017 §7).
- Conformance kit; **ADR-029** (Agentic Workflow Framework).
- **ADR-031** (Action Identity & Lifecycle Protocol) authored in full, superseding the Sprint 1 stub. ADR-029's propose→approve→commit lifecycle cannot be specified without it — the dedup handles, stale-approval reconciliation, and crash-window repair are its subject matter, so it is a Sprint 2 dependency rather than a parallel deliverable.
- **Scope note:** AUX (ADR-030) was considered for a Sprint 2 start and stays in Sprint 3. AUX wraps the AUX-shaped returns the framework already emits (ADR-028 D7) and has no dependency on ADR-029, whereas ADR-031 blocks it. Deferring AUX also gives the TASK-061 function-coverage ratchet one sprint to work before the phase's largest function-count additions land.
- Process defects due this sprint: **TASK-057** (health endpoint fails open), **TASK-058** (advisory handling), **TASK-059** (prettier version drift), **TASK-060** (PR backlog + branch staleness), **TASK-061** (function-coverage ratchet).

### Sprint 3 — Agent User Experience / AUX (PF)

- Agent-native endpoint contracts over the app-framework + agent workflows: structured `intent` + `nextActions` responses, single-call surfaces, replacing flat human-facing JSON blobs (per `docs/AUX_DESIGN.md`).
- **ADR-030** (Agent User Experience).
- Reflect AUX deliverables into the ROADMAP Phase 5 body (currently only "+ AUX" in the summary row) once AUX_DESIGN.md is worked in full.

### Sprint 3b — AUX implementation + gating, capability, and identity (PF + Playform)

Shipped the agent-native execution stack that Sprint 3's contracts specified:

- **AUX envelope** — every `/api/agent/*` response is a well-formed `AgentResponse<T>`
  (`result` + `trajectory` + `nextActions` + `cost`), validated on the way out by the L21
  conformance kit. Goal (workflow-level) and intent (step-level) kept as distinct names.
- **Gating contract** — a gated step is held (`AgentResponse.held`), the approver is a typed
  `AgentIdentity`, and human review is a policy default in `gating.ts approvalPolicy()`, not
  a welded property. Approval satisfies the gate without bypassing the risk floor.
- **Per-workflow capability enforcement (ADR-030 D9)** — checked up front, three explicit
  states (`none` / `granted` / `denied`, never silent) on `AgentResponse.capabilityCheck`,
  fail-closed. PF owns the seam; the consumer supplies `checkCapability`.
- **Two-principal agent identity (ADR-033, rung 1)** — the acting agent is resolved from a
  verified credential (never a body claim), authorized against a conservative first-party
  allowlist; `AgentIdentity.delegation` added forward-compatibly for rung 2.

Playform consumes this via `/api/agent/process-content` (two-principal: user gate via
`checkAccountStatus` AND agent gate via the rung-1 allowlist).

**Demo deferred to Sprint 3c (acceptance gate).** 3b's exit originally included a Playform
demo UI + A1-A8. A demo faithful to the stack needs live approve/reject with resume and the
admin surfaces that govern policy, capabilities, workflow permissions, and agent identity —
all of which are 3c backend (TASK-087, ADR-033 rung 2). Building it against 3b alone would
have to fake those surfaces. The demo is therefore folded into 3c as its acceptance gate,
where it exercises a real governed backend. Recorded here so the next planner finds it
(GOTCHA-70), not left as an unexplained hole in 3b.

### Sprint 3c — Admin-governed approval policy AND capability definition (PF + Playform)

Sprint 3c makes the 3b gating/capability/identity seams **admin-governed** and proves them
through a working demo. One sprint: four backend tracks + a seven-surface UX track + the
acceptance demo. PF-B owns each abstraction; PF admin follows the existing adminGuard /
admin_* / config-panel pattern; Playform-A extends where required. A1-A8 on every new UI.

**Backend + acceptance deliverables**

| #   | Deliverable                                                                                                                  | Repo             | Depends on                  | Done when                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------- | --------------------------- | ----------------------------------------------------------------------- |
| A1  | Durable approval-policy store — who-may-approve per action class, versioned + reference impl                                 | PF-B             | 3b approvalPolicy() seam    | Store read by the gate at runtime                                       |
| A2  | Approval-policy conformance kit                                                                                              | PF-B             | A1                          | Kit arms; a non-conforming store fails CI                               |
| A3  | Privileged policy mutation — itself a gated, audited commitment action; loosening (human->agent) higher-risk than tightening | PF-B             | A1                          | Mutation gated + audited; loosening carries the higher risk floor       |
| A4  | PF admin route behind new admin_manage_approval_policy scope                                                                 | PF               | A1-A3                       | Route enforces scope; drives the mutation                               |
| B1  | HTTP surface for approveHeldAction / rejectHeldAction                                                                        | PF-B -> Playform | 3b gating.ts                | Held action approved/rejected over HTTP; decision is a typed identity   |
| B2  | Endpoint carries an approval decision and resumes the workflow                                                               | Playform         | B1, 3b workflow loop        | Held workflow resumes on approve, halts on reject; both audited         |
| C1  | PF admin surface to DEFINE capabilities (name + intent) behind new admin_manage_capabilities scope                           | PF               | existing admin_* pattern    | Capabilities definable; scope enforced                                  |
| C2  | Playform admin surface to MAP Playform permissions -> PF capability names (replaces the static CAPABILITY_FEATURES map)      | Playform-A       | C1                          | Mapping editable; static map retired                                    |
| C3  | Third-party integrator docs for the name -> permission mapping workflow                                                      | PF docs          | C1, C2                      | Doc published; external integrator can follow it                        |
| D1  | Agent identity rung 2 — retire the rung-1 allowlist; swap the two seam fns (resolveAgentIdentity, agentAuthorized)           | PF-B -> Playform | 3b AgentIdentity.delegation | Identity resolved from attested credential, not the x-agent-role header |
| D2  | Governed agent registry — which agent identities exist, admin-managed                                                        | PF + Playform    | D1                          | Agents provisioned via admin, not hardcoded                             |
| D3  | Attested delegation flow (OAuth 2.1/PKCE, SPIFFE-style) per ADR-033 rung 2                                                   | Playform         | D1, D2                      | Attested delegation works end to end                                    |
| F1  | Per-account feature restriction via a platform_config row (makes agent_process_content / speak restrictable)                 | Playform         | Supabase migration pattern  | A restricted account is provably denied at the user gate                |
| E   | Acceptance: agent-approver path reachable AND governed end to end                                                            | both             | all above                   | A gated action approved by a governed agent identity, audited, resumed  |

**UX track** — seven new surfaces + a consistency pass, each gated on A1-A8. Extends PF's
existing AdminShell / AdminConfigPanels / AppealForm patterns; survey the admin component
surface at kickoff (same discipline as 3b).

| #   | UX surface                                                                                        | Repo          | Consumes | A1-A8 |
| --- | ------------------------------------------------------------------------------------------------- | ------------- | -------- | ----- |
| U1  | Approval-policy admin panel — view/edit who-may-approve; loosening vs tightening shown distinctly | PF + Playform | A1-A4    | Yes   |
| U2  | Capability definition admin panel — define capability name + intent                               | PF            | C1       | Yes   |
| U3  | Capability -> permission mapping panel                                                            | Playform      | C2       | Yes   |
| U4  | Agent registry admin panel — provision/manage agent identities                                    | PF + Playform | D2       | Yes   |
| U5  | Attestation / consent UX — the delegation flow screens                                            | Playform      | D3       | Yes   |
| U6  | Per-account restriction control — toggle feature restriction on an account                        | Playform      | F1       | Yes   |
| U7  | AgentConsole demo — goal picker, input, three capability states, held -> approve/reject -> resume | Playform      | A-D live | Yes   |
| U8  | Design-system consistency pass — all surfaces reuse existing patterns so A1-A8 is uniform         | PF + Playform | U1-U7    | Yes   |

GenAI anchors: P10 (the control surface for human oversight), P17 (policy change is a
commitment), P4 (loosening is higher-risk), P13 (bounded autonomy governed centrally),
P3/P18 (every change audited and reconstructable).

### Sprint 3c — CLOSE

Closed 2026-09-04. All deliverables shipped; the sprint gate is satisfied.

**Deliverables.** A1–A3 (durable, versioned, admin-mutated approval-policy store) · B/B-gov
(approve/resume path + fail-closed known-feature governance) · C (capability→feature map) ·
D-series (agent identity rung 2: governed trusted-agent registry, RS256 attested delegation,
OAuth 2.1/PKCE consent + minting, governed token TTL, rung-1 header retired — ADR-033) · F1
(per-account feature restriction, orthogonal to status, fail-closed — ADR-034) · the
GenAI-native governance admin (ADR-035) · U1–U8 (all seven governance/consent/console
surfaces + the design-system consistency pass). All ✅.

**Acceptance (E).** The agent-approver path is proven reachable AND governed end to end by
`__tests__/integration-agent-governance.test.ts` — it composes the real seams (agentAuthorized,
evaluateCapability, resolveApprover) and asserts both reachability and that each gate denies
when its precondition fails.

**Coverage ratchet (TASK-061).** Function coverage at close: platform-foundation **92.05%**,
Playform **91.75%** — both well above the ≥84% phase goal, both up from the Sprint 1 floors
(80.68% / 81.18%). Floors ratcheted to the close values (table above). Statement coverage held
throughout (PF 89.23%, Playform 90.5%).

**Release.** Cut as PF **v2.0.0** (tag + GitHub Release), not the v1.7.0 the plan anticipated:
the rung-1 retirement (ADR-033) is a breaking change for any consumer on the old
`x-agent-role` header, so semver required a major bump. Playform synced from PF main and
promoted develop→staging→main. Dependency security advisories cleared in both repos (npm
audit: 0 high, production).

**Documentation.** A complete adopter set added (SETUP_AND_INTEGRATION, ENV_REFERENCE,
AGENT_DELEGATION_GUIDE, MIGRATION_v1_to_v2), the architecture docs (TAD, PLATFORM_ARCHITECTURE,
AGENT_ARCHITECTURE) brought current, a documentation index (docs/README.md), and a
docs-integrity test (`__tests__/docs-integrity.test.ts`) that fails CI if docs drift behind the
code.

**Deferred (correctly, to phase exit — not sprint gate).** The live k6 re-baseline
(**TASK-046**) is a Phase 5 _exit_ gate, not a sprint gate; it remains open for phase close.
Admin-authored workflow composition captured as **FEAT-090** (needs its own ADR).

### Sprint 4 — Adaptive behavior + dynamic content generation (PF)

- LLM-driven adaptive AI behavior framework — consumers implement app-specific logic (opponents, tutors, assistants).
- AI-generated contextual content framework — consumers define content types and templates.

### Sprint 5 — Application-specific RAG + UGC screening (PF)

- Extend the Phase 4 RAG foundation with app-specific knowledge bases + context injection.
- User-generated content screening: route the new input surface through safety middleware (**Standing Rule 11** — no input surface ships unscreened).

### Sprint 6 — Multimodal AI (PF)

- Image/audio input in the provider interface; image generation (ADR-017 §8).
- Depends on **TASK-025** (ALB for ffmpeg-service stable URL) if the audio path leans on ffmpeg-service.

### Sprint 7 — Playform adoption

- Rewire SpikeApp onto `platform/app-framework`; consume the agent-native (AUX) contracts.
- **TASK-045:** rebase + grow Playform's GENAI_ROADMAP overlay; install the D3/D4 dual-repo guard.
- **TASK-046 (phase-exit expectation):** auth-enable `k6/api-load.js` (acquire a test-user JWT; send Bearer on `/process` + `/stream`), then run the live `DRY_RUN=0` re-baseline against **staging** — the first real moderation + agent latency baseline. Required before the Phase 5 exit gate.
- Playform's "game engine abstraction" overlay framing lives here (consumer-side).

### gate — Phase 5 exit (E1–E15)

- RAMPS Phase 5 assessment; **function coverage ≥ 84%** (RAMPS Phase 4 recommendation; PF 80.68% as of Sprint 1 close). Enforced per-sprint by the TASK-061 ratchet rather than checked once here.
- PF v1.7.0 tag + GitHub Release; Playform sync + promote.
- **Live k6 re-baseline (TASK-046)** completed against staging — moderation + agent latency captured. Do not close the phase without it.

---

## ADR roster (planned)

| ADR     | Subject                              |
| ------- | ------------------------------------ |
| ADR-028 | Application Framework Architecture   |
| ADR-029 | Agentic Workflow Framework           |
| ADR-030 | Agent User Experience (AUX)          |
| ADR-031 | Action Identity & Lifecycle Protocol |

> Next sequential ADR is **032** (028 and the 031 stub shipped in Sprint 1). ADR-031 was minted in Sprint 1 as a stub and is authored in full in Sprint 2; it was absent from this roster until then. Note: TASK-039's "ADR-021 candidate" tag is stale — ADR-021 is the social system.

---

## Coverage floors

| Repo                | Floor (stmts) |
| ------------------- | ------------- |
| platform-foundation | 90.52%        |
| Playform            | 90.56%        |

Function-coverage target ≥ 84% (phase goal).

| Repo                | Function floor (Sprint 4 close) |
| ------------------- | ------------------------------- |
| platform-foundation | 91.54%                          |
| Playform            | 91.75%                          |

> **Re-baseline (Sprint 3d close).** PF function coverage moved 92.05% -> 91.24%, not from a
> loss of tested code but from the admin-coverage remediation adding the entire admin surface
> to the coverage denominator (denominator ~4090 -> ~5298). Absolute covered functions rose;
> the percentage dipped because the base grew. The floor is re-baselined to the honest
> 3d-close figure (91.24%) rather than held at a number a coverage-improving change already
> moved. Statement coverage rose to 90.19% and ratchets up (TASK-061).

> **Ratchet (Sprint 4 close).** PF ratchets up to 90.52% statements / 91.54% functions, and
> Playform to 90.56% statements. Playform functions read 91.7% at Sprint-4 close, but the floor
> is **held at 91.75%**: the dip is a sync-denominator effect — the admin surface arrived via PF
> sync, growing Playform's function base — not a loss of tested functions, so 91.75% stays the
> target to climb back to (never lower a floor a coverage-improving change moved).

Coverage must never decrease between sprints — statements **or** functions. Function floors
ratchet up at each sprint close to whatever the sprint achieved, and each sprint's new modules
land at ≥ 84% so the average climbs rather than merely holding (**TASK-061**).

---

## Standing rules in force this phase

- **L21:** every new app-framework / agent abstraction ships a conformance kit; the meta-test fails CI the moment a registry slot lands without one.
- **L12:** GenAI 18-principle mapping table before any code each sprint.
- **Build order:** PF first; Playform inherits via SHA-pinned auto-sync from PF main. `ROADMAP.md` and `GENAI_ROADMAP.md` are Playform-owned overlays (sync-excluded).
- **GOTCHA-52:** never modify a PF-synced file in Playform — fix in PF first.
- **L22:** no task outlives its sprint — a sprint cannot close while an open task is scheduled for a sprint or phase that has already ended. Every open task carries a specific sprint, not a phase-shaped guess.
- **L23:** every promotion to main carries a written PR (Summary / Changes / Gate; root cause + failure mode for fixes).

---

## GenAI 18-Principle Mapping (L12 — Phase 5 pre-code gate)

> Mapped against `docs/GENAI_MANIFESTO.md` before any Phase 5 code (L12). Role legend:
> **Core** = Phase 5 is the primary deliverer · **Extend** = fabric / continued from prior phase ·
> **Advance** = moves a partial principle forward · **—** = no Phase 5 deliverable (reason given).

| #   | Principle                         | Phase 5  | How                                                                                                                                          |
| --- | --------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Intent-Driven Interaction         | Extend   | AUX exposes intent + `nextActions` contracts; adaptive behavior is intent-driven; app-framework sessions accept structured intent            |
| 2   | Agentic Execution Model           | **Core** | `platform/ai/agent.ts` delivers bounded, multi-step, instrumented, interruptible execution (ADR-029) — flips P2 planned → built              |
| 3   | Total Observability               | Extend   | Standing Rule 9: app-framework, agent workflows, AUX endpoints, multimodal calls instrumented day one (model/tokens/latency/cost/trajectory) |
| 4   | Structural Safety by Default      | Extend   | UGC screening routes the new input surface through safety middleware (Rule 11); agent tool calls policy-checked; multimodal inputs screened  |
| 5   | Prompts & Tools as Versioned      | Extend   | New agent tool defs + adaptive/content-gen prompts versioned in the registry; conformance kit per new abstraction (L21)                      |
| 6   | Structured Outputs & Self-Healing | Advance  | Agent tool calls + AUX responses schema-validated; content generation conforms to templates — advances the current partial                   |
| 7   | Provider-Aware Orchestration      | Extend   | Multimodal adds image/audio provider slots; adaptive behavior routes by capability/cost                                                      |
| 8   | Context & Memory Management       | Extend   | Application-specific RAG extends the Phase 4 RAG foundation with app knowledge bases; agent workflows use layered memory                     |
| 9   | Automated Eval & Validation       | Extend   | New adaptive / content-gen prompts require eval datasets + regression runs before ship                                                       |
| 10  | Human Oversight & Control         | Extend   | Agent workflows above the risk threshold require confirm; rollback / override first-class (ties to P17)                                      |
| 11  | Resilient Degradation             | Advance  | Agent workflows + adaptive behavior fall back to deterministic logic when the LLM is unavailable; multimodal degrades                        |
| 12  | Economic Transparency             | Advance  | Agent workflows + multimodal cost-tracked per trajectory; `AgentConfig.budgetConfig` caps; per-user budgets remain Phase 6                   |
| 13  | Control Plane & Governance        | Extend   | Bounded-autonomy policy governs agent execution centrally; full token-budget governance is Phase 6                                           |
| 14  | Self-Improving Feedback Loops     | —        | Phase 7 (feedback loop + quality monitoring). No Phase 5 deliverable — the lone deferred principle.                                          |
| 15  | Agent Identity as Delegation      | **Core** | Agent workflow framework makes the delegation chain + scoped, time-bounded, revocable permissions first-class                                |
| 16  | Cognitive Memory Architecture     | Extend   | Agent workflows use working/episodic/semantic/procedural memory; app-RAG adds resource memory atop Phase 4 user context                      |
| 17  | Cognition-Commitment Boundary     | **Core** | `agent.ts` draft-then-commit: durable, idempotent external actions, approval gates above a risk threshold                                    |
| 18  | Durable Execution Trajectories    | **Core** | `agent.ts` checkpointed, resumable, inspectable multi-step execution + rollback; extends the Phase 4 TrajectoryStore                         |

**Summary:** Phase 5's agentic workflow framework turns **P2 / P15 / P17 / P18** from planned → built and advances the **P6 / P11 / P12** partials; fabric principles (P3 / P4 / P5 / P8 / P10 / P16) are extended to every new surface. **P14** is the only principle with no Phase 5 deliverable (Phase 7). 18/18 accounted for.

---

## GenAI 18-Principle Mapping — Sprint 1 (L12 pre-code gate)

> Mapped against the Sprint 1 deliverables (ADR-028): ActivitySession, ActivityDefinition, state
> store (slot #14), action pipeline (D3), trajectory append (D4), concurrency (D5), turn-based
> core (D6), AUX-shaped returns (D7), session events (D8). Core = Sprint 1 primary deliverer.

| #   | Principle             | Sprint 1 | How                                                                     |
| --- | --------------------- | -------- | ----------------------------------------------------------------------- |
| 1   | Intent-Driven         | Extend   | Actions carry intent; `nextActions` (D7) exposes affordances            |
| 2   | Agentic Execution     | **Core** | Action pipeline (D3) — bounded, instrumented, tiered execution          |
| 3   | Total Observability   | Extend   | Every mutation → trajectory Step (D4); SessionEvent stream (D8)         |
| 4   | Structural Safety     | **Core** | D3 effects-as-capability, risk floors, `max()` — trust nothing declared |
| 5   | Versioned Artifacts   | Extend   | `ActivityDefinition` additive-only contract (D9); state-store kit       |
| 6   | Structured Outputs    | Extend   | AUX-shaped returns (D7) schema-validated                                |
| 7   | Provider-Aware        | Extend   | State store = registry slot #14 (D2), swappable                         |
| 8   | Context & Memory      | Extend   | Versioned session state (D2); trajectory as history (D4)                |
| 9   | Automated Eval        | Extend   | Conformance kit incl. concurrency tests (D5)                            |
| 10  | Human Oversight       | Extend   | Two-phase propose→commit gating (D3); approval-request events (D8)      |
| 11  | Resilient Degradation | Extend   | Conflict reject-to-caller (D5); memory-store fallback (D2)              |
| 12  | Economic Transparency | **Core** | `cost` in every return (D7); most-restrictive budget (D10)              |
| 13  | Control Plane         | Extend   | Risk-policy layer + budget ceilings centrally enforced                  |
| 14  | Feedback Loops        | —        | Phase 7 — no Sprint 1 work                                              |
| 15  | Agent Identity        | **Core** | `ActionContext` carries actor + delegation lineage (D3); one pipeline   |
| 16  | Cognitive Memory      | Extend   | Session state layers; user context reused (Phase 4)                     |
| 17  | Cognition-Commitment  | **Core** | D3 tiered durability; `operationId` propose→commit boundary             |
| 18  | Durable Trajectories  | **Core** | `operationId` spine; checkpointed/reconstructible trajectory (D4/D5)    |

**Summary:** Sprint 1 makes **P2 / P4 / P12 / P15 / P17 / P18** core-structural (built into the
framework, not conventional). P14 is the only gap (Phase 7). 18/18 accounted for.

---

## GenAI 18-Principle Mapping — Sprint 2 (L12 pre-code gate)

> Mapped against the Sprint 2 deliverables before any code (L12): the agentic workflow
> framework (ADR-029 — tool registry over the Phase 4 agent runtime, multi-step execution,
> durable state, rollback, two-phase propose→approve→commit) and the full action identity &
> lifecycle protocol (ADR-031 — five-stage state machine, per-edge dedup, stale-approval
> reconciliation, crash-window repair, external-effect idempotency). Sprint 1 built the
> single-actor action pipeline; Sprint 2 makes it multi-step, resumable, and safe across a
> crash. Core = Sprint 2 primary deliverer.

| #   | Principle             | Sprint 2 | How                                                                       |
| --- | --------------------- | -------- | ------------------------------------------------------------------------- |
| 1   | Intent-Driven         | Extend   | Workflow entry is an intent; `operationId` minted at intent (ADR-031)     |
| 2   | Agentic Execution     | **Core** | ADR-029 multi-step bounded execution — flips P2 planned → built           |
| 3   | Total Observability   | Extend   | Every workflow step appends a trajectory Step (D4); step-level events     |
| 4   | Structural Safety     | **Core** | Risk floors govern each step, not just the call; `max()` across the plan  |
| 5   | Versioned Artifacts   | Extend   | Tool definitions versioned in the registry; ADR-029 conformance kit (L21) |
| 6   | Structured Outputs    | Advance  | Tool calls schema-validated per step; invalid output retried, not trusted |
| 7   | Provider-Aware        | Extend   | Workflow steps route by capability/cost over existing provider slots      |
| 8   | Context & Memory      | Extend   | Durable workflow state across steps; trajectory as resumable history      |
| 9   | Automated Eval        | Extend   | Conformance kit incl. crash/resume + dedup arms (ADR-031 guarantees)      |
| 10  | Human Oversight       | **Core** | Two-phase approve gate above the risk threshold; stale-approval semantics |
| 11  | Resilient Degradation | Advance  | Rollback + crash-window repair; partial completion never silently lost    |
| 12  | Economic Transparency | Extend   | Budget ceilings enforced per step; most-restrictive-wins (D10) per plan   |
| 13  | Control Plane         | Extend   | Bounded-autonomy policy governs multi-step execution centrally            |
| 14  | Feedback Loops        | —        | Phase 7 — no Sprint 2 work                                                |
| 15  | Agent Identity        | **Core** | Delegation lineage carried across every step; scoped, revocable           |
| 16  | Cognitive Memory      | Extend   | Working memory across steps atop Phase 4 user context                     |
| 17  | Cognition-Commitment  | **Core** | ADR-031 makes the propose→commit boundary an explicit state machine       |
| 18  | Durable Trajectories  | **Core** | Checkpointed, resumable, inspectable multi-step execution + rollback      |

**Summary:** Sprint 2 makes **P2 / P4 / P10 / P15 / P17 / P18** core-structural and advances the
**P6 / P11** partials. P14 remains the only gap (Phase 7). 18/18 accounted for.

**Pre-code gate satisfied** — this table precedes any Sprint 2 implementation (L12).

## GenAI 18-Principle Mapping — Sprint 4 (L12 pre-code gate)

> Mapped against Sprint 4's deliverables — the adaptive-behavior framework (ADR-036), the
> content-generation framework (ADR-037), and the prompt-eval harness (ADR-038). Sprints 1–3c
> built and governed the agentic fabric; Sprint 4 rides it onto two generative surfaces and
> builds the eval harness they gate on. Core = Sprint 4 primary deliverer · Extend = fabric
> applied to a new surface · Advance = moves a partial forward · — = no deliverable.

| #   | Principle             | Sprint 4 | How                                                                                                                         |
| --- | --------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | Intent-Driven         | Extend   | Adaptive behavior is context/intent-driven; content requests are structured intent; both emit AUX `nextActions` (ADR-030)   |
| 2   | Agentic Execution     | Extend   | Both run as bounded, instrumented invocations over the `platform/agents/` runtime (ADR-029) — no new execution model        |
| 3   | Total Observability   | Extend   | Every adaptive decision + generation call traced day one — model / prompt-version / tokens / latency / cost / trajectory    |
| 4   | Structural Safety     | Extend   | Generated content routes through output validation + Guardian before it surfaces (ADR-021); adaptive actions policy-checked |
| 5   | Versioned Artifacts   | Extend   | New adaptive prompts + content templates versioned in the prompt registry (ADR-015); conformance kit per abstraction (L21)  |
| 6   | Structured Outputs    | **Core** | Content-gen conforms to consumer templates, schema-validated with a self-healing parse layer; adaptive decisions are typed  |
| 7   | Provider-Aware        | Extend   | Both route by capability / cost over existing provider slots                                                                |
| 8   | Context & Memory      | Extend   | Adaptive behavior consumes session state / user context / Phase-4 RAG; app-specific RAG is Sprint 5                         |
| 9   | Automated Eval        | **Core** | The eval harness (ADR-038) is built this sprint — `prompts/evals/` datasets + CI regression gate; net-new (ADR-017 §4)      |
| 10  | Human Oversight       | Extend   | Adaptive actions above the risk floor hit propose->confirm; generated content can require review (ADR-024)                  |
| 11  | Resilient Degradation | Advance  | Both degrade to deterministic logic when the LLM is down — adaptive -> scripted, content-gen -> static templates            |
| 12  | Economic Transparency | Extend   | Adaptive + generation cost-tracked per trajectory; `budgetConfig` caps enforced; per-user budgets remain Phase 6            |
| 13  | Control Plane         | Extend   | Governance admin (ADR-035) governs adaptive execution; content types / templates are governed artifacts                     |
| 14  | Feedback Loops        | —        | Phase 7 — no Sprint 4 work                                                                                                  |
| 15  | Agent Identity        | Extend   | Adaptive behavior acts under a delegated, scoped, revocable identity (rung-1/2 from 3b/3c) — no new identity mechanism      |
| 16  | Cognitive Memory      | Extend   | Adaptive behavior uses within-session working memory; resource memory and cross-session learning are deferred               |
| 17  | Cognition-Commitment  | Extend   | Generated content is held as a draft until validated / committed — no unvalidated output leaks (ADR-031 boundary)           |
| 18  | Durable Trajectories  | Extend   | Adaptive sequences + generation runs append to the checkpointed, inspectable trajectory                                     |

**Summary:** Sprint 4 rides the finished agentic fabric onto two generative surfaces and builds
the eval harness they gate on. **P6 / P9** are core — structured-by-construction output, and the
net-new eval harness (ADR-038). **P11** advances (deterministic fallback in both frameworks).
P14 remains the only gap (Phase 7). 18/18 accounted for.

**Pre-code gate satisfied** — this table precedes any Sprint 4 implementation (L12).

## GenAI 18-Principle Mapping — Sprint 3d (L12 pre-code gate)

> Sprint 3d — Agent Registry Unification (ADR-039), promoted from Track F to its own sprint (renamed from "Sprint 4b" so it orders correctly between 3c and 4; distinct from Phase 4's own Sprint 4b, which wired the social/input agents):
> register every agent so `listAgents()` is the single source of truth, run every agent on the
> governed runtime (no bespoke loops), enforce that with a CI guard, and add dual-control — a
> runtime hold + independent human approver on a named catastrophic config subset — surfaced
> GenAI-native in the admin (ADR-040). Core = primary deliverer · Extend = fabric applied to a
> new surface · Advance = moves a partial forward · — = no deliverable.

| #   | Principle             | Sprint 3d | How                                                                                                                              |
| --- | --------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Intent-Driven         | Extend    | Admin config-as-conversation via the command bar; holds/approvals surface as AUX nextActions                                     |
| 2   | Agentic Execution     | **Core**  | Every agent runs on the governed runtime (executeAgent / invokeTool); zero bespoke loops                                         |
| 3   | Total Observability   | Extend    | All agents' steps now on the runtime trajectory (was hand-rolled or absent)                                                      |
| 4   | Structural Safety     | Extend    | Dual-control raises effectiveRisk on a named catastrophic key set -> runtime hold before commit                                  |
| 5   | Versioned Artifacts   | Extend    | Approval policy + dual-control key set are admin-governed and versioned / audited                                                |
| 6   | Structured Outputs    | —         | Sprint 4 proper (ADR-037)                                                                                                        |
| 7   | Provider-Aware        | —         | No deliverable                                                                                                                   |
| 8   | Context & Memory      | —         | No deliverable                                                                                                                   |
| 9   | Automated Eval        | —         | Sprint 4 proper (ADR-038)                                                                                                        |
| 10  | Human Oversight       | Advance   | Dual-control: independent human approver on catastrophic changes + GenAI-native held-actions / approvals admin surface (ADR-040) |
| 11  | Resilient Degradation | —         | No deliverable                                                                                                                   |
| 12  | Economic Transparency | Extend    | Budget ceilings now enforced on the newly-registered agents                                                                      |
| 13  | Control Plane         | **Core**  | `listAgents()` is the single source of truth; admin-governed approval policy + dual-control; the D5 zero-bespoke CI guard        |
| 14  | Feedback Loops        | —         | Phase 7                                                                                                                          |
| 15  | Agent Identity        | Extend    | Every agent now carries a registered identity + budget                                                                           |
| 16  | Cognitive Memory      | —         | No deliverable                                                                                                                   |
| 17  | Cognition-Commitment  | Extend    | Held actions are the commit gate; a catastrophic change is held until approved                                                   |
| 18  | Durable Trajectories  | Extend    | Every agent appends to the checkpointed runtime trajectory                                                                       |

**Summary:** Sprint 3d unifies the agent registry and puts every agent on one governed execution
model. **P2 / P13** are core — single roster + one runtime, made binding by the D5 zero-bespoke
guard. **P10** advances via dual-control: a runtime hold + independent human approver on a named
catastrophic config subset, surfaced GenAI-native in the admin (ADR-040). The generative
principles (P6–P9) belong to Sprint 4 proper and are out of scope here.

**Pre-code gate satisfied** — this table precedes any remaining Sprint 3d implementation (L12).

### Sprint 3d — CLOSE

All deliverables shipped. Agent Registry Unification (ADR-039): one registry as the single
source of truth, every agent on the governed runtime, a zero-bespoke CI guard, Guardian
fails closed. Escalation SLA + remedial reaper (ADR-041): config, mechanism, conformance kit,
and the authenticated invocation route. Held-action & dual-control admin (ADR-040): the
`safety_approver` role (migration 034), the unified approvals surface, the decision route with
server-side enforcement, dual-control-keys management, and approve-by-conversation behind a
mandatory confirm.

**Admin coverage remediation.** The admin surface (services + every route + handlers + tool
schemas) was brought into the coverage map with zero blanket ignores; floors ratcheted to
statements 88 / lines 90 / functions 90 / branches 76. Close metrics: 218 suites, 2,730 tests,
90.19% statements / 91.24% functions / 77.38% branches.

**Release.** Cut as PF **v2.1.0** (minor — no breaking change; tag + GitHub Release). Promoted
develop→staging→main; Playform inherits on the next foundation sync.

Status at open: F1 (Sentinel) and F2a (both planners registered) already landed; F2b/F2c
(execution reroute + dual-control), F3 (Conductor + processing units), F4 (the guard + process
Gotchas) and F5 (AGENT_ARCHITECTURE backfill + naming) remain.

### Sprint 4 — OPEN

Opened 2026-09-04; resumed after the Sprint 3d detour. Objective: two LLM-driven generative
frameworks — adaptive behavior (ADR-036) and dynamic content generation (ADR-037) — plus
the prompt-eval harness (ADR-038) they both gate on.

**Entry gates satisfied.** Sprint 3d CLOSED (PF v2.1.0 → v2.1.1); the L12 GenAI 18-principle
mapping for Sprint 4 is recorded and complete (18/18; P6 and P9 core); enforced coverage
floor stmts 88 / lines 90 / funcs 90 / branches 76 (3d ratchet) — Sprint 4 holds or improves
it; scope locks in force — reference impls only, within-session memory only, UGC screening is
Sprint 5, multimodal is Sprint 6, Playform adoption is Sprint 7.

**Sequencing: ADR-038 first** (neither framework ships a prompt without an eval). ADR-038 is
**Accepted** — a deterministic record-replay CI gate plus a non-gating live lane, with
enum-exhaustive / fail-closed / boundary / adversarial fixture coverage mechanically enforced
by the conformance meta-test, and registry completeness enforced as a precondition (only 2 of
~10 prompt files are currently registered). ADR-036 is **Accepted** (adaptive behavior framework: consumer-implements seam on the
ADR-039 runtime, mandatory deterministic fallback, within-session memory as a typed slice of
the ActivityStateStore per D6a, effects via the D3 pipeline, eval-gated by ADR-038; the
reuse-the-session-store vs dedicated-store tradeoff is recorded in the ADR). ADR-037 remains
Proposed, authored after its Curator/prompt-registry pre-code survey.

**Pre-code gate satisfied** — the L12 Sprint-4 table (above) precedes any Sprint 4
implementation.

---

_Last updated: July 26, 2026 (Phase 5 Sprint 2 opened — L12 mapping recorded as the pre-code gate; ADR-031 promoted into the roster and into Sprint 2 scope; AUX/ADR-030 confirmed in Sprint 3; function floors added per TASK-061)_

_Last updated: August 18, 2026 (Phase 5 Sprint 3b close — Sprint 3b section added recording the AUX/gating/capability/identity stack as shipped; the demo UI + A1-A8 folded into Sprint 3c as its acceptance gate)_

_Last updated: August 18, 2026 (Phase 5 Sprint 3c scoped — the 3c body replaced with backend + acceptance and UX deliverable tables; F1 per-account restriction folded in; one sprint, no split)_

_Last updated: September 10, 2026 (Phase 5 Sprint 3d CLOSE — ADR-039 registry unification + ADR-040 dual-control admin + ADR-041 escalation reaper shipped; admin surface brought fully into the coverage map, floors ratcheted (stmts 88 / lines 90 / funcs 90 / branches 76); PF released as v2.1.0 (minor); Sprint 4 (adaptive behavior + content generation, ADR-036/037/038) is next)_

_Last updated: September 14, 2026 (Phase 5 Sprint 4 OPEN — entry gates verified (3d closed, L12 recorded, floor + scope locks); ADR-038 prompt-eval harness authored and Accepted as the sprint's first deliverable — deterministic record-replay gate + enforced comprehensive fixtures; ADR-036/037 remain Proposed pending their pre-code surveys)_

_Last updated: September 4, 2026 (Phase 5 Sprint 3c CLOSE — all deliverables + E acceptance shipped; function-coverage floors ratcheted to 92.05% / 91.75% per TASK-061; PF released as v2.0.0 (major, breaking rung-1 retirement) + Playform synced/promoted; adopter docs + docs-integrity guardrail added; live k6 (TASK-046) remains a phase-exit gate)_

_Last updated: September 4, 2026 (Phase 5 Sprint 4 opened — L12 mapping recorded as the pre-code gate; ADR-036 / 037 / 038 reserved as Proposed and indexed in TAD; adaptive memory scoped within-session, cross-session deferred; P9 eval harness net-new this sprint)_

_Last updated: September 6, 2026 (Phase 5 Sprint 3d opened — Agent Registry Unification (ADR-039) promoted from Track F to its own sprint; L12 mapping recorded; ADR-040 reserved for the GenAI-native held-action / dual-control admin surface; dual-control going live; F1 + F2a already landed)_

_Last updated: September 19, 2026 (Phase 5 Sprint 4 CLOSE — adaptive behavior (ADR-036) + dynamic content generation (ADR-037) frameworks shipped on the ADR-038 eval harness; screened, fail-closed content generation with L21 conformance kits; enforced coverage floor held at stmts 88 / lines 90 / funcs 90 / branches 76 (actual 90.52 / 91.56 / 91.54 / 77.77); PF released as v2.2.0 (minor). Sprint 5 (RAG + UGC input screening) is next)_

## GenAI 18-Principle Mapping · Sprint 5 (L12 pre-code gate)

> Mapped against Sprint 5's deliverables — application-specific RAG (ADR-042) extending the
> Phase-4 RAG foundation, and UGC input-surface screening (ADR-043) under Standing Rule 11.
> Core = Sprint 5 primary deliverer · Extend = fabric applied to a new surface ·
> Advance = moves a partial forward · — = no deliverable.

| #   | Principle             | Sprint 5 | How                                                                                                                         |
| --- | --------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | Intent-Driven         | Extend   | Retrieved app-context sharpens intent resolution; the screened input surface is the intent front door                       |
| 2   | Agentic Execution     | Extend   | Retrieval + input screening run as bounded, instrumented steps over the existing runtime — no new execution model           |
| 3   | Total Observability   | Extend   | Every retrieval (query / k / scores / tokens / latency) and every input-screen verdict traced day one                       |
| 4   | Structural Safety     | **Core** | UGC input screening routes user input through the Guardian before it reaches a model (Rule 11 — no input ships unscreened)  |
| 5   | Versioned Artifacts   | Extend   | New retrieval / screening prompts + knowledge-base schemas versioned in the registry; conformance kit per abstraction (L21) |
| 6   | Structured Outputs    | Extend   | Retrieval results + screen verdicts are typed and schema-validated; malformed retrieval fails closed                        |
| 7   | Provider-Aware        | Extend   | App-RAG routes embedding / retrieval over existing EmbeddingProvider slots by capability / cost                             |
| 8   | Context & Memory      | **Core** | App-specific RAG extends the Phase-4 foundation with app knowledge bases + budget-aware injection — the primary surface     |
| 9   | Automated Eval        | Extend   | New retrieval + screening prompts carry eval datasets + CI regression before ship (ADR-038 harness)                         |
| 10  | Human Oversight       | Extend   | Blocked / escalated input routes to the review queue (ADR-024); retrieval provenance is inspectable                         |
| 11  | Resilient Degradation | Advance  | RAG degrades to no-context generation when retrieval is down rather than failing the turn; screening fails closed           |
| 12  | Economic Transparency | Extend   | Retrieval + embedding cost-tracked per trajectory; context injection is budget-aware (Phase-4 injector)                     |
| 13  | Control Plane         | Extend   | Knowledge bases + screening policy are governed artifacts under the governance admin (ADR-035)                              |
| 14  | Feedback Loops        | —        | Phase 7 — no Sprint 5 work                                                                                                  |
| 15  | Agent Identity        | Extend   | Retrieval + screening act under the caller's delegated, scoped identity — no new identity mechanism                         |
| 16  | Cognitive Memory      | Extend   | App-RAG adds **resource memory** (app knowledge bases) atop the Phase-4 user-context store                                  |
| 17  | Cognition-Commitment  | Extend   | Screened, retrieved context informs generation but is not itself a committed action; the boundary is unchanged              |
| 18  | Durable Trajectories  | Extend   | Retrieval calls + screen verdicts append to the checkpointed, inspectable trajectory                                        |

**Summary:** Sprint 5 extends the agentic fabric onto two surfaces — retrieval-grounded context
(**P8** Core, app knowledge bases atop Phase-4 RAG) and a screened input front door (**P4** Core,
Standing Rule 11 made structural). **P11** advances (RAG degrades to no-context; screening fails
closed); **P16** gains resource memory. **P14** remains the lone gap (Phase 7). 18/18 accounted for.

**Pre-code gate satisfied** — this table precedes any Sprint 5 implementation (L12).

### Sprint 5 — CLOSE

_Last updated: September 22, 2026 (Phase 5 Sprint 5 CLOSE — application-specific RAG (ADR-042) and
UGC input-surface screening (ADR-043) shipped, both Accepted. ADR-042: a store-agnostic isolation
contract with named-dimension scope, the KB registry, in-memory and durable Supabase/pgvector
stores with app-layer scope enforcement (optional RLS backstop), the store-agnostic no-leak L21
kit, and the curator reference KB registered on the boot path. ADR-043: input screening made
structural and fail-closed at both enforcement points — ingestion (data-poisoning) and query
(prompt-injection) — on the provider-agnostic screenContent seam, with an L21 conformance kit.
Enforced coverage floor held at stmts 88 / lines 90 / funcs 90 / branches 76 (actual 90.52 / 91.56
/ 91.54 / 77.77). PF released as v2.3.0 (minor).)_

### Sprint 6 — OPEN

_Last updated: September 23, 2026 (Phase 5 Sprint 6 OPEN — entry gates verified (Sprint 5 CLOSED, PF v2.3.0 released + Playform v0.3.0 synced; coverage floor + scope locks hold); the L12 18-principle mapping is recorded below against the manifesto **tenet text** (not principle names). ADR-044 (multimodal provider interface), ADR-045 (governed image generation), ADR-046 (multimodal content safety), and ADR-047 (multimodal provenance & synthetic-media detection) reserved as Proposed and indexed in TAD; each authored in full after its pre-code survey. Design constraint: 044/045/046/047 consume one write-once multimodal substrate (content model, provider-capability descriptor, cost/observability seam, screenModality seam, provenance seam) and reuse the ADR-040/041 held-action risk/policy engine — no per-ADR reimplementation. Governed generation: every image is a committed effect (draft -> screen -> risk-classify -> admin-policy route: auto-commit low-tier / held-for-Confirm high-tier -> commit); safety axes (NSFW, real-person likeness, synthetic-origin) independently tunable; CSAM and real-person sexual imagery hard-refused above the tier system, non-configurable. Depends on TASK-025 (ffmpeg-service ALB) if the audio path leans on ffmpeg-service.)_

## GenAI 18-Principle Mapping — Sprint 6 (L12 pre-code gate)

> Mapped against `docs/GENAI_MANIFESTO.md` (**tenet text**, not principle names) before any Sprint 6 code (L12):
> multimodal input (ADR-044), governed image generation (ADR-045), multimodal content safety (ADR-046), and
> provenance / synthetic-media detection (ADR-047).
> Core = Sprint 6 primary deliverer — Extend = fabric applied to a new surface —
> Advance = moves a partial forward — — = no deliverable.

| #   | Principle             | Sprint 6 | How                                                                                                                          |
| --- | --------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1   | Intent-Driven         | Extend   | Image/audio enter as first-class inputs; the input conductor classifies modality into structured intent                      |
| 2   | Agentic Execution     | —        | No Sprint 6 deliverable (agentic runtime shipped Sprint 2)                                                                   |
| 3   | Total Observability   | Extend   | Every multimodal + generation call records model / modality / tokens / latency / cost, plus provenance + detection signals   |
| 4   | Structural Safety     | **Core** | Multimodal inputs screened in-pipeline; generated images screened before commit; fail-closed; hard-refuse invariants (046)   |
| 5   | Versioned Artifacts   | Extend   | Image-generation prompts versioned in the registry; a conformance kit per new multimodal abstraction (L21)                   |
| 6   | Structured Outputs    | Extend   | The generation request contract + the C2PA provenance manifest are schema-validated structured outputs (047)                 |
| 7   | Provider-Aware        | **Core** | Provider interface gains per-modality input + image-gen slots; capability/cost routing; managed variance; degrades (044)     |
| 8   | Context & Memory      | —        | No Sprint 6 deliverable (application-specific RAG shipped Sprint 5)                                                          |
| 9   | Automated Eval        | Extend   | New multimodal + image-gen prompts carry eval datasets + CI regression before ship (ADR-038 harness)                         |
| 10  | Human Oversight       | Extend   | High-risk-tier generations held for explicit human Confirm via the ADR-040 dual-control path; admin RBAC over the policy     |
| 11  | Resilient Degradation | Advance  | Multimodal degrades to text-only when a modality provider is unavailable rather than failing the turn                        |
| 12  | Economic Transparency | Advance  | Image/audio input tokens + generation units tracked per request/user/feature; generation under orchestration-layer budgets   |
| 13  | Control Plane         | Extend   | Risk-tier -> commit-path policy, category overrides, and hard-refuse invariants are central admin config, separate from app  |
| 14  | Feedback Loops        | —        | Phase 7 — the lone deferred principle; no Sprint 6 work                                                                      |
| 15  | Agent Identity        | —        | No Sprint 6 deliverable                                                                                                      |
| 16  | Cognitive Memory      | —        | No Sprint 6 deliverable                                                                                                      |
| 17  | Cognition-Commitment  | **Core** | Image generation spends money + creates a durable artifact -> draft-then-commit, idempotent, approval-gated above risk (045) |
| 18  | Durable Trajectories  | Extend   | Multimodal calls + generation commits (modality, cost, verdicts, provenance) append to the inspectable trajectory            |

**Summary:** Sprint 6 delivers **P7** (per-modality provider interface + routing), **P4** (the new multimodal
surface screened both directions, fail-closed, with hard-refuse invariants), and **P17** (image generation as a
committed, idempotent, approval-gated effect) as Core. **P11 / P12** advance (degradation + per-modality cost).
**P6 / P10 / P13** are earned by the tenet text (provenance manifest / held-action Confirm / admin policy), not
asserted. **P2 / P8 / P14 / P15 / P16** have no Sprint 6 deliverable (—). 18/18 accounted for.

**Pre-code gate satisfied** — this table precedes any Sprint 6 implementation (L12).
