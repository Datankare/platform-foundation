/**
 * __tests__/contract/tool-invocation-contract.ts
 * Tool invocation conformance kit — ADR-029 D2/D3. Not a *.test.ts.
 *
 * Registered as a FABRIC entry, not a registry slot: ADR-029 D9 decided tool execution is
 * in-process, so there is nothing to swap and no provider slot to add.
 *
 * The arms that matter are the ones proving the tool path is NOT a second pipeline: a
 * restricted tool must be gated by the same threshold that gates a restricted session
 * action, and an over-budget tool call must be refused by the same ceiling check.
 */

import { invokeTool } from "@/platform/agents/tool-invoker";
import { SchemaValidationError } from "@/platform/agents/schema";
import { InMemoryTrajectoryStore } from "@/platform/agents/trajectory-store";
import type { Tool, AgentIdentity } from "@/platform/kernel";

const actor: AgentIdentity = {
  actorType: "agent",
  actorId: "guardian",
  agentRole: "guardian",
};

function makeTool(overrides: Partial<Tool> = {}): Tool {
  return {
    id: "echo",
    name: "Echo",
    description: "Returns its input",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    outputSchema: {
      type: "object",
      properties: { echoed: { type: "string" } },
      required: ["echoed"],
    },
    effects: [],
    execute: async (input) => ({ echoed: String(input.text) }),
    ...overrides,
  };
}

export interface ToolInvocationContractFixtures {
  readonly makeTrajectoryStore: () => InMemoryTrajectoryStore;
}

export function runToolInvocationContract(fx: ToolInvocationContractFixtures): void {
  let store: InMemoryTrajectoryStore;
  let trajectoryId: string;

  beforeEach(async () => {
    store = fx.makeTrajectoryStore();
    const rec = await store.create({ kind: "agent", id: "guardian" }, "t", "platform");
    trajectoryId = rec.trajectory.trajectoryId;
  });

  function call(tool: Tool, input: Record<string, unknown>, extra = {}) {
    return invokeTool({
      tool,
      input,
      actor,
      sessionId: "sess_1",
      trajectoryId,
      stepIndex: 0,
      trajectoryStore: store,
      ...extra,
    });
  }

  describe("D3 — schemas enforced at both edges", () => {
    it("rejects input that fails its schema, before anything else runs", async () => {
      await expect(call(makeTool(), { wrong: 1 })).rejects.toBeInstanceOf(
        SchemaValidationError
      );
      // Nothing recorded: a malformed call must not occupy a trajectory step.
      const rec = await store.getById(trajectoryId);
      expect(rec?.trajectory.steps).toHaveLength(0);
    });

    it("accepts valid input and returns validated output", async () => {
      const res = await call(makeTool(), { text: "hi" });
      expect(res.output).toEqual({ echoed: "hi" });
      expect(res.attempts).toBe(1);
    });

    it("retries invalid output rather than coercing it", async () => {
      let n = 0;
      const flaky = makeTool({
        execute: async (input) => {
          n += 1;
          return n < 2 ? { wrong: true } : { echoed: String(input.text) };
        },
      });
      const res = await call(flaky, { text: "hi" });
      expect(res.attempts).toBe(2);
      expect(res.output).toEqual({ echoed: "hi" });
    });

    it("fails the step when output never validates", async () => {
      const broken = makeTool({ execute: async () => ({ wrong: true }) });
      await expect(call(broken, { text: "hi" })).rejects.toBeInstanceOf(
        SchemaValidationError
      );
    });

    it("never coerces — a failing tool does not report success", async () => {
      const broken = makeTool({ execute: async () => ({ wrong: true }) });
      await expect(call(broken, { text: "hi" })).rejects.toThrow(/failed its schema/);
    });
  });

  describe("D2 — the same pipeline that governs session actions", () => {
    it("appends exactly one trajectory step carrying the operationId (invariant 1)", async () => {
      const res = await call(makeTool(), { text: "hi" });
      const rec = await store.getById(trajectoryId);
      expect(rec?.trajectory.steps).toHaveLength(1);
      expect(rec?.trajectory.steps[0].operationId).toBe(res.operationId);
      expect(rec?.trajectory.steps[0].action).toBe("echo");
    });

    it("carries the justification record into the step (ADR-031 D9)", async () => {
      await call(makeTool({ effects: ["externalCall"], declaredRisk: "consequential" }), {
        text: "hi",
      });
      const rec = await store.getById(trajectoryId);
      const step = rec?.trajectory.steps[0];
      expect(step?.effects).toEqual(["externalCall"]);
      expect(step?.effectiveRisk).toBe("consequential");
      expect(step?.actor?.actorId).toBe("guardian");
    });

    it("gates a restricted tool on the same threshold as a restricted action", async () => {
      const restricted = makeTool({ effects: ["restricted"] });
      await expect(call(restricted, { text: "hi" })).rejects.toThrow(/requires approval/);
      const rec = await store.getById(trajectoryId);
      expect(rec?.trajectory.steps).toHaveLength(0);
    });

    it("refuses an over-budget call and names the agent ceiling", async () => {
      await expect(
        call(makeTool(), { text: "hi" }, { cost: 0.5, budgetCeiling: 0.01 })
      ).rejects.toThrow(/exceeds agent ceiling/);
    });

    it("accepts a caller-supplied operationId (ADR-031 D1)", async () => {
      const res = await call(makeTool(), { text: "hi" }, { operationId: "op_fixed" });
      expect(res.operationId).toBe("op_fixed");
      const rec = await store.getById(trajectoryId);
      expect(rec?.trajectory.steps[0].operationId).toBe("op_fixed");
    });
  });
}
