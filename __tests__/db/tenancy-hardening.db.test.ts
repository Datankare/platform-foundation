/**
 * @jest-environment node
 */
/**
 * __tests__/db/tenancy-hardening.db.test.ts — what 049 closes beyond the tenant policy itself
 * (ADR-053 D4, D5), each tried as app_tenant through platform/data:
 *
 *  - an operator's value of a key no tenant may set cannot be removed or changed by the tenant;
 *  - the request role cannot create temporary tables;
 *  - two tenants' rate-limit buckets of one name never wait on each other.
 */

import { Client } from "pg";
import { withOwnerTx, withTenantTx } from "@/platform/data";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  type TestTenant,
} from "../helpers/db";

const OPERATOR_KEY = "ai.daily_paid_requests_per_actor"; // not tenant-settable
const OWN_KEY = "default_language"; // tenant-settable

let a: TestTenant;
let b: TestTenant;

const overrides = async (tenantId: string) =>
  (
    await withOwnerTx("operator", (tx) =>
      tx.query<{ key: string; value: unknown }>(
        "select key, value from tenant_config_overrides where tenant_id = $1::uuid order by key",
        [tenantId]
      )
    )
  ).rows;

dbDescribe("tenancy hardening (049)", () => {
  beforeAll(async () => {
    await connectTestDatabase();
    a = await createTestTenant();
    b = await createTestTenant();
  });
  afterAll(async () => {
    await dropTestTenants();
    await disconnectTestDatabase();
  });

  describe("a tenant's own configuration", () => {
    beforeEach(async () => {
      await withOwnerTx("operator", async (tx) => {
        await tx.query("delete from tenant_config_overrides where tenant_id = $1::uuid", [
          a.id,
        ]);
        // The operator's value for A of a key no tenant may set, and A's own value.
        await tx.query(
          `insert into tenant_config_overrides (tenant_id, key, value)
           values ($1::uuid, $2, '50'), ($1::uuid, $3, '"fr"')`,
          [a.id, OPERATOR_KEY, OWN_KEY]
        );
      });
    });

    it("reads the operator's value that applies to it", async () => {
      const { rows } = await a.run(() =>
        withTenantTx((tx) =>
          tx.query<{ key: string }>(
            "select key from tenant_config_overrides order by key"
          )
        )
      );
      expect(rows.map((r) => r.key)).toEqual([OPERATOR_KEY, OWN_KEY].sort());
    });

    it("cannot delete the operator's value (DELETE evaluates no WITH CHECK)", async () => {
      const r = await a.run(() =>
        withTenantTx((tx) =>
          tx.query("delete from tenant_config_overrides where key = $1", [OPERATOR_KEY])
        )
      );
      expect(r.rowCount).toBe(0);
      const all = await a.run(() =>
        withTenantTx((tx) => tx.query("delete from tenant_config_overrides"))
      );
      expect(all.rowCount).toBe(1); // its own value only
      expect(await overrides(a.id)).toEqual([{ key: OPERATOR_KEY, value: 50 }]);
    });

    it("cannot change the operator's value, nor re-key its own value onto it", async () => {
      const r = await a.run(() =>
        withTenantTx((tx) =>
          tx.query("update tenant_config_overrides set value = '9999' where key = $1", [
            OPERATOR_KEY,
          ])
        )
      );
      expect(r.rowCount).toBe(0);
      // Moving it onto a key the tenant may set would remove it as surely as deleting it.
      const moved = await a.run(() =>
        withTenantTx((tx) =>
          tx.query(
            "update tenant_config_overrides set key = 'supported_languages', value = '[\"en\"]' where key = $1",
            [OPERATOR_KEY]
          )
        )
      );
      expect(moved.rowCount).toBe(0);
      await expect(
        a.run(() =>
          withTenantTx((tx) =>
            tx.query(
              "update tenant_config_overrides set key = 'config.dual_control_keys', value = '[]' where key = $1",
              [OWN_KEY]
            )
          )
        )
      ).rejects.toMatchObject({ code: "42501" });
      const own = await a.run(() =>
        withTenantTx((tx) =>
          tx.query("update tenant_config_overrides set value = '\"de\"' where key = $1", [
            OWN_KEY,
          ])
        )
      );
      expect(own.rowCount).toBe(1);
      expect(await overrides(a.id)).toEqual(
        [
          { key: OPERATOR_KEY, value: 50 },
          { key: OWN_KEY, value: "de" },
        ].sort((x, y) => x.key.localeCompare(y.key))
      );
    });

    it("another tenant reaches none of it", async () => {
      const r = await b.run(() =>
        withTenantTx((tx) => tx.query("delete from tenant_config_overrides"))
      );
      expect(r.rowCount).toBe(0);
      expect(await overrides(a.id)).toHaveLength(2);
    });
  });

  it("the request role cannot create a temporary table", async () => {
    // A connection of its own: a session that has already made its temporary schema (as
    // another role) is not re-checked.
    const c = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await c.connect();
    try {
      await expect(
        c.query("create temp table shadow_users (id int)")
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await c.end();
    }
  });

  it("two tenants' rate-limit buckets of one name never wait on each other", async () => {
    const holder = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    const other = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await holder.connect();
    await other.connect();
    try {
      const bucket = `hardening:${a.id}`;
      // Tenant A is inside rate_limit_hit's critical section for the bucket, transaction open.
      await holder.query("begin");
      await holder.query("select set_config('app.tenant_id', $1, true)", [a.id]);
      await holder.query("select * from rate_limit_hit($1, 5, 60)", [bucket]);
      // Tenant B's bucket of the same name must not wait for A's transaction.
      await other.query("begin");
      await other.query("select set_config('app.tenant_id', $1, true)", [b.id]);
      await other.query("set local lock_timeout = '500ms'");
      const r = await other.query<{ allowed: boolean; used: number }>(
        "select allowed, used from rate_limit_hit($1, 5, 60)",
        [bucket]
      );
      expect(r.rows[0]).toEqual({ allowed: true, used: 1 });
      await other.query("rollback");
      // The same tenant's bucket does wait (it is one bucket).
      await other.query("begin");
      await other.query("select set_config('app.tenant_id', $1, true)", [a.id]);
      await other.query("set local lock_timeout = '300ms'");
      await expect(
        other.query("select * from rate_limit_hit($1, 5, 60)", [bucket])
      ).rejects.toMatchObject({ code: "55P03" });
      await other.query("rollback");
      await holder.query("rollback");
    } finally {
      await holder.end();
      await other.end();
    }
  });
});
