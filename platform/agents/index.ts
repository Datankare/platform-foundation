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

export { generateId, generateSecureId, generateUuid } from "./utils";

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
  AddStepOptions,
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
  readTrajectoryChain,
  latestTrajectorySegment,
  chainSteps,
  trajectoryChainPages,
} from "./trajectory-store";

// ── Capability→feature map, read fail closed (review 12 H1) ─────────

export type { CapabilityFeatureDecision } from "./capability-features";
export { evaluateCapabilityFeatures, requiredFeatures } from "./capability-features";

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
export { PostgresEffectLedger } from "./postgres-effect-ledger";
export { performExternalEffect } from "./external-effect";
export type { ExternalEffectArgs, ExternalEffectOutcome } from "./external-effect";
export type { ResumeAgentArgs } from "./runtime";
export {
  InMemoryProposalStore,
  getProposalStore,
  setProposalStore,
  resetProposalStore,
} from "./proposal-store";
export { PostgresProposalStore } from "./postgres-proposal-store";
export { PostgresTrajectoryStore } from "./postgres-trajectory-store";
export { PostgresBudgetStore } from "./postgres-budget-store";
export { InMemoryBudgetStore, setBudgetTracker } from "./budget-tracker";
export { UndeclaredExternalEffectError } from "./tool-invoker";
export { invokeTool, DEFAULT_OUTPUT_RETRIES } from "./tool-invoker";
export type { InvokeToolArgs, InvokeToolResult } from "./tool-invoker";
export { assertValidSchema, isValidSchema, SchemaValidationError } from "./schema";

// ── Agent Configs (Sprint 4b) ───────────────────────────────────────

export { AGENT_CONFIGS, registerPlatformAgents } from "./agent-configs";
export { CORE_AGENT_GOALS, listAgentGoals, isAgentGoal } from "./goals";
export {
  registerWorkflow,
  resolveWorkflow,
  listWorkflowGoals,
  listWorkflows,
  resetWorkflowRegistry,
  runGoal,
  advanceGoal,
  resumeApprovedAction,
  TrajectoryAccessError,
  ApprovalMismatchError,
  HeldActionNotApprovedError,
} from "./workflow-loop";
export type {
  WorkflowDefinition,
  WorkflowStep,
  WorkflowStepContext,
  RunGoalArgs,
  ResumeApprovedActionArgs,
} from "./workflow-loop";
export {
  approvalPolicy,
  approveHeldAction,
  rejectHeldAction,
  heldActionRefusal,
  principalOf,
} from "./gating";
export type { HeldActionRefusal } from "./gating";
export {
  getApprovalPolicyStore,
  setApprovalPolicyStore,
  resetApprovalPolicyStore,
  resolveApprover,
  InMemoryApprovalPolicyStore,
  DEFAULT_APPROVAL_POLICY,
  approvalRulesProblem,
} from "./approval-policy-store";
export { PostgresApprovalPolicyStore } from "./postgres-approval-policy-store";
export type {
  ApprovalPolicy,
  ApprovalRule,
  ApprovalPolicyStore,
  ActorType,
} from "./approval-policy-store";
export type { ApproveHeldActionArgs } from "./gating";
export { buildCapabilities } from "./capabilities";
export type { Capabilities, GoalCapability, CapabilityStep } from "./capabilities";
