/**
 * __tests__/gating-and-resume.test.ts
 *
 * ADR-029 D5 and D7 end to end: a gated action is held rather than refused, approval
 * resumes the trajectory, rejection terminates it with a record and no state version, and
 * a resumed workflow re-executes no already-recorded step.
 */

import {
  proposeAction,
  approveProposal,
  rejectProposal,
} from "@/platform/action-pipeline";
import { resumeAgent } from "@/platform/agents/runtime";
import { InMemoryTrajectoryStore } from "@/platform/agents/trajectory-store";
import { InMemoryProposalStore } from "@/platform/agents/proposal-store";
import { InMemoryEffectLedger } from "@/platform/agents/effect-ledger";
import { registerAgent, resetAgentRegistry } from "@/platform/agents/registry";
import { BudgetTracker } from "@/platform/agents/budget-tracker";
import type { ActionSpec, AgentIdentity, SessionEvent } from "@/platform/kernel";
import type { WorkflowFn } from "@/platform/agents/runtime";
import * as platformConfig from "@/platform/auth/platform-config";
import { BUDGET_STEP_CAP_KEY } from "@/platform/agents/budget-config";

const actor: AgentIdentity = {
  actorType: "agent",
  actorId: "guardian",
  agentRole: "guardian",
};

const restrictedSpec: ActionSpec = {
  type: "purge_all",
  effects: ["restricted"],
  ephemeral: false,
  commutative: false,
};

describe("D7 — gating holds instead of refusing", () => {
  let trajectoryStore: InMemoryTrajectoryStore;
  let proposalStore: InMemoryProposalStore;
  let trajectoryId: string;

  beforeEach(async () => {
    trajectoryStore = new InMemoryTrajectoryStore();
    proposalStore = new InMemoryProposalStore();
    const rec = await trajectoryStore.create(
      { kind: "agent", id: "guardian" },
      "screen",
      "platform"
    );
    trajectoryId = rec.trajectory.trajectoryId;
  });

  function propose(emit?: (e: SessionEvent) => void) {
    return proposeAction({
      spec: restrictedSpec,
      actor,
      sessionId: "sess_1",
      trajectoryId,
      stepIndex: 0,
      label: "purge_all",
      proposalStore,
      trajectoryStore,
      emit,
    });
  }

  it("records the proposal and pauses the trajectory", async () => {
    const p = await propose();
    expect(p.status).toBe("proposed");

    const rec = await trajectoryStore.getById(trajectoryId);
    expect(rec?.trajectory.status).toBe("paused");
    expect(rec?.trajectory.steps).toHaveLength(1);
    expect(rec?.trajectory.steps[0].boundary).toBe("cognition");
    expect(rec?.trajectory.steps[0].proposalId).toBe(p.proposalId);
  });

  it("emits an approval-request event (ADR-028 D8)", async () => {
    const events: SessionEvent[] = [];
    await propose((e) => events.push(e));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("approval-request");
    expect(events[0].effectiveRisk).toBe("restricted");
  });

  it("nothing executes and no state version is produced (D8)", async () => {
    const p = await propose();
    const rec = await trajectoryStore.getById(trajectoryId);
    expect(rec?.trajectory.totalCost).toBe(0);
    expect(rec?.trajectory.steps[0].output).toMatchObject({
      proposalId: p.proposalId,
      status: "proposed",
    });
    expect(rec?.trajectory.steps[0].output).not.toHaveProperty("version");
  });

  it("approval returns the trajectory to running", async () => {
    const p = await propose();
    const approved = await approveProposal({
      proposalId: p.proposalId,
      decidedBy: "alice",
      proposalStore,
      trajectoryStore,
    });
    expect(approved?.status).toBe("approved");
    const rec = await trajectoryStore.getById(trajectoryId);
    expect(rec?.trajectory.status).toBe("running");
  });

  it("rejection is terminal and keeps the reasoning (D8)", async () => {
    const p = await propose();
    await rejectProposal({
      proposalId: p.proposalId,
      decidedBy: "alice",
      note: "not sanctioned",
      proposalStore,
      trajectoryStore,
    });

    const rec = await trajectoryStore.getById(trajectoryId);
    expect(rec?.trajectory.status).toBe("failed");
    expect(rec?.trajectory.steps).toHaveLength(2);
    expect(rec?.trajectory.steps[1].output).toMatchObject({
      status: "rejected",
      note: "not sanctioned",
    });
  });

  it("a second decision does not override the first (D4)", async () => {
    const p = await propose();
    await approveProposal({
      proposalId: p.proposalId,
      decidedBy: "alice",
      proposalStore,
      trajectoryStore,
    });
    const second = await rejectProposal({
      proposalId: p.proposalId,
      decidedBy: "bob",
      proposalStore,
      trajectoryStore,
    });
    expect(second).toBeUndefined();
  });
});

describe("D5 — resume re-executes no recorded step", () => {
  beforeEach(() => {
    resetAgentRegistry();
    registerAgent({
      id: "guardian",
      name: "guardian",
      description: "test",
      tools: [],
      budgetConfig: {
        maxCostPerTrajectory: 1,
        maxCostPerDay: 10,
        maxStepsPerTrajectory: 6,
      },
      effortTier: "standard",
    });
  });

  it("continues after the recorded steps, counted by side effect not timing", async () => {
    const trajectoryStore = new InMemoryTrajectoryStore();
    const budgetTracker = new BudgetTracker();
    const rec = await trajectoryStore.create(
      { kind: "agent", id: "guardian" },
      "screen",
      "platform"
    );
    const trajectoryId = rec.trajectory.trajectoryId;

    // Two steps already recorded, then paused — the shape executeAgent leaves behind.
    for (const i of [0, 1]) {
      await trajectoryStore.addStep(trajectoryId, {
        stepIndex: i,
        action: `step-${i}`,
        input: {},
        output: {},
        cost: 0,
        durationMs: 1,
        timestamp: new Date().toISOString(),
        boundary: "cognition",
      });
    }
    await trajectoryStore.updateStatus(trajectoryId, "paused");

    const executed: number[] = [];
    const workflow: WorkflowFn = async (ctx) => {
      executed.push(ctx.stepCount);
      return {
        action: `step-${ctx.stepCount}`,
        boundary: "cognition",
        input: {},
        output: {},
        costUsd: 0,
        continueExecution: ctx.stepCount < 3,
      };
    };

    const result = await resumeAgent({
      trajectoryId,
      workflow,
      trajectoryStore,
      budgetTracker,
    });

    // The side-effect counter: steps 0 and 1 were recorded and must not run again.
    expect(executed).not.toContain(0);
    expect(executed).not.toContain(1);
    expect(executed[0]).toBe(2);
    expect(result.finalStatus).toBe("completed");
  });

  it("reports indeterminate on resume when an effect is unresolved (D10)", async () => {
    const trajectoryStore = new InMemoryTrajectoryStore();
    const ledger = new InMemoryEffectLedger();
    const rec = await trajectoryStore.create(
      { kind: "agent", id: "guardian" },
      "screen",
      "platform"
    );
    const trajectoryId = rec.trajectory.trajectoryId;
    await trajectoryStore.updateStatus(trajectoryId, "paused");

    // An effect left in flight by whatever paused this run — the crash case.
    await ledger.begin({
      operationId: trajectoryId,
      effectKey: "charge",
      effectType: "externalCall",
    });

    const result = await resumeAgent({
      trajectoryId,
      workflow: async () => ({
        action: "finish",
        boundary: "cognition",
        input: {},
        output: {},
        costUsd: 0,
        continueExecution: false,
      }),
      trajectoryStore,
      effectLedger: ledger,
    });

    expect(result.finalStatus).toBe("indeterminate");
    const after = await trajectoryStore.getById(trajectoryId);
    expect(after?.trajectory.status).toBe("indeterminate");
  });

  it("refuses to resume a trajectory that is not paused", async () => {
    const trajectoryStore = new InMemoryTrajectoryStore();
    const rec = await trajectoryStore.create(
      { kind: "agent", id: "guardian" },
      "screen",
      "platform"
    );
    const result = await resumeAgent({
      trajectoryId: rec.trajectory.trajectoryId,
      workflow: async () => ({
        action: "x",
        boundary: "cognition",
        input: {},
        output: {},
        costUsd: 0,
        continueExecution: false,
      }),
      trajectoryStore,
    });
    expect(result.finalStatus).toBe("failed");
    expect(result.error).toMatch(/not paused/);
  });

  it("fails cleanly on an unknown trajectory", async () => {
    const result = await resumeAgent({
      trajectoryId: "nope",
      workflow: async () => ({
        action: "x",
        boundary: "cognition",
        input: {},
        output: {},
        costUsd: 0,
        continueExecution: false,
      }),
      trajectoryStore: new InMemoryTrajectoryStore(),
    });
    expect(result.error).toMatch(/not found/);
  });
});

// TASK-204 (N-46): resume honours the governed per-trajectory step cap, as executeAgent does
// (ADR-048 D1): min(agent.budget.max_steps_per_trajectory, the agent's default).
describe("resume honours the governed step cap (N-46)", () => {
  const spy = jest.spyOn(platformConfig, "getConfig");
  afterEach(() => spy.mockReset());
  afterAll(() => spy.mockRestore());

  beforeEach(() => {
    resetAgentRegistry();
    registerAgent({
      id: "guardian",
      name: "guardian",
      description: "test",
      tools: [],
      budgetConfig: {
        maxCostPerTrajectory: 1,
        maxCostPerDay: 10,
        maxStepsPerTrajectory: 6,
      },
      effortTier: "standard",
    });
  });

  async function pausedWith(steps: number) {
    const trajectoryStore = new InMemoryTrajectoryStore();
    const rec = await trajectoryStore.create(
      { kind: "agent", id: "guardian" },
      "screen",
      "platform"
    );
    const id = rec.trajectory.trajectoryId;
    for (let i = 0; i < steps; i++) {
      await trajectoryStore.addStep(id, {
        stepIndex: i,
        action: `step-${i}`,
        input: {},
        output: {},
        cost: 0,
        durationMs: 1,
        timestamp: new Date().toISOString(),
        boundary: "cognition",
      });
    }
    await trajectoryStore.updateStatus(id, "paused");
    return { trajectoryStore, id };
  }

  const forever: WorkflowFn = async (ctx) => ({
    action: `step-${ctx.stepCount}`,
    boundary: "cognition",
    input: {},
    output: {},
    costUsd: 0,
    continueExecution: true,
  });

  it("stops at a governed cap below the agent's default", async () => {
    spy.mockImplementation(
      async (key: string, d?: unknown) => (key === BUDGET_STEP_CAP_KEY ? 3 : d) as never
    );
    const { trajectoryStore, id } = await pausedWith(1);
    const result = await resumeAgent({
      trajectoryId: id,
      workflow: forever,
      trajectoryStore,
      budgetTracker: new BudgetTracker(),
    });
    expect(result.finalStatus).toBe("paused");
    expect(result.stepsCompleted).toBe(3);
    expect(result.error).toBe("step limit (3) reached before the workflow finished");
    expect(spy).toHaveBeenCalledWith(BUDGET_STEP_CAP_KEY, 6);
  });

  it("runs no step when the trajectory is already at the cap, and stays paused", async () => {
    spy.mockImplementation(
      async (key: string, d?: unknown) => (key === BUDGET_STEP_CAP_KEY ? 2 : d) as never
    );
    const { trajectoryStore, id } = await pausedWith(2);
    const ran: number[] = [];
    const result = await resumeAgent({
      trajectoryId: id,
      workflow: async (ctx) => {
        ran.push(ctx.stepCount);
        return forever(ctx);
      },
      trajectoryStore,
      budgetTracker: new BudgetTracker(),
    });
    expect(ran).toEqual([]);
    expect(result).toMatchObject({
      finalStatus: "paused",
      stepsCompleted: 2,
      success: false,
    });
    expect((await trajectoryStore.getById(id))?.trajectory.status).toBe("paused");
  });

  it("[hostile:store-down] a config store that fails falls back to the agent's default", async () => {
    spy.mockRejectedValue(new Error("db down"));
    const { trajectoryStore, id } = await pausedWith(0);
    const result = await resumeAgent({
      trajectoryId: id,
      workflow: forever,
      trajectoryStore,
      budgetTracker: new BudgetTracker(),
    });
    expect(result.stepsCompleted).toBe(6);
    expect(result.error).toBe("step limit (6) reached before the workflow finished");
  });
});
