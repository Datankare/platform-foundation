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
}

// ── Tool (P5) ─────────────────────────────────────────────────────────

/**
 * A typed tool definition that an agent can use.
 *
 * Tools are versioned artifacts registered in the agent runtime.
 * Each tool has explicit input/output schemas for validation.
 */
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
