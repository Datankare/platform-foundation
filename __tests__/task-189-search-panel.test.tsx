/**
 * @jest-environment jsdom
 */

/**
 * __tests__/task-189-search-panel.test.tsx — The command bar shows a search's rows as a table
 * (TASK-189): before, one JSON text of every column. Other actions' results are unchanged.
 * Round 1: long values cut with the whole on hover; JSON values as JSON; the confirm panel names
 * the filters a planned search will use.
 */

import React from "react";
import { render, screen, within } from "@testing-library/react";
import ExecutionResultsPanel from "@/components/admin/ExecutionResultsPanel";
import ActionConfirmPanel from "@/components/admin/ActionConfirmPanel";
import { describeSearch } from "@/components/admin/search-description";

describe("TASK-189: the panel shows a search as a table", () => {
  it("renders the columns and rows; other actions are unchanged", () => {
    render(
      <ExecutionResultsPanel
        results={[
          {
            tool: "search",
            success: true,
            result: "2 rows of users.",
            table: {
              table: "users",
              columns: ["email", "display_name", "email_verified", "last_sign_in_at"],
              rows: [
                ["a@x.test", "Alice", true, null],
                ["b@x.test", "Bob", false, "2026-10-01T00:00:00.000Z"],
              ],
            },
          },
          { tool: "create_role", success: true, result: "Role created" },
        ]}
        onDismiss={jest.fn()}
      />
    );
    expect(screen.getByText("2 rows of users.")).toBeDefined();
    const grid = screen.getByRole("table", { name: "Search results from users" });
    const headers = within(grid)
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(headers).toEqual(["Email", "Display name", "Email verified", "Last sign-in"]);
    expect(within(grid).getAllByRole("row")).toHaveLength(3);
    expect(within(grid).getByText("Alice")).toBeDefined();
    expect(within(grid).getByText("Yes")).toBeDefined();
    expect(within(grid).getByText("No")).toBeDefined();
    expect(within(grid).getByText("—")).toBeDefined();
    expect(screen.getByText("Role created")).toBeDefined();
    expect(screen.queryByText(/"email"/)).toBeNull();
  });

  it("no rows: the line alone, no empty table", () => {
    render(
      <ExecutionResultsPanel
        results={[
          {
            tool: "search",
            success: true,
            result: "No rows of users match.",
            table: { table: "users", columns: ["email"], rows: [] },
          },
        ]}
        onDismiss={jest.fn()}
      />
    );
    expect(screen.getByText("No rows of users match.")).toBeDefined();
    expect(screen.queryByRole("table", { name: /Search results/ })).toBeNull();
  });

  it("a column the catalog does not name shows its own name", () => {
    render(
      <ExecutionResultsPanel
        results={[
          {
            tool: "search",
            success: true,
            result: "1 row of x.",
            table: { table: "x", columns: ["unnamed_col"], rows: [["v"]] },
          },
        ]}
        onDismiss={jest.fn()}
      />
    );
    expect(screen.getByText("unnamed_col")).toBeDefined();
  });
});

describe("TASK-189 round 1: long values and JSON values", () => {
  it("a long value is cut in an inner block, whole in its title", () => {
    const long = "x".repeat(500);
    render(
      <ExecutionResultsPanel
        results={[
          {
            tool: "search",
            success: true,
            result: "1 row of roles.",
            table: { table: "roles", columns: ["description"], rows: [[long]] },
          },
        ]}
        onDismiss={jest.fn()}
      />
    );
    const shown = screen.getByTitle(long);
    expect(shown.tagName).toBe("DIV");
    expect(shown.className).toMatch(/\btruncate\b/);
    expect(shown.className).toMatch(/\bmax-w-xs\b/);
  });

  it("a config value's JSON text is shown as it is, never as yes/no", () => {
    render(
      <ExecutionResultsPanel
        results={[
          {
            tool: "search",
            success: true,
            result: "2 rows of platform_config.",
            table: {
              table: "platform_config",
              columns: ["key", "value"],
              rows: [
                ["a", "true"],
                ["b", '"true"'],
              ],
            },
          },
        ]}
        onDismiss={jest.fn()}
      />
    );
    expect(screen.getByText("true")).toBeDefined();
    expect(screen.getByText('"true"')).toBeDefined();
    expect(screen.queryByText("Yes")).toBeNull();
  });
});

describe("TASK-189 round 1: the confirm panel says what a search will read", () => {
  it("names the table and each filter, in words", () => {
    render(
      <ActionConfirmPanel
        plan={{
          message: "Here are this week's sign-ins.",
          actions: [
            {
              tool: "search",
              input: {
                table: "users",
                role: "Moderator",
                signed_in_within_days: 7,
                text: "ali",
                status: null,
              },
            },
          ],
        }}
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
        isExecuting={false}
      />
    );
    expect(
      screen.getByText(
        "Search users where role is Moderator, signed in within the last 7 days, text contains “ali”"
      )
    ).toBeDefined();
  });

  it("no filter: the table alone; a key the table does not take is named, never its value", () => {
    expect(describeSearch({ table: "roles" })).toBe("Search roles");
    expect(describeSearch({ table: "audit_log", within_days: 1 })).toBe(
      "Search audit_log where recorded within the last 1 day"
    );
    expect(describeSearch({ table: "roles", within_days: 1 })).toBe(
      "Search roles where within_days (an invalid value: the search will be refused)"
    );
    expect(describeSearch({ table: "roles", limit: 5 })).toBe(
      "Search roles where limit (an invalid value: the search will be refused)"
    );
  });

  it("round 2: a non-numeric day count is named as invalid, never a raw template", () => {
    const shown = describeSearch({ table: "users", signed_in_within_days: "seven" });
    expect(shown).toBe(
      "Search users where signed_in_within_days (an invalid value: the search will be refused)"
    );
    expect(shown).not.toMatch(/[{}]|plural|seven/);
    expect(describeSearch({ table: "users", created_within_days: 0 })).not.toMatch(
      /[{}]/
    );
    expect(describeSearch({ table: "users", created_within_days: 2.5 })).not.toMatch(
      /[{}]/
    );
  });

  it("round 2: text and query together are described as the refusal they are", () => {
    expect(describeSearch({ table: "users", text: "a", query: "b" })).toBe(
      "Search users where both text and query (the search will be refused: give one)"
    );
    expect(describeSearch({ table: "users", query: "ali" })).toBe(
      "Search users where text contains “ali”"
    );
  });

  it("the panel's copy of the filters is SEARCH_FILTERS", async () => {
    const { SEARCH_FILTERS } = await import("@/app/api/admin/ai/handlers/search");
    const { DESCRIBED_FILTERS } = await import("@/components/admin/search-description");
    expect(DESCRIBED_FILTERS).toEqual(SEARCH_FILTERS);
  });
});
