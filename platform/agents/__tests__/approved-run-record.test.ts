/**
 * @jest-environment node
 */
/**
 * platform/agents/__tests__/approved-run-record.test.ts — what the invoker records of an approved
 * run that did not take effect (TASK-194 rounds 17–18)
 */

const mockWrite = jest.fn();
jest.mock("@/platform/auth/audit", () => ({
  ...jest.requireActual("@/platform/auth/audit"),
  writeAuditLogOutsideTransaction: (...a: unknown[]) => mockWrite(...a),
}));

import { ApprovedRunFailedError, LOST_COMMIT_CODE } from "@/platform/action-pipeline";
import { recordApprovedRunFailed } from "@/platform/agents/tool-invoker";

const lost = (released: boolean) =>
  new ApprovedRunFailedError("t", "p1", LOST_COMMIT_CODE, released, {
    failure: { code: LOST_COMMIT_CODE },
  });
const typeOf = () =>
  (mockWrite.mock.calls[0][0] as { details: { type: string } }).details.type;

beforeEach(() => mockWrite.mockReset());

describe("recordApprovedRunFailed (rounds 17–18)", () => {
  it("a lost commit whose claim was kept: approved_run_indeterminate", async () => {
    await recordApprovedRunFailed(lost(false), "t", "agent:a");
    expect(typeOf()).toBe("approved_run_indeterminate");
  });

  it("a lost commit whose claim was released (an atomic run, rolled back with it): a failed run", async () => {
    await recordApprovedRunFailed(lost(true), "t", "agent:a");
    expect(typeOf()).toBe("approved_run_failed");
  });
});
