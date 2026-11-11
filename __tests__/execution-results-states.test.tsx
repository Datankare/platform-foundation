/**
 * @jest-environment jsdom
 */

/**
 * TASK-204 (N-41): the command bar's results, now inside coverage — a held action said as held
 * (neither done nor failed), a refusal in the catalog's words from its code and params, a failure
 * with only its text, the account acted on by address (its id only when details are shown), an
 * earlier users search counted by its rows, and a tool the catalog does not name.
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import ExecutionResultsPanel, {
  toolLabel,
} from "@/components/admin/ExecutionResultsPanel";
import { renderMessage } from "@/platform/errors/messages";
import { messageKey } from "@/platform/errors/registry";
import { shown } from "@/platform/errors/shown-text";

const r = (key: string, values?: Record<string, string | number>) =>
  renderMessage(`screens.admin_console.results.${key}`, values);

describe("ExecutionResultsPanel: each kind of result", () => {
  it("held, refused by code, failed by text: each said as what it is", () => {
    render(
      <ExecutionResultsPanel
        onDismiss={jest.fn()}
        results={[
          {
            tool: "purge_user_data",
            success: false,
            held: true,
            result: shown("screens.admin_console.results.held_second_admin"),
          },
          {
            tool: "change_user_role",
            success: false,
            code: "request.missing_fields",
            params: { fields: "role" },
          },
          {
            tool: "delete_role",
            success: false,
            code: "not.a.code",
            error: "It went wrong",
          },
          { tool: "create_role", success: false, code: "auth.permission_denied" },
        ]}
      />
    );
    expect(
      screen.getByText("Held for a second administrator’s approval; it has not run.")
    ).toBeDefined();
    expect(screen.getByText(r("held"))).toBeDefined();
    expect(
      screen.getByText(
        renderMessage(messageKey("request.missing_fields"), { fields: "role" })
      )
    ).toBeDefined();
    expect(screen.getByText("It went wrong")).toBeDefined();
    expect(
      screen.getByText(renderMessage(messageKey("auth.permission_denied")))
    ).toBeDefined();
    expect(screen.getAllByText(r("failed"))).toHaveLength(3);
  });

  it("[hostile] the account acted on by address; its id only when details are shown", () => {
    const results = [
      {
        tool: "purge_user_data",
        success: true,
        result: shown("screens.admin_console.results.password_policy_updated"),
        account: { id: "u-9", email: "leaver@example.test" },
      },
    ];
    const id = renderMessage("screens.admin_console.people.id", { id: "u-9" });
    const { rerender } = render(
      <ExecutionResultsPanel onDismiss={jest.fn()} results={results} />
    );
    expect(screen.getByText(/leaver@example\.test/)).toBeDefined();
    expect(screen.queryByText(id)).toBeNull();
    rerender(<ExecutionResultsPanel onDismiss={jest.fn()} results={results} showIds />);
    expect(screen.getByText(id)).toBeDefined();
  });

  it("an earlier users search without a count says its rows", () => {
    render(
      <ExecutionResultsPanel
        onDismiss={jest.fn()}
        results={[
          {
            tool: "search",
            success: true,
            earlier: true,
            table: {
              table: "users",
              columns: ["email"],
              rows: [["a@b.test"], ["c@d.test"]],
            },
          },
        ]}
      />
    );
    expect(
      screen.getByText(
        renderMessage("screens.admin_console.search.users_earlier", { matched: 2 })
      )
    ).toBeDefined();
  });

  it("a tool the catalog does not name is named as unknown, with its id", () => {
    expect(toolLabel("drop_everything")).toBe(
      renderMessage("screens.admin_console.tools.unknown", { tool: "drop_everything" })
    );
    expect(toolLabel("create_role")).not.toBe(
      renderMessage("screens.admin_console.tools.unknown", { tool: "create_role" })
    );
  });
});
