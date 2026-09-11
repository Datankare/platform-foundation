/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { HeldActionsPanel } from "@/components/admin/HeldActionsPanel";
import type { PendingApproval } from "@/platform/admin/pending-approvals";

const holds: PendingApproval[] = [
  {
    source: "runtime",
    id: "p1",
    label: "config.set moderation.strike_ban_threshold",
    configKey: "moderation.strike_ban_threshold",
    requester: "admin-1234567890",
    requiredPermission: "config_manage_safety",
    effectiveRisk: "restricted",
    effects: ["restricted"],
    reason: 'Held at effectiveRisk "restricted" — needs an independent approver.',
    createdAt: "2026-01-02T00:00:00.000Z",
  },
  {
    source: "config-approval",
    id: "a1",
    label: "moderation.blocklist_only_surfaces",
    configKey: "moderation.blocklist_only_surfaces",
    requester: "admin-2",
    requiredPermission: "config_manage_standard",
    reason: "raises the blocklist scope",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
];

describe("HeldActionsPanel — ADR-040 040a", () => {
  it("renders a row per hold with what / why / who / source", () => {
    render(<HeldActionsPanel data={{ approvals: holds }} />);
    expect(screen.getByText(/strike_ban_threshold/)).toBeDefined();
    expect(screen.getByText(/blocklist_only_surfaces/)).toBeDefined();
    expect(screen.getByText(/needs an independent approver/)).toBeDefined();
    expect(screen.getByText("Safety approver or super admin")).toBeDefined();
    expect(screen.getByText("Admin or super admin")).toBeDefined();
    expect(screen.getByText("Runtime hold")).toBeDefined();
    expect(screen.getByText("Config approval")).toBeDefined();
  });

  it("shows an empty-state direction when there are no holds", () => {
    render(<HeldActionsPanel data={{ approvals: [] }} />);
    expect(screen.getByText(/No pending approvals/)).toBeDefined();
  });

  it("tolerates missing data (loading) without throwing", () => {
    render(<HeldActionsPanel />);
    expect(screen.getByText(/No pending approvals/)).toBeDefined();
  });

  it("exposes an accessible caption and column headers", () => {
    render(<HeldActionsPanel data={{ approvals: holds }} />);
    expect(screen.getByText(/awaiting an independent reviewer/i)).toBeDefined();
    expect(screen.getByRole("columnheader", { name: "What" })).toBeDefined();
    expect(screen.getByRole("columnheader", { name: "Who can approve" })).toBeDefined();
    expect(screen.getAllByRole("columnheader")).toHaveLength(5);
  });
});
