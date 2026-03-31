/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
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
    expect(screen.getByText("Admin Panel")).toBeDefined();
  });

  it("renders all nav items when all permissions granted", () => {
    render(<AdminShell {...mockProps} />);
    expect(screen.getByText("Players")).toBeDefined();
    expect(screen.getByText("Roles")).toBeDefined();
    expect(screen.getByText("Entitlements")).toBeDefined();
    expect(screen.getByText("Audit Log")).toBeDefined();
    expect(screen.getByText("Guest Config")).toBeDefined();
    expect(screen.getByText("Password Policy")).toBeDefined();
  });

  it("hides nav items when permission denied", () => {
    render(
      <AdminShell {...mockProps} hasPermission={() => false}>
        {(section: AdminSection) => <div>{section}</div>}
      </AdminShell>
    );
    expect(screen.queryByText("Players")).toBeNull();
    expect(screen.queryByText("Roles")).toBeNull();
  });

  it("switches section on nav click", () => {
    render(<AdminShell {...mockProps} />);
    fireEvent.click(screen.getByText("Roles"));
    expect(screen.getByTestId("content").textContent).toBe("roles");
  });

  it("calls onSignOut", () => {
    render(<AdminShell {...mockProps} />);
    fireEvent.click(screen.getByText("Sign Out"));
    expect(mockProps.onSignOut).toHaveBeenCalled();
  });

  it("defaults to first visible section", () => {
    render(<AdminShell {...mockProps} />);
    expect(screen.getByTestId("content").textContent).toBe("players");
  });
});
