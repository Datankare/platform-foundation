/**
 * @jest-environment jsdom
 */
/**
 * __tests__/round1-admin-screens.test.tsx — what the admin screens now say (TASK-194 round 1)
 *
 *   A1: an approver sees what a held action would do — its account, an erasure's reason, a role
 *       change's roles — from the server's summary, and nothing of the payload beyond it.
 *   A7: the Roles screen says when a role lacks a feature permission.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { HeldActionsPanel } from "@/components/admin/HeldActionsPanel";
import { RolesDataView } from "@/components/admin/AdminDataViews";
import type { PendingApproval } from "@/platform/admin/pending-approvals";
import { renderShown, shown } from "@/platform/errors/shown-text";

const base = {
  source: "runtime" as const,
  requester: "admin-1234567890",
  requiredPermission: "admin_purge_user_data",
  reason: shown("screens.held.reason_held", {
    risk: "restricted",
    effects: [],
    effected: "no",
  }),
  createdAt: "2026-01-02T00:00:00.000Z",
};

describe("the approvals list shows each held action's summary (A1)", () => {
  it("an erasure: whose account, why, and that it is not a dry run", () => {
    const holds: PendingApproval[] = [
      {
        ...base,
        id: "p1",
        label: "purge_user_data",
        summary: {
          target: { id: "u-1", email: "someone@example.test" },
          reason: "legal-order",
          dryRun: false,
        },
      },
      {
        ...base,
        id: "p2",
        label: "change_user_role",
        requiredPermission: "admin_manage_users",
        summary: { target: { id: "u-2" }, fromRole: "free", toRole: "moderator" },
      },
      {
        ...base,
        id: "p3",
        label: "block_user_feature",
        summary: { target: { notFound: true }, feature: "translate" },
      },
    ];
    render(<HeldActionsPanel data={{ approvals: holds }} />);
    const lines = Array.from(document.querySelectorAll("[data-summary]")).map(
      (n) => n.textContent
    );
    expect(lines).toEqual([
      "Reason: legal-order",
      "Role: free → moderator",
      "Feature: translate",
    ]);
    // The account is in each hold's one-line what, by address — never by its id (TASK-202,
    // N-63: "Account: u-2" named an account by id).
    expect(screen.getByText("Erase the account someone@example.test")).toBeDefined();
    expect(screen.getByText("Role of an account with no address")).toBeDefined();
    expect(
      screen.getByText("Block “translate” for an account that is no longer found")
    ).toBeDefined();
    expect(document.body.textContent).not.toContain("u-2");
  });

  it("a hold with no summary shows only its reason", () => {
    render(
      <HeldActionsPanel data={{ approvals: [{ ...base, id: "p4", label: "x" }] }} />
    );
    expect(document.querySelectorAll("[data-summary]")).toHaveLength(0);
    expect(screen.getByText(renderShown(base.reason))).toBeDefined();
  });
});

describe("the Roles screen says when a role lacks a feature permission (A7)", () => {
  const role = (name: string, codes: string[]) => ({
    id: name,
    name,
    displayName: name,
    permissionCount: codes.length,
    permissions: codes.map((code) => ({ code, displayName: code, category: "feature" })),
    createdAt: "2026-10-29T09:15:00.000Z",
    updatedAt: "2026-10-29T09:15:00.000Z",
  });

  it("names the missing ones, and says nothing of a role that has all three", () => {
    render(
      <RolesDataView
        data={{
          roles: [
            role("full", ["can_translate", "can_view_profile", "can_edit_profile"]),
            role("partial", ["can_view_profile"]),
          ],
        }}
      />
    );
    const gaps = Array.from(document.querySelectorAll("[data-feature-gap]")).map(
      (n) => n.textContent
    );
    expect(gaps).toEqual([
      "Lacks can_edit_profile, can_translate: its holders cannot use those features.",
    ]);
  });
});
