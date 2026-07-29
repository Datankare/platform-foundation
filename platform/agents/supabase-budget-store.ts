/**
 * platform/agents/supabase-budget-store.ts — Durable budget accumulation
 *
 * BudgetStore backed by Postgres via the Supabase REST API, using raw fetch() — the
 * SupabaseTrajectoryStore / SupabaseSocialStore pattern, no JS client, so the conformance
 * kit can exercise this class against a PostgREST fake.
 *
 * Table: agent_budgets (migration 016, reshaped by 023).
 *
 * `increment` calls the agent_budget_consume() function rather than issuing a PATCH.
 * PostgREST cannot express `used_usd = used_usd + $1`, and doing the arithmetic here would
 * mean read-then-write — which loses concurrent increments and under-reports spend, i.e.
 * fails in the direction of overspending. The database does the addition.
 *
 * P12: Economic transparency — spend accumulates across instances, not per process
 * P13: Control plane — the daily ceiling is enforceable because the counter is shared
 *
 * @module platform/agents
 */

import type { BudgetScope, BudgetStore, BudgetUsage } from "./budget-tracker";

const TABLE = "agent_budgets";
const RPC = "agent_budget_consume";

interface UsageRow {
  used_usd: number | string;
  used_steps: number | string;
}

function headers(key: string, prefer?: string): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    apikey: key,
    Authorization: `Bearer ${key}`,
  };
  if (prefer) h["Prefer"] = prefer;
  return h;
}

/** NUMERIC comes back as a string from PostgREST when precision could be lost. */
function num(value: number | string | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function mapUsage(row: UsageRow | undefined): BudgetUsage {
  return {
    usedUsd: num(row?.used_usd),
    usedSteps: num(row?.used_steps),
  };
}

export class SupabaseBudgetStore implements BudgetStore {
  private readonly url: string;
  private readonly key: string;

  constructor(url: string, serviceKey: string) {
    this.url = url.replace(/\/+$/, "");
    this.key = serviceKey;
  }

  private scopeFilters(scope: BudgetScope): string {
    const parts = [
      `agent_id=eq.${encodeURIComponent(scope.agentId)}`,
      `scope_type=eq.${encodeURIComponent(scope.scopeType)}`,
      `period=eq.${encodeURIComponent(scope.period)}`,
      scope.scopeId === undefined
        ? "scope_id=is.null"
        : `scope_id=eq.${encodeURIComponent(scope.scopeId)}`,
    ];
    return parts.join("&");
  }

  async read(scope: BudgetScope): Promise<BudgetUsage> {
    const res = await fetch(
      `${this.url}/rest/v1/${TABLE}?${this.scopeFilters(scope)}&select=used_usd,used_steps`,
      { method: "GET", headers: headers(this.key) }
    );
    if (!res.ok) {
      throw new Error(`agents: budget read failed (${res.status}): ${await res.text()}`);
    }
    const rows = (await res.json()) as UsageRow[];
    return mapUsage(rows[0]);
  }

  async increment(
    scope: BudgetScope,
    deltaUsd: number,
    deltaSteps: number
  ): Promise<BudgetUsage> {
    const res = await fetch(`${this.url}/rest/v1/rpc/${RPC}`, {
      method: "POST",
      headers: headers(this.key),
      body: JSON.stringify({
        p_agent_id: scope.agentId,
        p_scope_type: scope.scopeType,
        p_scope_id: scope.scopeId ?? null,
        p_period: scope.period,
        p_delta_usd: deltaUsd,
        p_delta_steps: deltaSteps,
      }),
    });
    if (!res.ok) {
      throw new Error(
        `agents: budget increment failed (${res.status}): ${await res.text()}`
      );
    }
    const payload = (await res.json()) as UsageRow[] | UsageRow;
    const row = Array.isArray(payload) ? payload[0] : payload;
    return mapUsage(row);
  }

  async reset(): Promise<void> {
    // period is NOT NULL, so this matches every row. PostgREST refuses an unfiltered
    // DELETE, which is a guard worth keeping rather than working around with a wildcard.
    const res = await fetch(`${this.url}/rest/v1/${TABLE}?period=not.is.null`, {
      method: "DELETE",
      headers: headers(this.key),
    });
    if (!res.ok) {
      throw new Error(`agents: budget reset failed (${res.status}): ${await res.text()}`);
    }
  }
}
