/**
 * @jest-environment node
 */
/**
 * __tests__/purge-self-target.test.ts — an erasure of one's own account is refused as such, before
 * anything is read (TASK-194 round 11, nit 5)
 *
 * The erasure's rule reads the account (its role) once, then decides; self-targeting needs no
 * read, so it is decided first (`beforeFacts`): with the account lookup unavailable, asking to
 * erase one's own account still answers `admin.self_target` — for the requester (applyRule) and
 * for an approver (the hold authority's approverRuleRefusal) — never a lookup failure.
 */

const mockWithTenantTx = jest.fn();
jest.mock("@/platform/data", () => ({
  ...jest.requireActual("@/platform/data"),
  withTenantTx: (...args: unknown[]) => mockWithTenantTx(...args),
}));

import { checkPurgeUserData, purgeUserDataRule } from "@/app/api/admin/ai/handlers";
import { COMMAND_BAR_HOLDS } from "@/app/api/admin/ai/command-bar";
import type { VerifiedAdmin } from "@/platform/auth/admin-guard";
import type { ProposalRecord } from "@/platform/kernel/types";

const ME = "00000000-0000-4000-8000-0000000000a1";
const admin = {
  userId: ME,
  sub: "sub-me",
  roleName: "super_admin",
  permissions: ["admin_purge_user_data", "can_access_admin"],
} as unknown as VerifiedAdmin;

beforeEach(() => {
  mockWithTenantTx.mockReset().mockRejectedValue(new Error("lookup unavailable"));
});

it("the requester: admin.self_target, with the account unreadable", async () => {
  await expect(
    checkPurgeUserData({ userId: ME, reason: "account-deletion" }, admin)
  ).resolves.toMatchObject({ code: "admin.self_target" });
  expect(mockWithTenantTx).not.toHaveBeenCalled();
});

it("an approver: admin.self_target, with the account unreadable", async () => {
  const proposal = {
    proposalId: "p1",
    label: "purge_user_data",
    payload: { userId: ME, reason: "account-deletion" },
  } as unknown as ProposalRecord;
  await expect(
    COMMAND_BAR_HOLDS.approverRuleRefusal!(proposal, admin)
  ).resolves.toMatchObject({
    code: "admin.self_target",
  });
  expect(mockWithTenantTx).not.toHaveBeenCalled();
});

it("another account still needs its read: unreadable, it fails closed (throws)", async () => {
  await expect(
    checkPurgeUserData(
      { userId: "00000000-0000-4000-8000-0000000000b2", reason: "account-deletion" },
      admin
    )
  ).rejects.toThrow("lookup unavailable");
  expect(purgeUserDataRule.beforeFacts).toBeDefined();
});
