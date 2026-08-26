/**
 * __tests__/approval-policy-store-conformance.test.ts — Sprint 3c A2
 *
 * Runs the ApprovalPolicyStore conformance kit against the in-memory implementation.
 * The Supabase implementation (A3) will run the same kit against a PostgREST fake.
 */

import { InMemoryApprovalPolicyStore } from "@/platform/agents/approval-policy-store";
import { runApprovalPolicyStoreContract } from "./contract/approval-policy-contract";

describe("InMemoryApprovalPolicyStore — conformance", () => {
  runApprovalPolicyStoreContract({
    makeStore: () => new InMemoryApprovalPolicyStore(),
  });
});
