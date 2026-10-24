/**
 * @jest-environment node
 */
/**
 * platform/agents/__tests__/runtime-tenant.test.ts — an agent run belongs to one tenant
 * (ADR-053 D3)
 */

import { executeAgent, type StepOutcome, type WorkflowContext } from "../runtime";
import { registerAgent, resetAgentRegistry } from "../registry";
import { InMemoryTrajectoryStore } from "../trajectory-store";
import { BudgetTracker } from "../budget-tracker";
import { DEFAULT_BUDGET_CONFIG } from "../types";
import { runWithTenant } from "@/platform/tenancy/context";

const A = "11111111-1111-4111-8111-111111111111";

const step = (more: boolean): StepOutcome => ({
  action: "s",
  boundary: "cognition",
  input: {},
  output: {},
  costUsd: 0,
  continueExecution: more,
});

beforeEach(() => {
  resetAgentRegistry();
  registerAgent({
    id: "tenant-agent",
    name: "Tenant Agent",
    description: "t",
    tools: [],
    budgetConfig: DEFAULT_BUDGET_CONFIG,
  });
});

it("hands every step the run's tenant", async () => {
  const seen: (string | undefined)[] = [];
  let n = 0;
  const result = await runWithTenant({ tenantId: A, mode: "shared" }, () =>
    executeAgent(
      "tenant-agent",
      "test",
      "platform",
      undefined,
      async (ctx: WorkflowContext) => {
        seen.push(ctx.tenantId);
        return step(++n < 3);
      },
      new InMemoryTrajectoryStore(),
      new BudgetTracker()
    )
  );
  expect(result.success).toBe(true);
  expect(seen).toEqual([A, A, A]);
});
