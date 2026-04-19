/**
 * platform/agents/index.ts — Public API
 *
 * Agent type vocabulary for the platform runtime.
 * Sprint 1a: types only. Sprint 4a adds registry, runtime, trajectory, budget.
 *
 * @module platform/agents
 */

// Agent identity (P15)
export type { AgentIdentity } from "./types";

// Trajectory and steps (P18)
export type { Trajectory, Step, TrajectoryStatus, StepBoundary } from "./types";

// Tools (P5)
export type { Tool } from "./types";

// Budget (P12)
export type { BudgetConfig } from "./types";
export { DEFAULT_BUDGET_CONFIG } from "./types";

// Agent config (P2)
export type { AgentConfig } from "./types";
