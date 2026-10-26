/**
 * Review 16 (TASK-175 follow-up): a resume's checks before its claim are read-then-act. A resume
 * that passed them, then lost to a concurrent resume that ran and completed the step, used to be
 * refused by its budget check — and to write `paused` unconditionally over the winner's
 * `completed`. Now every status write on a resume path is a compare-and-set from the open
 * statuses: the loser is refused (HeldActionNotApprovedError) and the winner's status stands.
 * And a resume is refused on a store that does not declare it honours `from` (L6).
 */

import {
  HeldActionNotApprovedError,
  registerWorkflow,
  resetWorkflowRegistry,
  resumeApprovedAction,
  runGoal,
  TrajectoryStoreCasError,
  type WorkflowDefinition,
} from "../workflow-loop";
import { approveHeldAction } from "../gating";
import { InMemoryProposalStore, setProposalStore } from "../proposal-store";
import { InMemoryTrajectoryStore, setTrajectoryStore } from "../trajectory-store";
import {
  InMemoryApprovalPolicyStore,
  setApprovalPolicyStore,
} from "../approval-policy-store";
import { ApprovedRunFailedError } from "@/platform/action-pipeline";
import type { AgentIdentity, Tool, TrajectoryStore } from "@/platform/kernel";
import { withModules, WORKFLOW_GOALS_FIXTURE } from "@/__tests__/helpers/modules";
import { hooked, signal } from "@/__tests__/helpers/interleave";
import { getBudgetTracker, setBudgetTracker } from "../budget-tracker";

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

async function keptApproval(goal: WorkflowDefinition["goal"] = "translate") {
  const r = await runGoal({ goal, input: { text: "benign" }, actor: AGENT });
  const proposalId = r.held!.proposalId;
  const trajectoryId = r.trajectory.trajectoryId;
  await approveHeldAction({ proposalId, decidedBy: "user-1" });
  failNext = 1;
  const err = await resumeApprovedAction({ proposalId }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApprovedRunFailedError);
  return { proposalId, trajectoryId };
}
const status = async (id: string) => (await trajectories.getById(id))?.trajectory.status;

it("a loser's budget refusal never overwrites the winner's completed: refused, the workflow stays completed", async () => {
  const { proposalId, trajectoryId } = await keptApproval();
  const real = getBudgetTracker();
  const aAtClaim = signal();
  const bAtBudget = signal();
  const aDone = signal();
  let checks = 0;
  const tracker = new Proxy(real, {
    get(t, key) {
      if (key === "checkBudget")
        return async (...args: unknown[]) => {
          checks += 1;
          if (checks === 2) {
            bAtBudget.open();
            await aDone.wait;
            return { allowed: false };
          }
          return (t.checkBudget as (...a: unknown[]) => Promise<unknown>)(...args);
        };
      const v = Reflect.get(t, key, t);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  setBudgetTracker(tracker as typeof real);
  try {
    const aProposals = hooked(proposals, {
      claim: async (id: string, options?: { readonly atomic?: boolean }) => {
        aAtClaim.open();
        await bAtBudget.wait;
        return proposals.claim(id, options);
      },
    });
    const a = resumeApprovedAction({ proposalId, proposalStore: aProposals });
    void a.finally(() => aDone.open()).catch(() => undefined);
    await aAtClaim.wait;
    const b = resumeApprovedAction({ proposalId });
    const [ra, rb] = await Promise.allSettled([a, b]);
    expect(ra.status).toBe("fulfilled");
    expect(executed).toEqual(["publish:benign"]);
    expect((await proposals.getById(proposalId))?.status).toBe("executed");
    // B refused, and the workflow stays completed.
    expect(await status(trajectoryId)).toBe("completed");
    expect(rb.status).toBe("rejected");
    expect((rb as PromiseRejectedResult).reason).toBeInstanceOf(
      HeldActionNotApprovedError
    );
    expect(checks).toBe(2);
  } finally {
    setBudgetTracker(real);
  }
});

it("a budget refusal on an open workflow still pauses it (the compare-and-set applies)", async () => {
  const { proposalId, trajectoryId } = await keptApproval();
  const real = getBudgetTracker();
  setBudgetTracker(
    new Proxy(real, {
      get(t, key) {
        if (key === "checkBudget") return async () => ({ allowed: false });
        const v = Reflect.get(t, key, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as typeof real
  );
  try {
    const r = await resumeApprovedAction({ proposalId });
    expect(r.trajectory.status).toBe("paused");
    expect(await status(trajectoryId)).toBe("paused");
    expect(executed).toEqual([]);
  } finally {
    setBudgetTracker(real);
  }
});

it("review 16 L6: a resume is refused on a store that does not declare supportsStatusCas", async () => {
  const { proposalId, trajectoryId } = await keptApproval();
  // A consumer store that ignores `from` (fails open): wrapped without the declaration.
  const ignoring: TrajectoryStore = new Proxy(trajectories, {
    get(t, key) {
      if (key === "supportsStatusCas") return undefined;
      if (key === "updateStatus")
        return (id: string, s: Parameters<TrajectoryStore["updateStatus"]>[1]) =>
          t.updateStatus(id, s);
      const v = Reflect.get(t, key, t);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  await expect(
    resumeApprovedAction({ proposalId, trajectoryStore: ignoring })
  ).rejects.toBeInstanceOf(TrajectoryStoreCasError);
  expect(executed).toEqual([]);
  expect((await proposals.getById(proposalId))?.status).toBe("approved");
  expect(await status(trajectoryId)).toBe("awaiting_retry");
  // The platform's own stores declare it.
  expect(trajectories.supportsStatusCas).toBe(true);
});

it("an approval mismatch on a resume fails the workflow only while it is open — never over a status another call settled", async () => {
  const { proposalId, trajectoryId } = await keptApproval();
  // The workflow's step is now another tool: the approval does not cover it.
  resetWorkflowRegistry();
  registerWorkflow(workflow("translate", [["republish", true]]));
  // Another call settled the workflow meanwhile.
  await trajectories.updateStatus(trajectoryId, "completed");
  await expect(resumeApprovedAction({ proposalId })).rejects.toBeInstanceOf(
    HeldActionNotApprovedError
  );
  expect(await status(trajectoryId)).toBe("completed");
  // Open: the mismatch fails it, as before.
  await trajectories.updateStatus(trajectoryId, "awaiting_retry");
  await expect(resumeApprovedAction({ proposalId })).rejects.toThrow(
    "is not for republish"
  );
  expect(await status(trajectoryId)).toBe("failed");
  expect(executed).toEqual([]);
});
