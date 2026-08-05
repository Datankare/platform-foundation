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
export type { Tool, ToolExecute, EffectType, RiskLevel, ActionContext } from "./types";
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
export { executeAgent, resumeAgent } from "./runtime";
export {
  InMemoryEffectLedger,
  getEffectLedger,
  setEffectLedger,
  resetEffectLedger,
  idempotencyKeyFor,
} from "./effect-ledger";
export { SupabaseEffectLedger } from "./supabase-effect-ledger";
export { performExternalEffect } from "./external-effect";
export type { ExternalEffectArgs, ExternalEffectOutcome } from "./external-effect";
export type { ResumeAgentArgs } from "./runtime";
export {
  InMemoryProposalStore,
  getProposalStore,
  setProposalStore,
  resetProposalStore,
} from "./proposal-store";
export { SupabaseProposalStore } from "./supabase-proposal-store";
export { invokeTool, DEFAULT_OUTPUT_RETRIES } from "./tool-invoker";
export type { InvokeToolArgs, InvokeToolResult } from "./tool-invoker";
export { assertValidSchema, isValidSchema, SchemaValidationError } from "./schema";

// ── Agent Configs (Sprint 4b) ───────────────────────────────────────

export { AGENT_CONFIGS, registerPlatformAgents } from "./agent-configs";
