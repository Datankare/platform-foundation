/**
 * platform/agents/trajectory-store.ts — Trajectory persistence
 *
 * Interface + InMemory implementation for trajectory storage.
 * Supabase implementation wired when SOCIAL_STORE=supabase.
 *
 * P7:  Provider-aware — store interface with swappable implementations
 * P18: Durable trajectories — create, update, checkpoint, resume
 *
 * @module platform/agents
 */

import type { Trajectory, TrajectoryStatus, Step } from "./types";
import { generateId } from "./utils";

// ---------------------------------------------------------------------------
// Query types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Trajectory subject (ADR-029 D4)
// ---------------------------------------------------------------------------

/** Whether a trajectory belongs to an agent run or to an application session. */
export type TrajectorySubjectKind = "agent" | "session";

/**
 * Who or what the trajectory is about.
 *
 * Before ADR-029 D4, session trajectories were created by passing a sessionId into the
 * `agentId` parameter. It type-checked and was semantically wrong: session trajectories
 * were indistinguishable from agent trajectories and no query could retrieve them by
 * session.
 */
export interface TrajectorySubject {
  readonly kind: TrajectorySubjectKind;
  readonly id: string;
}

/** Options for querying trajectories */
export interface TrajectoryQuery {
  readonly agentId?: string;
  /** Filter to agent trajectories or session trajectories (ADR-029 D4). */
  readonly subjectKind?: TrajectorySubjectKind;
  /** Filter to one subject id — the sessionId for session trajectories. */
  readonly subjectId?: string;
  readonly scopeType?: "group" | "user" | "platform";
  readonly scopeId?: string;
  readonly status?: TrajectoryStatus;
  readonly limit?: number;
}

/** Cost summary stored alongside trajectory */
export interface TrajectoryCost {
  readonly tokens: number;
  readonly apiCalls: number;
  readonly usd: number;
}

/** Full trajectory record with persistence metadata */
export interface TrajectoryRecord {
  readonly trajectory: Trajectory;
  /** What this trajectory is about — agent run or session (ADR-029 D4). */
  readonly subject: TrajectorySubject;
  readonly trigger: string;
  readonly scopeType: "group" | "user" | "platform";
  readonly scopeId: string | null;
  readonly costSummary: TrajectoryCost;
}

// ---------------------------------------------------------------------------
// TrajectoryStore interface
// ---------------------------------------------------------------------------

export interface TrajectoryStore {
  /**
   * Create a new trajectory for an explicit subject. Returns the record.
   *
   * The subject is a discriminator, not a renamed agentId (ADR-029 D4): a session
   * trajectory and an agent trajectory are now distinguishable without inspecting the
   * trigger string.
   */
  create(
    subject: TrajectorySubject,
    trigger: string,
    scopeType: "group" | "user" | "platform",
    scopeId?: string
  ): Promise<TrajectoryRecord>;

  /** Add a step to a trajectory. Returns updated record. */
  addStep(trajectoryId: string, step: Step): Promise<TrajectoryRecord | undefined>;

  /** Update trajectory status. */
  updateStatus(
    trajectoryId: string,
    status: TrajectoryStatus
  ): Promise<TrajectoryRecord | undefined>;

  /** Get a trajectory by ID. */
  getById(trajectoryId: string): Promise<TrajectoryRecord | undefined>;

  /** Query trajectories with filters. */
  query(options: TrajectoryQuery): Promise<readonly TrajectoryRecord[]>;
}

// ---------------------------------------------------------------------------
// InMemoryTrajectoryStore
// ---------------------------------------------------------------------------

export class InMemoryTrajectoryStore implements TrajectoryStore {
  private records: TrajectoryRecord[] = [];

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
    this.records.push(record);
    return record;
  }

  async addStep(trajectoryId: string, step: Step): Promise<TrajectoryRecord | undefined> {
    const index = this.records.findIndex(
      (r) => r.trajectory.trajectoryId === trajectoryId
    );
    if (index === -1) return undefined;

    const current = this.records[index];
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
    this.records[index] = updated;
    return updated;
  }

  async updateStatus(
    trajectoryId: string,
    status: TrajectoryStatus
  ): Promise<TrajectoryRecord | undefined> {
    const index = this.records.findIndex(
      (r) => r.trajectory.trajectoryId === trajectoryId
    );
    if (index === -1) return undefined;

    const current = this.records[index];
    const updated: TrajectoryRecord = {
      ...current,
      trajectory: {
        ...current.trajectory,
        status,
        updatedAt: new Date().toISOString(),
      },
    };
    this.records[index] = updated;
    return updated;
  }

  async getById(trajectoryId: string): Promise<TrajectoryRecord | undefined> {
    return this.records.find((r) => r.trajectory.trajectoryId === trajectoryId);
  }

  async query(options: TrajectoryQuery): Promise<readonly TrajectoryRecord[]> {
    let filtered = [...this.records];

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

    // Most recent first
    filtered.sort((a, b) => b.trajectory.createdAt.localeCompare(a.trajectory.createdAt));

    if (options.limit && options.limit > 0) {
      filtered = filtered.slice(0, options.limit);
    }

    return filtered;
  }

  /** Get total count (test helper) */
  getRecordCount(): number {
    return this.records.length;
  }

  /** Clear all data (test helper) */
  clear(): void {
    this.records = [];
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let currentStore: TrajectoryStore = new InMemoryTrajectoryStore();

export function getTrajectoryStore(): TrajectoryStore {
  return currentStore;
}

export function setTrajectoryStore(store: TrajectoryStore): TrajectoryStore {
  const previous = currentStore;
  currentStore = store;
  return previous;
}

export function resetTrajectoryStore(): void {
  currentStore = new InMemoryTrajectoryStore();
}
