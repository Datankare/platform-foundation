# ADR-030 — Agent User Experience (AUX)

**Status:** Accepted
**Date:** 2026-08-14
**Decision Makers:** Raman Sud

Reserved in the Phase 5 ROADMAP changelog at phase open and left unwritten through Sprints 1–3a (GOTCHA-70). Authored here in full. `docs/AUX_DESIGN.md` is the design record; this ADR is the decision record, and ratifies the choices that document reaches.

---

## Context

Phase 5 built an application framework (ADR-028), an agentic workflow framework (ADR-029), and an action identity & lifecycle protocol (ADR-031). What it did not build is an interface an agent can use to drive them. The endpoints Playform exposes — `/api/extract`, `/api/identify`, `/api/process`, `/api/tts` — are human-facing: an agent must chain three or four of them, parse React-shaped JSON, and handle per-step failure itself.

The AUX_DESIGN document, written in April before any of the Phase 5 framework existed, described AUX as a wrapper over the Phase 3 voice pipeline. It was rewritten in Sprint 3b onto the app-framework. This ADR records the decisions that rewrite settled, so they are citable and gate-checkable rather than living only in a design narrative.

Two forces are in tension and the ADR must resolve them without picking a side:

- **Agent-centricity** wants the platform to expose state and affordances and let the agent decide the next step — choreography. This is what makes the system one an agent runs, not a script with an LLM caller.
- **Operational reality** wants a caller that does not want to spend tokens walking four round trips — a batch job, a latency-sensitive path — to accomplish a whole workflow in one call — orchestration.

Resolving that tension by building two code paths would create two safety regimes, and the faster one would be the one that skips gates. That is the shape of the defect ADR-032 documented.

---

## Decision

### D1 — Two intent layers, named apart: `goal` and `intent`

The request field an agent sets is **`goal`** — the workflow it wants accomplished (`identify-song`, `translate-and-speak`, `full-pipeline`, `analyze`). The per-step semantic the provider layer already emits — `IDENTIFY_INTENT = "inform"`, the voice pipeline's `STEP_INTENT_MAP` — stays **`intent`** and is not renamed.

The April draft called both `intent`. Renaming the request field to `goal` is the one breaking change AUX introduces, and it exists so the workflow layer and the step layer never collide in code or in an agent's reasoning. `goal` names what was asked; `intent` annotates what each internal step is doing.

### D2 — Choreography is the primitive; orchestration is a convenience over it

The platform runs a workflow two ways, and they are the **same machinery**:

- **Choreography** — each step returns its result plus `nextActions`; the agent picks the next hop. The stepwise goals (`identify-song`, `translate`, `transcribe`, `speak`) are the primitives.
- **Orchestration** — `full-pipeline` runs the identical step sequence server-side, against the same trajectory, and returns the final result plus the complete `nextActions` and trajectory.

`full-pipeline` is not a second implementation. It is the choreographed loop run to completion instead of across round trips. The step sequence is defined once, in PF-B, and has two entry points.

### D3 — `nextActions` is always present, including on an orchestrated return

A completed `full-pipeline` hands back affordances (`translate-more`, `respond`, `done`) exactly as a choreographed step does. An agent surface that dead-ends is an RPC. `nextActions` non-empty (terminal actions count) is a response invariant, not a per-endpoint choice.

### D4 — The orchestrated path must not skip the gates

Every step, whether reached by choreography or run inside `full-pipeline`, applies the same risk floor (ADR-031), the same budget check, the same content-safety screening on the new input surface (Standing Rule 11), and the same trajectory append. There is no fast path that trades a gate for latency. This is the load-bearing safety decision: without it, D2's "same machinery" claim is false and the orchestrated path is the unsafe regime.

### D5 — The response envelope is fixed and enforced

Every `/api/agent/*` response is `AgentResponse<T>` — `result` + `trajectory` + `nextActions` + `cost` — validated on the way out. The data already exists: providers emit `estimatedCostUsd` and thread `trajectoryId`/`stepIndex`; the human routes discard it. AUX stops discarding it. Enforcement is a runtime conformance kit (L21), not a review checklist.

### D6 — The PF-B / Playform-A boundary

The agent contract and the workflow orchestration are **platform (PF-B)** work, built first: the `goal` + `nextActions` contracts, the workflow loop, `/api/agent/capabilities`, and the gating contract that expresses a held action (ADR-031) to an agent caller. The **consumer (Playform-A)** endpoint that exposes the workflow — `/api/agent/process-content` — is built second and wraps the pipeline. The provider calls themselves stay in Playform's `platform/voice` module and are not rebuilt; the A-layer stops discarding what they emit.

### D7 — Song identification is a first-class goal

`identify-song` is a primitive goal, not a mode hidden inside `analyze`. `/api/identify` resolves to a single `SongMatch | null` (no candidate list; `matched: false` is a normal result, not an error — P11), so the `nextActions` branch after identify is binary: matched → offer `translate`/`speak`; not matched → offer `retry`/`done`. The demo's hum → identify → translate → speak chain is the composition of `identify-song` then the returned affordances, or one `full-pipeline` call — the same steps either way (D2).

### D8 — Capabilities are discoverable, not documented

`GET /api/agent/capabilities` enumerates the goals, their params, cost and latency ranges, languages, limits, and resolved provider names, from the registry and health probes the platform already runs. A new agent self-configures against it rather than against prose. It is the machine-readable form of this ADR's goal vocabulary.

---

## Invariants

- Exactly one workflow definition backs both the choreographed and orchestrated paths (D2).
- A `full-pipeline` trajectory shows the same gated steps as the equivalent choreographed sequence (D2, D4). This is checkable by comparing trajectories, and is the proof the two paths are one machine.
- Every `/api/agent/*` response carries `result` + `trajectory` + `nextActions` + `cost` (D5).
- `nextActions` is never empty; a terminal state is expressed as `done`, not as absence (D3).
- No agent-facing step executes without its risk, budget, safety, and trajectory gates (D4).
- `goal` is request-level; `intent` is step-level; neither name is used for the other (D1).

---

## Consequences

The demo is expressible two ways from one implementation, and the choreographed form makes "`nextActions` driving the next step" literally visible — the demo's headline.

`full-pipeline` gives batch and latency-sensitive callers a one-call path without a parallel codebase and without a weaker safety posture. The cost is that the workflow loop must be written so its steps are individually gated and individually appended even when run server-side in one call — the loop cannot take shortcuts its choreographed form would not.

The `goal`/`intent` rename touches every agent request example and the capabilities contract. It is a deliberate one-time cost taken now, while the surface has no external consumers, precisely to avoid the collision the April draft's single `intent` would have caused once agents started reasoning over it.

Deferring `/api/agent/respond` and `/api/agent/batch` to a later sprint (recorded in AUX_DESIGN, not dropped) keeps Sprint 3b to the demo's critical path: the workflow loop, the four primitive goals plus `full-pipeline`, capabilities, and the conformance gate.

---

## Conformance requirements (L21)

A response-conformance kit asserts, for every `/api/agent/*` endpoint:

1. **One-call** — an orchestrated goal completes its whole workflow in one call.
2. **Envelope** — the response is a well-formed `AgentResponse<T>`; missing `result`, `trajectory`, `nextActions`, or `cost` fails CI.
3. **NextActions** — present and non-empty; every `action` names a reachable goal or a terminal.
4. **Cost** — `cost.estimatedCostUSD` is numeric and is the sum of the steps' `estimatedCostUsd`.
5. **Trajectory** — `trajectory.trajectoryId` resolves to a durable record (TASK-075a) with one step per gated action.
6. **Gate parity** — a `full-pipeline` run and its choreographed equivalent produce trajectories with the same gated steps. This is the mechanical proof of D2/D4.
7. **Budget** — a `budgetMaxUSD` ceiling is respected and reported.
8. **Discoverability** — every implemented goal appears in `/api/agent/capabilities` (D8).

Gate 6 is the one that cannot be satisfied by inspecting a single response — it compares two runs — and it is the one that keeps orchestration from silently diverging from choreography.

---

## GenAI 18-Principle Mapping — completed (L12)

> The AUX_DESIGN Sprint 3b stub carried the load-bearing rows. This is the complete mapping; 18/18 accounted for before code.

| #   | Principle             | Role     | How                                                                                             |
| --- | --------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| 1   | Intent-Driven         | **Core** | `goal` is the request; `nextActions` enumerates affordances (D1, D3)                            |
| 2   | Agentic Execution     | **Core** | Bounded, instrumented, interruptible workflow loop; choreography exposes checkpoints (D2)       |
| 3   | Total Observability   | Extend   | Every step appends a trajectory Step; durable store (TASK-075a) survives the request            |
| 4   | Structural Safety     | **Core** | Per-step gates apply on both paths; no gate-skipping fast path (D4)                             |
| 5   | Versioned Artifacts   | Extend   | Goal vocabulary + `nextActions` schema versioned; conformance kit per surface (L21)             |
| 6   | Structured Outputs    | **Core** | `AgentResponse<T>` schema-validated on the way out (D5)                                         |
| 7   | Provider-Aware        | Extend   | Steps route over existing provider slots; capabilities reports resolved providers (D8)          |
| 8   | Context & Memory      | Extend   | Trajectory is resumable history; goals compose over shared session state                        |
| 9   | Automated Eval        | Extend   | Conformance kit includes gate-parity (6) and budget (7) arms                                    |
| 10  | Human Oversight       | Extend   | Held actions (ADR-031) expressed to the agent caller via the gating contract (D6)               |
| 11  | Resilient Degradation | Advance  | No match is a normal result, not an error (D7); a failed step is a trajectory step, not a crash |
| 12  | Economic Transparency | Advance  | Per-step `estimatedCostUsd` summed into `CostSummary`; `budgetMaxUSD` respected (D5)            |
| 13  | Control Plane         | Extend   | Bounded-autonomy policy governs each gated step centrally (D4)                                  |
| 14  | Feedback Loops        | —        | Phase 7 — no Sprint 3b deliverable                                                              |
| 15  | Agent Identity        | Extend   | `actorType`/`actorId`/`onBehalfOf` carried on every goal; delegation reaches the trajectory     |
| 16  | Cognitive Memory      | Extend   | Trajectory as episodic memory; capabilities as procedural memory the agent reads (D8)           |
| 17  | Cognition-Commitment  | **Core** | The gating contract carries ADR-031's propose→commit boundary to the agent surface (D6)         |
| 18  | Durable Trajectories  | **Core** | Trajectory is a first-class return backed by the durable store (D5, TASK-075a)                  |

**Summary:** AUX makes **P1 / P2 / P4 / P6 / P17 / P18** core-structural and advances the **P11 / P12** partials. P14 is the only principle with no Sprint 3b deliverable (Phase 7). 18/18 accounted for. Pre-code gate satisfied (L12).

---

## Amendments

### 2026-08-15 — the gating contract: held actions, and the approver as an identity

A gated workflow step (effectiveRisk at the threshold) is HELD, not refused. The response
carries a new optional field, `held: HeldAction`, naming the proposal and WHO may approve.

`held` is a distinct field, NOT a NextAction. Approval is not an affordance the agent takes
on its own behalf: modelling it as one would blur the propose->commit boundary ADR-031
draws and would let an agent approve its own held action. nextActions offers the agent only
what the agent may do — poll or abandon — never `approve`.

**The approver is an identity, and human review is a policy default, not a welded property.**
HeldAction.approver is an AgentIdentity whose actorType is "user" | "agent" | "system".
platform/agents/gating.ts approvalPolicy() returns actorType "user" for everything today —
human review, the P10 default and the only policy Sprint 3b ships. Moving a class of action
to agent approval later is a change to that policy (and, in Sprint 3c, to an admin-governed
policy store), NEVER a change to this envelope: actorType "agent" was always a legal value
of the field. The seam is deliberate so the agent-approver path stays reachable as the
system earns trust. Recorded here so a future planner finds it where they look (GOTCHA-70).

**Approval satisfies the gate; it does not skip it (P4).** The pipeline's execute path gains
an approvedProposalId that, with a proposalStore, verifies a real approved proposal for the
operation before committing a two-phase action. effectiveRisk is untouched; a caller with no
approved proposal is refused exactly as before. The L21 kit's R10 arm asserts an UNapproved
resume is refused — the arm exists precisely so the approved-commit path can never quietly
become a bypass.

Resume after approval reuses the loop's trajectoryId re-entry (ADR-029 D5). The resume index
counts COMMITMENT steps, not total steps: a held step leaves a `cognition` proposal step that
is bookkeeping, not progress, so counting it would skip the very step awaiting approval.

---

### 2026-08-15 — the envelope is a distinct type, and the trajectory keeps its own name

Implementation of the L21 kit required reading `ActionResult` (ADR-028 D7), which already
returns `{result, trajectory, nextActions, cost}`. The four field names match `AgentResponse`
and three of the four types do not:

| Field         | `ActionResult` (ADR-028 D7)        | `AgentResponse<T>` (D5) |
| ------------- | ---------------------------------- | ----------------------- |
| `result`      | `VersionedState<TState>`           | `T`                     |
| `trajectory`  | `Trajectory`                       | `Trajectory` — shared   |
| `nextActions` | `readonly string[]` — action types | `readonly NextAction[]` |
| `cost`        | `number`                           | `CostSummary`           |

The populations differ permanently, not incidentally: `enumerateNextActions` filters an
`ActivityDefinition`'s action types against current state, while an agent response enumerates
workflow goals. A session dispatch will never legitimately offer `translate`, and a goal
response will never offer `submit-guess`. Requirement 3 above — every `action` names a
reachable goal or a terminal — is therefore false for every session-layer response, so a
single shared type could not carry it.

`AgentResponse<T>` is accordingly a distinct type sharing only `Trajectory`. ADR-028 D7's
contract is unchanged, and the workflow loop maps between the layers. The mapping is the
drift surface this creates, and it is pinned by requirement 8: every goal offered as an
affordance must appear on the capabilities surface, so a loop that invents an affordance
fails CI rather than shipping.

Two smaller corrections in the same commit:

- **`trajectory.id` was wrong** in requirement 5 and in AUX_DESIGN's core types. The field
  is `trajectoryId`, on `Trajectory` and one level down on `TrajectoryRecord`. Shipping an
  `id` synonym would have built GOTCHA-78 into the contract on the day that gotcha predicted
  Sprint 3b's agent-native contracts would be where it next bit.
- **`NextAction.estimatedCost` becomes `estimatedCostUSD`, numeric.** A `"$0.002"` string
  cannot be summed or compared against `budgetMaxUSD` without every agent parsing currency,
  and requirement 4 already establishes cost as numeric.

---

## Related

- `docs/AUX_DESIGN.md` — the design record this ADR ratifies, with the two path diagrams.
- ADR-028 — Application Framework Architecture (the sessions AUX exposes).
- ADR-029 — Agentic Workflow Framework (the workflows AUX exposes).
- ADR-031 — Action Identity & Lifecycle Protocol (the gating contract D6 surfaces).
- ADR-032 — Bundle-Safe Singletons (why D4's no-fast-path rule is not optional).
- TASK-075a — durable store arms verified; TASK-075b — cross-request durability, closes when `/api/agent/process-content` exists.
