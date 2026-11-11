/**
 * @jest-environment jsdom
 */

/**
 * TASK-204 (N-41): the admin console's confirm step, now inside coverage — each proposed action
 * described in the catalog's words from what the planner put in (and the account the route read,
 * never the id), and the panel's own states: a choice of actions, a destructive one, a run under
 * way, a plan with nothing to do.
 */

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import ActionConfirmPanel, {
  describeAction,
} from "@/components/admin/ActionConfirmPanel";
import { describeSearch } from "@/components/admin/search-description";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";

const d = (key: string, values?: MessageValues) =>
  renderMessage(`screens.admin_console.plan.describe.${key}`, values);
const p = (key: string, values?: MessageValues) =>
  renderMessage(`screens.admin_console.plan.${key}`, values);
const none = p("none");

describe("describeAction: each tool in the catalog's words", () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ["approve_hold", { summary: "a setting" }, d("approve_hold", { what: "a setting" })],
    ["approve_hold", { proposalId: "p-1" }, d("approve_hold", { what: "p-1" })],
    ["reject_hold", {}, d("reject_hold", { what: "" })],
    [
      "create_role",
      { name: "mod", display_name: "Mod", permissions: ["a", 2] },
      d("create_role", { role: "Mod", permissions: ["a", "2"] }),
    ],
    [
      "create_role",
      { name: "mod", permissions: [] },
      d("create_role", { role: "mod", permissions: "none" }),
    ],
    ["create_role", {}, d("create_role", { role: "", permissions: "none" })],
    ["delete_role", { role_name: "old" }, d("delete_role", { role: "old" })],
    ["delete_role", {}, d("delete_role", { role: "" })],
    [
      "duplicate_role",
      { source_role: "a", new_display_name: "B" },
      d("duplicate_role", { source: "a", role: "B" }),
    ],
    ["duplicate_role", { new_name: "b" }, d("duplicate_role", { source: "", role: "b" })],
    ["duplicate_role", {}, d("duplicate_role", { source: "", role: "" })],
    [
      "assign_permissions",
      { role_name: "r", add: ["x"], remove: [] },
      d("assign_permissions", { role: "r", add: ["x"], remove: none }),
    ],
    [
      "assign_permissions",
      { add: "x" },
      d("assign_permissions", { role: "", add: none, remove: none }),
    ],
    [
      "change_user_role",
      { user_identifier: "u-1", new_role: "admin" },
      d("change_user_role", { account: "u-1", role: "admin" }),
    ],
    ["change_user_role", {}, d("change_user_role", { account: "", role: "" })],
    [
      "create_entitlement_group",
      { code: "g", permissions: ["p"] },
      d("create_entitlement_group", { group: "g", permissions: ["p"] }),
    ],
    [
      "create_entitlement_group",
      { display_name: "G", code: "g" },
      d("create_entitlement_group", { group: "G", permissions: "none" }),
    ],
    [
      "create_entitlement_group",
      {},
      d("create_entitlement_group", { group: "", permissions: "none" }),
    ],
    [
      "update_password_policy",
      { min_length: 14, rotation_days: "30" },
      d("update_password_policy", {
        changes: [
          d("policy_min_length", { value: 14 }),
          d("policy_rotation", { value: 30 }),
        ],
      }),
    ],
    [
      "update_password_policy",
      { rotation_days: 0 },
      d("update_password_policy", { changes: [d("policy_rotation", { value: 0 })] }),
    ],
    [
      "update_password_policy",
      { require_special: true },
      d("update_password_policy", { changes: d("policy_other") }),
    ],
    [
      "register_agent",
      { agent_id: "a", owner: "acme", scopes: ["s"] },
      d("register_agent", { agent: "a", owner: "acme", scopes: ["s"] }),
    ],
    [
      "register_agent",
      {},
      d("register_agent", { agent: "", owner: "first-party", scopes: none }),
    ],
    ["suspend_agent", { agent_id: "a" }, d("suspend_agent", { agent: "a" })],
    ["suspend_agent", {}, d("suspend_agent", { agent: "" })],
    [
      "suspend_agent",
      { agent_id: "a", reactivate: true },
      d("reactivate_agent", { agent: "a" }),
    ],
    ["suspend_agent", { reactivate: true }, d("reactivate_agent", { agent: "" })],
    [
      "set_agent_scope",
      { agent_id: "a", scopes: ["s", "t"] },
      d("set_agent_scope", { agent: "a", scopes: ["s", "t"] }),
    ],
    ["set_agent_scope", {}, d("set_agent_scope", { agent: "", scopes: none })],
    [
      "set_agent_ttl",
      { agent_id: "a", max_token_ttl: "600" },
      d("set_agent_ttl", { agent: "a", seconds: 600 }),
    ],
    [
      "set_agent_ttl",
      { max_token_ttl: "soon" },
      d("set_agent_ttl", { agent: "", seconds: 0 }),
    ],
    [
      "block_user_feature",
      { feature: "f", user_id: "u", reason: "  " },
      d("block_user_feature", { feature: "f", account: "u", reason: "none" }),
    ],
    [
      "block_user_feature",
      { reason: "abuse" },
      d("block_user_feature", { feature: "", account: "", reason: "abuse" }),
    ],
    [
      "unblock_user_feature",
      { feature: "f", user_id: "u" },
      d("unblock_user_feature", { feature: "f", account: "u" }),
    ],
    ["unblock_user_feature", {}, d("unblock_user_feature", { feature: "", account: "" })],
    [
      "set_approval_policy",
      { default_approver: "admin", rules: [{}, {}] },
      d("set_approval_policy", { approver: "admin", rules: 2 }),
    ],
    [
      "set_approval_policy",
      { rules: "all" },
      d("set_approval_policy", { approver: "", rules: 0 }),
    ],
    [
      "set_capability_mapping",
      { capability: "c", features: ["f"] },
      d("set_mapping", { capability: "c", features: ["f"] }),
    ],
    ["set_capability_mapping", {}, d("set_mapping", { capability: "", features: none })],
    [
      "set_capability_mapping",
      { capability: "c", remove: true },
      d("remove_mapping", { capability: "c" }),
    ],
    ["set_capability_mapping", { remove: true }, d("remove_mapping", { capability: "" })],
    ["purge_user_data", { userId: "u-9" }, d("purge_user_data", { account: "u-9" })],
    ["purge_user_data", {}, d("purge_user_data", { account: "" })],
    ["drop_everything", {}, d("other", { tool: "drop_everything" })],
  ];
  it.each(cases)("%s %j", (tool, input, expected) => {
    expect(describeAction({ tool, input })).toBe(expected);
  });

  it("a search is described as the search panel describes it", () => {
    const input = { table: "users", filters: { role: "admin" } };
    expect(describeAction({ tool: "search", input })).toBe(describeSearch(input));
  });

  // N-63: the account the route read, by address; never the id the planner put in.
  it("[hostile] names the account by the address the route read, never the id", () => {
    const action = { tool: "purge_user_data", input: { userId: "u-9" } };
    expect(describeAction(action, { email: "a@b.test", found: true })).toBe(
      d("purge_user_data", { account: "a@b.test" })
    );
    expect(describeAction(action, { email: null, found: true })).toBe(
      d("purge_user_data", {
        account: renderMessage("screens.admin_console.people.no_email"),
      })
    );
    expect(describeAction(action, { email: "a@b.test", found: false })).toBe(
      d("purge_user_data", {
        account: renderMessage("screens.admin_console.people.unknown"),
      })
    );
    for (const tool of [
      "change_user_role",
      "block_user_feature",
      "unblock_user_feature",
    ]) {
      expect(
        describeAction(
          { tool, input: { user_identifier: "u-9", user_id: "u-9" } },
          { email: "a@b.test", found: true }
        )
      ).not.toContain("u-9");
    }
  });
});

describe("ActionConfirmPanel: its states", () => {
  const two = {
    message: "Two things.",
    actions: [
      { tool: "delete_role", input: { role_name: "old" } },
      { tool: "suspend_agent", input: { agent_id: "a" } },
    ],
  };

  it("confirms only the actions left chosen; none chosen, nothing to confirm", () => {
    const onConfirm = jest.fn();
    render(
      <ActionConfirmPanel
        plan={two}
        onConfirm={onConfirm}
        onCancel={jest.fn()}
        isExecuting={false}
      />
    );
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    fireEvent.click(boxes[0]);
    fireEvent.click(screen.getByRole("button", { name: p("confirm", { count: 1 }) }));
    expect(onConfirm).toHaveBeenCalledWith([two.actions[1]]);
    fireEvent.click(boxes[1]);
    expect(
      screen.getByRole("button", { name: p("confirm", { count: 0 }) })
    ).toHaveProperty("disabled", true);
    fireEvent.click(boxes[0]);
    fireEvent.click(screen.getByRole("button", { name: p("confirm", { count: 1 }) }));
    expect(onConfirm).toHaveBeenLastCalledWith([two.actions[0]]);
  });

  it("marks a destructive action, and says so by the buttons", () => {
    render(
      <ActionConfirmPanel
        plan={two}
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
        isExecuting={false}
      />
    );
    expect(screen.getByText(`⚠ ${p("destructive")}`)).toBeDefined();
    expect(screen.getByText(p("destructive_note"))).toBeDefined();
  });

  it("while it runs: says so, and neither button acts", () => {
    const onCancel = jest.fn();
    render(
      <ActionConfirmPanel
        plan={{ message: "One.", actions: [two.actions[1]] }}
        onConfirm={jest.fn()}
        onCancel={onCancel}
        isExecuting
      />
    );
    expect(screen.getByRole("button", { name: p("executing") })).toHaveProperty(
      "disabled",
      true
    );
    expect(screen.getByRole("button", { name: p("cancel") })).toHaveProperty(
      "disabled",
      true
    );
    expect(screen.queryByText(p("destructive_note"))).toBeNull();
  });

  it("a plan with nothing to do: its message, what was left out, and a way out", () => {
    const onCancel = jest.fn();
    render(
      <ActionConfirmPanel
        plan={{ message: "Nothing to do.", actions: [], scopedOut: ["audit_log"] }}
        onConfirm={jest.fn()}
        onCancel={onCancel}
        isExecuting={false}
      />
    );
    expect(screen.getByText(p("scoped_out", { tables: ["audit_log"] }))).toBeDefined();
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: p("dismiss") }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("names each action's account as the route read it, by index", () => {
    render(
      <ActionConfirmPanel
        plan={{
          message: "Erase.",
          actions: [{ tool: "purge_user_data", input: { userId: "u-9" } }],
          accounts: { 0: { email: "a@b.test", found: true } },
        }}
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
        isExecuting={false}
      />
    );
    expect(screen.getByText(d("purge_user_data", { account: "a@b.test" }))).toBeDefined();
    expect(screen.queryByText(/u-9/)).toBeNull();
  });
});
