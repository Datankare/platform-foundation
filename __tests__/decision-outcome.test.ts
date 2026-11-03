/**
 * __tests__/decision-outcome.test.ts — the shared reader of a refused decision (TASK-194 round 17:
 * I-2 a change being settled, I-3 the requester's standing, nit 2 no
 * invented bound)
 */

import { changesTheList, refusedDecisionText } from "@/components/admin/decision-outcome";
import { renderMessage } from "@/platform/errors/messages";

const refused = (code: string, message = "M.") => ({ code, message });

describe("refusedDecisionText (round 17)", () => {
  it("no bound given: none invented (nit 2) — it said 75 minutes", () => {
    const undecided = refusedDecisionText("x", refused("approvals.indeterminate"), {
      approvalKept: false,
    });
    expect(undecided).toMatch(/once its run's lease has passed/);
    expect(undecided).not.toMatch(/\d+ minutes?/);
    const settling = refusedDecisionText("x", refused("admin.write_indeterminate"), {
      settling: true,
    });
    expect(settling).toMatch(/it is listed again\./);
    expect(settling).not.toMatch(/\d+ minutes?/);
  });

  it("a bound given: said", () => {
    expect(
      refusedDecisionText("x", refused("approvals.indeterminate"), {
        approvalKept: false,
        undecidedWithinMinutes: 20,
      })
    ).toMatch(/within 20 minutes/);
  });

  it("the requester's standing is the requester's — never 'reject it, you lack…'", () => {
    const text = refusedDecisionText(
      "change_user_role",
      refused(
        "approvals.requester_lacks_permission",
        "The account that requested this no longer holds admin_manage_users."
      ),
      { approvalKept: true }
    );
    expect(text).toBe(
      "change_user_role: The account that requested this no longer holds admin_manage_users."
    );
  });

  it("a change being settled: approve this one again once it is", () => {
    expect(
      refusedDecisionText("update_config", refused("approvals.settling"), {
        approvalKept: true,
      })
    ).toMatch(/approve it again once that change is settled/);
  });
});

// Round 21: stale without `withdrawn` — the withdrawal did not land (or an older answer): what to
// do, never "it was withdrawn", and the list read again — the row may no longer be what it was.
describe("a stale answer without withdrawn (round 21)", () => {
  const stale = {
    code: "approvals.stale",
    message:
      "What this change would replace changed after it was requested, so nothing was changed. Request the change again.",
  };

  it("says what to do next, never that it was withdrawn", () => {
    const text = refusedDecisionText("update_config", stale, { code: "approvals.stale" });
    expect(text).toMatch(/nothing was changed/);
    expect(text).toMatch(/reject it/);
    expect(text).not.toMatch(/withdrawn/);
  });

  it("reads the list again", () => {
    expect(changesTheList({ code: "approvals.stale" })).toBe(true);
    expect(changesTheList({ code: "approvals.run_failed", approvalKept: true })).toBe(
      false
    );
  });

  it("withdrawn: the withdrawn text, as before", () => {
    expect(
      refusedDecisionText("update_config", stale, {
        code: "approvals.stale",
        withdrawn: true,
      })
    ).toMatch(/It was withdrawn; the requester must ask again/);
  });
});

// Round 22, I-1: stale, its withdrawal not recorded, and settling (a two-person approval whose
// withdrawal did not land is left approved and unapplied, for the approval-expiry job): it is not
// listed until then — say when, and to reject it then.
describe("a stale answer that is settling (round 22)", () => {
  const stale = { code: "approvals.stale", message: "M." };

  it("says it is listed again within the bound, and to reject it then", () => {
    const text = refusedDecisionText("update_config", stale, {
      code: "approvals.stale",
      settling: true,
      settlesWithinMinutes: 75,
    });
    expect(text).toMatch(/listed again within 75 minutes; reject it then/);
    expect(text).not.toMatch(/still listed/);
  });

  it("no bound given: none invented", () => {
    const text = refusedDecisionText("update_config", stale, {
      code: "approvals.stale",
      settling: true,
    });
    expect(text).toMatch(/reject it then/);
    expect(text).not.toMatch(/\d+ minute/);
  });
});

// Round 22, residual: approvals.stale answers a role change too (the command bar's) — its message
// names no setting.
it("approvals.stale's message is the same for any held change: it names no setting", () => {
  const message = renderMessage("errors.approvals.stale");
  // Its own text (round 23, nit 4): a missing key renders as no message at all.
  expect(message).toMatch(/nothing was changed/);
  expect(message).not.toMatch(/setting/i);
  expect(message).not.toMatch(/withdrawn/i);
  expect(
    refusedDecisionText(
      "change_role",
      { code: "approvals.stale", message },
      {
        code: "approvals.stale",
      }
    )
  ).not.toMatch(/setting/i);
});
