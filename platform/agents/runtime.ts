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
  readonly finalStatus: "completed" | "failed" | "paused";
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
 */
export async function executeAgent(
  agentId: string,
  trigger: string,
  scopeType: "group" | "user" | "platform",
  scopeId: string | undefined,
  workflow: WorkflowFn,
  store?: TrajectoryStore,
  budget?: BudgetTracker
): Promise<ExecutionResult> {
  const trajectoryStore = store ?? getTrajectoryStore();
  const budgetTracker = budget ?? getBudgetTracker();

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

  const scopeKey = (scopeId ?? scopeType === "platform") ? "platform" : scopeType;

  // ── Create trajectory ───────────────────────────────────────────
  const record = await trajectoryStore.create(agentId, trigger, scopeType, scopeId);
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
      const budgetCheck = budgetTracker.checkBudget(
        agentId,
        scopeKey,
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
      budgetTracker.consume(agentId, scopeKey, outcome.costUsd, agentConfig.budgetConfig);

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
