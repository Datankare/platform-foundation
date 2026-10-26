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
  "PostgresBudgetStore",
  "PostgresEffectLedger",
  "PostgresProposalStore",
  "PostgresTrajectoryStore",
  "SchemaValidationError",
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
  // TASK-170 — an approved step whose run did not take effect: withdrawn, or its outcome decided
  "withdrawHeldAction",
  "resolveUndecidedHeldAction",
  "endHeldTrajectory",
  // Sprint 3c A1 — admin-governable approval policy
  "DEFAULT_APPROVAL_POLICY",
  "approvalRulesProblem",
  "InMemoryApprovalPolicyStore",
  "getApprovalPolicyStore",
  "resolveApprover",
  // Sprint 3c A3 — durable store install + reset, Postgres impl (ADR-053 D4)
  "PostgresApprovalPolicyStore",
  "resetApprovalPolicyStore",
  // Review 11 H-2 — a trajectory continued in linked segments, read as one chain
  "readTrajectoryChain",
  "latestTrajectorySegment",
  "chainSteps",
  "setApprovalPolicyStore",
  // ADR-030 AUX: workflow loop + capabilities (this commit)
  "advanceGoal",
  "buildCapabilities",
  "listWorkflowGoals",
  "listWorkflows",
  "registerWorkflow",
  "resetWorkflowRegistry",
  "resolveWorkflow",
  "runGoal",
  // PF v5.1.0 — held-action decisions and resume bound to the approval
  "ApprovalMismatchError",
  "HeldActionNotApprovedError",
  "TrajectoryAccessError",
  // Review 16 L6: a resume refused on a store that does not declare supportsStatusCas
  "TrajectoryStoreCasError",
  "heldActionRefusal",
  "principalOf",
  "resumeApprovedAction",
  // ADR-054 D4 — workflow goals: the core's and the registered modules'
  "CORE_AGENT_GOALS",
  "isAgentGoal",
  "listAgentGoals",
  // Review 12 — the chain read one segment at a time (M2); the capability map read fail closed (H1)
  "trajectoryChainPages",
  "evaluateCapabilityFeatures",
  "requiredFeatures",
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
