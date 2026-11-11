/**
 * @jest-environment node
 */
/**
 * __tests__/pending-approvals-eligible.test.ts — whether anyone in the tenant may decide an
 * undecided hold (TASK-194 round 7, I-3; round 8, items 5 and 6)
 *
 * listPendingApprovals marks an undecided hold that no one in its tenant may decide
 * (`noEligibleDecider`): read only for a viewer (the Approvals screens — never for the command
 * bar's context), in one statement for every undecided hold listed, whatever their number. The
 * statement's SQL is proved against Postgres in __tests__/db/operator-tenant-config.db.test.ts.
 */

jest.mock("@/platform/data", () => require("./helpers/fake-data").fakeDataModule());

import { fakeData } from "./helpers/fake-data";
import {
  InMemoryProposalStore,
  setProposalStore,
} from "@/platform/agents/proposal-store";
import { listPendingApprovals } from "@/platform/admin/pending-approvals";
import type { HoldAuthority } from "@/platform/admin/hold-authority";
import { CALLERS } from "./helpers/test-identities";
import { renderShown } from "@/platform/errors/shown-text";

let proposals: InMemoryProposalStore;

const authority: HoldAuthority = {
  name: "test",
  owns: () => true,
  requiredPermission: async () => "admin_purge_user_data",
  resume: async () => ({ kind: "applied" }),
};

const viewer = {
  userId: CALLERS.super_admin.userId,
  sub: CALLERS.super_admin.sub,
  roleName: "super_admin",
  permissions: CALLERS.super_admin.permissions,
};

/** `n` undecided holds: approved, claimed, recovered as undecided. */
async function undecided(n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const p = await proposals.create({
      operationId: `op_${i}`,
      sessionId: `s-${i}`,
      trajectoryId: `t-${i}`,
      label: "purge_user_data",
      actor: {
        actorType: "agent",
        actorId: "command-bar",
        agentRole: "command-bar",
        onBehalfOf: CALLERS.admin.userId,
      },
      effects: ["stateWrite"],
      effectiveRisk: "restricted",
      payload: {
        userId: `00000000-0000-4000-9000-00000000000${i}`,
        reason: "admin-action",
      },
    });
    await proposals.decide(p.proposalId, "approved", CALLERS.super_admin.userId, "ok");
    await proposals.claim(p.proposalId);
    ids.push(p.proposalId);
  }
  proposals.recoverStaleRuns(Date.now() + 1000);
  return ids;
}

/**
 * The statements that read who may decide (the users table, with their permissions) — not the
 * one that names the requesters by address (TASK-202, N-61: platform/admin/account-names.ts).
 */
const deciderReads = () =>
  fakeData().statements.filter(
    (s) => /\bfrom users\b/.test(s.sql) && !/\bas erased\b/.test(s.sql)
  );

beforeEach(() => {
  fakeData().reset();
  proposals = new InMemoryProposalStore();
  setProposalStore(proposals);
  // No one may decide any hold asked about: every hold's count is 0.
  fakeData().answer = (sql, values) =>
    /\bfrom users\b/.test(sql)
      ? (values[0] as string[]).map((holdId) => ({
          hold_id: holdId,
          user_id: null,
          total: 0,
        }))
      : undefined;
});

it("reads nothing about deciders without a viewer (the command bar's context) — round 8, item 5", async () => {
  await undecided(3);
  const listed = await listPendingApprovals([authority]);
  expect(listed).toHaveLength(3);
  expect(listed.some((a) => a.noEligibleDecider)).toBe(false);
  expect(deciderReads()).toEqual([]);
});

it.each([1, 5])(
  "reads who may decide %i undecided hold(s) in one statement — round 8, item 5",
  async (n) => {
    const ids = await undecided(n);
    const listed = await listPendingApprovals([authority], viewer);
    expect(
      listed
        .filter((a) => a.noEligibleDecider)
        .map((a) => a.id)
        .sort()
    ).toEqual([...ids].sort());
    expect(deciderReads()).toHaveLength(1);
  }
);

it("asks for the hold's permission and can_access_admin, never the requester or the account — round 8, item 6", async () => {
  const [id] = await undecided(1);
  await listPendingApprovals([authority], viewer);
  const [read] = deciderReads();
  expect(read.values[0]).toEqual([id]);
  expect(read.values[1]).toEqual(["admin_purge_user_data"]);
  const excluded = JSON.parse((read.values[2] as string[])[0]) as string[];
  expect(excluded).toEqual(
    expect.arrayContaining([CALLERS.admin.userId, "00000000-0000-4000-9000-000000000000"])
  );
  expect(read.values[3]).toEqual(
    expect.arrayContaining(["admin_purge_user_data", "can_access_admin"])
  );
});

it("an undecided row's reason names all three decisions, withdraw among them (round 8, pre-existing)", async () => {
  await undecided(1);
  const [row] = await listPendingApprovals([authority]);
  expect(renderShown(row.reason)).toMatch(
    /mark it executed — or, if it did not take effect, approve it again or withdraw it/
  );
});

describe("the approver rules (round 9, P-2; round 10, I-C)", () => {
  /** `n` possible deciders for every hold asked about. */
  const deciders = (n: number) => {
    fakeData().answer = (sql, values) =>
      /\bfrom users\b/.test(sql)
        ? (values[0] as string[]).flatMap((holdId) =>
            Array.from({ length: Math.min(n, values[5] as number) }, (_, i) => ({
              hold_id: holdId,
              user_id: `00000000-0000-4000-8000-00000000010${i}`,
              sub: `sub-${i}`,
              role_name: "admin",
              permissions: ["admin_purge_user_data", "can_access_admin"],
              total: n,
            }))
          )
        : undefined;
  };
  /**
   * An authority whose rules read their facts once per hold (`load`) and decide each approver
   * from them (`decide`), refusing every one, or none.
   */
  const ruled = (refuse: boolean) => {
    const decide = jest.fn(() =>
      refuse
        ? { code: "auth.grant_exceeds_own" as const, params: { permission: "x" } }
        : undefined
    );
    const load = jest.fn(async () => decide);
    return { authority: { ...authority, approverRuleCheck: load }, load, decide };
  };

  it("flags a hold whose every possible decider fails its rules", async () => {
    const [id] = await undecided(1);
    deciders(2);
    const { authority: a, decide } = ruled(true);
    const listed = await listPendingApprovals([a], viewer);
    expect(listed.find((x) => x.id === id)?.noEligibleDecider).toBe(true);
    expect(decide).toHaveBeenCalledTimes(2);
    expect(deciderReads()).toHaveLength(1);
  });

  it("does not flag a hold one of whose possible deciders passes its rules", async () => {
    const [id] = await undecided(1);
    deciders(2);
    const { authority: a } = ruled(false);
    const listed = await listPendingApprovals([a], viewer);
    expect(listed.find((x) => x.id === id)?.noEligibleDecider).toBeUndefined();
  });

  it("reads each hold's facts once, whatever the number of its candidates (round 10, I-C)", async () => {
    await undecided(3);
    deciders(8);
    const { authority: a, load, decide } = ruled(true);
    await listPendingApprovals([a], viewer);
    // One load per hold, then every candidate decided in memory.
    expect(load).toHaveBeenCalledTimes(3);
    expect(decide).toHaveBeenCalledTimes(3 * 8);
  });

  it("never claims a hold whose rules cannot be read — and lists it all the same (round 11, nit 4)", async () => {
    const [id] = await undecided(1);
    deciders(2);
    const { authority: a, load } = ruled(true);
    load.mockRejectedValueOnce(new Error("lookup unavailable"));
    const listed = await listPendingApprovals([a], viewer);
    expect(listed.find((x) => x.id === id)).toBeDefined();
    expect(listed.find((x) => x.id === id)?.noEligibleDecider).toBeUndefined();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("checks at most a bounded number of deciders, and never claims past it", async () => {
    const [id] = await undecided(1);
    deciders(50);
    const { authority: a, load } = ruled(true);
    const listed = await listPendingApprovals([a], viewer);
    expect(listed.find((x) => x.id === id)?.noEligibleDecider).toBeUndefined();
    expect(load).not.toHaveBeenCalled();
  });
});
