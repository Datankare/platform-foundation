# platform/action-pipeline — The governed execution pipeline

One implementation of the sequence every action traverses, whatever invoked it.

```
operationId (minted or supplied)
   → tier resolution
   → gating          (does this need a human?)
   → budget ceiling  (the minimum across every applicable limit)
   → state commit    (compare-and-set)
   → trajectory append
   → event emit
```

## Why one implementation

Two adapters sit above it, each owning only domain-specific behaviour:

| Adapter                    | Entry point    | Owns                                                |
| -------------------------- | -------------- | --------------------------------------------------- |
| `app-framework/session.ts` | `dispatch()`   | turn rules, validate/apply, next-action affordances |
| `agents/tool-invoker.ts`   | `invokeTool()` | schema validation, tool execution                   |

ADR-029 D2 says a tool call "is not a separate execution path". That binds the **pipeline**,
not the entry point: two entry points are fine, two implementations of gating, CAS and
trajectory recording are not. Forcing tool calls through `dispatch()` would drag turn
enforcement and affordance enumeration into agent execution, which D2 itself guards against.

## What a consumer reaches for

Most consumers use an adapter rather than this module directly. Reach for it when you are
building a third adapter.

```typescript
import { executeActionPipeline } from "@/platform/action-pipeline";
```

Held actions, resumption and rollback:

```typescript
import {
  proposeAction, // record the intent, pause, ask a human
  proposeOnce, // the same, deduplicated on operationId
  reviseProposal, // supersede a held proposal under the same operation
  approveWithReconciliation, // approve, unless the state moved underneath it
  rejectProposal,
  compensateTrajectory, // undo by appending corrections, never by rewriting
  repairSession, // complete an operation interrupted between commit and record
  mostRestrictiveCeiling,
} from "@/platform/action-pipeline";
```

## Dependencies

Imports **only** `platform/kernel`. Both stores arrive as parameters rather than through
singleton accessors, because an accessor lives in the module that owns the implementation and
importing one here would close the cycle this layering exists to open.

## Two decisions worth knowing before you extend it

**Budget is a minimum, risk is a maximum.** The effective ceiling is the lowest of every
applicable limit; the effective risk is the highest of every applicable signal. The
conservative direction differs by quantity, and taking the wrong one on either defeats both
(ADR-029 D3 and D8).

**Failure is three-valued.** An external effect that neither confirmed nor denied is
`indeterminate`, not failed. Collapsing it either way is how double charges and lost orders
happen (ADR-029 D10).

## ADRs

- **ADR-029** — agentic workflow framework (D1–D10)
- **ADR-031** — action identity and lifecycle (D1–D9)
