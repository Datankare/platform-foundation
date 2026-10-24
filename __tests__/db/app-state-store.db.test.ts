/**
 * @jest-environment node
 */
/**
 * PostgresActivityStateStore against the replayed database: the conformance kit inside one
 * tenant (its concurrency arm races commits and reducers on one row), the SQL paths the kit
 * does not reach, and sessions isolated between tenants.
 */

import { runAppStateStoreContract } from "../contract/app-state-store-contract";
import { runTenantIsolationContract } from "../contract/tenant-isolation-contract";
import { appStateIsolation } from "../helpers/store-isolation-fixtures";
import { PostgresActivityStateStore } from "@/platform/app-framework/postgres-state-store";
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

let seq = 0;
const sid = () => `db-session-${Date.now().toString(36)}-${seq++}`;

dbDescribe("PostgresActivityStateStore", () => {
  beforeAll(connectTestDatabase);
  afterAll(async () => {
    await dropTestTenants();
    await disconnectTestDatabase();
  });

  describe("conformance kit", () => {
    // The kit reuses fixed session ids in every test. app_sessions' primary key is (id) alone,
    // not (tenant_id, id), so a fresh tenant per test is not enough: each test's sessions are
    // removed after it. The isolation kit below shows the gap itself (same id, two tenants).
    let kitTenant: TestTenant | undefined;
    afterEach(async () => {
      await kitTenant?.run(() =>
        withTenantTx((tx) => tx.query("delete from app_sessions"))
      );
    });
    runAppStateStoreContract({
      makeStore: async () => {
        kitTenant = await createTestTenant();
        return inTenant(new PostgresActivityStateStore<{ count: number }>(), kitTenant);
      },
    });
  });

  describe("SQL paths beyond the kit", () => {
    let tenant: TestTenant;
    let store: PostgresActivityStateStore<{ n: number }>;
    beforeEach(async () => {
      tenant = await createTestTenant();
      store = inTenant(new PostgresActivityStateStore<{ n: number }>(), tenant);
    });

    it("refuses to create over an existing session", async () => {
      const id = sid();
      await store.create(id, { n: 1 });
      await expect(store.create(id, { n: 2 })).rejects.toThrow(
        `app-framework: create failed for ${id}`
      );
      expect((await store.load(id))?.state).toEqual({ n: 1 });
    });

    it("records producedBy on commit and reduceCommit", async () => {
      const id = sid();
      await store.create(id, { n: 1 });
      await store.commit(id, 1, { n: 2 }, "actor-a");
      expect((await store.load(id))?.producedBy).toBe("actor-a");
      const r = await store.reduceCommit(id, (s) => ({ n: s.n + 1 }), "actor-b");
      expect(r).toEqual({
        sessionId: id,
        state: { n: 3 },
        version: 3,
        producedBy: "actor-b",
      });
      expect((await store.load(id))?.producedBy).toBe("actor-b");
    });

    it("commit on a missing session throws", async () => {
      await expect(store.commit(sid(), 1, { n: 1 }, "a")).rejects.toThrow(
        "session not found on conflict"
      );
    });

    it("reduceCommit on a missing session throws", async () => {
      await expect(store.reduceCommit(sid(), (s) => s, "a")).rejects.toThrow(
        "session not found"
      );
    });

    it("saves and loads meta; empty or missing meta reads as null", async () => {
      const id = sid();
      await store.create(id, { n: 1 });
      expect(await store.loadMeta(id)).toBeNull(); // created with {}
      const meta = { participants: ["u1"] } as unknown as Parameters<
        typeof store.saveMeta
      >[1];
      await store.saveMeta(id, meta);
      expect(await store.loadMeta(id)).toEqual(meta);
      expect(await store.loadMeta(sid())).toBeNull();
      await expect(store.saveMeta(sid(), meta)).resolves.toBeUndefined(); // no row: no-op
    });

    it("saveMeta does not move the state version", async () => {
      const id = sid();
      await store.create(id, { n: 1 });
      await store.saveMeta(id, { participants: [] } as unknown as Parameters<
        typeof store.saveMeta
      >[1]);
      const { rows } = await tenant.run(() =>
        withTenantTx((tx) =>
          tx.query<{ version: number }>(
            "select version from app_sessions where id = $1",
            [id]
          )
        )
      );
      expect(rows[0].version).toBe(1);
    });
  });

  runTenantIsolationContract({
    name: "app_sessions",
    makeStore: () => new PostgresActivityStateStore<{ n: number }>(),
    createTenant: createTestTenant,
    ...appStateIsolation(),
  });
});
