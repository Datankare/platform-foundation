/**
 * @jest-environment jsdom
 */

/**
 * The governance views (TASK-220; SF-admin-050 to 063), each built from the console's shared
 * parts: what each shows, in names; its changes on the governed path, confirmed where they take
 * effect for people; and a body without its list said as a failed read, never as an empty list.
 *
 * Every list is a route's own answer (__tests__/fixtures/route-responses.json, made by
 * __tests__/route-fixtures.test.ts). A change's answer is the executor's
 * (POST /api/admin/ai/execute: `{ results: [{ success | held | code }] }`, the same shape for
 * every tool — the fixtures of one tool stand for all), or the entitlement route's own.
 */

import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  ApprovalPolicyDataView,
  AuditDataView,
  CapabilitiesDataView,
  CapabilityMappingDataView,
  EntitlementsDataView,
  PasswordPolicyDataView,
  PerAccountRestrictionsDataView,
  RolesDataView,
} from "@/components/admin/AdminDataViews";
import { renderMessage } from "@/platform/errors/messages";
import { permissionLabel } from "@/components/admin/ui/labels";
import { formatDate } from "@/components/admin/admin-format";
import { detailValue } from "@/components/admin/views/AuditView";
import { routeAnswer, type RouteFixtureName } from "@/__tests__/fixtures/route-responses";

const fetchMock = jest.fn();
beforeAll(() => {
  global.fetch = fetchMock as unknown as typeof fetch;
});
beforeEach(() => fetchMock.mockReset());

const body = (name: string) =>
  routeAnswer(name as RouteFixtureName)[1] as Record<string, unknown>;
function reply(name: string): Response {
  const [status, b] = routeAnswer(name as RouteFixtureName);
  return { ok: status < 400, status, json: async () => b } as unknown as Response;
}
const EXEC_APPLIED = "POST /api/admin/ai/execute — register_agent applied";
const EXEC_HELD = "POST /api/admin/ai/execute — register_agent held for approval";
const EXEC_REFUSED =
  "POST /api/admin/ai/execute — set_agent_scope refused (no admin_manage_agents)";

/** The request `url` was sent with, its body parsed. */
function sent(url: string): Record<string, unknown> {
  const call = fetchMock.mock.calls.find((c) => c[0] === url);
  if (!call) throw new Error(`no request to ${url}`);
  return JSON.parse(String((call[1] as RequestInit).body));
}
const may = () => true;
const outcomes = () =>
  screen.getAllByRole("status").find((n) => n.hasAttribute("data-outcomes"))!;

const ROLES = body("GET /api/admin/roles — the roles");
const role = (id: string, more: Record<string, unknown> = {}) => ({
  id,
  name: `role_${id}`,
  displayName: `Role ${id.toUpperCase()}`,
  permissionCount: 2,
  permissions: [
    { code: "can_translate", displayName: "x", category: "gameplay" },
    { code: "admin_view_audit", displayName: "x", category: "admin" },
  ],
  createdAt: "2026-10-29T14:05:00.000Z",
  updatedAt: "2026-10-29T14:05:00.000Z",
  ...more,
});
const available = [
  { code: "can_translate", displayName: "x", category: "gameplay" },
  { code: "admin_view_audit", displayName: "x", category: "admin" },
  { code: "admin_manage_users", displayName: "x", category: "admin" },
];

describe("Roles (SF-admin-053, 054, 062, 063)", () => {
  it("a role by its name, its stored name only with Show details; a caption and header scope", () => {
    const { rerender } = render(<RolesDataView data={ROLES} />);
    expect(screen.getByRole("button", { name: "Roles admin" })).toBeDefined();
    expect(screen.queryByText("roles_admin")).toBeNull();
    const table = screen.getByRole("table");
    expect(table.querySelector("caption")!.textContent).toBe("Roles");
    for (const th of within(table).getAllByRole("columnheader"))
      expect(th.getAttribute("scope")).toBe("col");
    rerender(<RolesDataView data={ROLES} showIds />);
    expect(screen.getByText("roles_admin")).toBeDefined();
  });

  it("a role's permissions by name, by category; what it lacks of the feature permissions by name", () => {
    render(
      <RolesDataView data={{ roles: [role("a")], availablePermissions: available }} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Role A" }));
    const detail = screen.getByRole("region", { name: "Role A" });
    expect(within(detail).getByText(permissionLabel("can_translate"))).toBeDefined();
    expect(detail.textContent).not.toMatch(/can_translate|admin_view_audit/);
    expect(within(detail).getByText(/^Lacks /).textContent).not.toMatch(/can_|_profile/);
  });

  it("a role the latest read added is marked New, in words, until the next read (SF-admin-062)", () => {
    const { rerender } = render(<RolesDataView data={{ roles: [role("a")] }} />);
    expect(screen.queryByText("New")).toBeNull();
    const second = { roles: [role("a"), role("b")] };
    rerender(<RolesDataView data={second} />);
    expect(screen.getByText("New").closest("tr")!.textContent).toContain("Role B");
    // The same read rendered again: still marked (it does not go by itself).
    rerender(<RolesDataView data={second} />);
    expect(screen.getByText("New")).toBeDefined();
    // The next read: nothing new.
    rerender(<RolesDataView data={{ roles: [role("a"), role("b")] }} />);
    expect(screen.queryByText("New")).toBeNull();
  });

  it("changing a role's permissions: confirmed, naming what is added and removed, then sent", async () => {
    fetchMock.mockResolvedValue(reply(EXEC_APPLIED));
    const onReload = jest.fn();
    render(
      <RolesDataView
        data={{ roles: [role("a")], availablePermissions: available }}
        hasPermission={may}
        onReload={onReload}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Role A" }));
    fireEvent.click(screen.getByRole("button", { name: "Change its permissions" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: permissionLabel("admin_manage_users") })
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: permissionLabel("admin_view_audit") })
    );
    fireEvent.click(screen.getByRole("button", { name: "Review the change" }));
    const step = screen.getByRole("alertdialog");
    expect(step.textContent).toContain(`Adds: ${permissionLabel("admin_manage_users")}.`);
    expect(step.textContent).toContain(
      `Removes: ${permissionLabel("admin_view_audit")}.`
    );
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(within(step).getByRole("button", { name: "Change permissions" }));
    await waitFor(() => expect(outcomes().textContent).toContain("Done"));
    expect(sent("/api/admin/ai/execute")).toEqual({
      actions: [
        {
          tool: "assign_permissions",
          input: {
            role_name: "role_a",
            add: ["admin_manage_users"],
            remove: ["admin_view_audit"],
          },
        },
      ],
    });
    expect(onReload).toHaveBeenCalled();
  });

  it("deleting a role cannot be undone: marked so, saying what is lost; held under dual control", async () => {
    fetchMock.mockResolvedValue(reply(EXEC_HELD));
    render(<RolesDataView data={{ roles: [role("a")] }} hasPermission={may} />);
    fireEvent.click(screen.getByRole("button", { name: "Role A" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete this role" }));
    const step = screen.getByRole("alertdialog");
    expect(step.getAttribute("data-risk")).toBe("irreversible");
    expect(step.textContent).toContain(
      renderMessage("screens.admin_console.confirm.consequence.delete_role")
    );
    fireEvent.click(within(step).getByRole("button", { name: "Delete this role" }));
    await waitFor(() => expect(outcomes().textContent).toContain("Held for approval"));
    expect(outcomes().textContent).toContain("Delete the role Role A");
    expect(sent("/api/admin/ai/execute")).toEqual({
      actions: [{ tool: "delete_role", input: { role_name: "role_a" } }],
    });
  });

  it("creating a role is ordinary: sent from its form, no confirm step", async () => {
    fetchMock.mockResolvedValue(reply(EXEC_APPLIED));
    render(
      <RolesDataView
        data={{ roles: [], availablePermissions: available }}
        hasPermission={may}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Create a role" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Support lead" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Stored name" }), {
      target: { value: "support_lead" },
    });
    fireEvent.click(
      screen.getByRole("checkbox", { name: permissionLabel("can_translate") })
    );
    fireEvent.click(screen.getByRole("button", { name: "Create the role" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(sent("/api/admin/ai/execute")).toEqual({
      actions: [
        {
          tool: "create_role",
          input: {
            name: "support_lead",
            display_name: "Support lead",
            permissions: ["can_translate"],
          },
        },
      ],
    });
  });

  it("a refused change says why, by the catalogue's sentence", async () => {
    fetchMock.mockResolvedValue(reply(EXEC_REFUSED));
    render(<RolesDataView data={{ roles: [role("a")] }} hasPermission={may} />);
    fireEvent.click(screen.getByRole("button", { name: "Role A" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy this role" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Copy" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Stored name" }), {
      target: { value: "copy" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Copy the role" }));
    await waitFor(() => expect(outcomes().textContent).toContain("Not done"));
    expect(outcomes().textContent).toContain(
      renderMessage("errors.auth.permission_denied", {
        permission: "admin_manage_agents",
      })
    );
  });

  it("without admin_manage_roles: no change is offered blind — disabled, the permission by name", () => {
    render(<RolesDataView data={{ roles: [role("a")] }} hasPermission={() => false} />);
    const create = screen.getByRole("button", {
      name: "Create a role",
    }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(
      screen.getByText(`Needs the permission “${permissionLabel("admin_manage_roles")}”.`)
    ).toBeDefined();
  });

  it("a body without its list is a failed read, never 'no roles'", () => {
    render(<RolesDataView data={{}} />);
    expect(screen.getByRole("alert").textContent).toContain("Could not read Roles");
    expect(
      screen.queryByText(renderMessage("screens.admin_console.views.roles.empty"))
    ).toBeNull();
  });
});

describe("Entitlements (SF-admin-053, 055)", () => {
  const groups = body(
    "GET /api/admin/entitlements — the groups, what each grants, and their holders"
  );
  it("a group's holders as counted, what it grants by name, its standing in words", () => {
    render(<EntitlementsDataView data={groups} />);
    expect(screen.getByText("3 accounts")).toBeDefined();
    expect(screen.getByText("No accounts")).toBeDefined();
    expect(screen.getAllByText(permissionLabel("can_translate")).length).toBeGreaterThan(
      0
    );
    expect(screen.getByText("On")).toBeDefined();
    expect(screen.getByText("Off")).toBeDefined();
    expect(screen.queryByText("premium")).toBeNull();
  });

  it("holders that could not be counted read Unknown — never 0 (SF-admin-055)", () => {
    render(
      <EntitlementsDataView
        data={body("GET /api/admin/entitlements — the holders could not be counted")}
      />
    );
    expect(screen.getByText(/^Unknown/)).toBeDefined();
    expect(screen.queryByText(/^0$|No accounts/)).toBeNull();
  });

  it("turning a group off: confirmed, then sent to the entitlement route; held under dual control", async () => {
    fetchMock.mockResolvedValue(
      reply("PATCH /api/admin/entitlements — held for a second admin")
    );
    render(<EntitlementsDataView data={groups} hasPermission={may} />);
    fireEvent.click(screen.getByRole("button", { name: "Premium" }));
    fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
    const step = screen.getByRole("alertdialog");
    expect(step.textContent).toContain(
      renderMessage(
        "screens.admin_console.confirm.consequence.set_entitlement_group_active"
      )
    );
    fireEvent.click(within(step).getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(outcomes().textContent).toContain("Held for approval"));
    expect(sent("/api/admin/entitlements")).toEqual({
      groupId: "0000000e-0000-4000-8000-000000000001",
      isActive: false,
    });
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("PATCH");
  });

  it("turned off and applied: done, and the groups read again", async () => {
    fetchMock.mockResolvedValue(reply("PATCH /api/admin/entitlements — turned off"));
    const onReload = jest.fn();
    render(
      <EntitlementsDataView data={groups} hasPermission={may} onReload={onReload} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Premium" }));
    fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Turn off" })
    );
    await waitFor(() => expect(outcomes().textContent).toContain("Done"));
    expect(outcomes().textContent).toContain("Turn off the group Premium");
    expect(onReload).toHaveBeenCalled();
  });
});

describe("Audit (SF-admin-050, 051, 052)", () => {
  const PAGE = "GET /api/admin/audit — a page of the log, more to read";
  it("reads its own pages: the first, then the next — the route's own hasMore", async () => {
    fetchMock.mockResolvedValue(reply(PAGE));
    render(<AuditDataView data={undefined} hasPermission={may} />);
    await screen.findByRole("table");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/admin/audit?offset=0&limit=50");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.map((c) => c[0])).toContain(
        "/api/admin/audit?offset=50&limit=50"
      )
    );
  });

  it("each action by name, people by address, details as named pairs (SF-admin-051, 052)", async () => {
    fetchMock.mockResolvedValue(reply(PAGE));
    render(<AuditDataView data={undefined} hasPermission={may} />);
    await screen.findByRole("table");
    expect(
      within(screen.getByRole("table")).getByText("Administrator's action")
    ).toBeDefined();
    expect(within(screen.getByRole("table")).getByText("Role changed")).toBeDefined();
    expect(screen.queryByText(/role_changed|admin_action/)).toBeNull();
    expect(screen.getAllByText("admin@example.com").length).toBe(2);
    expect(screen.getByText("From role")).toBeDefined();
    // The role by its name, never its stored code.
    expect(screen.getByText("Moderator")).toBeDefined();
    expect(screen.queryByText("moderator")).toBeNull();
    expect(screen.queryByText(/\{"fromRole"/)).toBeNull();
    // A target that names no account of the tenant (a setting): said so, its id a detail.
    expect(screen.getByText(/Not an account of this tenant/)).toBeDefined();
    expect(screen.queryByText("moderation.strike_ban_threshold")).toBeNull();
  });

  it("a detail's value in words: names for a role, feature, permission and setting; a code readable; Yes or No", () => {
    expect(detailValue("toRole", "safety_approver")).toBe("Safety approver");
    expect(detailValue("feature", "translate")).toBe("Translate");
    expect(detailValue("permissions", ["admin_manage_users"])).toBe(
      permissionLabel("admin_manage_users")
    );
    expect(detailValue("key", "signups_enabled")).not.toContain("_");
    expect(detailValue("via", "first_authenticated_request")).toBe(
      "First authenticated request"
    );
    expect(detailValue("requiresConsent", false)).toBe("No");
    expect(detailValue("enabled", true)).toBe("Yes");
    // Text that is not a code stays as written (an address, a sentence, a number).
    expect(detailValue("email", "ann@example.com")).toBe("ann@example.com");
    expect(detailValue("note", "Fewer bans")).toBe("Fewer bans");
    expect(detailValue("count", 3)).toBe("3");
    expect(detailValue("list", [])).toBe("None");
  });

  it("a filter by action, each by name: the log asked again with that action", async () => {
    fetchMock.mockResolvedValue(reply(PAGE));
    render(<AuditDataView data={undefined} hasPermission={may} />);
    await screen.findByRole("table");
    fireEvent.change(screen.getByRole("combobox", { name: "Show one kind of entry" }), {
      target: { value: "role_changed" },
    });
    await waitFor(() =>
      expect(fetchMock.mock.calls.map((c) => c[0])).toContain(
        "/api/admin/audit?offset=0&limit=50&q=role_changed"
      )
    );
  });

  it("a filter by account: its address found through the Users search (a POST), the log asked by its id", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === "/api/admin/users/search"
        ? reply("POST /api/admin/users/search — Ann alone")
        : reply(PAGE)
    );
    render(<AuditDataView data={undefined} hasPermission={may} />);
    await screen.findByRole("table");
    fireEvent.change(
      screen.getByRole("textbox", { name: /Show one account's entries/ }),
      {
        target: { value: "Ann@Example.com" },
      }
    );
    fireEvent.click(screen.getByRole("button", { name: "Show its entries" }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.map((c) => c[0])).toContain(
        "/api/admin/audit?offset=0&limit=50&q=11111111-1111-4111-8111-111111111111"
      )
    );
    expect(sent("/api/admin/users/search")).toEqual({ q: "ann@example.com", limit: 25 });
    // The address never travels in a URL.
    expect(fetchMock.mock.calls.map((c) => String(c[0])).join(" ")).not.toMatch(
      /example\.com/i
    );
  });

  it("an address no account has: said at its field", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === "/api/admin/users/search"
        ? reply("POST /api/admin/users/search — no accounts")
        : reply(PAGE)
    );
    render(<AuditDataView data={undefined} hasPermission={may} />);
    await screen.findByRole("table");
    const box = screen.getByRole("textbox", { name: /Show one account's entries/ });
    fireEvent.change(box, { target: { value: "nobody@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Show its entries" }));
    await waitFor(() => expect(box.getAttribute("aria-invalid")).toBe("true"));
  });

  it("a refused read is a failed read, with Try again", async () => {
    fetchMock.mockResolvedValue(reply("GET /api/admin/audit — refused (no permission)"));
    render(<AuditDataView data={undefined} />);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Could not read")
    );
  });
});

describe("Password policy (SF-admin-053, 056)", () => {
  const POLICY = body("GET /api/admin/password-policy — the policy");
  it("each rule in words: Yes or No, never a glyph; no rotation is Never", () => {
    render(
      <PasswordPolicyDataView
        data={{
          policy: {
            ...(POLICY.policy as object),
            requireSpecial: false,
            rotationDays: 0,
          },
        }}
      />
    );
    expect(screen.getAllByText("Yes").length).toBe(3);
    expect(screen.getByText("No")).toBeDefined();
    expect(screen.getByText("Never")).toBeDefined();
    expect(screen.queryByText(/[✓✕]/)).toBeNull();
  });

  it("a change: each rule from → to in the confirm step, only what changed sent", async () => {
    fetchMock.mockResolvedValue(reply(EXEC_HELD));
    render(<PasswordPolicyDataView data={POLICY} hasPermission={may} />);
    fireEvent.click(screen.getByRole("button", { name: "Change the policy" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Shortest password" }), {
      target: { value: "14" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Needs a symbol" }));
    fireEvent.click(screen.getByRole("button", { name: "Review the change" }));
    const step = screen.getByRole("alertdialog");
    expect(step.textContent).toContain(
      "Shortest password: 12 characters → 14 characters"
    );
    expect(step.textContent).toContain("Needs a symbol: Yes → No");
    fireEvent.click(within(step).getByRole("button", { name: "Change the policy" }));
    await waitFor(() => expect(outcomes().textContent).toContain("Held for approval"));
    expect(sent("/api/admin/ai/execute")).toEqual({
      actions: [
        {
          tool: "update_password_policy",
          input: { min_length: 14, require_special: false },
        },
      ],
    });
  });

  it("a number that is not one is said at its field, before anything is sent", () => {
    render(<PasswordPolicyDataView data={POLICY} hasPermission={may} />);
    fireEvent.click(screen.getByRole("button", { name: "Change the policy" }));
    const box = screen.getByRole("textbox", { name: "Shortest password" });
    fireEvent.change(box, { target: { value: "twelve" } });
    fireEvent.click(screen.getByRole("button", { name: "Review the change" }));
    expect(box.getAttribute("aria-invalid")).toBe("true");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Per-account (SF-admin-053, 057, 058)", () => {
  const BLOCKS = body(
    "GET /api/admin/per-account — a block, and the features that exist"
  );
  it("one heading (the section's), the block since its date, by address and feature name", () => {
    render(<PerAccountRestrictionsDataView data={BLOCKS} hasPermission={may} />);
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
    expect(screen.getByText("blocked@example.com")).toBeDefined();
    expect(screen.getByText("admin@example.com")).toBeDefined();
    // The console's date (admin-format), in the reader's time zone.
    expect(screen.getByText(formatDate("2026-01-02T00:00:00.000Z"))).toBeDefined();
    expect(screen.getByText("Translate")).toBeDefined();
  });

  it("Lift: the unblock, sent for that account and feature", async () => {
    fetchMock.mockResolvedValue(reply(EXEC_APPLIED));
    const onReload = jest.fn();
    render(
      <PerAccountRestrictionsDataView
        data={BLOCKS}
        hasPermission={may}
        onReload={onReload}
      />
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Lift the block on Translate for blocked@example.com",
      })
    );
    await waitFor(() => expect(outcomes().textContent).toContain("Done"));
    expect(sent("/api/admin/ai/execute")).toEqual({
      actions: [
        {
          tool: "unblock_user_feature",
          input: {
            user_id: "00000000-0000-4000-8000-0000000b10c1",
            feature: "translate",
          },
        },
      ],
    });
    expect(onReload).toHaveBeenCalled();
  });

  it("a block: the account found by address, the feature by name, a reason, confirmed", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === "/api/admin/users/search"
        ? reply("POST /api/admin/users/search — Ann alone")
        : reply(EXEC_APPLIED)
    );
    render(<PerAccountRestrictionsDataView data={BLOCKS} hasPermission={may} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Block a feature for an account" })
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "The account's email address" }),
      {
        target: { value: "ann@example.com" },
      }
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Feature" }), {
      target: { value: "song_id" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review the block" }));
    const step = await screen.findByRole("alertdialog");
    expect(step.textContent).toContain("Block Song ID for ann@example.com?");
    fireEvent.change(within(step).getByRole("textbox", { name: "Reason (optional)" }), {
      target: { value: "Spam" },
    });
    fireEvent.click(within(step).getByRole("button", { name: "Block it" }));
    await waitFor(() => expect(outcomes().textContent).toContain("Done"));
    expect(sent("/api/admin/ai/execute")).toEqual({
      actions: [
        {
          tool: "block_user_feature",
          input: {
            user_id: "11111111-1111-4111-8111-111111111111",
            feature: "song_id",
            reason: "Spam",
          },
        },
      ],
    });
  });

  it("each block keyed by its account and feature; no id shown", () => {
    const { container } = render(<PerAccountRestrictionsDataView data={BLOCKS} />);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(container.textContent).not.toContain("00000000-0000-4000-8000-0000000b10c1");
  });
});

describe("Approval policy (SF-admin-053, 057, 059)", () => {
  it("its values in the catalogue's words — risks, effects, approvers — never codes", () => {
    render(
      <ApprovalPolicyDataView
        data={{
          policy: {
            version: 4,
            default: "user",
            rules: [
              {
                maxRisk: "ordinary",
                effects: ["stateWrite", "externalCall"],
                requiredApprover: "agent",
              },
              { maxRisk: "consequential", requiredApprover: "user" },
            ],
          },
        }}
      />
    );
    expect(
      screen.getByText(/Version 4\. When no rule matches, a person approves\./)
    ).toBeDefined();
    expect(screen.getByText("Up to ordinary risk")).toBeDefined();
    expect(
      screen.getByText("writes stored data and calls an outside service")
    ).toBeDefined();
    expect(screen.getByText("Any effect")).toBeDefined();
    expect(screen.getByText("an agent")).toBeDefined();
    expect(document.body.textContent).not.toMatch(/stateWrite|externalCall|maxRisk/);
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
  });

  it("changing the rules: the new policy read back in words, then sent as the tool takes it", async () => {
    fetchMock.mockResolvedValue(reply(EXEC_HELD));
    render(
      <ApprovalPolicyDataView
        data={body("GET /api/admin/approval-policy — the policy")}
        hasPermission={may}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Change the rules" }));
    fireEvent.click(screen.getByRole("button", { name: "Add a rule" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Who approves" }), {
      target: { value: "agent" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "sends a message" }));
    fireEvent.click(screen.getByRole("button", { name: "Review the change" }));
    const step = screen.getByRole("alertdialog");
    expect(step.textContent).toContain(
      "Up to ordinary risk, sends a message: an agent approves"
    );
    fireEvent.click(within(step).getByRole("button", { name: "Store the new policy" }));
    await waitFor(() => expect(outcomes().textContent).toContain("Held for approval"));
    expect(sent("/api/admin/ai/execute")).toEqual({
      actions: [
        {
          tool: "set_approval_policy",
          input: {
            rules: [
              {
                max_risk: "ordinary",
                effects: ["sendMessage"],
                required_approver: "agent",
              },
            ],
          },
        },
      ],
    });
  });
});

describe("Capabilities (SF-admin-057, 060)", () => {
  it("goals by name, steps by name, cost in the console's currency format; the endpoint only with Show details", () => {
    const data = {
      goals: [
        {
          goal: "translate-and-speak",
          description: "Translates text and reads it aloud.",
          endpoint: "/api/process",
          steps: [{ intent: "translate" }, { intent: "speak" }],
          estimatedCostUSD: 0.004,
          requiredCapability: "translate",
        },
        { goal: "analyze", endpoint: "/api/agent/analyze" },
      ],
    };
    const { rerender } = render(<CapabilitiesDataView data={data} />);
    expect(screen.getByText("Translate and speak")).toBeDefined();
    expect(screen.getByText("Speak")).toBeDefined();
    expect(screen.getByText("US$0.004")).toBeDefined();
    expect(screen.getByText("US$0.00")).toBeDefined();
    expect(screen.getByText("Nothing beyond signing in")).toBeDefined();
    expect(screen.queryByText("/api/process")).toBeNull();
    expect(screen.queryByText("—")).toBeNull();
    rerender(<CapabilitiesDataView data={data} showIds />);
    expect(screen.getByText("/api/process")).toBeDefined();
  });

  it("the route's own answer (no workflow registered here): said as nothing yet", () => {
    render(
      <CapabilitiesDataView data={body("GET /api/admin/capabilities — the goals")} />
    );
    expect(
      screen.getByText(renderMessage("screens.admin_console.views.capabilities.empty"))
    ).toBeDefined();
  });
});

describe("Capability map (SF-admin-053, 057, 061)", () => {
  const MAP = body(
    "GET /api/admin/capability-mapping — the map and the features that exist"
  );
  it("each capability and the features it needs, by name", () => {
    render(<CapabilityMappingDataView data={MAP} />);
    expect(screen.getByRole("button", { name: "Identify song" })).toBeDefined();
    expect(screen.getByText("Song ID and Translate")).toBeDefined();
    expect(screen.queryByText(/song_id/)).toBeNull();
  });

  it("a capability's features changed: confirmed from → to, sent as the tool takes it", async () => {
    fetchMock.mockResolvedValue(reply(EXEC_APPLIED));
    render(<CapabilityMappingDataView data={MAP} hasPermission={may} />);
    fireEvent.click(screen.getByRole("button", { name: "Translate" }));
    fireEvent.click(screen.getByRole("button", { name: "Change its features" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Text to speech" }));
    fireEvent.click(screen.getByRole("button", { name: "Review the change" }));
    const step = screen.getByRole("alertdialog");
    expect(step.textContent).toContain(
      "From: Translate. To: Translate and Text to speech."
    );
    fireEvent.click(within(step).getByRole("button", { name: "Change the map" }));
    await waitFor(() => expect(outcomes().textContent).toContain("Done"));
    expect(sent("/api/admin/ai/execute")).toEqual({
      actions: [
        {
          tool: "set_capability_mapping",
          input: { capability: "translate", features: ["translate", "tts"] },
        },
      ],
    });
  });

  it("a mapping removed: confirmed, saying what follows", async () => {
    fetchMock.mockResolvedValue(reply(EXEC_HELD));
    render(<CapabilityMappingDataView data={MAP} hasPermission={may} />);
    fireEvent.click(screen.getByRole("button", { name: "Translate" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove the mapping" }));
    const step = screen.getByRole("alertdialog");
    expect(step.textContent).toContain(
      renderMessage("screens.admin_console.confirm.consequence.capability_mapping_remove")
    );
    fireEvent.click(within(step).getByRole("button", { name: "Remove the mapping" }));
    await waitFor(() => expect(outcomes().textContent).toContain("Held for approval"));
    expect(sent("/api/admin/ai/execute")).toEqual({
      actions: [
        {
          tool: "set_capability_mapping",
          input: { capability: "translate", remove: true },
        },
      ],
    });
  });

  it("a body without its list, or not a list, is a failed read — never 'none'", () => {
    const { rerender } = render(<CapabilityMappingDataView data={{ mappings: "x" }} />);
    expect(screen.getByRole("alert")).toBeDefined();
    rerender(<CapabilityMappingDataView data={{ mappings: [], features: [] }} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.getByText(renderMessage("screens.admin_console.views.capability_map.empty"))
    ).toBeDefined();
  });
});
