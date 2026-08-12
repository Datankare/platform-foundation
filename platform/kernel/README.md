# platform/kernel — Platform vocabulary

The dependency-free foundation. This module imports nothing from the platform; every other
module may import it. Thirteen currently do.

## Why it exists

The action pipeline is shared machinery: both the session adapter (`app-framework`) and the
tool adapter (`agents`) execute through it, so it cannot live inside either without closing an
import cycle. A shared pipeline needs a shared vocabulary beneath it.

```
consumers (moderation, admin, input, social, and any consuming app)
     │
adapters — app-framework/session.ts · agents/runtime.ts
     │
action-pipeline
     │
kernel  ← imports nothing
```

## What is here

| File             | Contents                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------- |
| `types.ts`       | The vocabulary: actions, risk, boundaries, trajectories, sessions, tools, proposals, effects |
| `state-store.ts` | The `ActivityStateStore` contract — registry slot #14, with its authoring checklist          |
| `singleton.ts`   | Process-wide singletons that survive the bundler (ADR-032)                                   |

## What a consumer reaches for

**Types**, for anything that touches an action or a trajectory:

```typescript
import type { ActionSpec, AgentIdentity, Step, StepBoundary } from "@/platform/kernel";
```

**`getSingleton` / `setSingleton`**, if you hold process-wide state of your own:

```typescript
import { getSingleton, setSingleton } from "@/platform/kernel";

const MY_KEY = "myapp.thing";
const readThing = () => getSingleton<Thing>(MY_KEY, () => new DefaultThing());
```

A `let` at module scope is **not** one value per process. Next bundles `instrumentation.ts`
and each route handler as separate entries, so a module imported by both is evaluated twice
and each copy gets its own state. That is not theoretical: it is why `initProviders()` once
registered every provider on a copy no request ever read, and every route silently ran
in-memory defaults regardless of configuration. `singleton.ts` explains the fix and why the
key must be a `Symbol.for`.

## Where the detail lives

The file headers, not here. `types.ts` carries the layering rationale and what came from
where; `state-store.ts` carries the state-provider authoring checklist including the
atomicity requirement; `singleton.ts` carries ADR-032 in full.

## ADRs

- **ADR-028** — application framework, and the `ActivityStateStore` contract
- **ADR-029** — agentic workflow framework; D2 is why this layer exists
- **ADR-032** — bundle-safe singletons
