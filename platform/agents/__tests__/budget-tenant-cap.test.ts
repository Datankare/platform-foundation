/**
 * @jest-environment node
 */
/**
 * platform/agents/__tests__/budget-tenant-cap.test.ts — each tenant's cap on all its agents
 * together (ADR-053 D6), above the per-agent caps
 */

const caps: Record<string, unknown> = {};
jest.mock("@/platform/auth/platform-config", () => ({
  getConfig: jest.fn(async (key: string, dflt: unknown) =>
    key in caps ? caps[key] : dflt
  ),
}));

import {
  BudgetTracker,
  InMemoryBudgetStore,
  TENANT_TOTAL_AGENT,
} from "../budget-tracker";
import {
  DEFAULT_TENANT_DAILY_COST_CAP,
  TENANT_COST_CAP_KEY,
  resolveTenantDailyCostCap,
} from "../budget-config";
import { runWithTenant } from "@/platform/tenancy/context";
import { DEFAULT_BUDGET_CONFIG } from "../types";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const inA = <T>(fn: () => T) => runWithTenant({ tenantId: A, mode: "shared" }, fn);
const inB = <T>(fn: () => T) => runWithTenant({ tenantId: B, mode: "shared" }, fn);
const roomy = { ...DEFAULT_BUDGET_CONFIG, maxCostPerDay: 100 };

beforeEach(() => {
  for (const k of Object.keys(caps)) delete caps[k];
});

it("one tenant's agents together stop at the tenant's cap; another tenant is untouched", async () => {
  caps[TENANT_COST_CAP_KEY] = 1;
  const tracker = new BudgetTracker(new InMemoryBudgetStore());
  await inA(() => tracker.consume("agent:one", "user", "u1", 0.6, roomy));
  await inA(() => tracker.consume("agent:two", "user", "u2", 0.5, roomy));
  // A third agent in A, with its own budget untouched, is refused by the tenant cap.
  const third = await inA(() => tracker.checkBudget("agent:three", "user", "u3", roomy));
  expect(third.allowed).toBe(false);
  expect(third.reason).toMatch(/Tenant daily budget exhausted/);
  expect(third.status.tenantId).toBe(A);
  // B has spent nothing.
  await expect(
    inB(() => tracker.checkBudget("agent:one", "user", "u1", roomy))
  ).resolves.toMatchObject({
    allowed: true,
  });
  await expect(inA(() => tracker.getTenantStatus())).resolves.toMatchObject({
    tenantId: A,
    usedUsd: 1.1,
    budgetUsd: 1,
    exhausted: true,
  });
  await expect(inB(() => tracker.getTenantStatus())).resolves.toMatchObject({
    usedUsd: 0,
  });
});

it("the agent's own cap still applies first", async () => {
  const tracker = new BudgetTracker(new InMemoryBudgetStore());
  await inA(() =>
    tracker.consume("agent:one", "user", "u1", 2, { ...roomy, maxCostPerDay: 1 })
  );
  const r = await inA(() =>
    tracker.checkBudget("agent:one", "user", "u1", { ...roomy, maxCostPerDay: 1 })
  );
  expect(r.reason).toMatch(/^Daily budget exhausted/);
});

it("the tenant total is a reserved scope no agent id collides with", () => {
  expect(TENANT_TOTAL_AGENT).toBe("*tenant*");
});

it.each([
  ["unset", undefined],
  ["zero", 0],
  ["negative", -5],
  ["not a number", "lots"],
])("an %s cap falls back to the seeded default, never unlimited", async (_l, value) => {
  if (value !== undefined) caps[TENANT_COST_CAP_KEY] = value;
  await expect(resolveTenantDailyCostCap()).resolves.toBe(DEFAULT_TENANT_DAILY_COST_CAP);
});

it("a config that cannot be read falls back to the default", async () => {
  const { getConfig } = jest.requireMock("@/platform/auth/platform-config") as {
    getConfig: jest.Mock;
  };
  getConfig.mockRejectedValueOnce(new Error("down"));
  await expect(resolveTenantDailyCostCap()).resolves.toBe(DEFAULT_TENANT_DAILY_COST_CAP);
});
