/**
 * platform/agents/index.ts — Public API
 *
 * Agent runtime for the platform. Sprint 1a delivered types.
 * Sprint 4a adds: registry, tools, trajectory store, budget tracker, runtime.
 *
 * @module platform/agents
 */

// ── Types (Sprint 1a) ────────────────────────────────────────────────

export type { AgentIdentity } from "./types";
export type { Trajectory, Step, TrajectoryStatus, StepBoundary } from "./types";
export type { Tool } from "./types";
export type { BudgetConfig, AgentConfig, EffortTier } from "./types";
export { DEFAULT_BUDGET_CONFIG } from "./types";

// ── Utilities ─────────────────────────────────────────────────────────

export { generateId } from "./utils";

// ── Agent Registry (Sprint 4a) ──────────────────────────────────────

export {
  registerAgent,
  getAgent,
  hasAgent,
  listAgents,
  unregisterAgent,
  resetAgentRegistry,
} from "./registry";

// ── Tool Registry (Sprint 4a) ───────────────────────────────────────

export {
  registerTool,
  getTool,
  hasTool,
  listTools,
  resolveTools,
  resetToolRegistry,
} from "./tools";

// ── Trajectory Store (Sprint 4a) ────────────────────────────────────

export type {
  TrajectoryStore,
  TrajectoryQuery,
  TrajectoryCost,
  TrajectoryRecord,
} from "./trajectory-store";
export {
  InMemoryTrajectoryStore,
  getTrajectoryStore,
  setTrajectoryStore,
  resetTrajectoryStore,
} from "./trajectory-store";

// ── Budget Tracker (Sprint 4a) ──────────────────────────────────────

export type { BudgetStatus, BudgetCheckResult } from "./budget-tracker";
export { BudgetTracker, getBudgetTracker, resetBudgetTracker } from "./budget-tracker";

// ── Runtime (Sprint 4a) ─────────────────────────────────────────────

export type {
  StepOutcome,
  WorkflowContext,
  WorkflowFn,
  ExecutionResult,
} from "./runtime";
export { executeAgent } from "./runtime";

// ── Agent Configs (Sprint 4b) ───────────────────────────────────────

export { AGENT_CONFIGS, registerPlatformAgents } from "./agent-configs";
