/**
 * platform/agents/__tests__/held-action-retry.test.ts — approving again retries an approved step
 * whose run failed before taking effect (TASK-170; Playform's adoption of v6.0.0)
 *
 * The workflow loop used to mark the trajectory `failed` when an approved step's run failed before
 * taking effect (ApprovedRunFailedError, approval kept), and a failed trajectory is never
 * continued — so "approve it again to retry" could not be done for an agent workflow (Playform
 * reopened the trajectory itself). Now, against the real loop, pipeline and in-memory stores:
 *
 *   kept approval     the trajectory waits in `awaiting_retry`; its own agent's continuation runs
 *                     nothing (held, awaiting "retry"); approving again (resumeApprovedAction)
 *                     resumes it at that step — once, however many approve at once
 *   unknown outcome   the release could not be written: `indeterminate`, blocked until a person
 *                     decides — approved again (runs once) or marked executed (ends)
 *   withdrawn         withdrawHeldAction, or any path that withdraws or rejects it (the expiry
 *                     job): the workflow ends (`failed`), recorded, never continued
 */

import {
  advanceGoal,
  HeldActionNotApprovedError,
  registerWorkflow,
  resetWorkflowRegistry,
  resumeApprovedAction,
  runGoal,
  TrajectoryAccessError,
  type WorkflowDefinition,
} from "../workflow-loop";
import {
  approveHeldAction,
  endHeldTrajectory,
  resolveUndecidedHeldAction,
  withdrawHeldAction,
} from "../gating";
import { InMemoryProposalStore, setProposalStore } from "../proposal-store";
import { InMemoryTrajectoryStore, setTrajectoryStore } from "../trajectory-store";
import {
  InMemoryApprovalPolicyStore,
  setApprovalPolicyStore,
} from "../approval-policy-store";
import { ApprovedRunFailedError } from "@/platform/action-pipeline";
import type { AgentIdentity, Tool } from "@/platform/kernel";
import { withModules, WORKFLOW_GOALS_FIXTURE } from "@/__tests__/helpers/modules";
import { hooked, signal } from "@/__tests__/helpers/interleave";

withModules([WORKFLOW_GOALS_FIXTURE]);

const AGENT: AgentIdentity = {
  actorType: "agent",
  actorId: "agent:conductor",
  agentRole: "conductor",
  onBehalfOf: "user-1",
  sessionId: "session-agent",
};

const executed: string[] = [];
/** How many of the next runs of a gated tool fail (thrown, before any effect). */
let failNext = 0;

function tool(id: string, gated: boolean): Tool {
  return {
    id,
    name: id,
    description: id,
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    outputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    effects: gated ? ["restricted"] : [],
    declaredRisk: gated ? "restricted" : "ordinary",
    execute: async (input) => {
      if (gated && failNext > 0) {
        failNext -= 1;
        throw new Error("upstream blip");
      }
      // Lets concurrent resumes overlap inside the run.
      await new Promise((r) => setTimeout(r, 2));
      executed.push(`${id}:${String(input.text)}`);
      return { text: String(input.text) };
    },
  };
}

function workflow(
  goal: WorkflowDefinition["goal"],
  steps: [string, boolean][]
): WorkflowDefinition {
  return {
    goal,
    description: goal,
    endpoint: "/api/agent/process-content",
    steps: steps.map(([id, gated]) => ({
      tool: tool(id, gated),
      intent: "inform",
      estimatedCostUSD: 0.001,
      input: (ctx) => ({ text: String(ctx.input.text ?? "") }),
    })),
  };
}

let proposals: InMemoryProposalStore;
let trajectories: InMemoryTrajectoryStore;

beforeEach(() => {
  executed.length = 0;
  failNext = 0;
  resetWorkflowRegistry();
  registerWorkflow(workflow("translate", [["publish", true]]));
  registerWorkflow(
    workflow("full-pipeline", [
      ["gate", true],
      ["after", false],
    ])
  );
  proposals = new InMemoryProposalStore();
  trajectories = new InMemoryTrajectoryStore();
  setProposalStore(proposals);
  setTrajectoryStore(trajectories);
  setApprovalPolicyStore(new InMemoryApprovalPolicyStore());
});
afterEach(() => jest.restoreAllMocks());

const status = async (id: string) => (await trajectories.getById(id))?.trajectory.status;
const continueAsAgent = (trajectoryId: string, goal: WorkflowDefinition["goal"]) =>
  advanceGoal({ goal, input: { text: "EVIL" }, actor: AGENT, trajectoryId });

/** Held, approved, and its first run failed before taking effect: the approval kept. */
async function keptApproval(goal: WorkflowDefinition["goal"] = "translate") {
  const r = await runGoal({ goal, input: { text: "benign" }, actor: AGENT });
  const proposalId = r.held!.proposalId;
  const trajectoryId = r.trajectory.trajectoryId;
  await approveHeldAction({ proposalId, decidedBy: "user-1" });
  failNext = 1;
  const err = await resumeApprovedAction({ proposalId }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApprovedRunFailedError);
  expect(err).toMatchObject({ released: true });
  return { proposalId, trajectoryId };
}

describe("a kept approval: the workflow waits to be approved again", () => {
  it("is awaiting_retry, not failed; the approval stands with why its run failed", async () => {
    const { proposalId, trajectoryId } = await keptApproval();
    expect(await status(trajectoryId)).toBe("awaiting_retry");
    expect(await proposals.getById(proposalId)).toMatchObject({
      status: "approved",
      lastRunError: expect.stringContaining("upstream blip"),
    });
    expect(executed).toEqual([]);
  });

  it("its own agent's continuation runs nothing: held, awaiting a retry decision", async () => {
    const { proposalId, trajectoryId } = await keptApproval();
    const r = await continueAsAgent(trajectoryId, "translate");
    expect(r.held).toMatchObject({
      proposalId,
      awaiting: "retry",
      lastRunError: expect.stringContaining("upstream blip"),
      approver: expect.objectContaining({ actorType: "user" }),
    });
    expect(r.nextActions[0].description).toMatch(/approved again/);
    expect(r.trajectory.status).toBe("awaiting_retry");
    // And runGoal is answered the same way.
    const again = await runGoal({
      goal: "translate",
      input: {},
      actor: AGENT,
      trajectoryId,
    });
    expect(again.held?.awaiting).toBe("retry");
    expect(executed).toEqual([]);
  });

  it("approving again resumes it at that step, with the approved payload, and completes", async () => {
    const { proposalId, trajectoryId } = await keptApproval();
    const r = await resumeApprovedAction({ proposalId });
    expect(r.trajectory.status).toBe("completed");
    expect(executed).toEqual(["publish:benign"]);
    expect((await proposals.getById(proposalId))?.status).toBe("executed");
    const t = await trajectories.getById(trajectoryId);
    expect(t!.trajectory.steps.filter((s) => s.boundary === "commitment")).toHaveLength(
      1
    );
  });

  it("a workflow with steps after it is running again, and continues as before", async () => {
    const { proposalId, trajectoryId } = await keptApproval("full-pipeline");
    const r = await resumeApprovedAction({ proposalId });
    expect(r.trajectory.status).toBe("running");
    const next = await advanceGoal({
      goal: "full-pipeline",
      input: { text: "next" },
      actor: AGENT,
      trajectoryId,
    });
    expect(next.trajectory.status).toBe("completed");
    expect(executed).toEqual(["gate:benign", "after:next"]);
  });

  it("concurrent re-approvals resume it once; the others are refused", async () => {
    const { proposalId, trajectoryId } = await keptApproval();
    const results = await Promise.allSettled([
      resumeApprovedAction({ proposalId }),
      resumeApprovedAction({ proposalId }),
      resumeApprovedAction({ proposalId }),
      resumeApprovedAction({ proposalId }),
      continueAsAgent(trajectoryId, "translate"),
    ]);
    expect(executed).toEqual(["publish:benign"]);
    const resumed = results
      .slice(0, 4)
      .filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<
      Awaited<ReturnType<typeof resumeApprovedAction>>
    >[];
    expect(resumed).toHaveLength(1);
    for (const r of results.slice(0, 4)) {
      if (r.status === "rejected")
        expect(r.reason).toBeInstanceOf(HeldActionNotApprovedError);
    }
    expect(await status(trajectoryId)).toBe("completed");
    expect((await proposals.getById(proposalId))?.status).toBe("executed");
    // Nothing was proposed again for the step.
    expect(
      await proposals.query({ operationId: `op_${trajectoryId}_0`, status: "proposed" })
    ).toEqual([]);
  });

  it("a retry that fails again keeps waiting, and the next approval runs it", async () => {
    const { proposalId, trajectoryId } = await keptApproval();
    failNext = 1;
    await expect(resumeApprovedAction({ proposalId })).rejects.toBeInstanceOf(
      ApprovedRunFailedError
    );
    expect(await status(trajectoryId)).toBe("awaiting_retry");
    await resumeApprovedAction({ proposalId });
    expect(executed).toEqual(["publish:benign"]);
    expect(await status(trajectoryId)).toBe("completed");
  });

  it("an approval that is used cannot drive the step again", async () => {
    const { proposalId } = await keptApproval();
    await resumeApprovedAction({ proposalId });
    await expect(resumeApprovedAction({ proposalId })).rejects.toBeInstanceOf(
      HeldActionNotApprovedError
    );
    expect(executed).toEqual(["publish:benign"]);
  });
});

describe("concurrent resumes: the approval's claim decides, whatever was read before (TASK-175)", () => {
  /**
   * B passes resumeApprovedAction's checks (approved, its step next); then A claims, runs and
   * completes the step; then B reads the trajectory again. B used to answer with the workflow A
   * completed — a success for work it did not do (the CI flake).
   */
  async function checkedThenOvertaken(goal: WorkflowDefinition["goal"]) {
    const { proposalId, trajectoryId } = await keptApproval(goal);
    const bChecked = signal();
    const aDone = signal();
    let reads = 0;
    const bTrajectories = hooked(trajectories, {
      getById: async (id: string) => {
        reads += 1;
        if (reads > 1) await aDone.wait;
        const record = await trajectories.getById(id);
        if (reads === 1) bChecked.open();
        return record;
      },
    });
    const aProposals = hooked(proposals, {
      claim: async (id: string, options?: { readonly atomic?: boolean }) => {
        await bChecked.wait;
        return proposals.claim(id, options);
      },
    });
    const a = resumeApprovedAction({ proposalId, proposalStore: aProposals });
    void a.finally(() => aDone.open()).catch(() => undefined);
    const b = resumeApprovedAction({ proposalId, trajectoryStore: bTrajectories });
    const [ra, rb] = await Promise.allSettled([a, b]);
    return { proposalId, trajectoryId, ra, rb };
  }

  it("checked, then overtaken before its run: refused, not answered with A's completion", async () => {
    const { proposalId, trajectoryId, ra, rb } = await checkedThenOvertaken("translate");
    expect(ra).toMatchObject({ status: "fulfilled" });
    expect(rb.status).toBe("rejected");
    expect((rb as PromiseRejectedResult).reason).toBeInstanceOf(
      HeldActionNotApprovedError
    );
    expect(executed).toEqual(["publish:benign"]);
    expect(await status(trajectoryId)).toBe("completed");
    expect((await proposals.getById(proposalId))?.status).toBe("executed");
  });

  it("with a step after it: the loser does not run the next step either", async () => {
    const { trajectoryId, ra, rb } = await checkedThenOvertaken("full-pipeline");
    expect(ra).toMatchObject({ status: "fulfilled" });
    expect((rb as PromiseRejectedResult).reason).toBeInstanceOf(
      HeldActionNotApprovedError
    );
    expect(executed).toEqual(["gate:benign"]);
    expect(await status(trajectoryId)).toBe("running");
  });

  it("both reach the claim: the compare-and-set picks one, the other is refused", async () => {
    const { proposalId, trajectoryId } = await keptApproval();
    const bAtClaim = signal();
    const aDone = signal();
    const aProposals = hooked(proposals, {
      claim: async (id: string, options?: { readonly atomic?: boolean }) => {
        await bAtClaim.wait;
        return proposals.claim(id, options);
      },
    });
    const bProposals = hooked(proposals, {
      claim: async (id: string, options?: { readonly atomic?: boolean }) => {
        bAtClaim.open();
        await aDone.wait;
        return proposals.claim(id, options);
      },
    });
    const a = resumeApprovedAction({ proposalId, proposalStore: aProposals });
    void a.finally(() => aDone.open()).catch(() => undefined);
    const b = resumeApprovedAction({ proposalId, proposalStore: bProposals });
    const [ra, rb] = await Promise.allSettled([a, b]);
    expect(ra).toMatchObject({ status: "fulfilled" });
    expect((rb as PromiseRejectedResult).reason).toBeInstanceOf(
      HeldActionNotApprovedError
    );
    expect(executed).toEqual(["publish:benign"]);
    expect(await status(trajectoryId)).toBe("completed");
    expect((await proposals.getById(proposalId))?.status).toBe("executed");
  });

  it("the concurrent test, 50 times: one runs, the others are refused, every time", async () => {
    for (let n = 0; n < 50; n += 1) {
      executed.length = 0;
      const { proposalId, trajectoryId } = await keptApproval();
      const results = await Promise.allSettled(
        [1, 2, 3, 4].map(() => resumeApprovedAction({ proposalId }))
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results)
        if (r.status === "rejected")
          expect(r.reason).toBeInstanceOf(HeldActionNotApprovedError);
      expect(executed).toEqual(["publish:benign"]);
      expect(await status(trajectoryId)).toBe("completed");
    }
    // 50 rounds in memory: about a second idle, several on a loaded runner — a bound for the work,
    // not jest's 5 s default (TASK-198: it timed out under CPU load).
  }, 30_000);
});

describe("a decision on a held step never overwrites what a concurrent run recorded (TASK-175)", () => {
  it("withdrawn while a run finishes the workflow: the end is not written over it", async () => {
    const { proposalId, trajectoryId } = await keptApproval();
    // The workflow finishes between the withdrawal's look at it and its end.
    const store = hooked(trajectories, {
      addStep: async (...args: Parameters<InMemoryTrajectoryStore["addStep"]>) => {
        const added = await trajectories.addStep(...args);
        await trajectories.updateStatus(trajectoryId, "completed");
        return added;
      },
    });
    await withdrawHeldAction({ proposalId, decidedBy: "user-1", trajectoryStore: store });
    expect(await status(trajectoryId)).toBe("completed");
  });

  it("approved again, and resumed before the trajectory is moved: not moved back to awaiting_retry", async () => {
    const r = await runGoal({
      goal: "translate",
      input: { text: "benign" },
      actor: AGENT,
    });
    const proposalId = r.held!.proposalId;
    const trajectoryId = r.trajectory.trajectoryId;
    await approveHeldAction({ proposalId, decidedBy: "user-1" });
    failNext = 1;
    jest.spyOn(proposals, "release").mockRejectedValueOnce(new Error("db down"));
    await resumeApprovedAction({ proposalId }).catch(() => undefined);
    proposals.recoverStaleRuns(Date.now() + 60_000);
    expect(await status(trajectoryId)).toBe("indeterminate");
    // A resume runs the step the moment the proposal is approved again, before the decision
    // moves the trajectory.
    const store = hooked(trajectories, {
      updateStatus: async (
        ...args: Parameters<InMemoryTrajectoryStore["updateStatus"]>
      ) => {
        await resumeApprovedAction({ proposalId });
        return trajectories.updateStatus(...args);
      },
    });
    const done = await resolveUndecidedHeldAction({
      proposalId,
      resolution: "approved",
      decidedBy: "user-1",
      trajectoryStore: store,
    });
    expect(done?.status).toBe("approved");
    expect(executed).toEqual(["publish:benign"]);
    expect(await status(trajectoryId)).toBe("completed");
  });

  it("a continuation that saw a kept approval, overtaken by its resume: refused, the completion kept", async () => {
    const { proposalId, trajectoryId } = await keptApproval();
    // Left running by another path (TASK-173): the continuation would move it to awaiting_retry.
    await trajectories.updateStatus(trajectoryId, "running");
    const props = hooked(proposals, {
      query: async (...args: Parameters<InMemoryProposalStore["query"]>) => {
        const found = await proposals.query(...args);
        await resumeApprovedAction({ proposalId });
        return found;
      },
    });
    await expect(
      advanceGoal({
        goal: "translate",
        input: {},
        actor: AGENT,
        trajectoryId,
        proposalStore: props,
      })
    ).rejects.toBeInstanceOf(HeldActionNotApprovedError);
    expect(executed).toEqual(["publish:benign"]);
    expect(await status(trajectoryId)).toBe("completed");
  });
});

describe("withdrawn or rejected: the workflow ends", () => {
  it("withdrawHeldAction withdraws the kept approval, records it and ends the trajectory", async () => {
    const { proposalId, trajectoryId } = await keptApproval();
    const w = await withdrawHeldAction({ proposalId, decidedBy: "user-1" });
    expect(w?.status).toBe("rejected");
    expect(await status(trajectoryId)).toBe("failed");
    const t = await trajectories.getById(trajectoryId);
    expect(t!.trajectory.steps.at(-1)).toMatchObject({
      boundary: "cognition",
      proposalId,
      output: expect.objectContaining({ status: "rejected", decidedBy: "user-1" }),
    });
    await expect(resumeApprovedAction({ proposalId })).rejects.toBeInstanceOf(
      HeldActionNotApprovedError
    );
    await expect(continueAsAgent(trajectoryId, "translate")).rejects.toBeInstanceOf(
      TrajectoryAccessError
    );
    expect(executed).toEqual([]);
    // A second withdrawal decides nothing.
    expect(await withdrawHeldAction({ proposalId, decidedBy: "user-1" })).toBeUndefined();
  });

  it("withdrawn by another path (the expiry job): the next continuation ends it — never re-proposed", async () => {
    const { proposalId, trajectoryId } = await keptApproval();
    await proposals.withdraw(proposalId, "system:approval-expiry", "lapsed");
    await expect(continueAsAgent(trajectoryId, "translate")).rejects.toBeInstanceOf(
      TrajectoryAccessError
    );
    expect(await status(trajectoryId)).toBe("failed");
    expect(
      await proposals.query({ operationId: `op_${trajectoryId}_0`, status: "proposed" })
    ).toEqual([]);
    expect(executed).toEqual([]);
  });

  it("a trajectory already finished is left as it is", async () => {
    const { proposalId, trajectoryId } = await keptApproval();
    await trajectories.updateStatus(trajectoryId, "completed");
    const before = (await trajectories.getById(trajectoryId))!.trajectory.steps.length;
    await withdrawHeldAction({ proposalId, decidedBy: "user-1" });
    expect(await status(trajectoryId)).toBe("completed");
    expect((await trajectories.getById(trajectoryId))!.trajectory.steps).toHaveLength(
      before
    );
    // And a held action whose trajectory is gone ends nothing.
    await endHeldTrajectory(trajectories, {
      ...(await proposals.getById(proposalId))!,
      trajectoryId: "gone",
    });
  });

  it("the trajectory still ends when its record of the decision cannot be written", async () => {
    const { proposalId, trajectoryId } = await keptApproval();
    jest.spyOn(trajectories, "addStep").mockRejectedValueOnce(new Error("full"));
    await withdrawHeldAction({ proposalId, decidedBy: "user-1", note: "  " });
    expect(await status(trajectoryId)).toBe("failed");
  });
});

describe("an approved run whose outcome is unknown blocks the workflow until decided", () => {
  /** The run fails and its approval cannot be given back: released false, the claim kept. */
  async function undecided(goal: WorkflowDefinition["goal"] = "translate") {
    const r = await runGoal({ goal, input: { text: "benign" }, actor: AGENT });
    const proposalId = r.held!.proposalId;
    const trajectoryId = r.trajectory.trajectoryId;
    await approveHeldAction({ proposalId, decidedBy: "user-1" });
    failNext = 1;
    jest.spyOn(proposals, "release").mockRejectedValueOnce(new Error("db down"));
    const err = await resumeApprovedAction({ proposalId }).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "ApprovedRunFailedError", released: false });
    return { proposalId, trajectoryId };
  }

  it("is indeterminate; while its claim stands, nothing continues it", async () => {
    const { proposalId, trajectoryId } = await undecided();
    expect(await status(trajectoryId)).toBe("indeterminate");
    expect((await proposals.getById(proposalId))?.status).toBe("executing");
    await expect(resumeApprovedAction({ proposalId })).rejects.toBeInstanceOf(
      HeldActionNotApprovedError
    );
    await expect(continueAsAgent(trajectoryId, "translate")).rejects.toBeInstanceOf(
      HeldActionNotApprovedError
    );
    expect(executed).toEqual([]);
  });

  it("once recovered as undecided: held, awaiting its outcome — approve/resume refused", async () => {
    const { proposalId, trajectoryId } = await undecided();
    proposals.recoverStaleRuns(Date.now() + 60_000);
    expect((await proposals.getById(proposalId))?.status).toBe("indeterminate");
    const r = await continueAsAgent(trajectoryId, "translate");
    expect(r.held).toMatchObject({ proposalId, awaiting: "outcome" });
    expect(r.nextActions[0].description).toMatch(/outcome is unknown/);
    await expect(resumeApprovedAction({ proposalId })).rejects.toBeInstanceOf(
      HeldActionNotApprovedError
    );
    expect(executed).toEqual([]);
  });

  it("approved again by a person: awaiting_retry, then resumed once", async () => {
    const { proposalId, trajectoryId } = await undecided();
    proposals.recoverStaleRuns(Date.now() + 60_000);
    const done = await resolveUndecidedHeldAction({
      proposalId,
      resolution: "approved",
      decidedBy: "user-1",
    });
    expect(done?.status).toBe("approved");
    expect(await status(trajectoryId)).toBe("awaiting_retry");
    const results = await Promise.allSettled([
      resumeApprovedAction({ proposalId }),
      resumeApprovedAction({ proposalId }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(executed).toEqual(["publish:benign"]);
    expect(await status(trajectoryId)).toBe("completed");
  });

  it("approved again by another path: the agent's continuation sees it awaiting a retry", async () => {
    const { proposalId, trajectoryId } = await undecided();
    proposals.recoverStaleRuns(Date.now() + 60_000);
    await proposals.resolveIndeterminate(proposalId, "approved", "user-1", "verified");
    const r = await continueAsAgent(trajectoryId, "translate");
    expect(r.held?.awaiting).toBe("retry");
    expect(await status(trajectoryId)).toBe("awaiting_retry");
  });

  it("marked executed: its output was never recorded — the workflow ends, not continued", async () => {
    const { proposalId, trajectoryId } = await undecided("full-pipeline");
    proposals.recoverStaleRuns(Date.now() + 60_000);
    const done = await resolveUndecidedHeldAction({
      proposalId,
      resolution: "executed",
      decidedBy: "user-1",
    });
    expect(done?.status).toBe("executed");
    expect(await status(trajectoryId)).toBe("failed");
    const t = await trajectories.getById(trajectoryId);
    expect(t!.trajectory.steps.at(-1)?.output).toMatchObject({
      status: "executed",
      outputRecorded: false,
    });
    await expect(continueAsAgent(trajectoryId, "full-pipeline")).rejects.toBeInstanceOf(
      TrajectoryAccessError
    );
    expect(executed).toEqual([]);
  });

  it("marked executed by another path: the next continuation ends it", async () => {
    const { proposalId, trajectoryId } = await undecided();
    proposals.recoverStaleRuns(Date.now() + 60_000);
    await proposals.resolveIndeterminate(proposalId, "executed", "user-1", "verified");
    await expect(continueAsAgent(trajectoryId, "translate")).rejects.toBeInstanceOf(
      TrajectoryAccessError
    );
    expect(await status(trajectoryId)).toBe("failed");
  });

  it("a decision on a run that is not undecided decides nothing", async () => {
    const { proposalId, trajectoryId } = await keptApproval();
    expect(
      await resolveUndecidedHeldAction({
        proposalId,
        resolution: "executed",
        decidedBy: "user-1",
        note: "x",
      })
    ).toBeUndefined();
    expect(await status(trajectoryId)).toBe("awaiting_retry");
  });
});

describe("an instance lost mid-run: the recovery leaves its workflow waiting (TASK-173)", () => {
  /** Held, approved, and its run claimed — then the instance is lost: no end is written. */
  async function lostMidRun(
    goal: WorkflowDefinition["goal"] = "translate",
    atomic = false
  ) {
    const r = await runGoal({ goal, input: { text: "benign" }, actor: AGENT });
    const proposalId = r.held!.proposalId;
    const trajectoryId = r.trajectory.trajectoryId;
    await approveHeldAction({ proposalId, decidedBy: "user-1" });
    expect(await proposals.claim(proposalId, { atomic })).toMatchObject({
      status: "executing",
    });
    expect(await status(trajectoryId)).toBe("running");
    return { proposalId, trajectoryId };
  }

  const proposedAgain = async (trajectoryId: string) =>
    proposals.query({ operationId: `op_${trajectoryId}_0`, status: "proposed" });

  it("undecided: the trajectory is indeterminate; the continuation is held, awaiting its outcome", async () => {
    const { proposalId, trajectoryId } = await lostMidRun();
    const recovered = proposals.recoverStaleRuns(Date.now() + 60_000, trajectories);
    expect(recovered.map((p) => p.status)).toEqual(["indeterminate"]);
    expect(await status(trajectoryId)).toBe("indeterminate");
    const r = await continueAsAgent(trajectoryId, "translate");
    expect(r.held).toMatchObject({ proposalId, awaiting: "outcome" });
    expect(r.trajectory.status).toBe("indeterminate");
    await expect(resumeApprovedAction({ proposalId })).rejects.toBeInstanceOf(
      HeldActionNotApprovedError
    );
    expect(await proposedAgain(trajectoryId)).toEqual([]);
    expect(executed).toEqual([]);
  });

  it("approved again by a person, then resumed: it runs once and completes", async () => {
    const { proposalId, trajectoryId } = await lostMidRun();
    proposals.recoverStaleRuns(Date.now() + 60_000, trajectories);
    const done = await resolveUndecidedHeldAction({
      proposalId,
      resolution: "approved",
      decidedBy: "user-1",
    });
    expect(done?.status).toBe("approved");
    expect(await status(trajectoryId)).toBe("awaiting_retry");
    const results = await Promise.allSettled([
      resumeApprovedAction({ proposalId }),
      resumeApprovedAction({ proposalId }),
      continueAsAgent(trajectoryId, "translate"),
    ]);
    expect(results.slice(0, 2).filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(executed).toEqual(["publish:benign"]);
    expect(await status(trajectoryId)).toBe("completed");
    expect((await proposals.getById(proposalId))?.status).toBe("executed");
    await expect(resumeApprovedAction({ proposalId })).rejects.toBeInstanceOf(
      HeldActionNotApprovedError
    );
    expect(executed).toEqual(["publish:benign"]);
  });

  it("atomic: approved again, the trajectory awaiting_retry; the continuation is held, awaiting a retry", async () => {
    const { proposalId, trajectoryId } = await lostMidRun("translate", true);
    const recovered = proposals.recoverStaleRuns(Date.now() + 60_000, trajectories);
    expect(recovered.map((p) => p.status)).toEqual(["approved"]);
    expect(await status(trajectoryId)).toBe("awaiting_retry");
    const r = await continueAsAgent(trajectoryId, "translate");
    expect(r.held).toMatchObject({ proposalId, awaiting: "retry" });
    expect(executed).toEqual([]);
    const resumed = await resumeApprovedAction({ proposalId });
    expect(resumed.trajectory.status).toBe("completed");
    expect(executed).toEqual(["publish:benign"]);
  });

  it("a trajectory already finished is left as it is by the recovery", async () => {
    const { trajectoryId } = await lostMidRun();
    await trajectories.updateStatus(trajectoryId, "failed");
    proposals.recoverStaleRuns(Date.now() + 60_000, trajectories);
    expect(await status(trajectoryId)).toBe("failed");
  });

  it("a recovery that did not move the trajectory: the continuation still answers held (defence in depth)", async () => {
    const undecided = await lostMidRun();
    proposals.recoverStaleRuns(Date.now() + 60_000);
    expect(await status(undecided.trajectoryId)).toBe("running");
    const r = await continueAsAgent(undecided.trajectoryId, "translate");
    expect(r.held).toMatchObject({
      proposalId: undecided.proposalId,
      awaiting: "outcome",
    });
    expect(await status(undecided.trajectoryId)).toBe("indeterminate");
    // runGoal answers it the same way.
    const again = await runGoal({
      goal: "translate",
      input: {},
      actor: AGENT,
      trajectoryId: undecided.trajectoryId,
    });
    expect(again.held?.awaiting).toBe("outcome");

    const atomic = await lostMidRun("translate", true);
    proposals.recoverStaleRuns(Date.now() + 60_000);
    expect(await status(atomic.trajectoryId)).toBe("running");
    const a = await continueAsAgent(atomic.trajectoryId, "translate");
    expect(a.held).toMatchObject({ proposalId: atomic.proposalId, awaiting: "retry" });
    expect(await status(atomic.trajectoryId)).toBe("awaiting_retry");
    expect(await proposedAgain(undecided.trajectoryId)).toEqual([]);
    expect(await proposedAgain(atomic.trajectoryId)).toEqual([]);
    expect(executed).toEqual([]);
  });

  it("undecided after the continuation's first look: the hold is answered held, never a plain error", async () => {
    const { proposalId, trajectoryId } = await lostMidRun();
    proposals.recoverStaleRuns(Date.now() + 60_000);
    // The continuation's first read misses it (it was recovered just after).
    jest.spyOn(proposals, "query").mockResolvedValueOnce([]);
    const r = await continueAsAgent(trajectoryId, "translate");
    expect(r.held).toMatchObject({ proposalId, awaiting: "outcome" });
    expect(await status(trajectoryId)).toBe("indeterminate");
    expect(await proposedAgain(trajectoryId)).toEqual([]);
    expect(executed).toEqual([]);
  });

  it("a fresh approval on a running trajectory still runs on the agent's continuation", async () => {
    const r = await runGoal({
      goal: "translate",
      input: { text: "benign" },
      actor: AGENT,
    });
    await approveHeldAction({ proposalId: r.held!.proposalId, decidedBy: "user-1" });
    const next = await continueAsAgent(r.trajectory.trajectoryId, "translate");
    expect(next.held).toBeUndefined();
    expect(next.trajectory.status).toBe("completed");
    expect(executed).toEqual(["publish:benign"]);
  });
});
