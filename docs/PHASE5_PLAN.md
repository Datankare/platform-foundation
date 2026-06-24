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
- **k6 re-baseline (dry baseline captured; live deferred → TASK-046, Sprint 7):** dry run vs prod (`playform-inky.vercel.app`, 10 VUs, 1221 reqs) — 0% errors; process p95 76.9ms, stream p95 71.4ms, health p95 149ms; only health p99 tripped on a single ~2s Vercel cold start (benign). A live `DRY_RUN=0` run can't reach moderation/agent paths today — Sprint 3d auth-guards 401 every k6 request (the script sends no auth header), so its "~$5 live" note is stale. Live re-baseline needs an auth-enabled k6 script → **TASK-046** (Sprint 7, phase-exit expectation).
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

### Sprint 2 — Agentic workflow framework (PF)

- `platform/ai/agent.ts`: tool registry (extends the Phase 4 agent runtime), multi-step execution, durable state, rollback (ADR-017 §7).
- Conformance kit; **ADR-029** (Agentic Workflow Framework).

### Sprint 3 — Agent User Experience / AUX (PF)

- Agent-native endpoint contracts over the app-framework + agent workflows: structured `intent` + `nextActions` responses, single-call surfaces, replacing flat human-facing JSON blobs (per `docs/AUX_DESIGN.md`).
- **ADR-030** (Agent User Experience).
- Reflect AUX deliverables into the ROADMAP Phase 5 body (currently only "+ AUX" in the summary row) once AUX_DESIGN.md is worked in full.

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

- RAMPS Phase 5 assessment; **function coverage ≥ 84%** (RAMPS Phase 4 recommendation; currently PF 80.26%).
- PF v1.7.0 tag + GitHub Release; Playform sync + promote.
- **Live k6 re-baseline (TASK-046)** completed against staging — moderation + agent latency captured. Do not close the phase without it.

---

## ADR roster (planned)

| ADR     | Subject                            |
| ------- | ---------------------------------- |
| ADR-028 | Application Framework Architecture |
| ADR-029 | Agentic Workflow Framework         |
| ADR-030 | Agent User Experience (AUX)        |

> Next sequential ADR is **028**. Note: TASK-039's "ADR-021 candidate" tag is stale — ADR-021 is the social system.

---

## Coverage floors

| Repo                | Floor (stmts) |
| ------------------- | ------------- |
| platform-foundation | 88.54%        |
| Playform            | 89.45%        |

Function-coverage target ≥ 84% (phase goal). Coverage must never decrease between sprints.

---

## Standing rules in force this phase

- **L21:** every new app-framework / agent abstraction ships a conformance kit; the meta-test fails CI the moment a registry slot lands without one.
- **L12:** GenAI 18-principle mapping table before any code each sprint.
- **Build order:** PF first; Playform inherits via SHA-pinned auto-sync from PF main. `ROADMAP.md` and `GENAI_ROADMAP.md` are Playform-owned overlays (sync-excluded).
- **GOTCHA-52:** never modify a PF-synced file in Playform — fix in PF first.

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

_Last updated: June 21, 2026 (Phase 5 Sprint 0 closed — k6 dry baseline recorded, live re-baseline deferred to Sprint 7 as TASK-046; GenAI 18-principle mapping; entry gate N1-N8)_
