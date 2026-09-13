/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { HeldActionsPanel } from "@/components/admin/HeldActionsPanel";
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
    await waitFor(() => expect(screen.queryByText(/strike_ban_threshold/)).toBeNull());
  });

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

  it("shows the empty state when there are no holds", () => {
    render(<HeldActionsPanel data={{ approvals: [] }} />);
    expect(screen.getByText(/No pending approvals/)).toBeDefined();
  });
});
