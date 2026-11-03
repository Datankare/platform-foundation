/**
 * @jest-environment node
 */
/**
 * platform/admin/__tests__/resume-failure-text.test.ts — what an approved run's error says to the
 * decision: fixed text, the error's own logged (TASK-194 round 15, I-1 and I-5)
 *
 * A run's reason can be a store's message (a table, a constraint); resumeFailure carried the
 * error's message — and with it that reason — into the decision's result. It returns fixed text
 * now, logs the error's, and carries the run's own registry code when it gave one.
 */

import { logger } from "@/lib/logger";
import { resumeFailure } from "@/platform/admin/hold-authority";
import {
  ActionNotRecordedError,
  ApprovedRunFailedError,
  PipelineRejectedError,
} from "@/platform/action-pipeline";
import { HeldActionNotApprovedError } from "@/platform/agents/workflow-loop";

const SECRET = 'duplicate key value violates "secret_internal_index"';
let error: jest.SpyInstance;
beforeEach(() => {
  error = jest.spyOn(logger, "error").mockImplementation(() => undefined);
});
afterEach(() => error.mockRestore());

const said = (r: unknown) => JSON.stringify(r);

describe("resumeFailure (round 15, I-1 and I-5)", () => {
  it.each([
    ["a used approval", new PipelineRejectedError(`used: ${SECRET}`, "approval-used")],
    ["an approval no longer approved", new HeldActionNotApprovedError(SECRET)],
  ])("%s: in use, fixed text, the error logged", (_name, err) => {
    const r = resumeFailure(err);
    expect(r.kind).toBe("in_use");
    expect(said(r)).not.toContain("secret_internal_index");
    expect(error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ error: expect.stringContaining("secret_internal_index") })
    );
  });

  it("a run that failed: fixed text, the approval kept as released, the error logged", () => {
    const r = resumeFailure(
      new ApprovedRunFailedError("update_config", "p1", SECRET, true)
    );
    expect(r).toEqual({
      kind: "failed",
      error: "The approved change was not applied.",
      approvalKept: true,
    });
    expect(error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ error: expect.stringContaining("secret_internal_index") })
    );
  });

  it("a run whose claim was not given back: approvalKept false", () => {
    const r = resumeFailure(
      new ApprovedRunFailedError("update_config", "p1", "x", false)
    );
    expect(r).toMatchObject({ kind: "failed", approvalKept: false });
  });

  it("a coded run: its code and params", () => {
    const r = resumeFailure(
      new ApprovedRunFailedError(
        "update_config",
        "p1",
        "approvals.already_pending",
        true,
        {
          failure: { code: "approvals.already_pending", params: { key: "k" } },
        }
      )
    );
    expect(r).toEqual({
      kind: "failed",
      error: "The approved change was not applied.",
      approvalKept: true,
      code: "approvals.already_pending",
      params: { key: "k" },
    });
  });

  // Round 20, residual A; round 21, I-1 and nit 6: a change refused for good is `refused` — only
  // when its claim was given back; a claim kept is a run whose outcome is a person's to decide.
  describe("a change refused for good (jobs.schedule_required)", () => {
    const refusedRun = (released: boolean) =>
      new ApprovedRunFailedError(
        "update_config",
        "p1",
        "jobs.schedule_required",
        released,
        {
          failure: { code: "jobs.schedule_required", params: {} },
        }
      );

    it("its claim given back: refused, with its code — logged as a warning, no withdrawal claimed", () => {
      const warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
      try {
        expect(resumeFailure(refusedRun(true))).toEqual({
          kind: "refused",
          error: "The approved change is refused as it stands now.",
          code: "jobs.schedule_required",
          params: {},
        });
        expect(warn).toHaveBeenCalledWith(
          expect.not.stringMatching(/withdrawn/),
          expect.objectContaining({ code: "jobs.schedule_required" })
        );
        expect(error).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it("its claim kept (released false): failed, approval not kept — never refused", () => {
      expect(resumeFailure(refusedRun(false))).toMatchObject({
        kind: "failed",
        approvalKept: false,
      });
    });

    it("stale with its claim kept: failed, approval not kept — never stale", () => {
      expect(
        resumeFailure(
          new ApprovedRunFailedError("update_config", "p1", "approvals.stale", false)
        )
      ).toMatchObject({ kind: "failed", approvalKept: false });
    });
  });

  it("an unregistered or catch-all code is no code", () => {
    for (const code of ["not.a.code", "admin.action_failed", "internal.error"])
      expect(
        resumeFailure(
          new ApprovedRunFailedError("t", "p", code, true, { failure: { code } })
        )
      ).not.toHaveProperty("code");
  });

  it("applied, its record not stored: fixed text, the error logged", () => {
    const r = resumeFailure(new ActionNotRecordedError("t", "op", true, SECRET));
    expect(r).toMatchObject({ kind: "applied" });
    expect(said(r)).not.toContain("secret_internal_index");
  });
});
