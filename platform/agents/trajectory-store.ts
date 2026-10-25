/**
 * platform/agents/trajectory-store.ts — Trajectory persistence
 *
 * Interface + InMemory implementation for trajectory storage. The durable implementation
 * (PostgresTrajectoryStore) is wired when TRAJECTORY_STORE=postgres. The in-memory store keeps
 * each tenant's trajectories in its own partition, as row-level security does (ADR-053 D6).
 *
 * P7:  Provider-aware — store interface with swappable implementations
 * P18: Durable trajectories — create, update, checkpoint, resume
 *
 * @module platform/agents
 */

import type { Trajectory, TrajectoryStatus, Step } from "./types";
// The contract moved to platform/kernel: the action pipeline appends trajectory
// steps and cannot import platform/agents (ADR-029 D2). Implementations and the
// singleton stay here; this re-export keeps every existing importer working.
export type {
  AddStepOptions,
  TrajectorySubjectKind,
  TrajectorySubject,
  TrajectoryQuery,
  TrajectoryCost,
  TrajectoryRecord,
  TrajectoryStore,
} from "@/platform/kernel/types";
import type {
  AddStepOptions,
  TrajectorySubject,
  TrajectoryQuery,
  TrajectoryCost,
  TrajectoryRecord,
  TrajectoryStore,
} from "@/platform/kernel/types";
import { generateId } from "./utils";
import { getSingleton, setSingleton } from "@/platform/kernel/singleton";
import { TenantPartitionedMap } from "@/platform/tenancy/partition";
import {
  jsonBytes,
  TRAJECTORY_MAX_BYTES,
  TRAJECTORY_MAX_STEPS,
  trajectoryChainFull,
  trajectoryFull,
  trajectoryHasRoom,
} from "@/platform/errors/json-limits";
import { resolveTrajectoryMaxSegments } from "./budget-config";

/** A step's size as stored; a value JSON cannot hold (in memory only) counts as nothing. */
function stepBytes(step: Step): number {
  try {
    return jsonBytes(step) + 1;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Query types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Trajectory subject (ADR-029 D4)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// TrajectoryStore interface
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// InMemoryTrajectoryStore
// ---------------------------------------------------------------------------

export class InMemoryTrajectoryStore implements TrajectoryStore {
  /** trajectoryId → record, per tenant. Insertion order is creation order. */
  private readonly parts = new TenantPartitionedMap<string, TrajectoryRecord>();

  async create(
    subject: TrajectorySubject,
    trigger: string,
    scopeType: "group" | "user" | "platform",
    scopeId?: string
  ): Promise<TrajectoryRecord> {
    const now = new Date().toISOString();
    const trajectory: Trajectory = {
      trajectoryId: generateId(),
      agentId: subject.id,
      steps: [],
      status: "running",
      totalCost: 0,
      createdAt: now,
      updatedAt: now,
    };
    const record: TrajectoryRecord = {
      trajectory,
      subject,
      trigger,
      scopeType,
      scopeId: scopeId ?? null,
      costSummary: { tokens: 0, apiCalls: 0, usd: 0 },
    };
    this.parts.current().set(trajectory.trajectoryId, record);
    return record;
  }

  /**
   * Bytes of each trajectory's steps, by trajectory id, per tenant (the per-trajectory cap, review
   * 10 L10). By id, not by record (review 11 L-4: a WeakMap keyed by the record forgot the count
   * whenever another write — updateStatus — replaced the record, so the cap never bound).
   */
  private readonly sizes = new TenantPartitionedMap<string, number>();

  private bytesOf(trajectoryId: string): number {
    return this.sizes.current().get(trajectoryId) ?? 0;
  }

  /** Each segment's continuation id, by segment id, per tenant (review 12 M1). */
  private readonly next = new TenantPartitionedMap<string, string>();

  /**
   * The first segment of the chain `record` belongs to: its predecessors by their links, each met
   * once (review 12 L6 — a corrupt, cyclic link ends the walk, never loops).
   */
  private rootOf(record: TrajectoryRecord): TrajectoryRecord {
    const records = this.parts.current();
    const seen = new Set<string>([record.trajectory.trajectoryId]);
    let at = record;
    for (;;) {
      const back = at.trajectory.previousTrajectoryId;
      if (!back || seen.has(back)) return at;
      const prev = records.get(back);
      if (!prev) return at;
      seen.add(back);
      at = prev;
    }
  }

  /** The last segment of the chain `record` belongs to (review 12 M1), each met once (L6). */
  private tailOf(record: TrajectoryRecord): TrajectoryRecord {
    const records = this.parts.current();
    const links = this.next.current();
    const seen = new Set<string>([record.trajectory.trajectoryId]);
    let at = record;
    for (;;) {
      const nextId = links.get(at.trajectory.trajectoryId);
      if (!nextId || seen.has(nextId)) return at;
      const n = records.get(nextId);
      if (!n) return at;
      seen.add(nextId);
      at = n;
    }
  }

  async chainTail(trajectoryId: string): Promise<TrajectoryRecord | undefined> {
    const current = this.parts.current().get(trajectoryId);
    return current ? this.tailOf(current) : undefined;
  }

  async chainSegment(
    trajectoryId: string,
    segment: number
  ): Promise<TrajectoryRecord | undefined> {
    const records = this.parts.current();
    const current = records.get(trajectoryId);
    if (!current || !Number.isInteger(segment) || segment < 1) return undefined;
    const links = this.next.current();
    let at: TrajectoryRecord | undefined = this.rootOf(current);
    const seen = new Set<string>();
    while (at && (at.trajectory.segment ?? 1) < segment) {
      seen.add(at.trajectory.trajectoryId);
      const nextId = links.get(at.trajectory.trajectoryId);
      at = nextId && !seen.has(nextId) ? records.get(nextId) : undefined;
    }
    return at && (at.trajectory.segment ?? 1) === segment ? at : undefined;
  }

  async assertRoomForStep(
    trajectoryId: string,
    options: AddStepOptions = {}
  ): Promise<void> {
    const current = this.parts.current().get(trajectoryId);
    if (!current) return;
    const tail = this.tailOf(current);
    const id = tail.trajectory.trajectoryId;
    if (trajectoryHasRoom(tail.trajectory.steps.length, this.bytesOf(id))) return;
    if (!options.rollover) throw trajectoryFull("agent_trajectories.steps");
    const max = await resolveTrajectoryMaxSegments();
    if ((tail.trajectory.segment ?? 1) >= max) {
      throw trajectoryChainFull("agent_trajectories", max);
    }
  }

  async addStep(
    trajectoryId: string,
    step: Step,
    options: AddStepOptions = {}
  ): Promise<TrajectoryRecord | undefined> {
    const current = this.parts.current().get(trajectoryId);
    if (!current) return undefined;
    const size = stepBytes(step);
    // Always the chain's tail (review 12 M1): whichever segment's id the caller holds, the step
    // goes after every step already recorded — never back into an earlier segment it fits in.
    const tail = this.tailOf(current);
    const id = tail.trajectory.trajectoryId;
    const bytes = this.bytesOf(id) + size;
    if (
      tail.trajectory.steps.length + 1 <= TRAJECTORY_MAX_STEPS &&
      bytes <= TRAJECTORY_MAX_BYTES
    ) {
      return this.append(tail, step, bytes);
    }
    // The same cap as the durable store. With rollover, a full tail is continued in a linked
    // new one (review 11 H-2), up to the chain's segment cap (review 12 M2).
    if (!options.rollover) throw trajectoryFull("agent_trajectories.steps");
    const max = await resolveTrajectoryMaxSegments();
    // Read again after the await: another append may have continued the chain meanwhile.
    const latest = this.tailOf(tail);
    if (latest !== tail)
      return this.addStep(latest.trajectory.trajectoryId, step, options);
    if ((tail.trajectory.segment ?? 1) >= max) {
      throw trajectoryChainFull("agent_trajectories", max);
    }
    return this.append(this.startContinuation(tail), step, size);
  }

  /** A new trajectory continuing `previous`: the same subject, trigger and scope (review 11 H-2). */
  private startContinuation(previous: TrajectoryRecord): TrajectoryRecord {
    const now = new Date().toISOString();
    const p = previous.trajectory;
    const record: TrajectoryRecord = {
      ...previous,
      trajectory: {
        trajectoryId: generateId(),
        agentId: p.agentId,
        steps: [],
        status: "running",
        totalCost: 0,
        createdAt: now,
        updatedAt: now,
        segment: (p.segment ?? 1) + 1,
        previousTrajectoryId: p.trajectoryId,
        // Every step before it: `previous` is the tail, so its predecessors' and its own.
        stepOffset: (p.stepOffset ?? 0) + p.steps.length,
      },
      costSummary: { tokens: 0, apiCalls: 0, usd: 0 },
    };
    this.parts.current().set(record.trajectory.trajectoryId, record);
    this.next.current().set(p.trajectoryId, record.trajectory.trajectoryId);
    return record;
  }

  private append(current: TrajectoryRecord, step: Step, bytes: number): TrajectoryRecord {
    const trajectoryId = current.trajectory.trajectoryId;
    const newSteps = [...current.trajectory.steps, step];
    const newTotalCost = current.trajectory.totalCost + step.cost;
    const newCost: TrajectoryCost = {
      tokens: current.costSummary.tokens,
      apiCalls: current.costSummary.apiCalls + (step.cost > 0 ? 1 : 0),
      usd: current.costSummary.usd + step.cost,
    };

    const updated: TrajectoryRecord = {
      ...current,
      trajectory: {
        ...current.trajectory,
        steps: newSteps,
        totalCost: newTotalCost,
        updatedAt: new Date().toISOString(),
      },
      costSummary: newCost,
    };
    this.parts.current().set(trajectoryId, updated);
    this.sizes.current().set(trajectoryId, bytes);
    return updated;
  }

  async updateStatus(
    trajectoryId: string,
    status: TrajectoryStatus
  ): Promise<TrajectoryRecord | undefined> {
    const records = this.parts.current();
    const current = records.get(trajectoryId);
    if (!current) return undefined;

    const updated: TrajectoryRecord = {
      ...current,
      trajectory: {
        ...current.trajectory,
        status,
        updatedAt: new Date().toISOString(),
      },
    };
    records.set(trajectoryId, updated);
    return updated;
  }

  /**
   * Move `trajectoryId` to `to` only if its status is one of `from` (compare-and-set), at once —
   * what the in-memory recovery of a lost run uses (InMemoryProposalStore.recoverStaleRuns,
   * TASK-173). Returns the moved record, or undefined when it was not in one of `from`.
   */
  moveStatus(
    trajectoryId: string,
    from: readonly TrajectoryStatus[],
    to: TrajectoryStatus
  ): TrajectoryRecord | undefined {
    const records = this.parts.current();
    const current = records.get(trajectoryId);
    if (!current || !from.includes(current.trajectory.status)) return undefined;
    const updated: TrajectoryRecord = {
      ...current,
      trajectory: {
        ...current.trajectory,
        status: to,
        updatedAt: new Date().toISOString(),
      },
    };
    records.set(trajectoryId, updated);
    return updated;
  }

  async getById(trajectoryId: string): Promise<TrajectoryRecord | undefined> {
    return this.parts.current().get(trajectoryId);
  }

  async query(options: TrajectoryQuery): Promise<readonly TrajectoryRecord[]> {
    let filtered = [...this.parts.current().values()];

    if (options.agentId) {
      filtered = filtered.filter((r) => r.trajectory.agentId === options.agentId);
    }
    if (options.subjectKind) {
      filtered = filtered.filter((r) => r.subject.kind === options.subjectKind);
    }
    if (options.subjectId) {
      filtered = filtered.filter((r) => r.subject.id === options.subjectId);
    }
    if (options.scopeType) {
      filtered = filtered.filter((r) => r.scopeType === options.scopeType);
    }
    if (options.scopeId) {
      filtered = filtered.filter((r) => r.scopeId === options.scopeId);
    }
    if (options.status) {
      filtered = filtered.filter((r) => r.trajectory.status === options.status);
    }

    // Most recent first; a continuation created in the same millisecond as its predecessor is
    // still the newer (its segment).
    filtered.sort(
      (a, b) =>
        b.trajectory.createdAt.localeCompare(a.trajectory.createdAt) ||
        (b.trajectory.segment ?? 1) - (a.trajectory.segment ?? 1)
    );

    if (options.limit && options.limit > 0) {
      filtered = filtered.slice(0, options.limit);
    }

    return options.withoutSteps
      ? filtered.map((r) => ({ ...r, trajectory: { ...r.trajectory, steps: [] } }))
      : filtered;
  }

  async deleteFinishedBefore(cutoff: Date, limit: number): Promise<number> {
    const records = this.parts.current();
    const at = cutoff.getTime();
    let deleted = 0;
    for (const [id, r] of records) {
      if (deleted >= limit) break;
      const finished =
        r.trajectory.status === "completed" || r.trajectory.status === "failed";
      if (finished && new Date(r.trajectory.updatedAt).getTime() < at) {
        records.delete(id);
        this.sizes.current().delete(id);
        this.next.current().delete(id);
        deleted++;
      }
    }
    return deleted;
  }

  /** The current tenant's record count (test helper) */
  getRecordCount(): number {
    return this.parts.current().size;
  }

  /** Clear every tenant's data (test helper) */
  clear(): void {
    this.parts.clearAll();
    this.sizes.clearAll();
    this.next.clearAll();
  }
}

// ---------------------------------------------------------------------------
// Chains (review 11 H-2)
// ---------------------------------------------------------------------------

/** The most segments a chain is followed through (a guard against a corrupt store). */
const MAX_CHAIN_SEGMENTS = 100_000;

/**
 * The segments of the chain `trajectoryId` belongs to, first to last, one at a time (review 12
 * M2): each read alone (chainSegment), so a reader that needs the history holds one segment's
 * steps at a time, never the whole chain. Each segment is yielded once, in order (review 12 L6: a
 * store that answers a segment twice, or out of order, ends the walk).
 */
export async function* trajectoryChainPages(
  store: TrajectoryStore,
  trajectoryId: string
): AsyncGenerator<TrajectoryRecord> {
  const tail = await store.chainTail(trajectoryId);
  if (!tail) return;
  const last = Math.min(tail.trajectory.segment ?? 1, MAX_CHAIN_SEGMENTS);
  const seen = new Set<string>();
  for (let n = 1; n <= last; n++) {
    const seg = n === last ? tail : await store.chainSegment(trajectoryId, n);
    if (!seg || seen.has(seg.trajectory.trajectoryId)) return;
    if ((seg.trajectory.segment ?? 1) !== n) return;
    seen.add(seg.trajectory.trajectoryId);
    yield seg;
  }
}

/**
 * Every segment of the chain `trajectoryId` belongs to, first to last (review 11 H-2), read one
 * segment at a time (trajectoryChainPages) and collected — the whole chain in memory, so for a
 * reader that needs it all; one that can work segment by segment uses the pages. A trajectory
 * never continued is a chain of one.
 */
export async function readTrajectoryChain(
  store: TrajectoryStore,
  trajectoryId: string
): Promise<readonly TrajectoryRecord[]> {
  const out: TrajectoryRecord[] = [];
  for await (const seg of trajectoryChainPages(store, trajectoryId)) out.push(seg);
  return out;
}

/**
 * The last segment of the chain `trajectoryId` belongs to (itself when never continued) — read
 * alone, with none of its predecessors' steps (review 12 M2).
 */
export async function latestTrajectorySegment(
  store: TrajectoryStore,
  trajectoryId: string
): Promise<TrajectoryRecord | undefined> {
  return store.chainTail(trajectoryId);
}

/** Every step of a chain, in order: the whole run as one list. */
export function chainSteps(chain: readonly TrajectoryRecord[]): readonly Step[] {
  return chain.flatMap((r) => r.trajectory.steps);
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

/** ADR-032: anchored on globalThis — a module-scope `let` is duplicated per bundle entry. */
const TRAJECTORYSTORE_KEY = "platform.agents.trajectoryStore";
function readCurrentStore(): TrajectoryStore {
  return getSingleton<TrajectoryStore>(
    TRAJECTORYSTORE_KEY,
    () => new InMemoryTrajectoryStore()
  );
}
function writeCurrentStore(next: TrajectoryStore): void {
  setSingleton<TrajectoryStore>(TRAJECTORYSTORE_KEY, next);
}

export function getTrajectoryStore(): TrajectoryStore {
  return readCurrentStore();
}

export function setTrajectoryStore(store: TrajectoryStore): TrajectoryStore {
  const previous = readCurrentStore();
  writeCurrentStore(store);
  return previous;
}

export function resetTrajectoryStore(): void {
  writeCurrentStore(new InMemoryTrajectoryStore());
}
