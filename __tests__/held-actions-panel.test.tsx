/**
 * @jest-environment jsdom
 */
import React from "react";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { HeldActionsPanel, RESULT_MS } from "@/components/admin/HeldActionsPanel";
import { renderMessage } from "@/platform/errors/messages";
import type { PendingApproval } from "@/platform/admin/pending-approvals";

const holds: PendingApproval[] = [
  {
    source: "runtime",
    id: "p1",
    label: "config.set moderation.strike_ban_threshold",
    requester: "admin-1234567890",
    requiredPermission: "config_manage_safety",
    reason: "Held at effectiveRisk restricted — needs an independent approver.",
    createdAt: "2026-01-02T00:00:00.000Z",
  },
  {
    source: "config-approval",
    id: "a1",
    label: "moderation.blocklist_only_surfaces",
    requester: "admin-2",
    requiredPermission: "config_manage_standard",
    reason: "raises the blocklist scope",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
];

const fetchMock = jest.fn();
beforeAll(() => {
  global.fetch = fetchMock as unknown as typeof fetch;
});
beforeEach(() => {
  fetchMock.mockReset();
});

function resolveFetch(status: number, body: unknown) {
  fetchMock.mockResolvedValue({
    ok: status < 400,
    status,
    json: async () => body,
  } as unknown as Response);
}

const approveBtn = "Approve config.set moderation.strike_ban_threshold";

describe("HeldActionsPanel — ADR-040 040a/040c", () => {
  it("renders a row per hold with approve/reject controls", () => {
    render(<HeldActionsPanel data={{ approvals: holds }} />);
    expect(screen.getByText(/strike_ban_threshold/)).toBeDefined();
    expect(screen.getByText("Runtime hold")).toBeDefined();
    expect(screen.getByRole("button", { name: approveBtn })).toBeDefined();
    expect(screen.getAllByRole("columnheader")).toHaveLength(5);
  });

  it("approves a hold through the decision route and removes the row", async () => {
    resolveFetch(200, { decision: "approve", outcome: "approved" });
    render(<HeldActionsPanel data={{ approvals: holds }} />);
    fireEvent.click(screen.getByRole("button", { name: approveBtn }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/approvals/p1",
      expect.objectContaining({ method: "POST" })
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: approveBtn })).toBeNull()
    );
  });

  it("an approval says it took effect, announced, then shows the empty list (TASK-186)", async () => {
    resolveFetch(200, { decision: "approve", outcome: "approved", applied: true });
    render(<HeldActionsPanel data={{ approvals: [holds[0]] }} />);
    fireEvent.click(screen.getByRole("button", { name: approveBtn }));
    const status = await screen.findByRole("status");
    await waitFor(() =>
      expect(status.textContent).toContain(
        "Approved: config.set moderation.strike_ban_threshold took effect."
      )
    );
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(screen.getByText(/No pending approvals/)).toBeDefined();
    // Dismissed at once on request.
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("the result goes by itself after a few seconds", async () => {
    jest.useFakeTimers();
    try {
      resolveFetch(200, { decision: "reject" });
      render(<HeldActionsPanel data={{ approvals: [holds[0]] }} />);
      fireEvent.click(
        screen.getByRole("button", {
          name: "Reject config.set moderation.strike_ban_threshold",
        })
      );
      await waitFor(() =>
        expect(screen.getByRole("status").textContent).toContain("Rejected: config.set")
      );
      act(() => {
        jest.advanceTimersByTime(RESULT_MS + 10);
      });
      expect(screen.getByRole("status").textContent).toBe("");
    } finally {
      jest.useRealTimers();
    }
  });

  it("a held change now waiting for a second approval says so, not 'took effect'", async () => {
    resolveFetch(200, {
      decision: "approve",
      outcome: "approved",
      applied: false,
      pendingApproval: { id: "x" },
    });
    render(<HeldActionsPanel data={{ approvals: holds }} />);
    fireEvent.click(screen.getByRole("button", { name: approveBtn }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toMatch(
        /waits for a second approval/
      )
    );
  });

  it("approved but the run failed: the reason, through the refusal handler; the row stays", async () => {
    resolveFetch(502, { code: "approvals.run_failed", params: {} });
    render(<HeldActionsPanel data={{ approvals: holds }} />);
    fireEvent.click(screen.getByRole("button", { name: approveBtn }));
    const reason = renderMessage("errors.approvals.run_failed");
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        `${holds[0].label}: ${reason}`
      )
    );
    expect(screen.getByRole("alert").textContent).toBe(reason);
    expect(screen.getByRole("button", { name: approveBtn })).toBeDefined();
  });

  // Round 15, I-1: the run's own code, with the approval kept — the next step for that code. The
  // body is the decision route's (held-config-resume-coded.test.ts feeds the panel's words the
  // route's real answer).
  it.each([
    [
      409,
      "approvals.already_pending",
      { key: "moderation.strike_ban_threshold" },
      /decide the change that is waiting first, then approve this one again/,
    ],
    [503, "service.unavailable", { service: "audit" }, /approve it again to retry/],
    // A refusal approving again would meet the same way: reject it, never "retry".
    [
      422,
      "admin.config_invalid_value",
      { key: "moderation.strike_ban_threshold", reason: "above_max", max: 10 },
      /approving it again would be refused the same way: reject it/,
    ],
    [404, "admin.target_not_found", { target: "k" }, /refused the same way: reject it/],
  ])(
    "approved, the run failed %i %s: what to do next, the row stays",
    async (status, code, params, next) => {
      resolveFetch(status, {
        code,
        params,
        message: renderMessage(`errors.${code}`, params),
        approvalKept: true,
      });
      render(<HeldActionsPanel data={{ approvals: holds }} />);
      fireEvent.click(screen.getByRole("button", { name: approveBtn }));
      await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(next));
      expect(screen.getByRole("status").textContent).toContain(
        renderMessage(`errors.${code}`, params)
      );
      if (status < 500)
        expect(screen.getByRole("status").textContent).not.toMatch(
          /approve it again to retry/
        );
      expect(screen.getByRole("button", { name: approveBtn })).toBeDefined();
    }
  );

  it("surfaces the server error when approval is refused (e.g. self-approval 409)", async () => {
    resolveFetch(409, {
      error: "Self-approval is not permitted; an independent approver must clear this.",
    });
    render(<HeldActionsPanel data={{ approvals: holds }} />);
    fireEvent.click(screen.getByRole("button", { name: approveBtn }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
    expect(screen.getByText(/Self-approval is not permitted/)).toBeDefined();
    expect(screen.getByText(/strike_ban_threshold/)).toBeDefined();
  });

  it("replaces its rows when the page passes fresh data (no stale first render)", () => {
    const { rerender } = render(<HeldActionsPanel data={{ approvals: holds }} />);
    expect(screen.getByRole("button", { name: approveBtn })).toBeTruthy();
    rerender(<HeldActionsPanel data={{ approvals: [holds[1]] }} />);
    expect(screen.queryByRole("button", { name: approveBtn })).toBeNull();
    expect(screen.getByText(/blocklist_only_surfaces/)).toBeTruthy();
  });

  it("an undecided run verified not applied is withdrawn, never run: decision withdraw, and says so (round 5, item 2)", async () => {
    resolveFetch(200, { decision: "withdraw", source: "runtime", status: "rejected" });
    const undecided: PendingApproval = { ...holds[0], undecided: true };
    render(<HeldActionsPanel data={{ approvals: [undecided] }} />);
    const withdraw = screen.getByRole("button", {
      name: `Withdraw ${undecided.label}: verified that it did not take effect; it will not run`,
    });
    fireEvent.click(withdraw);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      decision: "withdraw",
      source: "runtime",
    });
    const status = await screen.findByRole("status");
    await waitFor(() =>
      expect(status.textContent).toContain(
        `Withdrawn: ${undecided.label} did not take effect and will not run.`
      )
    );
  });

  it("an undecided duplicate refused approval again points at withdraw (round 6, I-2; round 8, item 1)", async () => {
    resolveFetch(409, {
      code: "approvals.duplicate_undecided",
      error: renderMessage("errors.approvals.duplicate_undecided"),
    });
    const undecided: PendingApproval = {
      ...holds[0],
      label: "purge_user_data",
      undecided: true,
    };
    render(<HeldActionsPanel data={{ approvals: [undecided] }} />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Approve purge_user_data again: verified that it did not take effect",
      })
    );
    const status = await screen.findByRole("status");
    await waitFor(() =>
      expect(status.textContent).toContain(
        "purge_user_data: another erasure of this account is open, so this one is not approved again. Mark it executed if it took effect; if it did not, withdraw it."
      )
    );
    // The row stays, with its Withdraw control.
    expect(
      screen.getByRole("button", {
        name: "Withdraw purge_user_data: verified that it did not take effect; it will not run",
      })
    ).toBeDefined();
  });

  it("an undecided run no one in the tenant may decide says a platform operator decides it (round 7, I-3)", () => {
    const stuck: PendingApproval = {
      ...holds[0],
      label: "purge_user_data",
      undecided: true,
      noEligibleDecider: true,
    };
    render(<HeldActionsPanel data={{ approvals: [stuck] }} />);
    expect(
      screen.getByText(
        "No one here may approve this again or mark it executed: its requester and the account it acts on cannot decide it, and no one else in good standing who holds config_manage_safety with access to administration meets the change's own rules (one who holds it but not those rules may still withdraw it, if it did not take effect). A platform operator decides it — Operator → Tenants → this tenant → Settings → Held changes."
      )
    ).toBeDefined();
  });

  it("another kind of undecided duplicate gets the generic guidance, not an erasure's (round 9, N-1)", async () => {
    resolveFetch(409, {
      code: "approvals.duplicate_undecided",
      error: renderMessage("errors.approvals.duplicate_undecided"),
    });
    const undecided: PendingApproval = { ...holds[0], undecided: true };
    render(<HeldActionsPanel data={{ approvals: [undecided] }} />);
    fireEvent.click(
      screen.getByRole("button", {
        name: `Approve ${undecided.label} again: verified that it did not take effect`,
      })
    );
    const status = await screen.findByRole("status");
    await waitFor(() =>
      expect(status.textContent).toContain(
        `${undecided.label}: Another hold for the same action on the same subject is open`
      )
    );
    expect(status.textContent).not.toMatch(/erasure/);
  });

  it("the catalog's guidance names withdraw (round 6, I-2)", () => {
    expect(renderMessage("errors.approvals.indeterminate")).toMatch(/withdraw it/);
    // The new-request message stays as it was; the duplicate's guidance is the panel's own
    // (round 7, N-4).
    expect(renderMessage("errors.admin.erasure_pending")).toBe(
      "This account's erasure is already waiting for approval."
    );
    expect(
      renderMessage("screens.held.result_duplicate_undecided", { label: "x" })
    ).toMatch(/withdraw it/);
    // The undecided duplicate's own code says the same (round 8, item 1).
    expect(renderMessage("errors.approvals.duplicate_undecided")).toMatch(
      /Mark it executed.*withdraw it/
    );
  });

  it("shows the empty state when there are no holds", () => {
    render(<HeldActionsPanel data={{ approvals: [] }} />);
    expect(screen.getByText(/No pending approvals/)).toBeDefined();
  });
});

describe("a held approval-policy change (round 12, I-2)", () => {
  it("shows each rule it would store and its default approver", () => {
    render(
      <HeldActionsPanel
        data={{
          approvals: [
            {
              ...holds[0],
              id: "p-policy",
              label: "set_approval_policy",
              summary: {
                approvalPolicy: {
                  rules: [
                    { maxRisk: "ordinary", requiredApprover: "agent" },
                    {
                      maxRisk: "consequential",
                      effects: ["externalCall"],
                      requiredApprover: "user",
                    },
                  ],
                  defaultApprover: "user",
                },
              },
            },
          ],
        }}
      />
    );
    // Each value in the catalog's words (round 13, nit 6), and what the rules do not change
    // (round 13, I-A).
    expect(
      screen.getByText("Rule 1: actions up to ordinary risk are approved by an agent")
    ).toBeDefined();
    expect(
      screen.getByText(
        "Rule 2: actions up to consequential risk with external calls are approved by a person"
      )
    ).toBeDefined();
    expect(screen.getByText("Default approver: a person")).toBeDefined();
    expect(
      screen.getByText(/a person approves it whatever these rules say/)
    ).toBeDefined();
  });
});

describe("HeldActionsPanel — what became of the approval (TASK-194 round 16)", () => {
  // Round 16, items 1, 3 and 4: what became of the approval — undecided (a runtime run's lost
  // commit), settling (a config approval's), withdrawn by the system — said, and the list read
  // again (the decided row is no longer listed as it was).
  it.each([
    [
      "undecided",
      409,
      {
        code: "approvals.indeterminate",
        approvalKept: false,
        undecidedWithinMinutes: 75,
      },
      /listed as undecided within 75 minutes: verify it, then mark it executed if it took effect, or withdraw it/,
    ],
    [
      "settling",
      503,
      { code: "admin.write_indeterminate", settling: true, settlesWithinMinutes: 75 },
      /outcome is being checked: if it did not apply, it is listed again within 75 minutes/,
    ],
    [
      "withdrawn",
      422,
      {
        code: "admin.config_invalid_value",
        params: { key: "k", reason: "above_max", max: 10 },
        withdrawn: true,
      },
      /withdrawn; the requester must ask again/,
    ],
  ])("%s: said, and the list read again", async (_name, status, body, said) => {
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status,
        json: async () => body,
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ approvals: [holds[1]] }),
      } as unknown as Response);
    render(<HeldActionsPanel data={{ approvals: holds }} />);
    fireEvent.click(screen.getByRole("button", { name: approveBtn }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(said));
    expect(screen.getByRole("status").textContent).not.toMatch(
      /approve it again to retry/
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: approveBtn })).toBeNull()
    );
    expect(fetchMock.mock.calls[1][0]).toBe("/api/admin/approvals");
  });

  it("an undecided config hold says a retry of one that applied is refused as stale; another does not", async () => {
    const { refusedDecisionText } = jest.requireActual(
      "@/components/admin/decision-outcome"
    );
    const refused = { code: "approvals.indeterminate", message: "m" };
    const body = { approvalKept: false, undecidedWithinMinutes: 75 };
    expect(refusedDecisionText("update_config", refused, body)).toMatch(
      /refused as stale/
    );
    expect(
      refusedDecisionText("set_entitlement_group_active", refused, body)
    ).not.toMatch(/stale|approve it again/);
  });
});
