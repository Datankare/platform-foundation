/**
 * platform/agents/proposal-store.ts — Proposal persistence (ADR-031 D2)
 *
 * In-memory implementation and the singleton. The contract lives in platform/kernel because
 * the action pipeline creates and decides proposals and cannot import platform/agents
 * (ADR-029 D2). The in-memory store keeps each tenant's proposals in its own partition, as
 * row-level security does for PostgresProposalStore (ADR-053 D6).
 *
 * @module platform/agents
 */

import type {
  CreateProposalArgs,
  ProposalQuery,
  ProposalRecord,
  ProposalStatus,
  ProposalStore,
  TrajectoryStatus,
} from "@/platform/kernel";
import { generateUuid } from "./utils";
import { getSingleton, setSingleton } from "@/platform/kernel/singleton";
import { TenantPartitionedMap } from "@/platform/tenancy/partition";

export type {
  CreateProposalArgs,
  ProposalQuery,
  ProposalRecord,
  ProposalStatus,
  ProposalStore,
} from "@/platform/kernel";

const ONE_LIVE: ReadonlySet<ProposalStatus> = new Set([
  "proposed",
  "approved",
  "executing",
  "indeterminate",
  "executed",
]);

/** Why a run that never ended within its lease is undecided (review 11 H-1). */
export const INDETERMINATE_NOTE =
  "run did not end within its lease; its outcome is unknown — verify, then mark it executed or approve it again";

/** Why an atomic run that never ended was returned to approved (its effect rolled back with it). */
export const ATOMIC_RECOVERED_NOTE =
  "atomic run did not end within its lease; its transaction rolled back with its effect, approval kept";

/**
 * Where a recovered run leaves its workflow (TASK-173). When the approval-expiry job takes back a
 * run that never ended (an instance lost mid-run), the run's trajectory was left as the run had it
 * — `running` (or `awaiting_retry`, for a retry) — and its own agent's continuation re-proposed the
 * step, which the one-live rule refused with a plain error. The recovery now moves the trajectory
 * to the waiting state that matches the approval, in the same transaction:
 *
 *   approval indeterminate  ->  trajectory indeterminate (blocked: a person decides its outcome)
 *   approval approved again ->  trajectory awaiting_retry (an atomic run: approve it again to retry)
 *
 * — only from the statuses a run leaves it in; a finished (completed, failed) or already
 * undecided trajectory is left as it is. A run whose step was recorded (executed) ran:
 *
 *   approval executed       ->  trajectory completed (review round 1, L1), unless it is a
 *                               workflow's: its user continues the workflow past the step (M1)
 */
export const RECOVERED_TRAJECTORY: Readonly<
  Record<
    "indeterminate" | "approved" | "executed",
    { readonly to: TrajectoryStatus; readonly from: readonly TrajectoryStatus[] }
  >
> = {
  indeterminate: { to: "indeterminate", from: ["running", "paused", "awaiting_retry"] },
  approved: { to: "awaiting_retry", from: ["running", "paused"] },
  // Its step was recorded: the action ran, so the request it was held for is over (review
  // round 1, L1) — except a workflow's, which its user continues past the step (M1).
  executed: { to: "completed", from: ["running", "paused", "awaiting_retry"] },
};

/**
 * The trajectories an in-memory recovery moves (InMemoryTrajectoryStore.moveStatus): structural,
 * so this module does not import the trajectory store.
 */
export interface RecoveryTrajectories {
  moveStatus(
    trajectoryId: string,
    from: readonly TrajectoryStatus[],
    to: TrajectoryStatus
  ): unknown;
}

/** The note a withdrawn approval keeps: who had approved it and when, then why it was withdrawn. */
export function withdrawalNote(approved: ProposalRecord, note: string): string {
  return `Approved by ${approved.decidedBy ?? "unknown"} at ${approved.decidedAt ?? "unknown"}, never run; withdrawn: ${note}`;
}

export class InMemoryProposalStore implements ProposalStore {
  /** proposalId → record, per tenant. Insertion order is creation order. */
  private readonly parts = new TenantPartitionedMap<string, ProposalRecord>();

  async create(args: CreateProposalArgs): Promise<ProposalRecord> {
    const records = this.parts.current();
    // As the database's idx_proposals_tenant_one_live (migrations 046, 049): at most one
    // proposal per operation in a tenant that is open, approved or used.
    if (
      [...records.values()].some(
        (r) => r.operationId === args.operationId && ONE_LIVE.has(r.status)
      )
    ) {
      throw new Error(
        `agents: operation ${args.operationId} already has an open, approved or used proposal`
      );
    }
    const now = new Date().toISOString();
    const record: ProposalRecord = {
      proposalId: generateUuid(),
      operationId: args.operationId,
      sessionId: args.sessionId,
      trajectoryId: args.trajectoryId,
      label: args.label,
      status: "proposed",
      actor: args.actor,
      effects: args.effects,
      effectiveRisk: args.effectiveRisk,
      payload: args.payload ?? {},
      observedVersion: args.observedVersion,
      createdAt: now,
      updatedAt: now,
    };
    records.set(record.proposalId, record);
    return record;
  }

  async getById(proposalId: string): Promise<ProposalRecord | undefined> {
    return this.parts.current().get(proposalId);
  }

  async decide(
    proposalId: string,
    status: Exclude<
      ProposalStatus,
      "proposed" | "executed" | "executing" | "indeterminate"
    >,
    decidedBy: string,
    note?: string
  ): Promise<ProposalRecord | undefined> {
    const records = this.parts.current();
    const current = records.get(proposalId);
    if (!current) return undefined;
    // Only from `proposed`. A second decision on the same proposal is a no-op returning
    // undefined, so a caller can distinguish "I decided this" from "someone already had"
    // (ADR-031 D4).
    if (current.status !== "proposed") return undefined;

    const now = new Date().toISOString();
    const updated: ProposalRecord = {
      ...current,
      status,
      decidedBy,
      decidedAt: now,
      decisionNote: note,
      updatedAt: now,
    };
    records.set(proposalId, updated);
    return updated;
  }

  async consume(proposalId: string): Promise<ProposalRecord | undefined> {
    const records = this.parts.current();
    const current = records.get(proposalId);
    if (!current || current.status !== "approved") return undefined;
    const updated: ProposalRecord = {
      ...current,
      status: "executed",
      updatedAt: new Date().toISOString(),
    };
    records.set(proposalId, updated);
    return updated;
  }

  /**
   * Move `proposalId` to `to`, only if it is in one of `from` and (when given) its claim's token
   * is `token` (compare-and-set).
   */
  private transition(
    proposalId: string,
    from: readonly ProposalStatus[],
    to: ProposalStatus,
    change: Partial<ProposalRecord> = {},
    token?: string
  ): ProposalRecord | undefined {
    const records = this.parts.current();
    const current = records.get(proposalId);
    if (!current || !from.includes(current.status)) return undefined;
    if (token !== undefined && current.runToken !== token) return undefined;
    const updated: ProposalRecord = {
      ...current,
      status: to,
      ...change,
      updatedAt: new Date().toISOString(),
    };
    records.set(proposalId, updated);
    return updated;
  }

  async claim(
    proposalId: string,
    options: { readonly atomic?: boolean } = {}
  ): Promise<ProposalRecord | undefined> {
    return this.transition(proposalId, ["approved"], "executing", {
      runToken: generateUuid(),
      runAtomic: options.atomic === true,
    });
  }

  async complete(
    proposalId: string,
    runToken: string
  ): Promise<ProposalRecord | undefined> {
    const current = this.parts.current().get(proposalId);
    // Already executed by this very claim (the recovery found its step): done.
    if (current?.status === "executed" && current.runToken === runToken) return current;
    return this.transition(
      proposalId,
      ["executing", "indeterminate"],
      "executed",
      {},
      runToken
    );
  }

  async release(
    proposalId: string,
    note: string,
    runToken: string
  ): Promise<ProposalRecord | undefined> {
    return this.transition(
      proposalId,
      ["executing", "indeterminate"],
      "approved",
      { lastRunError: note, runToken: undefined, runAtomic: undefined },
      runToken
    );
  }

  async resolveIndeterminate(
    proposalId: string,
    resolution: "executed" | "approved",
    decidedBy: string,
    note: string
  ): Promise<ProposalRecord | undefined> {
    const now = new Date().toISOString();
    return this.transition(
      proposalId,
      ["indeterminate"],
      resolution,
      resolution === "approved"
        ? {
            decidedBy,
            decidedAt: now,
            decisionNote: note,
            runToken: undefined,
            runAtomic: undefined,
          }
        : { lastRunError: `marked executed by ${decidedBy}: ${note}` }
    );
  }

  /**
   * Take back every run claimed before `before` (ms since the epoch) that never ended — the
   * in-memory form of the approval-expiry job's recovery (hold-expiry.ts), for tests: an atomic
   * run's approval is approved again (its effect rolled back with it), any other is
   * `indeterminate` (review 11 H-1: its effect may have happened). Given `trajectories`, each
   * recovered run's trajectory moves to the matching waiting state (RECOVERED_TRAJECTORY,
   * TASK-173), as the database job does in its statement.
   */
  recoverStaleRuns(
    before: number,
    trajectories?: RecoveryTrajectories
  ): readonly ProposalRecord[] {
    const out: ProposalRecord[] = [];
    for (const r of [...this.parts.current().values()]) {
      if (r.status === "executing" && Date.parse(r.updatedAt) < before) {
        const back = r.runAtomic
          ? this.transition(r.proposalId, ["executing"], "approved", {
              lastRunError: ATOMIC_RECOVERED_NOTE,
              runToken: undefined,
              runAtomic: undefined,
            })
          : this.transition(r.proposalId, ["executing"], "indeterminate", {
              lastRunError: INDETERMINATE_NOTE,
            });
        if (back) {
          out.push(back);
          const move =
            RECOVERED_TRAJECTORY[
              back.status === "approved" ? "approved" : "indeterminate"
            ];
          trajectories?.moveStatus(back.trajectoryId, move.from, move.to);
        }
      }
    }
    return out;
  }

  async withdraw(
    proposalId: string,
    decidedBy: string,
    note: string
  ): Promise<ProposalRecord | undefined> {
    const records = this.parts.current();
    const current = records.get(proposalId);
    if (!current || current.status !== "approved") return undefined;
    const now = new Date().toISOString();
    const updated: ProposalRecord = {
      ...current,
      status: "rejected",
      decidedBy,
      decidedAt: now,
      decisionNote: withdrawalNote(current, note),
      updatedAt: now,
    };
    records.set(proposalId, updated);
    return updated;
  }

  async supersede(
    proposalIds: readonly string[],
    decidedBy: string,
    note: string
  ): Promise<readonly string[]> {
    const moved: string[] = [];
    for (const id of new Set(proposalIds)) {
      const current = this.parts.current().get(id);
      if (current?.status === "proposed") {
        if (await this.decide(id, "rejected", decidedBy, note)) moved.push(id);
      } else if (current?.status === "approved") {
        if (await this.withdraw(id, decidedBy, note)) moved.push(id);
      }
    }
    return moved;
  }

  async query(options: ProposalQuery): Promise<readonly ProposalRecord[]> {
    let out = [...this.parts.current().values()];
    if (options.operationId)
      out = out.filter((r) => r.operationId === options.operationId);
    if (options.trajectoryId)
      out = out.filter((r) => r.trajectoryId === options.trajectoryId);
    if (options.status) out = out.filter((r) => r.status === options.status);
    if (options.statuses) {
      const statuses = new Set(options.statuses);
      out = out.filter((r) => statuses.has(r.status));
    }
    if (options.labels) {
      const labels = new Set(options.labels);
      out = out.filter((r) => labels.has(r.label));
    }
    if (options.payloadKey !== undefined) {
      out = out.filter((r) => {
        const k = r.payload["key"] ?? r.payload["configKey"];
        return k === options.payloadKey;
      });
    }
    if (options.excludeIds?.length) {
      const excluded = new Set(options.excludeIds);
      out = out.filter((r) => !excluded.has(r.proposalId));
    }
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (options.limit && options.limit > 0) out = out.slice(0, options.limit);
    return out;
  }

  /** Forget every tenant's proposals (tests). */
  clear(): void {
    this.parts.clearAll();
  }
}

/** ADR-032: anchored on globalThis — a module-scope `let` is duplicated per bundle entry. */
const PROPOSALSTORE_KEY = "platform.agents.proposalStore";
function readCurrentStore(): ProposalStore {
  return getSingleton<ProposalStore>(
    PROPOSALSTORE_KEY,
    () => new InMemoryProposalStore()
  );
}
function writeCurrentStore(next: ProposalStore): void {
  setSingleton<ProposalStore>(PROPOSALSTORE_KEY, next);
}

export function getProposalStore(): ProposalStore {
  return readCurrentStore();
}

export function setProposalStore(store: ProposalStore): ProposalStore {
  const previous = readCurrentStore();
  writeCurrentStore(store);
  return previous;
}

export function resetProposalStore(): void {
  writeCurrentStore(new InMemoryProposalStore());
}
