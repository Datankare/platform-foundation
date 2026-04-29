# ADR-022: Agent Runtime Architecture

**Status:** Accepted
**Date:** 2026-04-29
**Decision Makers:** Raman Sud
**Sprint:** Phase 4 Sprint 4a

## Context

Sprint 1a delivered agent type vocabulary (AgentIdentity, Trajectory, Step, Tool, BudgetConfig). Sprint 4a needs the execution infrastructure — the runtime that turns those types into running, observable, budget-constrained workflows.

The Guardian and Sentinel agents (Sprint 3b) already build trajectories manually. Sprint 4b adds six social agents. Without a runtime, each agent would reinvent trajectory management, budget checking, and step recording.

Design constraints:

1. **Simple loop, not a framework** — agents are defined workflows with AI at specific steps, not open-ended LLM loops
2. **Budget enforcement** — prevent runaway costs before they happen (P12, P13)
3. **Durable trajectories** — every agent run is inspectable and replayable (P18)
4. **Cognition-commitment boundary** — steps are typed as internal (revisable) or external (audited) per P17
5. **Provider-aware storage** — Supabase for production, in-memory for tests (P7)

## Decision

### Module Structure

```
platform/agents/
├── types.ts           — Sprint 1a: AgentIdentity, Trajectory, Step, Tool, BudgetConfig
├── utils.ts           — Sprint 1a: generateId()
├── registry.ts        — Sprint 4a: register/lookup agents by name
├── tools.ts           — Sprint 4a: typed tool definitions registry
├── trajectory-store.ts — Sprint 4a: TrajectoryStore interface + InMemory + singleton
├── budget-tracker.ts  — Sprint 4a: per-agent per-scope cost enforcement
├── runtime.ts         — Sprint 4a: executeAgent() — the core loop
└── index.ts           — barrel exports
```

### Execution Loop (`executeAgent`)

```
1. Look up agent config from registry
2. Create trajectory in store (status: running)
3. Loop:
   a. Check budget → if exhausted, pause and return
   b. Call workflow function → get StepOutcome
   c. Record step in trajectory store
   d. Consume budget
   e. If !continueExecution or step limit hit → break
4. Mark trajectory completed (or failed on error)
```

The workflow function is a `WorkflowFn` — it receives `WorkflowContext` (trajectoryId, identity, stepCount, totalCost) and returns a `StepOutcome` (action, boundary, input, output, cost, continueExecution). The runtime doesn't know what the workflow does; it manages the lifecycle around it.

### Budget Tracker

- Per-agent, per-scope, per-period (YYYY-MM) tracking
- Two enforcement dimensions: daily USD cap and step count cap per trajectory
- `checkBudget()` before each step (read-only), `consume()` after step completes
- Budget exhaustion → trajectory paused (not failed) — can be resumed when budget resets

### Trajectory Store

- Interface with InMemory implementation (default) and migration 016 for Supabase
- Create, addStep, updateStatus, getById, query with filters
- Steps stored as JSONB array — each step carries action, boundary (P17), input, output, cost, durationMs, timestamp
- Cost summary: {tokens, apiCalls, usd}

### Agent Registry

- Simple Map<string, AgentConfig> — register/lookup/list/unregister
- Duplicate registration throws (fail-fast)
- Reset for testing

### Tool Registry

- Separate from agent registry — tools are shared across agents
- `resolveTools()` maps tool IDs to definitions (skips missing)

## What This Does NOT Do

- **No agent implementations** — the runtime is infrastructure. Guardian, Matchmaker, etc. are built in Sprint 4b using this runtime.
- **No AI calls** — the runtime is AI-agnostic. It manages lifecycle; workflows make AI calls.
- **No plugin system** — no middleware chain, no hooks, no event bus. Agents are functions.
- **No multi-agent orchestration** — one agent, one trajectory. Cross-agent coordination is Phase 5.

## Consequences

- Sprint 4b agents call `executeAgent()` instead of manually building trajectories
- Budget enforcement is automatic — no agent can forget to check
- Every agent run is inspectable via trajectory query
- The existing Guardian and Sentinel can be migrated to use `executeAgent()` in Sprint 4b (optional, not required)

## Related

- ADR-015: GenAI-Native Stack (18 principles)
- ADR-021: Social System Architecture (social agents operate on this runtime)
- AGENT_ARCHITECTURE.md (full agent design doc)
- Migration 016: agent_trajectories + agent_budgets tables
