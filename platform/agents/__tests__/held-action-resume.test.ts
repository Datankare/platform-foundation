/**
 * platform/agents/__tests__/held-action-resume.test.ts — deciding and resuming a held action (PF v5.1.0)
 *
 * Hostile cases from the Playform v0.8.0 release review, run against the REAL workflow loop,
 * pipeline and in-memory stores — nothing about the hold, the approval or the resume is mocked.
 * Before v5.1.0 the resume never found the approval (the step was held again), a resume could
 * run another goal or input on one approval, any caller holding a trajectoryId could continue
 * someone else's workflow, a two-gate workflow could commit its second gate on the first one's
 * approval, and the durable store forgot who a held action belonged to.
 */

import {
  advanceGoal,
  ApprovalMismatchError,
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
  heldActionRefusal,
  principalOf,
  rejectHeldAction,
} from "../gating";
import { InMemoryProposalStore, setProposalStore } from "../proposal-store";
import { InMemoryTrajectoryStore, setTrajectoryStore } from "../trajectory-store";
import {
  InMemoryApprovalPolicyStore,
  setApprovalPolicyStore,
  type ApprovalPolicy,
} from "../approval-policy-store";
import {
  canonicalJson,
  executeActionPipeline,
  PipelineRejectedError,
} from "@/platform/action-pipeline";
import type { AgentIdentity, ProposalRecord, Tool } from "@/platform/kernel";
import { generateSecureId } from "../utils";

const AGENT: AgentIdentity = {
  actorType: "agent",
  actorId: "agent:conductor",
  agentRole: "conductor",
  onBehalfOf: "user-1",
  sessionId: "session-agent",
};
const OWNER: AgentIdentity = {
  actorType: "user",
  actorId: "user-1",
  agentRole: "none",
  sessionId: "session-browser",
};

const executed: string[] = [];

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
  resetWorkflowRegistry();
  registerWorkflow(workflow("translate", [["publish", true]]));
  registerWorkflow(workflow("speak", [["other-restricted", true]]));
  registerWorkflow(
    workflow("full-pipeline", [
      ["first-gate", true],
      ["second-gate", true],
    ])
  );
  proposals = new InMemoryProposalStore();
  trajectories = new InMemoryTrajectoryStore();
  // The defaults — exactly how a consumer route runs (it passes no stores).
  setProposalStore(proposals);
  setTrajectoryStore(trajectories);
  setApprovalPolicyStore(new InMemoryApprovalPolicyStore());
});

async function hold(goal: WorkflowDefinition["goal"] = "translate", text = "benign") {
  const r = await runGoal({ goal, input: { text }, actor: AGENT });
  expect(r.held).toBeDefined();
  return { proposalId: r.held!.proposalId, trajectoryId: r.trajectory.trajectoryId };
}

describe("resuming an approved held action", () => {
  it("runs the approved step exactly once, with the approved payload, and completes", async () => {
    const h = await hold();
    await approveHeldAction({ proposalId: h.proposalId, decidedBy: "user-1" });
    const r = await resumeApprovedAction({ proposalId: h.proposalId });
    expect(r.held).toBeUndefined();
    expect(r.trajectory.status).toBe("completed");
    expect(executed).toEqual(["publish:benign"]);
  });

  it("runs as the proposing agent (capability checked for it), not as whoever approved", async () => {
    registerWorkflow({
      ...workflow("transcribe", [["gated-explain", true]]),
      requiredCapability: "transcribe",
    });
    const seen: AgentIdentity[] = [];
    const checkCapability = async (_c: string, actor: AgentIdentity) => {
      seen.push(actor);
      return true;
    };
    const r = await runGoal({
      goal: "transcribe",
      input: { text: "e" },
      actor: AGENT,
      checkCapability,
    });
    await approveHeldAction({ proposalId: r.held!.proposalId, decidedBy: "user-1" });
    await resumeApprovedAction({ proposalId: r.held!.proposalId, checkCapability });
    expect(seen.map((a) => a.actorId)).toEqual(["agent:conductor", "agent:conductor"]);
    const t = await trajectories.getById(r.trajectory.trajectoryId);
    const commit = t!.trajectory.steps.find((s) => s.boundary === "commitment");
    expect(commit?.actor?.actorId).toBe("agent:conductor");
    expect(executed).toEqual(["gated-explain:e"]);
  });

  it("refuses to resume a held action that is not approved", async () => {
    const h = await hold();
    await expect(
      resumeApprovedAction({ proposalId: h.proposalId })
    ).rejects.toBeInstanceOf(HeldActionNotApprovedError);
    await rejectHeldAction({ proposalId: h.proposalId, decidedBy: "user-1" });
    await expect(
      resumeApprovedAction({ proposalId: h.proposalId })
    ).rejects.toBeInstanceOf(HeldActionNotApprovedError);
    expect(executed).toEqual([]);
  });

  it("ignores a caller's input on resume: the approved payload runs, not the new text", async () => {
    const h = await hold("translate", "benign");
    await approveHeldAction({ proposalId: h.proposalId, decidedBy: "user-1" });
    await advanceGoal({
      goal: "translate",
      input: { text: "EVIL" },
      actor: AGENT,
      trajectoryId: h.trajectoryId,
    });
    expect(executed).toEqual(["publish:benign"]);
  });

  it("refuses a resume under another goal: one approval never releases another action", async () => {
    const h = await hold("translate", "benign");
    await approveHeldAction({ proposalId: h.proposalId, decidedBy: "user-1" });
    await expect(
      advanceGoal({
        goal: "speak",
        input: { text: "EVIL" },
        actor: AGENT,
        trajectoryId: h.trajectoryId,
      })
    ).rejects.toBeInstanceOf(TrajectoryAccessError);
    expect(executed).toEqual([]);
  });

  it("does not commit the second gate of a workflow on the first gate's approval", async () => {
    const h = await hold("full-pipeline", "x");
    await approveHeldAction({ proposalId: h.proposalId, decidedBy: "user-1" });
    const first = await resumeApprovedAction({ proposalId: h.proposalId });
    expect(executed).toEqual(["first-gate:x"]);
    // Continuing reaches the second gate, which is held — not released by the first approval.
    const second = await advanceGoal({
      goal: "full-pipeline",
      input: { text: "x" },
      actor: AGENT,
      trajectoryId: first.trajectory.trajectoryId,
    });
    expect(second.held).toBeDefined();
    expect(second.held!.proposalId).not.toBe(h.proposalId);
    expect(executed).toEqual(["first-gate:x"]);
  });

  it("never executes an approved proposal that is for another tool than the step", async () => {
    const h = await hold("translate");
    // An approval forged for another tool under this step's operation.
    await proposals.decide(h.proposalId, "superseded", "test");
    const forged = await proposals.create({
      operationId: `op_${h.trajectoryId}_0`,
      sessionId: h.trajectoryId,
      trajectoryId: h.trajectoryId,
      label: "something-else",
      actor: AGENT,
      effects: ["restricted"],
      effectiveRisk: "restricted",
      payload: { text: "benign" },
    });
    await proposals.decide(forged.proposalId, "approved", "user-1");
    await expect(
      advanceGoal({
        goal: "translate",
        input: {},
        actor: AGENT,
        trajectoryId: h.trajectoryId,
      })
    ).rejects.toBeInstanceOf(ApprovalMismatchError);
    expect(executed).toEqual([]);
    expect((await trajectories.getById(h.trajectoryId))!.trajectory.status).toBe(
      "failed"
    );
  });
});

describe("the pipeline commits only what was approved", () => {
  async function approvedProposal(): Promise<ProposalRecord> {
    const h = await hold();
    return (await approveHeldAction({ proposalId: h.proposalId, decidedBy: "user-1" }))
      .proposal!;
  }

  function commit(p: ProposalRecord, label: string, input?: Record<string, unknown>) {
    return executeActionPipeline({
      spec: {
        type: label,
        effects: ["restricted"],
        declaredRisk: "restricted",
        ephemeral: false,
        commutative: false,
      },
      actor: AGENT,
      sessionId: p.sessionId,
      operationId: p.operationId,
      label,
      cost: 0,
      boundary: "commitment",
      stateStore: undefined as never,
      trajectoryStore: trajectories,
      trajectoryId: p.trajectoryId,
      stepIndex: 0,
      expectedVersion: 0,
      perform: async () => {
        executed.push(`pipeline:${label}`);
        return {};
      },
      computeNextState: null,
      approvedProposalId: p.proposalId,
      proposalStore: proposals,
      approvalInput: input,
    });
  }

  it.each([
    ["another action", "other-restricted", { text: "benign" }],
    ["another input", "publish", { text: "EVIL" }],
    ["no input at all", "publish", undefined],
  ])("refuses %s under an approval", async (_label, label, input) => {
    const p = await approvedProposal();
    await expect(commit(p, label, input)).rejects.toBeInstanceOf(PipelineRejectedError);
    expect(executed).toEqual([]);
  });

  it("commits the approved action with its approved input", async () => {
    const p = await approvedProposal();
    await commit(p, "publish", { text: "benign" });
    expect(executed).toEqual(["pipeline:publish"]);
  });
});

describe("canonicalJson — what the approval comparison compares", () => {
  it("ignores key order at every depth", () => {
    expect(canonicalJson({ a: 1, b: { c: 2, d: [1, { e: 3, f: 4 }] } })).toBe(
      canonicalJson({ b: { d: [1, { f: 4, e: 3 }], c: 2 }, a: 1 })
    );
  });

  it("tells apart values a durable store keeps apart (Dates by their time)", () => {
    expect(canonicalJson({ when: new Date(0) })).not.toBe(
      canonicalJson({ when: new Date(9e12) })
    );
    expect(canonicalJson({ when: new Date(0) })).not.toBe(canonicalJson({ when: {} }));
    expect(canonicalJson({ a: "1" })).not.toBe(canonicalJson({ a: 1 }));
  });
});

describe("one approval releases one step, once", () => {
  it("runs the step once when resumes race on one approval", async () => {
    const h = await hold("translate", "benign");
    await approveHeldAction({ proposalId: h.proposalId, decidedBy: "user-1" });
    const results = await Promise.allSettled([
      resumeApprovedAction({ proposalId: h.proposalId }),
      resumeApprovedAction({ proposalId: h.proposalId }),
      advanceGoal({
        goal: "translate",
        input: {},
        actor: AGENT,
        trajectoryId: h.trajectoryId,
      }),
    ]);
    expect(executed).toEqual(["publish:benign"]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await proposals.getById(h.proposalId))?.status).toBe("executed");
    const t = await trajectories.getById(h.trajectoryId);
    expect(t!.trajectory.steps.filter((s) => s.boundary === "commitment")).toHaveLength(
      1
    );
    // The losing calls were refused, not turned into a new hold.
    expect(
      await proposals.query({ operationId: `op_${h.trajectoryId}_0`, status: "proposed" })
    ).toEqual([]);
  });

  it("never re-holds a step whose approval arrives while a continuation is deciding to hold", async () => {
    const h = await hold("translate", "benign");
    // The continuation finds no approval, gets requires-approval and checks that the step has
    // not run; then, before it can propose, the owner approves and the step runs. Simulated by
    // approving and running inside the continuation's last check (its query for a used approval).
    let raced = false;
    const realQuery = proposals.query.bind(proposals);
    jest.spyOn(proposals, "query").mockImplementation(async (q) => {
      if (!raced && q.status === "executed") {
        raced = true;
        const before = await realQuery(q);
        await approveHeldAction({ proposalId: h.proposalId, decidedBy: "user-1" });
        await resumeApprovedAction({ proposalId: h.proposalId });
        return before;
      }
      return realQuery(q);
    });
    await expect(
      advanceGoal({
        goal: "translate",
        input: {},
        actor: AGENT,
        trajectoryId: h.trajectoryId,
      })
    ).rejects.toBeInstanceOf(HeldActionNotApprovedError);
    expect(executed).toEqual(["publish:benign"]);
    expect(
      await realQuery({ operationId: `op_${h.trajectoryId}_0`, status: "proposed" })
    ).toEqual([]);
    expect((await trajectories.getById(h.trajectoryId))!.trajectory.status).toBe(
      "completed"
    );
  });

  it("the store keeps one open, approved or used proposal per operation (as the database index)", async () => {
    const h = await hold();
    const again = {
      operationId: `op_${h.trajectoryId}_0`,
      sessionId: h.trajectoryId,
      trajectoryId: h.trajectoryId,
      label: "publish",
      actor: AGENT,
      effects: ["restricted" as const],
      effectiveRisk: "restricted" as const,
    };
    await expect(proposals.create(again)).rejects.toThrow(/already has/);
    await approveHeldAction({ proposalId: h.proposalId, decidedBy: "user-1" });
    await expect(proposals.create(again)).rejects.toThrow(/already has/);
    await resumeApprovedAction({ proposalId: h.proposalId });
    await expect(proposals.create(again)).rejects.toThrow(/already has/);
  });

  it("an approval recorded after a concurrent continuation completed the workflow leaves it completed", async () => {
    const h = await hold();
    const real = proposals.decide.bind(proposals);
    jest.spyOn(proposals, "decide").mockImplementationOnce(async (...a) => {
      const decided = await real(...a);
      await advanceGoal({
        goal: "translate",
        input: {},
        actor: AGENT,
        trajectoryId: h.trajectoryId,
      });
      return decided;
    });
    await approveHeldAction({ proposalId: h.proposalId, decidedBy: "user-1" });
    expect((await trajectories.getById(h.trajectoryId))!.trajectory.status).toBe(
      "completed"
    );
    expect(executed).toEqual(["publish:benign"]);
  });

  it("refuses to replay an approval to drive later steps", async () => {
    registerWorkflow(
      workflow("transcribe", [
        ["gate", true],
        ["after-1", false],
        ["after-2", false],
      ])
    );
    const h = await hold("transcribe", "t");
    await approveHeldAction({ proposalId: h.proposalId, decidedBy: "user-1" });
    await resumeApprovedAction({ proposalId: h.proposalId });
    expect(executed).toEqual(["gate:t"]);
    await expect(
      resumeApprovedAction({ proposalId: h.proposalId })
    ).rejects.toBeInstanceOf(HeldActionNotApprovedError);
    expect(executed).toEqual(["gate:t"]);
  });

  it("refuses to continue a trajectory whose held action was rejected (no re-proposing)", async () => {
    const h = await hold();
    await rejectHeldAction({ proposalId: h.proposalId, decidedBy: "user-1" });
    await expect(
      advanceGoal({
        goal: "translate",
        input: { text: "again" },
        actor: AGENT,
        trajectoryId: h.trajectoryId,
      })
    ).rejects.toBeInstanceOf(TrajectoryAccessError);
    expect(
      await proposals.query({ operationId: `op_${h.trajectoryId}_0`, status: "proposed" })
    ).toEqual([]);
  });

  it("refuses to continue a failed trajectory (a refused or rejected workflow is over)", async () => {
    const h = await hold();
    await trajectories.updateStatus(h.trajectoryId, "failed");
    await expect(
      advanceGoal({
        goal: "translate",
        input: { text: "x" },
        actor: AGENT,
        trajectoryId: h.trajectoryId,
      })
    ).rejects.toBeInstanceOf(TrajectoryAccessError);
  });
});

describe("trajectory ownership", () => {
  it("scopes a delegated agent's trajectory to the user it acts for", async () => {
    const h = await hold();
    const t = await trajectories.getById(h.trajectoryId);
    expect(t).toMatchObject({ scopeType: "user", scopeId: "user-1" });
  });

  it.each([
    ["another user's agent", { ...AGENT, onBehalfOf: "user-2" }],
    ["another user", { ...OWNER, actorId: "user-2" }],
    ["an agent acting for nobody", { ...AGENT, onBehalfOf: undefined }],
  ])(
    "refuses %s continuing the trajectory, as if it did not exist",
    async (_label, actor) => {
      const h = await hold();
      await expect(
        advanceGoal({
          goal: "translate",
          input: { text: "x" },
          actor: actor as AgentIdentity,
          trajectoryId: h.trajectoryId,
        })
      ).rejects.toThrow(`trajectory not found: ${h.trajectoryId}`);
    }
  );

  it("refuses a delegated agent continuing a platform-scoped trajectory (one from before 5.1)", async () => {
    const legacy = await trajectories.create(
      { kind: "agent", id: AGENT.actorId },
      "translate",
      "platform"
    );
    await expect(
      advanceGoal({
        goal: "translate",
        input: { text: "x" },
        actor: AGENT,
        trajectoryId: legacy.trajectory.trajectoryId,
      })
    ).rejects.toBeInstanceOf(TrajectoryAccessError);
  });

  it("lets the owner's agent continue its own trajectory", async () => {
    registerWorkflow(
      workflow("transcribe", [
        ["one", false],
        ["two", false],
      ])
    );
    const first = await advanceGoal({
      goal: "transcribe",
      input: { text: "a" },
      actor: AGENT,
    });
    await advanceGoal({
      goal: "transcribe",
      input: { text: "a" },
      actor: { ...AGENT, sessionId: "another-session" },
      trajectoryId: first.trajectory.trajectoryId,
    });
    expect(executed).toEqual(["one:a", "two:a"]);
  });
});

describe("who may decide a held action (heldActionRefusal)", () => {
  async function proposal(actor: AgentIdentity = AGENT): Promise<ProposalRecord> {
    return proposals.create({
      operationId: `op_${generateSecureId()}`,
      sessionId: "s",
      trajectoryId: "t",
      label: "publish",
      actor,
      effects: ["restricted"],
      effectiveRisk: "restricted",
    });
  }
  const agentPolicy: ApprovalPolicy = { version: 2, default: "agent", rules: [] };

  it("lets the owner approve through their own session", async () => {
    expect(heldActionRefusal(await proposal(), OWNER, "approve")).toBeNull();
  });

  it.each([
    ["no proposal", undefined, OWNER],
    ["another user", "own", { ...OWNER, actorId: "user-2" }],
    ["a proposal with no owner (a row from before migration 046)", "legacy", OWNER],
  ])("answers %s as not found", async (_label, kind, decider) => {
    const p =
      kind === undefined
        ? undefined
        : kind === "legacy"
          ? await proposal({
              actorType: "agent",
              actorId: "agent:conductor",
              agentRole: "c",
            })
          : await proposal();
    expect(heldActionRefusal(p, decider as AgentIdentity, "approve")).toBe("not_found");
    expect(heldActionRefusal(p, decider as AgentIdentity, "reject")).toBe("not_found");
  });

  it("refuses a decision on a closed proposal", async () => {
    const p = await proposal();
    const decided = await proposals.decide(p.proposalId, "approved", "user-1");
    expect(heldActionRefusal(decided, OWNER, "approve")).toBe("not_open");
    expect(heldActionRefusal(decided, OWNER, "reject")).toBe("not_open");
  });

  it("refuses the proposing agent approving its own action, even where agents may approve", async () => {
    expect(heldActionRefusal(await proposal(), AGENT, "approve", agentPolicy)).toBe(
      "self_approval"
    );
  });

  it("refuses an agent that drops its delegation and approves as the user through the same session", async () => {
    const stripped: AgentIdentity = {
      actorType: "user",
      actorId: "user-1",
      agentRole: "none",
      sessionId: AGENT.sessionId,
    };
    expect(heldActionRefusal(await proposal(), stripped, "approve")).toBe(
      "self_approval"
    );
  });

  it("refuses a decider whose session is unknown when the proposer's is known", async () => {
    const noSession: AgentIdentity = {
      actorType: "user",
      actorId: "user-1",
      agentRole: "none",
    };
    expect(heldActionRefusal(await proposal(), noSession, "approve")).toBe(
      "approver_not_allowed"
    );
  });

  it("refuses an approver of a kind the policy does not name", async () => {
    const otherAgent: AgentIdentity = {
      ...AGENT,
      actorId: "agent:other",
      sessionId: "s2",
    };
    expect(heldActionRefusal(await proposal(), otherAgent, "approve")).toBe(
      "approver_not_allowed"
    );
    expect(heldActionRefusal(await proposal(), OWNER, "approve", agentPolicy)).toBe(
      "approver_not_allowed"
    );
    expect(
      heldActionRefusal(await proposal(), otherAgent, "approve", agentPolicy)
    ).toBeNull();
  });

  it("lets the owner — or the proposing agent itself — reject", async () => {
    expect(heldActionRefusal(await proposal(), OWNER, "reject")).toBeNull();
    expect(heldActionRefusal(await proposal(), AGENT, "reject")).toBeNull();
  });

  it("refuses approval through the session the action was proposed through, whoever proposed it", async () => {
    // An agent given the user's session can propose as the user (no delegation token) and then
    // approve as the user: the same session shows no second party.
    expect(heldActionRefusal(await proposal(OWNER), OWNER, "approve")).toBe(
      "self_approval"
    );
    const elsewhere = { ...OWNER, sessionId: "another-sign-in" };
    expect(heldActionRefusal(await proposal(OWNER), elsewhere, "approve")).toBeNull();
  });

  it("refuses approval when the proposer's session is unknown (independence cannot be shown)", async () => {
    const noSession: AgentIdentity = { ...AGENT, sessionId: undefined };
    expect(heldActionRefusal(await proposal(noSession), OWNER, "approve")).toBe(
      "approver_not_allowed"
    );
    expect(heldActionRefusal(await proposal(noSession), OWNER, "reject")).toBeNull();
  });

  it("principalOf: the user an agent acts for, a user, or nobody", () => {
    expect(principalOf(AGENT)).toBe("user-1");
    expect(principalOf(OWNER)).toBe("user-1");
    // A user is themselves: a claimed onBehalfOf is ignored.
    expect(principalOf({ ...OWNER, onBehalfOf: "victim" })).toBe("user-1");
    // An attested delegation must agree with the claim.
    expect(
      principalOf({
        ...AGENT,
        onBehalfOf: "victim",
        delegation: { onBehalfOf: "user-1", scope: [], method: "oauth2.1-pkce" },
      })
    ).toBeUndefined();
    expect(
      principalOf({
        ...AGENT,
        delegation: { onBehalfOf: "user-1", scope: [], method: "oauth2.1-pkce" },
      })
    ).toBe("user-1");
    expect(principalOf({ ...AGENT, onBehalfOf: "" })).toBeUndefined();
    expect(principalOf({ ...OWNER, actorId: "" })).toBeUndefined();
    expect(
      principalOf({ actorType: "system", actorId: "s", agentRole: "s" })
    ).toBeUndefined();
  });
});

describe("rejectHeldAction reports whether it decided", () => {
  it("returns the rejected record, and nothing when the action was already decided", async () => {
    const h = await hold();
    await approveHeldAction({ proposalId: h.proposalId, decidedBy: "user-1" });
    expect(
      await rejectHeldAction({ proposalId: h.proposalId, decidedBy: "user-1" })
    ).toBeUndefined();

    const h2 = await hold("speak");
    const rejected = await rejectHeldAction({
      proposalId: h2.proposalId,
      decidedBy: "user-1",
    });
    expect(rejected?.status).toBe("rejected");
  });
});
