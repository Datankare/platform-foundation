# Authoring an adaptive behavior (ADR-036)

This directory holds the **reference** adaptive behavior. It is a complete, registered,
end-to-end example — copy it when you add a new adaptive behavior (Playform is the first
consumer). The platform owns the loop; you supply the app-specific pieces.

## What the platform owns vs. what you supply

The platform provides the loop (`runAdaptive`), within-session memory (D5), fail-closed
execution (D3), and the governed-effect path (`routeAdaptiveEffect`, D4). You supply one
`AdaptiveBehavior<TInput, TDecision>`:

| Field       | Meaning                                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`      | A registered prompt name (ADR-038). The behavior is eval-gated by that name — the prompt must have an eval suite, or the harness fails.                                              |
| `agentId`   | A registered runtime agent (ADR-039) that hosts the decision, so every decision is a traced trajectory.                                                                              |
| `build`     | `(input, memory) => AIRequest`. Map your input **and** the recent within-session summaries into the prompt.                                                                          |
| `parse`     | The prompt's own exported parser. Must be total and fail-closed — never throw.                                                                                                       |
| `schema`    | JSON Schema (ajv) the parsed decision is validated against before use. Defense in depth over the parser.                                                                             |
| `fallback`  | **Mandatory.** Deterministic decision returned on any failure (orchestrator error, open breaker, parse failure, schema-invalid, run-incomplete). Registration is refused without it. |
| `summarize` | `(decision) => string`. A compact line appended to within-session memory and fed into the next `build`.                                                                              |

## The three rules that bite

1. **Fail-closed everywhere.** The parser never throws; the fallback is the safe no-op
   (here, `"steady"`). Because the reference parser is total, the loop's parse/schema
   fallback branches are exercised by the generic loop test, not the behavior's own test —
   the behavior test covers the happy path, memory, and the runtime-failure fallbacks.
2. **Memory is within-session only.** `memory.recent` is a bounded, session-scoped slice.
   Do not persist across sessions — that is a later sprint and its own ADR.
3. **Effects are governed.** `runAdaptive` never mutates state. When a decision is
   effectful, route it through `routeAdaptiveEffect`, which forces boundary `commitment`
   and runs the action pipeline (CAS, risk gating, held-action/dual-control). There is no
   route around the controls.

## Activation

`registerAdaptiveReference()` (see `../bootstrap.ts`) registers the host agent and the
behavior. It is called from `initProviders()` at server boot — the same path every platform
singleton initializes on — and mirrored once per test file in `jest.setup.ts`. It is
idempotent. A newly registered host agent must also be listed in
`docs/AGENT_ARCHITECTURE.md` (roster completeness, ADR-039 D5).

## Files in the reference

- `pacing.ts` — `PACING_HOST_AGENT`, `PACING_BEHAVIOR`, the schema.
- `../bootstrap.ts` — `registerAdaptiveReference()`.
- `prompts/adaptive/pacing-v1.ts` — the prompt (builder + parser + `PacingDecision`).
- `prompts/evals/adaptive/pacing.eval.ts` — the ADR-038 eval suite.
- `__tests__/adaptive-pacing-e2e.test.ts` — the functional end-to-end proof.
