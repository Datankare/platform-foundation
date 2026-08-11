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
// The contract moved to platform/kernel: the action pipeline appends trajectory
// steps and cannot import platform/agents (ADR-029 D2). Implementations and the
// singleton stay here; this re-export keeps every existing importer working.
export type {
  TrajectorySubjectKind,
  TrajectorySubject,
  TrajectoryQuery,
  TrajectoryCost,
  TrajectoryRecord,
  TrajectoryStore,
} from "@/platform/kernel/types";
import type {
  TrajectorySubject,
  TrajectoryQuery,
  TrajectoryCost,
  TrajectoryRecord,
  TrajectoryStore,
} from "@/platform/kernel/types";
import { generateId } from "./utils";
import { getSingleton, setSingleton } from "@/platform/kernel/singleton";

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
