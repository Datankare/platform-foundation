/**
 * platform/agents/runtime.ts — Agent execution engine
 *
 * Executes agent workflows as bounded, multi-step, instrumented
 * trajectories with budget enforcement. This is a simple loop,
 * not a framework — no plugin system, no middleware chain.
 *
 * P2:  Agentic execution — bounded workflows with step limits
 * P3:  Total observability — every step timed and costed
 * P11: Resilient degradation — budget exhausted → graceful stop
 * P12: Economic transparency — costs tracked per step
 * P15: Agent identity — actor on every operation
 * P17: Cognition-commitment — step boundary enforced
 * P18: Durable trajectories — full history persisted
 *
 * @module platform/agents
 */

import type { AgentIdentity, Step, StepBoundary } from "./types";
import type { TrajectoryStore } from "./trajectory-store";
import { getTrajectoryStore } from "./trajectory-store";
import { getBudgetTracker } from "./budget-tracker";
import { getEffectLedger } from "./effect-ledger";
import type { EffectLedger } from "@/platform/kernel";
import type { BudgetTracker } from "./budget-tracker";
import { getAgent } from "./registry";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Step builder — what workflow functions return
// ---------------------------------------------------------------------------

/** Outcome of a single workflow step */
export interface StepOutcome {
  /** Action name for the trajectory log */
  readonly action: string;
  /** Whether this step is cognition or commitment (P17) */
  readonly boundary: StepBoundary;
  /** Input data (serializable) */
  readonly input: Record<string, unknown>;
  /** Output data (serializable) */
  readonly output: Record<string, unknown>;
  /** Cost in USD (0 for rule-based steps) */
  readonly costUsd: number;
  /** Should the workflow continue after this step? */
  readonly continueExecution: boolean;
}

/** Context available to workflow functions */
export interface WorkflowContext {
  /** Current trajectory ID */
  readonly trajectoryId: string;
  /** Agent identity for this run */
  readonly identity: AgentIdentity;
  /** Steps completed so far */
  readonly stepCount: number;
  /** Total cost so far */
  readonly totalCostUsd: number;
  /** Scope key for this run */
  readonly scopeKey: string;
}

/**
 * A workflow function. Called repeatedly until it returns
 * continueExecution=false or budget is exhausted.
 *
 * The function receives the context and returns the outcome
 * of the current step.
 */
export type WorkflowFn = (context: WorkflowContext) => Promise<StepOutcome>;

// ---------------------------------------------------------------------------
// Execution result
// ---------------------------------------------------------------------------

export interface ExecutionResult {
  readonly success: boolean;
  readonly trajectoryId: string;
  readonly stepsCompleted: number;
  readonly totalCostUsd: number;
  readonly finalStatus: "completed" | "failed" | "paused" | "indeterminate";
  readonly error?: string;
}

// ---------------------------------------------------------------------------
// executeAgent — the core loop
// ---------------------------------------------------------------------------

/**
 * Execute an agent workflow.
 *
 * 1. Look up agent config from registry
 * 2. Create trajectory in store
 * 3. Loop: check budget → run step → record → repeat
 * 4. Mark trajectory complete/failed
 *
 * @param agentId — registered agent ID
 * @param trigger — what initiated this run
 * @param scopeType — group, user, or platform
 * @param scopeId — specific scope entity (optional)
 * @param workflow — the step function to execute
 * @param store — override trajectory store (testing)
 * @param budget — override budget tracker (testing)
 * @param ledger — override effect ledger (testing)
 */
export async function executeAgent(
  agentId: string,
  trigger: string,
  scopeType: "group" | "user" | "platform",
  scopeId: string | undefined,
  workflow: WorkflowFn,
  store?: TrajectoryStore,
  budget?: BudgetTracker,
  ledger?: EffectLedger
): Promise<ExecutionResult> {
  const trajectoryStore = store ?? getTrajectoryStore();
  const budgetTracker = budget ?? getBudgetTracker();
  // ADR-029 D10: consulted before completion is declared. Optional and last, matching the
  // store/budget override shape, so every existing positional call site is unaffected.
  const effectLedger = ledger ?? getEffectLedger();

  // ── Look up agent ───────────────────────────────────────────────
  const agentConfig = getAgent(agentId);
  if (!agentConfig) {
    return {
      success: false,
      trajectoryId: "",
      stepsCompleted: 0,
      totalCostUsd: 0,
      finalStatus: "failed",
      error: `Agent not registered: ${agentId}`,
    };
  }

  const scopeKey = scopeId ?? scopeType;

  // ── Create trajectory ───────────────────────────────────────────
  const record = await trajectoryStore.create(
    { kind: "agent", id: agentId },
    trigger,
    scopeType,
    scopeId
  );
  const trajectoryId = record.trajectory.trajectoryId;

  const identity: AgentIdentity = {
    actorType: "agent",
    actorId: agentId,
    agentRole: agentConfig.name,
  };

  let stepCount = 0;
  let totalCostUsd = 0;

  try {
    // ── Step loop ─────────────────────────────────────────────────
    while (true) {
      // Budget check before each step
      const budgetCheck = await budgetTracker.checkBudget(
        agentId,
        scopeType,
        scopeId,
        agentConfig.budgetConfig
      );

      if (!budgetCheck.allowed) {
        logger.warn("Agent budget exhausted", {
          agentId,
          trajectoryId,
          reason: budgetCheck.reason,
        });
        await trajectoryStore.updateStatus(trajectoryId, "paused");
        return {
          success: false,
          trajectoryId,
          stepsCompleted: stepCount,
          totalCostUsd,
          finalStatus: "paused",
          error: budgetCheck.reason,
        };
      }

      // Execute step
      const context: WorkflowContext = {
        trajectoryId,
        identity,
        stepCount,
        totalCostUsd,
        scopeKey,
      };

      const startMs = Date.now();
      const outcome = await workflow(context);
      const durationMs = Date.now() - startMs;

      // Record step
      const step: Step = {
        stepIndex: stepCount,
        action: outcome.action,
        boundary: outcome.boundary,
        input: outcome.input,
        output: outcome.output,
        cost: outcome.costUsd,
        durationMs,
        timestamp: new Date().toISOString(),
      };

      await trajectoryStore.addStep(trajectoryId, step);

      // Consume budget
      await budgetTracker.consume(
        agentId,
        scopeType,
        scopeId,
        outcome.costUsd,
        agentConfig.budgetConfig
      );

      stepCount += 1;
      totalCostUsd += outcome.costUsd;

      // Check if workflow is done
      if (!outcome.continueExecution) {
        break;
      }

      // Hard step limit (safety net)
      if (stepCount >= agentConfig.budgetConfig.maxStepsPerTrajectory) {
        logger.warn("Agent hit step limit", {
          agentId,
          trajectoryId,
          maxSteps: agentConfig.budgetConfig.maxStepsPerTrajectory,
        });
        break;
      }
    }

    // ── Complete ────────────────────────────────────────────────────
    // ADR-029 D10: an unresolved external effect makes the whole workflow
    // indeterminate. Reporting completed here would be an at-least-once violation
    // if the effect did fire, and the guess would leave no trace.
    const unresolved = await effectLedger.listUnresolved();
    const mine = unresolved.filter((e) => e.operationId === trajectoryId);
    if (mine.length > 0) {
      await trajectoryStore.updateStatus(trajectoryId, "indeterminate");
      return {
        success: false,
        trajectoryId,
        stepsCompleted: stepCount,
        totalCostUsd,
        finalStatus: "indeterminate",
        error: `${mine.length} external effect(s) unresolved — needs human resolution`,
      };
    }

    await trajectoryStore.updateStatus(trajectoryId, "completed");

    return {
      success: true,
      trajectoryId,
      stepsCompleted: stepCount,
      totalCostUsd,
      finalStatus: "completed",
    };
  } catch (err) {
    // ── Failed ──────────────────────────────────────────────────────
    logger.error("Agent execution failed", {
      agentId,
      trajectoryId,
      error: err instanceof Error ? err.message : "Unknown",
    });

    await trajectoryStore.updateStatus(trajectoryId, "failed");

    return {
      success: false,
      trajectoryId,
      stepsCompleted: stepCount,
      totalCostUsd,
      finalStatus: "failed",
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

// ── Resume (ADR-029 D5) ───────────────────────────────────────────────

export interface ResumeAgentArgs {
  readonly trajectoryId: string;
  readonly workflow: WorkflowFn;
  readonly trajectoryStore?: TrajectoryStore;
  readonly budgetTracker?: BudgetTracker;
  readonly effectLedger?: EffectLedger;
}

/**
 * Resume a paused trajectory.
 *
 * Replays from the trajectory: steps already recorded are NOT re-executed. The workflow is
 * called with stepCount already advanced past them, so a workflow that branches on
 * stepCount continues where it stopped rather than repeating work — which is the D5
 * guarantee, and the reason `paused` is a real state rather than a decorated failure.
 *
 * Refuses anything not `paused`: resuming a completed or failed trajectory would append
 * steps to a finished record, and resuming a running one would double-execute.
 */
export async function resumeAgent(args: ResumeAgentArgs): Promise<ExecutionResult> {
  const trajectoryStore = args.trajectoryStore ?? getTrajectoryStore();
  const budgetTracker = args.budgetTracker ?? getBudgetTracker();
  const effectLedger = args.effectLedger ?? getEffectLedger();

  const record = await trajectoryStore.getById(args.trajectoryId);
  if (!record) {
    return {
      success: false,
      trajectoryId: args.trajectoryId,
      stepsCompleted: 0,
      totalCostUsd: 0,
      finalStatus: "failed",
      error: `Trajectory not found: ${args.trajectoryId}`,
    };
  }

  if (record.trajectory.status !== "paused") {
    return {
      success: false,
      trajectoryId: args.trajectoryId,
      stepsCompleted: record.trajectory.steps.length,
      totalCostUsd: record.trajectory.totalCost,
      finalStatus: "failed",
      error: `Trajectory is ${record.trajectory.status}, not paused — nothing to resume`,
    };
  }

  const agentId = record.subject.id;
  const agentConfig = getAgent(agentId);
  if (!agentConfig) {
    return {
      success: false,
      trajectoryId: args.trajectoryId,
      stepsCompleted: record.trajectory.steps.length,
      totalCostUsd: record.trajectory.totalCost,
      finalStatus: "failed",
      error: `Agent not registered: ${agentId}`,
    };
  }

  const identity: AgentIdentity = {
    actorType: "agent",
    actorId: agentId,
    agentRole: agentConfig.name,
  };

  // Already-recorded steps are the resume anchor: execution continues AFTER them.
  let stepCount = record.trajectory.steps.length;
  let totalCostUsd = record.trajectory.totalCost;
  const scopeType = record.scopeType;
  const scopeId = record.scopeId ?? undefined;
  const scopeKey = scopeId ?? scopeType;

  await trajectoryStore.updateStatus(args.trajectoryId, "running");

  try {
    while (true) {
      const budgetCheck = await budgetTracker.checkBudget(
        agentId,
        scopeType,
        scopeId,
        agentConfig.budgetConfig
      );

      if (!budgetCheck.allowed) {
        await trajectoryStore.updateStatus(args.trajectoryId, "paused");
        return {
          success: false,
          trajectoryId: args.trajectoryId,
          stepsCompleted: stepCount,
          totalCostUsd,
          finalStatus: "paused",
          error: budgetCheck.reason,
        };
      }

      const context: WorkflowContext = {
        trajectoryId: args.trajectoryId,
        identity,
        stepCount,
        totalCostUsd,
        scopeKey,
      };

      const startMs = Date.now();
      const outcome = await args.workflow(context);
      const durationMs = Date.now() - startMs;

      await trajectoryStore.addStep(args.trajectoryId, {
        stepIndex: stepCount,
        action: outcome.action,
        boundary: outcome.boundary,
        input: outcome.input,
        output: outcome.output,
        cost: outcome.costUsd,
        durationMs,
        timestamp: new Date().toISOString(),
      });

      await budgetTracker.consume(
        agentId,
        scopeType,
        scopeId,
        outcome.costUsd,
        agentConfig.budgetConfig
      );

      stepCount += 1;
      totalCostUsd += outcome.costUsd;

      if (!outcome.continueExecution) break;
      if (stepCount >= agentConfig.budgetConfig.maxStepsPerTrajectory) break;
    }

    // ADR-029 D10, same guard as executeAgent. Resume runs after a crash or a pause,
    // which is exactly when an external effect was left in flight — so this path is the
    // likeliest to meet an unresolved one, not the least.
    const unresolved = await effectLedger.listUnresolved();
    const mine = unresolved.filter((e) => e.operationId === args.trajectoryId);
    if (mine.length > 0) {
      await trajectoryStore.updateStatus(args.trajectoryId, "indeterminate");
      return {
        success: false,
        trajectoryId: args.trajectoryId,
        stepsCompleted: stepCount,
        totalCostUsd,
        finalStatus: "indeterminate",
        error: `${mine.length} external effect(s) unresolved — needs human resolution`,
      };
    }

    await trajectoryStore.updateStatus(args.trajectoryId, "completed");
    return {
      success: true,
      trajectoryId: args.trajectoryId,
      stepsCompleted: stepCount,
      totalCostUsd,
      finalStatus: "completed",
    };
  } catch (err) {
    await trajectoryStore.updateStatus(args.trajectoryId, "failed");
    return {
      success: false,
      trajectoryId: args.trajectoryId,
      stepsCompleted: stepCount,
      totalCostUsd,
      finalStatus: "failed",
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}
