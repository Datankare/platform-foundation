/**
 * __tests__/adr031-lifecycle.test.ts
 *
 * The five ADR-031 decisions that Sprint 2 built anchors for and left unimplemented:
 * D3 revision, D4's remaining dedup edges, D5 stale-approval reconciliation, D6
 * crash-window repair, D7 an effect that actually fires through the ledger.
 */

import {
  proposeAction,
  proposeOnce,
  reviseProposal,
  approveWithReconciliation,
  repairSession,
} from "@/platform/action-pipeline";
import { performExternalEffect } from "@/platform/agents/external-effect";
import { InMemoryProposalStore } from "@/platform/agents/proposal-store";
import { InMemoryEffectLedger } from "@/platform/agents/effect-ledger";
import { InMemoryTrajectoryStore } from "@/platform/agents/trajectory-store";
import { InMemoryActivityStateStore } from "@/platform/app-framework";
import type { ActionSpec, AgentIdentity } from "@/platform/kernel";

const actor: AgentIdentity = {
  actorType: "agent",
  actorId: "guardian",
  agentRole: "guardian",
};

const spec: ActionSpec = {
  type: "purge",
  effects: ["restricted"],
  ephemeral: false,
  commutative: false,
};

describe("D3 — revision mints a new proposal under the same operation", () => {
  let proposalStore: InMemoryProposalStore;
  let trajectoryStore: InMemoryTrajectoryStore;
  let trajectoryId: string;

  beforeEach(async () => {
    proposalStore = new InMemoryProposalStore();
    trajectoryStore = new InMemoryTrajectoryStore();
    const rec = await trajectoryStore.create(
      { kind: "agent", id: "guardian" },
      "t",
      "platform"
    );
    trajectoryId = rec.trajectory.trajectoryId;
  });

  function base(operationId: string) {
    return {
      spec,
      actor,
      sessionId: "sess_1",
      trajectoryId,
      stepIndex: 0,
      label: "purge",
      operationId,
      proposalStore,
      trajectoryStore,
    };
  }

  it("supersedes the prior proposal and keeps the operation identity", async () => {
    const first = await proposeAction(base("op_1"));
    const revised = await reviseProposal({ ...base("op_1"), revisedBy: "alice" });

    expect(revised.proposalId).not.toBe(first.proposalId);
    expect(revised.operationId).toBe("op_1");
    expect(revised.status).toBe("proposed");

    const prior = await proposalStore.getById(first.proposalId);
    expect(prior?.status).toBe("superseded");
  });

  it("leaves exactly one live proposal per operation", async () => {
    await proposeAction(base("op_1"));
    await reviseProposal({ ...base("op_1"), revisedBy: "alice" });
    const live = await proposalStore.query({ operationId: "op_1", status: "proposed" });
    expect(live).toHaveLength(1);
  });

  it("records why it was superseded", async () => {
    const first = await proposeAction(base("op_1"));
    await reviseProposal({ ...base("op_1"), revisedBy: "alice", reason: "wrong target" });
    const prior = await proposalStore.getById(first.proposalId);
    expect(prior?.decisionNote).toBe("wrong target");
  });
});

describe("D4 — intent to proposed is deduplicated on operationId", () => {
  let proposalStore: InMemoryProposalStore;
  let trajectoryStore: InMemoryTrajectoryStore;
  let trajectoryId: string;

  beforeEach(async () => {
    proposalStore = new InMemoryProposalStore();
    trajectoryStore = new InMemoryTrajectoryStore();
    const rec = await trajectoryStore.create(
      { kind: "agent", id: "guardian" },
      "t",
      "platform"
    );
    trajectoryId = rec.trajectory.trajectoryId;
  });

  function base(operationId?: string) {
    return {
      spec,
      actor,
      sessionId: "sess_1",
      trajectoryId,
      stepIndex: 0,
      label: "purge",
      operationId,
      proposalStore,
      trajectoryStore,
    };
  }

  it("returns the existing live proposal rather than minting a second", async () => {
    const first = await proposeOnce(base("op_1"));
    const retry = await proposeOnce(base("op_1"));
    expect(retry.proposalId).toBe(first.proposalId);
    expect(await proposalStore.query({ operationId: "op_1" })).toHaveLength(1);
  });

  it("mints a fresh proposal for a different operation", async () => {
    const a = await proposeOnce(base("op_1"));
    const b = await proposeOnce(base("op_2"));
    expect(b.proposalId).not.toBe(a.proposalId);
  });

  it("does not dedup when no operationId is supplied — nothing to key on", async () => {
    const a = await proposeOnce(base(undefined));
    const b = await proposeOnce(base(undefined));
    expect(b.proposalId).not.toBe(a.proposalId);
  });
});

describe("D5 — an approval is bound to the state it was granted against", () => {
  let proposalStore: InMemoryProposalStore;
  let trajectoryStore: InMemoryTrajectoryStore;
  let stateStore: InMemoryActivityStateStore<{ n: number }>;
  let trajectoryId: string;

  beforeEach(async () => {
    proposalStore = new InMemoryProposalStore();
    trajectoryStore = new InMemoryTrajectoryStore();
    stateStore = new InMemoryActivityStateStore<{ n: number }>();
    const rec = await trajectoryStore.create(
      { kind: "agent", id: "guardian" },
      "t",
      "platform"
    );
    trajectoryId = rec.trajectory.trajectoryId;
    await stateStore.create("sess_1", { n: 0 });
  });

  async function propose(observedVersion: number) {
    return proposeAction({
      spec,
      actor,
      sessionId: "sess_1",
      trajectoryId,
      stepIndex: 0,
      label: "purge",
      operationId: "op_1",
      observedVersion,
      proposalStore,
      trajectoryStore,
    });
  }

  it("approves when the version has not moved", async () => {
    const p = await propose(1);
    const outcome = await approveWithReconciliation({
      proposalId: p.proposalId,
      decidedBy: "alice",
      proposalStore,
      trajectoryStore,
      stateStore: stateStore as never,
      spec,
    });
    expect(outcome.kind).toBe("approved");
  });

  it("supersedes a non-commutative approval when the version advanced", async () => {
    const p = await propose(1);
    await stateStore.commit("sess_1", 1, { n: 1 }, "op_other");

    const outcome = await approveWithReconciliation({
      proposalId: p.proposalId,
      decidedBy: "alice",
      proposalStore,
      trajectoryStore,
      stateStore: stateStore as never,
      spec,
    });

    expect(outcome.kind).toBe("stale");
    expect(outcome.observedVersion).toBe(1);
    expect(outcome.currentVersion).toBe(2);
    expect((await proposalStore.getById(p.proposalId))?.status).toBe("superseded");
  });

  it("approves a COMMUTATIVE action even when the version advanced", async () => {
    // reduceCommit applies against latest by construction, so a moved version does not
    // change what the approval means.
    const p = await propose(1);
    await stateStore.commit("sess_1", 1, { n: 1 }, "op_other");

    const outcome = await approveWithReconciliation({
      proposalId: p.proposalId,
      decidedBy: "alice",
      proposalStore,
      trajectoryStore,
      stateStore: stateStore as never,
      spec: { ...spec, commutative: true },
    });

    expect(outcome.kind).toBe("approved");
  });

  it("a superseded approval never produces a stateVersion (D8)", async () => {
    const p = await propose(1);
    await stateStore.commit("sess_1", 1, { n: 1 }, "op_other");
    await approveWithReconciliation({
      proposalId: p.proposalId,
      decidedBy: "alice",
      proposalStore,
      trajectoryStore,
      stateStore: stateStore as never,
      spec,
    });
    const state = await stateStore.load("sess_1");
    expect(state?.producedBy).toBe("op_other");
  });

  it("reports already-decided rather than re-approving", async () => {
    const p = await propose(1);
    await approveWithReconciliation({
      proposalId: p.proposalId,
      decidedBy: "alice",
      proposalStore,
      trajectoryStore,
    });
    const second = await approveWithReconciliation({
      proposalId: p.proposalId,
      decidedBy: "bob",
      proposalStore,
      trajectoryStore,
    });
    expect(second.kind).toBe("already-decided");
  });
});

describe("D6 — crash-window repair completes forward", () => {
  let trajectoryStore: InMemoryTrajectoryStore;
  let stateStore: InMemoryActivityStateStore<{ n: number }>;
  let trajectoryId: string;

  beforeEach(async () => {
    trajectoryStore = new InMemoryTrajectoryStore();
    stateStore = new InMemoryActivityStateStore<{ n: number }>();
    const rec = await trajectoryStore.create(
      { kind: "session", id: "sess_1" },
      "t",
      "user"
    );
    trajectoryId = rec.trajectory.trajectoryId;
    await stateStore.create("sess_1", { n: 0 });
  });

  function repair() {
    return repairSession({
      sessionId: "sess_1",
      trajectoryId,
      actor,
      stateStore: stateStore as never,
      trajectoryStore,
    });
  }

  it("appends the missing tail for a commit with no trajectory step", async () => {
    // The crash window: state committed, process died before the append.
    await stateStore.commit("sess_1", 1, { n: 1 }, "op_interrupted");

    const outcome = await repair();

    expect(outcome.repaired).toBe(true);
    expect(outcome.operationId).toBe("op_interrupted");
    const rec = await trajectoryStore.getById(trajectoryId);
    expect(rec?.trajectory.steps).toHaveLength(1);
    expect(rec?.trajectory.steps[0].operationId).toBe("op_interrupted");
    expect(rec?.trajectory.steps[0].output).toMatchObject({ repaired: true });
  });

  it("never re-applies the state transition", async () => {
    await stateStore.commit("sess_1", 1, { n: 1 }, "op_interrupted");
    await repair();
    const state = await stateStore.load("sess_1");
    // Version 2, not 3: repair records, it does not re-commit.
    expect(state?.version).toBe(2);
    expect(state?.state.n).toBe(1);
  });

  it("is a no-op when the operation was already recorded", async () => {
    await stateStore.commit("sess_1", 1, { n: 1 }, "op_done");
    await trajectoryStore.addStep(trajectoryId, {
      stepIndex: 0,
      action: "commit",
      input: {},
      output: {},
      cost: 0,
      durationMs: 0,
      timestamp: new Date().toISOString(),
      boundary: "commitment",
      operationId: "op_done",
    });

    const outcome = await repair();

    expect(outcome.repaired).toBe(false);
    expect(outcome.reason).toBe("already recorded");
  });

  it("is idempotent — repairing twice appends one step", async () => {
    await stateStore.commit("sess_1", 1, { n: 1 }, "op_interrupted");
    await repair();
    await repair();
    const rec = await trajectoryStore.getById(trajectoryId);
    expect(rec?.trajectory.steps).toHaveLength(1);
  });

  it("reports rather than throwing when there is nothing to repair", async () => {
    const outcome = await repair();
    expect(outcome.repaired).toBe(false);
    expect(outcome.reason).toMatch(/producedBy/);
  });
});

describe("D7 — an effect fires through the ledger, exactly once", () => {
  let ledger: InMemoryEffectLedger;

  beforeEach(() => {
    ledger = new InMemoryEffectLedger();
  });

  it("writes the entry before the call and resolves it after", async () => {
    const outcome = await performExternalEffect({
      operationId: "op_1",
      effectKey: "charge",
      effectType: "externalCall",
      call: async () => ({ id: "ch_1" }),
      ledger,
    });

    expect(outcome.status).toBe("confirmed");
    const entry = await ledger.get("op_1", "charge");
    expect(entry?.status).toBe("confirmed");
    expect(entry?.receipt).toEqual({ id: "ch_1" });
  });

  it("hands the downstream an idempotency key derived from the operation", async () => {
    let seen = "";
    await performExternalEffect({
      operationId: "op_1",
      effectKey: "charge",
      effectType: "externalCall",
      call: async (key) => {
        seen = key;
        return {};
      },
      ledger,
    });
    expect(seen).toContain("op_1");
    expect(seen).toContain("charge");
  });

  it("does not call twice for the same operation and effect", async () => {
    let calls = 0;
    const args = {
      operationId: "op_1",
      effectKey: "charge",
      effectType: "externalCall" as const,
      call: async () => {
        calls += 1;
        return { id: "ch_1" };
      },
      ledger,
    };

    await performExternalEffect(args);
    const second = await performExternalEffect(args);

    expect(calls).toBe(1);
    expect(second.status).toBe("confirmed");
  });

  it("does NOT re-fire an unresolved entry — it reports indeterminate", async () => {
    // A previous attempt began and never resolved: the process died mid-call. Calling
    // again would be at-least-once; assuming failure would be at-most-once.
    await ledger.begin({
      operationId: "op_1",
      effectKey: "charge",
      effectType: "externalCall",
    });

    let calls = 0;
    const outcome = await performExternalEffect({
      operationId: "op_1",
      effectKey: "charge",
      effectType: "externalCall",
      call: async () => {
        calls += 1;
        return {};
      },
      ledger,
    });

    expect(calls).toBe(0);
    expect(outcome.status).toBe("indeterminate");
  });

  it("reconciles an unresolved entry when the downstream can be asked", async () => {
    await ledger.begin({
      operationId: "op_1",
      effectKey: "charge",
      effectType: "externalCall",
    });

    const outcome = await performExternalEffect({
      operationId: "op_1",
      effectKey: "charge",
      effectType: "externalCall",
      call: async () => ({ id: "should-not-be-called" }),
      reconcile: async () => ({ id: "ch_existing" }),
      ledger,
    });

    expect(outcome.status).toBe("confirmed");
  });

  it("records a clear failure as failed", async () => {
    const outcome = await performExternalEffect({
      operationId: "op_1",
      effectKey: "charge",
      effectType: "externalCall",
      call: async () => {
        throw new Error("card declined");
      },
      ledger,
    });
    expect(outcome.status).toBe("failed");
  });

  it("records an ambiguous failure as indeterminate, not failed", async () => {
    // A timeout after send is not a failure — it is an unknown. Recording it as failure
    // invites a retry that double-fires.
    const outcome = await performExternalEffect({
      operationId: "op_1",
      effectKey: "charge",
      effectType: "externalCall",
      call: async () => {
        throw new Error("socket timeout after send");
      },
      ledger,
    });
    expect(outcome.status).toBe("indeterminate");
  });
});
