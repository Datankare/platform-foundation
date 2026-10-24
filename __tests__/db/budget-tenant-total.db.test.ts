/**
 * @jest-environment node
 */
/**
 * The tenant's daily agent total moves with every agent's spend, atomically (ADR-053 D6), on
 * Postgres: a failure while consuming counts neither, so the tenant cap never under-counts what
 * its agents spent; and concurrent consumes in one tenant each see the totals the one before
 * left (agent_budget_consume_with_tenant serialises them on the tenant's total row).
 */

jest.mock("@/platform/auth/platform-config", () => ({
  getConfig: jest.fn(async (_key: string, dflt: unknown) => dflt),
}));

import { BudgetTracker, TENANT_TOTAL_AGENT } from "@/platform/agents/budget-tracker";
import { PostgresBudgetStore } from "@/platform/agents/postgres-budget-store";
import { DEFAULT_BUDGET_CONFIG } from "@/platform/agents/types";
import { withTenantTx } from "@/platform/data";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
} from "../helpers/db";

const roomy = { ...DEFAULT_BUDGET_CONFIG, maxCostPerDay: 1000 };

async function totals(): Promise<Record<string, number>> {
  const { rows } = await withTenantTx((tx) =>
    tx.query<{ agent_id: string; used: string }>(
      "select agent_id, sum(used_usd)::text as used from agent_budgets group by agent_id"
    )
  );
  return Object.fromEntries(rows.map((r) => [r.agent_id, Number(r.used)]));
}

dbDescribe("the tenant's agent total on Postgres", () => {
  beforeAll(connectTestDatabase);
  afterAll(async () => {
    await dropTestTenants();
    await disconnectTestDatabase();
  });

  it("a consume that fails part-way counts neither the agent's spend nor the tenant's", async () => {
    const t = await createTestTenant();
    const tracker = new BudgetTracker(new PostgresBudgetStore());
    const period = tracker.getCurrentPeriod();
    // The tenant's total is at the column's limit (numeric(12,6)): adding to it fails in the
    // database — after the agent's own row was added to, if the two are separate writes.
    await t.run(() =>
      withTenantTx((tx) =>
        tx.query(
          `insert into agent_budgets (agent_id, scope_type, scope_id, period, used_usd, used_steps)
           values ($1, 'platform', null, $2, 999999.9, 0)`,
          [TENANT_TOTAL_AGENT, period]
        )
      )
    );
    await t.run(async () => {
      await expect(
        tracker.consume("agent:one", "user", "u1", 0.25, roomy)
      ).rejects.toMatchObject({ code: "22003" });
      const all = await totals();
      // The agent's spend is not counted without the tenant's.
      expect(all["agent:one"] ?? 0).toBe(0);
      expect(all[TENANT_TOTAL_AGENT]).toBeCloseTo(999999.9, 6);
    });
  });

  it("concurrent consumes across agents keep the tenant total equal to their sum", async () => {
    const t = await createTestTenant();
    const tracker = new BudgetTracker(new PostgresBudgetStore());
    await t.run(async () => {
      await Promise.all(
        Array.from({ length: 24 }, (_, i) =>
          tracker.consume(`agent:${i % 4}`, "user", `u${i % 4}`, 0.01, roomy)
        )
      );
      const all = await totals();
      expect(all[TENANT_TOTAL_AGENT]).toBeCloseTo(0.24, 9);
      for (let i = 0; i < 4; i++) expect(all[`agent:${i}`]).toBeCloseTo(0.06, 9);
      await expect(tracker.getTenantStatus()).resolves.toMatchObject({ usedUsd: 0.24 });
    });
  });

  it("refuses an agent id that is the tenant total's", async () => {
    const t = await createTestTenant();
    await expect(
      t.run(() =>
        withTenantTx((tx) =>
          tx.query(
            "select * from agent_budget_consume_with_tenant($1, 'platform', null, '2026-10-23', 1, 1)",
            [TENANT_TOTAL_AGENT]
          )
        )
      )
    ).rejects.toThrow(/invalid agent id/);
  });
});
