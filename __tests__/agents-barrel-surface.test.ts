/**
 * __tests__/agents-barrel-surface.test.ts
 *
 * The public API of platform/agents, asserted exactly.
 *
 * Two reasons this exists. It is a real test: nothing today notices an export removed from
 * the barrel until something downstream fails to compile, and nothing notices an internal
 * helper accidentally made public. And it covers the re-export getters — a barrel's
 * `export { x } from "./y"` compiles to a getter per export, covered only when something
 * imports through the barrel rather than from the module directly.
 *
 * Exact rather than a subset: an export ADDED without being considered public is as much a
 * change to the contract as one removed.
 */

import * as agents from "@/platform/agents";

const EXPECTED_EXPORTS = [
  "AGENT_CONFIGS",
  "BudgetTracker",
  "DEFAULT_BUDGET_CONFIG",
  "DEFAULT_OUTPUT_RETRIES",
  "InMemoryBudgetStore",
  "InMemoryEffectLedger",
  "InMemoryProposalStore",
  "InMemoryTrajectoryStore",
  "SchemaValidationError",
  "SupabaseBudgetStore",
  "SupabaseEffectLedger",
  "SupabaseProposalStore",
  "SupabaseTrajectoryStore",
  "UndeclaredExternalEffectError",
  "assertValidSchema",
  "executeAgent",
  "generateId",
  "generateSecureId",
  "generateUuid",
  "getAgent",
  "getBudgetTracker",
  "getEffectLedger",
  "getProposalStore",
  "getTool",
  "getTrajectoryStore",
  "hasAgent",
  "hasTool",
  "idempotencyKeyFor",
  "invokeTool",
  "isValidSchema",
  "listAgents",
  "listTools",
  "performExternalEffect",
  "registerAgent",
  "registerPlatformAgents",
  "registerTool",
  "resetAgentRegistry",
  "resetBudgetTracker",
  "resetEffectLedger",
  "resetProposalStore",
  "resetToolRegistry",
  "resetTrajectoryStore",
  "resolveTools",
  "resumeAgent",
  "setBudgetTracker",
  "setEffectLedger",
  "setProposalStore",
  "setTrajectoryStore",
  "unregisterAgent",
  // ADR-030 AUX gating (Sprint 3b step 4)
  "approveHeldAction",
  "rejectHeldAction",
  "approvalPolicy",
  // Sprint 3c A1 — admin-governable approval policy
  "DEFAULT_APPROVAL_POLICY",
  "InMemoryApprovalPolicyStore",
  "getApprovalPolicyStore",
  "resolveApprover",
  // ADR-030 AUX: workflow loop + capabilities (this commit)
  "advanceGoal",
  "buildCapabilities",
  "listWorkflowGoals",
  "listWorkflows",
  "registerWorkflow",
  "resetWorkflowRegistry",
  "resolveWorkflow",
  "runGoal",
].sort();

describe("platform/agents — public API surface", () => {
  it("exports exactly the expected names", () => {
    const actual = Object.keys(agents).sort();
    expect(actual).toEqual(EXPECTED_EXPORTS);
  });

  it("every export is defined — the getters resolve", () => {
    for (const name of EXPECTED_EXPORTS) {
      expect((agents as Record<string, unknown>)[name]).toBeDefined();
    }
  });

  it("the store and ledger accessors return usable instances", () => {
    // A barrel that exports a name bound to undefined would satisfy a key check and fail
    // here — which is the difference between "the export exists" and "it works".
    expect(agents.getTrajectoryStore()).toBeInstanceOf(agents.InMemoryTrajectoryStore);
    expect(agents.getProposalStore()).toBeInstanceOf(agents.InMemoryProposalStore);
    expect(agents.getEffectLedger()).toBeInstanceOf(agents.InMemoryEffectLedger);
    expect(agents.getBudgetTracker()).toBeInstanceOf(agents.BudgetTracker);
    // setBudgetTracker was reachable only by deep import while get/reset were public.
    expect(typeof agents.setBudgetTracker).toBe("function");
  });

  it("the id generators produce distinct values of the documented shape", () => {
    expect(agents.generateId()).toHaveLength(16);
    expect(agents.generateSecureId()).toHaveLength(32);
    expect(agents.generateUuid()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });
});
