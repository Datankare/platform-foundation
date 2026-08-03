/**
 * __tests__/proposal-store-singleton.test.ts
 *
 * Registry slot #17's wiring. setProposalStore is what the provider registry calls, and
 * nothing else proved it takes effect — the same shape as SupabaseActivityStateStore, which
 * shipped dead for a sprint because no test ever reached it (TASK-066).
 */

import {
  InMemoryProposalStore,
  getProposalStore,
  setProposalStore,
  resetProposalStore,
} from "@/platform/agents/proposal-store";
import type { AgentIdentity } from "@/platform/kernel";

const actor: AgentIdentity = {
  actorType: "agent",
  actorId: "guardian",
  agentRole: "guardian",
};

describe("proposal store singleton (registry slot #17)", () => {
  afterEach(() => {
    resetProposalStore();
  });

  it("defaults to an in-memory store", () => {
    expect(getProposalStore()).toBeInstanceOf(InMemoryProposalStore);
  });

  it("setProposalStore takes effect and returns the previous store", async () => {
    const first = getProposalStore();
    const replacement = new InMemoryProposalStore();

    const previous = setProposalStore(replacement);

    expect(previous).toBe(first);
    expect(getProposalStore()).toBe(replacement);

    // Prove it is the ACTIVE store, not merely the returned one.
    await getProposalStore().create({
      operationId: "op_1",
      sessionId: "sess_1",
      trajectoryId: "traj_1",
      label: "purge",
      actor,
      effects: ["restricted"],
      effectiveRisk: "restricted",
    });
    expect(await replacement.query({})).toHaveLength(1);
  });

  it("resetProposalStore installs a fresh store", async () => {
    await getProposalStore().create({
      operationId: "op_1",
      sessionId: "sess_1",
      trajectoryId: "traj_1",
      label: "purge",
      actor,
      effects: ["restricted"],
      effectiveRisk: "restricted",
    });
    expect(await getProposalStore().query({})).toHaveLength(1);

    resetProposalStore();

    expect(await getProposalStore().query({})).toHaveLength(0);
  });
});
