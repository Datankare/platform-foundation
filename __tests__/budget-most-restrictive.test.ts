/**
 * __tests__/budget-most-restrictive.test.ts
 *
 * ADR-029 D8: the effective ceiling is the MINIMUM across every applicable budget.
 *
 * Deliberately opposite to D3's max() on effectiveRisk. The conservative direction differs
 * by quantity — for risk, higher is safer; for spend, lower is — and taking the maximum
 * ceiling or the minimum risk would defeat both.
 */

import { mostRestrictiveCeiling } from "@/platform/action-pipeline";
import { invokeTool } from "@/platform/agents/tool-invoker";
import { InMemoryTrajectoryStore } from "@/platform/agents/trajectory-store";
import type { AgentIdentity, Tool } from "@/platform/kernel";

const actor: AgentIdentity = {
  actorType: "agent",
  actorId: "guardian",
  agentRole: "guardian",
};

function makeTool(): Tool {
  return {
    id: "charge",
    name: "Charge",
    description: "Costs money",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    effects: [],
    execute: async () => ({ ok: true }),
  };
}

describe("mostRestrictiveCeiling", () => {
  it("returns the lowest limit", () => {
    expect(
      mostRestrictiveCeiling([
        { limit: 1.0, label: "agent ceiling" },
        { limit: 0.01, label: "session ceiling" },
      ])
    ).toEqual({ limit: 0.01, label: "session ceiling" });
  });

  it("is order-independent", () => {
    const a = mostRestrictiveCeiling([
      { limit: 0.01, label: "session ceiling" },
      { limit: 1.0, label: "agent ceiling" },
    ]);
    expect(a?.limit).toBe(0.01);
  });

  it("returns undefined for no ceilings — unbounded, not zero", () => {
    // The distinction matters: treating an absent budget as a budget of nothing would
    // refuse every action rather than permitting them.
    expect(mostRestrictiveCeiling([])).toBeUndefined();
  });

  it("keeps a zero ceiling, which is a real limit", () => {
    expect(mostRestrictiveCeiling([{ limit: 0, label: "frozen" }])).toEqual({
      limit: 0,
      label: "frozen",
    });
  });
});

describe("D8 — a tool call is bound by the stricter of both budgets", () => {
  let store: InMemoryTrajectoryStore;
  let trajectoryId: string;

  beforeEach(async () => {
    store = new InMemoryTrajectoryStore();
    const rec = await store.create({ kind: "agent", id: "guardian" }, "run", "platform");
    trajectoryId = rec.trajectory.trajectoryId;
  });

  function call(extra: Record<string, unknown>) {
    return invokeTool({
      tool: makeTool(),
      input: {},
      actor,
      sessionId: "sess_1",
      trajectoryId,
      stepIndex: 0,
      trajectoryStore: store,
      ...extra,
    });
  }

  it("refuses on the session ceiling when it is the lower one", async () => {
    await expect(
      call({ cost: 0.5, budgetCeiling: 1.0, sessionCeiling: 0.01 })
    ).rejects.toThrow(/exceeds session ceiling 0.01/);
  });

  it("refuses on the agent ceiling when THAT is the lower one", async () => {
    await expect(
      call({ cost: 0.5, budgetCeiling: 0.01, sessionCeiling: 1.0 })
    ).rejects.toThrow(/exceeds agent ceiling 0.01/);
  });

  it("permits a cost under both", async () => {
    const res = await call({ cost: 0.005, budgetCeiling: 1.0, sessionCeiling: 0.01 });
    expect(res.output).toEqual({ ok: true });
  });

  it("a generous agent budget does not defeat a strict session one", async () => {
    // The whole point of taking the minimum. Under max() this would be permitted.
    await expect(
      call({ cost: 0.9, budgetCeiling: 100, sessionCeiling: 0.5 })
    ).rejects.toThrow(/session ceiling/);
  });

  it("is unbounded when neither ceiling is supplied", async () => {
    const res = await call({ cost: 999 });
    expect(res.output).toEqual({ ok: true });
  });

  it("applies a single ceiling when only one is supplied", async () => {
    await expect(call({ cost: 0.5, sessionCeiling: 0.01 })).rejects.toThrow(
      /session ceiling/
    );
    await expect(call({ cost: 0.5, budgetCeiling: 0.01 })).rejects.toThrow(
      /agent ceiling/
    );
  });
});
