# platform/input — Classification and intent resolution

Turns an inbound request into a decision about what the caller wants and which agent should
handle it.

## What is here

| File                  | Contents                                |
| --------------------- | --------------------------------------- |
| `types.ts`            | Classification and intent vocabulary    |
| `classifier.ts`       | Rule-based content classification       |
| `agent-classifier.ts` | LLM-backed classification               |
| `intent.ts`           | Rule-based intent resolution            |
| `agent-intent.ts`     | LLM-backed intent resolution            |
| `conductor.ts`        | Orchestrates classification and routing |

Each concern has a **rule-based and an LLM-backed** implementation. The rule-based one is not
a mock — it is a cheaper, deterministic path for the cases that do not need a model, and the
distinction matters for both cost and latency.

## Status

**No module in `platform/` imports this.** It is either a public surface a consuming
application calls directly, or it is unreached. That is recorded here rather than left for
someone to discover: if it is the former, a consumer example belongs in this file; if the
latter, the module needs a decision.

The importer inventory is mechanical — `grep -rn "@/platform/input" platform/` returns
nothing — so this is a fact rather than an impression.

## Dependencies

`agents` for agent identity and trajectory vocabulary, `ai` for the model calls the LLM-backed
implementations make.
