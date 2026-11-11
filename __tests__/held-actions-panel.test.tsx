/**
 * @jest-environment jsdom
 */
import React from "react";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { HeldActionsPanel } from "@/components/admin/HeldActionsPanel";
import { renderMessage } from "@/platform/errors/messages";
import type { PendingApproval } from "@/platform/admin/pending-approvals";
import { routeAnswer, type RouteFixtureName } from "@/__tests__/fixtures/route-responses";

// Every list and every answer is the routes' own (__tests__/fixtures/route-responses.json, made by
// __tests__/route-fixtures.test.ts): a held change to the dual-control list (a runtime hold) and a
// two-person approval of a safety setting.
const list = (name: RouteFixtureName) =>
  (routeAnswer(name)[1] as { approvals: PendingApproval[] }).approvals;
const holds = list(
  "GET /api/admin/approvals — held changes, to a second admin who may decide them"
);
const DECISION = "POST /api/admin/approvals/[id] —";
const messageOf = (name: RouteFixtureName) =>
  (routeAnswer(name)[1] as { message: string }).message;

const fetchMock = jest.fn();
beforeAll(() => {
  global.fetch = fetchMock as unknown as typeof fetch;
});
beforeEach(() => {
  fetchMock.mockReset();
});

/** A route's own answer, as fetch resolves it. */
function reply(name: RouteFixtureName): Response {
  const [status, body] = routeAnswer(name);
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}
function resolveFetch(name: string) {
  fetchMock.mockResolvedValue(reply(name as RouteFixtureName));
}

const LABEL = "Setting config.dual_control_keys";
const approveBtn = `Approve: ${LABEL}`;

/** Approve (or reject) a row: its button, then the confirm step's (TASK-202, N-61). */
function decideRow(name: string, confirm = "Approve and apply") {
  fireEvent.click(screen.getByRole("button", { name }));
  fireEvent.click(screen.getByRole("button", { name: confirm }));
}

describe("HeldActionsPanel — ADR-040 040a/040c", () => {
  it("renders a card per hold with approve/reject controls", () => {
    render(<HeldActionsPanel data={{ approvals: holds }} />);
    expect(screen.getAllByText(/strike_ban_threshold/).length).toBeGreaterThan(0);
    // Why it waits, in words (TASK-202, N-61): no state → a dual-controlled change.
    expect(screen.getAllByText(/Under dual control/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: approveBtn })).toBeDefined();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("approves a hold through the decision route and removes the row", async () => {
    resolveFetch(`${DECISION} approved, it took effect`);
    render(<HeldActionsPanel data={{ approvals: holds }} />);
    decideRow(approveBtn);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/admin/approvals/${holds[0]!.id}`,
      expect.objectContaining({ method: "POST" })
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: approveBtn })).toBeNull()
    );
  });

  it("an approval says it took effect, announced, then shows the empty list (TASK-186)", async () => {
    resolveFetch(`${DECISION} approved, it took effect`);
    render(<HeldActionsPanel data={{ approvals: [holds[0]!] }} />);
    decideRow(approveBtn);
    const status = await screen.findByRole("status");
    await waitFor(() =>
      expect(status.textContent).toContain(
        `Approved: ${LABEL}. Applied: the setting is now ["signups_enabled","config.dual_control_keys","default_language"].`
      )
    );
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(screen.getByText(/No pending approvals/)).toBeDefined();
    // Dismissed at once on request.
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("the result stays until dismissed (TASK-202, N-62: it went by itself after seconds)", async () => {
    jest.useFakeTimers();
    try {
      resolveFetch(`${DECISION} rejected`);
      render(<HeldActionsPanel data={{ approvals: [holds[0]!] }} />);
      decideRow(`Reject: ${LABEL}`, "Reject it");
      await waitFor(() =>
        expect(screen.getByRole("status").textContent).toContain(
          `Rejected: ${LABEL}. Nothing was changed.`
        )
      );
      act(() => {
        jest.advanceTimersByTime(10 * 60_000);
      });
      expect(screen.getByRole("status").textContent).toContain(`Rejected: ${LABEL}`);
    } finally {
      jest.useRealTimers();
    }
  });

  it("a held change now waiting for a second approval says so, not 'took effect'", async () => {
    resolveFetch(`${DECISION} approved, now waiting for a second approval`);
    render(<HeldActionsPanel data={{ approvals: holds }} />);
    decideRow(approveBtn);
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toMatch(
        /waits for a second approval/
      )
    );
  });

  it("approved but the run failed: the reason, through the refusal handler; the row stays", async () => {
    resolveFetch(`${DECISION} approved, the run failed`);
    render(<HeldActionsPanel data={{ approvals: holds }} />);
    decideRow(approveBtn);
    const reason = renderMessage("errors.approvals.run_failed");
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(`${LABEL}: ${reason}`)
    );
    expect(screen.getByRole("alert").textContent).toBe(reason);
    expect(screen.getByRole("button", { name: approveBtn })).toBeDefined();
  });

  // Round 15, I-1: the run's own code, with the approval kept — the next step for that code. The
  // body is the decision route's (held-config-resume-coded.test.ts feeds the panel's words the
  // route's real answer).
  it.each([
    [
      "a change already waiting",
      /decide the change that is waiting first, then approve this one again/,
    ],
    ["the audit log down", /approve it again to retry/],
    // A refusal approving again would meet the same way: reject it, never "retry".
    [
      "the value now refused",
      /approving it again would be refused the same way: reject it/,
    ],
    ["the setting gone", /refused the same way: reject it/],
  ])(
    "approved, the run failed (%s): what to do next, the row stays",
    async (why, next) => {
      const name = `${DECISION} approved, the run failed (${why})` as RouteFixtureName;
      const status = routeAnswer(name)[0];
      resolveFetch(name);
      render(<HeldActionsPanel data={{ approvals: holds }} />);
      decideRow(approveBtn);
      await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(next));
      expect(screen.getByRole("status").textContent).toContain(messageOf(name));
      if (status < 500)
        expect(screen.getByRole("status").textContent).not.toMatch(
          /approve it again to retry/
        );
      expect(screen.getByRole("button", { name: approveBtn })).toBeDefined();
    }
  );

  it("surfaces the server error when approval is refused (self-approval 409)", async () => {
    const refused = `${DECISION} refused (its own requester)` as RouteFixtureName;
    resolveFetch(refused);
    render(<HeldActionsPanel data={{ approvals: holds }} />);
    decideRow(approveBtn);
    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
    // Said at the row and in the results, which stay (TASK-202, N-62).
    expect(screen.getByRole("alert").textContent).toContain(messageOf(refused));
    expect(screen.getByRole("status").textContent).toContain(messageOf(refused));
    // The row stays.
    expect(screen.getByRole("button", { name: approveBtn })).toBeDefined();
  });

  it("replaces its rows when the page passes fresh data (no stale first render)", () => {
    const { rerender } = render(<HeldActionsPanel data={{ approvals: holds }} />);
    expect(screen.getByRole("button", { name: approveBtn })).toBeTruthy();
    rerender(<HeldActionsPanel data={{ approvals: [holds[1]!] }} />);
    expect(screen.queryByRole("button", { name: approveBtn })).toBeNull();
    expect(screen.getAllByText(/strike_ban_threshold/).length).toBeGreaterThan(0);
  });

  it("an undecided run verified not applied is withdrawn, never run: decision withdraw, and says so (round 5, item 2)", async () => {
    resolveFetch(`${DECISION} an undecided run withdrawn`);
    const [undecided] = list("GET /api/admin/approvals — a held change, undecided");
    render(<HeldActionsPanel data={{ approvals: [undecided!] }} />);
    const withdraw = screen.getByRole("button", {
      name: `Withdraw ${LABEL}: verified that it did not take effect; it will not run`,
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
      expect(status.textContent).toContain(`Withdrawn: ${LABEL}. It will not run.`)
    );
  });

  it("an undecided duplicate refused approval again points at withdraw (round 6, I-2; round 8, item 1)", async () => {
    resolveFetch(`${DECISION} an undecided erasure approved again, another open`);
    const erasures = list(
      "GET /api/admin/approvals — an undecided erasure, another open"
    );
    render(<HeldActionsPanel data={{ approvals: erasures }} />);
    const erase = "Erase the account ann@example.com";
    fireEvent.click(
      screen.getByRole("button", {
        name: `Approve ${erase} again: verified that it did not take effect`,
      })
    );
    const status = await screen.findByRole("status");
    await waitFor(() =>
      expect(status.textContent).toContain(
        `${erase}: another erasure of this account is open, so this one is not approved again. Mark it executed if it took effect; if it did not, withdraw it.`
      )
    );
    // The row stays, with its Withdraw control.
    expect(
      screen.getByRole("button", {
        name: `Withdraw ${erase}: verified that it did not take effect; it will not run`,
      })
    ).toBeDefined();
  });

  it("an undecided run no one in the tenant may decide says a platform operator decides it (round 7, I-3)", () => {
    const [stuck] = list(
      "GET /api/admin/approvals — an undecided erasure, no one here may decide it"
    );
    expect(stuck!.noEligibleDecider).toBe(true);
    render(<HeldActionsPanel data={{ approvals: [stuck!] }} />);
    expect(
      screen.getByText(
        /^No one here may approve this again or mark it executed: its requester and the account it acts on cannot decide it, and no one else in good standing who holds admin_purge_user_data with access to administration meets the change's own rules .* A platform operator decides it — Operator → Tenants → this tenant → Settings → Held changes\.$/
      )
    ).toBeDefined();
  });

  // Only an erasure's authority finds duplicates (HoldAuthority.duplicateOf, TASK-199), so the
  // decision route answers no other hold with this code; the words for one are the generic ones.
  it("another kind of undecided duplicate gets the generic guidance, not an erasure's (round 9, N-1)", () => {
    const { refusedDecisionText } = jest.requireActual(
      "@/components/admin/decision-outcome"
    );
    // The code and message as the decision route answers them (for an erasure's duplicate).
    const duplicate = routeAnswer(
      `${DECISION} an undecided erasure approved again, another open`
    )[1] as { code: string; message: string };
    const text = refusedDecisionText("update_config", duplicate, {}, LABEL);
    expect(text).toContain(
      `${LABEL}: Another hold for the same action on the same subject is open`
    );
    expect(text).not.toMatch(/erasure/);
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
              ...holds[0]!,
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
      "approved, its run's claim not given back",
      approveBtn,
      /listed as undecided within 75 minutes: verify it, then mark it executed if it took effect, or withdraw it/,
    ],
    [
      "settling",
      "a two-person approval approved, its apply settling",
      "Approve: Setting moderation.strike_ban_threshold",
      /outcome is being checked: if it did not apply, it is listed again within 75 minutes/,
    ],
    [
      "withdrawn",
      "approved, refused for good and withdrawn",
      approveBtn,
      /withdrawn; the requester must ask again/,
    ],
  ])("%s: said, and the list read again", async (_name, answer, decided, said) => {
    fetchMock
      .mockResolvedValueOnce(reply(`${DECISION} ${answer}` as RouteFixtureName))
      .mockResolvedValueOnce(
        reply(
          answer.startsWith("a two-person")
            ? "GET /api/admin/approvals — a held change, undecided"
            : "GET /api/admin/approvals — after a decision, the other held change"
        )
      );
    render(<HeldActionsPanel data={{ approvals: holds }} />);
    decideRow(decided);
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(said));
    expect(screen.getByRole("status").textContent).not.toMatch(
      /approve it again to retry/
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: decided })).toBeNull()
    );
    expect(fetchMock.mock.calls[1][0]).toBe("/api/admin/approvals");
  });

  it("an undecided config hold says a retry of one that applied is refused as stale; another does not", async () => {
    const { refusedDecisionText } = jest.requireActual(
      "@/components/admin/decision-outcome"
    );
    // The decision route's own answer for a run whose claim was not given back.
    const answer = routeAnswer(
      `${DECISION} approved, its run's claim not given back`
    )[1] as {
      code: string;
      message: string;
    };
    const { code, message } = answer;
    const claimLost = { code, message };
    const body = answer;
    expect(refusedDecisionText("update_config", claimLost, body)).toMatch(
      /refused as stale/
    );
    expect(
      refusedDecisionText("set_entitlement_group_active", claimLost, body)
    ).not.toMatch(/stale|approve it again/);
  });
});
