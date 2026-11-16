/**
 * @jest-environment jsdom
 */

import React from "react";
import { act, render, screen, fireEvent, within } from "@testing-library/react";
import AdminShell, { SectionHeading } from "@/components/admin/AdminShell";
import { SECTIONS } from "@/components/admin/ui/sections";
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

  it("names who is signed in, then their role (TASK-216, SF-admin-005)", () => {
    render(
      <AdminShell {...mockProps} adminName="ann@example.test" adminRole="Super admin" />
    );
    expect(screen.getByText("ann@example.test")).toBeDefined();
    expect(screen.getByText("Super admin")).toBeDefined();
  });

  it("the sections are in named groups, in the sidebar and in the picker (SF-admin-008)", () => {
    render(<AdminShell {...mockProps} />);
    const nav = within(screen.getByRole("navigation"));
    const groups = ["People", "Access", "Safety", "Settings", "Operations"];
    for (const group of groups) {
      const list = nav.getByRole("list", { name: group });
      expect(within(list).getAllByRole("listitem").length).toBeGreaterThan(0);
    }
    expect(
      within(nav.getByRole("list", { name: "Safety" })).getByText("Approvals")
    ).toBeDefined();
    expect(
      [...screen.getByRole("combobox").querySelectorAll("optgroup")].map((g) => g.label)
    ).toEqual(groups);
    // Each section has an icon of its own (two shared the padlock).
    const icons = SECTIONS.map((s) => s.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it("the open section is in the address: chosen, reloaded, Back (SF-admin-006)", () => {
    const onSectionChange = jest.fn();
    const { unmount } = render(
      <AdminShell {...mockProps} onSectionChange={onSectionChange} />
    );
    fireEvent.click(within(screen.getByRole("navigation")).getByText("Roles"));
    expect(window.location.search).toBe("?section=roles");
    fireEvent.click(within(screen.getByRole("navigation")).getByText("Audit log"));
    expect(window.location.search).toBe("?section=audit");
    // A reload opens the section the address names.
    unmount();
    render(<AdminShell {...mockProps} onSectionChange={onSectionChange} />);
    expect(screen.getByTestId("content").textContent).toBe("audit");
    // Back: the address is the section before, and the shell follows it.
    act(() => {
      window.history.replaceState(null, "", "/admin?section=roles");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.getByTestId("content").textContent).toBe("roles");
    expect(onSectionChange).toHaveBeenLastCalledWith("roles");
  });

  it("[hostile] an address naming no section, or one the admin may not open, opens the first permitted", () => {
    window.history.replaceState(null, "", "/admin?section=nope");
    const { unmount } = render(<AdminShell {...mockProps} />);
    expect(screen.getByTestId("content").textContent).toBe("users");
    unmount();
    window.history.replaceState(null, "", "/admin?section=users");
    render(
      <AdminShell
        {...mockProps}
        hasPermission={(code) => code === "admin_manage_roles"}
      />
    );
    expect(screen.getByTestId("content").textContent).toBe("roles");
  });

  it("a section change moves focus to the new heading; opening the console moves none (SF-admin-007)", () => {
    render(
      <AdminShell {...mockProps}>
        {(section: AdminSection) => <SectionHeading section={section} />}
      </AdminShell>
    );
    expect(document.activeElement).toBe(document.body);
    fireEvent.click(within(screen.getByRole("navigation")).getByText("Roles"));
    const heading = screen.getByRole("heading", { level: 2, name: "Roles" });
    expect(document.activeElement).toBe(heading);
  });
});
