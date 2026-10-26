/**
 * @jest-environment node
 */
/**
 * TASK-170 on the replayed database: an approved workflow step whose run failed before taking
 * effect waits in `awaiting_retry` (migration 053) and is resumed by approving it again — once,
 * under concurrent approvals; an undecided run blocks the workflow until decided; a withdrawal
 * ends it. The in-memory cases are platform/agents/__tests__/held-action-retry.test.ts; these run
 * the same loop over PostgresProposalStore and PostgresTrajectoryStore, in a tenant.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req",
}));

import {
  advanceGoal,
  HeldActionNotApprovedError,
  registerWorkflow,
  resetWorkflowRegistry,
  resumeApprovedAction,
  runGoal,
  TrajectoryAccessError,
  type WorkflowDefinition,
} from "@/platform/agents/workflow-loop";
import {
  approveHeldAction,
  resolveUndecidedHeldAction,
  withdrawHeldAction,
} from "@/platform/agents/gating";
import { PostgresProposalStore } from "@/platform/agents/postgres-proposal-store";
import { PostgresTrajectoryStore } from "@/platform/agents/postgres-trajectory-store";
import { setProposalStore } from "@/platform/agents/proposal-store";
import { setTrajectoryStore } from "@/platform/agents/trajectory-store";
import {
  InMemoryApprovalPolicyStore,
  setApprovalPolicyStore,
} from "@/platform/agents/approval-policy-store";
import { ApprovedRunFailedError } from "@/platform/action-pipeline";
import { withOwnerTx, withTenantTx } from "@/platform/data";
import { recoverStaleRuns } from "@/platform/admin/hold-expiry";
import type {
  AgentIdentity,
  ProposalStore,
  Tool,
  TrajectoryStore,
} from "@/platform/kernel";
import { withModules, WORKFLOW_GOALS_FIXTURE } from "../helpers/modules";
import { hooked, signal } from "../helpers/interleave";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  DB_ENABLED,
  type TestTenant,
} from "../helpers/db";

withModules([WORKFLOW_GOALS_FIXTURE]);

const AGENT: AgentIdentity = {
  actorType: "agent",
  actorId: "agent:conductor",
  agentRole: "conductor",
  onBehalfOf: "user-1",
  sessionId: "session-agent",
};

const executed: string[] = [];
let failNext = 0;

function tool(id: string, gated: boolean): Tool {
  return {
    id,
    name: id,
    description: id,
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    outputSchema: { type: "object", properties: { text: { type: "string" } } },
    effects: gated ? ["restricted"] : [],
    declaredRisk: gated ? "restricted" : "ordinary",
    execute: async (input) => {
      if (gated && failNext > 0) {
        failNext -= 1;
        throw new Error("upstream blip");
      }
      await new Promise((r) => setTimeout(r, 5));
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

let t: TestTenant;
let proposals: PostgresProposalStore;
let trajectories: PostgresTrajectoryStore;
let restore: [ProposalStore, TrajectoryStore] | undefined;

if (DB_ENABLED) {
  beforeAll(connectTestDatabase);
  afterAll(async () => {
    if (restore) {
      setProposalStore(restore[0]);
      setTrajectoryStore(restore[1]);
    }
    await dropTestTenants();
    await disconnectTestDatabase();
  });
  beforeEach(async () => {
    t = await createTestTenant();
    executed.length = 0;
    failNext = 0;
    resetWorkflowRegistry();
    registerWorkflow(workflow("translate", [["publish", true]]));
    proposals = new PostgresProposalStore();
    trajectories = new PostgresTrajectoryStore();
    const previous: [ProposalStore, TrajectoryStore] = [
      setProposalStore(proposals),
      setTrajectoryStore(trajectories),
    ];
    restore ??= previous;
    setApprovalPolicyStore(new InMemoryApprovalPolicyStore());
  });
  afterEach(() => jest.restoreAllMocks());
}

const status = (id: string) =>
  t.run(async () => (await trajectories.getById(id))?.trajectory.status);

async function heldAndApproved() {
  const r = await t.run(() =>
    runGoal({ goal: "translate", input: { text: "benign" }, actor: AGENT })
  );
  const proposalId = r.held!.proposalId;
  await t.run(() => approveHeldAction({ proposalId, decidedBy: "user-1" }));
  return { proposalId, trajectoryId: r.trajectory.trajectoryId };
}

async function keptApproval() {
  const h = await heldAndApproved();
  failNext = 1;
  const err = await t
    .run(() => resumeApprovedAction({ proposalId: h.proposalId }))
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApprovedRunFailedError);
  expect(err).toMatchObject({ released: true });
  return h;
}

dbDescribe("TASK-170 on Postgres: approving again retries a kept approval", () => {
  it("the trajectory row is awaiting_retry; its agent's continuation runs nothing", async () => {
    const { proposalId, trajectoryId } = await keptApproval();
    expect(await status(trajectoryId)).toBe("awaiting_retry");
    const rows = await t.run(() =>
      withTenantTx(
        async (tx) =>
          (
            await tx.query("select status::text from agent_trajectories where id = $1", [
              trajectoryId,
            ])
          ).rows
      )
    );
    expect(rows).toEqual([{ status: "awaiting_retry" }]);
    const r = await t.run(() =>
      advanceGoal({ goal: "translate", input: {}, actor: AGENT, trajectoryId })
    );
    expect(r.held).toMatchObject({ proposalId, awaiting: "retry" });
    expect(executed).toEqual([]);
  });

  it("concurrent re-approvals resume it once, and it completes", async () => {
    const { proposalId, trajectoryId } = await keptApproval();
    const results = await Promise.allSettled(
      [1, 2, 3, 4].map(() => t.run(() => resumeApprovedAction({ proposalId })))
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results)
      if (r.status === "rejected")
        expect(r.reason).toBeInstanceOf(HeldActionNotApprovedError);
    expect(executed).toEqual(["publish:benign"]);
    expect(await status(trajectoryId)).toBe("completed");
    expect((await t.run(() => proposals.getById(proposalId)))?.status).toBe("executed");
    const commits = await t.run(async () =>
      (await trajectories.getById(trajectoryId))!.trajectory.steps.filter(
        (s) => s.boundary === "commitment"
      )
    );
    expect(commits).toHaveLength(1);
  });

  it("a withdrawal ends it: failed, recorded, never continued", async () => {
    const { proposalId, trajectoryId } = await keptApproval();
    expect(
      (await t.run(() => withdrawHeldAction({ proposalId, decidedBy: "user-1" })))?.status
    ).toBe("rejected");
    expect(await status(trajectoryId)).toBe("failed");
    await expect(
      t.run(() =>
        advanceGoal({ goal: "translate", input: {}, actor: AGENT, trajectoryId })
      )
    ).rejects.toBeInstanceOf(TrajectoryAccessError);
    await expect(
      t.run(() => resumeApprovedAction({ proposalId }))
    ).rejects.toBeInstanceOf(HeldActionNotApprovedError);
    expect(executed).toEqual([]);
  });

  it("an undecided run blocks it until decided; approved again, it runs once", async () => {
    const { proposalId, trajectoryId } = await heldAndApproved();
    failNext = 1;
    jest.spyOn(proposals, "release").mockRejectedValueOnce(new Error("db down"));
    const err = await t
      .run(() => resumeApprovedAction({ proposalId }))
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "ApprovedRunFailedError", released: false });
    expect(await status(trajectoryId)).toBe("indeterminate");
    await expect(
      t.run(() => resumeApprovedAction({ proposalId }))
    ).rejects.toBeInstanceOf(HeldActionNotApprovedError);

    // The job's recovery, as the job runs it, past a 1-minute lease: undecided.
    await withOwnerTx("platform-job", async (tx) => {
      await tx.query(
        "update proposals set updated_at = now() - interval '5 minutes' where id = $1::uuid",
        [proposalId]
      );
      return recoverStaleRuns(tx, 60, { tenantIds: [t.id] });
    });
    const waiting = await t.run(() =>
      advanceGoal({ goal: "translate", input: {}, actor: AGENT, trajectoryId })
    );
    expect(waiting.held).toMatchObject({ proposalId, awaiting: "outcome" });

    await t.run(() =>
      resolveUndecidedHeldAction({
        proposalId,
        resolution: "approved",
        decidedBy: "user-1",
      })
    );
    expect(await status(trajectoryId)).toBe("awaiting_retry");
    const results = await Promise.allSettled(
      [1, 2].map(() => t.run(() => resumeApprovedAction({ proposalId })))
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(executed).toEqual(["publish:benign"]);
    expect(await status(trajectoryId)).toBe("completed");
  });

  it("an undecided run marked executed ends the workflow", async () => {
    const { proposalId, trajectoryId } = await heldAndApproved();
    failNext = 1;
    jest.spyOn(proposals, "release").mockRejectedValueOnce(new Error("db down"));
    await t.run(() => resumeApprovedAction({ proposalId })).catch(() => undefined);
    await withOwnerTx("platform-job", async (tx) => {
      await tx.query(
        "update proposals set updated_at = now() - interval '5 minutes' where id = $1::uuid",
        [proposalId]
      );
      return recoverStaleRuns(tx, 60, { tenantIds: [t.id] });
    });
    await t.run(() =>
      resolveUndecidedHeldAction({
        proposalId,
        resolution: "executed",
        decidedBy: "user-1",
      })
    );
    expect(await status(trajectoryId)).toBe("failed");
    await expect(
      t.run(() =>
        advanceGoal({ goal: "translate", input: {}, actor: AGENT, trajectoryId })
      )
    ).rejects.toBeInstanceOf(TrajectoryAccessError);
  });

  it("retention keeps a trajectory awaiting a retry", async () => {
    const { trajectoryId } = await keptApproval();
    await withOwnerTx("platform-job", (tx) =>
      tx.query(
        "update agent_trajectories set updated_at = now() - interval '400 days' where id = $1::uuid",
        [trajectoryId]
      )
    );
    await t.run(() => trajectories.deleteFinishedBefore(new Date(), 100));
    expect(await status(trajectoryId)).toBe("awaiting_retry");
  });
});

/** Held, approved, its run claimed — and the instance lost: the lease lapses with no end. */
dbDescribe(
  "TASK-175 on Postgres: concurrent resumes — the approval's claim decides",
  () => {
    beforeEach(() => {
      registerWorkflow(
        workflow("full-pipeline", [
          ["gate", true],
          ["after", false],
        ])
      );
    });

    /** Held, approved, its first run failed before taking effect: the approval kept. */
    async function kept(goal: WorkflowDefinition["goal"]) {
      const r = await t.run(() =>
        runGoal({ goal, input: { text: "benign" }, actor: AGENT })
      );
      const proposalId = r.held!.proposalId;
      await t.run(() => approveHeldAction({ proposalId, decidedBy: "user-1" }));
      failNext = 1;
      await t.run(() => resumeApprovedAction({ proposalId })).catch(() => undefined);
      return { proposalId, trajectoryId: r.trajectory.trajectoryId };
    }

    /** B passes resumeApprovedAction's checks; A then claims, runs and completes; then B reads on. */
    async function checkedThenOvertaken(goal: WorkflowDefinition["goal"]) {
      const { proposalId, trajectoryId } = await kept(goal);
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
      const [ra, rb] = await t.run(() => {
        const a = resumeApprovedAction({ proposalId, proposalStore: aProposals });
        void a.finally(() => aDone.open()).catch(() => undefined);
        const b = resumeApprovedAction({ proposalId, trajectoryStore: bTrajectories });
        return Promise.allSettled([a, b]);
      });
      return { proposalId, trajectoryId, ra, rb };
    }

    it("checked, then overtaken before its run: refused, not answered with A's completion", async () => {
      const { proposalId, trajectoryId, ra, rb } =
        await checkedThenOvertaken("translate");
      expect(ra).toMatchObject({ status: "fulfilled" });
      expect((rb as PromiseRejectedResult).reason).toBeInstanceOf(
        HeldActionNotApprovedError
      );
      expect(executed).toEqual(["publish:benign"]);
      expect(await status(trajectoryId)).toBe("completed");
      expect((await t.run(() => proposals.getById(proposalId)))?.status).toBe("executed");
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
      const { proposalId, trajectoryId } = await kept("translate");
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
      const [ra, rb] = await t.run(() => {
        const a = resumeApprovedAction({ proposalId, proposalStore: aProposals });
        void a.finally(() => aDone.open()).catch(() => undefined);
        const b = resumeApprovedAction({ proposalId, proposalStore: bProposals });
        return Promise.allSettled([a, b]);
      });
      expect(ra).toMatchObject({ status: "fulfilled" });
      expect((rb as PromiseRejectedResult).reason).toBeInstanceOf(
        HeldActionNotApprovedError
      );
      expect(executed).toEqual(["publish:benign"]);
      expect(await status(trajectoryId)).toBe("completed");
      expect((await t.run(() => proposals.getById(proposalId)))?.status).toBe("executed");
    });

    it("the concurrent test, 50 times: one runs, the others are refused, every time", async () => {
      for (let n = 0; n < 50; n += 1) {
        executed.length = 0;
        const { proposalId, trajectoryId } = await kept("translate");
        const results = await Promise.allSettled(
          [1, 2, 3, 4].map(() => t.run(() => resumeApprovedAction({ proposalId })))
        );
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        for (const r of results)
          if (r.status === "rejected")
            expect(r.reason).toBeInstanceOf(HeldActionNotApprovedError);
        expect(executed).toEqual(["publish:benign"]);
        expect(await status(trajectoryId)).toBe("completed");
      }
    }, 120_000);

    it("a status compare-and-set: moved only from the statuses named, under the row lock", async () => {
      const { trajectoryId } = await kept("translate");
      expect(
        await t.run(() =>
          trajectories.updateStatus(trajectoryId, "failed", { from: ["indeterminate"] })
        )
      ).toBeUndefined();
      expect(await status(trajectoryId)).toBe("awaiting_retry");
      const moved = await t.run(() =>
        Promise.all(
          [1, 2, 3].map(() =>
            trajectories.updateStatus(trajectoryId, "running", {
              from: ["awaiting_retry"],
            })
          )
        )
      );
      expect(moved.filter((m) => m !== undefined)).toHaveLength(1);
      expect(await status(trajectoryId)).toBe("running");
    });

    it("withdrawn while a run finishes the workflow: the end is not written over it", async () => {
      const { proposalId, trajectoryId } = await kept("translate");
      const store = hooked(trajectories, {
        addStep: async (...args: Parameters<PostgresTrajectoryStore["addStep"]>) => {
          const added = await trajectories.addStep(...args);
          await trajectories.updateStatus(trajectoryId, "completed");
          return added;
        },
      });
      await t.run(() =>
        withdrawHeldAction({ proposalId, decidedBy: "user-1", trajectoryStore: store })
      );
      expect(await status(trajectoryId)).toBe("completed");
    });
  }
);

async function lostMidRun(atomic = false) {
  const h = await heldAndApproved();
  expect((await t.run(() => proposals.claim(h.proposalId, { atomic })))?.status).toBe(
    "executing"
  );
  expect(await status(h.trajectoryId)).toBe("running");
  await withOwnerTx("platform-job", async (tx) => {
    await tx.query(
      "update proposals set updated_at = now() - interval '5 minutes' where id = $1::uuid",
      [h.proposalId]
    );
    return recoverStaleRuns(tx, 60, { tenantIds: [t.id] });
  });
  return h;
}

const recoveryAudit = (proposalId: string) =>
  withOwnerTx("platform-job", async (tx) =>
    (
      await tx.query<{ details: Record<string, unknown> }>(
        `select details from audit_log
          where tenant_id = $1::uuid and details->>'type' = 'approval_run_recovered'
            and details->>'holdId' = $2`,
        [t.id, proposalId]
      )
    ).rows.map((r) => r.details)
  );

const proposedAgain = (trajectoryId: string) =>
  t.run(() =>
    proposals.query({ operationId: `op_${trajectoryId}_0`, status: "proposed" })
  );

dbDescribe(
  "TASK-173 on Postgres: an instance lost mid-run leaves its workflow waiting",
  () => {
    it("undecided: the recovery moves the trajectory to indeterminate, audited, in its statement", async () => {
      const { proposalId, trajectoryId } = await lostMidRun();
      expect((await t.run(() => proposals.getById(proposalId)))?.status).toBe(
        "indeterminate"
      );
      expect(await status(trajectoryId)).toBe("indeterminate");
      expect(await recoveryAudit(proposalId)).toEqual([
        expect.objectContaining({
          status: "indeterminate",
          trajectoryId,
          trajectoryFrom: "running",
          trajectoryStatus: "indeterminate",
        }),
      ]);
      const r = await t.run(() =>
        advanceGoal({
          goal: "translate",
          input: { text: "EVIL" },
          actor: AGENT,
          trajectoryId,
        })
      );
      expect(r.held).toMatchObject({ proposalId, awaiting: "outcome" });
      expect(r.trajectory.status).toBe("indeterminate");
      await expect(
        t.run(() => resumeApprovedAction({ proposalId }))
      ).rejects.toBeInstanceOf(HeldActionNotApprovedError);
      expect(await proposedAgain(trajectoryId)).toEqual([]);
      expect(executed).toEqual([]);
    });

    it("approved again by a person, then resumed: it runs once and completes", async () => {
      const { proposalId, trajectoryId } = await lostMidRun();
      await t.run(() =>
        resolveUndecidedHeldAction({
          proposalId,
          resolution: "approved",
          decidedBy: "user-1",
        })
      );
      expect(await status(trajectoryId)).toBe("awaiting_retry");
      const results = await Promise.allSettled([
        t.run(() => resumeApprovedAction({ proposalId })),
        t.run(() => resumeApprovedAction({ proposalId })),
        t.run(() =>
          advanceGoal({ goal: "translate", input: {}, actor: AGENT, trajectoryId })
        ),
      ]);
      expect(results.slice(0, 2).filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(executed).toEqual(["publish:benign"]);
      expect(await status(trajectoryId)).toBe("completed");
      expect((await t.run(() => proposals.getById(proposalId)))?.status).toBe("executed");
    });

    it("atomic: approved again and the trajectory awaiting_retry; held awaiting a retry, then runs once", async () => {
      const { proposalId, trajectoryId } = await lostMidRun(true);
      expect((await t.run(() => proposals.getById(proposalId)))?.status).toBe("approved");
      expect(await status(trajectoryId)).toBe("awaiting_retry");
      expect(await recoveryAudit(proposalId)).toEqual([
        expect.objectContaining({
          status: "approved",
          trajectoryFrom: "running",
          trajectoryStatus: "awaiting_retry",
        }),
      ]);
      const r = await t.run(() =>
        advanceGoal({ goal: "translate", input: {}, actor: AGENT, trajectoryId })
      );
      expect(r.held).toMatchObject({ proposalId, awaiting: "retry" });
      expect(executed).toEqual([]);
      const resumed = await t.run(() => resumeApprovedAction({ proposalId }));
      expect(resumed.trajectory.status).toBe("completed");
      expect(executed).toEqual(["publish:benign"]);
    });

    it("a finished trajectory is not moved; the audit records none moved", async () => {
      const h = await heldAndApproved();
      await t.run(() => proposals.claim(h.proposalId));
      await t.run(() => trajectories.updateStatus(h.trajectoryId, "failed"));
      await withOwnerTx("platform-job", async (tx) => {
        await tx.query(
          "update proposals set updated_at = now() - interval '5 minutes' where id = $1::uuid",
          [h.proposalId]
        );
        return recoverStaleRuns(tx, 60, { tenantIds: [t.id] });
      });
      expect(await status(h.trajectoryId)).toBe("failed");
      expect(await recoveryAudit(h.proposalId)).toEqual([
        expect.objectContaining({ status: "indeterminate", trajectoryId: null }),
      ]);
    });

    it("a trajectory left running by another path: the continuation still answers held (defence in depth)", async () => {
      const { proposalId, trajectoryId } = await lostMidRun();
      await withOwnerTx("platform-job", (tx) =>
        tx.query("update agent_trajectories set status = 'running' where id = $1::uuid", [
          trajectoryId,
        ])
      );
      const r = await t.run(() =>
        advanceGoal({ goal: "translate", input: {}, actor: AGENT, trajectoryId })
      );
      expect(r.held).toMatchObject({ proposalId, awaiting: "outcome" });
      expect(await status(trajectoryId)).toBe("indeterminate");
      expect(await proposedAgain(trajectoryId)).toEqual([]);
      expect(executed).toEqual([]);
    });
  }
);
