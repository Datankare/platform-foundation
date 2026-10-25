/**
 * @jest-environment node
 */
/**
 * __tests__/rv11-hostile.test.ts — Review 11's proofs, asserting the fixed behaviour
 *
 * Ported from the reviewer's review11/__tests__/rv11-hostile.test.ts (each proof showed the
 * fault; each case here shows it fixed). The Postgres variants are in
 * __tests__/db/rv11-runs-and-chains.db.test.ts.
 *
 *   H-1  A run slower than its 10-minute lease: the recovery job gave its approval back, the run's
 *        completion lost its compare-and-set silently, and the approval ran a second time. Now
 *        each claim has a token; the recovery marks the run undecided (never approved again); the
 *        run's completion by its token lands; a completion that cannot land is raised, audited
 *        and alerted; nothing claims an approval while a run holds it.
 *   H-2  An app session could not take its 1 001st move. A full trajectory is now continued in a
 *        linked one, with the move; the chain reads as one; an agent run opts in, any other
 *        growth path is still refused with the coded error.
 *   M-1  An approved run whose own work had run, then failed after it, was released as "not
 *        applied" and ran its work again. Any failure after the work is "applied".
 *   L-1  A shared large string counted as one value: 1.2 GB was written out to be measured.
 *   L-3  One oversized row hid every row after it in the command bar's search.
 *   L-4  The in-memory trajectory store forgot its byte count on a status change.
 */

const audits: Record<string, unknown>[] = [];
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req",
}));
jest.mock("@/platform/auth/audit", () => ({
  writeAuditLog: async (entry: Record<string, unknown>) => {
    audits.push(entry);
  },
  writeAuditLogOutsideTransaction: async (entry: Record<string, unknown>) => {
    audits.push(entry);
  },
}));

import { invokeTool } from "@/platform/agents/tool-invoker";
import {
  chainSteps,
  InMemoryTrajectoryStore,
  latestTrajectorySegment,
  readTrajectoryChain,
  setTrajectoryStore,
} from "@/platform/agents/trajectory-store";
import { InMemoryProposalStore } from "@/platform/agents/proposal-store";
import { InMemoryActivityStateStore } from "@/platform/app-framework/memory-state-store";
import {
  ActionNotRecordedError,
  PipelineRejectedError,
} from "@/platform/action-pipeline";
import {
  assertStorableJson,
  jsonDepth,
  STORED_JSON_MAX_BYTES,
  storedJsonViolation,
  TRAJECTORY_MAX_STEPS,
} from "@/platform/errors/json-limits";
import { searchResultText } from "@/app/api/admin/ai/handlers/search";
import { createSession, dispatch, loadSession } from "@/platform/app-framework/session";
import { resetActivityStateStore } from "@/platform/app-framework";
import type { AgentIdentity, Step, Tool } from "@/platform/kernel";

const actor: AgentIdentity = { actorType: "agent", actorId: "agent:a1", agentRole: "a" };

function heldTool(execute: Tool["execute"], overrides: Partial<Tool> = {}): Tool {
  return {
    id: "held",
    name: "held",
    description: "",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    effects: ["stateWrite"],
    declaredRisk: "restricted",
    execute,
    ...overrides,
  };
}

async function approvedRun(op: string) {
  const trajectories = new InMemoryTrajectoryStore();
  const trajectoryId = (
    await trajectories.create({ kind: "agent", id: "a1" }, "t", "platform")
  ).trajectory.trajectoryId;
  const store = new InMemoryProposalStore();
  const p = await store.create({
    operationId: op,
    sessionId: "s",
    trajectoryId,
    label: "held",
    actor,
    effects: ["stateWrite"],
    effectiveRisk: "restricted",
    payload: {},
  });
  await store.decide(p.proposalId, "approved", "approver");
  return { trajectories, trajectoryId, store, id: p.proposalId };
}

beforeEach(() => {
  audits.length = 0;
});

describe("rv11 H-1: a run slower than its lease applies once", () => {
  it("recovery mid-run marks it undecided; the run completes by its token; it never runs twice", async () => {
    const { trajectories, trajectoryId, store, id } = await approvedRun("op_h");
    let effects = 0;
    let first = true;
    const statusDuringRun: (string | undefined)[] = [];
    const t = heldTool(async () => {
      effects += 1;
      if (first) {
        first = false;
        // A second claim while this run holds the approval: impossible.
        expect(await store.claim(id)).toBeUndefined();
        // The hourly job runs while this run is still going (past its 10-minute lease).
        store.recoverStaleRuns(Date.now() + 1);
        statusDuringRun.push((await store.getById(id))?.status);
        // Undecided is not runnable either.
        expect(await store.claim(id)).toBeUndefined();
      }
      return { ok: true };
    });
    const run = () =>
      invokeTool({
        tool: t,
        input: {},
        actor,
        sessionId: "s",
        trajectoryId,
        stepIndex: 0,
        trajectoryStore: trajectories,
        proposalStore: store,
        approvedProposalId: id,
        operationId: "op_h",
      });
    await run();
    expect(statusDuringRun).toEqual(["indeterminate"]);
    // The run's own completion, by its token, landed: executed — not approved again.
    expect((await store.getById(id))?.status).toBe("executed");
    // "Approve again to retry" cannot run it a second time.
    await expect(run()).rejects.toBeInstanceOf(PipelineRejectedError);
    expect(effects).toBe(1);
  });

  it("a completion that cannot land — the claim taken back and decided otherwise — is raised, audited as a conflict, never swallowed", async () => {
    const { trajectories, trajectoryId, store, id } = await approvedRun("op_c");
    let effects = 0;
    const t = heldTool(async () => {
      effects += 1;
      if (effects === 1) {
        store.recoverStaleRuns(Date.now() + 1);
        // A person, seeing it undecided, verified (wrongly) and approved it again.
        await store.resolveIndeterminate(id, "approved", "bob", "looked not applied");
      }
      return { ok: true };
    });
    const err = await invokeTool({
      tool: t,
      input: {},
      actor,
      sessionId: "s",
      trajectoryId,
      stepIndex: 0,
      trajectoryStore: trajectories,
      proposalStore: store,
      approvedProposalId: id,
      operationId: "op_c",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionNotRecordedError);
    expect(err).toMatchObject({ applied: true, approvalConflict: true, proposalId: id });
    expect(audits).toEqual([
      expect.objectContaining({
        details: expect.objectContaining({
          type: "approval_run_conflict",
          holdId: id,
          tool: "held",
        }),
      }),
    ]);
    // The person's fresh approval stands; the old run's token ended nothing of it.
    expect((await store.getById(id))?.status).toBe("approved");
    expect(effects).toBe(1);
  });

  it("an atomic run's claim is returned to approved by the recovery (its effect rolled back with it); any other is undecided", async () => {
    const store = new InMemoryProposalStore();
    const mk = async (op: string, atomic: boolean) => {
      const p = await store.create({
        operationId: op,
        sessionId: "s",
        trajectoryId: "t",
        label: "held",
        actor,
        effects: ["stateWrite"],
        effectiveRisk: "restricted",
      });
      await store.decide(p.proposalId, "approved", "approver");
      await store.claim(p.proposalId, { atomic });
      return p.proposalId;
    };
    const a = await mk("op_a", true);
    const n = await mk("op_n", false);
    store.recoverStaleRuns(Date.now() + 1);
    expect((await store.getById(a))?.status).toBe("approved");
    expect((await store.getById(a))?.runToken).toBeUndefined();
    expect((await store.getById(n))?.status).toBe("indeterminate");
  });
});

describe("rv11 H-2: a session outgrows one trajectory", () => {
  const def = {
    id: "counter",
    capabilities: ["persistent"],
    actions: [{ type: "inc", effects: ["stateWrite"] }],
    initialState: () => ({ n: 0 }),
    validateAction: () => true,
    applyAction: (s: { n: number }) => ({ n: s.n + 1 }),
  };
  const user: AgentIdentity = {
    actorType: "user",
    actorId: "alice",
    agentRole: "player",
  };

  beforeEach(() => {
    resetActivityStateStore();
    setTrajectoryStore(new InMemoryTrajectoryStore());
  });

  it("move 1 001 succeeds, in segment 2 linked to segment 1; the chain reads as one; a load continues there", async () => {
    let s = await createSession({
      definition: def as never,
      config: {},
      participants: [user],
    });
    const firstId = s.trajectory.trajectoryId;
    for (let i = 0; i < TRAJECTORY_MAX_STEPS + 1; i++) {
      const out = await dispatch({
        session: s,
        definition: def as never,
        action: { type: "inc" } as never,
        actor: user,
        options: { computeNextActions: false },
      });
      if ("conflict" in out && out.conflict) throw new Error("conflict");
      const r = out as { result: typeof s.current; trajectory: typeof s.trajectory };
      s = { ...s, current: r.result, trajectory: r.trajectory };
    }
    expect((s.current.state as { n: number }).n).toBe(TRAJECTORY_MAX_STEPS + 1);
    expect(s.trajectory).toMatchObject({
      segment: 2,
      previousTrajectoryId: firstId,
      stepOffset: TRAJECTORY_MAX_STEPS,
    });
    expect(s.trajectory.steps).toHaveLength(1);
    // The move's index in the whole session.
    expect(s.trajectory.steps[0].stepIndex).toBe(TRAJECTORY_MAX_STEPS);

    const { getTrajectoryStore } = await import("@/platform/agents/trajectory-store");
    const chain = await readTrajectoryChain(getTrajectoryStore(), firstId);
    expect(chain.map((r) => r.trajectory.segment ?? 1)).toEqual([1, 2]);
    const steps = chainSteps(chain);
    expect(steps).toHaveLength(TRAJECTORY_MAX_STEPS + 1);
    expect(steps.map((x) => x.stepIndex)).toEqual(
      Array.from({ length: TRAJECTORY_MAX_STEPS + 1 }, (_, i) => i)
    );
    // From either end, the same chain.
    expect(
      (await readTrajectoryChain(getTrajectoryStore(), s.trajectory.trajectoryId)).map(
        (r) => r.trajectory.trajectoryId
      )
    ).toEqual(chain.map((r) => r.trajectory.trajectoryId));
    expect(
      (await latestTrajectorySegment(getTrajectoryStore(), firstId))?.trajectory
        .trajectoryId
    ).toBe(s.trajectory.trajectoryId);

    // Loaded again, the session goes on in the newest segment.
    const loaded = await loadSession({
      sessionId: s.sessionId,
      definition: def as never,
      actor: user,
    });
    expect(loaded?.session.trajectory.trajectoryId).toBe(s.trajectory.trajectoryId);

    // A stale session object (still on segment 1) appends to the existing continuation: no fork.
    const stale = await dispatch({
      session: { ...s, trajectory: chain[0].trajectory },
      definition: def as never,
      action: { type: "inc" } as never,
      actor: user,
      options: { computeNextActions: false },
    });
    expect(
      (stale as { trajectory: { trajectoryId: string } }).trajectory.trajectoryId
    ).toBe(s.trajectory.trajectoryId);
    expect(await readTrajectoryChain(getTrajectoryStore(), firstId)).toHaveLength(2);
  }, 60_000);

  it("an agent run opts in and continues; without it a full trajectory refuses the call before it runs (request.trajectory_full)", async () => {
    const trajectories = new InMemoryTrajectoryStore();
    const created = await trajectories.create(
      { kind: "agent", id: "a1" },
      "t",
      "platform"
    );
    const step = (i: number): Step => ({
      stepIndex: i,
      action: "x",
      input: {},
      output: {},
      cost: 0,
      durationMs: 0,
      timestamp: "",
      boundary: "commitment",
    });
    for (let i = 0; i < TRAJECTORY_MAX_STEPS; i++) {
      await trajectories.addStep(created.trajectory.trajectoryId, step(i));
    }
    let work = 0;
    const tool: Tool = {
      id: "read",
      name: "read",
      description: "",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      effects: [],
      declaredRisk: "ordinary",
      execute: async () => {
        work += 1;
        return { ok: true };
      },
    };
    const call = (rolloverTrajectory?: boolean) =>
      invokeTool({
        tool,
        input: {},
        actor,
        sessionId: "s",
        trajectoryId: created.trajectory.trajectoryId,
        stepIndex: TRAJECTORY_MAX_STEPS,
        trajectoryStore: trajectories,
        rolloverTrajectory,
      });
    await expect(call()).rejects.toMatchObject({ code: "request.trajectory_full" });
    expect(work).toBe(0);
    const out = await call(true);
    expect(work).toBe(1);
    const next = (
      out.outcome as { trajectory: { trajectoryId: string; segment?: number } }
    ).trajectory;
    expect(next.segment).toBe(2);
    expect(next.trajectoryId).not.toBe(created.trajectory.trajectoryId);
    // Through the first segment's id, an append goes to the chain's tail (review 12 M1): after
    // the step just recorded, never refused for the full segment it names.
    const tailAppend = await trajectories.addStep(
      created.trajectory.trajectoryId,
      step(TRAJECTORY_MAX_STEPS + 1)
    );
    expect(tailAppend!.trajectory.trajectoryId).toBe(next.trajectoryId);
    expect(tailAppend!.trajectory.stepOffset).toBe(TRAJECTORY_MAX_STEPS);
    // The append path itself refuses a full tail without the opt-in.
    const full = await trajectories.create({ kind: "agent", id: "a2" }, "t", "platform");
    for (let i = 0; i < TRAJECTORY_MAX_STEPS; i++) {
      await trajectories.addStep(full.trajectory.trajectoryId, step(i));
    }
    await expect(
      trajectories.addStep(full.trajectory.trajectoryId, step(TRAJECTORY_MAX_STEPS))
    ).rejects.toMatchObject({ code: "request.trajectory_full" });
  });
});

describe("rv11 M-1: a failure after the tool's own work is 'applied'", () => {
  it("an approved tool whose next state is refused after its work: applied, the approval used, the work run once", async () => {
    const { trajectories, trajectoryId, store, id } = await approvedRun("op_s");
    const stateStore = new InMemoryActivityStateStore<unknown>();
    await stateStore.create("s", { v: 0 });
    (stateStore as { validate?: (s: unknown) => void }).validate = (s: unknown) =>
      assertStorableJson(s, "app_sessions.state");
    let work = 0;
    const t = heldTool(async () => {
      work += 1;
      return { n: work };
    });
    const run = () =>
      invokeTool({
        tool: t,
        input: {},
        actor,
        sessionId: "s",
        trajectoryId,
        stepIndex: 0,
        trajectoryStore: trajectories,
        proposalStore: store,
        approvedProposalId: id,
        operationId: "op_s",
        stateStore,
        expectedVersion: 1,
        computeNextState: (o: Record<string, unknown>) =>
          o.n === 1 ? { blob: "z".repeat(1_100_000) } : { v: o.n },
      });
    const err = await run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionNotRecordedError);
    expect(err).toMatchObject({ applied: true });
    expect((err as Error).message).toContain("applied");
    expect((await store.getById(id))?.status).toBe("executed");
    expect(audits).toEqual([
      expect.objectContaining({
        details: expect.objectContaining({
          type: "action_applied_not_recorded",
          tool: "held",
        }),
      }),
    ]);
    // Not "approve again to retry": the work is not run a second time.
    await expect(run()).rejects.toBeInstanceOf(PipelineRejectedError);
    expect(work).toBe(1);
  });

  it("an approved tool's invalid output is not retried (the retry would run the approved work again): applied, once", async () => {
    const { trajectories, trajectoryId, store, id } = await approvedRun("op_o");
    let work = 0;
    const t = heldTool(
      async () => {
        work += 1;
        return { wrong: true };
      },
      {
        outputSchema: {
          type: "object",
          required: ["ok"],
          properties: { ok: { type: "boolean" } },
        },
      }
    );
    const err = await invokeTool({
      tool: t,
      input: {},
      actor,
      sessionId: "s",
      trajectoryId,
      stepIndex: 0,
      trajectoryStore: trajectories,
      proposalStore: store,
      approvedProposalId: id,
      operationId: "op_o",
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "ActionNotRecordedError", applied: true });
    expect(work).toBe(1);
    expect((await store.getById(id))?.status).toBe("executed");
  });

  it("a failure before the work returns still keeps the approval (released, approve again to retry)", async () => {
    const { trajectories, trajectoryId, store, id } = await approvedRun("op_b");
    const t = heldTool(async () => {
      throw new Error("db blip");
    });
    const err = await invokeTool({
      tool: t,
      input: {},
      actor,
      sessionId: "s",
      trajectoryId,
      stepIndex: 0,
      trajectoryStore: trajectories,
      proposalStore: store,
      approvedProposalId: id,
      operationId: "op_b",
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "ApprovedRunFailedError", released: true });
    expect(await store.getById(id)).toMatchObject({ status: "approved" });
    expect(audits).toEqual([
      expect.objectContaining({
        details: expect.objectContaining({ type: "approved_run_failed", holdId: id }),
      }),
    ]);
  });
});

describe("rv11 L-1: strings count by their length", () => {
  it("1 200 references to one 1 MB string are refused without being written out", () => {
    const big = "x".repeat(1_000_000);
    const doc = new Array(1200).fill(big);
    const stringify = jest.spyOn(JSON, "stringify");
    try {
      expect(storedJsonViolation(doc)).toEqual({
        code: "request.json_too_large",
        max: STORED_JSON_MAX_BYTES,
      });
      // Work, not time: nothing was serialised to find that out.
      expect(stringify).not.toHaveBeenCalled();
    } finally {
      stringify.mockRestore();
    }
  });

  it("keys count too; one string over the limit, alone or shared, is refused unwritten", () => {
    const key = "k".repeat(1000);
    const wide: Record<string, number> = {};
    for (let i = 0; i < 1100; i++) wide[`${key}${i}`] = 1;
    const stringify = jest.spyOn(JSON, "stringify");
    try {
      expect(storedJsonViolation(wide)?.code).toBe("request.json_too_large");
      expect(storedJsonViolation("y".repeat(STORED_JSON_MAX_BYTES))?.code).toBe(
        "request.json_too_large"
      );
      const shared = { s: "z".repeat(600_000) };
      expect(storedJsonViolation({ a: shared, b: shared })?.code).toBe(
        "request.json_too_large"
      );
      expect(stringify).not.toHaveBeenCalled();
    } finally {
      stringify.mockRestore();
    }
  });

  it("the bound is a lower bound: a document just within the limit is still accepted", () => {
    const fits = { s: "a".repeat(STORED_JSON_MAX_BYTES - 20) };
    expect(storedJsonViolation(fits)).toBeNull();
    // Multi-byte text is still measured exactly once within the bound.
    const multi = { s: "é".repeat(600_000) };
    expect(storedJsonViolation(multi)?.code).toBe("request.json_too_large");
    // A Date is written as its text, never as its (absent) members.
    expect(jsonDepth({ at: new Date(0) })).toBe(1);
    expect(storedJsonViolation({ at: new Date(0) })).toBeNull();
  });

  it("the DAG case stays linear (review 10 L9)", () => {
    let node: unknown = { leaf: 1 };
    for (let i = 0; i < 60; i++) node = { a: node, b: node };
    expect(storedJsonViolation(node)).toEqual({
      code: "request.json_too_large",
      max: STORED_JSON_MAX_BYTES,
    });
    expect(jsonDepth(node)).toBe(61);
  });
});

describe("rv11 L-3: an oversized row hides no other row", () => {
  it("the oversized row is skipped and named; every later row that fits is shown", () => {
    const rows = [
      { id: "big-1", details: "x".repeat(300 * 1024) },
      ...Array.from({ length: 19 }, (_, i) => ({ id: `r${i}` })),
    ];
    const text = searchResultText(rows);
    const shown = JSON.parse(text.slice(0, text.lastIndexOf("]") + 1)) as {
      id: string;
    }[];
    expect(shown.map((r) => r.id)).toEqual(rows.slice(1).map((r) => r.id));
    expect(text).toContain("1 row not shown (big-1)");
    expect(text).toContain("showing 19 of 20");
  });
});

describe("rv11 L-4: the in-memory store keeps its byte count across status changes", () => {
  it("20 steps of 900 KB with a status change between each: refused past 16 MiB", async () => {
    const st = new InMemoryTrajectoryStore();
    const id = (await st.create({ kind: "agent", id: "a" }, "t", "platform")).trajectory
      .trajectoryId;
    const big = { blob: "y".repeat(900_000) };
    let refused: unknown;
    let stored = 0;
    for (let i = 0; i < 20; i++) {
      await st.updateStatus(id, "running");
      try {
        await st.addStep(id, {
          stepIndex: i,
          action: "x",
          input: {},
          output: big,
          cost: 0,
          durationMs: 0,
          timestamp: "",
          boundary: "commitment",
        });
        stored += 1;
      } catch (e) {
        refused = e;
        break;
      }
    }
    expect(refused).toMatchObject({ code: "request.trajectory_full" });
    const rec = await st.getById(id);
    expect(rec!.trajectory.steps).toHaveLength(stored);
    expect(JSON.stringify(rec!.trajectory.steps).length).toBeLessThanOrEqual(
      16 * 1_048_576
    );
    await expect(st.assertRoomForStep(id)).rejects.toMatchObject({
      code: "request.trajectory_full",
    });
  });
});
