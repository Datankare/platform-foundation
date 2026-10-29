# Prompt-cache reads were billed at a fixed 0.1x of input, and most callers dropped them

| Field        | Detail                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Case         | `task-186-cache-reads-billed-at-a-fixed-multiple`                                                                               |
| Source       | TASK-186 (the review after merge of PR #462)                                                                                    |
| Area (tier)  | AI cost reporting (Medium); the cost guards it feeds — agent budgets — are config (High)                                        |
| Review input | The diff of PR #462 (`656ca94`), with `platform/ai/instrumentation.ts`, `platform/ai/types.ts` and the callers, as of `6540699` |
| Fixed in     | TASK-186 (on develop after `6540699`); `__tests__/ai-instrumentation.test.ts`, `__tests__/ai-cache-governance.test.ts`          |

## What the diff did

PR #462 added opt-in prompt caching and counted cache tokens in cost: `estimateCost` took an
optional `{ readTokens, writeTokens }` and billed them as multiples of the model's input price —
0.1x for a read and 1.25x for a 5-minute write — and the orchestrator passed the response's
cache counts.

## The defect

The read price is per model, not a fixed multiple: Sonnet 5.5 — the standard tier, which the same
week's #461 had just adopted — bills cache reads at 0.05x of input ($0.10 per 1M, not $0.20), so
every cached Sonnet call was reported at twice its read cost. The test asserted the multiplier
(`toBeCloseTo(0.2)` "at 0.1x"), so it encoded the defect instead of the price. And the cache
argument was optional: the nine callers that priced their own calls (the five social agents, the
moderation classifier, `agent-intent`, `agent-classifier`, the adaptive loop) still passed input
and output only, so their cache tokens were not billed at all — and the agents' budgets are
charged from those figures.

## Where

`platform/ai/instrumentation.ts:23` (`CACHE_READ_MULTIPLIER = 0.1`) and `:39` (applied to every
model's input price); `__tests__/ai-instrumentation.test.ts:39–41` (the multiplier asserted);
`platform/social/agents/gatekeeper.ts:98` (one of the nine callers passing input and output
only), as of `6540699`.

## How it was caught

An independent review of #461 and #462 after they were merged without one, checking the figures
against Anthropic's pricing page.

## The finding a reviewer should have produced

**Important** — `platform/ai/instrumentation.ts:23` — cache reads are billed at a fixed 0.1x of
the input price, but the multiplier differs by model: Sonnet 5.5 (the standard tier) bills reads
at 0.05x, so its cached calls are over-reported by $0.10 per 1M read tokens. Put the read and
write prices on `ModelConfig` from the published table and test against the table, not a
multiplier. Same class: the cache argument is optional, so `gatekeeper.ts:98` and the eight other
callers of `estimateCost` silently omit cache tokens — make the usage itself the argument so no
caller can leave them out.

## Scoring

- **Caught (2):** Names that a fixed multiplier misprices Sonnet 5.5's cache reads (or that the
  read price must come per model from the price table), at `instrumentation.ts`.
- **Partial (1):** Names only that the other callers of `estimateCost` drop cache tokens, or
  says the multiplier is unverified without naming the model it is wrong for.
