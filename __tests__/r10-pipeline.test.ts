/**
 * @jest-environment node
 */
/**
 * __tests__/r10-pipeline.test.ts — Nothing applied is reported as nothing stored; a failed run
 * keeps its approval; a trajectory is bounded; depth is measured as stored
 * (review 10 H2, M5, L9, L10)
 *
 *   M5  The stored-JSON limits were checked after the action's effect: a tool did its work, then
 *       its step was refused, and the caller was told nothing was stored. Now a tool output too
 *       large to keep is recorded as such (the step says the output was not kept) — checked
 *       before its declared effects fire; a next state the store would refuse stops the call
 *       before the effect; a failure after the effect says "applied, record not stored" and is
 *       audited.
 *   H2  An approved run that fails before taking effect releases its claim (executing ->
 *       approved); one that took effect completes it (executed).
 *   L9  jsonDepth's visited set undercounted a sub-object shared at two depths.
 *   L10 A trajectory's steps grew without bound: a full one refuses the next action before it
 *       runs (request.trajectory_full).
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req",
}));
const audits: Record<string, unknown>[] = [];
jest.mock("@/platform/auth/audit", () => ({
  writeAuditLog: async (entry: Record<string, unknown>) => {
    audits.push(entry);
  },
  // The adapter writes its records of a run's outcome outside the run's transaction (review 11).
  writeAuditLogOutsideTransaction: async (entry: Record<string, unknown>) => {
    audits.push(entry);
  },
}));

import { invokeTool } from "@/platform/agents/tool-invoker";
import { InMemoryTrajectoryStore } from "@/platform/agents/trajectory-store";
import { InMemoryProposalStore } from "@/platform/agents/proposal-store";
import { InMemoryActivityStateStore } from "@/platform/app-framework/memory-state-store";
import {
  ActionNotRecordedError,
  ApprovedRunFailedError,
  executeActionPipeline,
} from "@/platform/action-pipeline";
import {
  assertStorableJson,
  isJsonLimitError,
  jsonDepth,
  STORED_JSON_MAX_BYTES,
  STORED_JSON_MAX_DEPTH,
  storedJsonViolation,
  TRAJECTORY_MAX_STEPS,
} from "@/platform/errors/json-limits";
import type { AgentIdentity, Step, Tool } from "@/platform/kernel";

const actor: AgentIdentity = { actorType: "agent", actorId: "agent:a1", agentRole: "a" };

function tool(overrides: Partial<Tool> = {}): Tool {
  return {
    id: "big",
    name: "big",
    description: "",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    effects: ["stateWrite"],
    declaredRisk: "ordinary",
    execute: async () => ({ ok: true }),
    ...overrides,
  };
}

let trajectories: InMemoryTrajectoryStore;
let trajectoryId: string;
beforeEach(async () => {
  audits.length = 0;
  trajectories = new InMemoryTrajectoryStore();
  trajectoryId = (await trajectories.create({ kind: "agent", id: "a1" }, "t", "platform"))
    .trajectory.trajectoryId;
});

const call = (t: Tool, extra: Record<string, unknown> = {}) =>
  invokeTool({
    tool: t,
    input: {},
    actor,
    sessionId: "s",
    trajectoryId,
    stepIndex: 0,
    trajectoryStore: trajectories,
    ...extra,
  });

describe("r10 M5: the limit is met before the effect, and a failure after it is told truthfully", () => {
  it("the reviewer's case: the tool's work is done and its oversized output is recorded as not kept — never 'nothing was stored'", async () => {
    const sideEffects: string[] = [];
    const res = await call(
      tool({
        execute: async () => {
          sideEffects.push("written");
          return { blob: "x".repeat(1_100_000) };
        },
      })
    );
    expect(sideEffects).toEqual(["written"]);
    // The caller has the whole output.
    expect((res.output.blob as string).length).toBe(1_100_000);
    // The step is stored, and says the output was too large to keep.
    const steps = (await trajectories.getById(trajectoryId))!.trajectory.steps;
    expect(steps).toHaveLength(1);
    expect(steps[0].output).toMatchObject({
      outputNotRecorded: { code: "request.json_too_large", max: STORED_JSON_MAX_BYTES },
    });
    expect(JSON.stringify(steps[0]).length).toBeLessThan(10_000);
  });

  it("an output too large is found before the declared external effect fires — and the effect fires once, recorded", async () => {
    const order: string[] = [];
    await call(
      tool({
        effects: ["externalCall"],
        execute: async () => {
          order.push("execute");
          return { blob: "y".repeat(1_100_000) };
        },
        externalEffects: [
          {
            key: "send",
            type: "externalCall",
            call: async () => {
              order.push("effect");
              return { sent: true };
            },
          },
        ],
      })
    );
    expect(order).toEqual(["execute", "effect"]);
    const steps = (await trajectories.getById(trajectoryId))!.trajectory.steps;
    expect(steps[0].output).toHaveProperty("outputNotRecorded");
  });

  it("a next state the store would refuse stops the call before its external effect fires", async () => {
    const fired: string[] = [];
    const stateStore = new InMemoryActivityStateStore<unknown>();
    await stateStore.create("s", { v: 0 });
    (stateStore as unknown as { validate: (s: unknown) => void }).validate = (s) =>
      assertStorableJson(s, "app_sessions.state");
    let deep: unknown = "leaf";
    for (let i = 0; i < STORED_JSON_MAX_DEPTH + 5; i++) deep = [deep];
    await expect(
      call(
        tool({
          effects: ["externalCall"],
          externalEffects: [
            {
              key: "send",
              type: "externalCall",
              call: async () => {
                fired.push("effect");
                return {};
              },
            },
          ],
        }),
        {
          stateStore,
          expectedVersion: 1,
          computeNextState: () => ({ deep }),
        }
      )
    ).rejects.toMatchObject({ code: "request.json_too_deep" });
    expect(fired).toEqual([]);
    expect((await stateStore.load("s"))?.version).toBe(1);
    expect((await trajectories.getById(trajectoryId))!.trajectory.steps).toEqual([]);
  });

  it("a session action's next state is checked before anything: refused, nothing committed", async () => {
    const stateStore = new InMemoryActivityStateStore<unknown>();
    await stateStore.create("s", { v: 0 });
    (stateStore as unknown as { validate: (s: unknown) => void }).validate = (s) =>
      assertStorableJson(s, "app_sessions.state");
    await expect(
      executeActionPipeline({
        spec: {
          type: "set",
          effects: ["stateWrite"],
          ephemeral: false,
          commutative: false,
        },
        actor,
        sessionId: "s",
        label: "set",
        cost: 0,
        boundary: "commitment",
        stateStore,
        trajectoryStore: trajectories,
        trajectoryId,
        stepIndex: 0,
        expectedVersion: 1,
        computeNextState: () => ({ blob: "z".repeat(STORED_JSON_MAX_BYTES + 1) }),
      })
    ).rejects.toMatchObject({ code: "request.json_too_large" });
    expect((await stateStore.load("s"))?.state).toEqual({ v: 0 });
  });

  it("a record that cannot be stored after the effect: 'applied, record not stored', and audited", async () => {
    const failing = new InMemoryTrajectoryStore();
    const id = (await failing.create({ kind: "agent", id: "a1" }, "t", "platform"))
      .trajectory.trajectoryId;
    jest.spyOn(failing, "addStep").mockRejectedValue(new Error("db down"));
    const done: string[] = [];
    const err = await invokeTool({
      tool: tool({
        execute: async () => {
          done.push("work");
          return { ok: true };
        },
      }),
      input: {},
      actor,
      sessionId: "s",
      trajectoryId: id,
      stepIndex: 0,
      trajectoryStore: failing,
    }).catch((e: unknown) => e);
    expect(done).toEqual(["work"]);
    expect(err).toBeInstanceOf(ActionNotRecordedError);
    expect(err).toMatchObject({ applied: true });
    expect((err as Error).message).toMatch(/applied, but its record could not be stored/);
    expect(audits).toEqual([
      expect.objectContaining({
        details: expect.objectContaining({
          type: "action_applied_not_recorded",
          tool: "big",
          reason: "db down",
        }),
      }),
    ]);
  });
});

describe("r10 H2: an approved run claims its approval and ends the claim", () => {
  async function approvedHold(store: InMemoryProposalStore, input = {}) {
    const p = await store.create({
      operationId: "op_h",
      sessionId: "s",
      trajectoryId,
      label: "held",
      actor,
      effects: ["stateWrite"],
      effectiveRisk: "restricted",
      payload: input,
    });
    await store.decide(p.proposalId, "approved", "approver");
    return p.proposalId;
  }
  const held = (execute: Tool["execute"], extra: Partial<Tool> = {}) =>
    tool({ id: "held", declaredRisk: "restricted", execute, ...extra });
  const runApproved = (store: InMemoryProposalStore, id: string, t: Tool) =>
    call(t, { proposalStore: store, approvedProposalId: id, operationId: "op_h" });

  it("a run that throws releases the approval (approved, with why); the retry runs and uses it", async () => {
    const store = new InMemoryProposalStore();
    const id = await approvedHold(store);
    let n = 0;
    const t = held(async () => {
      n += 1;
      if (n === 1) throw new Error("transient");
      return { ok: true };
    });
    const err = await runApproved(store, id, t).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApprovedRunFailedError);
    expect(err).toMatchObject({ released: true, reason: "transient" });
    expect(await store.getById(id)).toMatchObject({
      status: "approved",
      lastRunError: expect.stringContaining("transient"),
    });
    await runApproved(store, id, t);
    expect((await store.getById(id))?.status).toBe("executed");
    expect(n).toBe(2);
  });

  it("a run whose result reports failure releases the approval too", async () => {
    const store = new InMemoryProposalStore();
    const id = await approvedHold(store);
    const t = held(async () => ({ success: false, error: "nope" }), {
      reportsFailure: (o) => (o.success === false ? String(o.error) : undefined),
    });
    await expect(runApproved(store, id, t)).rejects.toBeInstanceOf(
      ApprovedRunFailedError
    );
    expect((await store.getById(id))?.status).toBe("approved");
  });

  it("concurrent runs of one approval: one runs, the others are refused (approval-used)", async () => {
    const store = new InMemoryProposalStore();
    const id = await approvedHold(store);
    let runs = 0;
    const t = held(async () => {
      runs += 1;
      await new Promise((r) => setTimeout(r, 5));
      return { ok: true };
    });
    const results = await Promise.allSettled([
      runApproved(store, id, t),
      runApproved(store, id, t),
      runApproved(store, id, t),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(runs).toBe(1);
    expect((await store.getById(id))?.status).toBe("executed");
  });

  it("an applied run whose record cannot be stored uses the approval (never runs twice)", async () => {
    const store = new InMemoryProposalStore();
    const id = await approvedHold(store);
    jest.spyOn(trajectories, "addStep").mockRejectedValueOnce(new Error("db down"));
    await expect(
      runApproved(
        store,
        id,
        held(async () => ({ ok: 1 }))
      )
    ).rejects.toBeInstanceOf(ActionNotRecordedError);
    expect((await store.getById(id))?.status).toBe("executed");
  });

  it("atomic: with a store that has transactions, the claim, the run and the completion are one unit", async () => {
    const store = new InMemoryProposalStore();
    const units: string[] = [];
    (
      store as unknown as { atomically: <T>(fn: () => Promise<T>) => Promise<T> }
    ).atomically = async (fn) => {
      units.push("begin");
      try {
        const r = await fn();
        units.push("commit");
        return r;
      } catch (e) {
        units.push("rollback");
        throw e;
      }
    };
    const id = await approvedHold(store);
    await runApproved(
      store,
      id,
      held(async () => ({ ok: 1 }), { atomic: true })
    );
    expect(units).toEqual(["begin", "commit"]);
    expect((await store.getById(id))?.status).toBe("executed");
    // An atomic tool cannot have external effects.
    await expect(
      call(
        tool({
          atomic: true,
          effects: ["externalCall"],
          externalEffects: [{ key: "k", type: "externalCall", call: async () => ({}) }],
        })
      )
    ).rejects.toThrow(/atomic and has external effects/);
  });
});

describe("r10 L9: depth as JSON.stringify writes it", () => {
  const stored = (v: unknown) => {
    let m = 0;
    let c = 0;
    for (const ch of JSON.stringify(v)) {
      if (ch === "[" || ch === "{") m = Math.max(m, ++c);
      else if (ch === "]" || ch === "}") c--;
    }
    return m;
  };

  it("the reviewer's case: a sub-object met shallow first is still counted at its stored depth", () => {
    let x: unknown = "leaf";
    for (let i = 0; i < 60; i++) x = [x];
    let deep: unknown = x;
    for (let i = 0; i < 60; i++) deep = { d: deep };
    const doc = [deep, x];
    expect(jsonDepth(doc)).toBe(stored(doc));
    expect(stored(doc)).toBeGreaterThan(100);
    expect(storedJsonViolation(doc)).toEqual({
      code: "request.json_too_deep",
      max: STORED_JSON_MAX_DEPTH,
    });
  });

  it("shared sub-objects in any order, and a diamond, measure as stored", () => {
    const leaf = { a: [1, [2, [3]]] };
    const mid = [leaf, { b: leaf }];
    for (const doc of [
      { p: mid, q: [[[mid]]] },
      [[[[leaf]]], leaf],
      [leaf, [[[[leaf]]]]],
    ]) {
      expect(jsonDepth(doc)).toBe(stored(doc));
    }
  });

  it("a cycle is infinitely deep (it cannot be stored) — refused with the coded error", () => {
    const a: Record<string, unknown> = { x: 1 };
    a.self = { back: a };
    expect(jsonDepth(a)).toBe(Number.POSITIVE_INFINITY);
    expect(storedJsonViolation(a)).toMatchObject({ code: "request.json_too_deep" });
  });

  it("a small graph of shared sub-objects that expands past the byte limit is refused without being written out", () => {
    let x: unknown = "x";
    for (let i = 0; i < 40; i++) x = [x, x]; // 2^40 values as text
    expect(jsonDepth(x)).toBe(40);
    expect(storedJsonViolation(x)).toEqual({
      code: "request.json_too_large",
      max: STORED_JSON_MAX_BYTES,
    });
  });
});

describe("r10 L10: a trajectory is bounded, refused before the action runs", () => {
  const step = (i: number, out: Record<string, unknown> = {}): Step => ({
    stepIndex: i,
    action: "a",
    input: {},
    output: out,
    cost: 0,
    durationMs: 0,
    timestamp: new Date(0).toISOString(),
    boundary: "commitment",
  });

  it(`at ${TRAJECTORY_MAX_STEPS} steps the next action is refused (request.trajectory_full) and never runs`, async () => {
    for (let i = 0; i < TRAJECTORY_MAX_STEPS; i++)
      await trajectories.addStep(trajectoryId, step(i));
    let ran = false;
    const err = await call(
      tool({
        execute: async () => {
          ran = true;
          return {};
        },
      })
    ).catch((e: unknown) => e);
    expect(isJsonLimitError(err)).toBe(true);
    expect(err).toMatchObject({
      code: "request.trajectory_full",
      params: { max: TRAJECTORY_MAX_STEPS },
    });
    expect(ran).toBe(false);
    await expect(trajectories.addStep(trajectoryId, step(9999))).rejects.toMatchObject({
      code: "request.trajectory_full",
    });
  });

  it("past 16 MiB of steps (with room for no more largest step) the next action is refused", async () => {
    const big = "b".repeat(1_000_000);
    for (let i = 0; i < 16; i++)
      await trajectories.addStep(trajectoryId, step(i, { big }));
    let ran = false;
    await expect(
      call(
        tool({
          execute: async () => {
            ran = true;
            return {};
          },
        })
      )
    ).rejects.toMatchObject({ code: "request.trajectory_full" });
    expect(ran).toBe(false);
  });
});
