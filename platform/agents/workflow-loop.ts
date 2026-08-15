/**
 * platform/agents/workflow-loop.ts — The PF-B workflow loop (ADR-030 D2, D4)
 *
 * One workflow definition per goal, with TWO entry points over the same runner:
 *
 *   runGoal()      orchestration — runs every remaining step server-side, one call
 *   advanceGoal()  choreography  — runs the next step only, agent picks the next hop
 *
 * Both call runSteps(). That is the whole of D2's "same machinery" claim: there is no
 * second implementation to drift, because there is no second implementation.
 *
 * D4 (no gate-skipping fast path) is structural rather than remembered: every step
 * executes through invokeTool, so the risk floor, the budget ceiling and the trajectory
 * append come from the action pipeline (ADR-029 D2). The loop has no code path that
 * reaches a provider without going through it, so there is nothing to forget.
 *
 * GenAI Principles: P1 (goal-driven), P2 (bounded, interruptible), P4 (gates on both
 * paths), P6 (AgentResponse envelope), P12 (CostSummary), P18 (durable trajectory).
 *
 * @module platform/agents
 */

import type {
  AgentGoal,
  AgentIdentity,
  AgentResponse,
  CostSummary,
  NextAction,
  Step,
  Tool,
  TrajectoryRecord,
  TrajectoryStore,
} from "@/platform/kernel";
import { getSingleton, setSingleton } from "@/platform/kernel/singleton";
import { PipelineRejectedError } from "@/platform/action-pipeline";
import { invokeTool } from "./tool-invoker";
import { getTrajectoryStore } from "./trajectory-store";

// ── Definition ────────────────────────────────────────────────────────

/** What the steps executed so far produced, for the next step's input. */
export interface WorkflowContext {
  readonly goal: AgentGoal;
  readonly input: Record<string, unknown>;
  /** Outputs of completed steps, in order. */
  readonly outputs: readonly Record<string, unknown>[];
}

/**
 * One step of a workflow.
 *
 * `intent` is the STEP-level semantic the provider layer already emits (ADR-030 D1) —
 * the same vocabulary as IDENTIFY_INTENT and STEP_INTENT_MAP. It is not the goal, and
 * the two names are never used for each other.
 */
export interface WorkflowStep {
  readonly tool: Tool;
  readonly intent: string;
  /**
   * Declared pre-execution cost estimate in USD.
   *
   * The budget ceiling is checked before the step runs, so the figure has to be known
   * before the provider reports what it actually charged. Reconciling the estimate
   * against the provider's own estimatedCostUsd is TASK-085.
   */
  readonly estimatedCostUSD: number;
  readonly input: (ctx: WorkflowContext) => Record<string, unknown>;
}

export interface WorkflowDefinition {
  readonly goal: AgentGoal;
  readonly description: string;
  readonly steps: readonly WorkflowStep[];
  /** Endpoint an agent calls to continue or re-enter this workflow. */
  readonly endpoint: string;
}

// ── Registry ──────────────────────────────────────────────────────────

/**
 * ADR-032: anchored on globalThis. A module-scope Map is duplicated per bundle entry,
 * so a workflow registered at startup would be invisible to the request that needed it.
 */
const WORKFLOW_REGISTRY_KEY = "platform.agents.workflows.v1";

function registry(): Map<string, WorkflowDefinition> {
  return getSingleton<Map<string, WorkflowDefinition>>(
    WORKFLOW_REGISTRY_KEY,
    () => new Map<string, WorkflowDefinition>()
  );
}

/** Register a workflow definition. Throws on a duplicate goal. */
export function registerWorkflow(definition: WorkflowDefinition): void {
  if (definition.steps.length === 0) {
    throw new Error(`workflow ${definition.goal} declares no steps`);
  }
  if (registry().has(definition.goal)) {
    throw new Error(`workflow already registered: ${definition.goal}`);
  }
  registry().set(definition.goal, definition);
}

/**
 * Resolve a goal to its workflow. Throws on an unregistered goal.
 *
 * Fails closed for ADR-029 D1's reason: a surface that silently ignores an unknown goal
 * answers wrongly forever, where one that refuses fails once and loudly.
 */
export function resolveWorkflow(goal: AgentGoal): WorkflowDefinition {
  const definition = registry().get(goal);
  if (!definition) {
    throw new Error(`workflow not registered: ${goal}`);
  }
  return definition;
}

/** The goals this platform implements — the data behind /api/agent/capabilities (D8). */
export function listWorkflowGoals(): readonly AgentGoal[] {
  return [...registry().keys()] as readonly AgentGoal[];
}

/** Clear the registry (testing only). */
export function resetWorkflowRegistry(): void {
  setSingleton<Map<string, WorkflowDefinition>>(
    WORKFLOW_REGISTRY_KEY,
    new Map<string, WorkflowDefinition>()
  );
}

// ── Running ───────────────────────────────────────────────────────────

export interface RunGoalArgs {
  readonly goal: AgentGoal;
  readonly input: Record<string, unknown>;
  readonly actor: AgentIdentity;
  readonly sessionId?: string;
  /** Ceiling in USD; absent = unbounded. Enforced per step by the pipeline (D8). */
  readonly budgetMaxUSD?: number;
  /** Continue an existing trajectory — this is what makes choreography one workflow. */
  readonly trajectoryId?: string;
  readonly trajectoryStore?: TrajectoryStore;
}

/** Where a run stopped and why. */
type RunStop = "completed" | "paused";

async function openTrajectory(
  args: RunGoalArgs,
  store: TrajectoryStore
): Promise<TrajectoryRecord> {
  if (args.trajectoryId) {
    const existing = await store.getById(args.trajectoryId);
    if (!existing) {
      throw new Error(`trajectory not found: ${args.trajectoryId}`);
    }
    return existing;
  }
  return store.create({ kind: "agent", id: args.actor.actorId }, args.goal, "platform");
}

/**
 * Run steps [from, to) of a definition against one trajectory.
 *
 * The single runner. Orchestration passes the whole remaining range; choreography passes
 * one step. Nothing else differs, which is what makes the two trajectories comparable
 * (ADR-030 requirement 6).
 */
async function runSteps(
  definition: WorkflowDefinition,
  args: RunGoalArgs,
  store: TrajectoryStore,
  trajectoryId: string,
  from: number,
  to: number,
  priorOutputs: readonly Record<string, unknown>[]
): Promise<RunStop> {
  // Seeded from the trajectory, not from this call. A choreographed hop is a fresh
  // process invocation and knows nothing of the previous one, so a step whose input
  // reads an earlier step's output would see nothing and the two entry points would
  // silently compute different things (ADR-029 D5: resume replays from the trajectory).
  const outputs: Record<string, unknown>[] = [...priorOutputs];

  for (let i = from; i < to; i += 1) {
    const step = definition.steps[i];
    if (!step) break;

    const ctx: WorkflowContext = {
      goal: definition.goal,
      input: args.input,
      outputs,
    };

    try {
      const result = await invokeTool({
        tool: step.tool,
        input: step.input(ctx),
        actor: args.actor,
        sessionId: args.sessionId ?? trajectoryId,
        trajectoryId,
        stepIndex: i,
        cost: step.estimatedCostUSD,
        budgetCeiling: args.budgetMaxUSD,
        trajectoryStore: store,
      });
      outputs.push(result.output);
    } catch (err) {
      // ADR-029 D8: budget exhaustion PAUSES rather than fails — with resume (D5) a
      // pause is recoverable, and a caller that raised its ceiling can continue the
      // same trajectory rather than starting a second one and paying twice.
      // A gated step (requires-approval) pauses for D7's reason: it is held, not refused.
      if (err instanceof PipelineRejectedError) {
        await store.updateStatus(trajectoryId, "paused");
        return "paused";
      }
      await store.updateStatus(trajectoryId, "failed");
      throw err;
    }
  }

  return "completed";
}

function summariseCost(steps: readonly Step[]): CostSummary {
  return {
    apiCalls: steps.length,
    // Token accounting belongs to the provider layer; this loop sees USD only. The
    // A-layer keeps what the providers emit (AUX_DESIGN) rather than inventing it here.
    tokensUsed: 0,
    estimatedCostUSD: steps.reduce((sum, s) => sum + s.cost, 0),
    cachedResults: 0,
    costSavedFromCache: 0,
  };
}

/**
 * Affordances after a run (ADR-030 D3).
 *
 * Never empty: a finished workflow offers `done` rather than nothing, which is the
 * difference between an agent surface and an RPC. Every non-terminal affordance names a
 * REGISTERED goal, so requirement 8's discoverability check cannot be satisfied by an
 * invented action.
 */
function affordances(
  definition: WorkflowDefinition,
  remaining: number,
  stop: RunStop
): readonly NextAction[] {
  if (stop === "paused") {
    return [
      {
        action: "retry",
        description: `Resume ${definition.goal} — raise the ceiling or approve the held step`,
        endpoint: definition.endpoint,
        requiredParams: ["trajectoryId"],
        estimatedCostUSD: 0,
      },
      terminal(),
    ];
  }

  if (remaining > 0) {
    return [
      {
        action: definition.goal,
        description: `Continue ${definition.goal} — ${remaining} step(s) remaining`,
        endpoint: definition.endpoint,
        requiredParams: ["trajectoryId"],
        estimatedCostUSD: definition.steps
          .slice(definition.steps.length - remaining)
          .reduce((sum, s) => sum + s.estimatedCostUSD, 0),
      },
      terminal(),
    ];
  }

  return [terminal()];
}

function terminal(): NextAction {
  return {
    action: "done",
    description: "Workflow complete; no further step required",
    endpoint: null,
    requiredParams: [],
    estimatedCostUSD: 0,
  };
}

async function assemble(
  definition: WorkflowDefinition,
  store: TrajectoryStore,
  trajectoryId: string,
  stop: RunStop
): Promise<AgentResponse<unknown>> {
  const record = await store.getById(trajectoryId);
  if (!record) {
    throw new Error(`trajectory vanished mid-run: ${trajectoryId}`);
  }

  const steps = record.trajectory.steps;
  const remaining = Math.max(definition.steps.length - steps.length, 0);

  if (stop === "completed" && remaining === 0) {
    await store.updateStatus(trajectoryId, "completed");
  }

  const settled = await store.getById(trajectoryId);
  const trajectory = (settled ?? record).trajectory;

  return {
    result: {
      goal: definition.goal,
      output: steps.at(-1)?.output ?? {},
    },
    trajectory,
    nextActions: affordances(definition, remaining, stop),
    cost: summariseCost(trajectory.steps),
  };
}

/**
 * ORCHESTRATION (ADR-030 D2): run every remaining step in one call.
 *
 * Identical to calling advanceGoal() until nothing remains — the same runner, the same
 * gates, the same trajectory. That equivalence is asserted, not asserted-to-be-true, by
 * the L21 kit's requirement 6.
 */
export async function runGoal(args: RunGoalArgs): Promise<AgentResponse<unknown>> {
  const definition = resolveWorkflow(args.goal);
  const store = args.trajectoryStore ?? getTrajectoryStore();
  const record = await openTrajectory(args, store);
  const trajectoryId = record.trajectory.trajectoryId;
  const from = record.trajectory.steps.length;

  const stop = await runSteps(
    definition,
    args,
    store,
    trajectoryId,
    from,
    definition.steps.length,
    record.trajectory.steps.map((s) => s.output)
  );
  return assemble(definition, store, trajectoryId, stop);
}

/**
 * CHOREOGRAPHY (ADR-030 D2): run the next step only, and hand back the affordances.
 *
 * The agent picks the next hop from nextActions and calls again with the trajectoryId.
 */
export async function advanceGoal(args: RunGoalArgs): Promise<AgentResponse<unknown>> {
  const definition = resolveWorkflow(args.goal);
  const store = args.trajectoryStore ?? getTrajectoryStore();
  const record = await openTrajectory(args, store);
  const trajectoryId = record.trajectory.trajectoryId;
  const from = record.trajectory.steps.length;

  const stop =
    from >= definition.steps.length
      ? "completed"
      : await runSteps(
          definition,
          args,
          store,
          trajectoryId,
          from,
          from + 1,
          record.trajectory.steps.map((s) => s.output)
        );

  return assemble(definition, store, trajectoryId, stop);
}

// ── Gotchas ───────────────────────────────────────────────────────────
//
// 1. A step's position in the trajectory IS its index. runSteps resumes from
//    trajectory.steps.length, so a workflow whose step appended nothing would loop on
//    the same index forever. invokeTool appends exactly one step per call (ADR-029
//    invariant 1) — do not add a step type that skips the pipeline.
//
// 2. `intent` on WorkflowStep is the step-level provider semantic; `goal` on
//    WorkflowDefinition is the workflow. ADR-030 D1 keeps the names apart deliberately.
//    Do not collapse them, and do not add a `goal` to a step.
//
// 3. estimatedCostUSD is a PRE-execution declaration, because the budget ceiling is
//    checked before the step runs. CostSummary reports what the trajectory recorded,
//    not what was declared — the two agree today only because the pipeline records the
//    declared figure (TASK-085).
