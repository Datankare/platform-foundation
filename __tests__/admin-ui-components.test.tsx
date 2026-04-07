/**
 * @jest-environment jsdom
 */

/**
 * Sprint 7a.5 — Admin UI component tests
 *
 * Tests admin components with mocked props and user interactions.
 */

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";

// ── ActionConfirmPanel ──────────────────────────────────────────────────

import ActionConfirmPanel from "@/components/admin/ActionConfirmPanel";

describe("ActionConfirmPanel", () => {
  const basePlan = {
    message: "I'll create a moderator role.",
    actions: [
      {
        tool: "create_role",
        input: {
          name: "moderator",
          display_name: "Moderator",
          permissions: ["can_play"],
        },
      },
    ],
  };

  it("renders AI message", () => {
    render(
      <ActionConfirmPanel
        plan={basePlan}
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
        isExecuting={false}
      />
    );
    expect(screen.getByText("I'll create a moderator role.")).toBeDefined();
  });

  it("renders human-readable action description", () => {
    render(
      <ActionConfirmPanel
        plan={basePlan}
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
        isExecuting={false}
      />
    );
    expect(screen.getByText(/Create role "Moderator" with permissions/)).toBeDefined();
  });

  it("renders confirm button with action count", () => {
    render(
      <ActionConfirmPanel
        plan={basePlan}
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
        isExecuting={false}
      />
    );
    expect(screen.getByText("Confirm 1 action")).toBeDefined();
  });

  it("calls onConfirm with selected actions", () => {
    const onConfirm = jest.fn();
    render(
      <ActionConfirmPanel
        plan={basePlan}
        onConfirm={onConfirm}
        onCancel={jest.fn()}
        isExecuting={false}
      />
    );
    fireEvent.click(screen.getByText("Confirm 1 action"));
    expect(onConfirm).toHaveBeenCalledWith(basePlan.actions);
  });

  it("calls onCancel", () => {
    const onCancel = jest.fn();
    render(
      <ActionConfirmPanel
        plan={basePlan}
        onConfirm={jest.fn()}
        onCancel={onCancel}
        isExecuting={false}
      />
    );
    fireEvent.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalled();
  });

  it("shows destructive warning for delete actions", () => {
    const deletePlan = {
      message: "I'll delete the role.",
      actions: [{ tool: "delete_role", input: { role_name: "test" } }],
    };
    render(
      <ActionConfirmPanel
        plan={deletePlan}
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
        isExecuting={false}
      />
    );
    expect(screen.getByText("⚠ Destructive")).toBeDefined();
  });

  it("shows Executing... when isExecuting", () => {
    render(
      <ActionConfirmPanel
        plan={basePlan}
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
        isExecuting={true}
      />
    );
    expect(screen.getByText("Executing...")).toBeDefined();
  });

  it("shows Dismiss for plans with no actions", () => {
    render(
      <ActionConfirmPanel
        plan={{ message: "No actions needed.", actions: [] }}
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
        isExecuting={false}
      />
    );
    expect(screen.getByText("Dismiss")).toBeDefined();
  });
});

// ── ExecutionResultsPanel ───────────────────────────────────────────────

import ExecutionResultsPanel from "@/components/admin/ExecutionResultsPanel";

describe("ExecutionResultsPanel", () => {
  it("renders success results", () => {
    render(
      <ExecutionResultsPanel
        results={[
          {
            tool: "create_role",
            success: true,
            result: 'Role "Moderator" created with 2 permissions',
          },
        ]}
        onDismiss={jest.fn()}
      />
    );
    expect(screen.getByText('Role "Moderator" created with 2 permissions')).toBeDefined();
  });

  it("renders error results", () => {
    render(
      <ExecutionResultsPanel
        results={[
          {
            tool: "delete_role",
            success: false,
            error: "Cannot delete — 5 users assigned",
          },
        ]}
        onDismiss={jest.fn()}
      />
    );
    expect(screen.getByText("Cannot delete — 5 users assigned")).toBeDefined();
  });

  it("calls onDismiss", () => {
    const onDismiss = jest.fn();
    render(
      <ExecutionResultsPanel
        results={[{ tool: "search", success: true, result: "found" }]}
        onDismiss={onDismiss}
      />
    );
    fireEvent.click(screen.getByText("Dismiss"));
    expect(onDismiss).toHaveBeenCalled();
  });
});

// ── AdminPromptBar ──────────────────────────────────────────────────────

import AdminPromptBar from "@/components/admin/AdminPromptBar";

// Mock fetch for prompt bar
global.fetch = jest.fn();

describe("AdminPromptBar", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders input with placeholder", () => {
    render(
      <AdminPromptBar
        panel="roles"
        onPlanReceived={jest.fn()}
        placeholder="Try something"
      />
    );
    expect(screen.getByPlaceholderText("Try something")).toBeDefined();
  });

  it("renders Run button", () => {
    render(<AdminPromptBar panel="roles" onPlanReceived={jest.fn()} />);
    expect(screen.getByText("Run")).toBeDefined();
  });

  it("disables Run when input is empty", () => {
    render(<AdminPromptBar panel="roles" onPlanReceived={jest.fn()} />);
    const button = screen.getByText("Run");
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  it("enables Run when input has text", () => {
    render(<AdminPromptBar panel="roles" onPlanReceived={jest.fn()} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Create a role" } });
    const button = screen.getByText("Run");
    expect(button.hasAttribute("disabled")).toBe(false);
  });
});

// ── AdminDataViews ──────────────────────────────────────────────────────

import {
  RolesDataView,
  UsersDataView,
  EntitlementsDataView,
  GuestConfigDataView,
  PasswordPolicyDataView,
} from "@/components/admin/AdminDataViews";

describe("RolesDataView", () => {
  it("renders roles table with data", () => {
    render(
      <RolesDataView
        data={{
          roles: [
            {
              id: "r1",
              name: "admin",
              displayName: "Admin",
              permissionCount: 11,
              permissions: [
                { code: "can_play", displayName: "Can Play", category: "gameplay" },
              ],
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-03-31T00:00:00Z",
            },
          ],
        }}
      />
    );
    expect(screen.getByText("Admin")).toBeDefined();
    expect(screen.getByText("11")).toBeDefined();
  });

  it("shows empty message when no roles", () => {
    render(<RolesDataView data={{ roles: [] }} />);
    expect(screen.getByText(/No roles found/)).toBeDefined();
  });

  it("expands role to show permissions on click", () => {
    render(
      <RolesDataView
        data={{
          roles: [
            {
              id: "r1",
              name: "admin",
              displayName: "Admin",
              permissionCount: 1,
              permissions: [
                { code: "can_play", displayName: "Can Play", category: "gameplay" },
              ],
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-03-31T00:00:00Z",
            },
          ],
        }}
      />
    );
    fireEvent.click(screen.getByText("Admin"));
    expect(screen.getByText("can_play")).toBeDefined();
    expect(screen.getByText("Can Play")).toBeDefined();
  });
});

describe("UsersDataView", () => {
  it("renders users table", () => {
    render(
      <UsersDataView
        data={{
          users: [
            {
              id: "p1",
              email: "alice@test.com",
              displayName: "Alice",
              roleName: "admin",
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
        }}
      />
    );
    expect(screen.getByText("alice@test.com")).toBeDefined();
    expect(screen.getByText("Alice")).toBeDefined();
  });

  it("shows empty message when no users", () => {
    render(<UsersDataView data={{ users: [] }} />);
    expect(screen.getByText(/No users found/)).toBeDefined();
  });
});

describe("EntitlementsDataView", () => {
  it("renders entitlements with status badges", () => {
    render(
      <EntitlementsDataView
        data={{
          groups: [
            {
              id: "eg1",
              code: "beta_access",
              displayName: "Beta Access",
              isActive: true,
              userCount: 5,
            },
          ],
        }}
      />
    );
    expect(screen.getByText("beta_access")).toBeDefined();
    expect(screen.getByText("Beta Access")).toBeDefined();
    expect(screen.getByText("Active")).toBeDefined();
    expect(screen.getByText("5")).toBeDefined();
  });
});

describe("GuestConfigDataView", () => {
  it("renders config values", () => {
    render(
      <GuestConfigDataView
        data={{
          config: {
            nudgeAfterSessions: 3,
            graceAfterSessions: 7,
            lockoutAfterSessions: 10,
            guestTokenTtlHours: 72,
          },
        }}
      />
    );
    expect(screen.getByText("3")).toBeDefined();
    expect(screen.getByText("7")).toBeDefined();
    expect(screen.getByText("10")).toBeDefined();
    expect(screen.getByText("72")).toBeDefined();
  });

  it("shows loading when no data", () => {
    render(<GuestConfigDataView data={{}} />);
    expect(screen.getByText("Loading...")).toBeDefined();
  });
});

describe("PasswordPolicyDataView", () => {
  it("renders policy values", () => {
    render(
      <PasswordPolicyDataView
        data={{
          policy: {
            minLength: 12,
            rotationDays: 90,
            passwordHistoryCount: 5,
            requireUppercase: true,
            requireLowercase: true,
            requireNumber: true,
            requireSpecial: false,
          },
        }}
      />
    );
    expect(screen.getByText("12")).toBeDefined();
    expect(screen.getByText("90")).toBeDefined();
    expect(screen.getByText("5")).toBeDefined();
  });

  it("shows loading when no data", () => {
    render(<PasswordPolicyDataView data={{}} />);
    expect(screen.getByText("Loading...")).toBeDefined();
  });
});
