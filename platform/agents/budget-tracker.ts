/**
 * platform/agents/budget-tracker.ts — Agent budget enforcement
 *
 * Tracks and enforces per-agent per-scope cost budgets.
 * Prevents runaway costs by checking before each step.
 *
 * Scope of what this enforces: spend only. The period is a calendar day, matching
 * BudgetConfig.maxCostPerDay. The per-trajectory step limit is NOT enforced here — it
 * belongs where the trajectory is, and runtime.ts enforces it inside the execution loop.
 *
 * Storage is behind BudgetStore so spend can accumulate across instances (TASK-063). The
 * methods are async for that reason and no other: a synchronous read-through cache in
 * front of a durable counter cannot enforce a cap across instances, which is the defect.
 *
 * P12: Economic transparency — every cost is tracked
 * P13: Control plane — budgets are configurable limits
 * P11: Resilient degradation — budget exhausted → degrade, don't crash
 *
 * @module platform/agents
 */

import type { BudgetConfig } from "./types";
import { DEFAULT_BUDGET_CONFIG } from "./types";

// ---------------------------------------------------------------------------
// Budget state types
// ---------------------------------------------------------------------------

/** The scope a budget accumulates against. Mirrors agent_budgets' key columns. */
export interface BudgetScope {
  readonly agentId: string;
  readonly scopeType: "group" | "user" | "platform";
  /** The scoped entity. Absent for platform scope. */
  readonly scopeId?: string;
  /** YYYY-MM-DD. */
  readonly period: string;
}

/** Accumulated usage for one scope in one period. */
export interface BudgetUsage {
  readonly usedUsd: number;
  readonly usedSteps: number;
}

/** Current budget status for an agent in a scope */
export interface BudgetStatus {
  readonly agentId: string;
  readonly scopeType: "group" | "user" | "platform";
  readonly scopeId?: string;
  readonly period: string;
  readonly usedUsd: number;
  readonly budgetUsd: number;
  /** Observability only (P12) — steps do not gate. See the module header. */
  readonly usedSteps: number;
  readonly exhausted: boolean;
  readonly remainingUsd: number;
}

/** Budget check result */
export interface BudgetCheckResult {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly status: BudgetStatus;
}

// ---------------------------------------------------------------------------
// BudgetStore
// ---------------------------------------------------------------------------

/**
 * Durable accumulation of spend.
 *
 * `increment` MUST be atomic add-and-return. Reading a counter, adding in application
 * code and writing it back loses concurrent increments, and a spend counter that loses
 * increments under-reports spend — it fails open, in the direction of overspending. An
 * implementation that cannot do this atomically must not register.
 */
export interface BudgetStore {
  read(scope: BudgetScope): Promise<BudgetUsage>;
  increment(
    scope: BudgetScope,
    deltaUsd: number,
    deltaSteps: number
  ): Promise<BudgetUsage>;
  reset(): Promise<void>;
}

function scopeKeyOf(scope: BudgetScope): string {
  return `${scope.agentId}:${scope.scopeType}:${scope.scopeId ?? ""}:${scope.period}`;
}

/** In-process store. Atomic by construction — JavaScript does not interleave here. */
export class InMemoryBudgetStore implements BudgetStore {
  private usage = new Map<string, BudgetUsage>();

  async read(scope: BudgetScope): Promise<BudgetUsage> {
    return this.usage.get(scopeKeyOf(scope)) ?? { usedUsd: 0, usedSteps: 0 };
  }

  async increment(
    scope: BudgetScope,
    deltaUsd: number,
    deltaSteps: number
  ): Promise<BudgetUsage> {
    const key = scopeKeyOf(scope);
    const current = this.usage.get(key) ?? { usedUsd: 0, usedSteps: 0 };
    const next: BudgetUsage = {
      usedUsd: current.usedUsd + deltaUsd,
      usedSteps: current.usedSteps + deltaSteps,
    };
    this.usage.set(key, next);
    return next;
  }

  async reset(): Promise<void> {
    this.usage.clear();
  }
}

// ---------------------------------------------------------------------------
// BudgetTracker
// ---------------------------------------------------------------------------

export class BudgetTracker {
  private readonly store: BudgetStore;

  constructor(store: BudgetStore = new InMemoryBudgetStore()) {
    this.store = store;
  }

  /**
   * Get the current period as YYYY-MM-DD.
   *
   * Daily, because the ceiling it accumulates against is BudgetConfig.maxCostPerDay.
   */
  getCurrentPeriod(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  private scopeOf(
    agentId: string,
    scopeType: "group" | "user" | "platform",
    scopeId?: string
  ): BudgetScope {
    return { agentId, scopeType, scopeId, period: this.getCurrentPeriod() };
  }

  private toStatus(
    scope: BudgetScope,
    usage: BudgetUsage,
    config: BudgetConfig
  ): BudgetStatus {
    // Spend only. A step count accumulated per agent per period says nothing about
    // whether any one trajectory has run too long.
    return {
      agentId: scope.agentId,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      period: scope.period,
      usedUsd: usage.usedUsd,
      budgetUsd: config.maxCostPerDay,
      usedSteps: usage.usedSteps,
      exhausted: usage.usedUsd >= config.maxCostPerDay,
      remainingUsd: Math.max(0, config.maxCostPerDay - usage.usedUsd),
    };
  }

  /**
   * Check if budget allows another step.
   * Does NOT consume — use consume() after the step succeeds.
   */
  async checkBudget(
    agentId: string,
    scopeType: "group" | "user" | "platform",
    scopeId?: string,
    config?: BudgetConfig
  ): Promise<BudgetCheckResult> {
    const cfg = config ?? DEFAULT_BUDGET_CONFIG;
    const scope = this.scopeOf(agentId, scopeType, scopeId);
    const usage = await this.store.read(scope);
    const status = this.toStatus(scope, usage, cfg);

    if (usage.usedUsd >= cfg.maxCostPerDay) {
      return {
        allowed: false,
        reason: `Daily budget exhausted: $${usage.usedUsd.toFixed(4)} / $${cfg.maxCostPerDay.toFixed(4)}`,
        status,
      };
    }

    // No step gate here. maxStepsPerTrajectory is enforced by runtime.ts inside the
    // execution loop, where stepCount is the count for THIS trajectory.
    return { allowed: true, status };
  }

  /**
   * Consume budget after a step completes. Atomic at the store.
   */
  async consume(
    agentId: string,
    scopeType: "group" | "user" | "platform",
    scopeId: string | undefined,
    costUsd: number,
    config?: BudgetConfig
  ): Promise<BudgetStatus> {
    const cfg = config ?? DEFAULT_BUDGET_CONFIG;
    const scope = this.scopeOf(agentId, scopeType, scopeId);
    const usage = await this.store.increment(scope, costUsd, 1);
    return this.toStatus(scope, usage, cfg);
  }

  /**
   * Get current budget status without modifying.
   */
  async getStatus(
    agentId: string,
    scopeType: "group" | "user" | "platform",
    scopeId?: string,
    config?: BudgetConfig
  ): Promise<BudgetStatus> {
    const cfg = config ?? DEFAULT_BUDGET_CONFIG;
    const scope = this.scopeOf(agentId, scopeType, scopeId);
    return this.toStatus(scope, await this.store.read(scope), cfg);
  }

  /**
   * Clear all budget data (testing only).
   */
  async reset(): Promise<void> {
    await this.store.reset();
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let tracker = new BudgetTracker();

export function getBudgetTracker(): BudgetTracker {
  return tracker;
}

/** Set the active tracker (called by the provider registry in 2c-2b). */
export function setBudgetTracker(next: BudgetTracker): void {
  tracker = next;
}

export function resetBudgetTracker(): void {
  tracker = new BudgetTracker();
}
