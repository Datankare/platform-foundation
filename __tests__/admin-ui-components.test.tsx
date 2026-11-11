/**
 * @jest-environment jsdom
 */

/**
 * Sprint 7a.5 — Admin UI component tests
 *
 * Tests admin components with mocked props and user interactions.
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { renderMessage } from "@/platform/errors/messages";

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
    // In the catalog's words (TASK-202): curly quotes, the permissions listed.
    expect(screen.getByText(/Create role “Moderator” with /)).toBeDefined();
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
    expect(screen.getByText("⚠ Cannot be undone")).toBeDefined();
  });

  it("shows Running… when isExecuting", () => {
    render(
      <ActionConfirmPanel
        plan={basePlan}
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
        isExecuting={true}
      />
    );
    expect(screen.getByText("Running…")).toBeDefined();
  });

  it("names an account by the address the planner route read, never the id it put in (TASK-202, N-63)", () => {
    const id = "0b7c1d2e-3f40-4a51-8b62-7c83d94ea5f6";
    render(
      <ActionConfirmPanel
        plan={{
          message: "Blocking translate.",
          actions: [
            { tool: "block_user_feature", input: { user_id: id, feature: "translate" } },
          ],
          accounts: { 0: { email: "member@example.test", found: true } },
        }}
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
        isExecuting={false}
      />
    );
    expect(screen.getByText(/Block “translate” for member@example\.test/)).toBeDefined();
    expect(screen.queryByText(new RegExp(id))).toBeNull();
  });

  it("an account the route found in no tenant of this one: said, never the id", () => {
    const id = "0b7c1d2e-3f40-4a51-8b62-7c83d94ea5f6";
    render(
      <ActionConfirmPanel
        plan={{
          message: "",
          actions: [{ tool: "purge_user_data", input: { userId: id } }],
          accounts: { 0: { email: null, found: false } },
        }}
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
        isExecuting={false}
      />
    );
    expect(screen.getByText("Erase an account not found in this tenant")).toBeDefined();
  });

  it("says which searches were left out, and how to ask for one (TASK-202, N-65)", () => {
    render(
      <ActionConfirmPanel
        plan={{
          message: "Searching the settings.",
          actions: [{ tool: "search", input: { table: "platform_config" } }],
          scopedOut: ["permissions", "audit_log"],
        }}
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
        isExecuting={false}
      />
    );
    expect(screen.getByText(/Not searched: permissions and audit_log/)).toBeDefined();
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
            result: shown("screens.admin_console.results.role_created", {
              name: "Moderator",
              count: 2,
              gap: "none",
              missing: [],
            }),
          },
        ]}
        onDismiss={jest.fn()}
      />
    );
    expect(
      screen.getByText("Role “Moderator” created with 2 permissions.")
    ).toBeDefined();
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

  it("renders a coded failure as its catalog message, with its params (rebase round 2, 2)", () => {
    render(
      <ExecutionResultsPanel
        results={[
          {
            tool: "delete_role",
            success: false,
            error: "admin.role_in_use",
            code: "admin.role_in_use",
            params: { count: "5" },
          },
        ]}
        onDismiss={jest.fn()}
      />
    );
    expect(
      screen.getByText(
        "5 accounts still have this role. Move them to another role first."
      )
    ).toBeDefined();
    expect(screen.queryByText("admin.role_in_use")).toBeNull();
  });

  it("calls onDismiss", () => {
    const onDismiss = jest.fn();
    render(
      <ExecutionResultsPanel
        results={[
          {
            tool: "search",
            success: true,
            result: shown("screens.admin_console.results.role_changed", {
              role: "Moderator",
            }),
          },
        ]}
        onDismiss={onDismiss}
      />
    );
    fireEvent.click(screen.getByText("Dismiss"));
    expect(onDismiss).toHaveBeenCalled();
  });
});

// ── AdminPromptBar ──────────────────────────────────────────────────────

import AdminPromptBar from "@/components/admin/AdminPromptBar";

import { routeAnswer, type RouteFixtureName } from "@/__tests__/fixtures/route-responses";

// Mock fetch for prompt bar: each answer is the route's own (__tests__/fixtures/route-responses).
global.fetch = jest.fn();
const routeReply = (name: RouteFixtureName) => {
  const [status, body] = routeAnswer(name);
  return { ok: status < 400, status, json: async () => body };
};

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

  it.each([
    ["rate limited", "POST /api/admin/ai — refused (rate limited)"],
    ["signed out", "POST /api/admin/ai — refused (signed out)"],
    ["restricted", "POST /api/admin/ai — refused (a suspended staff account)"],
  ] as [string, RouteFixtureName][])(
    "a refusal (%s) is shown by the shared notice, not as a plan",
    async (_label, name) => {
      (global.fetch as jest.Mock).mockResolvedValue(routeReply(name));
      const onPlan = jest.fn();
      const { container } = render(
        <AdminPromptBar panel="roles" onPlanReceived={onPlan} />
      );
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "do it" } });
      fireEvent.click(screen.getByText("Run"));
      await waitFor(() =>
        expect(container.querySelector('[role="alert"], [role="status"]')).not.toBeNull()
      );
      expect(onPlan).not.toHaveBeenCalled();
    }
  );

  it("shows a declined request's catalog message, through the shared refusal handler (TASK-186)", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      routeReply("POST /api/admin/ai — the model declined")
    );
    const onPlan = jest.fn();
    render(<AdminPromptBar panel="roles" onPlanReceived={onPlan} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "do it" } });
    fireEvent.click(screen.getByText("Run"));
    await waitFor(() => expect(onPlan).toHaveBeenCalled());
    expect(onPlan).toHaveBeenCalledWith({
      message: renderMessage("errors.ai.request_declined"),
      actions: [],
    });
  });
});

// ── AdminDataViews ──────────────────────────────────────────────────────

import {
  RolesDataView,
  EntitlementsDataView,
  PasswordPolicyDataView,
} from "@/components/admin/AdminDataViews";
import { shown } from "@/platform/errors/shown-text";

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

  // TASK-207, N-107: a duplicated role's note was English the SQL wrote into its description; it
  // is the catalog's key and values (description_note), rendered here, before what was written.
  it("a duplicated role's note is the catalog's, then the description an administrator wrote", () => {
    const data = routeAnswer("GET /api/admin/roles — the roles")[1] as {
      roles: { displayName: string; description: string | null }[];
    };
    render(<RolesDataView data={data} />);
    fireEvent.click(screen.getByText("Roles admin (copy)"));
    const note = renderMessage("screens.admin_console.roles.duplicated_from", {
      source: "roles_admin",
    });
    expect(note).toBe("Duplicated from roles_admin.");
    expect(screen.getByText(`${note} Manages roles.`)).toBeDefined();
    // The original role has neither: nothing is shown for it.
    fireEvent.click(screen.getByText("Roles admin"));
    expect(screen.queryByText(/Duplicated from/)).toBeNull();
  });
});

// UsersDataView became the Users panel (TASK-185): __tests__/admin-users-panel.test.tsx.

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
