# The GenAI-Native Systems Manifesto

**Owner:** Raman Sud, CTO
**Canonical location:** `docs/GENAI_MANIFESTO.md`
**Companion document:** [`docs/GENAI_ROADMAP.md`](./GENAI_ROADMAP.md) — maps these principles to phased delivery

> This manifesto defines the principles for designing GenAI-native systems that are reliable, observable, and production-grade by default. These principles are domain-agnostic and apply to any system where AI participates in execution, decision-making, or user interaction.

---

## 1. Intent-Driven Interaction

Natural language and structured intent are first-class inputs.

- **Parsing:** User and system intent is parsed into structured execution plans.
- **Validation:** Plans are validated and "dry-run" before execution.
- **Dynamic UI:** Interfaces are generated or adapted based on real-time task requirements.

## 2. Agentic Execution Model

Work is performed by bounded execution units (agents).

- **Multi-step:** Agents can plan, call tools, and execute complex workflows.
- **Instrumented:** Every execution is scoped, observable, and interruptible.
- **Bounded Autonomy:** Action is explicitly constrained by system-level policies.

## 3. Total Observability

All AI interactions are fully instrumented.

- **Rich Tracing:** Every request records model, prompt version, inputs, outputs, latency, and cost.
- **Real-time Queries:** Execution traces are queryable to identify bottlenecks or failures instantly.
- **Zero Guesswork:** Systems are debuggable through deterministic logs, not anecdotal "vibes."

## 4. Structural Safety by Default

Safety is enforced at the system level, not added as a feature.

- **Pipeline Defense:** Input validation and prompt injection defenses are baked into the request pipeline.
- **Policy Checks:** Output validation is mandatory before any plan is executed.
- **Isolation:** Data access is governed by strict permissions and tenant isolation boundaries.

## 5. Prompts and Tools as Versioned Artifacts

All AI-facing components are managed as code.

- **Registry:** Prompts, tool definitions, and workflows are versioned in a central registry.
- **Lifecycle:** Changes are testable, comparable, and reversible.
- **Deployment:** A/B testing and canary rollouts are to be first-class capabilities. _Not built yet:_ a
  prompt or model change ships to everyone at once, behind the deterministic eval lane and the live
  eval lane (ADR-038); split tests and canaries are planned ([FEAT-091](./TASKS.md)).

## 6. Structured Outputs and Self-Healing Contracts

AI outputs must conform to explicit schemas.

- **Schema Enforcement:** Outputs are validated against JSON/Pydantic schemas before downstream use.
- **Graceful Parsing:** The system includes a "self-healing" layer to re-parse or fix minor schema deviations.
- **Zero Trust:** Unstructured text is never directly trusted for system execution.

## 7. Provider-Aware Orchestration

Model usage is abstracted but behavior is not assumed to be interchangeable.

- **Multi-Provider:** Systems support multiple providers and model types (SaaS and local).
- **Smart Routing:** Decisions consider capability, cost, latency, and reliability per task.
- **Managed Variance:** Behavioral differences across models are explicitly addressed in the logic.

## 8. Context and Memory Management

Context is intentionally constructed, not implicitly assumed.

- **Layered Memory:** Retrieval (RAG), session state, and system memory are managed as distinct layers.
- **Scoped Injection:** Context injection is auditable, cost-aware, and limited to what is necessary.
- **Access Control:** Data freshness and relevance are enforced at the retrieval layer.

## 9. Automated Evaluation and Continuous Validation

System quality is continuously measured.

- **Pre-release Evals:** Changes to prompts or models require passing an automated benchmark suite.
- **Signal Monitoring:** Production traffic is monitored for hallucination and drift signals.
- **Success Metrics:** Tracking goes beyond "latency" to include task success and accuracy.
- **Adversarial Validation (core tenet):** Every test proves what the system refuses, not only what it does. Every category of test — unit, component, integration, conformance, end-to-end, evals, load — carries hostile cases: each actor attempting what it must not do, every second path to the same effect, generated malformed and injected input, random monkey sequences checked against invariants, real guards and real data stores on privileged paths, and injected failures that must fail closed. The standard and its enforcement are in [CONTRIBUTING](../CONTRIBUTING.md#adversarial-validation--a-core-tenet).

## 10. Human Oversight and Control

Humans remain the final authority over critical actions.

- **Authorization:** High-impact or destructive operations require explicit human "Confirm."
- **Intervention:** Systems support manual override, rollback, and deep auditability.
- **RBAC:** Role-based access controls govern who can authorize which AI-driven actions.

## 11. Resilient Degradation

Systems are designed to function under partial failure.

- **Fallbacks:** Fallback models or deterministic logic are triggered when the primary AI is unavailable.
- **Containment:** Failures are isolated to specific agents and do not cascade.
- **Uptime over Intelligence:** Graceful degradation to manual or static workflows is preferred over an outage.

## 12. Economic Transparency and Control

AI cost is a first-class operational concern.

- **Unit Economics:** Usage is tracked and attributed per request, user, and feature.
- **Runtime Limits:** Budgets and rate limits are enforced at the orchestration layer.
- **Optimization:** Systems dynamically optimize for the best cost-to-quality ratio.

## 13. Control Plane and Governance

A centralized control layer governs all AI behavior.

- **Centralized Policy:** Global rules define what can be executed and by whom.
- **Independent Config:** System-wide governance (safety, cost, access) is managed separately from app logic.
- **Compliance:** Runtime enforcement ensures the system adheres to organizational standards.

## 14. Self-Improving Feedback Loops

Systems evolve based on real-world usage.

- **Signal Capture:** User feedback and execution outcomes are captured continuously.
- **Data-Driven Tuning:** Prompt tuning and model selection are informed by production data.
- **Guardrails:** Safeguards prevent feedback loops from degrading system quality over time.

## 15. Agent Identity as Delegated Capability

Identity evolves from "who are you" to "what are you allowed to do right now."

- **Delegation Chain:** Every agent action carries provenance — who initiated the goal, which agent interpreted it, which sub-agent proposed the next step.
- **Scoped Permissions:** Agent permissions are narrow, time-bounded, and revocable — not inherited from the user's broad session.
- **Auditability:** The full delegation chain (user → planner → researcher → executor) is logged and reconstructible for any action.
- **Separation of Actor:** An agent acting on behalf of a user is a distinct identity with distinct constraints, not the user themselves.

## 16. Cognitive Memory Architecture

Agent memory is a structured architecture, not a single store.

- **Working Memory:** Active task state — what the agent is doing now, what it has tried, what is pending.
- **Episodic Memory:** Temporal trajectories — sequences of attempts, observations, errors, and outcomes across sessions.
- **Semantic Memory:** Durable facts about users, organizations, systems, and domains — with consolidation and contradiction handling.
- **Procedural Memory:** Learned routines and policies — how this class of task should generally be approached, versioned and governed.
- **Resource Memory:** Where things live — which dashboard, repo, file, workflow, or person is relevant, with permission-aware retrieval.
- **Selective Recall:** Remembering well is more important than remembering everything. Forgetting policies, freshness signals, and trust boundaries are explicit.

## 17. Cognition-Commitment Boundary

Internal deliberation and external action are architecturally separated.

- **Internal Fluidity:** Agents may branch, backtrack, reconsider, and explore hypotheses freely within the cognitive loop.
- **External Durability:** Actions that touch production systems, send messages, spend money, or modify state are durable, idempotent, and explicitly approved.
- **No Leakage:** No agent "thinking out loud" leaks into the real world as side effects. Draft actions are held until committed.
- **Approval Gates:** Actions above a configurable risk threshold require deterministic validation, policy check, or human approval before commitment.

## 18. Durable Execution Trajectories

The execution unit is the trajectory, not the request.

- **Trajectory as Object:** The evolving path of reasoning, tool use, and state transitions connecting a goal to an outcome is the primary runtime object.
- **Checkpointed:** Agent state is checkpointed between steps — surviving crashes, resuming after interruption, replaying for debugging.
- **Inspectable:** Pause, resume, branch, approve, and rollback are first-class operations available to users and admins.
- **Behavioral Forensics:** When an agent makes a poor choice, the postmortem reads like a behavioral analysis — why the agent chose that tool, what alternatives it considered, what context it retrieved, what evidence it found persuasive.

---

## Principle Readiness

| #   | Principle                         | Status     | Platform Implementation                                                                                                   |
| --- | --------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | Intent-Driven Interaction         | ✅ Built   | Admin AI command bar — NL → plan → confirm → execute                                                                      |
| 2   | Agentic Execution Model           | ✅ Built   | Agent runtime and workflow loop (`platform/agents`, ADR-029/030): tools through the governed action pipeline              |
| 3   | Total Observability               | ✅ Built   | Tracing, metrics, error reporting, health (Sprint 3)                                                                      |
| 4   | Structural Safety by Default      | ✅ Built   | Blocklist + LLM classifier; input screened, output screened (stream windows, `lib/output-screening.ts`)                   |
| 5   | Prompts as Versioned Artifacts    | 🔶 Partial | Prompt registry with versions and eval suites; A/B tests and canary rollouts not built ([FEAT-091](./TASKS.md))           |
| 6   | Structured Outputs & Self-Healing | ✅ Built   | Tool inputs and outputs checked against JSON Schema, retried rather than coerced (ADR-029 D3); prompt parsers fail closed |
| 7   | Provider-Aware Orchestration      | ✅ Built   | Provider abstraction, model tiering, circuit breaker; the weekly model check (`scripts/check-model-ids.mjs`)              |
| 8   | Context & Memory Management       | 🔶 Partial | RAG types, chunker and embedding registry (`platform/rag`); no embedding provider built                                   |
| 9   | Automated Eval & Validation       | ✅ Built   | Prompt evals: a deterministic lane gating CI and a keyed live lane, `npm run eval:live` (ADR-038)                         |
| 10  | Human Oversight & Control         | ✅ Built   | Plan → confirm → execute; held actions and two-person approval (dual control)                                             |
| 11  | Resilient Degradation             | 🔶 Partial | Circuit breaker + retry built; a fallback model per tier planned ([TASK-188](./TASKS.md))                                 |
| 12  | Economic Transparency             | 🔶 Partial | Per-call cost; agent and tenant budgets; a daily paid-request quota per user; no per-user cost budget                     |
| 13  | Control Plane & Governance        | 🔶 Partial | Governed settings by tier, dual control, agent budgets and step caps; A/B testing not built ([FEAT-091](./TASKS.md))      |
| 14  | Self-Improving Feedback Loops     | ⏳ Planned | Feedback loop + quality monitoring planned                                                                                |
| 15  | Agent Identity as Delegation      | 🔶 Partial | Agents act under their own identity, scoped capabilities and on-behalf-of; delegated credentials are the app's (Playform) |
| 16  | Cognitive Memory Architecture     | ⏳ Planned | Extends RAG/user context with structured memory types                                                                     |
| 17  | Cognition-Commitment Boundary     | ✅ Built   | Each step records its boundary; a gated action is held as a proposal until approved (ADR-029 D5–D8)                       |
| 18  | Durable Execution Trajectories    | ✅ Built   | Trajectories checkpointed per step, resumable under the same caps, retained by policy (`platform/agents`)                 |

**Summary (re-checked against the code on 2026-11-08, TASK-204 N-49):** 10 of 18 principles built,
6 partially built, 2 planned. All 18 are accounted for in the [GenAI-Native Roadmap](./GENAI_ROADMAP.md).

---

## References

| Source                                                                                                                                                                         | Relevance                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rodriguez, J. (2026). "The Agent-Native Rewrite: Why Every Piece of Software Infrastructure Needs to be Reimagined for AI Agents." _The Sequence Opinion #840_, April 9, 2026. | Informed P15 (Agent Identity), P16 (Cognitive Memory), P17 (Cognition-Commitment Boundary), P18 (Durable Execution Trajectories). Core thesis: identity, storage, messaging, memory, execution, and observability must be rethought for AI agents that generate their own control flow. |

---

## Changelog

| Date       | Author    | Change                                                                                                                                                                                                        |
| ---------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-04-09 | Raman Sud | P15-P18 elevated to cross-phase fabric (not Phase 5 deferrals). Agentic-native is a standing architectural commitment across all phases.                                                                      |
| 2026-04-09 | Raman Sud | Added P15–P18 (Agent Identity, Cognitive Memory, Cognition-Commitment Boundary, Durable Execution Trajectories). Informed by Rodriguez 2026 "Agent-Native Rewrite." Readiness table updated to 18 principles. |
| 2026-04-07 | Raman Sud | Initial manifesto — 14 principles extracted from platform architecture and roadmap planning. Readiness table added.                                                                                           |

_Last updated: November 8, 2026 (TASK-204, N-49 — §5 and the readiness table re-checked against the code)_
