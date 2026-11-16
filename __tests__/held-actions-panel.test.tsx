/**
 * @jest-environment jsdom
 */
import React from "react";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  HeldActionsPanel,
  decisionGate,
  describeWhat,
  summaryLines,
} from "@/components/admin/HeldActionsPanel";
import { permissionLabel } from "@/components/admin/ui/labels";
import { renderMessage } from "@/platform/errors/messages";
import type { PendingApproval } from "@/platform/admin/pending-approvals";
import { routeAnswer, type RouteFixtureName } from "@/__tests__/fixtures/route-responses";
import { changeValueText, itemText } from "@/components/admin/config-value";

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

// A setting by its name, never its key (TASK-220, SF-admin-031).
const LABEL = "Setting Config: dual control keys";
const approveBtn = `Approve: ${LABEL}`;

/** An administrator who may decide every hold (the console passes the viewer's permissions). */
const may = () => true;
let reload: jest.Mock;
beforeEach(() => {
  reload = jest.fn();
});

/** The panel as the console mounts it: the viewer's permissions, and a way to read again. */
function panel(approvals: PendingApproval[], more: Record<string, unknown> = {}) {
  return (
    <HeldActionsPanel
      data={{ approvals }}
      hasPermission={may}
      onReload={reload}
      {...more}
    />
  );
}

/** Decide a row: its button, then the confirm step's (TASK-202, N-61; TASK-220, SF-admin-030). */
function decideRow(name: string, confirm = "Approve and apply") {
  fireEvent.click(screen.getByRole("button", { name }));
  fireEvent.click(screen.getByRole("button", { name: confirm }));
}

/** The console's outcome list (one live region: SF-admin-033). */
const outcomes = () => screen.getByRole("status");

describe("HeldActionsPanel — ADR-040 040a/040c", () => {
  it("a request with no person's comment shows the platform's note, worded (TASK-209)", () => {
    const noted = holds.map((h) =>
      h.source === "config-approval"
        ? {
            ...h,
            comment: undefined,
            commentShown: { key: "screens.records.changed_on_page" },
          }
        : h
    ) as PendingApproval[];
    render(panel(noted));
    expect(screen.getAllByText("Changed on the config page").length).toBe(1);
  });

  it("renders a card per hold, each setting by its name, with approve/reject controls", () => {
    render(panel(holds));
    expect(
      screen.getAllByText(/Moderation: strike ban threshold/).length
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/strike_ban_threshold/)).toBeNull();
    // Why it waits, in words (TASK-202, N-61): no state → a dual-controlled change.
    expect(screen.getAllByText(/Under dual control/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: approveBtn })).toBeDefined();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    // Who can approve, by the permission's name (SF-admin-031): never its code.
    expect(document.body.textContent).not.toMatch(/config_manage_safety/);
  });

  it("approves a hold through the decision route, removes the row and reads the list again", async () => {
    resolveFetch(`${DECISION} approved, it took effect`);
    render(panel(holds));
    decideRow(approveBtn);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/admin/approvals/${holds[0]!.id}`,
      expect.objectContaining({ method: "POST" })
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: approveBtn })).toBeNull()
    );
    expect(reload).toHaveBeenCalled();
  });

  it("an approval says it took effect, announced, then shows the empty list (TASK-186)", async () => {
    resolveFetch(`${DECISION} approved, it took effect`);
    render(panel([holds[0]!]));
    decideRow(approveBtn);
    const status = outcomes();
    await waitFor(() =>
      expect(status.textContent).toContain(
        `Approved: ${LABEL}. Applied: the setting is now Signups enabled, Config: dual control keys, Default language.`
      )
    );
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(screen.getByText(/No pending approvals/)).toBeDefined();
    // Dismissed at once on request.
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(outcomes().textContent).toBe("");
  });

  it("the result stays until dismissed (TASK-202, N-62: it went by itself after seconds)", async () => {
    jest.useFakeTimers();
    try {
      resolveFetch(`${DECISION} rejected`);
      render(panel([holds[0]!]));
      decideRow(`Reject: ${LABEL}`, "Reject it");
      await waitFor(() =>
        expect(outcomes().textContent).toContain(
          `Rejected: ${LABEL}. Nothing was changed.`
        )
      );
      act(() => {
        jest.advanceTimersByTime(10 * 60_000);
      });
      expect(outcomes().textContent).toContain(`Rejected: ${LABEL}`);
    } finally {
      jest.useRealTimers();
    }
  });

  it("a held change now waiting for a second approval says so, not 'took effect'", async () => {
    resolveFetch(`${DECISION} approved, now waiting for a second approval`);
    render(panel(holds));
    decideRow(approveBtn);
    await waitFor(() =>
      expect(outcomes().textContent).toMatch(/waits for a second approval/)
    );
  });

  it("approved but the run failed: the reason, said once in the outcome list; the row stays (SF-admin-033)", async () => {
    resolveFetch(`${DECISION} approved, the run failed`);
    render(panel(holds));
    decideRow(approveBtn);
    const reason = renderMessage("errors.approvals.run_failed");
    await waitFor(() => expect(outcomes().textContent).toContain(`${LABEL}: ${reason}`));
    // Not repeated under the card (it was said twice): one place, the outcome list.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.body.textContent!.split(reason).length - 1).toBe(1);
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
      render(panel(holds));
      decideRow(approveBtn);
      await waitFor(() => expect(outcomes().textContent).toMatch(next));
      expect(outcomes().textContent).toContain(messageOf(name));
      if (status < 500)
        expect(outcomes().textContent).not.toMatch(/approve it again to retry/);
      expect(screen.getByRole("button", { name: approveBtn })).toBeDefined();
    }
  );

  it("surfaces the server error when approval is refused (self-approval 409), once", async () => {
    const refused = `${DECISION} refused (its own requester)` as RouteFixtureName;
    resolveFetch(refused);
    render(panel(holds));
    decideRow(approveBtn);
    await waitFor(() => expect(outcomes().textContent).toContain(messageOf(refused)));
    expect(screen.queryByRole("alert")).toBeNull();
    // The row stays.
    expect(screen.getByRole("button", { name: approveBtn })).toBeDefined();
  });

  it("no answer at all: said as not done, and the buttons come back", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    render(panel(holds));
    decideRow(approveBtn);
    await waitFor(() =>
      expect(outcomes().textContent).toContain(renderMessage("screens.refusal.network"))
    );
    expect(
      (screen.getByRole("button", { name: approveBtn }) as HTMLButtonElement).disabled
    ).toBe(false);
  });

  it("replaces its rows when the page passes fresh data (no stale first render)", () => {
    const { rerender } = render(panel(holds));
    expect(screen.getByRole("button", { name: approveBtn })).toBeTruthy();
    rerender(panel([holds[1]!]));
    expect(screen.queryByRole("button", { name: approveBtn })).toBeNull();
    expect(
      screen.getAllByText(/Moderation: strike ban threshold/).length
    ).toBeGreaterThan(0);
  });

  it("an undecided run verified not applied is withdrawn, never run — after its confirm step (round 5, item 2; SF-admin-030)", async () => {
    resolveFetch(`${DECISION} an undecided run withdrawn`);
    const [undecided] = list("GET /api/admin/approvals — a held change, undecided");
    render(panel([undecided!]));
    fireEvent.click(
      screen.getByRole("button", {
        name: `Withdraw: ${LABEL} — verified that it did not take effect; it will not run`,
      })
    );
    // One click no longer acts: the confirm step says it cannot be undone.
    expect(fetchMock).not.toHaveBeenCalled();
    const step = screen.getByRole("alertdialog");
    expect(step.getAttribute("data-risk")).toBe("irreversible");
    expect(step.textContent).toContain(
      renderMessage("screens.admin_console.confirm.irreversible")
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Reason (optional)" }), {
      target: { value: "Checked: the list did not change." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Withdraw it" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      decision: "withdraw",
      source: "runtime",
      note: "Checked: the list did not change.",
    });
    await waitFor(() =>
      expect(outcomes().textContent).toContain(`Withdrawn: ${LABEL}. It will not run.`)
    );
  });

  it.each([
    ["Mark executed", "Mark it as taken effect", "mark_executed", "consequential"],
    ["Approve again", "Approve it again", "reapprove", "consequential"],
  ])(
    "%s on an undecided run asks first, then sends its decision (SF-admin-030)",
    async (button, confirm, decision, risk) => {
      resolveFetch(`${DECISION} an undecided run withdrawn`);
      const [undecided] = list("GET /api/admin/approvals — a held change, undecided");
      render(panel([undecided!]));
      fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${button}: `) }));
      expect(fetchMock).not.toHaveBeenCalled();
      expect(screen.getByRole("alertdialog").getAttribute("data-risk")).toBe(risk);
      fireEvent.click(screen.getByRole("button", { name: confirm }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(String(init.body))).toEqual({ decision, source: "runtime" });
    }
  );

  it("approving an erasure again is confirmed as the erasure it lets through: irreversible", () => {
    const [erasure] = list(
      "GET /api/admin/approvals — an undecided erasure, another open"
    );
    render(panel([erasure!]));
    fireEvent.click(screen.getByRole("button", { name: /^Approve again: / }));
    expect(screen.getByRole("alertdialog").getAttribute("data-risk")).toBe(
      "irreversible"
    );
  });

  it("the confirm step takes focus, and Cancel gives it back to the decision's button (SF-admin-034)", async () => {
    render(panel(holds));
    const approve = screen.getByRole("button", { name: approveBtn });
    approve.focus();
    fireEvent.click(approve);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("alertdialog"))
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: approveBtn })
      )
    );
  });

  it("an undecided duplicate refused approval again points at withdraw (round 6, I-2; round 8, item 1)", async () => {
    resolveFetch(`${DECISION} an undecided erasure approved again, another open`);
    const erasures = list(
      "GET /api/admin/approvals — an undecided erasure, another open"
    );
    render(panel(erasures));
    const erase = "Erase the account ann@example.com";
    decideRow(
      `Approve again: ${erase} — verified that it did not take effect`,
      "Approve it again"
    );
    await waitFor(() =>
      expect(outcomes().textContent).toContain(
        `${erase}: another erasure of this account is open, so this one is not approved again. Mark it executed if it took effect; if it did not, withdraw it.`
      )
    );
    // The row stays, with its Withdraw control.
    expect(
      screen.getByRole("button", {
        name: `Withdraw: ${erase} — verified that it did not take effect; it will not run`,
      })
    ).toBeDefined();
  });

  it("an undecided run no one in the tenant may decide says a platform operator decides it — the permission by name (round 7, I-3)", () => {
    const [stuck] = list(
      "GET /api/admin/approvals — an undecided erasure, no one here may decide it"
    );
    expect(stuck!.noEligibleDecider).toBe(true);
    render(panel([stuck!]));
    expect(
      screen.getByText(
        /^No one here may approve this again or mark it executed: its requester and the account it acts on cannot decide it, and no one else in good standing who holds Purge user data with access to administration meets the change's own rules .* A platform operator decides it — Operator → Tenants → this tenant → Settings → Held changes\.$/
      )
    ).toBeDefined();
  });

  // Only an erasure's authority finds duplicates (HoldAuthority.duplicateOf, TASK-199), so the
  // decision route answers no other hold with this code; the words for one are the generic ones.
  it("another kind of undecided duplicate gets the generic guidance, not an erasure's (round 9, N-1)", () => {
    const { refusedDecisionText } = jest.requireActual(
      "@/components/admin/decision-outcome"
    );
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
    expect(renderMessage("errors.admin.erasure_pending")).toBe(
      "This account's erasure is already waiting for approval."
    );
    expect(
      renderMessage("screens.held.result_duplicate_undecided", { label: "x" })
    ).toMatch(/withdraw it/);
    expect(renderMessage("errors.approvals.duplicate_undecided")).toMatch(
      /Mark it executed.*withdraw it/
    );
  });

  it("shows the empty state when there are no holds", () => {
    render(panel([]));
    expect(screen.getByText(/No pending approvals/)).toBeDefined();
  });
});

describe("a queue not wholly read is said, never taken for all that waits (SF-admin-004)", () => {
  it("one source unreadable: what was read, and which could not be", () => {
    const answer = routeAnswer(
      "GET /api/admin/approvals — the two-person approvals unreadable"
    )[1] as { approvals: PendingApproval[]; unreadable: string[] };
    render(<HeldActionsPanel data={answer} hasPermission={may} onReload={reload} />);
    expect(screen.getByRole("alert").textContent).toContain(
      renderMessage("screens.held.unreadable_config_approval")
    );
    expect(screen.getByRole("button", { name: approveBtn })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /^Try reading .* again$/ }));
    expect(reload).toHaveBeenCalled();
  });

  it("nothing listed and a source unreadable: never 'No pending approvals'", () => {
    render(
      <HeldActionsPanel
        data={{ approvals: [], unreadable: ["runtime"] }}
        hasPermission={may}
      />
    );
    expect(screen.queryByText(/No pending approvals/)).toBeNull();
    expect(screen.getByRole("alert")).toBeDefined();
  });
});

describe("Approve and Reject only where the decision route would take them (E-56, SF-admin-032)", () => {
  const requester = holds[0]!.requester;

  it("without the hold's permission: every decision disabled, saying which permission by name", () => {
    render(
      panel(holds, { hasPermission: (code: string) => code !== "config_manage_safety" })
    );
    const approve = screen.getByRole("button", { name: approveBtn }) as HTMLButtonElement;
    const reject = screen.getByRole("button", {
      name: `Reject: ${LABEL}`,
    }) as HTMLButtonElement;
    expect([approve.disabled, reject.disabled]).toEqual([true, true]);
    expect(approve.getAttribute("aria-describedby")).toBeTruthy();
    expect(
      document.getElementById(approve.getAttribute("aria-describedby")!)!.textContent
    ).toBe("Needs the permission “Manage safety config”.");
    fireEvent.click(approve);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("one's own request: Approve disabled with why; Reject stays (the requester may withdraw it)", () => {
    render(panel([holds[0]!], { viewerId: requester.toUpperCase() }));
    const approve = screen.getByRole("button", { name: approveBtn }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(document.body.textContent).toContain(
      renderMessage("screens.held.gate_own_request")
    );
    expect(
      (screen.getByRole("button", { name: `Reject: ${LABEL}` }) as HTMLButtonElement)
        .disabled
    ).toBe(false);
  });

  it("one's own request, undecided: none of its decisions is offered", () => {
    const [undecided] = list("GET /api/admin/approvals — a held change, undecided");
    render(panel([undecided!], { viewerId: requester }));
    for (const b of screen
      .getAllByRole("button")
      .filter((x) => x.hasAttribute("data-decision")))
      expect((b as HTMLButtonElement).disabled).toBe(true);
  });

  it("a hold that acts on one's own account: no decision at all", () => {
    const [erasure] = list(
      "GET /api/admin/approvals — an undecided erasure, another open"
    ).slice(1);
    render(panel([erasure!], { viewerId: erasure!.summary!.target!.id }));
    for (const b of screen
      .getAllByRole("button")
      .filter((x) => x.hasAttribute("data-decision")))
      expect((b as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).toContain(
      renderMessage("screens.held.gate_own_account")
    );
  });

  it("a role change whose account's role changed since: Approve disabled, Reject offered (SF-admin-032)", () => {
    const stale: PendingApproval = {
      ...holds[0]!,
      id: "p-role",
      label: "change_user_role",
      change: undefined,
      configKey: undefined,
      summary: {
        target: { id: "00000000-0000-4000-8000-00000000a111", email: "ann@example.com" },
        fromRole: "player",
        toRole: "moderator",
        roleChangedSince: { now: "admin" },
      },
    };
    render(panel([stale]));
    const approve = screen.getByRole("button", {
      name: /^Approve: Role of ann@example.com/,
    });
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).toContain(
      renderMessage("screens.held.gate_role_changed")
    );
    expect(
      (
        screen.getByRole("button", {
          name: /^Reject: Role of ann@example.com/,
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false);
  });

  it("[decisionGate] the rules, alone", () => {
    const a = holds[0]!;
    expect(decisionGate(a, undefined, () => true)).toEqual({
      approve: null,
      reject: null,
      undecided: null,
    });
    expect(decisionGate(a, a.requester, () => true).approve).toBe(
      renderMessage("screens.held.gate_own_request")
    );
    expect(decisionGate(a, a.requester, () => true).reject).toBeNull();
    expect(decisionGate(a, "someone-else", () => false).reject).toMatch(
      /Needs the permission/
    );
  });
});

describe("codes are names on a held change's card (SF-admin-031, 036)", () => {
  it("a role change: roles by name, what it grants and takes away by permission name, the feature by name", () => {
    const lines = summaryLines({
      fromRole: "player",
      toRole: "super_admin",
      permissionsGranted: ["admin_manage_users"],
      permissionsRemoved: ["can_translate"],
      feature: "translate",
    });
    const text = lines.join("\n");
    expect(text).toContain("Role: Player → Super admin");
    expect(text).not.toMatch(/admin_manage_users|can_translate|super_admin/);
    expect(text).toContain(`Grants: ${permissionLabel("admin_manage_users")}`);
  });

  it("an erasure's kind of reason is its requester's reason, by its label — never a code, never 'no reason' (SF-admin-036)", () => {
    const [erasure] = list(
      "GET /api/admin/approvals — an erasure held, the person asked for it"
    );
    render(panel([erasure!]));
    const label = renderMessage("screens.admin_console.users.erase_reason_user_request");
    const reasonRow = screen.getByText(
      renderMessage("screens.held.comment")
    ).nextElementSibling!;
    expect(reasonRow.textContent).toBe(label);
    expect(document.body.textContent).not.toContain("user-request");
    expect(document.body.textContent).not.toContain(
      renderMessage("screens.held.no_comment")
    );
    // Said once: not again as a summary line.
    expect(document.body.textContent!.split(label).length - 1).toBe(1);
  });
});

describe("two holds with the same id from two sources are two cards (SF-admin-037)", () => {
  it("deciding one leaves the other's buttons as they are", async () => {
    let answer: (r: Response) => void = () => undefined;
    fetchMock.mockReturnValue(new Promise<Response>((r) => (answer = r)));
    const twin: PendingApproval = { ...holds[1]!, id: holds[0]!.id };
    render(panel([holds[0]!, twin]));
    decideRow(approveBtn);
    // The first card is busy; its twin (same id, other source) is not.
    const twinApprove = screen.getByRole("button", {
      name: "Approve: Setting Moderation: strike ban threshold",
    }) as HTMLButtonElement;
    expect(twinApprove.disabled).toBe(false);
    answer(reply(`${DECISION} approved, it took effect`));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: approveBtn })).toBeNull()
    );
    expect(
      screen.getByRole("button", {
        name: "Approve: Setting Moderation: strike ban threshold",
      })
    ).toBeDefined();
  });
});

describe("a held approval-policy change (round 12, I-2)", () => {
  it("shows each rule it would store and its default approver", () => {
    render(
      panel([
        {
          ...holds[0]!,
          id: "p-policy",
          label: "set_approval_policy",
          change: undefined,
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
      ])
    );
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
  // again through the console (the decided row is no longer listed as it was).
  it.each([
    [
      "undecided",
      "approved, its run's claim not given back",
      approveBtn,
      /listed as undecided within 75 minutes: check it, then mark it as having taken effect, or withdraw it/,
    ],
    [
      "settling",
      "a two-person approval approved, its apply settling",
      "Approve: Setting Moderation: strike ban threshold",
      /outcome is being checked: if it did not apply, it is listed again within 75 minutes/,
    ],
    [
      "withdrawn",
      "approved, refused for good and withdrawn",
      approveBtn,
      /withdrawn; the requester must ask again/,
    ],
  ])("%s: said, and the list read again", async (_name, answer, decided, said) => {
    fetchMock.mockResolvedValueOnce(reply(`${DECISION} ${answer}` as RouteFixtureName));
    render(panel(holds));
    decideRow(decided);
    await waitFor(() => expect(outcomes().textContent).toMatch(said));
    expect(outcomes().textContent).not.toMatch(/approve it again to retry/);
    expect(reload).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an undecided config hold says a retry of one that applied is refused; another does not", async () => {
    const { refusedDecisionText } = jest.requireActual(
      "@/components/admin/decision-outcome"
    );
    const answer = routeAnswer(
      `${DECISION} approved, its run's claim not given back`
    )[1] as {
      code: string;
      message: string;
    };
    const { code, message } = answer;
    const claimLost = { code, message };
    expect(refusedDecisionText("update_config", claimLost, answer)).toMatch(
      /the second try is refused/
    );
    expect(
      refusedDecisionText("set_entitlement_group_active", claimLost, answer)
    ).not.toMatch(/second try|approve it again/);
  });
});

describe("a held change's one line reads right whatever the account (TASK-208, N-111)", () => {
  // Every account-naming label, with each account a hold can name: an address, one with none,
  // one no longer found. A template given a phrase where it expects an address read "Erase the
  // account an account that is no longer found".
  const LABELS = [
    "change_user_role",
    "purge_user_data",
    "block_user_feature",
    "unblock_user_feature",
  ];
  const TARGETS: Record<string, NonNullable<PendingApproval["summary"]>["target"]> = {
    address: { id: "u1", email: "ann@example.com" },
    "no address": { id: "u1" },
    "not found": { notFound: true },
  };
  /** A noun phrase said twice in a row ("the account an account"), or a capital mid-line. */
  const misComposed = (text: string) =>
    /\b(\w+) (?:a|an|the) \1\b/i.test(text) ||
    /\b(?:the|a|an) \w+ (?:a|an|the) \w+/i.test(text.replace(/“[^”]*”/g, "")) ||
    /[a-z,] (?:An?|The) [a-z]/.test(text);

  it.each(LABELS.flatMap((label) => Object.keys(TARGETS).map((t) => [label, t])))(
    "%s, its account %s",
    (label, target) => {
      const text = describeWhat({
        label,
        summary: { target: TARGETS[target], feature: "translate" },
      });
      expect([text, misComposed(text)]).toEqual([text, false]);
    }
  );

  it("an erasure names the account by address, or says it is no longer found", () => {
    const erase = (t: string) =>
      describeWhat({ label: "purge_user_data", summary: { target: TARGETS[t] } });
    expect(erase("address")).toBe("Erase the account ann@example.com");
    expect(erase("not found")).toBe("Erase an account that is no longer found");
    expect(erase("no address")).toBe("Erase an account with no address");
  });

  it("[self-test] the check finds the doubled phrase this read before", () => {
    expect(misComposed("Erase the account an account that is no longer found")).toBe(
      true
    );
    expect(misComposed("Give An account not found in this tenant the role “x”")).toBe(
      true
    );
    expect(misComposed("Erase an account that is no longer found")).toBe(false);
    expect(misComposed("Block “translate” for an account that is no longer found")).toBe(
      false
    );
  });
});

describe("a held list change in words (the walk: a stored name, an agent as JSON)", () => {
  it("a setting by its name; an agent by what it may do; a capability by the features it needs", () => {
    expect(itemText("config.dual_control_keys", "default_language")).toBe(
      "Default language"
    );
    const agent = itemText("agent.trusted_agents", [
      "agent:helper",
      { owner: "first-party", scopes: ["translate"], status: "active", maxTokenTtl: 120 },
    ]);
    expect(agent).toBe(
      "agent:helper: answers to this organisation; may use Translate; Active; longest token 120 seconds"
    );
    expect(agent).not.toMatch(/[{}[\]"]/);
    expect(itemText("agent.trusted_agents", ["agent:bare", { status: "odd" }])).toMatch(
      /may use no capability; .+; longest token the platform's default$/
    );
    expect(
      itemText("agent.capability_features", ["translate", ["translate", "tts"]])
    ).toBe("Translate needs Translate and Text to speech".replace(" and ", ", "));
    // Any other list keeps its items as written.
    expect(itemText("some.list", "a_b")).toBe("a_b");
    expect(itemText(undefined, { a: 1 })).toBe('{"a":1}');
  });

  it("before → after: an allowed value by name where the catalogue has one; free text as written", () => {
    expect(changeValueText("default_language", "en")).toBe(
      renderMessage("screens.admin_console.labels.setting_values.default_language.en")
    );
    expect(changeValueText("some.text", "kept_as_written")).toBe("kept_as_written");
    expect(
      changeValueText("config.dual_control_keys", ["signups_enabled", "default_language"])
    ).toBe("Signups enabled, Default language");
    expect(changeValueText("x", [])).toBe("None");
  });
});
