/**
 * @jest-environment node
 */
/**
 * Review 11 on the replayed database — the Postgres variants of the reviewer's proofs
 * (review11/__tests__/rv11-hostile.test.ts ran them in memory; review11 rv11.sql's cases)
 *
 *   H-1  A run slower than its lease: the job's own recovery, on the owner connection, marks it
 *        undecided mid-run; the run's completion by its token lands; it never runs twice; a
 *        completion the claim no longer allows is raised and audited as a conflict.
 *   H-2  A full trajectory is continued in a linked row, in one transaction with the append —
 *        concurrent appenders find one continuation, never a fork; the chain reads as one; an
 *        account's export and erasure cover every segment.
 *   M-2  A config write's compare-and-set: refused when the value it replaces changed.
 *   L-6  An atomic run's attempt and failure records survive its rollback; a retry inside a
 *        joined transaction (set_approval_policy's version conflict) runs under a savepoint.
 *   SQL  jsonb_replace_text_value's key collisions (review11 rv11.sql), exactly.
 *
 * Recovery here runs as the job runs it — withOwnerTx("platform-job") — scoped to this suite's
 * tenants and with a lease the production job never reaches (review 11 L-5).
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req",
}));

import { invokeTool } from "@/platform/agents/tool-invoker";
import { PostgresTrajectoryStore } from "@/platform/agents/postgres-trajectory-store";
import { PostgresProposalStore } from "@/platform/agents/postgres-proposal-store";
import { PostgresApprovalPolicyStore } from "@/platform/agents/postgres-approval-policy-store";
import { PostgresActivityStateStore } from "@/platform/app-framework/postgres-state-store";
import {
  chainSteps,
  latestTrajectorySegment,
  readTrajectoryChain,
} from "@/platform/agents/trajectory-store";
import {
  ActionNotRecordedError,
  ApprovedRunFailedError,
  PipelineRejectedError,
} from "@/platform/action-pipeline";
import { withOwnerTx, withSavepoint, withTenantTx } from "@/platform/data";
import { recoverStaleRuns } from "@/platform/admin/hold-expiry";
import { audited } from "@/platform/auth/audit";
import { eraseUserData, exportUserTables } from "@/platform/auth/user-data";
import { setConfigWithHistory, getEnhancedConfig } from "@/platform/auth/platform-config";
import { TRAJECTORY_MAX_STEPS } from "@/platform/errors/json-limits";
import type { AgentIdentity, Step, Tool } from "@/platform/kernel";
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

/** The job's recovery, as the job runs it, for this suite's tenant, past a 1-minute lease. */
async function recoverNow(proposalId: string): Promise<number> {
  return withOwnerTx("platform-job", async (tx) => {
    await tx.query(
      "update proposals set updated_at = now() - interval '5 minutes' where id = $1::uuid",
      [proposalId]
    );
    return recoverStaleRuns(tx, 60, { tenantIds: [t.id] });
  });
}

async function approvedProposal(store: PostgresProposalStore, tid: string, op: string) {
  const p = await t.run(() =>
    store.create({
      operationId: op,
      sessionId: "s",
      trajectoryId: tid,
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

function heldTool(execute: Tool["execute"], extra: Partial<Tool> = {}): Tool {
  return {
    id: "held",
    name: "held",
    description: "",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    effects: ["stateWrite"],
    declaredRisk: "restricted",
    execute,
    ...extra,
  };
}

dbDescribe("rv11 H-1 on Postgres: a run slower than its lease applies once", () => {
  it("recovered mid-run as undecided; completed by its token; never run again", async () => {
    const proposals = new PostgresProposalStore();
    const trajectories = new PostgresTrajectoryStore();
    const traj = await t.run(() =>
      trajectories.create({ kind: "agent", id: "a1" }, "test", "platform")
    );
    const id = await approvedProposal(proposals, traj.trajectory.trajectoryId, "op_slow");
    let effects = 0;
    const during: unknown[] = [];
    const run = () =>
      t.run(() =>
        invokeTool({
          tool: heldTool(async () => {
            effects += 1;
            if (effects === 1) {
              expect(await t.run(() => proposals.claim(id))).toBeUndefined();
              during.push(await recoverNow(id));
              during.push((await t.run(() => proposals.getById(id)))?.status);
              expect(await t.run(() => proposals.claim(id))).toBeUndefined();
            }
            return { ok: true };
          }),
          input: {},
          actor,
          sessionId: "s",
          trajectoryId: traj.trajectory.trajectoryId,
          stepIndex: 0,
          operationId: "op_slow",
          trajectoryStore: trajectories,
          proposalStore: proposals,
          approvedProposalId: id,
        })
      );
    await run();
    expect(during).toEqual([1, "indeterminate"]);
    expect((await t.run(() => proposals.getById(id)))?.status).toBe("executed");
    await expect(run()).rejects.toBeInstanceOf(PipelineRejectedError);
    expect(effects).toBe(1);
    const recovered = await sql(
      "select details->>'status' as status from audit_log where details->>'type' = 'approval_run_recovered' and details->>'holdId' = $1",
      [id]
    );
    expect(recovered).toEqual([{ status: "indeterminate" }]);
  });

  it("a completion the claim no longer allows is raised as applied, and audited as a conflict", async () => {
    const proposals = new PostgresProposalStore();
    const trajectories = new PostgresTrajectoryStore();
    const traj = await t.run(() =>
      trajectories.create({ kind: "agent", id: "a1" }, "test", "platform")
    );
    const id = await approvedProposal(proposals, traj.trajectory.trajectoryId, "op_conf");
    const err = await t
      .run(() =>
        invokeTool({
          tool: heldTool(async () => {
            await recoverNow(id);
            await t.run(() =>
              proposals.resolveIndeterminate(
                id,
                "approved",
                "bob",
                "verified not applied"
              )
            );
            return { ok: true };
          }),
          input: {},
          actor,
          sessionId: "s",
          trajectoryId: traj.trajectory.trajectoryId,
          stepIndex: 0,
          operationId: "op_conf",
          trajectoryStore: trajectories,
          proposalStore: proposals,
          approvedProposalId: id,
        })
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionNotRecordedError);
    expect(err).toMatchObject({ applied: true, approvalConflict: true });
    const audit = await sql(
      "select details->>'holdId' as hold from audit_log where details->>'type' = 'approval_run_conflict'"
    );
    expect(audit).toEqual([{ hold: id }]);
    expect((await t.run(() => proposals.getById(id)))?.status).toBe("approved");
  });
});

const step = (i: number, actorId = "agent:a1"): Step => ({
  stepIndex: i,
  action: "move",
  input: {},
  output: {},
  cost: 0,
  durationMs: 0,
  timestamp: new Date().toISOString(),
  boundary: "commitment",
  actor: { actorType: "user", actorId, agentRole: "player" },
});

/** A trajectory holding the most steps one may, written in one statement. */
async function fullTrajectory(
  store: PostgresTrajectoryStore,
  subject: { kind: "agent" | "session"; id: string },
  actorId = "agent:a1"
): Promise<string> {
  const traj = await t.run(() => store.create(subject, "test", "user"));
  const id = traj.trajectory.trajectoryId;
  await sql(
    `update agent_trajectories
        set steps = (select jsonb_agg(jsonb_build_object('stepIndex', i - 1, 'action', 'move',
                                                         'actor', jsonb_build_object('actorId', $3::text)))
                       from generate_series(1, $2::int) i)
      where id = $1::uuid`,
    [id, TRAJECTORY_MAX_STEPS, actorId]
  );
  return id;
}

dbDescribe("rv11 H-2 on Postgres: a full trajectory is continued, linked", () => {
  it("move 1 001 goes to segment 2, linked, with the step offset; the chain reads as one", async () => {
    const store = new PostgresTrajectoryStore();
    const first = await fullTrajectory(store, { kind: "session", id: `sess_${t.id}` });
    await expect(t.run(() => store.addStep(first, step(1000)))).rejects.toMatchObject({
      code: "request.trajectory_full",
    });
    const next = await t.run(() => store.addStep(first, step(1000), { rollover: true }));
    expect(next!.trajectory).toMatchObject({
      segment: 2,
      previousTrajectoryId: first,
      stepOffset: TRAJECTORY_MAX_STEPS,
    });
    expect(next!.trajectory.steps.map((s) => s.stepIndex)).toEqual([1000]);
    expect(next!.subject).toEqual({ kind: "session", id: `sess_${t.id}` });
    const chain = await t.run(() => readTrajectoryChain(store, first));
    expect(chain.map((r) => r.trajectory.segment ?? 1)).toEqual([1, 2]);
    expect(chainSteps(chain)).toHaveLength(TRAJECTORY_MAX_STEPS + 1);
    expect(
      (await t.run(() => latestTrajectorySegment(store, first)))?.trajectory.trajectoryId
    ).toBe(next!.trajectory.trajectoryId);
    // The chain's shape is the database's too.
    await expect(
      sql("update agent_trajectories set segment = 1 where id = $1::uuid", [
        next!.trajectory.trajectoryId,
      ])
    ).rejects.toThrow(
      // The chain guard (review 12 L6) refuses it before the CHECK is reached.
      /agent_trajectories_chain_shape|chain never changes after it is created/
    );
  });

  it("concurrent appenders to a full segment find one continuation: never a fork, no step lost", async () => {
    const store = new PostgresTrajectoryStore();
    const first = await fullTrajectory(store, { kind: "agent", id: "a1" });
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        t.run(() => store.addStep(first, step(1000 + i), { rollover: true }))
      )
    );
    const ids = new Set(results.map((r) => r!.trajectory.trajectoryId));
    expect(ids.size).toBe(1);
    const rows = await sql(
      "select id, jsonb_array_length(steps) as n from agent_trajectories where previous_trajectory_id = $1::uuid",
      [first]
    );
    expect(rows).toEqual([{ id: [...ids][0], n: 5 }]);
  });

  it("an account's export and erasure cover every segment of its session's trajectory", async () => {
    const user = await t.user("player");
    const sessionId = `sess_${user}`;
    const states = new PostgresActivityStateStore<{ n: number }>();
    await t.run(async () => {
      await states.create(sessionId, { n: 0 });
      await states.saveMeta(sessionId, {
        definitionId: "counter",
        status: "active",
        capabilities: ["persistent"],
        participants: [{ actorType: "user", actorId: user, agentRole: "player" }],
      });
    });
    const store = new PostgresTrajectoryStore();
    const first = await fullTrajectory(store, { kind: "session", id: sessionId }, user);
    await t.run(() => store.addStep(first, step(1000, user), { rollover: true }));

    const exported = await t.run(() => withTenantTx((tx) => exportUserTables(tx, user)));
    const segs = (exported.sessionTrajectories as { segment: number }[]).map(
      (r) => r.segment
    );
    expect(segs.sort()).toEqual([1, 2]);

    const erased = await t.run(() => withTenantTx((tx) => eraseUserData(tx, user)));
    expect(erased.find((s) => s.name === "sessionTrajectories")?.rows).toBe(2);
    expect(
      await sql(
        "select count(*)::int as n from agent_trajectories where subject_kind = 'session' and subject_id = $1",
        [sessionId]
      )
    ).toEqual([{ n: 0 }]);
  });

  it("a shared session's chain is anonymised in every segment", async () => {
    const user = await t.user("shared-player");
    const store = new PostgresTrajectoryStore();
    const first = await fullTrajectory(store, { kind: "agent", id: "a1" }, user);
    const second = await t.run(() =>
      store.addStep(first, step(1000, user), { rollover: true })
    );
    await t.run(() => withTenantTx((tx) => eraseUserData(tx, user)));
    const left = await sql(
      "select count(*)::int as n from agent_trajectories where id = any($1::uuid[]) and steps::text like '%' || $2 || '%'",
      [[first, second!.trajectory.trajectoryId], user]
    );
    expect(left).toEqual([{ n: 0 }]);
  });
});

dbDescribe("rv11 M-2 on Postgres: a compare-and-set config write", () => {
  it("is refused when the value it replaces changed, and applied when it did not", async () => {
    const admin = await t.user("ops");
    const key = "agent.trusted_agents";
    const entry = await t.run(() => getEnhancedConfig(key));
    expect(entry).not.toBeNull();
    const target = { scope: "tenant" as const, operator: true };
    const before = [["agent:a", { owner: "o", scopes: ["x"], status: "active" }]];
    const set = (value: unknown, expected?: unknown) =>
      t.run(() =>
        setConfigWithHistory(
          key,
          value,
          admin,
          "rv11",
          "admin_ui",
          undefined,
          target,
          expected === undefined ? {} : { expectPrevious: { value: expected } }
        )
      );
    expect(await set(before)).toMatchObject({ success: true });
    const suspended = [["agent:a", { owner: "o", scopes: ["x"], status: "suspended" }]];
    // Another change landed first: the reduction judged against the old value is not made.
    expect(await set(suspended, [])).toMatchObject({
      success: false,
      error: expect.stringMatching(/changed since it was read/),
    });
    expect(await set(suspended, before)).toMatchObject({ success: true });
    const stored = await withOwnerTx("operator", (tx) =>
      tx.query<{ value: unknown }>(
        "select value from tenant_config_overrides where tenant_id = $1::uuid and key = $2",
        [t.id, key]
      )
    );
    expect(stored.rows[0].value).toEqual(suspended);
  });
});

dbDescribe("rv11 L-6 on Postgres: records of an attempt survive the rollback", () => {
  it("an audited action inside a transaction that rolls back leaves its attempt and failure records", async () => {
    const marker = `rv11-${t.id}`;
    await expect(
      t.run(() =>
        withTenantTx(async () => {
          await audited(
            { action: "admin_action", agent: "rv11", details: { type: marker } },
            async () => ({ success: false, error: "refused" })
          );
          throw new Error("the outer transaction rolls back");
        })
      )
    ).rejects.toThrow(/rolls back/);
    const rows = await sql(
      "select details->>'outcome' as outcome from audit_log where details->>'type' = $1 order by created_at",
      [marker]
    );
    expect(rows).toEqual([{ outcome: "attempted" }, { outcome: "failed" }]);
  });

  it("an atomic approved run that fails: its write and claim roll back; its attempt and the run's failure are on record", async () => {
    const proposals = new PostgresProposalStore();
    const trajectories = new PostgresTrajectoryStore();
    const user = await t.user("target");
    const traj = await t.run(() =>
      trajectories.create({ kind: "agent", id: "a1" }, "test", "platform")
    );
    const id = await approvedProposal(
      proposals,
      traj.trajectory.trajectoryId,
      "op_atomic11"
    );
    const err = await t
      .run(() =>
        invokeTool({
          tool: heldTool(
            async () => {
              await audited(
                {
                  action: "admin_action",
                  agent: "rv11",
                  details: { type: "rv11_atomic" },
                },
                async () => {
                  await withTenantTx((tx) =>
                    tx.query(
                      "insert into user_feature_restrictions (user_id, feature, reason, created_by) values ($1::uuid, 'chat', 'rv11', $1)",
                      [user]
                    )
                  );
                  return { success: true };
                }
              );
              throw new Error("after the write");
            },
            { atomic: true }
          ),
          input: {},
          actor,
          sessionId: "s",
          trajectoryId: traj.trajectory.trajectoryId,
          stepIndex: 0,
          operationId: "op_atomic11",
          trajectoryStore: trajectories,
          proposalStore: proposals,
          approvedProposalId: id,
        })
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApprovedRunFailedError);
    expect(
      await sql(
        "select count(*)::int as n from user_feature_restrictions where reason = 'rv11'"
      )
    ).toEqual([{ n: 0 }]);
    expect((await t.run(() => proposals.getById(id)))?.status).toBe("approved");
    const records = await sql(
      "select details->>'type' as type, details->>'outcome' as outcome from audit_log where details->>'type' in ('rv11_atomic', 'approved_run_failed') order by created_at"
    );
    expect(records).toEqual([
      { type: "rv11_atomic", outcome: "attempted" },
      // Review 12 L1: its act succeeded and then rolled back with the run — said so.
      { type: "rv11_atomic", outcome: "rolled_back" },
      { type: "approved_run_failed", outcome: null },
    ]);
  });

  it("a savepoint undoes one failed statement and leaves the joined transaction usable", async () => {
    const rows = await t.run(() =>
      withTenantTx(async (tx) => {
        await expect(withSavepoint(tx, () => tx.query("select 1 / 0"))).rejects.toThrow(
          /division by zero/
        );
        return (await tx.query<{ ok: number }>("select 1 as ok")).rows;
      })
    );
    expect(rows).toEqual([{ ok: 1 }]);
  });

  it("set_approval_policy's version-conflict retry works inside a joined transaction", async () => {
    const store = new PostgresApprovalPolicyStore();
    const rules = [{ maxRisk: "restricted", requiredApprover: "user" }] as never;
    const hold = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // Two transactions, each joined by setRules: the second's insert waits on the first's
    // version, fails on it once the first commits, and retries — under its savepoint — in the
    // same, still usable, transaction.
    const versions = await Promise.all([
      t.run(() =>
        withTenantTx(async () => {
          const p = await store.setRules(rules, "a");
          await hold(300);
          return p.version;
        })
      ),
      (async () => {
        await hold(50);
        return t.run(() =>
          withTenantTx(async () => (await store.setRules(rules, "b")).version)
        );
      })(),
    ]);
    expect(new Set(versions).size).toBe(2);
    expect(Math.abs(versions[0] - versions[1])).toBe(1);
  });
});

dbDescribe(
  "rv11 SQL: jsonb_replace_text_value's colliding keys (review11 rv11.sql)",
  () => {
    it.each([
      ['{"ann@x.com":"p","U1":"q"}', { U1: "q", "U1#1": "p" }],
      [
        '{"ann@x.com":"p","U1":"q","U1#1":"z"}',
        { U1: "q", "U1#1": "z", "U1#1-d98835d2fdbc": "p" },
      ],
      ['{"ANN@x.com":"p","ann@x.com":"q"}', { "U1#1": "p", "U1#2": "q" }],
      [
        '{"a":{"ann@x.com":1},"b":{"ann@x.com":2,"U1":3}}',
        { a: { "U1#1": 1 }, b: { U1: 3, "U1#2": 2 } },
      ],
      [
        '{"x":"ann@x.com: ", "U1": 1, "ann@x.com": 2}',
        { x: "ann@x.com: ", U1: 1, "U1#1": 2 },
      ],
      ['{"k":"say \\"ann@x.com\\": hi","U1":1}', { k: 'say "ann@x.com": hi', U1: 1 }],
      ['["ann@x.com", {"ann@x.com":"v"}]', ["U1", { U1: "v" }]],
      [
        '{"ann@x.com":"p","U1":"q","U1#1":"z", "U1#2":"w"}',
        { U1: "q", "U1#1": "z", "U1#2": "w", "U1#1-d06cac70db3b": "p" },
      ],
      ['{"pre ann@x.com":"p","pre U1":"q"}', { "pre U1": "q", "pre ann@x.com": "p" }],
    ])("%s: no value lost, free text kept", async (doc, expected) => {
      const rows = await withOwnerTx("tenant-lifecycle", (tx) =>
        tx.query<{ r: unknown }>(
          "select public.jsonb_replace_text_value($1::jsonb, 'ann@x.com', 'U1') as r",
          [doc]
        )
      );
      expect(rows.rows[0].r).toEqual(expected);
    });
  }
);
