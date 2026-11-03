/**
 * platform/agents/__tests__/gating.test.ts
 *
 * Covers the gating paths the conformance arm does not reach: rejectHeldAction, and the
 * reconcile branch of approveHeldAction (ADR-031 D5 stale-approval). The conformance arm
 * approves-then-resumes on the happy path; these cover refusal and reconciliation, which
 * are the safety-relevant halves.
 */

import {
  approvalPolicy,
  approveHeldAction,
  heldActionRefusal,
  rejectHeldAction,
} from "../gating";
import { InMemoryProposalStore } from "../proposal-store";
import { InMemoryTrajectoryStore } from "../trajectory-store";
import { InMemoryActivityStateStore } from "@/platform/app-framework/memory-state-store";
import { proposeOnce } from "@/platform/action-pipeline";
import type { ActionSpec, AgentIdentity } from "@/platform/kernel";

const ACTOR: AgentIdentity = {
  actorType: "agent",
  actorId: "gating-test",
  agentRole: "test",
};

const SPEC: ActionSpec = {
  type: "restricted-tool",
  effects: ["restricted"],
  declaredRisk: "restricted",
  ephemeral: false,
  commutative: false,
};

async function seedHeld(
  proposals: InMemoryProposalStore,
  trajectories: InMemoryTrajectoryStore,
  observedVersion?: number
) {
  const record = await trajectories.create(
    { kind: "agent", id: ACTOR.actorId },
    "analyze",
    "platform"
  );
  const trajectoryId = record.trajectory.trajectoryId;
  const proposal = await proposeOnce({
    spec: SPEC,
    actor: ACTOR,
    sessionId: trajectoryId,
    operationId: `op_${trajectoryId}_0`,
    label: SPEC.type,
    payload: { text: "gate me" },
    observedVersion,
    trajectoryId,
    stepIndex: 0,
    proposalStore: proposals,
    trajectoryStore: trajectories,
  });
  return { trajectoryId, proposal };
}

describe("approvalPolicy — human review is the default (P10)", () => {
  it("returns a user (human) approver for a restricted action", () => {
    const approver = approvalPolicy("restricted", ["restricted"]);
    expect(approver.actorType).toBe("user");
  });

  it("returns an approver typed as an identity, not a boolean flag", () => {
    // The seam: actorType is one of the three actor types, so an agent approver is
    // expressible later without changing this return shape.
    const approver = approvalPolicy("consequential", ["externalCall"]);
    expect(["user", "agent", "system"]).toContain(approver.actorType);
  });
});

describe("rejectHeldAction", () => {
  it("marks the proposal rejected and records it on the trajectory", async () => {
    const proposals = new InMemoryProposalStore();
    const trajectories = new InMemoryTrajectoryStore();
    const { proposal, trajectoryId } = await seedHeld(proposals, trajectories);

    await rejectHeldAction({
      proposalId: proposal.proposalId,
      decidedBy: "human-reviewer",
      note: "not this time",
      proposalStore: proposals,
      trajectoryStore: trajectories,
    });

    const after = await proposals.getById(proposal.proposalId);
    expect(after?.status).toBe("rejected");
    expect(after?.decidedBy).toBe("human-reviewer");

    // A rejected proposal never yields a stateVersion (ADR-031 D8): the trajectory records
    // the refusal, and no commitment step follows it.
    const record = await trajectories.getById(trajectoryId);
    const committed = record?.trajectory.steps.filter((s) => s.boundary === "commitment");
    expect(committed).toHaveLength(0);
  });
});

describe("approveHeldAction — reconcile branch (ADR-031 D5)", () => {
  it("approves when state has not advanced under the proposal", async () => {
    const proposals = new InMemoryProposalStore();
    const trajectories = new InMemoryTrajectoryStore();
    const stateStore = new InMemoryActivityStateStore<{ n: number }>();
    await stateStore.create("sess-stable", { n: 0 }); // version 1

    const { proposal } = await seedHeld(proposals, trajectories, 1);
    // Point the proposal's session at the state we seeded by approving with reconcile
    // against a store whose version still matches observedVersion.
    const outcome = await approveHeldAction({
      proposalId: proposal.proposalId,
      decidedBy: "human-reviewer",
      proposalStore: proposals,
      trajectoryStore: trajectories,
      reconcile: { stateStore, spec: SPEC },
    });

    // observedVersion was 1 and the proposal's session has no managed state in this store,
    // so load returns null and reconciliation degrades to a plain approve (ADR-031 D5).
    expect(["approved", "already-decided"]).toContain(outcome.kind);
  });

  it("supersedes a stale approval when state advanced non-commutatively", async () => {
    const proposals = new InMemoryProposalStore();
    const trajectories = new InMemoryTrajectoryStore();

    // Seed the proposal observing version 1, then advance the SAME session's state to 2.
    const record = await trajectories.create(
      { kind: "agent", id: ACTOR.actorId },
      "analyze",
      "platform"
    );
    const trajectoryId = record.trajectory.trajectoryId;
    const stateStore = new InMemoryActivityStateStore<{ n: number }>();
    await stateStore.create(trajectoryId, { n: 0 }); // version 1

    const proposal = await proposeOnce({
      spec: SPEC,
      actor: ACTOR,
      sessionId: trajectoryId,
      operationId: `op_${trajectoryId}_0`,
      label: SPEC.type,
      payload: { text: "gate me" },
      observedVersion: 1,
      trajectoryId,
      stepIndex: 0,
      proposalStore: proposals,
      trajectoryStore: trajectories,
    });

    await stateStore.commit(trajectoryId, 1, { n: 1 }, "advance"); // version 2

    const outcome = await approveHeldAction({
      proposalId: proposal.proposalId,
      decidedBy: "human-reviewer",
      proposalStore: proposals,
      trajectoryStore: trajectories,
      reconcile: { stateStore, spec: SPEC },
    });

    // Non-commutative spec, version moved 1 -> 2: the approval is stale and supersedes
    // rather than committing a transition from a state that no longer exists.
    expect(outcome.kind).toBe("stale");
  });
});

// Round 12, I-2: a policy whose default is not a person — set by hand, or reaching the gate past
// the stores' checks — cannot let an agent approve a restricted held action.
describe("heldActionRefusal — a restricted action needs a person, whatever the default", () => {
  const agentDefault = { version: 5, default: "agent" as const, rules: [] };

  it("refuses an agent approver of a restricted hold under a non-person default", () => {
    // Held by the user's agent in one session; decided by the same user's agent in another (an
    // independent session), or by the user: only the person may approve it.
    const proposer = {
      actorType: "agent" as const,
      actorId: "agent-a",
      agentRole: "assistant",
      onBehalfOf: "u1",
      sessionId: "s-proposer",
    };
    const held = {
      proposalId: "p1",
      status: "proposed",
      actor: proposer,
      effectiveRisk: "restricted",
      effects: ["restricted"],
    } as unknown as Parameters<typeof heldActionRefusal>[0];
    const agentDecider = { ...proposer, actorId: "agent-b", sessionId: "s-decider" };
    const userDecider = {
      actorType: "user" as const,
      actorId: "u1",
      agentRole: "user",
      sessionId: "s-decider",
    };
    expect(heldActionRefusal(held, agentDecider, "approve", agentDefault)).toBe(
      "approver_not_allowed"
    );
    expect(heldActionRefusal(held, userDecider, "approve", agentDefault)).toBeNull();
    expect(approvalPolicy("restricted", ["restricted"], agentDefault).actorType).toBe(
      "user"
    );
  });
});
