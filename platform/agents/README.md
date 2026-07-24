# platform/agents — Agent Runtime

Bounded, instrumented, resumable agent execution (ADR-022).

## Status

✅ **Complete** (Phase 4, Sprint 4a/4b) — registry, tool registry, trajectory store, budget
tracker, execution engine, platform agent configs. Extended in Phase 5 by the agentic workflow
framework (`platform/ai/agent.ts`, ADR-029).

## Architecture

An agent is a bounded execution unit. `executeAgent()` runs a workflow that may plan, call
tools, and take multiple steps — every step recorded to a trajectory and charged against a
budget.

```
executeAgent(agentId, workflowFn, ctx)
    │
    ├→ AgentRegistry   — who may run, with what config
    ├→ ToolRegistry    — what it may call (resolveTools)
    ├→ BudgetTracker   — token / cost / step ceilings, enforced mid-run
    └→ TrajectoryStore — every step persisted: inspectable, resumable, auditable
```

## Public API

| Export                                                            | Purpose                                                  |
| ----------------------------------------------------------------- | -------------------------------------------------------- |
| `executeAgent()`                                                  | Run a workflow as a bounded agent                        |
| `registerAgent()` / `getAgent()` / `listAgents()` / `hasAgent()`  | Agent registry                                           |
| `registerTool()` / `getTool()` / `listTools()` / `resolveTools()` | Tool registry                                            |
| `InMemoryTrajectoryStore`, `getTrajectoryStore()`                 | Durable execution trajectories                           |
| `BudgetTracker`, `getBudgetTracker()`                             | Token / cost enforcement per run                         |
| `AGENT_CONFIGS`, `registerPlatformAgents()`                       | Built-in agent configs                                   |
| `generateId()`                                                    | Trajectory / step identifiers (64-bit, crypto-secure)    |
| `generateSecureId()`                                              | Session / guest / operation ids (128-bit, crypto-secure) |

Types: `AgentIdentity`, `AgentConfig`, `BudgetConfig`, `EffortTier`, `Trajectory`, `Step`,
`Tool`, `WorkflowContext`, `WorkflowFn`, `ExecutionResult`. Defaults: `DEFAULT_BUDGET_CONFIG`.

Reset helpers (`resetAgentRegistry`, `resetToolRegistry`, `resetTrajectoryStore`,
`resetBudgetTracker`) are for testing only.

## GenAI principles

- **P2 — Agentic Execution:** multi-step, instrumented, interruptible, policy-bounded.
- **P15 — Agent Identity as Delegation:** `AgentIdentity` carries the delegation chain; agent
  permissions are scoped, not inherited from the user's session.
- **P18 — Durable Trajectories:** the trajectory is the execution unit — checkpointed,
  inspectable, replayable for behavioral forensics.
- **P12 — Economic Transparency:** `BudgetConfig` caps cost per run; spend is attributed.

## Agents built on this runtime

Guardian and Sentinel (moderation), Config Manager (admin), and the five social agents
(matchmaker, gatekeeper, concierge, analyst, curator).

## Related

ADR-022 (agent runtime), ADR-029 (agentic workflow framework, Phase 5), `docs/AGENT_ARCHITECTURE.md`.
