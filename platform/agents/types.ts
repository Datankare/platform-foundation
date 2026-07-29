/**
 * platform/agents/types.ts — Agent type vocabulary
 *
 * Foundational types for the agent runtime. Pulled forward from Sprint 4a
 * because Sprint 1a's input module needs AgentIdentity and Trajectory types.
 *
 * These types are domain-agnostic — they define the agent runtime vocabulary,
 * not any specific agent's behavior. Specific agents (Conductor, Guardian,
 * Matchmaker, etc.) are defined in their own modules.
 *
 * GenAI Principles:
 *   P2  — Agentic execution: agents are bounded, multi-step, instrumented
 *   P3  — Total observability: every step records cost, latency, timestamps
 *   P5  — Versioned artifacts: tool definitions are typed and registerable
 *   P6  — Structured outputs: all types enforce schemas
 *   P12 — Economic transparency: cost tracking at step and trajectory level
 *   P15 — Agent identity: actorType/actorId/agentRole/onBehalfOf
 *   P17 — Cognition-commitment: step actions are typed for boundary enforcement
 *   P18 — Durable trajectories: trajectoryId/stepIndex, checkpointable
 *
 * @module platform/agents
 */

// ── Agent Identity (P15) ──────────────────────────────────────────────

/**
 * Who is performing an action.
 *
 * Every agent action carries identity — the delegation chain from user
 * through planner to executor is fully reconstructible.
 */
export interface AgentIdentity {
  /** What kind of actor: user, agent, or system */
  readonly actorType: "user" | "agent" | "system";
  /** Unique identifier for this actor */
  readonly actorId: string;
  /** Role this agent is playing (e.g., "conductor", "guardian", "classifier") */
  readonly agentRole: string;
  /** If this agent is acting on behalf of someone, their ID */
  readonly onBehalfOf?: string;
}

// ── Trajectory (P18) ──────────────────────────────────────────────────

/**
 * Status of a trajectory.
 *
 * - running: actively executing steps
 * - completed: all steps finished successfully
 * - failed: a step failed and the trajectory was not recovered
 * - paused: checkpointed and waiting for resume or human approval
 */
export type TrajectoryStatus = "running" | "completed" | "failed" | "paused";

/**
 * A durable execution trajectory.
 *
 * The trajectory is the primary runtime object — not the request.
 * It connects a goal to an outcome through a series of inspectable steps.
 * Trajectories survive crashes, support resume, and enable behavioral forensics.
 */
export interface Trajectory {
  /** Unique trajectory ID — stable across all steps in a workflow */
  readonly trajectoryId: string;
  /** The agent that owns this trajectory */
  readonly agentId: string;
  /** Ordered list of steps taken */
  readonly steps: readonly Step[];
  /** Current status */
  readonly status: TrajectoryStatus;
  /** Total accumulated cost in USD across all steps */
  readonly totalCost: number;
  /** ISO timestamp when trajectory was created */
  readonly createdAt: string;
  /** ISO timestamp of last update */
  readonly updatedAt: string;
}

// ── Step (P18) ────────────────────────────────────────────────────────

/**
 * Whether a step is cognition (internal, revisable) or commitment
 * (external, durable, audited). See P17.
 */
export type StepBoundary = "cognition" | "commitment";

// ── Effects & Risk (ADR-028 D3 vocabulary, declared here per ADR-029 D1) ──

/**
 * The unit of both capability grant and risk floor. An action or a tool declares the
 * effects it performs; effects grant the ability to act AND source the minimum risk
 * level. Declaring an effect cannot be gamed (P4).
 *
 * Declared in platform/agents rather than platform/app-framework because ADR-029 D1 puts
 * `effects` on `Tool`, and the dependency runs one way: platform/agents imports nothing,
 * while app-framework, admin, input and moderation all import from it. Declaring these in
 * app-framework and importing them here would close a cycle; re-declaring them here would
 * be the parallel vocabulary ADR-029 D1 rules out. platform/app-framework/types.ts
 * re-exports both, so every existing consumer is unchanged and there is one declaration.
 */
export type EffectType = "stateWrite" | "externalCall" | "sendMessage" | "restricted";

/**
 * Risk level of an action or tool call. `effectiveRisk = max(declaredRisk,
 * max(effectFloors))` — a consumer may raise risk, never lower it below the effect
 * floor (P4). The floors themselves stay in app-framework: they are policy, not
 * vocabulary.
 */
export type RiskLevel = "ordinary" | "consequential" | "restricted";

// ── Action Context (ADR-028 D3, ADR-031 D9) ───────────────────────────

/**
 * The justification record for an action, assembled by the coordinator — never by a
 * consumer and never by a domain hook. Carried across propose → commit → effect →
 * trajectory (ADR-031 D9).
 *
 * Declared here so `Tool.execute` can receive one without platform/agents importing the
 * app-framework. Re-exported from platform/app-framework/types.ts, which remains its
 * conceptual home.
 */
export interface ActionContext {
  /** Stable identity of the logical action across all five stages (ADR-031 D1). */
  readonly operationId: string;
  /** Scoped under operationId; present only for revisable gated actions (ADR-031 D3). */
  readonly proposalId?: string;
  /** Who is acting (P15). */
  readonly actor: AgentIdentity;
  /** The session this action belongs to. */
  readonly sessionId: string;
  /** Cognition (held) vs commitment (durable) — P17. */
  readonly boundary: StepBoundary;
  /** Effects this action performs — capability grant + risk-floor source. */
  readonly effects: readonly EffectType[];
  /** max(declaredRisk, max(effect floors)) — computed by the coordinator. */
  readonly effectiveRisk: RiskLevel;
}

/**
 * A single step within a trajectory.
 *
 * Steps are the atomic unit of agent execution. Each step records
 * what action was taken, what data went in and came out, how long
 * it took, and how much it cost. Steps are typed as cognition or
 * commitment per P17.
 */
export interface Step {
  /** Position in the trajectory (0-indexed) */
  readonly stepIndex: number;
  /** What the agent did (e.g., "classify-audio", "resolve-intent", "route-to-pipeline") */
  readonly action: string;
  /** Input data for this step (serializable) */
  readonly input: Record<string, unknown>;
  /** Output data from this step (serializable) */
  readonly output: Record<string, unknown>;
  /** Cost in USD for this step (0 for rule-based operations) */
  readonly cost: number;
  /** Duration of this step in milliseconds */
  readonly durationMs: number;
  /** ISO timestamp when this step executed */
  readonly timestamp: string;
  /** Whether this step is cognition (revisable) or commitment (durable) — P17 */
  readonly boundary: StepBoundary;
  /**
   * Stable identity of the logical action this step belongs to (ADR-031 D1).
   *
   * The identity fields below are optional so Phase 4 callers compile unchanged
   * (ADR-029 D4 — additive). The framework always populates them.
   */
  readonly operationId?: string;
  /** Present only for revisable gated actions (ADR-031 D3). */
  readonly proposalId?: string;
  /** Who performed this step (P15) — carried from the ActionContext. */
  readonly actor?: AgentIdentity;
  /** Effects this step performed — capability grant + risk-floor source. */
  readonly effects?: readonly EffectType[];
  /** max(declaredRisk, max(effect floors)) as computed for this step. */
  readonly effectiveRisk?: RiskLevel;
}

// ── Tool (P5) ─────────────────────────────────────────────────────────

/**
 * A typed tool definition that an agent can use.
 *
 * Tools are versioned artifacts registered in the agent runtime.
 * Each tool has explicit input/output schemas for validation.
 */
/**
 * The handler a tool runs (ADR-029 D1).
 *
 * `input` is validated against `inputSchema` before the call and the return value against
 * `outputSchema` after (ADR-029 D3) — invalid output is retried within the step budget,
 * never coerced.
 *
 * `context` is optional in Sprint 2 step 1 and becomes required when ADR-029 D2 routes tool
 * invocation through the ADR-028 D3 pipeline. Nothing assembles an ActionContext for a tool
 * call before D2, and a call site synthesising one would be minting an operationId outside
 * the coordinator, which ADR-031 D1 forbids.
 */
export type ToolExecute = (
  input: Record<string, unknown>,
  context?: ActionContext
) => Promise<Record<string, unknown>>;

export interface Tool {
  /** Unique tool identifier */
  readonly id: string;
  /** Human-readable name */
  readonly name: string;
  /** What the tool does */
  readonly description: string;
  /** JSON Schema for tool input */
  readonly inputSchema: Record<string, unknown>;
  /** JSON Schema for tool output */
  readonly outputSchema: Record<string, unknown>;
  /**
   * The handler (ADR-029 D1). A registered tool is invocable, not merely declared — the
   * registry no longer stores declarations that nothing can call.
   */
  readonly execute: ToolExecute;
  /** What this tool does to the world, in the ADR-028 D3 vocabulary (ADR-029 D1). */
  readonly effects: readonly EffectType[];
  /** Advisory and upward-only from the effect floor, exactly as ActionSpec (ADR-029 D1). */
  readonly declaredRisk?: RiskLevel;
}

// ── Budget (P12) ──────────────────────────────────────────────────────

/**
 * Budget configuration for an agent.
 *
 * Prevents runaway costs by capping per-trajectory and daily spend.
 */
export interface BudgetConfig {
  /** Maximum cost in USD per trajectory */
  readonly maxCostPerTrajectory: number;
  /** Maximum cost in USD per day */
  readonly maxCostPerDay: number;
  /** Maximum number of steps per trajectory */
  readonly maxStepsPerTrajectory: number;
}

/** Sensible defaults — tight budget for rule-based agents */
export const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  maxCostPerTrajectory: 0.1,
  maxCostPerDay: 5.0,
  maxStepsPerTrajectory: 20,
};

// ── Effort Tier (P12) ──────────────────────────────────────────────────

/**
 * Effort tier for agent LLM calls.
 *
 * Controls how much thinking budget an agent gets per step.
 * "low" for clear signals, "standard" for typical decisions,
 * "max" for ambiguous or high-stakes evaluations.
 *
 * Informed by Rezvani 2026 "/powerup" analysis: not every
 * classification needs Opus-max tokens.
 */
export type EffortTier = "low" | "standard" | "max";

// ── Agent Config (P2) ─────────────────────────────────────────────────

/**
 * Configuration for an agent instance.
 *
 * Agents are configured, not coded. The runtime reads AgentConfig
 * to know what tools an agent has, what its budget is, and what
 * its identity is.
 */
export interface AgentConfig {
  /** Unique agent identifier */
  readonly id: string;
  /** Human-readable name */
  readonly name: string;
  /** Description of what this agent does */
  readonly description: string;
  /** Tools available to this agent */
  readonly tools: readonly Tool[];
  /** Budget constraints */
  readonly budgetConfig: BudgetConfig;
  /** Effort tier for LLM calls (P12) — defaults to "standard" */
  readonly effortTier?: EffortTier;
}

// ── Gotchas ───────────────────────────────────────────────────────────
//
// (L17) Module-level gotchas — add issues here as they're discovered.
//
// 1. All fields are `readonly` — use spread operator to create modified copies.
//    Do NOT use type assertions to bypass readonly.
//
// 2. Step.input and Step.output are Record<string, unknown> — always validate
//    structure before accessing nested fields. Use type guards.
//
// 3. Trajectory.steps is `readonly Step[]` — to add a step, spread into a new
//    array: `{ ...trajectory, steps: [...trajectory.steps, newStep] }`
//
// 4. BudgetConfig.maxCostPerTrajectory = 0.10 USD by default. This is intentionally
//    tight for rule-based agents. Override for LLM-backed agents in Sprint 4b.
