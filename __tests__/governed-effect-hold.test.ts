/**
 * __tests__/governed-effect-hold.test.ts — A held governed effect is held for real (audit C-13)
 *
 * routeGovernedEffect (the adaptive and content frameworks' one effect router) answered "held"
 * for a gated effect and dropped it: no proposal, so nothing could approve it, and an approval
 * could not make it run. Now, against the real pipeline and stores: a gated effect mints one
 * proposal, does nothing else; once approved it runs exactly once, only for the state approved.
 */

import { routeGovernedEffect } from "@/platform/effects";
import { InMemoryProposalStore } from "@/platform/agents/proposal-store";
import { InMemoryTrajectoryStore } from "@/platform/agents/trajectory-store";
import { approveHeldAction } from "@/platform/agents/gating";
import { InMemoryActivityStateStore } from "@/platform/app-framework/memory-state-store";

interface Level {
  readonly level: number;
}

async function setup() {
  const proposalStore = new InMemoryProposalStore();
  const trajectoryStore = new InMemoryTrajectoryStore();
  const stateStore = new InMemoryActivityStateStore<Level>();
  await stateStore.create("s1", { level: 1 });
  const commits: Level[] = [];
  const commit = stateStore.commit.bind(stateStore);
  jest.spyOn(stateStore, "commit").mockImplementation(async (id, expected, next, by) => {
    const r = await commit(id, expected, next, by);
    if (r.ok) commits.push(next);
    return r;
  });
  return { proposalStore, trajectoryStore, commits, stateStore };
}

async function request(
  env: Awaited<ReturnType<typeof setup>>,
  level: number,
  extra: { approvedProposalId?: string; operationId?: string } = {}
) {
  const trajectory = await env.trajectoryStore.create(
    { kind: "agent", id: "adaptive-host" },
    "adaptive",
    "platform"
  );
  return routeGovernedEffect<Level>({
    // A restricted effect: always over the gating line.
    spec: { type: "set-level", effects: ["restricted"], declaredRisk: "restricted" },
    actor: { actorType: "agent", actorId: "adaptive-host", agentRole: "adaptive" },
    sessionId: "s1",
    label: "set-level",
    cost: 0,
    stateStore: env.stateStore as never,
    trajectoryStore: env.trajectoryStore,
    trajectoryId: trajectory.trajectory.trajectoryId,
    stepIndex: 0,
    expectedVersion: (await env.stateStore.load("s1"))!.version,
    computeNextState: () => ({ level }),
    proposalStore: env.proposalStore,
    ...extra,
  });
}

describe("routeGovernedEffect — holds (C-13)", () => {
  it("mints a proposal for a gated effect and commits nothing", async () => {
    const env = await setup();
    const held = await request(env, 7);
    expect(held).toMatchObject({ status: "held", reason: "requires-approval" });
    const proposal = await env.proposalStore.getById(held.proposalId!);
    expect(proposal).toMatchObject({
      status: "proposed",
      label: "set-level",
      operationId: held.operationId,
      payload: { label: "set-level", nextState: { level: 7 } },
    });
    expect(env.commits).toEqual([]);
  });

  it("runs the approved effect once, and never again on the same approval", async () => {
    const env = await setup();
    const held = await request(env, 7);
    await approveHeldAction({
      proposalId: held.proposalId!,
      decidedBy: "00000000-0000-4000-9000-000000000001",
      proposalStore: env.proposalStore,
      trajectoryStore: env.trajectoryStore,
    } as never);
    const ran = await request(env, 7, {
      approvedProposalId: held.proposalId,
      operationId: held.operationId,
    });
    expect(ran.status).toBe("applied");
    expect(env.commits).toEqual([{ level: 7 }]);
    const again = await request(env, 7, {
      approvedProposalId: held.proposalId,
      operationId: held.operationId,
    });
    expect(again.status).toBe("rejected");
    expect(env.commits).toHaveLength(1);
  });

  it("refuses to run a different state than the one approved", async () => {
    const env = await setup();
    const held = await request(env, 7);
    await approveHeldAction({
      proposalId: held.proposalId!,
      decidedBy: "00000000-0000-4000-9000-000000000001",
      proposalStore: env.proposalStore,
      trajectoryStore: env.trajectoryStore,
    } as never);
    const swapped = await request(env, 99, {
      approvedProposalId: held.proposalId,
      operationId: held.operationId,
    });
    expect(swapped).toMatchObject({ status: "rejected", reason: "requires-approval" });
    expect(env.commits).toEqual([]);
  });

  it("refuses an approval that was never given (no new proposal minted either)", async () => {
    const env = await setup();
    const held = await request(env, 7);
    const early = await request(env, 7, {
      approvedProposalId: held.proposalId,
      operationId: held.operationId,
    });
    expect(early.status).toBe("rejected");
    expect(await env.proposalStore.query({ operationId: held.operationId })).toHaveLength(
      1
    );
  });
});
