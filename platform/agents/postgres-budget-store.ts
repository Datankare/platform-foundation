/**
 * platform/agents/postgres-budget-store.ts — durable budget accumulation (ADR-048 D3, ADR-053 D4)
 *
 * BudgetStore on Postgres through platform/data, in the request's tenant: row-level security
 * keeps each tenant's spend apart, and the budget function adds within the caller's tenant.
 *
 * `increment` calls agent_budget_consume() rather than reading and writing: the database does
 * the addition, so concurrent increments are never lost (losing them under-reports spend — it
 * fails in the direction of overspending).
 *
 * P12: Economic transparency — spend accumulates across instances, not per process
 * P13: Control plane — the daily ceiling is enforceable because the counter is shared
 *
 * @module platform/agents
 */

import {
  TENANT_TOTAL_AGENT,
  type BudgetScope,
  type BudgetStore,
  type BudgetUsage,
} from "./budget-tracker";
import { withTenantTx } from "@/platform/data";

interface UsageRow {
  used_usd: string | number;
  used_steps: string | number;
}

/** numeric arrives as text (no precision is lost in transit); integers as numbers. */
function num(value: string | number | undefined | null): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
    throw new Error("agents: budget row holds a non-numeric amount");
  }
  return 0;
}

function usage(row: UsageRow | undefined): BudgetUsage {
  return { usedUsd: num(row?.used_usd), usedSteps: num(row?.used_steps) };
}

export class PostgresBudgetStore implements BudgetStore {
  async read(scope: BudgetScope): Promise<BudgetUsage> {
    const { rows } = await withTenantTx((tx) =>
      tx.query<UsageRow>(
        `select used_usd, used_steps from agent_budgets
          where agent_id = $1 and scope_type = $2::trajectory_scope
            and scope_id is not distinct from $3 and period = $4`,
        [scope.agentId, scope.scopeType, scope.scopeId ?? null, scope.period]
      )
    );
    return usage(rows[0]);
  }

  async increment(
    scope: BudgetScope,
    deltaUsd: number,
    deltaSteps: number
  ): Promise<BudgetUsage> {
    const { rows } = await withTenantTx((tx) =>
      tx.query<UsageRow>(
        "select used_usd, used_steps from agent_budget_consume($1, $2::trajectory_scope, $3, $4, $5, $6)",
        [
          scope.agentId,
          scope.scopeType,
          scope.scopeId ?? null,
          scope.period,
          deltaUsd,
          deltaSteps,
        ]
      )
    );
    if (rows.length !== 1) throw new Error("agents: budget increment returned no row");
    return usage(rows[0]);
  }

  /**
   * The agent's scope and the tenant's total, in one transaction: agent_budget_consume_with_tenant
   * (049) locks the tenant's total row first, so a tenant's consumes serialise on it and the two
   * counters never disagree. `tenant` must be the tracker's tenant-total scope, which the
   * function fixes in SQL ('*tenant*', platform scope).
   */
  async incrementWithTenant(
    scope: BudgetScope,
    tenant: BudgetScope,
    deltaUsd: number,
    deltaSteps: number
  ): Promise<{ readonly agent: BudgetUsage; readonly tenant: BudgetUsage }> {
    if (
      tenant.agentId !== TENANT_TOTAL_AGENT ||
      tenant.scopeType !== "platform" ||
      tenant.scopeId !== undefined ||
      tenant.period !== scope.period
    ) {
      throw new Error("agents: the tenant scope is not this period's tenant total");
    }
    const { rows } = await withTenantTx((tx) =>
      tx.query<
        UsageRow & { tenant_used_usd: string | number; tenant_used_steps: number }
      >(
        `select used_usd, used_steps, tenant_used_usd, tenant_used_steps
           from agent_budget_consume_with_tenant($1, $2::trajectory_scope, $3, $4, $5, $6)`,
        [
          scope.agentId,
          scope.scopeType,
          scope.scopeId ?? null,
          scope.period,
          deltaUsd,
          deltaSteps,
        ]
      )
    );
    if (rows.length !== 1) throw new Error("agents: budget increment returned no row");
    return {
      agent: usage(rows[0]),
      tenant: usage({
        used_usd: rows[0].tenant_used_usd,
        used_steps: rows[0].tenant_used_steps,
      }),
    };
  }

  /** Forget this tenant's budgets (tests and operator resets). Never another tenant's. */
  async reset(): Promise<void> {
    await withTenantTx((tx) => tx.query("delete from agent_budgets"));
  }
}
