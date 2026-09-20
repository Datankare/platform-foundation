# ADR-036 — Adaptive behavior framework

Status: Accepted (Phase 5 Sprint 4). Decision maker: Raman Sud.
Spec basis: ADR-028 (application framework — D1 consumer-implements, D2 ActivityStateStore, D3
action pipeline), ADR-029 (agentic workflow framework), ADR-031 (action identity & lifecycle),
ADR-015 (LLM orchestration — circuit breaker / fallback), ADR-039 (agent runtime), ADR-038
(prompt-eval harness). L12 (this sprint's pre-code gate), L21 (conformance).

## 1. The end state

A platform framework for **LLM-driven adaptive behavior** — decisions that adjust to prior-turn
context — where the platform owns the loop and the consumer supplies the app-specific logic
(ADR-028 D1). A consumer registers an `AdaptiveBehavior<TInput, TDecision>`:

```ts
interface AdaptiveBehavior<TInput, TDecision> {
  readonly name: string; // registered prompt name (ADR-015/-038)
  readonly build: (input: TInput, memory: AdaptiveMemory) => PromptRequest;
  readonly parse: (raw: string) => TDecision; // the prompt's own typed parser
  readonly schema: Schema<TDecision>; // validated before the decision is used
  readonly fallback: (input: TInput, memory: AdaptiveMemory) => TDecision; // MANDATORY, deterministic
}
```

The platform's adaptive loop, per decision: read within-session memory -> `build` -> call the
orchestrator -> `parse` -> schema-validate -> on **any** failure, `fallback` -> route effectful
outcomes through the D3 action pipeline -> append memory -> trace. The framework ships reference
implementations only; real adaptive consumers (opponents, tutors, assistants) arrive with
Playform adoption in Sprint 7. Consumers inherit the framework; the same rules govern theirs.

## 2. Decisions

**D1 — Consumer-implements seam (ADR-028 D1).** The platform owns the loop; the consumer supplies
`build` / `parse` / `schema` / `fallback` for its own `TInput`/`TDecision`. No app logic lives in
the framework; no loop logic lives in the consumer.

**D2 — Runs on the ADR-039 runtime.** Each decision executes inside `executeAgent` as a
`WorkflowFn`, so it is a traced trajectory (model, prompt-version, tokens, latency, cost, budget,
effect ledger) — identical governance to every other agent. No second execution path.

**D3 — The deterministic fallback is mandatory and fires on any of:** orchestrator error, an open
circuit breaker (ADR-015), parse failure, or schema-invalid output. The platform **refuses to
register** an `AdaptiveBehavior` without a `fallback`. Adaptive behavior is therefore fail-closed
by construction: a model outage or a malformed decision degrades to a deterministic decision, it
never stalls or emits an unvalidated one.

**D4 — Effectful decisions route through the D3 action pipeline** (`platform/action-pipeline`),
never applied directly to state. Adaptive actions thereby inherit CAS on the versioned state,
risk gating, and the held-action / dual-control path (ADR-040) — an adaptive decision has no
privileged route around the controls every other action passes through.

**D5 — Within-session memory is a typed slice of the ActivityStateStore (D6a — see §3).** The
framework reads and appends a bounded, JSON-serializable memory slice inside the existing
versioned session state (kernel slot #14). It is written through the same CAS path (never a
blind overwrite), and it dies with the session — cross-session learning is out of scope for
Sprint 4 and cannot leak in, because no store outlives the session.

**D6 — Eval-gated.** Every adaptive prompt ships with an ADR-038 eval suite; the prompt-evals
meta-test already fails the build for an unevaluated prompt, so an adaptive behavior cannot land
without its decision contract exhaustively evaluated (enum / fail-closed / boundary / adversarial).

## 3. Alternatives considered

**Within-session memory location (the D5 decision).**

- **(a) Reuse the ActivityStateStore — CHOSEN.** Adaptive memory is a typed slice of the existing
  per-session versioned state (ADR-028 D2, kernel slot #14). _For:_ no new state mechanism;
  inherits CAS, versioning, and the reconstructible-state guarantee already proven for session
  state; one lifecycle to reason about; and "within-session only" holds **by construction** —
  the store dies with the session, so cross-session state cannot leak in even by mistake.
  _Against:_ adaptive memory shares a version line with the rest of session state, so a memory
  append and an unrelated state change contend on the same CAS (acceptable — the pipeline already
  composes commutative/contended actions).

- **(b) A dedicated `AdaptiveMemory` store keyed by session — REJECTED.** _For:_ explicit
  separation; adaptive memory evolves independently of session state. _Against:_ a second state
  mechanism to build, persist, and reconcile against the app-framework; a new lifecycle to get
  right; and — decisively — it reintroduces the risk the framework is meant to preclude: a
  separately-lifecycled store is exactly where cross-session leakage creeps in when the Sprint-7
  consumer wants "just a little" persistence. Reusing the session-scoped store makes the
  within-session boundary a property of the storage, not of discipline.

Chosen (a): the minimal option that also makes the Sprint-4 scope boundary structural rather than
conventional. When cross-session learning is designed (a later sprint / its own ADR), it gets a
deliberate, separately-governed store — not an accidental widening of this one.

**Execution path.** Considered a standalone adaptive loop; rejected in favor of `executeAgent`
(D2) so adaptive decisions inherit tracing, budget, and the effect ledger rather than duplicating
them — two execution paths would mean two implementations of governance.

**Fallback optionality.** Considered an optional fallback with a platform default; rejected (D3) —
a generic default cannot be correct for an arbitrary `TDecision`, and a missing fallback is
precisely when an outage would surface as a stall or an unvalidated decision. Mandatory + consumer-
supplied is the only fail-closed option.

**Effect routing (the D4 decision).**

- **(a) Route through the D3 pipeline behind a framework wrapper that forces the boundary —
  CHOSEN.** An effectful decision is expressed as an `ActionSpec` + `computeNextState` and handed
  to `routeAdaptiveEffect`, which fixes `boundary = "commitment"` and calls
  `executeActionPipeline`, translating its outcomes into one small vocabulary (`applied` /
  `held` / `rejected` / `conflict`). _For:_ every adaptive effect inherits CAS on versioned
  state, risk gating, and the held-action / dual-control path (ADR-040), with no privileged
  route around them; the boundary is set by the framework, so the pipeline computes risk from
  the spec and a caller cannot downgrade it (P4/P17) — the "no route around the controls"
  guarantee is **structural**, not a convention; and the consumer codes against a compact,
  stable outcome type rather than the full pipeline surface. _Against:_ a thin translation
  layer the framework must keep in step with the pipeline's outcomes; the consumer must model
  its effect as a spec rather than mutate state inline.

- **(b) Apply the decision directly to state (or let the consumer call the pipeline itself) —
  REJECTED.** _For:_ fewer types and no wrapper; the shortest path from decision to state.
  _Against:_ a direct mutation strips CAS, risk gating, and dual-control from adaptive actions
  outright; and even "let the consumer call `executeActionPipeline` directly" reopens the same
  hole, because the boundary becomes caller-supplied — an adaptive effect could be presented at
  a lower boundary to dodge the gate, and every consumer re-implements outcome translation.
  Either variant makes the D4 guarantee a matter of consumer discipline.

Chosen (a): the boundary and the governed path are properties of the framework, not of a
well-behaved caller. The cost is one thin translation layer; the return is that an adaptive
decision carries exactly the controls every other action does, by construction.

## 4. How we get there — implementation sequencing

(1) `AdaptiveBehavior` registry + the adaptive loop over `executeAgent`, with the mandatory-fallback
registration guard. (2) The within-session memory slice API on the ActivityStateStore (typed,
bounded, CAS-appended). (3) Schema validation + the fallback triggers (D3). (4) A reference
adaptive behavior + its ADR-038 eval suite. (5) The L21 conformance kit. ADR-037 (content
generation) follows, reusing the same seam + pipeline.

## 5. Invariants

- No `AdaptiveBehavior` registers without a deterministic `fallback` (D3).
- Every adaptive decision is schema-validated before use; an invalid decision triggers the
  fallback, never propagation (D3).
- Every effectful adaptive outcome goes through the D3 pipeline — no direct state mutation (D4).
- Adaptive memory lives only in session-scoped state and dies with the session; nothing persists
  across sessions (D5).
- Every adaptive prompt has an ADR-038 eval suite (D6).
- Every adaptive decision is a traced trajectory (D2).

## 6. Conformance kit (L21)

`__tests__/adaptive-behavior-contract.ts` (invoked per registered behavior): registration is
rejected without a fallback; an orchestrator error, an open breaker, a parse failure, and a
schema-invalid output each yield the deterministic fallback; an effectful decision is observed on
the action pipeline (never a direct commit); adaptive memory does not survive a session boundary;
and the behavior's prompt has an eval suite (cross-checked against ADR-038's EVAL_SUITES).

## 7. Related

ADR-028 (D1/D2/D3), ADR-029/-031 (workflow, action lifecycle), ADR-015 (orchestrator/breaker),
ADR-039 (runtime), ADR-038 (eval harness), ADR-040 (held-action/dual-control the pipeline routes
through). Consumed by ADR-037 (content generation, same seam) and Sprint-7 Playform adoption.

_Last updated: September 15, 2026 (Phase 5 Sprint 4 — ADR-036 authored in full: consumer-implements
adaptive seam on the ADR-039 runtime, mandatory deterministic fallback (fail-closed on error /
open-breaker / parse / schema-invalid), effectful decisions via the D3 pipeline, within-session
memory as a typed slice of the ActivityStateStore (D6a — reuse-the-session-store chosen over a
dedicated store; tradeoffs recorded in §3), eval-gated by ADR-038)._
_Last updated: September 17, 2026 (Phase 5 Sprint 4 — effect-routing tradeoff recorded in §3 (D4): the D3 pipeline behind a boundary-forcing wrapper (a, chosen) over applying decisions directly or a caller-supplied boundary (b))._
