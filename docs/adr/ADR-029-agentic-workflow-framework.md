# ADR-029: Agentic Workflow Framework

**Status:** Accepted
**Date:** 2026-07-28
**Decision Makers:** Raman Sud
**Sprint:** Phase 5 Sprint 2
**Related:** ADR-028 (application framework), ADR-031 (action identity & lifecycle protocol), ADR-022 (agent runtime), ADR-017 §7 (rollback)

## Context

Phase 4 delivered an agent runtime: a registry, a tool registry, a trajectory store, a budget
tracker, and `executeAgent()` — a loop that runs a workflow function step by step, records each
step, and stops on budget exhaustion or a step limit. It is deliberately a loop and not a
framework: no plugin system, no middleware chain.

Sprint 1 delivered the application framework: an action pipeline with effects-as-capability,
risk floors, tiered durability, optimistic concurrency, and trajectory append (ADR-028 D3–D5).

Sprint 2 makes agent execution multi-step, durable, resumable, and reversible, and implements
the ADR-031 lifecycle protocol. Reading both surfaces before designing surfaced four gaps and
two defects, and one structural choice that determines everything else.

### The structural choice

The agent runtime and the application framework each have a notion of "a thing an actor does
that has effects, costs money, and must be audited". Sprint 2 can either extend the agent loop
with its own risk, gating, and identity handling, or route agent tool calls **through** the
ADR-028 D3 action pipeline.

Two parallel implementations would mean two risk vocabularies, two gating thresholds, two
idempotency stories, and two places to fix every future defect. They would drift, and the
drift would be invisible until a gated action escaped gating on the path nobody checked. This
ADR routes tool calls through the existing pipeline (D2).

### Gaps in the current runtime

1. **`Tool` is not executable.** It carries `id`, `name`, `description`, `inputSchema`,
   `outputSchema` — and no handler. The registry stores declarations that cannot be invoked.
   Nothing validates against the schemas either, so the P6 structured-output claim rests on
   metadata alone.
2. **`Step` carries no identity.** ADR-031 D9 requires `operationId`, actor, effects, and
   `effectiveRisk` on the durable record. `Step` has `stepIndex`, `action`, `input`, `output`,
   `cost`, `durationMs`, `timestamp`, `boundary`.
3. **There is no resume.** `TrajectoryStatus` includes `paused`, `executeAgent()` sets it on
   budget exhaustion, and the module header claims checkpoint/resume under P18. No resume
   function exists in the store or the runtime, so a paused trajectory is terminal in practice.
   Both approval-gating (D7) and ADR-031 D6 crash-window repair depend on resume existing.
4. **There is no rollback.** Named in Sprint 2 scope via ADR-017 §7; absent.

### Defects

5. **Session trajectories are recorded under the `agentId` parameter.** `session.ts` calls
   `getTrajectoryStore().create(sessionId, "session-created", "user")`, where the first
   parameter is `agentId`. It type-checks and is semantically wrong: session trajectories are
   indistinguishable from agent trajectories, and no query can retrieve trajectories by
   session. Fixed by D4.
6. **`resolveTools()` silently drops unknown tool ids.** The docstring says it logs a warning;
   the implementation skips without logging. An agent configured with a mistyped tool id runs
   with fewer capabilities and no signal — the same fail-open shape as TASK-057's health
   endpoint. Fixed by D1.

## Decision

### D1 — Tools are executable capability-declaring artifacts, and resolution fails closed

`Tool` gains an executable contract:

- `execute(input, context): Promise<output>` — the handler.
- `effects: readonly EffectType[]` — reusing the ADR-028 vocabulary, not a parallel one.
- `declaredRisk?: RiskLevel` — advisory and upward-only, exactly as `ActionSpec`.

A tool therefore declares what it does to the world in the same terms an action does, which is
what makes D2 possible.

`resolveTools()` throws on an unregistered id rather than skipping it. A missing tool is a
misconfiguration, and an agent silently running with reduced capability is worse than an agent
that refuses to start: the first produces wrong answers indefinitely, the second produces one
loud failure at registration.

### D2 — Tool invocation is an action through the ADR-028 D3 pipeline

A tool call is not a separate execution path. The runtime assembles an `ActionContext` for each
invocation and routes it through the same pipeline session actions use:

`effectiveRisk = max(declaredRisk, max(effect floors))` · tier resolution · gating ·
budget check · commit · trajectory append.

Consequences that follow for free rather than by reimplementation: a tool declaring
`restricted` effects is gated identically to a restricted session action; a tool's state writes
obey the same optimistic concurrency; a tool call appears in the trajectory in the same shape
as an action.

The agent loop keeps its character — it remains a loop, not a plugin system. What changes is
that the step it executes goes through the pipeline instead of around it.

### D3 — Schemas are enforced at both edges, and invalid output is retried, not trusted

`inputSchema` is validated before `execute`; `outputSchema` after. A tool returning output that
fails its own schema is a tool that failed, not a tool that succeeded with unusual data.

Invalid output is retried within the step's remaining budget. On exhaustion the step fails and
the trajectory fails. Coercing malformed output into the expected shape is prohibited: it
converts a detectable failure into a plausible wrong answer, which is the failure mode
structured outputs exist to prevent (P6).

### D4 — `Step` carries the action identity, and trajectories carry their subject

`Step` gains optional fields — `operationId`, `proposalId`, `actor`, `effects`,
`effectiveRisk`. Optional keeps the change additive for existing Phase 4 callers (P5 contract
discipline); the framework always populates them.

This implements ADR-031 D9 and simultaneously fixes the Sprint 1 defect where
`assembleActionContext()`'s return value is discarded — the context is computed and now has
somewhere to go.

`TrajectoryStore.create()` gains an explicit `subject` discriminator (`agent` | `session`) with
its id, replacing the current practice of passing a `sessionId` in the `agentId` parameter.
Trajectories become queryable by session, and an agent trajectory is distinguishable from a
session trajectory without inspecting the trigger string.

### D5 — Resume is keyed by `operationId`, and recorded steps are never re-executed

`TrajectoryStore` gains resume support, and the runtime gains a `resumeAgent()` entry point.

Resume replays from the trajectory: steps already recorded are **not** re-executed. The
step's `operationId` is the dedup key (ADR-031 D4), so a resumed workflow that reaches an
already-committed step returns the recorded result rather than repeating it.

This is what makes `paused` a real state rather than a decorated terminal failure, and it is
the mechanism ADR-031 D6 forward-repair uses.

### D6 — Rollback is compensation, not reversal

Committed state transitions are not undone. Other actors may already have observed them, and
external effects may already have fired.

Rollback appends **compensating actions** — each with its own `operationId`, linked to the
operation it compensates. The trajectory records both the original and the compensation, so the
history says what happened and what was done about it, rather than being rewritten to say the
first thing never happened.

A step whose effects are not compensable declares so, and a workflow containing one is refused
at registration rather than discovered mid-rollback. Discovering irreversibility during
rollback is discovering it too late.

### D7 — Gating pauses the trajectory; approval resumes it

A tool call whose `effectiveRisk` reaches `GATING_THRESHOLD` resolves to the `two-phase` tier
and does not execute. The runtime:

1. records the proposal step (boundary `cognition`, ADR-031 `proposed`),
2. emits an `approval-request` `SessionEvent` (ADR-028 D8),
3. pauses the trajectory.

Approval resumes it via D5. Rejection terminates the operation with a trajectory and no
`stateVersion` (ADR-031 D8). Stale approvals are handled by ADR-031 D5, not re-litigated here.

This is why D5 had to exist first: without resume, gating could only refuse, never hold.

### D8 — Budget is most-restrictive-wins across every applicable ceiling

An agent step inside a session is bound by both the agent's `BudgetConfig` and the session's
ceiling. The effective ceiling is the **minimum**, symmetric with ADR-028 D10 and deliberately
opposite to D3's `max()` on risk: the conservative direction differs by quantity, and taking
the maximum ceiling or the minimum risk would defeat both.

Budget exhaustion pauses rather than fails (current runtime behaviour, retained) — with D5,
pausing is now recoverable rather than a dead end.

### D9 — No new registry slot; the kit is behavioural

Tool execution is in-process. There is nothing to swap, so ADR-029 adds no provider registry
slot. The conformance kit registers as a non-registry kit in the contract manifest, and the L21
meta-test covers it as an abstraction with a kit rather than as a slot without one.

### D10 — Failure is three-valued

A workflow ends `completed`, `failed`, or `paused`. An external effect additionally admits
`indeterminate` (ADR-031 D7) when a downstream neither confirms nor denies.

`indeterminate` propagates: a workflow containing an indeterminate effect is itself
indeterminate and MUST NOT report `completed`. Collapsing it into success or failure is an
at-least-once or at-most-once violation depending on the direction of the guess, and the guess
is invisible afterwards.

## Invariants

1. Every tool call produces exactly one trajectory step carrying its `operationId`.
2. No tool executes without schema-validated input.
3. No tool result is accepted without schema-validated output.
4. A gated tool call never executes before approval.
5. A resumed workflow re-executes no already-recorded step.
6. Rollback appends; it never deletes or rewrites a recorded step.
7. The effective budget ceiling is the minimum of all applicable ceilings.
8. An indeterminate effect never reports as completed.

## Consequences

**Positive.** One pipeline, one risk vocabulary, one idempotency story across session actions
and agent tool calls. `paused` becomes recoverable, which makes approval-gating and crash
repair implementable. Tool misconfiguration fails loudly at registration. The audit record
finally carries the fields that justify each action.

**Negative.** Routing tool calls through the action pipeline couples the agent runtime to the
app-framework, where before they were independent — a deliberate trade of independence for a
single source of truth about risk. Existing Phase 4 workflow functions must be revisited to
declare effects on their tools. The compensation model requires every irreversible step to be
declared as such, which is real authoring burden and will be got wrong at least once.

**Neutral.** `Step` field additions are optional and additive; Phase 4 callers compile
unchanged. The agent loop's shape is unchanged.

## Conformance kit (L21)

Required arms, extending the five ADR-031 specifies:

- Tool input/output schema enforcement, including the retry-on-invalid-output path.
- `resolveTools()` throws on an unknown id.
- Gated tool call pauses without executing; approval resumes; rejection terminates with a
  trajectory and no `stateVersion`.
- Resume re-executes no recorded step (asserted by side-effect counter, not by timing).
- Compensation appends and never rewrites.
- Effective ceiling is the minimum across agent and session budgets.
- Indeterminate effects propagate to workflow status.

## Related

ADR-028 (application framework — D3 action pipeline, D8 session events, D10 budgets),
ADR-031 (action identity & lifecycle protocol — implemented here), ADR-022 (agent runtime —
extended here), ADR-017 §7 (rollback).
