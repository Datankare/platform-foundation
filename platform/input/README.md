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

## Who calls it

This is a **public surface**: no other `platform/` module imports it, and consuming
applications call it directly. That is the intended shape rather than an accident.

| Repo                | Caller                                       | Uses                                         |
| ------------------- | -------------------------------------------- | -------------------------------------------- |
| platform-foundation | `components/AdaptiveInput/AdaptiveInput.tsx` | `InputMode`, `ConductorOutput`, `ActionItem` |
| playform            | `lib/usePlayformConductor.ts`                | the conductor, per-request                   |
| playform            | `lib/playformIntentResolver.ts`              | intent resolution                            |
| playform            | `components/SpikeApp.tsx`                    | `InputMode`                                  |
| playform            | `components/AdaptiveInput/AdaptiveInput.tsx` | the same types                               |

An earlier revision of this file claimed nothing imported the module. That was wrong: the
importer search covered `platform/` and was reported as though it covered the repository.
Recorded here because a reader who believed it would reasonably have concluded the module was
dead.

## Using it from an application

```typescript
import { usePlayformConductor } from "@/lib/usePlayformConductor";

// The conductor classifies the input, resolves an intent, and returns the
// affordances the UI should offer next.
const { mode, output, actions } = usePlayformConductor();
```

`lib/usePlayformConductor.ts` in playform is the worked example: it wires the conductor to a
React surface and is the closest thing to a reference consumer.

## Dependencies

`agents` for agent identity and trajectory vocabulary, `ai` for the model calls the LLM-backed
implementations make.
