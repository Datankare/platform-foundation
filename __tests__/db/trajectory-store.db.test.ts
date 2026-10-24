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
      const after = await store.addStep(rec.trajectory.trajectoryId, step(0, 0));
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

    it("reads a malformed steps or total_cost as empty", async () => {
      const rec = await store.create({ kind: "agent", id: "z" }, "t", "platform");
      await tenant.run(() =>
        withTenantTx((tx) =>
          tx.query(
            `update agent_trajectories set steps = '{"not": "a list"}'::jsonb,
                total_cost = '"nonsense"'::jsonb where id = $1::uuid`,
            [rec.trajectory.trajectoryId]
          )
        )
      );
      const loaded = await store.getById(rec.trajectory.trajectoryId);
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
