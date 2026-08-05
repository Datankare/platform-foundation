/**
 * platform/action-pipeline/index.ts — The governed execution pipeline (ADR-029 D2)
 *
 * ONE implementation of the sequence every action traverses, whatever invoked it:
 *
 *   operationId (minted or supplied) → tier resolution → gating → budget ceiling →
 *   state commit via CAS → trajectory append → event emit
 *
 * Two adapters sit above it and own only domain-specific behaviour:
 *
 *   app-framework/session.ts  dispatch()    — turn rules, validateAction, applyAction,
 *                                             next-action affordances
 *   agents/runtime.ts         invokeTool()  — schema validation, tool execution (commit 3)
 *
 * D2 says a tool call "is not a separate execution path". That binds the pipeline, not the
 * entry point: two entry points are fine, two implementations of gating/CAS/trajectory are
 * not. Forcing tool calls through dispatch() would drag session-specific orchestration —
 * turn enforcement, affordance enumeration, an ActivitySession per agent run — into agent
 * execution, which D2's own closing paragraph guards against.
 *
 * This module imports ONLY platform/kernel. Both stores arrive as parameters rather than
 * via singletons, because a singleton accessor lives in the module that owns the
 * implementation and importing it here would close the cycle this layering exists to open.
 *
 * @module platform/action-pipeline
 */

import type {
  ActionContext,
  ActionSpec,
  ActivityStateStore,
  AgentIdentity,
  DurabilityTier,
  SessionEvent,
  Step,
  StepBoundary,
  Trajectory,
  TrajectoryStore,
  VersionedState,
  ProposalRecord,
  ProposalStore,
} from "@/platform/kernel";
import { generateSecureId } from "@/platform/agents/utils";
import { assembleActionContext, computeEffectiveRisk, resolveTier } from "./risk";

// ── Rejection ─────────────────────────────────────────────────────────

export type PipelineRejectionReason = "requires-approval" | "budget-exceeded";

/** One applicable spending limit, and whose it is (ADR-029 D8). */
export interface BudgetCeiling {
  /** Limit in USD. */
  readonly limit: number;
  /** Whose limit — "session ceiling", "agent ceiling". Named in the rejection. */
  readonly label: string;
}

/**
 * The binding ceiling: the lowest of every applicable limit.
 *
 * Returns undefined when nothing applies, which means unbounded — deliberately NOT zero.
 * A missing budget must not read as a budget of nothing.
 */
export function mostRestrictiveCeiling(
  ceilings: readonly BudgetCeiling[]
): BudgetCeiling | undefined {
  let lowest: BudgetCeiling | undefined;
  for (const c of ceilings) {
    if (!lowest || c.limit < lowest.limit) lowest = c;
  }
  return lowest;
}

/** Raised when the pipeline refuses before any state mutation. */
export class PipelineRejectedError extends Error {
  constructor(
    message: string,
    readonly reason: PipelineRejectionReason
  ) {
    super(message);
    this.name = "PipelineRejectedError";
  }
}

// ── Request / outcome ─────────────────────────────────────────────────

export interface PipelineRequest<TState> {
  /** The declared spec — risk and effects are computed from it, never accepted from a caller. */
  readonly spec: ActionSpec;
  readonly actor: AgentIdentity;
  readonly sessionId: string;
  /**
   * ADR-031 D1: supplied by the caller for retry safety, minted here when absent.
   * When present it is the idempotency key and the call is a retry of that logical action.
   */
  readonly operationId?: string;
  /** What the trajectory step records as the action — an action type or a tool id. */
  readonly label: string;
  readonly cost: number;
  readonly boundary: StepBoundary;

  readonly stateStore: ActivityStateStore<TState>;
  readonly trajectoryStore: TrajectoryStore;
  readonly trajectoryId: string;
  readonly stepIndex: number;
  readonly expectedVersion: number;

  /**
   * Produces the next managed state, or null when this action writes no managed state —
   * a read-only tool, for instance. A null writer skips the commit and still appends a
   * trajectory step, so ADR-029's "exactly one trajectory step per invocation" holds.
   */
  readonly computeNextState: (() => TState) | null;

  /**
   * The execution callback: runs after gating, budget and identity, before any commit.
   * A session action has none — its effect IS the state transition. A tool call has one,
   * and its return value becomes part of the trajectory step's output.
   */
  readonly perform?: () => Promise<Record<string, unknown>>;

  /** Session or agent ceiling in USD; absent = unbounded. Shorthand for a single ceiling. */
  readonly budgetCeiling?: number;
  /**
   * Names whose ceiling this is, for the rejection message — "session ceiling",
   * "agent ceiling". The pipeline does not know which budget it is holding; the adapter
   * does, and a caller needs to know which one rejected it.
   */
  readonly ceilingLabel?: string;
  /**
   * Every applicable ceiling (ADR-029 D8). The effective ceiling is the MINIMUM, and the
   * rejection names whichever one bound the call.
   *
   * An agent step inside a session is bound by both the agent's BudgetConfig and the
   * session's ceiling. Taking the maximum would let the more generous budget defeat the
   * stricter one — which is why this is a minimum while effectiveRisk is a maximum. The
   * conservative direction differs by quantity: for risk, higher is safer; for spend,
   * lower is.
   *
   * Folded together with budgetCeiling/ceilingLabel, so a caller may supply either form.
   */
  readonly ceilings?: readonly BudgetCeiling[];
  readonly emit?: (event: SessionEvent) => void;
  readonly stepInput?: Record<string, unknown>;
  readonly stepOutput?: Record<string, unknown>;
  readonly eventIntent?: string;
}

export interface PipelineConflict<TState> {
  readonly conflict: true;
  readonly currentVersion: number;
  readonly currentState: TState;
}

export interface PipelineSuccess<TState> {
  readonly conflict?: false;
  readonly tier: DurabilityTier;
  readonly context: ActionContext;
  /** null for ephemeral actions and for actions writing no managed state. */
  readonly committed: VersionedState<TState> | null;
  readonly step: Step | null;
  readonly trajectory: Trajectory | null;
}

export type PipelineOutcome<TState> = PipelineSuccess<TState> | PipelineConflict<TState>;

export function isPipelineConflict<TState>(
  outcome: PipelineOutcome<TState>
): outcome is PipelineConflict<TState> {
  return (outcome as PipelineConflict<TState>).conflict === true;
}

// ── The pipeline ──────────────────────────────────────────────────────

/**
 * Execute one governed action. The stages are fixed and their order is the contract:
 * nothing commits before gating, nothing appends a trajectory step before the commit it
 * describes, and a CAS loss mutates nothing.
 */
export async function executeActionPipeline<TState>(
  req: PipelineRequest<TState>
): Promise<PipelineOutcome<TState>> {
  // 1. Tier + gating. Computed from the spec so no caller can smuggle a lower risk (P4).
  const tier = resolveTier(req.spec);
  if (tier === "two-phase") {
    throw new PipelineRejectedError(
      `${req.label} requires approval (effectiveRisk=${computeEffectiveRisk(req.spec)}) — use propose/approve (ADR-031)`,
      "requires-approval"
    );
  }

  // 2. Budget — most-restrictive-wins across every applicable ceiling (ADR-029 D8).
  // The minimum, not the maximum: a session ceiling of 0.01 must bind a tool whose agent
  // ceiling is 1.00, or the more generous budget defeats the stricter one.
  const applicable: BudgetCeiling[] = [...(req.ceilings ?? [])];
  if (req.budgetCeiling !== undefined) {
    applicable.push({
      limit: req.budgetCeiling,
      label: req.ceilingLabel ?? "ceiling",
    });
  }
  const binding = mostRestrictiveCeiling(applicable);
  if (binding && req.cost > binding.limit) {
    // Naming the binding ceiling matters: a caller told only "over budget" cannot tell
    // whether to raise the agent's allowance or the session's.
    throw new PipelineRejectedError(
      `cost ${req.cost} exceeds ${binding.label} ${binding.limit}`,
      "budget-exceeded"
    );
  }

  // 3. Identity. ADR-031 D1 — the caller may supply it, and then it IS the idempotency key.
  // 128-bit even though it is an audit key rather than a capability: a guessable id would
  // let a caller collide with another actor's in-flight operation.
  const operationId = req.operationId ?? `op_${generateSecureId()}`;

  // 4. Ephemeral actions leave no durable trace at all (ADR-028 D3 invariant).
  if (tier === "ephemeral") {
    return {
      tier,
      context: assembleActionContext({
        spec: req.spec,
        actor: req.actor,
        sessionId: req.sessionId,
        operationId,
        boundary: req.boundary,
      }),
      committed: null,
      step: null,
      trajectory: null,
    };
  }

  // 5. The justification record (ADR-031 D9).
  const context = assembleActionContext({
    spec: req.spec,
    actor: req.actor,
    sessionId: req.sessionId,
    operationId,
    boundary: req.boundary,
  });

  // 6. Execute, for adapters whose action does something other than transition state.
  // Runs after gating so a refused call never executes, and before commit so a failing
  // execution leaves no committed state behind it.
  const performed = req.perform ? await req.perform() : undefined;

  // 7. Commit managed state, if this action writes any.
  let committed: VersionedState<TState> | null = null;
  if (req.computeNextState) {
    const nextState = req.computeNextState();
    if (req.spec.commutative) {
      committed = await req.stateStore.reduceCommit(
        req.sessionId,
        () => nextState,
        operationId
      );
    } else {
      const res = await req.stateStore.commit(
        req.sessionId,
        req.expectedVersion,
        nextState,
        operationId
      );
      if (!res.ok) {
        // A lost CAS mutates nothing — no trajectory append, no event (ADR-028 D5).
        return {
          conflict: true,
          currentVersion: res.currentVersion,
          currentState: res.currentState,
        };
      }
      committed = {
        sessionId: req.sessionId,
        state: res.state,
        version: res.version,
        producedBy: operationId,
      };
    }
  }

  // 7. Trajectory append, derived from the authoritative commit and keyed by operationId.
  const step: Step = {
    stepIndex: req.stepIndex,
    action: req.label,
    input: { operationId, actorId: req.actor.actorId, ...(req.stepInput ?? {}) },
    output: {
      ...(committed ? { version: committed.version } : {}),
      ...(performed ?? {}),
      ...(req.stepOutput ?? {}),
    },
    cost: req.cost,
    durationMs: 0,
    timestamp: new Date().toISOString(),
    boundary: context.boundary,
    operationId: context.operationId,
    proposalId: context.proposalId,
    actor: context.actor,
    effects: context.effects,
    effectiveRisk: context.effectiveRisk,
  };
  const record = await req.trajectoryStore.addStep(req.trajectoryId, step);

  // 8. Emit.
  req.emit?.({
    type: "state-change",
    sessionId: req.sessionId,
    operationId: context.operationId,
    trajectoryId: req.trajectoryId,
    stepIndex: step.stepIndex,
    proposalId: context.proposalId,
    actor: context.actor,
    boundary: context.boundary,
    effects: context.effects,
    effectiveRisk: context.effectiveRisk,
    intent: req.eventIntent ?? "commit",
    at: step.timestamp,
  });

  return {
    tier,
    context,
    committed,
    step,
    trajectory: record?.trajectory ?? null,
  };
}

// ── Gating: propose / approve / reject (ADR-029 D7, ADR-031 D2) ───────

/**
 * Hold a gated action instead of refusing it.
 *
 * executeActionPipeline throws on a two-phase action: the caller asked for immediate
 * execution and cannot have it. This is the other option — the caller can wait for a human.
 * Both exist deliberately; an application picks per action.
 *
 * Records the proposal, emits an approval-request event, pauses the trajectory. Nothing
 * executes and nothing commits: a proposal has an operationId and a trajectory, and never a
 * stateVersion (ADR-031 D8).
 */
export async function proposeAction(req: ProposeRequest): Promise<ProposalRecord> {
  const operationId = req.operationId ?? `op_${generateSecureId()}`;
  const context = assembleActionContext({
    spec: req.spec,
    actor: req.actor,
    sessionId: req.sessionId,
    operationId,
    boundary: "cognition",
  });

  const proposal = await req.proposalStore.create({
    operationId,
    sessionId: req.sessionId,
    trajectoryId: req.trajectoryId,
    label: req.label,
    actor: req.actor,
    effects: context.effects,
    effectiveRisk: context.effectiveRisk,
    payload: req.payload,
    observedVersion: req.observedVersion,
  });

  // The cognition step: what was proposed is recorded whether or not it is ever approved.
  await req.trajectoryStore.addStep(req.trajectoryId, {
    stepIndex: req.stepIndex,
    action: req.label,
    input: { operationId, actorId: req.actor.actorId, ...(req.payload ?? {}) },
    output: { proposalId: proposal.proposalId, status: "proposed" },
    cost: 0,
    durationMs: 0,
    timestamp: new Date().toISOString(),
    boundary: "cognition",
    operationId,
    proposalId: proposal.proposalId,
    actor: context.actor,
    effects: context.effects,
    effectiveRisk: context.effectiveRisk,
  });

  await req.trajectoryStore.updateStatus(req.trajectoryId, "paused");

  req.emit?.({
    type: "approval-request",
    sessionId: req.sessionId,
    operationId,
    trajectoryId: req.trajectoryId,
    stepIndex: req.stepIndex,
    proposalId: proposal.proposalId,
    actor: context.actor,
    boundary: "cognition",
    effects: context.effects,
    effectiveRisk: context.effectiveRisk,
    intent: "approval-request",
    at: proposal.createdAt,
  });

  return proposal;
}

export interface ProposeRequest {
  readonly spec: ActionSpec;
  readonly actor: AgentIdentity;
  readonly sessionId: string;
  readonly trajectoryId: string;
  readonly stepIndex: number;
  readonly label: string;
  readonly operationId?: string;
  readonly payload?: Record<string, unknown>;
  readonly observedVersion?: number;
  readonly proposalStore: ProposalStore;
  readonly trajectoryStore: TrajectoryStore;
  readonly emit?: (event: SessionEvent) => void;
}

export interface DecideRequest {
  readonly proposalId: string;
  readonly decidedBy: string;
  readonly note?: string;
  readonly proposalStore: ProposalStore;
  readonly trajectoryStore: TrajectoryStore;
  readonly emit?: (event: SessionEvent) => void;
}

/**
 * Approve a held proposal and return the trajectory to `running` so it can be resumed
 * (ADR-029 D7 — approval resumes via D5).
 *
 * Returns undefined if the proposal already moved: a second approval is a no-op, not an
 * error, and not a second commit (ADR-031 D4).
 */
export async function approveProposal(
  req: DecideRequest
): Promise<ProposalRecord | undefined> {
  const decided = await req.proposalStore.decide(
    req.proposalId,
    "approved",
    req.decidedBy,
    req.note
  );
  if (!decided) return undefined;

  await req.trajectoryStore.updateStatus(decided.trajectoryId, "running");
  return decided;
}

/**
 * Reject a held proposal. Terminal: the trajectory records what was proposed and why it was
 * refused, and no stateVersion is ever produced (ADR-031 D8). A protocol that discards
 * rejected proposals cannot answer why an action did not happen.
 */
export async function rejectProposal(
  req: DecideRequest
): Promise<ProposalRecord | undefined> {
  const decided = await req.proposalStore.decide(
    req.proposalId,
    "rejected",
    req.decidedBy,
    req.note
  );
  if (!decided) return undefined;

  await req.trajectoryStore.addStep(decided.trajectoryId, {
    stepIndex: 0,
    action: decided.label,
    input: { operationId: decided.operationId, actorId: decided.actor.actorId },
    output: {
      proposalId: decided.proposalId,
      status: "rejected",
      decidedBy: req.decidedBy,
      note: req.note ?? "",
    },
    cost: 0,
    durationMs: 0,
    timestamp: new Date().toISOString(),
    boundary: "cognition",
    operationId: decided.operationId,
    proposalId: decided.proposalId,
    actor: decided.actor,
    effects: decided.effects,
    effectiveRisk: decided.effectiveRisk,
  });
  await req.trajectoryStore.updateStatus(decided.trajectoryId, "failed");
  return decided;
}

// ── Compensation (ADR-029 D6) ─────────────────────────────────────────

/**
 * What to run to cancel one recorded step.
 *
 * The caller builds this from the step, because only the caller knows how to undo its own
 * domain action. The pipeline owns the identity, ordering and recording; it does not know
 * what a refund is.
 */
export interface CompensationPlan {
  readonly spec: ActionSpec;
  readonly label: string;
  readonly perform: () => Promise<Record<string, unknown>>;
}

export interface CompensateRequest {
  readonly trajectoryId: string;
  readonly trajectoryStore: TrajectoryStore;
  readonly actor: AgentIdentity;
  readonly sessionId: string;
  /**
   * Given a recorded step, return how to cancel it — or null for steps that need no
   * compensation (cognition steps, reads, anything already compensated).
   */
  readonly plan: (step: Step) => CompensationPlan | null;
  readonly emit?: (event: SessionEvent) => void;
}

export interface CompensationOutcome {
  readonly compensated: number;
  readonly skipped: number;
  readonly failures: readonly { operationId: string; error: string }[];
}

/**
 * Compensate a trajectory: append actions that cancel what was committed.
 *
 * Nothing is undone and nothing is deleted. Each compensating action gets its own
 * operationId and a `compensates` link to the step it cancels, and both remain in the
 * history — so the trajectory answers "what happened" and "what was done about it"
 * separately, which a rewritten history cannot.
 *
 * Steps are compensated in REVERSE order. If step 2 depended on step 1, undoing 1 first
 * would leave 2's compensation acting against a state that no longer holds.
 *
 * A compensation that itself fails is recorded and the walk CONTINUES: stopping would
 * leave the remaining steps both uncompensated and unrecorded, which is strictly worse
 * than a partial unwind with a complete account of it.
 */
export async function compensateTrajectory(
  req: CompensateRequest
): Promise<CompensationOutcome> {
  const record = await req.trajectoryStore.getById(req.trajectoryId);
  if (!record) {
    throw new Error(`Trajectory not found: ${req.trajectoryId}`);
  }

  const steps = [...record.trajectory.steps].reverse();
  const alreadyCompensated = new Set(
    record.trajectory.steps
      .map((s) => s.compensates)
      .filter((id): id is string => typeof id === "string")
  );

  let compensated = 0;
  let skipped = 0;
  const failures: { operationId: string; error: string }[] = [];
  let nextIndex = record.trajectory.steps.length;

  for (const step of steps) {
    // Never compensate a compensation, and never compensate twice.
    if (
      step.compensates ||
      (step.operationId && alreadyCompensated.has(step.operationId))
    ) {
      skipped += 1;
      continue;
    }

    const plan = req.plan(step);
    if (!plan) {
      skipped += 1;
      continue;
    }

    if (plan.spec.compensable === false) {
      // Registration should have caught this. If it reaches here the declaration was added
      // after the fact, and refusing loudly beats pretending the unwind was complete.
      failures.push({
        operationId: step.operationId ?? "(none)",
        error: `${plan.label} is declared non-compensable`,
      });
      continue;
    }

    const operationId = `op_${generateSecureId()}`;
    const context = assembleActionContext({
      spec: plan.spec,
      actor: req.actor,
      sessionId: req.sessionId,
      operationId,
      boundary: "commitment",
    });

    let output: Record<string, unknown> = {};
    let error: string | undefined;
    try {
      output = await plan.perform();
    } catch (err) {
      error = err instanceof Error ? err.message : "Unknown error";
      failures.push({ operationId: step.operationId ?? "(none)", error });
    }

    await req.trajectoryStore.addStep(req.trajectoryId, {
      stepIndex: nextIndex,
      action: plan.label,
      input: { operationId, actorId: req.actor.actorId, compensating: step.action },
      output: error ? { error, compensated: false } : { ...output, compensated: true },
      cost: 0,
      durationMs: 0,
      timestamp: new Date().toISOString(),
      boundary: "commitment",
      operationId,
      actor: context.actor,
      effects: context.effects,
      effectiveRisk: context.effectiveRisk,
      compensates: step.operationId,
    });
    nextIndex += 1;

    req.emit?.({
      type: "state-change",
      sessionId: req.sessionId,
      operationId,
      trajectoryId: req.trajectoryId,
      stepIndex: nextIndex - 1,
      actor: context.actor,
      boundary: "commitment",
      effects: context.effects,
      effectiveRisk: context.effectiveRisk,
      intent: "compensate",
      at: new Date().toISOString(),
    });

    if (!error) compensated += 1;
  }

  return { compensated, skipped, failures };
}

// ── ADR-031 D3/D4/D5 — revision, dedup, stale-approval reconciliation ──

/**
 * Propose, deduplicated on operationId (ADR-031 D4, intent -> proposed edge).
 *
 * A retry of the same logical action returns the EXISTING live proposal rather than minting
 * a second. Two live proposals for one operation would mean two things an approver could
 * approve for a single action, which D3 calls a protocol violation rather than a variant.
 */
export async function proposeOnce(req: ProposeRequest): Promise<ProposalRecord> {
  if (req.operationId) {
    const live = await req.proposalStore.query({
      operationId: req.operationId,
      status: "proposed",
    });
    if (live.length > 0) return live[0];
  }
  return proposeAction(req);
}

export interface ReviseRequest extends ProposeRequest {
  /** The operation being revised. Required — a revision has something to revise. */
  readonly operationId: string;
  readonly revisedBy: string;
  readonly reason?: string;
}

/**
 * Revise a held proposal (ADR-031 D3).
 *
 * Supersedes the live proposal and mints a NEW proposalId under the SAME operationId. The
 * audit trail then shows one logical action with a revision, rather than two unrelated
 * attempts — which is the difference between "we changed our minds about this" and "someone
 * tried twice".
 *
 * `superseded` was a declared status with nothing able to reach it before this.
 */
export async function reviseProposal(req: ReviseRequest): Promise<ProposalRecord> {
  const live = await req.proposalStore.query({
    operationId: req.operationId,
    status: "proposed",
  });
  for (const prior of live) {
    await req.proposalStore.decide(
      prior.proposalId,
      "superseded",
      req.revisedBy,
      req.reason ?? "revised"
    );
  }
  return proposeAction(req);
}

/** Why an approval did not commit. */
export type ApprovalOutcomeKind = "approved" | "stale" | "already-decided";

export interface ApprovalOutcome {
  readonly kind: ApprovalOutcomeKind;
  readonly proposal?: ProposalRecord;
  /** On `stale`: the version now, versus what the approver saw. */
  readonly observedVersion?: number;
  readonly currentVersion?: number;
}

export interface ReconciledApprovalRequest extends DecideRequest {
  /** Reads the current version for the stale check. Omit to skip reconciliation. */
  readonly stateStore?: ActivityStateStore<unknown>;
  /**
   * The spec of the action being approved. A commutative action applies against latest by
   * construction, so an advanced version does not invalidate its approval (ADR-031 D5).
   */
  readonly spec?: ActionSpec;
}

/**
 * Approve a proposal, reconciling against state that may have moved (ADR-031 D5).
 *
 *   version unchanged            -> approve
 *   advanced, commutative        -> approve; reduceCommit applies against latest
 *   advanced, non-commutative    -> SUPERSEDE, and the operation returns to `proposed`
 *
 * Stale approvals are never silently re-applied against newer state. An approver approved a
 * specific transition from a specific state; applying it to a different state is a different
 * action wearing the same approval.
 *
 * Without a stateStore this degrades to plain approveProposal — deliberately explicit, so a
 * caller that cannot reconcile has said so rather than silently skipping the check.
 */
export async function approveWithReconciliation(
  req: ReconciledApprovalRequest
): Promise<ApprovalOutcome> {
  const proposal = await req.proposalStore.getById(req.proposalId);
  if (!proposal || proposal.status !== "proposed") {
    return { kind: "already-decided", proposal: proposal ?? undefined };
  }

  if (req.stateStore && proposal.observedVersion !== undefined) {
    const current = await req.stateStore.load(proposal.sessionId);
    const currentVersion = current?.version;

    if (currentVersion !== undefined && currentVersion !== proposal.observedVersion) {
      // Commutative actions are exempt: reduceCommit applies against latest by
      // construction, so a moved version does not change what the approval means.
      if (!req.spec?.commutative) {
        await req.proposalStore.decide(
          req.proposalId,
          "superseded",
          req.decidedBy,
          `state advanced ${proposal.observedVersion} -> ${currentVersion}; approval is stale`
        );
        await req.trajectoryStore.updateStatus(proposal.trajectoryId, "paused");
        return {
          kind: "stale",
          proposal,
          observedVersion: proposal.observedVersion,
          currentVersion,
        };
      }
    }
  }

  const approved = await approveProposal(req);
  return approved
    ? { kind: "approved", proposal: approved }
    : { kind: "already-decided", proposal };
}

// ── ADR-031 D6 — crash-window repair ──────────────────────────────────

export interface RepairRequest<TState> {
  readonly sessionId: string;
  readonly trajectoryId: string;
  readonly actor: AgentIdentity;
  readonly stateStore: ActivityStateStore<TState>;
  readonly trajectoryStore: TrajectoryStore;
  readonly emit?: (event: SessionEvent) => void;
}

export interface RepairOutcome {
  readonly repaired: boolean;
  readonly operationId?: string;
  readonly reason: string;
}

/**
 * Complete an operation interrupted between commit and trajectory append (ADR-031 D6).
 *
 * The protocol is commit-first, record-after: the reverse would allow a recorded action that
 * never happened, which is strictly worse than an unrecorded action that did. That leaves
 * one window where durable state can exist without an audit record, and this closes it.
 *
 * Forward-only, and driven by the state store, which is the authority:
 *   1. read producedBy from the committed state — the repair anchor
 *   2. if no trajectory step carries that operationId, the operation was interrupted
 *   3. append the missing tail from the committed state
 *
 * It NEVER re-applies the state transition and NEVER re-fires the external effect. An
 * interrupted operation is completed, not rolled back: rollback would undo a committed
 * transition other actors may already have observed.
 *
 * The ADR says this runs "on session load". There is no session load path in the framework
 * today — createSession creates, and nothing loads — so this is an explicit entry point
 * rather than an invented lifecycle hook. TASK-071 records that a load path should call it.
 */
export async function repairSession<TState>(
  req: RepairRequest<TState>
): Promise<RepairOutcome> {
  const state = await req.stateStore.load(req.sessionId);
  if (!state) {
    return { repaired: false, reason: "no state for session" };
  }
  const operationId = state.producedBy;
  if (!operationId) {
    // Pre-D2 state, or a session that has never committed. Nothing to reconcile against.
    return { repaired: false, reason: "committed state carries no producedBy" };
  }

  const record = await req.trajectoryStore.getById(req.trajectoryId);
  if (!record) {
    return { repaired: false, operationId, reason: "trajectory not found" };
  }

  const recorded = record.trajectory.steps.some((s) => s.operationId === operationId);
  if (recorded) {
    return { repaired: false, operationId, reason: "already recorded" };
  }

  // The tail: the trajectory step and the event that the interrupted operation never wrote.
  const timestamp = new Date().toISOString();
  await req.trajectoryStore.addStep(req.trajectoryId, {
    stepIndex: record.trajectory.steps.length,
    action: "repaired-commit",
    input: { operationId, actorId: req.actor.actorId },
    output: { version: state.version, repaired: true },
    cost: 0,
    durationMs: 0,
    timestamp,
    boundary: "commitment",
    operationId,
    actor: req.actor,
  });

  req.emit?.({
    type: "state-change",
    sessionId: req.sessionId,
    operationId,
    trajectoryId: req.trajectoryId,
    stepIndex: record.trajectory.steps.length,
    actor: req.actor,
    boundary: "commitment",
    intent: "repair",
    at: timestamp,
  });

  return { repaired: true, operationId, reason: "missing tail appended" };
}

export * from "./risk";

// ── Gotchas ───────────────────────────────────────────────────────────
//
// 1. Both stores are parameters, never singletons. Importing a store accessor here would
//    close the cycle this module exists to open. Adapters resolve the singleton and pass it.
//
// 2. computeNextState === null is a real case, not an omission: a read-only tool commits no
//    managed state and still gets exactly one trajectory step (ADR-029 invariant 1).
//
// 3. Stage order is the contract. Gating before commit, commit before trajectory append,
//    nothing at all on a lost CAS. Reordering these breaks guarantees, not just tests.
