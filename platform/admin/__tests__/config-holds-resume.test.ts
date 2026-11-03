/**
 * @jest-environment node
 */
/**
 * platform/admin/__tests__/config-holds-resume.test.ts — an approved held config change whose run
 * files a two-person approval reports pending only when it was filed (TASK-194 round 13, P-1)
 *
 * A held config change, once approved, runs; on a safety key with two-person approval on, the run
 * files a config approval. When that filing is refused — another change to the key already
 * waiting — the result says `requiresApproval` with an `approvalError`: nothing is pending, and
 * the hold's run failed. It was reported pending.
 */

const mockRun = jest.fn();
jest.mock("@/platform/admin/config-handlers", () => ({
  ...jest.requireActual("@/platform/admin/config-handlers"),
  runApprovedConfigChange: (...args: unknown[]) => mockRun(...args),
}));

import { CONFIG_HOLDS } from "@/platform/admin/hold-authority";
import type { ProposalRecord } from "@/platform/kernel/types";

const proposal = {
  proposalId: "p1",
  label: "update_config",
  payload: {},
} as unknown as ProposalRecord;
const ran = (data: Record<string, unknown>) => ({
  toolId: "update_config",
  success: true,
  data,
  durationMs: 0,
});

it("a filed two-person approval is pending", async () => {
  mockRun.mockResolvedValue(
    ran({ applied: false, requiresApproval: true, approval: { id: "a" } })
  );
  await expect(CONFIG_HOLDS.resume(proposal)).resolves.toMatchObject({ kind: "pending" });
});

it("a refused filing is a failed run, never pending (round 13, P-1)", async () => {
  mockRun.mockResolvedValue(
    ran({
      applied: false,
      requiresApproval: true,
      approvalError: 'A pending approval already exists for "k".',
    })
  );
  await expect(CONFIG_HOLDS.resume(proposal)).resolves.toMatchObject({
    kind: "failed",
    error: expect.stringContaining("already exists"),
  });
});

// Round 21, nit 7: a run that answered (no error thrown) refused for good — a required job's key,
// held before the job was required — is `refused`, with its code: the decision withdraws it.
it("a run that answered jobs.schedule_required is refused, with its code", async () => {
  mockRun.mockResolvedValue({
    toolId: "update_config",
    success: true,
    data: { applied: false, error: "required" },
    errorCode: "jobs.schedule_required",
    errorParams: {},
    durationMs: 0,
  });
  await expect(CONFIG_HOLDS.resume(proposal)).resolves.toMatchObject({
    kind: "refused",
    code: "jobs.schedule_required",
  });
});
