/**
 * platform/agents/tool-invoker.ts — The tool adapter (ADR-029 D2, D3)
 *
 * The second entry point over executeActionPipeline. Its counterpart is
 * app-framework/session.ts's dispatch(), and both execute through the SAME pipeline —
 * which is what D2 binds. What differs is only what sits above it:
 *
 *   dispatch()    turn rules · validateAction · applyAction · affordances
 *   invokeTool()  input schema · tool execution · output schema · retry-on-invalid
 *
 * Everything else — gating on effectiveRisk, the budget ceiling, CAS commit for tools that
 * write managed state, the trajectory step carrying operationId — comes from the pipeline
 * rather than being reimplemented here. That is the whole point of the extraction: a
 * restricted tool is gated by the same code that gates a restricted session action.
 *
 * @module platform/agents
 */

import {
  ActionNotRecordedError,
  ApprovedRunFailedError,
  executeActionPipeline,
  isPipelineConflict,
  type PipelineOutcome,
} from "@/platform/action-pipeline";
import type {
  ProposalStore,
  ActionSpec,
  ActivityStateStore,
  AgentIdentity,
  EffectLedger,
  SessionEvent,
  Tool,
  TrajectoryStore,
} from "@/platform/kernel";
import { assertValidSchema, isValidSchema, SchemaValidationError } from "./schema";
import { getTrajectoryStore } from "./trajectory-store";
import { generateSecureId } from "./utils";
import { performExternalEffect, type ExternalEffectOutcome } from "./external-effect";
import { storedJsonViolation } from "@/platform/errors/json-limits";
import { logger } from "@/lib/logger";
import { raiseAlert } from "@/platform/observability/alert";

/** Effects that reach outside the system and therefore require a ledger entry (D7). */
const EXTERNAL_EFFECTS: readonly string[] = ["externalCall", "sendMessage"];

/**
 * Raised when a tool declares an external effect in `effects` and declares no
 * externalEffects to fire it through (ADR-031 D7).
 *
 * The declaration is the whole mechanism: a tool that reaches outside without a ledger entry
 * can be retried into firing twice, and nothing downstream can tell that it happened.
 */
export class UndeclaredExternalEffectError extends Error {
  constructor(
    readonly toolId: string,
    readonly declared: readonly string[]
  ) {
    super(
      `tool ${toolId} declares ${declared.join(", ")} in effects but no externalEffects. ` +
        "An external effect must be declared so the platform can route it through the " +
        "effect ledger (ADR-031 D7)."
    );
    this.name = "UndeclaredExternalEffectError";
  }
}

/** How many times invalid output is retried before the step fails (ADR-029 D3). */
export const DEFAULT_OUTPUT_RETRIES = 2;

export interface InvokeToolArgs<TState = unknown> {
  readonly tool: Tool;
  readonly input: Record<string, unknown>;
  readonly actor: AgentIdentity;
  /** The session or agent run this invocation belongs to. */
  readonly sessionId: string;
  readonly trajectoryId: string;
  readonly stepIndex: number;
  /** ADR-031 D1 — supply to make this a retry of an existing logical action. */
  readonly operationId?: string;
  readonly cost?: number;
  /** Agent budget ceiling in USD; absent = unbounded. */
  readonly budgetCeiling?: number;
  /**
   * Session ceiling in USD, when this tool call happens inside a session (ADR-029 D8).
   *
   * The effective limit is the minimum of this and budgetCeiling. It is supplied
   * explicitly rather than read from a session, because a tool call has no session to
   * read — an agent on a cron has an agent budget and no session at all, and inventing
   * one to satisfy the signature is what D2 declined to do.
   */
  readonly sessionCeiling?: number;
  readonly trajectoryStore?: TrajectoryStore;
  /**
   * A long-running agent's opt-in (review 11 H-2): a full trajectory is continued in a linked new
   * one — the result's `outcome.trajectory` is then the continuation, and the caller goes on
   * there — instead of refusing the call (request.trajectory_full, the default).
   */
  readonly rolloverTrajectory?: boolean;
  /** Required only for a tool that writes managed state. */
  readonly stateStore?: ActivityStateStore<TState>;
  readonly expectedVersion?: number;
  /** Produces the next managed state from the tool's output; omit for a read-only tool. */
  readonly computeNextState?: (output: Record<string, unknown>) => TState;
  readonly maxOutputRetries?: number;
  readonly emit?: (event: SessionEvent) => void;
  /** Override the ledger the declared external effects are written to (testing). */
  readonly effectLedger?: EffectLedger;
  /**
   * Satisfies the gate for an already-approved two-phase action (ADR-030 D6, ADR-031 D2).
   * The pipeline verifies the proposal is approved for operationId; an unapproved or
   * mismatched id is refused. Requires proposalStore.
   */
  readonly approvedProposalId?: string;
  readonly proposalStore?: ProposalStore;
}

export interface InvokeToolResult<TState = unknown> {
  readonly output: Record<string, unknown>;
  readonly operationId: string;
  readonly attempts: number;
  readonly outcome: PipelineOutcome<TState>;
  /**
   * One entry per declared external effect, in declaration order.
   *
   * An `indeterminate` entry here means the downstream neither confirmed nor denied. The
   * ledger row stays unresolved, so executeAgent's D10 check reports the whole workflow
   * indeterminate rather than completed — the propagation path, not a separate one.
   */
  readonly effects: readonly ExternalEffectOutcome<Record<string, unknown>>[];
}

/**
 * A Tool declares what an ActionSpec declares — effects and an advisory risk — so the
 * pipeline can score it with the same function it scores a session action with. ephemeral
 * is false even for a read-only tool: ADR-029 invariant 1 requires exactly one trajectory
 * step per tool call, and ephemeral actions leave no trace at all.
 */
function specFor(tool: Tool): ActionSpec {
  return {
    type: tool.id,
    effects: tool.effects,
    declaredRisk: tool.declaredRisk,
    ephemeral: false,
    commutative: false,
  };
}

/**
 * Invoke a tool through the governed pipeline.
 *
 * D3: input is validated before execute and output after. Invalid output is retried, never
 * coerced — coercing malformed output into the expected shape turns a detectable failure
 * into a plausible wrong answer, which is what structured outputs exist to prevent (P6).
 */
export async function invokeTool<TState = unknown>(
  args: InvokeToolArgs<TState>
): Promise<InvokeToolResult<TState>> {
  const { tool, input, actor } = args;
  // An approved run executes its tool once (review 11 M-1): a retry would run approved work a
  // second time. Invalid output after it is a failure after the work — applied.
  const approved = args.approvedProposalId !== undefined;
  const retries = approved ? 0 : (args.maxOutputRetries ?? DEFAULT_OUTPUT_RETRIES);

  // ADR-031 D7, checked BEFORE anything runs: a tool reaching outside without declaring how
  // is a contract violation, and refusing at the edge is cheaper than discovering it from a
  // duplicate charge.
  const declaredExternal = tool.effects.filter((e) => EXTERNAL_EFFECTS.includes(e));
  if (declaredExternal.length > 0 && !tool.externalEffects?.length) {
    throw new UndeclaredExternalEffectError(tool.id, declaredExternal);
  }

  // Input edge. Validated before the pipeline runs at all: a malformed call should not
  // consume budget or occupy an operationId.
  assertValidSchema(tool.inputSchema, input, "input", tool.id);

  // An atomic tool's effects are all one tenant transaction's writes; an external call cannot be
  // rolled back with them (review 10 H2).
  if (tool.atomic && tool.externalEffects?.length) {
    throw new Error(
      `tool ${tool.id} is declared atomic and has external effects; an external effect cannot be part of a database transaction`
    );
  }

  let attempts = 0;
  let output: Record<string, unknown> = {};
  const effectOutcomes: ExternalEffectOutcome<Record<string, unknown>>[] = [];
  // Effects fire inside perform(), which runs before the pipeline returns its
  // context — so when the caller supplies no operationId, one is minted here and
  // handed to the pipeline, keeping a single identity across both (ADR-031 D1).
  const pendingOperationId = args.operationId ?? `op_${generateSecureId()}`;

  // The managed state this call commits, computed from the tool's output inside perform —
  // before any declared effect fires — so a state the store would refuse stops the call before
  // it reaches outside (review 10 M5).
  let nextState: TState | undefined;
  const writesState = Boolean(args.computeNextState && args.stateStore);

  const perform = async (): Promise<Record<string, unknown>> => {
    let lastErrors: readonly string[] = [];
    for (let attempt = 0; attempt <= retries; attempt++) {
      attempts = attempt + 1;
      const candidate = await tool.execute(input);
      // From here the tool's own work has run. For an approved run, every failure after this
      // point is a failure after the effect — "applied", the approval used — never "not applied"
      // with the approval kept for a second run of the same work (review 11 M-1).
      try {
        if (isValidSchema(tool.outputSchema, candidate)) {
          output = candidate;
          // Everything that would make the call unrecordable is checked BEFORE the declared
          // external effects fire (review 10 M5: the stored-JSON limit was met after the work,
          // and the caller was told nothing was stored). The next state must be storable; an
          // output too large or too deep to keep is recorded as such — the step says the output
          // was not kept — rather than failing a call whose work is done. The caller still gets
          // the whole output.
          if (writesState) {
            nextState = (args.computeNextState as (o: Record<string, unknown>) => TState)(
              candidate
            );
            args.stateStore!.validate?.(nextState);
          }
          const violation = storedJsonViolation(candidate);
          const recorded = violation
            ? { outputNotRecorded: { code: violation.code, max: violation.max } }
            : candidate;
          // Declared external effects fire AFTER the tool's own work validates. Firing first
          // would mean a schema failure left a charge behind it, and the retry loop would
          // then fire it again — the ledger would catch the second, but the first would still
          // be an effect for an invocation that failed.
          await fireDeclaredEffects();
          return recorded;
        }
        try {
          assertValidSchema(tool.outputSchema, candidate, "output", tool.id);
        } catch (err) {
          if (err instanceof SchemaValidationError) lastErrors = err.errors;
          else throw err;
        }
        if (approved) {
          throw new SchemaValidationError(
            `tool ${tool.id}: output failed its schema — ${lastErrors.join("; ")}`,
            "output",
            tool.id,
            lastErrors
          );
        }
      } catch (err) {
        if (!approved || err instanceof ActionNotRecordedError) throw err;
        throw new ActionNotRecordedError(
          tool.id,
          pendingOperationId,
          true,
          err instanceof Error ? err.message : String(err),
          { cause: err }
        );
      }
    }
    throw new SchemaValidationError(
      `tool ${tool.id}: output failed its schema after ${attempts} attempt(s) — ${lastErrors.join("; ")}`,
      "output",
      tool.id,
      lastErrors
    );
  };

  // Each declared effect gets its own ledger entry, keyed on operationId + key, so one
  // invocation firing two effects cannot have them deduped into one.
  async function fireDeclaredEffects(): Promise<void> {
    if (!tool.externalEffects?.length) return;
    const operationId = args.operationId ?? pendingOperationId;
    if (!operationId) {
      throw new Error(
        `tool ${tool.id} declares external effects but no operationId is available; ` +
          "an effect without an identity cannot be deduplicated (ADR-031 D7)."
      );
    }
    for (const effect of tool.externalEffects) {
      effectOutcomes.push(
        await performExternalEffect<Record<string, unknown>>({
          operationId,
          effectKey: effect.key,
          effectType: effect.type,
          call: (idempotencyKey) => effect.call(input, idempotencyKey),
          reconcile: effect.reconcile,
          request: input,
          ledger: args.effectLedger,
        })
      );
    }
  }

  let outcome: PipelineOutcome<TState>;
  try {
    outcome = await executeActionPipeline<TState>({
      spec: specFor(tool),
      actor,
      sessionId: args.sessionId,
      operationId: args.approvedProposalId ? args.operationId : pendingOperationId,
      label: tool.id,
      cost: args.cost ?? 0,
      boundary: "commitment",
      stateStore: args.stateStore as ActivityStateStore<TState>,
      trajectoryStore: args.trajectoryStore ?? getTrajectoryStore(),
      trajectoryId: args.trajectoryId,
      stepIndex: args.stepIndex,
      expectedVersion: args.expectedVersion ?? 0,
      rolloverTrajectory: args.rolloverTrajectory,
      perform,
      // Computed (and checked) inside perform, before the effects.
      computeNextState: writesState ? () => nextState as TState : null,
      ceilings: [
        ...(args.budgetCeiling !== undefined
          ? [{ limit: args.budgetCeiling, label: "agent ceiling" }]
          : []),
        ...(args.sessionCeiling !== undefined
          ? [{ limit: args.sessionCeiling, label: "session ceiling" }]
          : []),
      ],
      emit: args.emit,
      stepInput: { toolId: tool.id },
      eventIntent: "tool-call",
      approvedProposalId: args.approvedProposalId,
      proposalStore: args.proposalStore,
      // What runs is what was approved: the pipeline compares it with the proposal's payload.
      approvalInput: args.approvedProposalId ? input : undefined,
      reportsFailure: tool.reportsFailure
        ? () => tool.reportsFailure!(output)
        : undefined,
      atomic: tool.atomic,
    });
  } catch (err) {
    // Applied, and its record not stored: said so, and put on the audit log (review 10 M5) — a
    // completion that conflicted with its claim as a conflict, alerted (review 11 H-1).
    if (err instanceof ActionNotRecordedError && err.applied) {
      await recordUnrecorded(err, tool.id, actor.actorId);
    } else if (err instanceof ApprovedRunFailedError) {
      // Recorded here, outside the run's transaction: an atomic run's own records rolled back
      // with it (review 11 L-6).
      await recordApprovedRunFailed(err, tool.id, actor.actorId);
    }
    throw err;
  }

  if (isPipelineConflict(outcome)) {
    return {
      output,
      operationId: args.operationId ?? "",
      attempts,
      outcome,
      effects: effectOutcomes,
    };
  }

  return {
    output,
    operationId: outcome.context.operationId,
    attempts,
    outcome,
    effects: effectOutcomes,
  };
}

/**
 * Audit an action that took effect without its record (review 10 M5), or whose approval's
 * completion conflicted with its claim (review 11 H-1: raised, audited, alerted). Best effort,
 * outside any transaction the call ran in: the error already says what happened, and an audit log
 * that cannot be written is logged by the writer.
 */
async function recordUnrecorded(
  err: ActionNotRecordedError,
  toolId: string,
  actorId: string
): Promise<void> {
  logger.error("Tool call applied; its record could not be stored", {
    route: "platform/agents/tool-invoker",
    toolId,
    operationId: err.operationId,
    reason: err.reason,
  });
  if (err.approvalConflict) {
    raiseAlert({
      name: "approvals.run_conflict",
      message: `An approved run of ${toolId} took effect after its claim was taken back and decided otherwise; check the approval's audit trail (docs/runbooks/approvals-and-agents.md).`,
      tags: {
        tool: toolId,
        operationId: err.operationId,
        proposalId: err.proposalId ?? "",
      },
    });
  }
  try {
    const { writeAuditLogOutsideTransaction } = await import("@/platform/auth/audit");
    await writeAuditLogOutsideTransaction({
      action: "admin_action",
      agent: actorId,
      details: {
        type: err.approvalConflict
          ? "approval_run_conflict"
          : "action_applied_not_recorded",
        tool: toolId,
        operationId: err.operationId,
        ...(err.proposalId ? { holdId: err.proposalId } : {}),
        reason: err.reason.slice(0, 500),
      },
    });
  } catch {
    // Logged above; nothing more can be done here.
  }
}

/**
 * Audit an approved run that failed before taking effect (review 11 L-6): an atomic run's own
 * attempt records rolled back with its transaction, so the failure is written here, after it.
 */
async function recordApprovedRunFailed(
  err: ApprovedRunFailedError,
  toolId: string,
  actorId: string
): Promise<void> {
  try {
    const { writeAuditLogOutsideTransaction } = await import("@/platform/auth/audit");
    await writeAuditLogOutsideTransaction({
      action: "admin_action",
      agent: actorId,
      details: {
        type: "approved_run_failed",
        tool: toolId,
        holdId: err.proposalId,
        approvalKept: err.released,
        reason: err.reason.slice(0, 500),
      },
    });
  } catch {
    // Logged by the writer.
  }
}

// ── Gotchas ───────────────────────────────────────────────────────────
//
// 1. Input is validated BEFORE the pipeline, output INSIDE it. That asymmetry is
//    deliberate: a malformed call should not consume budget or mint an operationId, while
//    malformed output happens after the tool has already run and must be recorded.
//
// 2. Retry re-executes the tool with the SAME input. Declared external effects are safe
//    under that retry because each carries a ledger entry keyed on operationId + effect
//    key: the second attempt finds the entry and does not re-fire. A tool doing its own
//    un-declared external work is NOT safe, which is why the adapter refuses one.
//
// 4. Effects fire after the output validates, not before. Firing first would leave a charge
//    behind a schema failure, and the retry loop would fire it again.
//
// 3. Output is never coerced toward the schema. If a tool cannot satisfy its own contract,
//    the step fails — a plausible wrong answer is worse than a loud failure (P6).
