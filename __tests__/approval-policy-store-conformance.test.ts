/**
 * __tests__/approval-policy-store-conformance.test.ts — Sprint 3c A2
 *
 * Runs the ApprovalPolicyStore conformance kit against the in-memory implementation, and the
 * tenant isolation kit against its per-tenant policies (ADR-053 D6). The Postgres store runs
 * both in __tests__/db/approval-policy-store.db.test.ts.
 */

import {
  DEFAULT_APPROVAL_POLICY,
  InMemoryApprovalPolicyStore,
} from "@/platform/agents/approval-policy-store";
import { runApprovalPolicyStoreContract } from "./contract/approval-policy-contract";
import { runTenantIsolationContract } from "./contract/tenant-isolation-contract";
import {
  approvalPolicyIsolation,
  memoryTenant,
} from "./helpers/store-isolation-fixtures";

describe("InMemoryApprovalPolicyStore — conformance", () => {
  runApprovalPolicyStoreContract({
    makeStore: () => new InMemoryApprovalPolicyStore(),
  });
});

describe("InMemoryApprovalPolicyStore — tenants", () => {
  runTenantIsolationContract({
    name: "approval policy (memory)",
    makeStore: () => new InMemoryApprovalPolicyStore(),
    createTenant: memoryTenant,
    ...approvalPolicyIsolation(),
    failsClosedWithoutTenant: false,
  });

  it("starts every tenant at the store's initial policy", async () => {
    const initial = { ...DEFAULT_APPROVAL_POLICY, version: 4, default: "agent" as const };
    const store = new InMemoryApprovalPolicyStore(initial);
    const a = await memoryTenant();
    const b = await memoryTenant();
    await a.run(() => store.setRules([], "admin"));
    expect(await a.run(() => store.load())).toEqual({ ...initial, version: 5 });
    expect(await b.run(() => store.load())).toEqual(initial);
  });
});
