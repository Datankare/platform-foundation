# A model refusal was thrown before its usage was read, so its cost was recorded as 0

| Field        | Detail                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Case         | `task-186-a-refusal-lost-its-billed-usage`                                                                                            |
| Source       | TASK-186 (review round 1 of the fix for #461 / #462)                                                                                  |
| Area (tier)  | AI cost reporting (Medium); the agent budgets and the paid quota it feeds are config (High)                                           |
| Review input | `platform/ai/provider.ts`, `platform/ai/orchestrator.ts`, `platform/moderation/classifier.ts`, as of `6540699`                        |
| Fixed in     | TASK-186 (on develop after `6540699`); `__tests__/ai-cache-governance.test.ts`, `__tests__/anthropic-provider-model-settings.test.ts` |

## What the diff did

PR #462 made a model refusal (`stop_reason: "refusal"`, an HTTP 200) throw a permanent
`AIProviderError` instead of returning an empty reply, in `complete()` and in `stream()`.

## The defect

A refusal is billed: the prompt was read and the response counted. The throw came before the
response's `usage` was read, and the error carried none, so every path that records cost saw 0:
the orchestrator's failure metrics wrote 0 tokens and $0, and the safety classifier's fail-closed
result reported `costUsd: 0`. Refused calls — which a user can provoke on purpose — cost money that
no metric, agent budget or quota counted.

## Where

`platform/ai/provider.ts:107` (thrown before the usage at `:144` is read) and `:284` (the stream's
refusal, with the counts read at `:250` and `:261` left behind); `platform/ai/orchestrator.ts:474`
and `:476` (`recordFailureMetrics`: `inputTokens: 0`, `estimatedCostUsd: 0`);
`platform/moderation/classifier.ts:73` (`failClosedResult("Classifier unavailable", 0)`), as of
`6540699`.

## How it was caught

Two independent reviewers of TASK-186 (the review after merge of #461 and #462), each on its own.

## The finding a reviewer should have produced

**Important** — `platform/ai/provider.ts:107` — the refusal is thrown before `data.usage` is
read, so a billed call is recorded as free: `recordFailureMetrics` (`orchestrator.ts:474`) writes 0
tokens and $0, and the classifier's fail-closed result (`classifier.ts:73`) says `costUsd: 0`.
Carry the usage on the error and record its cost wherever a failure is recorded. Same class: any
error path after a paid call that drops what the call was billed for.

## Scoring

- **Caught (2):** Names that a refusal's usage is lost before it is thrown, so its cost is
  recorded as 0, at the provider's refusal throw or the orchestrator's failure metrics.
- **Partial (1):** Names only the classifier's `costUsd: 0` on its error path, without the cause.
