# ADR-039: Agent Registry Unification and the Single-Roster Rule

Status: Accepted (Phase 5 Sprint 4, Track F). Decision maker: Raman Sud.
Related: ADR-022 (agent runtime + registry), ADR-030 (governed goal-loop), ADR-029 (executeAgent;
compensation), ADR-028 (action pipeline), ADR-033 (trusted-agent registry — different thing),
ADR-015 (prompt registry), `__tests__/docs-integrity.test.ts`.

---

## 1. The end state

After Track F delivers this ADR, three rules hold — and CI enforces all three:

1. **One registry is the source of truth.** `listAgents()` is the complete list of agents.
   Nothing is an agent unless it is registered there.
2. **Every agent runs on the governed runtime.** No agent has its own execution loop. Each runs
   through `executeAgent` / `runGoal` / `advanceGoal`, so every step passes the action pipeline —
   risk floor, gating/approval, budget, trajectory.
3. **The docs follow the registry.** `AGENT_ARCHITECTURE.md` is checked against `listAgents()`,
   so it can never fall behind the code.

A new agent that skips registration, or runs its own loop, **fails the build**. The rule is
mechanical, not a matter of remembering.

### Agent lifecycle

```
  ┌────────────────────────────────────────────────────────────┐
  │ 1. DEFINE                                                    │
  │    AgentConfig = identity + tools (+ compensable) + budget   │
  └────────────────────────────────────────────────────────────┘
                       │ registerAgent()
                       ▼
  ┌────────────────────────────────────────────────────────────┐
  │ 2. REGISTER — the Agent Registry                            │
  │    listAgents() is the single source of truth               │
  │    · AGENT_ARCHITECTURE.md is checked against it             │
  │    · CI: an unregistered agent  ⇒  build fails              │
  └────────────────────────────────────────────────────────────┘
                       │ invoke
                       ▼
  ┌────────────────────────────────────────────────────────────┐
  │ 3. RUN — on the governed runtime                            │
  │    executeAgent / runGoal / advanceGoal                      │
  │                                                              │
  │    ┌───────────────────────┐                                │
  │    │  workflow  (1 block)  │   every step ─┐                │
  │    │  plan → tool → observe │               ▼                │
  │    └───────────▲───────────┘   Action pipeline:             │
  │                └── loop ──┘     risk floor · gating/approval │
  │                until done       · budget · trajectory append │
  │                                                              │
  │    · CI: a bespoke (off-runtime) loop  ⇒  build fails       │
  └────────────────────────────────────────────────────────────┘
                       │
                       ▼
  ┌────────────────────────────────────────────────────────────┐
  │ 4. RESULT                                                    │
  │    durable trajectory — inspectable · resumable · auditable  │
  │    · budget-bounded                                          │
  └────────────────────────────────────────────────────────────┘
```

The "workflow" block is deliberately abstracted: whether an agent is a fixed sequence (e.g.
Sentinel) or an open-ended planner (the admin agents), it is one block that the runtime loops
through the pipeline. That single abstraction is why every agent can share one execution model.

---

## 2. Decisions

**D1 — The registry is the single source of truth.** Every agent has an `AgentConfig`.
`listAgents()` is authoritative; `AGENT_ARCHITECTURE.md` is checked against it, never the reverse.

**D2 — Every agent is registered.** Register the agents that currently aren't: Sentinel,
config-manager, command-bar, Conductor, and any processing unit that meets D6.

**D3 — Every agent runs on the governed runtime.** No bespoke execution loops remain:

- Sentinel migrates its 5-step sequence to `executeAgent`.
- config-manager and command-bar port onto the governed runtime via `executeAgent` + `invokeTool` — the open-ended planners choose tools dynamically, so they do not fit the fixed-workflow `runGoal`; each tool call is governed by `invokeTool`, and config-manager keeps `config-approval` as its domain two-person gate (execution rerouted, approval kept). Their
  hand-rolled loop and their own approval code are deleted — approval comes from the pipeline
  (`gating.ts` + `approval-policy-store.ts`), the same path the governance admin already uses.

No allowlist, no grandfathering. (See §4 for why this is a port, not new runtime work, and why
we do it now.)

**D4 — Tools declare compensability.** Registering an agent means declaring each tool's
`compensable` flag (ADR-029). A config-write that can't be compensated is a single committed
action behind the confirm + two-person gate, not a step inside a rollback-expecting workflow.

**D5 — A CI guard makes it binding.** `__tests__/agent-registry-integrity.test.ts` fails a
commit when any of these is true:

1. a registered agent is missing from `AGENT_ARCHITECTURE.md`;
2. a module outside `platform/agents/` looks like an agent (builds its own step/tool loop) but
   isn't registered;
3. any file runs a bespoke agent loop at all — there is no allowlist.

The guard self-tests first (it proves it can detect the signature and sees the known agents
before trusting any absence).

**D6 — What counts as an agent (vs a service).** An agent (a) has an identity, (b) makes an
LLM/tool decision, and (c) produces a step trajectory. A pure deterministic transform — no
decision, no identity — is a _service_, documented as such, not registered. This is the test
used to classify Conductor and the processing units.

**D7 — Two registries, named apart.** "Agent registry" = the runtime registry (this ADR).
"Trusted-agent registry" = ADR-033's attested-delegation trust store. Different things; the docs
are corrected so they're never conflated.

---

## 3. How we get there — Track F

| Commit | Work                                                                                                                                                            |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1     | Register Sentinel + migrate its execution to the runtime                                                                                                        |
| F2     | Register config-manager + command-bar; port both onto `runGoal`/`advanceGoal`; register their ~10 tools with compensability; delete the bespoke loop + approval |
| F3     | Classify Conductor + the processing units (D6) and register the ones that qualify                                                                               |
| F4     | The zero-bespoke CI guard (D5)                                                                                                                                  |
| F5     | Backfill `AGENT_ARCHITECTURE.md` to the full roster + fix the ADR-033 naming                                                                                    |

F2 is the largest, but it is a _port_ — the runtime it targets already exists. Commit #2's doc
backfill folds into F5; the process Gotchas (84/85) ride F4.

---

## 4. Background — how we got here

### The registry already does more than it was being used for

Two execution facilities already exist, and both are general (not fixed-sequence-only):

- `executeAgent()` runs a `WorkflowFn` repeatedly until it says stop, bounded by budget/step
  ceilings.
- `platform/agents/workflow-loop.ts` (ADR-030) is the governed goal-loop — `runGoal()` and
  `advanceGoal()` — where every step goes through the action pipeline, gating and approval
  included.

So the runtime already runs governed, open-ended, tool-looping agents. That is what makes D3 a
_port that deletes code_, not a runtime extension.

### The drift this fixes

Several real agents were never registered and ran their own loops: Sentinel
(`platform/moderation/sentinel.ts`), config-manager (`app/api/admin/config-ai`, whose code still
carries a `"when the agent runtime is activated (Sprint 4b)"` TODO that never happened), the
governance command-bar (`app/api/admin/ai`), and possibly Conductor + the processing units.
Because the registry wasn't the source of truth, `AGENT_ARCHITECTURE` drifted — Sentinel had no
proper entry and the config agent none at all. It is the same failure class that left TAD listing
9 of 35 ADRs for months: nothing fails when a doc quietly falls behind the code. D1 + D5 close
that class for agents.

### Why now, and why all the way

There are no production users yet, so rewriting the admin surface's execution carries no
live-traffic risk. Combined with the goal-loop already existing, there is no reason to register
the planners but leave them bespoke — so D3 reshapes everything now rather than grandfathering.

---

## 5. Invariants

- `listAgents()` is the complete set of agents; docs and the guard derive from it.
- No unregistered agent exists (D5.2).
- No bespoke agent loop exists anywhere (D5.3).
- After Track F, execution is always the governed runtime.

## 6. Conformance kit (L21)

The D5 guard _is_ the conformance kit for "every agent is on the roster and running sanctioned":
it fails closed on any unregistered or bespoke agent. Track F ships it with the migrations.

## 7. Related

ADR-022, ADR-030 (`runGoal`/`advanceGoal`), ADR-028 (action pipeline), ADR-029 (compensation),
ADR-033 (trusted-agent registry), ADR-015, `__tests__/docs-integrity.test.ts`.
