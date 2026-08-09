/**
 * __tests__/tool-external-effects.test.ts
 *
 * ADR-031 D7 as a contract rather than a convention: a tool declares its external effects
 * and the platform routes them through the ledger.
 */

import {
  invokeTool,
  UndeclaredExternalEffectError,
} from "@/platform/agents/tool-invoker";
import { InMemoryEffectLedger } from "@/platform/agents/effect-ledger";
import { InMemoryTrajectoryStore } from "@/platform/agents/trajectory-store";
import type { AgentIdentity, Tool } from "@/platform/kernel";

const actor: AgentIdentity = {
  actorType: "agent",
  actorId: "payer",
  agentRole: "payer",
};

function makeTool(overrides: Partial<Tool> = {}): Tool {
  return {
    id: "charge",
    name: "Charge",
    description: "Charges a card",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    effects: [],
    execute: async () => ({ ok: true }),
    ...overrides,
  };
}

describe("D7 — an undeclared external effect is refused", () => {
  let store: InMemoryTrajectoryStore;
  let trajectoryId: string;

  beforeEach(async () => {
    store = new InMemoryTrajectoryStore();
    const rec = await store.create({ kind: "agent", id: "payer" }, "run", "platform");
    trajectoryId = rec.trajectory.trajectoryId;
  });

  function call(tool: Tool, extra: Record<string, unknown> = {}) {
    return invokeTool({
      tool,
      input: {},
      actor,
      sessionId: "sess_1",
      trajectoryId,
      stepIndex: 0,
      trajectoryStore: store,
      ...extra,
    });
  }

  it("refuses a tool declaring externalCall with no externalEffects", async () => {
    await expect(call(makeTool({ effects: ["externalCall"] }))).rejects.toBeInstanceOf(
      UndeclaredExternalEffectError
    );
  });

  it("refuses a tool declaring sendMessage with no externalEffects", async () => {
    await expect(call(makeTool({ effects: ["sendMessage"] }))).rejects.toThrow(
      /no externalEffects/
    );
  });

  it("refuses before anything runs — no trajectory step, no execute", async () => {
    let executed = false;
    await expect(
      call(
        makeTool({
          effects: ["externalCall"],
          execute: async () => {
            executed = true;
            return {};
          },
        })
      )
    ).rejects.toBeInstanceOf(UndeclaredExternalEffectError);

    expect(executed).toBe(false);
    const rec = await store.getById(trajectoryId);
    expect(rec?.trajectory.steps).toHaveLength(0);
  });

  it("permits a tool with no external effects at all", async () => {
    const res = await call(makeTool());
    expect(res.output).toEqual({ ok: true });
    expect(res.effects).toEqual([]);
  });
});

describe("D7 — declared effects fire through the ledger", () => {
  let store: InMemoryTrajectoryStore;
  let ledger: InMemoryEffectLedger;
  let trajectoryId: string;

  beforeEach(async () => {
    store = new InMemoryTrajectoryStore();
    ledger = new InMemoryEffectLedger();
    const rec = await store.create({ kind: "agent", id: "payer" }, "run", "platform");
    trajectoryId = rec.trajectory.trajectoryId;
  });

  function call(tool: Tool, extra: Record<string, unknown> = {}) {
    return invokeTool({
      tool,
      input: { amount: 10 },
      actor,
      sessionId: "sess_1",
      trajectoryId,
      stepIndex: 0,
      trajectoryStore: store,
      effectLedger: ledger,
      operationId: "op_1",
      ...extra,
    });
  }

  function chargingTool(calls: string[]): Tool {
    return makeTool({
      effects: ["externalCall"],
      externalEffects: [
        {
          key: "charge",
          type: "externalCall",
          call: async (input, idempotencyKey) => {
            calls.push(idempotencyKey);
            return { chargeId: "ch_1", amount: input.amount };
          },
        },
      ],
    });
  }

  it("writes a ledger entry and resolves it", async () => {
    const calls: string[] = [];
    const res = await call(chargingTool(calls));

    expect(res.effects).toHaveLength(1);
    expect(res.effects[0].status).toBe("confirmed");
    const entry = await ledger.get("op_1", "charge");
    expect(entry?.status).toBe("confirmed");
  });

  it("hands the downstream an idempotency key derived from the operation", async () => {
    const calls: string[] = [];
    await call(chargingTool(calls));
    expect(calls[0]).toContain("op_1");
    expect(calls[0]).toContain("charge");
  });

  it("does not re-fire on a retry of the same operation", async () => {
    const calls: string[] = [];
    const tool = chargingTool(calls);
    await call(tool);
    const second = await call(tool);

    expect(calls).toHaveLength(1);
    expect(second.effects[0].status).toBe("confirmed");
  });

  it("keeps two effects in one invocation separate", async () => {
    const fired: string[] = [];
    const tool = makeTool({
      effects: ["externalCall", "sendMessage"],
      externalEffects: [
        {
          key: "charge",
          type: "externalCall",
          call: async () => {
            fired.push("charge");
            return { id: "ch_1" };
          },
        },
        {
          key: "receipt",
          type: "sendMessage",
          call: async () => {
            fired.push("receipt");
            return { id: "msg_1" };
          },
        },
      ],
    });

    const res = await call(tool);

    // Two effects, two ledger entries — not deduped into one by sharing an operationId.
    expect(fired).toEqual(["charge", "receipt"]);
    expect(res.effects).toHaveLength(2);
    expect(await ledger.get("op_1", "charge")).toBeDefined();
    expect(await ledger.get("op_1", "receipt")).toBeDefined();
  });

  it("does not fire when the tool's output fails its schema", async () => {
    // Firing first would leave a charge behind a failed invocation, and the retry loop
    // would fire it again.
    const fired: string[] = [];
    const tool = makeTool({
      effects: ["externalCall"],
      outputSchema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
      },
      execute: async () => ({ wrong: true }),
      externalEffects: [
        {
          key: "charge",
          type: "externalCall",
          call: async () => {
            fired.push("charge");
            return {};
          },
        },
      ],
    });

    await expect(call(tool)).rejects.toThrow(/failed its schema/);
    expect(fired).toHaveLength(0);
    expect(await ledger.get("op_1", "charge")).toBeUndefined();
  });

  it("reports an indeterminate effect and leaves the ledger row unresolved", async () => {
    const tool = makeTool({
      effects: ["externalCall"],
      externalEffects: [
        {
          key: "charge",
          type: "externalCall",
          call: async () => {
            throw new Error("socket timeout after send");
          },
        },
      ],
    });

    const res = await call(tool);

    expect(res.effects[0].status).toBe("indeterminate");
    // Unresolved for the D10 check: executeAgent reports the workflow indeterminate.
    const unresolved = await ledger.listUnresolved();
    expect(unresolved.map((e) => e.effectKey)).toContain("charge");
  });

  it("mints one operationId shared by the step and its effects", async () => {
    const calls: string[] = [];
    const res = await invokeTool({
      tool: chargingTool(calls),
      input: { amount: 10 },
      actor,
      sessionId: "sess_1",
      trajectoryId,
      stepIndex: 0,
      trajectoryStore: store,
      effectLedger: ledger,
    });

    // No operationId supplied: the one minted for the ledger must be the one the trajectory
    // step carries, or the effect and its audit record refer to different actions.
    expect(calls[0]).toContain(res.operationId);
    const rec = await store.getById(trajectoryId);
    expect(rec?.trajectory.steps[0].operationId).toBe(res.operationId);
  });
});
