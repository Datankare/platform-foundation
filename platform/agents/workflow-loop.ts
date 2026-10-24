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
  HeldAction,
  NextAction,
  ProposalRecord,
  ProposalStore,
  RiskLevel,
  Step,
  Tool,
  TrajectoryRecord,
  TrajectoryStore,
} from "@/platform/kernel";
import { EFFECT_RISK_FLOOR } from "@/platform/kernel";
import { getSingleton, setSingleton } from "@/platform/kernel/singleton";
import { PipelineRejectedError, proposeOnce } from "@/platform/action-pipeline";
import { invokeTool } from "./tool-invoker";
import { getTrajectoryStore } from "./trajectory-store";
import { getProposalStore } from "./proposal-store";
import { approvalPolicy, principalOf } from "./gating";
import { getApprovalPolicyStore } from "./approval-policy-store";
import { isAgentGoal, listAgentGoals } from "./goals";

// ── Definition ────────────────────────────────────────────────────────

/** What the steps executed so far produced, for the next step's input. */
export interface WorkflowStepContext {
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
  readonly input: (ctx: WorkflowStepContext) => Record<string, unknown>;
}

export interface WorkflowDefinition {
  readonly goal: AgentGoal;
  readonly description: string;
  readonly steps: readonly WorkflowStep[];
  /** Endpoint an agent calls to continue or re-enter this workflow. */
  readonly endpoint: string;
  /**
   * An OPAQUE capability name this workflow requires (ADR-030 D9). PF knows the name only;
   * a consumer maps it to its own permission set via RunGoalArgs.checkCapability. Absent
   * means the workflow requires no capability beyond endpoint auth — a deliberate, logged
   * state ("none"), never a silent default. The name is workflow-centric: one name stands
   * for the whole permission set the workflow needs, resolved consumer-side.
   */
  readonly requiredCapability?: string;
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

/**
 * Register a workflow definition. Throws on a goal neither the core nor a registered module
 * declares (ADR-054 D4), on a duplicate goal, and on a workflow with no steps.
 */
export function registerWorkflow(definition: WorkflowDefinition): void {
  if (!isAgentGoal(definition.goal)) {
    throw new Error(
      `workflow goal ${definition.goal} is not declared by the core or a registered module ` +
        `(declared: ${listAgentGoals().join(", ")})`
    );
  }
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

/** The registered definitions in full — what buildCapabilities reads (D8). */
export function listWorkflows(): readonly WorkflowDefinition[] {
  return [...registry().values()];
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
  readonly proposalStore?: ProposalStore;
  /**
   * Resolves whether `actor` satisfies an opaque capability name (ADR-030 D9). Supplied by
   * the consumer, which owns the name -> permission mapping (PF does not know the consumer's
   * permission strings). Absent when the caller has no capability model; a workflow that
   * declares requiredCapability but is given no checkCapability is DENIED (fail-closed, P11)
   * rather than run ungoverned.
   */
  readonly checkCapability?: (
    capability: string,
    actor: AgentIdentity
  ) => Promise<boolean>;
}

/**
 * Where a run stopped and, when held, what is held.
 *
 * `held` is a STATE the caller observes (ADR-030 D6), carried up to AgentResponse.held. It
 * is not an affordance in nextActions: an agent must not be handed "approve" for its own
 * held action, because the approver may be — and by policy default is — a human (P10).
 */
interface RunResult {
  readonly stop: "completed" | "paused" | "held" | "denied";
  readonly held?: HeldAction;
  /**
   * The capability decision for this run (ADR-030 D9). Always set — "none" is affirmative,
   * not the absence of a check. Carried to AgentResponse.capabilityCheck and logged by the
   * consumer at all three states, so a run that required no capability is an explicit fact,
   * never an inferred one.
   */
  readonly capability: {
    readonly capability: string | null;
    readonly state: "none" | "granted" | "denied";
  };
}

/**
 * Completed WORKFLOW steps, which is what resume counts.
 *
 * A held step leaves a `cognition` proposal step in the trajectory (proposeAction appends
 * one) but performs no work. Counting total steps would resume PAST the held step and skip
 * it; counting commitment steps resumes AT it, so an approved held step re-executes exactly
 * once. This is the load-bearing distinction in the whole gating path.
 */
function commitmentCount(steps: readonly Step[]): number {
  return steps.filter((s: Step) => s.boundary === "commitment").length;
}

/**
 * A trajectory that does not exist, or is not the caller's, or was opened for another goal.
 * One error for all three, so a caller cannot tell which — the trajectoryId of someone else's
 * workflow reveals nothing and continues nothing (Playform v0.8.0 release review).
 */
export class TrajectoryAccessError extends Error {
  constructor(readonly trajectoryId: string) {
    super(`trajectory not found: ${trajectoryId}`);
    this.name = "TrajectoryAccessError";
  }
}

/**
 * Where a new trajectory is scoped: to the user the actor stands for (principalOf), else to the
 * platform. The scope is what a later continuation is checked against (openTrajectory).
 */
function createTrajectory(
  store: TrajectoryStore,
  actor: AgentIdentity,
  goal: AgentGoal
): Promise<TrajectoryRecord> {
  const principal = principalOf(actor);
  const subject = { kind: "agent" as const, id: actor.actorId };
  return principal
    ? store.create(subject, goal, "user", principal)
    : store.create(subject, goal, "platform");
}

/**
 * Whether `actor` may continue `record` for `goal`: the same goal it was opened for, and the
 * same owner — the same user for a user-scoped trajectory; for a platform-scoped one, the same
 * agent acting for nobody. Trajectories created before PF v5.1.0 are platform-scoped, so a
 * delegated agent cannot continue one (it fails closed; the workflow is started again).
 */
function mayContinue(
  record: TrajectoryRecord,
  actor: AgentIdentity,
  goal: string
): boolean {
  if (record.trigger !== goal) return false;
  // A failed trajectory — a refused capability, a failed step, a mismatched approval — is over.
  if (record.trajectory.status === "failed") return false;
  const principal = principalOf(actor);
  if (principal !== undefined) {
    return record.scopeType === "user" && record.scopeId === principal;
  }
  return record.scopeType === "platform" && record.subject.id === actor.actorId;
}

async function openTrajectory(
  args: RunGoalArgs,
  store: TrajectoryStore
): Promise<TrajectoryRecord> {
  if (args.trajectoryId) {
    const existing = await store.getById(args.trajectoryId);
    if (!existing || !mayContinue(existing, args.actor, args.goal)) {
      throw new TrajectoryAccessError(args.trajectoryId);
    }
    return existing;
  }
  return createTrajectory(store, args.actor, args.goal);
}

/**
 * An approved proposal that does not match the step it is resumed at — another tool. Never
 * executed: an approval covers exactly the action it was given for.
 */
export class ApprovalMismatchError extends Error {
  constructor(
    readonly proposalId: string,
    readonly expectedTool: string
  ) {
    super(`approved proposal ${proposalId} is not for ${expectedTool}`);
    this.name = "ApprovalMismatchError";
  }
}

/**
 * Run steps [from, to) of a definition against one trajectory.
 *
 * The single runner. Orchestration passes the whole remaining range; choreography passes
 * one step. Nothing else differs, which is what makes the two trajectories comparable
 * (ADR-030 requirement 6).
 *
 * `from` is a COMMITMENT count, not a step count — see commitmentCount. A step whose index
 * is `from` is re-attempted; if it was previously held and now has an approved proposal, it
 * commits through the approved path, otherwise it re-holds.
 */
async function runSteps(
  definition: WorkflowDefinition,
  args: RunGoalArgs,
  store: TrajectoryStore,
  trajectoryId: string,
  from: number,
  to: number,
  priorOutputs: readonly Record<string, unknown>[]
): Promise<Omit<RunResult, "capability">> {
  // The store the hold was written to (holdStep defaults the same way), so a resume finds the
  // approval wherever it was recorded.
  const proposalStore = args.proposalStore ?? getProposalStore();

  // Seeded from the trajectory, not from this call. A choreographed hop is a fresh process
  // invocation and knows nothing of the previous one, so a step whose input reads an
  // earlier step's output would see nothing and the two entry points would silently
  // compute different things (ADR-029 D5: resume replays from the trajectory).
  const outputs: Record<string, unknown>[] = [...priorOutputs];

  for (let i = from; i < to; i += 1) {
    const step = definition.steps[i];
    if (!step) break;

    const ctx: WorkflowStepContext = {
      goal: definition.goal,
      input: args.input,
      outputs,
    };

    // Is this step already held with an approved proposal? Then commit it through the
    // approved path rather than re-attempting a fresh gated call — with exactly what was
    // approved: the proposal's own tool and payload, never input recomputed from this call
    // (a resume must not turn one approval into a different action).
    const approved = await approvedProposalForStep(proposalStore, trajectoryId, i);
    if (approved && approved.label !== step.tool.id) {
      await store.updateStatus(trajectoryId, "failed");
      throw new ApprovalMismatchError(approved.proposalId, step.tool.id);
    }

    try {
      const result = await invokeTool({
        tool: step.tool,
        input: approved ? approved.payload : step.input(ctx),
        actor: args.actor,
        sessionId: args.sessionId ?? trajectoryId,
        trajectoryId,
        stepIndex: i,
        cost: step.estimatedCostUSD,
        budgetCeiling: args.budgetMaxUSD,
        trajectoryStore: store,
        proposalStore,
        approvedProposalId: approved?.proposalId,
        operationId: approved?.operationId,
      });
      outputs.push(result.output);
    } catch (err) {
      if (err instanceof PipelineRejectedError) {
        if (err.reason === "approval-used") {
          // Another call ran this step on the same approval: nothing to hold or pause here.
          throw new HeldActionNotApprovedError(approved?.proposalId ?? "");
        }
        if (err.reason === "requires-approval") {
          // A concurrent call may have just run this step on its approval (it read the
          // trajectory before we did): then there is nothing to hold — never re-propose a step
          // that has run.
          if (await stepAlreadyRan(store, proposalStore, trajectoryId, i)) {
            throw new HeldActionNotApprovedError(approved?.proposalId ?? "");
          }
          // Hold: mint a proposal (idempotent via proposeOnce) and surface who must approve.
          // If the step's approval arrived (or was used) between our checks and the proposal,
          // proposing again is refused — by proposeOnce, or by the store's one-live rule — and
          // this call stands down rather than pausing a step that has its decision.
          let held: HeldAction;
          try {
            held = await holdStep(definition, step, i, ctx, args, store, trajectoryId);
          } catch (holdErr) {
            if (
              (holdErr instanceof PipelineRejectedError &&
                holdErr.reason === "approval-used") ||
              (await stepAlreadyRan(store, proposalStore, trajectoryId, i)) ||
              (await approvedProposalForStep(proposalStore, trajectoryId, i))
            ) {
              throw new HeldActionNotApprovedError(approved?.proposalId ?? "");
            }
            throw holdErr;
          }
          await store.updateStatus(trajectoryId, "paused");
          return { stop: "held", held };
        }
        // budget-exceeded: pause, recoverable by raising the ceiling (ADR-029 D8).
        await store.updateStatus(trajectoryId, "paused");
        return { stop: "paused" };
      }
      await store.updateStatus(trajectoryId, "failed");
      throw err;
    }
  }

  return { stop: "completed" };
}

/** Whether step `stepIndex` has already committed, or its approval was already used. */
async function stepAlreadyRan(
  store: TrajectoryStore,
  proposalStore: ProposalStore,
  trajectoryId: string,
  stepIndex: number
): Promise<boolean> {
  const record = await store.getById(trajectoryId);
  if (record && commitmentCount(record.trajectory.steps) > stepIndex) return true;
  const used = await proposalStore.query({
    operationId: stepOperationId(trajectoryId, stepIndex),
    status: "executed",
  });
  return used.some((p) => p.trajectoryId === trajectoryId);
}

/** The operation a held step is proposed under: one per trajectory and step index. */
function stepOperationId(trajectoryId: string, stepIndex: number): string {
  return `op_${trajectoryId}_${stepIndex}`;
}

/**
 * The approved proposal for THIS step of this trajectory, if any.
 *
 * Looked up by the step's own operation (holdStep proposes under it), not by the first held
 * proposal on the trajectory — a workflow with two gated steps must not commit the second on
 * the first one's approval. Its operationId is what the pipeline's approved-commit path
 * verifies against.
 */
async function approvedProposalForStep(
  proposalStore: ProposalStore,
  trajectoryId: string,
  stepIndex: number
): Promise<ProposalRecord | undefined> {
  const approved = await proposalStore.query({
    operationId: stepOperationId(trajectoryId, stepIndex),
    status: "approved",
  });
  return approved.find((p) => p.trajectoryId === trajectoryId);
}

/**
 * Mint the proposal for a gated step and build the HeldAction naming who may approve.
 *
 * proposeOnce is idempotent per operationId (ADR-031 D3), so a re-hold on the same step
 * does not create a second proposal.
 */
async function holdStep(
  definition: WorkflowDefinition,
  step: WorkflowStep,
  stepIndex: number,
  ctx: WorkflowStepContext,
  args: RunGoalArgs,
  store: TrajectoryStore,
  trajectoryId: string
): Promise<HeldAction> {
  const proposalStore = args.proposalStore ?? getProposalStore();
  const effectiveRisk = computeToolRisk(step.tool);
  const operationId = stepOperationId(trajectoryId, stepIndex);
  const approvalPolicyValue = await getApprovalPolicyStore().load();

  const proposal = await proposeOnce({
    spec: {
      type: step.tool.id,
      effects: step.tool.effects,
      declaredRisk: step.tool.declaredRisk,
      ephemeral: false,
      commutative: false,
    },
    actor: args.actor,
    sessionId: args.sessionId ?? trajectoryId,
    operationId,
    label: step.tool.id,
    payload: step.input(ctx),
    trajectoryId,
    stepIndex,
    proposalStore,
    trajectoryStore: store,
  });

  return {
    proposalId: proposal.proposalId,
    operationId: proposal.operationId,
    label: proposal.label,
    effectiveRisk: proposal.effectiveRisk,
    effects: proposal.effects,
    approver: approvalPolicy(effectiveRisk, step.tool.effects, approvalPolicyValue),
    approvalEndpoint: `${definition.endpoint}/approve`,
    observedVersion: proposal.observedVersion,
  };
}

/** Effective risk of a tool, mirroring the pipeline's computation (ADR-029). */
function computeToolRisk(tool: Tool): RiskLevel {
  const order: RiskLevel[] = ["ordinary", "consequential", "restricted"];
  let max: RiskLevel = tool.declaredRisk ?? "ordinary";
  for (const effect of tool.effects) {
    const floor = EFFECT_RISK_FLOOR[effect];
    if (order.indexOf(floor) > order.indexOf(max)) max = floor;
  }
  return max;
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
 * Never empty: a finished workflow offers `done` rather than nothing. When held, the agent
 * is offered ONLY what the agent may legitimately do — poll the held state, or abandon —
 * never "approve". Approval is a human's by policy default (P10), surfaced in
 * AgentResponse.held, not handed to the agent as its own affordance (ADR-031 boundary).
 */
function affordances(
  definition: WorkflowDefinition,
  remaining: number,
  result: RunResult
): readonly NextAction[] {
  if (result.stop === "held") {
    return [
      {
        action: "retry",
        description: `Held for approval by ${result.held?.approver.actorType ?? "an approver"} — poll or resume after a decision`,
        endpoint: definition.endpoint,
        requiredParams: ["trajectoryId"],
        estimatedCostUSD: 0,
      },
      terminal(),
    ];
  }

  if (result.stop === "paused") {
    return [
      {
        action: "retry",
        description: `Resume ${definition.goal} — raise the ceiling and retry`,
        endpoint: definition.endpoint,
        requiredParams: ["trajectoryId"],
        estimatedCostUSD: 0,
      },
      terminal(),
    ];
  }

  if (result.stop === "denied") {
    // Denied for lack of capability: nothing ran and nothing will without the capability.
    // The only affordance is terminal — retry would just be denied again. The WHY is in
    // AgentResponse.capabilityCheck, not buried here.
    return [terminal()];
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
  result: RunResult
): Promise<AgentResponse<unknown>> {
  const record = await store.getById(trajectoryId);
  if (!record) {
    throw new Error(`trajectory vanished mid-run: ${trajectoryId}`);
  }

  const steps = record.trajectory.steps;
  // Remaining is over WORKFLOW steps, so a held proposal step does not count as progress.
  const remaining = Math.max(definition.steps.length - commitmentCount(steps), 0);

  if (result.stop === "completed" && remaining === 0) {
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
    nextActions: affordances(definition, remaining, result),
    cost: summariseCost(trajectory.steps),
    ...(result.held ? { held: result.held } : {}),
    capabilityCheck: result.capability,
  };
}

/**
 * ORCHESTRATION (ADR-030 D2): run every remaining step in one call.
 *
 * Identical to calling advanceGoal() until nothing remains — the same runner, the same
 * gates, the same trajectory. That equivalence is asserted, not asserted-to-be-true, by
 * the L21 kit's requirement 6.
 */
/**
 * Resolve the capability decision for a workflow BEFORE any step runs (ADR-030 D9).
 *
 * Three states, all explicit:
 *   none    — the workflow declares no requiredCapability. Runs; logged as none.
 *   granted — declared, and checkCapability returned true. Runs.
 *   denied  — declared, and either checkCapability returned false OR no checkCapability was
 *             supplied at all. Fail-closed (P11): a governed workflow with no way to check
 *             its capability is denied, not run ungoverned.
 *
 * Permissions are fully known before execution, so this gates at the entrance rather than
 * mid-run (unlike budget and gating, whose triggers are only discoverable while running).
 */
async function decideCapability(
  definition: WorkflowDefinition,
  args: RunGoalArgs
): Promise<RunResult["capability"]> {
  const cap = definition.requiredCapability;
  if (cap === undefined) {
    return { capability: null, state: "none" };
  }
  if (!args.checkCapability) {
    return { capability: cap, state: "denied" };
  }
  const ok = await args.checkCapability(cap, args.actor);
  return { capability: cap, state: ok ? "granted" : "denied" };
}

/**
 * Build the denied response WITHOUT running any step. A denial is recorded durably: a
 * trajectory is created and marked failed (P18 — the refusal is auditable), zero steps, and
 * capabilityCheck.state is "denied" so a discovering agent sees WHY in the response, not
 * only in server logs it cannot read.
 */
async function denyResponse(
  definition: WorkflowDefinition,
  args: RunGoalArgs,
  store: TrajectoryStore,
  capability: RunResult["capability"]
): Promise<AgentResponse<unknown>> {
  const record = await createTrajectory(store, args.actor, args.goal);
  const trajectoryId = record.trajectory.trajectoryId;
  await store.updateStatus(trajectoryId, "failed");
  const settled = await store.getById(trajectoryId);
  const trajectory = (settled ?? record).trajectory;
  return {
    result: { goal: definition.goal, output: {} },
    trajectory,
    nextActions: affordances(definition, 0, { stop: "denied", capability }),
    cost: summariseCost(trajectory.steps),
    capabilityCheck: capability,
  };
}

export async function runGoal(args: RunGoalArgs): Promise<AgentResponse<unknown>> {
  const definition = resolveWorkflow(args.goal);
  const store = args.trajectoryStore ?? getTrajectoryStore();

  const capability = await decideCapability(definition, args);
  if (capability.state === "denied") {
    return denyResponse(definition, args, store, capability);
  }

  const record = await openTrajectory(args, store);
  const trajectoryId = record.trajectory.trajectoryId;
  const from = commitmentCount(record.trajectory.steps);

  const stepResult = await runSteps(
    definition,
    args,
    store,
    trajectoryId,
    from,
    definition.steps.length,
    record.trajectory.steps
      .filter((s: Step) => s.boundary === "commitment")
      .map((s: Step) => s.output)
  );
  return assemble(definition, store, trajectoryId, { ...stepResult, capability });
}

/**
 * CHOREOGRAPHY (ADR-030 D2): run the next step only, and hand back the affordances.
 *
 * The agent picks the next hop from nextActions and calls again with the trajectoryId.
 */
export async function advanceGoal(args: RunGoalArgs): Promise<AgentResponse<unknown>> {
  const definition = resolveWorkflow(args.goal);
  const store = args.trajectoryStore ?? getTrajectoryStore();

  const capability = await decideCapability(definition, args);
  if (capability.state === "denied") {
    return denyResponse(definition, args, store, capability);
  }

  const record = await openTrajectory(args, store);
  const trajectoryId = record.trajectory.trajectoryId;
  const from = commitmentCount(record.trajectory.steps);

  const stepResult =
    from >= definition.steps.length
      ? ({ stop: "completed" } as Omit<RunResult, "capability">)
      : await runSteps(
          definition,
          args,
          store,
          trajectoryId,
          from,
          from + 1,
          record.trajectory.steps
            .filter((s: Step) => s.boundary === "commitment")
            .map((s: Step) => s.output)
        );

  return assemble(definition, store, trajectoryId, { ...stepResult, capability });
}

/** A resume of a held action that is not (or no longer) approved. */
export class HeldActionNotApprovedError extends Error {
  constructor(readonly proposalId: string) {
    super(`held action ${proposalId} is not approved`);
    this.name = "HeldActionNotApprovedError";
  }
}

export interface ResumeApprovedActionArgs {
  readonly proposalId: string;
  readonly checkCapability?: RunGoalArgs["checkCapability"];
  readonly budgetMaxUSD?: number;
  readonly trajectoryStore?: TrajectoryStore;
  readonly proposalStore?: ProposalStore;
}

/**
 * Run the step an approval released — and only that, once (PF v5.1.0).
 *
 * Everything comes from the approved proposal and its trajectory, nothing from the caller: the
 * goal is the one the trajectory was opened for, the actor is the identity that proposed the
 * action (so the workflow continues as the agent acting for its owner, not as the human who
 * approved), and the step runs with the proposal's own tool and payload. A caller resuming
 * with advanceGoal and its own goal or input could otherwise turn one approval into another
 * action (Playform v0.8.0 release review). The trajectory's next step must be the one the
 * proposal was made for, so the same approval cannot be replayed to drive later steps. Throws
 * HeldActionNotApprovedError when the proposal is not approved or its step is not next,
 * TrajectoryAccessError when its trajectory is gone.
 */
export async function resumeApprovedAction(
  args: ResumeApprovedActionArgs
): Promise<AgentResponse<unknown>> {
  const proposalStore = args.proposalStore ?? getProposalStore();
  const store = args.trajectoryStore ?? getTrajectoryStore();
  const proposal = await proposalStore.getById(args.proposalId);
  if (!proposal || proposal.status !== "approved") {
    throw new HeldActionNotApprovedError(args.proposalId);
  }
  const record = await store.getById(proposal.trajectoryId);
  if (!record) throw new TrajectoryAccessError(proposal.trajectoryId);
  const next = commitmentCount(record.trajectory.steps);
  if (stepOperationId(proposal.trajectoryId, next) !== proposal.operationId) {
    // Already run, or for another step: this approval releases nothing now.
    throw new HeldActionNotApprovedError(args.proposalId);
  }

  return advanceGoal({
    goal: record.trigger as AgentGoal,
    input: {},
    actor: proposal.actor,
    sessionId: proposal.sessionId,
    trajectoryId: proposal.trajectoryId,
    trajectoryStore: store,
    proposalStore,
    checkCapability: args.checkCapability,
    budgetMaxUSD: args.budgetMaxUSD,
  });
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
