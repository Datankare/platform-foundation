/**
 * @jest-environment node
 */
/**
 * Approved runs and stored-JSON limits on the replayed database (review 10 H2, M5, L10)
 *
 *   M5  The reviewer's proof (review10/__tests__/db/r10-limit-after-perform.db.test.ts): the tool
 *       did its work, then the step write refused the oversized output and the caller was told
 *       nothing was stored. Now the step is stored, saying the output was not kept.
 *   L10 A trajectory row holds at most TRAJECTORY_MAX_STEPS steps and TRAJECTORY_MAX_BYTES: a full
 *       one refuses the next action before it runs.
 *   H2  On Postgres: an atomic run's claim, effect, step and completion are one transaction (a
 *       failure leaves the approval approved and nothing written); a run that never ended is
 *       taken back by the approval-expiry job after its lease — executed when its step was
 *       recorded, undecided otherwise (review 11 H-1: never approved again) — and each recovery
 *       is audited.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { invokeTool } from "@/platform/agents/tool-invoker";
import { PostgresTrajectoryStore } from "@/platform/agents/postgres-trajectory-store";
import { PostgresProposalStore } from "@/platform/agents/postgres-proposal-store";
import { ApprovedRunFailedError } from "@/platform/action-pipeline";
import { withOwnerTx, withTenantTx } from "@/platform/data";
import { recoverStaleRuns, RUN_RECOVERY_ACTOR } from "@/platform/admin/hold-expiry";
import {
  STORED_JSON_MAX_BYTES,
  TRAJECTORY_MAX_STEPS,
} from "@/platform/errors/json-limits";
import type { AgentIdentity, Tool } from "@/platform/kernel";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  DB_ENABLED,
  type TestTenant,
} from "../helpers/db";

let t: TestTenant;
if (DB_ENABLED) {
  beforeAll(connectTestDatabase);
  afterAll(async () => {
    await dropTestTenants();
    await disconnectTestDatabase();
  });
  beforeEach(async () => {
    t = await createTestTenant();
  });
}

const actor: AgentIdentity = { actorType: "agent", actorId: "agent:a1", agentRole: "a" };
const sql = (text: string, values: unknown[] = []) =>
  t.run(() => withTenantTx(async (tx) => (await tx.query(text, values)).rows));

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

dbDescribe(
  "r10 M5: the stored-JSON limit no longer turns a done action into 'nothing stored'",
  () => {
    it("the reviewer's case: the tool's work is done and its step is stored, saying the output was not kept", async () => {
      const sideEffects: string[] = [];
      const store = new PostgresTrajectoryStore();
      await t.run(async () => {
        const traj = await store.create({ kind: "agent", id: "a1" }, "test", "platform");
        const res = await invokeTool({
          tool: tool({
            execute: async () => {
              sideEffects.push("written");
              return { blob: "x".repeat(1_100_000) };
            },
          }),
          input: {},
          actor,
          sessionId: "s",
          trajectoryId: traj.trajectory.trajectoryId,
          stepIndex: 0,
          trajectoryStore: store,
        });
        expect(sideEffects).toEqual(["written"]);
        expect((res.output.blob as string).length).toBe(1_100_000);
        const after = await store.getById(traj.trajectory.trajectoryId);
        expect(after!.trajectory.steps).toHaveLength(1);
        expect(after!.trajectory.steps[0].output).toMatchObject({
          outputNotRecorded: {
            code: "request.json_too_large",
            max: STORED_JSON_MAX_BYTES,
          },
        });
      });
    });
  }
);

dbDescribe("r10 L10: one trajectory row is bounded", () => {
  it(`a trajectory holding ${TRAJECTORY_MAX_STEPS} steps refuses the next action before it runs`, async () => {
    const store = new PostgresTrajectoryStore();
    const traj = await t.run(() =>
      store.create({ kind: "agent", id: "a1" }, "test", "platform")
    );
    const id = traj.trajectory.trajectoryId;
    await sql(
      `update agent_trajectories
          set steps = (select jsonb_agg(jsonb_build_object('stepIndex', i, 'action', 'a'))
                         from generate_series(1, $2::int) i)
        where id = $1::uuid`,
      [id, TRAJECTORY_MAX_STEPS]
    );
    let ran = false;
    const err = await t
      .run(() =>
        invokeTool({
          tool: tool({
            execute: async () => {
              ran = true;
              return {};
            },
          }),
          input: {},
          actor,
          sessionId: "s",
          trajectoryId: id,
          stepIndex: 0,
          trajectoryStore: store,
        })
      )
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "request.trajectory_full" });
    expect(ran).toBe(false);
    const [row] = await sql(
      "select jsonb_array_length(steps) as n from agent_trajectories where id = $1::uuid",
      [id]
    );
    expect(row.n).toBe(TRAJECTORY_MAX_STEPS);
  });

  it("a trajectory without room for one more largest step (16 MiB in all) refuses it too", async () => {
    const store = new PostgresTrajectoryStore();
    const traj = await t.run(() =>
      store.create({ kind: "agent", id: "a1" }, "test", "platform")
    );
    const id = traj.trajectory.trajectoryId;
    await sql(
      `update agent_trajectories
          set steps = (select jsonb_agg(jsonb_build_object('stepIndex', i, 'blob', repeat('b', 1000000)))
                         from generate_series(1, 16) i)
        where id = $1::uuid`,
      [id]
    );
    await expect(t.run(() => store.assertRoomForStep(id))).rejects.toMatchObject({
      code: "request.trajectory_full",
    });
  });
});

dbDescribe("r10 H2: approved runs on Postgres", () => {
  async function approved(
    store: PostgresProposalStore,
    trajectoryId: string,
    op: string
  ) {
    const p = await t.run(() =>
      store.create({
        operationId: op,
        sessionId: "s",
        trajectoryId,
        label: "held",
        actor,
        effects: ["stateWrite"],
        effectiveRisk: "restricted",
        payload: {},
      })
    );
    await t.run(() => store.decide(p.proposalId, "approved", "approver"));
    return p.proposalId;
  }

  it("atomic: a failed run rolls back its write and its claim together; the retry writes once and uses the approval", async () => {
    const proposals = new PostgresProposalStore();
    const trajectories = new PostgresTrajectoryStore();
    const user = await t.user("target");
    const traj = await t.run(() =>
      trajectories.create({ kind: "agent", id: "a1" }, "test", "platform")
    );
    const id = await approved(proposals, traj.trajectory.trajectoryId, "op_atomic");
    let fail = true;
    const atomicTool = tool({
      id: "held",
      declaredRisk: "restricted",
      atomic: true,
      execute: async () => {
        await withTenantTx((tx) =>
          tx.query(
            "insert into user_feature_restrictions (user_id, feature, reason, created_by) values ($1::uuid, 'chat', 'r10', $1)",
            [user]
          )
        );
        if (fail) throw new Error("after the write");
        return { ok: true };
      },
    });
    const runIt = () =>
      t.run(() =>
        invokeTool({
          tool: atomicTool,
          input: {},
          actor,
          sessionId: "s",
          trajectoryId: traj.trajectory.trajectoryId,
          stepIndex: 0,
          operationId: "op_atomic",
          trajectoryStore: trajectories,
          proposalStore: proposals,
          approvedProposalId: id,
        })
      );
    await expect(runIt()).rejects.toBeInstanceOf(ApprovedRunFailedError);
    const rows = () =>
      sql(
        "select count(*)::int as n from user_feature_restrictions where reason = 'r10'"
      );
    expect((await rows())[0].n).toBe(0);
    expect((await t.run(() => proposals.getById(id)))?.status).toBe("approved");

    fail = false;
    await runIt();
    expect((await rows())[0].n).toBe(1);
    expect((await t.run(() => proposals.getById(id)))?.status).toBe("executed");
    const steps = (await t.run(() => trajectories.getById(traj.trajectory.trajectoryId)))!
      .trajectory.steps;
    expect(steps.filter((s) => s.operationId === "op_atomic")).toHaveLength(1);
    // Used: refused before anything runs.
    await expect(runIt()).rejects.toMatchObject({ name: "PipelineRejectedError" });
    expect((await rows())[0].n).toBe(1);
  });

  it("concurrent claims of one approval: exactly one wins", async () => {
    const proposals = new PostgresProposalStore();
    const id = await approved(proposals, "t", "op_conc");
    const results = await Promise.all(
      Array.from({ length: 5 }, () => t.run(() => proposals.claim(id)))
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("a run that never ended is taken back after its lease: undecided (no step recorded — never approved again, review 11 H-1) or executed (step recorded), audited", async () => {
    const proposals = new PostgresProposalStore();
    const trajectories = new PostgresTrajectoryStore();
    const traj = await t.run(() =>
      trajectories.create({ kind: "agent", id: "a1" }, "test", "platform")
    );
    const tid = traj.trajectory.trajectoryId;
    const crashedBefore = await approved(proposals, tid, "op_crash_before");
    const crashedAfter = await approved(proposals, tid, "op_crash_after");
    const running = await approved(proposals, tid, "op_running");
    for (const id of [crashedBefore, crashedAfter, running]) {
      expect((await t.run(() => proposals.claim(id)))?.status).toBe("executing");
    }
    // The second crashed after its step was recorded (it took effect).
    await t.run(() =>
      trajectories.addStep(tid, {
        stepIndex: 0,
        action: "held",
        input: {},
        output: {},
        cost: 0,
        durationMs: 0,
        timestamp: new Date().toISOString(),
        boundary: "commitment",
        operationId: "op_crash_after",
      })
    );
    // Five minutes ago, against a one-minute lease: the job's own 10-minute lease never sweeps
    // these from under this test (review 11 L-5).
    await sql(
      "update proposals set updated_at = now() - interval '5 minutes' where id = any($1::uuid[])",
      [[crashedBefore, crashedAfter]]
    );
    // The owner path the job uses, scoped to this test's tenant.
    const n = await withOwnerTx("platform-job", (tx) =>
      recoverStaleRuns(tx, 60, { tenantIds: [t.id] })
    );
    expect(n).toBe(2);
    expect(await t.run(() => proposals.getById(crashedBefore))).toMatchObject({
      status: "indeterminate",
      lastRunError: expect.stringContaining("outcome is unknown"),
    });
    expect((await t.run(() => proposals.getById(crashedAfter)))?.status).toBe("executed");
    expect((await t.run(() => proposals.getById(running)))?.status).toBe("executing");
    const audit = await sql(
      "select details from audit_log where details->>'type' = 'approval_run_recovered' order by details->>'status'"
    );
    expect(audit.map((r) => [r.details.status, r.details.agent])).toEqual([
      ["executed", RUN_RECOVERY_ACTOR],
      ["indeterminate", RUN_RECOVERY_ACTOR],
    ]);
    // An undecided run is not runnable: no second claim.
    expect(await t.run(() => proposals.claim(crashedBefore))).toBeUndefined();
  });
});
