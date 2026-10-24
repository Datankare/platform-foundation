/**
 * @jest-environment node
 */
/**
 * PostgresApprovalPolicyStore against the replayed database: the conformance kit inside one
 * tenant (its concurrency arm races two setRules on the per-tenant unique version), the audit
 * columns, and each tenant's policy history kept apart.
 */

import { runApprovalPolicyStoreContract } from "../contract/approval-policy-contract";
import { runTenantIsolationContract } from "../contract/tenant-isolation-contract";
import { approvalPolicyIsolation } from "../helpers/store-isolation-fixtures";
import { PostgresApprovalPolicyStore } from "@/platform/agents/postgres-approval-policy-store";
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

dbDescribe("PostgresApprovalPolicyStore", () => {
  beforeAll(connectTestDatabase);
  afterAll(async () => {
    await dropTestTenants();
    await disconnectTestDatabase();
  });

  runApprovalPolicyStoreContract({
    makeStore: async () =>
      inTenant(new PostgresApprovalPolicyStore(), await createTestTenant()),
  });

  describe("SQL paths beyond the kit", () => {
    let tenant: TestTenant;
    let store: PostgresApprovalPolicyStore;
    beforeEach(async () => {
      tenant = await createTestTenant();
      store = inTenant(new PostgresApprovalPolicyStore(), tenant);
    });

    it("appends an audited row per change: version, decider, carried-forward default", async () => {
      await store.setRules(
        [{ maxRisk: "ordinary", requiredApprover: "agent" }],
        "admin-a"
      );
      await store.setRules([], "admin-b");
      const { rows } = await tenant.run(() =>
        withTenantTx((tx) =>
          tx.query<{ version: number; decided_by: string; default_approver: string }>(
            "select version, decided_by, default_approver from agent_approval_policy order by version"
          )
        )
      );
      expect(rows).toEqual([
        { version: 2, decided_by: "admin-a", default_approver: "user" },
        { version: 3, decided_by: "admin-b", default_approver: "user" },
      ]);
    });

    it("carries a non-default approver forward and reads non-list rules as empty", async () => {
      await tenant.run(() =>
        withTenantTx((tx) =>
          tx.query(
            `insert into agent_approval_policy (id, version, default_approver, rules, decided_by)
             values (gen_random_uuid(), 7, 'agent', '{}'::jsonb, 'seed')`
          )
        )
      );
      expect(await store.load()).toEqual({ version: 7, default: "agent", rules: [] });
      const next = await store.setRules([], "admin");
      expect(next).toEqual({ version: 8, default: "agent", rules: [] });
    });

    it("survives a burst of concurrent changes with no lost or duplicate version", async () => {
      await Promise.all(
        Array.from({ length: 4 }, (_, i) =>
          store.setRules(
            [{ maxRisk: "ordinary", requiredApprover: "agent" }],
            `admin-${i}`
          )
        )
      );
      expect((await store.load()).version).toBe(5);
    });

    it("gives up after repeated version conflicts", async () => {
      const spy = jest
        .spyOn(
          (await import("@/platform/data")) as { withTenantTx: typeof withTenantTx },
          "withTenantTx"
        )
        .mockRejectedValue(Object.assign(new Error("dup"), { code: "23505" }));
      try {
        await expect(store.setRules([], "admin")).rejects.toThrow(
          "approval-policy version conflict"
        );
      } finally {
        spy.mockRestore();
      }
    });

    it("propagates any other database error at once", async () => {
      const spy = jest
        .spyOn(
          (await import("@/platform/data")) as { withTenantTx: typeof withTenantTx },
          "withTenantTx"
        )
        .mockRejectedValueOnce(Object.assign(new Error("boom"), { code: "XX000" }));
      try {
        await expect(store.setRules([], "admin")).rejects.toThrow("boom");
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
    });
  });

  runTenantIsolationContract({
    name: "agent_approval_policy",
    makeStore: () => new PostgresApprovalPolicyStore(),
    createTenant: createTestTenant,
    ...approvalPolicyIsolation(),
  });
});
