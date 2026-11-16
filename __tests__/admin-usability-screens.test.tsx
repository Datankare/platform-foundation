/**
 * @jest-environment jsdom
 */
/**
 * __tests__/admin-usability-screens.test.tsx — the admin console as a person uses it (TASK-202)
 *
 * Each screen answered with what its real route answers (__tests__/fixtures/route-responses,
 * produced by the handlers in route-fixtures.test.ts — never a body written here):
 *
 *   - Approvals (N-61, N-62): each hold says what it changes (key, now → after; a list's added
 *     items), who asked by address and role, when, and why; Approve and Reject ask again,
 *     repeating it; the result names the change and stays;
 *   - Erasures (S3-E19): an unverifiable identity, and — one operator — no second one, said
 *     plainly;
 *   - long cells expand (N-64); the console's sections fit a phone (a picker).
 */
import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { routeAnswer, type RouteFixtureName } from "./fixtures/route-responses";
import { renderMessage } from "@/platform/errors/messages";

const mockApiFetch = jest.fn();
jest.mock("@/platform/auth/api-fetch", () => ({
  apiFetch: (...a: unknown[]) => mockApiFetch(...a),
}));

import { HeldActionsPanel } from "@/components/admin/HeldActionsPanel";
import { ErasuresPanel } from "@/components/admin/ErasuresPanel";
import { ExpandableText } from "@/components/admin/ExpandableText";
import AdminShell from "@/components/admin/AdminShell";

/** The body of a fixture (the data a page passes a panel). */
const bodyOf = (name: RouteFixtureName) => routeAnswer(name)[1] as never;

const allow =
  (...granted: string[]) =>
  (code: string) =>
    granted.includes(code);

beforeEach(() => mockApiFetch.mockReset());

// Platform config and Trusted agents moved onto the console's shared parts (TASK-220): their
// screens' tests are __tests__/admin-governance-panels.test.tsx.

const held = (key: string, v?: Record<string, string>) =>
  renderMessage(`screens.held.${key}`, v);

describe("Approvals: the approver sees what they decide (N-61, N-62)", () => {
  const data = bodyOf(
    "GET /api/admin/approvals — held changes, to a second admin who may decide them"
  );

  it("each hold: what, before → after, who by address and role, when, why — never an id", () => {
    const { container } = render(
      <HeldActionsPanel data={data} hasPermission={() => true} />
    );
    // The two-person approval of a number: now 5, after 7 — the setting by name (TASK-220).
    expect(
      screen.getByText(held("what_config", { key: "Moderation: strike ban threshold" }))
    ).toBeTruthy();
    const diffs = container.querySelectorAll("[data-diff='true']");
    expect(diffs.length).toBe(2);
    expect(diffs[1].textContent ?? diffs[0].textContent).toBeTruthy();
    expect(container.textContent).toContain("Fewer bans for first offences");
    // The held list change: the setting it adds, by name — never its stored name (the walk).
    expect(container.textContent).toContain("+ Default language");
    expect(container.textContent).not.toContain("default_language");
    // Who asked, by address and role.
    const who = [...container.querySelectorAll("[data-requester='true']")].map(
      (n) => n.textContent
    );
    expect(who).toContain("requester@example.test (Super admin)");
    // Never the requester's id.
    for (const a of (data as { approvals: { requester: string }[] }).approvals)
      expect(container.textContent).not.toContain(a.requester);
  });

  it("Approve asks again, repeating what is decided; Go back sends nothing", () => {
    render(<HeldActionsPanel data={data} hasPermission={() => true} />);
    const what = held("what_config", { key: "Moderation: strike ban threshold" });
    fireEvent.click(
      screen.getByRole("button", { name: held("approve_label", { what }) })
    );
    const confirm = screen.getByRole("alertdialog", {
      name: held("confirm_approve_title"),
    });
    expect(within(confirm).getAllByText(what).length).toBeGreaterThan(0);
    expect(within(confirm).getByText(/requester@example\.test/)).toBeTruthy();
    fireEvent.click(
      within(confirm).getByRole("button", {
        name: renderMessage("screens.admin_console.confirm.cancel"),
      })
    );
    expect(
      screen.queryByRole("alertdialog", { name: held("confirm_approve_title") })
    ).toBeNull();
    expect(mockApiFetch).not.toHaveBeenCalled();
  });
});

const er = (key: string, v?: Record<string, string | number>) =>
  renderMessage(`screens.admin_console.erasures.${key}`, v);

describe("Erasures: open erasures and the attestation (S3-E19)", () => {
  const data = bodyOf(
    "GET /api/operator/erasures — an unverifiable identity, one operator"
  );

  it("shows the unverifiable identity, and plainly that no second operator exists", () => {
    const { container } = render(<ErasuresPanel data={data} />);
    expect(container.querySelector("[data-pool-unverified='true']")).not.toBeNull();
    expect(screen.getByText(er("no_second_operator", { operators: 1 }))).toBeTruthy();
    // No request is offered that no one could approve.
    expect(screen.queryByRole("button", { name: er("ask") })).toBeNull();
    expect(
      screen.getByText(er("requested_by", { person: "requester@example.test" }))
    ).toBeTruthy();
  });
  // Asking, approving and rejecting: admin-operator-screens.test.tsx (TASK-221).
});

describe("long cells and narrow screens (N-64)", () => {
  it("a long value is cut with a button that shows all of it, and back", () => {
    const text = "x".repeat(200);
    render(<ExpandableText text={text} column="Details" />);
    expect(screen.queryByText(text)).toBeNull();
    const more = screen.getByRole("button", {
      name: renderMessage("screens.admin_console.cell.more_label", { column: "Details" }),
    });
    fireEvent.click(more);
    expect(screen.getByText(new RegExp(`^${text}`))).toBeTruthy();
    expect(more.getAttribute("aria-expanded")).toBe("true");
  });

  it("the console's sections are a picker on a phone, the sidebar on a desktop: one list", () => {
    const changed = jest.fn();
    render(
      <AdminShell
        adminName="Admin"
        hasPermission={allow("can_access_admin", "platform_operate")}
        onSignOut={() => undefined}
        onSectionChange={changed}
      >
        {(s) => <p>{s}</p>}
      </AdminShell>
    );
    const picker = screen.getByRole("combobox", {
      name: renderMessage("screens.admin_console.nav_label"),
    });
    fireEvent.change(picker, { target: { value: "erasures" } });
    expect(changed).toHaveBeenLastCalledWith("erasures");
    expect(screen.getByText("erasures")).toBeTruthy();
  });
});
