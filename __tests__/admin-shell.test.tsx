/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import AdminShell from "@/components/admin/AdminShell";
import type { AdminSection } from "@/components/admin/AdminShell";

const mockProps = {
  adminName: "Admin User",
  hasPermission: () => true,
  onSignOut: jest.fn(),
  children: (section: AdminSection) => <div data-testid="content">{section}</div>,
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("AdminShell", () => {
  it("renders admin name", () => {
    render(<AdminShell {...mockProps} />);
    expect(screen.getByText("Admin User")).toBeDefined();
  });

  it("renders Admin Panel title", () => {
    render(<AdminShell {...mockProps} />);
    expect(screen.getByRole("heading", { name: "Admin panel" })).toBeDefined();
  });

  it("renders all nav items when all permissions granted", () => {
    render(<AdminShell {...mockProps} />);
    // The sidebar (desktop) and the picker (phone) list the same sections (TASK-202, N-64).
    const nav = within(screen.getByRole("navigation"));
    const picker = within(screen.getByRole("combobox"));
    for (const name of [
      "Users",
      "Roles",
      "Entitlements",
      "Audit log",
      "Password policy",
      "Erasures",
    ]) {
      expect(nav.getByText(name)).toBeDefined();
      expect(picker.getByRole("option", { name })).toBeDefined();
    }
  });

  it("hides nav items when permission denied", () => {
    render(
      <AdminShell {...mockProps} hasPermission={() => false}>
        {(section: AdminSection) => <div>{section}</div>}
      </AdminShell>
    );
    expect(screen.queryByText("Users")).toBeNull();
    expect(screen.queryByText("Roles")).toBeNull();
  });

  it("switches section on nav click", () => {
    render(<AdminShell {...mockProps} />);
    fireEvent.click(within(screen.getByRole("navigation")).getByText("Roles"));
    expect(screen.getByTestId("content").textContent).toBe("roles");
  });

  it("calls onSignOut", () => {
    render(<AdminShell {...mockProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(mockProps.onSignOut).toHaveBeenCalled();
  });

  it("on a phone, the picker switches section (TASK-202, N-64)", () => {
    render(<AdminShell {...mockProps} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Admin sections" }), {
      target: { value: "audit" },
    });
    expect(screen.getByTestId("content").textContent).toBe("audit");
    expect(
      within(screen.getByRole("navigation"))
        .getByText("Audit log")
        .closest("button")
        ?.getAttribute("aria-current")
    ).toBe("page");
  });

  it("defaults to first visible section", () => {
    render(<AdminShell {...mockProps} />);
    expect(screen.getByTestId("content").textContent).toBe("users");
  });
});
