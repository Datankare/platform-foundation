/**
 * platform/agents/budget-tracker.ts — Agent budget enforcement
 *
 * Tracks and enforces per-agent per-scope cost budgets.
 * Prevents runaway costs by checking before each step.
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

/** Current budget status for an agent in a scope */
export interface BudgetStatus {
  readonly agentId: string;
  readonly scopeKey: string;
  readonly period: string;
  readonly usedUsd: number;
  readonly budgetUsd: number;
  readonly usedSteps: number;
  readonly maxSteps: number;
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
// Budget record (in-memory)
// ---------------------------------------------------------------------------

interface BudgetRecord {
  agentId: string;
  scopeKey: string;
  period: string;
  usedUsd: number;
  usedSteps: number;
  config: BudgetConfig;
}

// ---------------------------------------------------------------------------
// BudgetTracker
// ---------------------------------------------------------------------------

export class BudgetTracker {
  private records = new Map<string, BudgetRecord>();

  /**
   * Build a unique key for agent + scope + period.
   */
  private makeKey(agentId: string, scopeKey: string, period: string): string {
    return `${agentId}:${scopeKey}:${period}`;
  }

  /**
   * Get current period in YYYY-MM format.
   */
  getCurrentPeriod(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    return `${year}-${month}`;
  }

  /**
   * Ensure a budget record exists, creating with defaults if not.
   */
  private ensureRecord(
    agentId: string,
    scopeKey: string,
    period: string,
    config?: BudgetConfig
  ): BudgetRecord {
    const key = this.makeKey(agentId, scopeKey, period);
    let record = this.records.get(key);
    if (!record) {
      record = {
        agentId,
        scopeKey,
        period,
        usedUsd: 0,
        usedSteps: 0,
        config: config ?? DEFAULT_BUDGET_CONFIG,
      };
      this.records.set(key, record);
    }
    return record;
  }

  /**
   * Build a BudgetStatus from a record.
   */
  private toStatus(record: BudgetRecord): BudgetStatus {
    const exhausted =
      record.usedUsd >= record.config.maxCostPerDay ||
      record.usedSteps >= record.config.maxStepsPerTrajectory;
    return {
      agentId: record.agentId,
      scopeKey: record.scopeKey,
      period: record.period,
      usedUsd: record.usedUsd,
      budgetUsd: record.config.maxCostPerDay,
      usedSteps: record.usedSteps,
      maxSteps: record.config.maxStepsPerTrajectory,
      exhausted,
      remainingUsd: Math.max(0, record.config.maxCostPerDay - record.usedUsd),
    };
  }

  /**
   * Check if budget allows another step.
   * Does NOT consume — use consume() after the step succeeds.
   */
  checkBudget(
    agentId: string,
    scopeKey: string,
    config?: BudgetConfig
  ): BudgetCheckResult {
    const period = this.getCurrentPeriod();
    const record = this.ensureRecord(agentId, scopeKey, period, config);
    const status = this.toStatus(record);

    if (record.usedUsd >= record.config.maxCostPerDay) {
      return {
        allowed: false,
        reason: `Daily budget exhausted: $${record.usedUsd.toFixed(4)} / $${record.config.maxCostPerDay.toFixed(4)}`,
        status,
      };
    }

    if (record.usedSteps >= record.config.maxStepsPerTrajectory) {
      return {
        allowed: false,
        reason: `Step limit reached: ${record.usedSteps} / ${record.config.maxStepsPerTrajectory}`,
        status,
      };
    }

    return { allowed: true, status };
  }

  /**
   * Consume budget after a step completes.
   * Returns updated status.
   */
  consume(
    agentId: string,
    scopeKey: string,
    costUsd: number,
    config?: BudgetConfig
  ): BudgetStatus {
    const period = this.getCurrentPeriod();
    const record = this.ensureRecord(agentId, scopeKey, period, config);
    record.usedUsd += costUsd;
    record.usedSteps += 1;
    return this.toStatus(record);
  }

  /**
   * Get current budget status without modifying.
   */
  getStatus(agentId: string, scopeKey: string, config?: BudgetConfig): BudgetStatus {
    const period = this.getCurrentPeriod();
    const record = this.ensureRecord(agentId, scopeKey, period, config);
    return this.toStatus(record);
  }

  /**
   * Clear all budget data (testing only).
   */
  reset(): void {
    this.records.clear();
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let tracker = new BudgetTracker();

export function getBudgetTracker(): BudgetTracker {
  return tracker;
}

export function resetBudgetTracker(): void {
  tracker = new BudgetTracker();
}
