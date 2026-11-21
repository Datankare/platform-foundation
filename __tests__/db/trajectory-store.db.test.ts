/**
 * @jest-environment node
 */
/**
 * PostgresTrajectoryStore against the replayed database: the conformance kit inside one tenant
 * (each test a fresh tenant, so a fresh store), the SQL paths the kit does not reach, and the
 * store isolated between tenants.
 */

import { runTrajectoryStoreContract } from "../contract/trajectory-store-contract";
import { runTenantIsolationContract } from "../contract/tenant-isolation-contract";
import { trajectoryIsolation } from "../helpers/store-isolation-fixtures";
import { PostgresTrajectoryStore } from "@/platform/agents/postgres-trajectory-store";
import { withTenantTx } from "@/platform/data";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  inTenant,
  type TestTenant,
} from "../helpers/db";

dbDescribe("PostgresTrajectoryStore", () => {
  beforeAll(connectTestDatabase);
  afterAll(async () => {
    await dropTestTenants();
    await disconnectTestDatabase();
  });

  runTrajectoryStoreContract({
    makeStore: async () =>
      inTenant(new PostgresTrajectoryStore(), await createTestTenant()),
  });

  describe("SQL paths beyond the kit", () => {
    let tenant: TestTenant;
    let store: PostgresTrajectoryStore;
    beforeEach(async () => {
      tenant = await createTestTenant();
      store = inTenant(new PostgresTrajectoryStore(), tenant);
    });

    it("returns undefined, without a query error, for an id that is not a uuid", async () => {
      expect(await store.getById("not-a-uuid")).toBeUndefined();
      expect(await store.addStep("not-a-uuid", step(0))).toBeUndefined();
      expect(await store.updateStatus("not-a-uuid", "failed")).toBeUndefined();
    });

    it("round-trips scope, trigger, ISO timestamps, and bumps updatedAt on write", async () => {
      const rec = await store.create({ kind: "session", id: "s1" }, "go", "group", "g1");
      expect(rec.scopeType).toBe("group");
      expect(rec.scopeId).toBe("g1");
      expect(rec.trigger).toBe("go");
      expect(new Date(rec.trajectory.createdAt).toISOString()).toBe(
        rec.trajectory.createdAt
      );
      await store.addStep(rec.trajectory.trajectoryId, step(0, 0));
      const after = await store.getById(rec.trajectory.trajectoryId);
      expect(after?.costSummary.apiCalls).toBe(0); // a free step is not an API call
      expect(after!.trajectory.updatedAt >= rec.trajectory.updatedAt).toBe(true);
      const status = await store.updateStatus(
        rec.trajectory.trajectoryId,
        "indeterminate"
      );
      expect(status?.trajectory.status).toBe("indeterminate");
      expect(status?.trajectory.steps).toHaveLength(1);
    });

    it("applies every query filter, newest first", async () => {
      const a = await store.create({ kind: "agent", id: "x" }, "t", "user", "u1");
      const b = await store.create({ kind: "agent", id: "x" }, "t", "group", "g1");
      await store.create({ kind: "session", id: "y" }, "t", "platform");
      await store.updateStatus(a.trajectory.trajectoryId, "paused");

      const ids = (rs: readonly { trajectory: { trajectoryId: string } }[]) =>
        rs.map((r) => r.trajectory.trajectoryId);
      expect(ids(await store.query({ agentId: "x" }))).toEqual([
        b.trajectory.trajectoryId,
        a.trajectory.trajectoryId,
      ]);
      expect(ids(await store.query({ scopeType: "user" }))).toEqual([
        a.trajectory.trajectoryId,
      ]);
      expect(ids(await store.query({ scopeId: "g1" }))).toEqual([
        b.trajectory.trajectoryId,
      ]);
      expect(ids(await store.query({ status: "paused", subjectKind: "agent" }))).toEqual([
        a.trajectory.trajectoryId,
      ]);
      expect(await store.query({ limit: 0 })).toHaveLength(3); // no positive limit: all
    });

    it("reads a malformed total_cost as empty; a run without steps reads []", async () => {
      const rec = await store.create({ kind: "agent", id: "z" }, "t", "platform");
      await tenant.run(() =>
        withTenantTx((tx) =>
          tx.query(
            `update agent_trajectories set total_cost = '"nonsense"'::jsonb where id = $1::uuid`,
            [rec.trajectory.trajectoryId]
          )
        )
      );
      const loaded = await store.getById(rec.trajectory.trajectoryId);
      // No step rows (TASK-230): the segment's steps are an empty list, never null.
      expect(loaded?.trajectory.steps).toEqual([]);
      expect(loaded?.costSummary).toEqual({ tokens: 0, apiCalls: 0, usd: 0 });
      const partial = await tenant.run(() =>
        withTenantTx((tx) =>
          tx.query(
            `update agent_trajectories set total_cost = '{"usd": "1"}'::jsonb where id = $1::uuid`,
            [rec.trajectory.trajectoryId]
          )
        )
      );
      expect(partial.rowCount).toBe(1);
      expect((await store.getById(rec.trajectory.trajectoryId))?.costSummary.usd).toBe(0);
    });

    // TASK-230 (ADR-059; reviews B-8, RB2-4, S6, SB-10 (4), TB-x-4): work counted, never timed —
    // in the test's own transaction, which the store's statements join.
    describe("(TASK-230) an append is one row; a read is one statement", () => {
      /** Run `fn` in one tenant transaction, counting the statements sent on it. */
      const counted = <T>(fn: () => Promise<T>) =>
        tenant.run(() =>
          withTenantTx(async (tx) => {
            let n = 0;
            const send = tx.query.bind(tx);
            (tx as { query: typeof tx.query }).query = ((
              ...a: Parameters<typeof send>
            ) => {
              n += 1;
              return send(...a);
            }) as typeof tx.query;
            try {
              return { value: await fn(), statements: n };
            } finally {
              (tx as { query: typeof tx.query }).query = send;
            }
          })
        );

      it("getById, chainTail, chainSegment and query read in one statement each; query reads no step", async () => {
        const rec = await store.create({ kind: "agent", id: "c" }, "t", "platform");
        const id = rec.trajectory.trajectoryId;
        await store.addStep(id, step(0));
        await store.addStep(id, step(1));
        for (const read of [
          () => store.getById(id),
          () => store.chainTail(id),
          () => store.chainSegment(id, 1),
        ]) {
          const r = await counted(read);
          expect(r.statements).toBe(1);
          expect(r.value?.trajectory.steps).toHaveLength(2);
        }
        const q = await counted(() => store.query({ agentId: "c" }));
        expect(q.statements).toBe(1);
        expect(q.value[0].trajectory.steps).toEqual([]);
        expect(q.value[0].trajectory.stepCount).toBe(2);
      });

      it("(B-8, TB-x-4) an append to a 999-step run reads no toast block of the steps; a read of the run does", async () => {
        const rec = await store.create({ kind: "agent", id: "toast" }, "t", "platform");
        const id = rec.trajectory.trajectoryId;
        // 999 steps of ~3 KB that do not compress (md5 chained): stored out of line.
        await tenant.run(() =>
          withTenantTx((tx) =>
            tx.query(
              `insert into agent_trajectory_steps (trajectory_id, seq, step)
               select $1::uuid, i, jsonb_build_object('stepIndex', i, 'text',
                        (select string_agg(md5(i::text || ':' || j::text), '') from generate_series(1, 96) j))
                 from generate_series(0, 998) i order by i`,
              [id]
            )
          )
        );
        const toastRead = (fn: () => Promise<unknown>) =>
          tenant.run(() =>
            withTenantTx(async (tx) => {
              const blocks = async () =>
                Number(
                  (
                    await tx.query<{ n: string }>(
                      `select pg_stat_get_xact_blocks_fetched(c.reltoastrelid)::text as n
                         from pg_class c where c.oid = 'public.agent_trajectory_steps'::regclass`
                    )
                  ).rows[0].n
                );
              const before = await blocks();
              await fn();
              return (await blocks()) - before;
            })
          );
        expect(await toastRead(() => store.addStep(id, step(999)))).toBe(0);
        // The counter does count: reading the segment reads its steps' toast.
        expect(await toastRead(() => store.getById(id))).toBeGreaterThan(0);
        expect((await store.getById(id))?.trajectory.steps).toHaveLength(1000);
      });
    });

    it("propagates a database refusal (a check constraint) as a thrown error", async () => {
      await expect(
        store.create({ kind: "robot" as "agent", id: "r" }, "t", "platform")
      ).rejects.toThrow(/subject_kind_check/);
    });
  });

  runTenantIsolationContract({
    name: "agent_trajectories",
    makeStore: () => new PostgresTrajectoryStore(),
    createTenant: createTestTenant,
    ...trajectoryIsolation(),
  });
});

function step(index: number, cost = 0) {
  return {
    stepIndex: index,
    action: `action-${index}`,
    input: {},
    output: {},
    cost,
    durationMs: 1,
    timestamp: new Date().toISOString(),
    boundary: "cognition" as const,
  };
}
