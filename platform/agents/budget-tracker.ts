/**
 * platform/agents/budget-readTracker().ts — Agent budget enforcement
 *
 * Tracks and enforces per-agent per-scope cost budgets, and above them each tenant's own daily
 * cap on all its agents' spend together (ADR-053 D6: one tenant's agents cannot spend another's
 * share, nor the platform's). Prevents runaway costs by checking before each step.
 *
 * Budgets are per tenant: the Postgres store under row-level security, the in-memory store by
 * tenant partition.
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
import { resolveDailyCostCap, resolveTenantDailyCostCap } from "./budget-config";
import { TenantPartitionedMap, memoryPartition } from "@/platform/tenancy/partition";
import { DEFAULT_BUDGET_CONFIG } from "./types";
import { getSingleton, setSingleton } from "@/platform/kernel/singleton";

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
  /** The tenant whose budget this is ("-" outside any tenant: tests and local runs only). */
  readonly tenantId: string;
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
  /**
   * One step's spend, added to the agent's scope and to the tenant's total (`tenant`) as ONE
   * atomic change: both or neither. Two separate increments let a failure between them count
   * the agent's spend and not the tenant's — the tenant cap then under-counts, failing open.
   */
  incrementWithTenant(
    scope: BudgetScope,
    tenant: BudgetScope,
    deltaUsd: number,
    deltaSteps: number
  ): Promise<{ readonly agent: BudgetUsage; readonly tenant: BudgetUsage }>;
  reset(): Promise<void>;
}

function scopeKeyOf(scope: BudgetScope): string {
  return `${scope.agentId}:${scope.scopeType}:${scope.scopeId ?? ""}:${scope.period}`;
}

/** In-process store. Atomic by construction — JavaScript does not interleave here. */
export class InMemoryBudgetStore implements BudgetStore {
  private readonly parts = new TenantPartitionedMap<string, BudgetUsage>();

  private get usage(): Map<string, BudgetUsage> {
    return this.parts.current();
  }

  async read(scope: BudgetScope): Promise<BudgetUsage> {
    return this.usage.get(scopeKeyOf(scope)) ?? { usedUsd: 0, usedSteps: 0 };
  }

  async increment(
    scope: BudgetScope,
    deltaUsd: number,
    deltaSteps: number
  ): Promise<BudgetUsage> {
    return this.add(scope, deltaUsd, deltaSteps);
  }

  async incrementWithTenant(
    scope: BudgetScope,
    tenant: BudgetScope,
    deltaUsd: number,
    deltaSteps: number
  ): Promise<{ readonly agent: BudgetUsage; readonly tenant: BudgetUsage }> {
    // Synchronous between the two: nothing else runs in between, and neither can fail.
    const t = this.add(tenant, deltaUsd, deltaSteps);
    const agent = this.add(scope, deltaUsd, deltaSteps);
    return { agent, tenant: t };
  }

  private add(scope: BudgetScope, deltaUsd: number, deltaSteps: number): BudgetUsage {
    const key = scopeKeyOf(scope);
    const current = this.usage.get(key) ?? { usedUsd: 0, usedSteps: 0 };
    const next: BudgetUsage = {
      usedUsd: current.usedUsd + deltaUsd,
      usedSteps: current.usedSteps + deltaSteps,
    };
    this.usage.set(key, next);
    return next;
  }

  /** Forget the current tenant's budgets (as the Postgres store does). */
  async reset(): Promise<void> {
    this.usage.clear();
  }
}

/**
 * The scope that accumulates every agent's spend in a tenant, against the tenant's daily cap.
 * Not an agent id any agent can have (agent ids are "agent:…" or bare role names).
 */
export const TENANT_TOTAL_AGENT = "*tenant*";

// ---------------------------------------------------------------------------
// BudgetTracker
// ---------------------------------------------------------------------------

export class BudgetTracker {
  private readonly store: BudgetStore;

  constructor(store: BudgetStore = new InMemoryBudgetStore()) {
    this.store = store;
  }

  /**
   * Get the current period as YYYY-MM-DD, in UTC (TASK-144).
   *
   * Daily, because the ceiling it accumulates against is BudgetConfig.maxCostPerDay. In UTC so
   * the cap resets at the same moment on every host: it used the server's local day, which on a
   * host outside UTC moved the reset and could split one UTC day's spend across two periods.
   */
  getCurrentPeriod(now: Date = new Date()): string {
    return now.toISOString().slice(0, 10);
  }

  private scopeOf(
    agentId: string,
    scopeType: "group" | "user" | "platform",
    scopeId?: string
  ): BudgetScope {
    return { agentId, scopeType, scopeId, period: this.getCurrentPeriod() };
  }

  private tenantScope(): BudgetScope {
    return {
      agentId: TENANT_TOTAL_AGENT,
      scopeType: "platform",
      period: this.getCurrentPeriod(),
    };
  }

  /** The tenant's spend today across all its agents, against its daily cap. */
  async getTenantStatus(): Promise<{
    readonly tenantId: string;
    readonly period: string;
    readonly usedUsd: number;
    readonly budgetUsd: number;
    readonly exhausted: boolean;
  }> {
    const cap = await resolveTenantDailyCostCap();
    const scope = this.tenantScope();
    const usage = await this.store.read(scope);
    return {
      tenantId: memoryPartition(),
      period: scope.period,
      usedUsd: usage.usedUsd,
      budgetUsd: cap,
      exhausted: usage.usedUsd >= cap,
    };
  }

  private async toStatus(
    scope: BudgetScope,
    usage: BudgetUsage,
    config: BudgetConfig
  ): Promise<BudgetStatus> {
    const cap = await resolveDailyCostCap(config.maxCostPerDay);
    // Spend only. A step count accumulated per agent per period says nothing about
    // whether any one trajectory has run too long.
    return {
      tenantId: memoryPartition(),
      agentId: scope.agentId,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      period: scope.period,
      usedUsd: usage.usedUsd,
      budgetUsd: cap,
      usedSteps: usage.usedSteps,
      exhausted: usage.usedUsd >= cap,
      remainingUsd: Math.max(0, cap - usage.usedUsd),
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
    const cap = await resolveDailyCostCap(cfg.maxCostPerDay);
    const scope = this.scopeOf(agentId, scopeType, scopeId);
    const usage = await this.store.read(scope);
    const status = await this.toStatus(scope, usage, cfg);

    if (usage.usedUsd >= cap) {
      return {
        allowed: false,
        reason: `Daily budget exhausted: $${usage.usedUsd.toFixed(4)} / $${cap.toFixed(4)}`,
        status,
      };
    }

    // ADR-053 D6: the tenant's cap on all its agents together, checked after the agent's own.
    const tenantCap = await resolveTenantDailyCostCap();
    const tenantUsage = await this.store.read(this.tenantScope());
    if (tenantUsage.usedUsd >= tenantCap) {
      return {
        allowed: false,
        reason: `Tenant daily budget exhausted: $${tenantUsage.usedUsd.toFixed(4)} / $${tenantCap.toFixed(4)}`,
        status,
      };
    }

    // No step gate here. maxStepsPerTrajectory is enforced by runtime.ts inside the
    // execution loop, where stepCount is the count for THIS trajectory.
    return { allowed: true, status };
  }

  /**
   * Consume budget after a step completes: the agent's spend and the tenant's total move
   * together, atomically (both or neither) at the store.
   *
   * What a cap can and cannot stop: a step's cost is known only after it ran, so checkBudget
   * gates the NEXT step on the totals. Steps already running when a cap is reached (concurrent
   * trajectories that each passed the check) still complete and are counted — the overshoot is
   * bounded by the steps in flight, never lost or hidden. Preventing that would need each step's
   * cost reserved in advance, which no BudgetConfig states.
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
    const { agent } = await this.store.incrementWithTenant(
      scope,
      { ...this.tenantScope(), period: scope.period },
      costUsd,
      1
    );
    return this.toStatus(scope, agent, cfg);
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

/** ADR-032: anchored on globalThis — a module-scope `let` is duplicated per bundle entry. */
const BUDGETTRACKER_KEY = "platform.agents.budgetTracker";
function readTracker(): BudgetTracker {
  return getSingleton<BudgetTracker>(BUDGETTRACKER_KEY, () => new BudgetTracker());
}
function writeTracker(next: BudgetTracker): void {
  setSingleton<BudgetTracker>(BUDGETTRACKER_KEY, next);
}

export function getBudgetTracker(): BudgetTracker {
  return readTracker();
}

/** Set the active readTracker() (called by the provider registry in 2c-2b). */
export function setBudgetTracker(next: BudgetTracker): BudgetTracker {
  const previous = readTracker();
  writeTracker(next);
  return previous;
}

export function resetBudgetTracker(): void {
  writeTracker(new BudgetTracker());
}
