/**
 * @jest-environment jsdom
 */
/**
 * __tests__/task-190-one-list.test.tsx — On the Users screen a command-bar search of users
 * filters the one list; ids behind "Show details"; readable values (TASK-190)
 *
 * The owner's live check: "show moderators" on /admin → Users drew a second table in the results
 * box (an Id column, raw ISO dates, the role as "moderator") while the list below still showed
 * everyone. Now: the list applies the search's validated filters (from the execute response's
 * `table.filters`) and shows them as removable chips with "Clear all", and the search's row says
 * how many matched, "shown in the list below" — no second table; a search of any other table, or
 * of users from another section, keeps the compact table, its values readable ("29 Oct 2026" with
 * the whole timestamp in the tooltip, "Moderator", "Active") and its ids hidden unless "Show
 * details" is on — a toggle only admins and super-admins are offered.
 *
 * Round 1: a chip removed or "Clear all" dismisses the search's row (1); a hand-off clears the
 * panel's own search box, and the row has no count of its own (2); a role with no display name
 * reads "Qa lead" (3); only `id` is hidden — actor and target ids show their first 8 characters
 * (4); the toggle only where it changes something (5); an earlier users search of a plan is one
 * line (6); a refused users search keeps the list's filters and says so (7); tooltips in UTC (8);
 * a role chip's words do not change when the roles load (9).
 */
import React, { useState } from "react";
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const push = jest.fn();
const replace = jest.fn();
const signOut = jest.fn(async () => undefined);
jest.mock("next/navigation", () => ({ useRouter: () => ({ push, replace }) }));
jest.mock("@/platform/auth/context", () => ({
  ...jest.requireActual("@/platform/auth/context"),
  useAuth: () => ({ signOut }),
}));

import AdminPage from "@/app/admin/page";
import {
  filterChip,
  UsersPanel,
  type UserListFilters,
} from "@/components/admin/UsersPanel";
import ExecutionResultsPanel, {
  shownCell,
} from "@/components/admin/ExecutionResultsPanel";
import {
  afterFiltersChanged,
  applyUsersSearch,
} from "@/components/admin/users-search-handoff";
import { DETAILS_ROLES, mayShowDetails } from "@/components/admin/ShowDetailsToggle";
import { fullTimestamp } from "@/components/admin/admin-format";
import { renderMessage } from "@/platform/errors/messages";

const u = (key: string, values?: Record<string, string | number>) =>
  renderMessage(`screens.admin_console.users.${key}`, values);
const SHOW = renderMessage("screens.admin_console.details.show");
const HIDE = renderMessage("screens.admin_console.details.hide");

const ROLES = [
  { id: "r-free", name: "free", displayName: "Free" },
  { id: "r-mod", name: "moderator", displayName: "Moderator" },
];
const MOD_ID = "33333333-3333-4333-8333-333333333333";
const MOD = {
  id: MOD_ID,
  email: "mo@example.com",
  displayName: "Mo",
  roleId: "r-mod",
  roleName: "moderator",
  roleDisplayName: "Moderator",
  status: "active",
  statusUntil: null,
  emailVerified: true,
  createdAt: "2026-10-29T09:15:00.000Z",
  lastSignInAt: "2026-10-29T10:00:00.000Z",
  entitlements: [],
};
const ANN = {
  ...MOD,
  id: "11111111-1111-4111-8111-111111111111",
  email: "ann@example.com",
  displayName: "Ann",
  roleId: "r-free",
  roleName: "free",
  roleDisplayName: "Free",
};

const json = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const fetchMock = jest.fn();
/** The Users list's reads, as their query parameters. */
const listReads = () =>
  fetchMock.mock.calls
    .map(([url, init]) => ({ url: String(url), init: init as RequestInit | undefined }))
    .filter((c) => c.url.startsWith("/api/admin/users?") && !c.init?.method)
    .map((c) => new URL(c.url, "http://x").searchParams);

/** A list that answers as the server would: only moderators when role=moderator. */
function listAnswer(url: string) {
  const role = new URL(url, "http://x").searchParams.get("role");
  const users = role?.toLowerCase() === "moderator" ? [MOD] : [ANN, MOD];
  return json(200, { users, roles: ROLES, page: { hasMore: false } });
}

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).startsWith("/api/admin/users")) return listAnswer(String(url));
    return json(404, {});
  });
});

async function settle() {
  for (let i = 0; i < 6; i++) await act(async () => await Promise.resolve());
}

/** The panel with its filters held as the console page holds them. */
function Holder({
  initial,
  showIds = false,
  handoff = 0,
}: {
  initial: UserListFilters;
  showIds?: boolean;
  handoff?: number;
}) {
  const [filters, setFilters] = useState<UserListFilters>(initial);
  return (
    <UsersPanel
      hasPermission={() => true}
      filters={filters}
      onFiltersChange={setFilters}
      showIds={showIds}
      handoff={handoff}
    />
  );
}

describe("the Users list applies the command bar's filters, as chips", () => {
  it("sends each filter to the list and names it readably", async () => {
    render(
      <Holder
        initial={{ role: "moderator", signed_in_within_days: 7, status: "active" }}
      />
    );
    await screen.findByText("mo@example.com");
    expect(screen.queryByText("ann@example.com")).toBeNull();
    const read = listReads().at(-1)!;
    expect(read.get("role")).toBe("moderator");
    expect(read.get("signed_in_within_days")).toBe("7");
    expect(read.get("status")).toBe("active");
    const chips = screen.getByRole("group", { name: u("filters_label") });
    expect(
      within(chips).getByRole("button", { name: "Remove filter: Role: Moderator" })
    ).toBeDefined();
    expect(within(chips).getByText("Signed in within 7 days")).toBeDefined();
    expect(within(chips).getByText("Status: Active")).toBeDefined();
    expect(
      within(chips).getByRole("button", { name: u("filters_clear_all") })
    ).toBeDefined();
  });

  it("removing a chip reads the list without it; Clear all removes every one", async () => {
    render(<Holder initial={{ role: "moderator", created_within_days: 30 }} />);
    await screen.findByText("mo@example.com");
    fireEvent.click(
      screen.getByRole("button", { name: "Remove filter: Role: Moderator" })
    );
    await screen.findByText("ann@example.com");
    const after = listReads().at(-1)!;
    expect(after.get("role")).toBeNull();
    expect(after.get("created_within_days")).toBe("30");
    expect(after.get("offset")).toBe("0");
    fireEvent.click(screen.getByRole("button", { name: u("filters_clear_all") }));
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: u("filters_label") })).toBeNull()
    );
    expect(listReads().at(-1)!.get("created_within_days")).toBeNull();
  });

  it("no filters: no chips, nothing extra sent", async () => {
    render(<Holder initial={{}} />);
    await screen.findByText("ann@example.com");
    expect(screen.queryByRole("group", { name: u("filters_label") })).toBeNull();
    const read = listReads().at(-1)!;
    for (const k of ["role", "status", "text", "signed_in_within_days"])
      expect(read.get(k)).toBeNull();
  });

  it("a filtered list with no match says so", async () => {
    fetchMock.mockImplementation(async () =>
      json(200, { users: [], roles: ROLES, page: { hasMore: false } })
    );
    render(<Holder initial={{ status: "banned" }} />);
    expect(await screen.findByText(u("empty_filtered"))).toBeDefined();
  });

  it("chip words: a role not in the catalog read as a role name, text quoted, plural days", () => {
    expect(filterChip("role", "Support Lead", ROLES)).toBe("Role: Support lead");
    expect(filterChip("role", "qa_lead", ROLES)).toBe("Role: Qa lead");
    expect(filterChip("role", "MODERATOR", ROLES)).toBe("Role: Moderator");
    expect(filterChip("text", "jane", ROLES)).toBe("Contains “jane”");
    expect(filterChip("created_within_days", 1)).toBe("Created within 1 day");
    expect(filterChip("status", "restricted")).toBe("Status: Restricted");
  });

  it("dates as the Users screen writes them, the whole timestamp in the tooltip", async () => {
    render(<Holder initial={{}} />);
    await screen.findByText("ann@example.com");
    const cells = screen.getAllByText("29 Oct 2026");
    expect(cells.length).toBeGreaterThan(0);
    expect(cells[0]).toHaveAttribute("title", fullTimestamp(MOD.createdAt));
    // In UTC, and saying so, whatever the browser's zone (round 1, item 8).
    expect(fullTimestamp(MOD.createdAt)).toBe("29 Oct 2026, 09:15:00 UTC");
  });

  it("round 2 (9): a role chip is named once the roles are read — no flip on screen", async () => {
    for (const role of ["moderator", "MODERATOR", "free"])
      expect(filterChip("role", role, [])).toBe(filterChip("role", role, ROLES));
    let answer: (v: unknown) => void = () => undefined;
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        })
    );
    // A role whose display name the value alone cannot give: the catalog names it.
    const QA = { id: "r-qa", name: "qa", displayName: "QA Lead" };
    render(<Holder initial={{ role: "qa", status: "active" }} />);
    // While the first page is read: a placeholder, never a guess that would then change.
    expect(screen.getByRole("button", { name: "Remove filter: Role: …" })).toBeDefined();
    expect(screen.queryByText("Role: Qa")).toBeNull();
    expect(screen.getByText("Status: Active")).toBeDefined();
    await act(async () =>
      answer(json(200, { users: [MOD], roles: [...ROLES, QA], page: { hasMore: false } }))
    );
    await screen.findByText("mo@example.com");
    expect(
      screen.getByRole("button", { name: "Remove filter: Role: QA lead" })
    ).toBeDefined();
  });

  it("round 2 (9): a first read that failed names the role chip from its value", async () => {
    fetchMock.mockImplementation(async () => json(500, {}));
    render(<Holder initial={{ role: "qa_lead" }} />);
    expect(
      await screen.findByRole("button", { name: "Remove filter: Role: Qa lead" })
    ).toBeDefined();
  });

  it("round 2 (N-1): a hand-off of the same filters goes back to page 1, nothing open", async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      ...ANN,
      id: `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`,
      email: `u${i}@example.com`,
    }));
    fetchMock.mockImplementation(async () =>
      json(200, { users: many, roles: ROLES, page: { hasMore: true } })
    );
    const { rerender } = render(<Holder initial={{ role: "free" }} handoff={1} />);
    await screen.findByText("u0@example.com");
    fireEvent.click(screen.getByRole("button", { name: u("next") }));
    await waitFor(() => expect(listReads().at(-1)!.get("offset")).toBe("25"));
    await screen.findByText("u0@example.com");
    fireEvent.click(screen.getByText("u3@example.com"));
    expect(screen.getByRole("heading", { name: /^Account:/ })).toBeDefined();
    rerender(<Holder initial={{ role: "free" }} handoff={2} />);
    await waitFor(() => expect(listReads().at(-1)!.get("offset")).toBe("0"));
    expect(listReads().at(-1)!.get("role")).toBe("free");
    expect(screen.queryByRole("heading", { name: /^Account:/ })).toBeNull();
  });

  it("round 1 (2): a hand-off clears the panel's own search box", async () => {
    const { rerender } = render(<Holder initial={{}} />);
    await screen.findByText("ann@example.com");
    const box = screen.getByRole("searchbox");
    fireEvent.change(box, { target: { value: "ann" } });
    fireEvent.submit(box.closest("form")!);
    await waitFor(() => expect(listReads().at(-1)!.get("q")).toBe("ann"));
    rerender(<Holder initial={{}} handoff={1} />);
    await waitFor(() => expect(listReads().at(-1)!.get("q")).toBeNull());
    expect(screen.getByRole("searchbox")).toHaveValue("");
    expect(screen.queryByRole("button", { name: u("clear") })).toBeNull();
  });

  it("ids: hidden by default; the Id column and the detail id with showIds", async () => {
    const { unmount } = render(<Holder initial={{}} />);
    await screen.findByText("ann@example.com");
    expect(screen.queryByRole("columnheader", { name: u("col_id") })).toBeNull();
    expect(screen.queryByText(MOD_ID)).toBeNull();
    unmount();
    render(<Holder initial={{}} showIds />);
    await screen.findByText("ann@example.com");
    expect(screen.getByRole("columnheader", { name: u("col_id") })).toBeDefined();
    expect(screen.getByText(MOD_ID)).toBeDefined();
  });
});

describe("the results row of a users search on the Users screen: one line, no table", () => {
  const usersSearch = {
    tool: "search",
    success: true,
    result: "1 row of users.",
    table: {
      table: "users",
      columns: ["id", "email", "role", "created_at"],
      rows: [[MOD_ID, "mo@example.com", "Moderator", MOD.createdAt]],
      matched: 1,
      filters: { role: "moderator" },
    },
  };

  const LISTED = "The matching users are shown in the list below.";

  it("listed: 'shown in the list below', no grid, no count of its own (round 1, item 2)", () => {
    render(
      <ExecutionResultsPanel
        results={[
          { ...usersSearch, listed: true, table: { ...usersSearch.table, matched: 7 } },
        ]}
        onDismiss={jest.fn()}
      />
    );
    expect(screen.getByText(LISTED)).toBeDefined();
    // The planner's count is not the list's: it is not shown.
    expect(screen.queryByText(/7/)).toBeNull();
    expect(screen.queryByRole("table", { name: /Search results from users/ })).toBeNull();
  });

  it("round 1 (6): an earlier users search of the plan is one line, no table", () => {
    render(
      <ExecutionResultsPanel
        results={[
          { ...usersSearch, earlier: true, table: { ...usersSearch.table, matched: 3 } },
          { ...usersSearch, earlier: true },
          { ...usersSearch, listed: true },
        ]}
        onDismiss={jest.fn()}
      />
    );
    expect(
      screen.getByText("3 users matched (an earlier search in this plan).")
    ).toBeDefined();
    expect(
      screen.getByText("1 user matched (an earlier search in this plan).")
    ).toBeDefined();
    expect(screen.getByText(LISTED)).toBeDefined();
    expect(screen.queryByRole("table", { name: /Search results from users/ })).toBeNull();
  });

  it("round 1 (7): a refused users search says the list kept its filters", () => {
    render(
      <ExecutionResultsPanel
        results={[
          {
            tool: "search",
            success: false,
            error: "The value of status is not valid.",
            keptFilters: "previous" as const,
          },
        ]}
        onDismiss={jest.fn()}
      />
    );
    expect(
      screen.getByText(
        "The value of status is not valid. The list still shows the previous filters."
      )
    ).toBeDefined();
  });

  it("round 2 (N-3): after an earlier users search in the plan, the row says whose filters", () => {
    render(
      <ExecutionResultsPanel
        results={[
          { ...usersSearch, listed: true },
          {
            tool: "search",
            success: false,
            error: "The value of status is not valid.",
            keptFilters: "earlier" as const,
          },
        ]}
        onDismiss={jest.fn()}
      />
    );
    expect(
      screen.getByText(
        "The value of status is not valid. The list shows the filters of the earlier search in this plan."
      )
    ).toBeDefined();
  });

  it("not listed (another section): the compact table, readable, ids hidden", () => {
    render(<ExecutionResultsPanel results={[usersSearch]} onDismiss={jest.fn()} />);
    const grid = screen.getByRole("table", { name: "Search results from users" });
    const headers = within(grid)
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(headers).toEqual(["Email", "Role", "Created"]);
    expect(within(grid).queryByText(MOD_ID)).toBeNull();
    expect(within(grid).getByText("Moderator")).toBeDefined();
    const date = within(grid).getByText("29 Oct 2026");
    expect(date).toHaveAttribute("title", fullTimestamp(MOD.createdAt));
    expect(within(grid).queryByText(MOD.createdAt)).toBeNull();
  });

  it("round 1 (4): only `id` is behind Show details; actor and target as on the Audit log", () => {
    const ACTOR = "aaaaaaaa-1111-4111-8111-111111111111";
    const TARGET = "bbbbbbbb-2222-4222-8222-222222222222";
    const audit = {
      tool: "search",
      success: true,
      result: "1 row of audit_log.",
      table: {
        table: "audit_log",
        columns: ["id", "action", "actor_id", "target_id", "created_at"],
        rows: [[MOD_ID, "role_changed", ACTOR, TARGET, MOD.createdAt]],
      },
    };
    const { rerender } = render(
      <ExecutionResultsPanel results={[audit]} onDismiss={jest.fn()} />
    );
    let grid = screen.getByRole("table", { name: "Search results from audit_log" });
    expect(
      within(grid)
        .getAllByRole("columnheader")
        .map((h) => h.textContent)
    ).toEqual(["Action", "Actor", "Target", "Created"]);
    expect(within(grid).getByText("aaaaaaaa")).toHaveAttribute("title", ACTOR);
    expect(within(grid).getByText("bbbbbbbb")).toHaveAttribute("title", TARGET);
    expect(within(grid).queryByText(MOD_ID)).toBeNull();
    rerender(<ExecutionResultsPanel results={[audit]} showIds onDismiss={jest.fn()} />);
    grid = screen.getByRole("table", { name: "Search results from audit_log" });
    expect(
      within(grid)
        .getAllByRole("columnheader")
        .map((h) => h.textContent)
    ).toEqual(["Id", "Action", "Actor", "Target", "Created"]);
    expect(within(grid).getByText(MOD_ID)).toBeDefined();
  });

  it("readable cells: status capitalised, role in sentence case, JSON left as JSON", () => {
    expect(shownCell("users", "status", "restricted").text).toBe("Restricted");
    // Round 1 (3): a role with no display name, as the Users list reads it.
    expect(shownCell("users", "role", "qa_lead")).toEqual({
      text: "Qa lead",
      title: "qa_lead",
    });
    expect(shownCell("users", "role", "Moderator").text).toBe("Moderator");
    expect(shownCell("users", "role", "Super Admin")).toEqual({
      text: "Super admin",
      title: "Super Admin",
    });
    expect(shownCell("platform_config", "value", "true").text).toBe("true");
    expect(shownCell("roles", "name", "moderator").text).toBe("moderator");
    expect(shownCell("users", "status_until", "not a date").text).toBe("—");
  });
});

describe("applyUsersSearch: the hand-off", () => {
  const search = (table: string, filters: Record<string, unknown>, success = true) => ({
    tool: "search",
    success,
    table: { table, columns: [], rows: [], filters: filters as Record<string, string> },
  });

  it("on Users, the last users search's validated filters; its row listed, earlier ones one line", () => {
    const out = applyUsersSearch("users", [
      search("users", { role: "free" }),
      search("roles", { text: "x" }),
      search("users", { role: "moderator", signed_in_within_days: 7 }),
    ]);
    expect(out.filters).toEqual({ role: "moderator", signed_in_within_days: 7 });
    expect(out.results.map((r) => r.listed ?? false)).toEqual([false, false, true]);
    // Round 1 (6): only the last drives the list; the earlier users search is a summary.
    expect(out.results.map((r) => r.earlier ?? false)).toEqual([true, false, false]);
  });

  it("round 1 (7): a refused users search hands nothing over and says the filters stayed", () => {
    const refused = { tool: "search", success: false, error: "invalid" };
    const sent = [{ tool: "search", input: { table: "users", status: "nope" } }];
    const kept = applyUsersSearch("users", [refused], sent, { role: "moderator" });
    expect(kept.filters).toBeNull();
    expect(kept.results[0]!.keptFilters).toBe("previous");
    // Round 2 (N-3): an earlier users search of the plan ran — the list shows its filters.
    const after = applyUsersSearch(
      "users",
      [search("users", { role: "free" }), refused],
      [{ tool: "search", input: { table: "users" } }, ...sent],
      { role: "moderator" }
    );
    expect(after.filters).toEqual({ role: "free" });
    expect(after.results.map((r) => [r.listed ?? false, r.keptFilters])).toEqual([
      [true, undefined],
      [false, "earlier"],
    ]);
    // No filters on the list: nothing to say.
    expect(applyUsersSearch("users", [refused], sent, {}).results[0]!.keptFilters).toBe(
      undefined
    );
    // Another table's refusal, or elsewhere: nothing.
    expect(
      applyUsersSearch(
        "users",
        [refused],
        [{ tool: "search", input: { table: "roles" } }],
        {
          role: "moderator",
        }
      ).results[0]!.keptFilters
    ).toBe(undefined);
    expect(
      applyUsersSearch("roles", [refused], sent, { role: "moderator" }).results[0]!
        .keptFilters
    ).toBe(undefined);
  });

  it("round 1 (1): changed filters dismiss the listed row, and the kept-filters note", () => {
    const listed = { tool: "search", success: true, listed: true };
    const other = { tool: "create_role", success: true, result: "Role created" };
    expect(afterFiltersChanged([listed])).toBeNull();
    expect(afterFiltersChanged([other, listed])).toEqual([other]);
    expect(
      afterFiltersChanged([{ tool: "search", success: false, keptFilters: "previous" }])
    ).toEqual([{ tool: "search", success: false, keptFilters: undefined }]);
    expect(afterFiltersChanged(null)).toBeNull();
  });

  it("elsewhere, a failed search or another table: nothing handed over", () => {
    expect(
      applyUsersSearch("roles", [search("users", { role: "x" })]).filters
    ).toBeNull();
    expect(
      applyUsersSearch("users", [search("users", { role: "x" }, false)]).filters
    ).toBeNull();
    expect(
      applyUsersSearch("users", [search("roles", { text: "x" })]).filters
    ).toBeNull();
  });

  it("only the users filters are handed over, never anything else in the response", () => {
    const out = applyUsersSearch("users", [
      search("users", { role: "free", email: "x@y", action: "z", text: { a: 1 } }),
    ]);
    expect(out.filters).toEqual({ role: "free" });
  });
});

describe("Show details: offered to admins and super-admins only", () => {
  it("the roles", () => {
    expect(DETAILS_ROLES).toEqual(["admin", "super_admin"]);
    expect(mayShowDetails("admin")).toBe(true);
    expect(mayShowDetails("super_admin")).toBe(true);
    for (const r of ["moderator", "free", "dev-bypass", "", "Admin", null, undefined])
      expect(mayShowDetails(r as string)).toBe(false);
  });

  const serveSession = (roleName: string, permissions: string[]) => {
    fetchMock.mockImplementation(async (url: string) => {
      const p = String(url).split("?")[0];
      if (p === "/api/admin/session") return json(200, { roleName, permissions });
      if (p === "/api/admin/users") return listAnswer(String(url));
      if (p === "/api/admin/approvals") return json(200, { approvals: [] });
      return json(200, {});
    });
  };

  it.each([
    ["super_admin", true],
    ["admin", true],
    ["moderator", false],
  ])("%s → toggle shown: %p", async (role, offered) => {
    serveSession(role, ["can_access_admin", "admin_manage_users"]);
    render(<AdminPage />);
    await screen.findByText("ann@example.com");
    await settle();
    const toggle = screen.queryByRole("button", { name: SHOW });
    if (!offered) {
      expect(toggle).toBeNull();
      expect(screen.queryByText(MOD_ID)).toBeNull();
      return;
    }
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByText(MOD_ID)).toBeNull();
    fireEvent.click(toggle!);
    expect(screen.getByRole("button", { name: HIDE })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByText(MOD_ID)).toBeDefined();
  });

  it("round 1 (5): only where it changes something — not on a section with no id table", async () => {
    serveSession("admin", ["can_access_admin", "admin_manage_users"]);
    render(<AdminPage />);
    await screen.findByText("ann@example.com");
    await settle();
    expect(screen.getByRole("button", { name: SHOW })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /Approvals/ }));
    await settle();
    expect(screen.queryByRole("button", { name: SHOW })).toBeNull();
  });
});

describe("the console, end to end: 'show moderators' on Users filters the one list", () => {
  it("plan → confirm → the list re-read with the validated filters; one line, no table", async () => {
    let executed: unknown;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const p = String(url).split("?")[0];
      if (p === "/api/admin/session")
        return json(200, {
          roleName: "admin",
          permissions: ["can_access_admin", "admin_manage_users"],
        });
      if (p === "/api/admin/users") return listAnswer(String(url));
      if (p === "/api/admin/ai")
        return json(200, {
          plan: {
            message: "Searching moderators.",
            // The planner's raw input: the page must not use it.
            actions: [
              { tool: "search", input: { table: "users", role: " MODERATOR  " } },
            ],
          },
        });
      if (p === "/api/admin/ai/execute") {
        executed = JSON.parse(String(init?.body));
        return json(200, {
          results: [
            {
              tool: "search",
              success: true,
              result: "1 row of users.",
              table: {
                table: "users",
                columns: ["id", "email", "role"],
                rows: [[MOD_ID, "mo@example.com", "Moderator"]],
                matched: 1,
                filters: { role: "moderator" },
              },
            },
          ],
        });
      }
      return json(200, {});
    });
    render(<AdminPage />);
    await screen.findByText("ann@example.com");
    const bar = screen.getAllByRole("textbox")[0]!;
    fireEvent.change(bar, { target: { value: "show moderators" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText("Searching moderators.")).toBeDefined();
    expect(screen.getByText("Search users where role is MODERATOR")).toBeDefined();
    // Round 1 (2): something typed in the panel's own box first — the hand-off clears it.
    const box = screen.getByRole("searchbox");
    fireEvent.change(box, { target: { value: "mo" } });
    fireEvent.submit(box.closest("form")!);
    await waitFor(() => expect(listReads().at(-1)!.get("q")).toBe("mo"));
    fireEvent.click(screen.getByRole("button", { name: /Confirm 1 action/ }));
    expect(
      await screen.findByText("The matching users are shown in the list below.")
    ).toBeDefined();
    await waitFor(() => expect(screen.getByRole("searchbox")).toHaveValue(""));
    expect(listReads().at(-1)!.get("q")).toBeNull();
    expect(executed).toBeDefined();
    await waitFor(() => expect(screen.queryByText("ann@example.com")).toBeNull());
    expect(screen.getByText("mo@example.com")).toBeDefined();
    // The validated filter, not the planner's " MODERATOR  ".
    expect(listReads().at(-1)!.get("role")).toBe("moderator");
    expect(
      screen.getByRole("button", { name: "Remove filter: Role: Moderator" })
    ).toBeDefined();
    expect(screen.queryByRole("table", { name: /Search results from users/ })).toBeNull();
    // Clear all: everyone again, and the search's row no longer stands (round 1, item 1).
    fireEvent.click(screen.getByRole("button", { name: u("filters_clear_all") }));
    expect(await screen.findByText("ann@example.com")).toBeDefined();
    expect(
      screen.queryByText("The matching users are shown in the list below.")
    ).toBeNull();
  });

  it("round 1 (1): removing the last chip dismisses the row too", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const p = String(url).split("?")[0];
      if (p === "/api/admin/session")
        return json(200, {
          roleName: "admin",
          permissions: ["can_access_admin", "admin_manage_users"],
        });
      if (p === "/api/admin/users") return listAnswer(String(url));
      if (p === "/api/admin/ai")
        return json(200, {
          plan: {
            message: "Searching moderators.",
            actions: [{ tool: "search", input: { table: "users", role: "moderator" } }],
          },
        });
      if (p === "/api/admin/ai/execute")
        return json(200, {
          results: [
            {
              tool: "search",
              success: true,
              table: {
                table: "users",
                columns: ["id", "email"],
                rows: [[MOD_ID, "mo@example.com"]],
                matched: 1,
                filters: { role: "moderator" },
              },
            },
          ],
        });
      return json(200, {});
    });
    render(<AdminPage />);
    await screen.findByText("ann@example.com");
    fireEvent.change(screen.getAllByRole("textbox")[0]!, {
      target: { value: "show moderators" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    fireEvent.click(await screen.findByRole("button", { name: /Confirm 1 action/ }));
    await screen.findByText("The matching users are shown in the list below.");
    fireEvent.click(
      screen.getByRole("button", { name: "Remove filter: Role: Moderator" })
    );
    expect(await screen.findByText("ann@example.com")).toBeDefined();
    expect(
      screen.queryByText("The matching users are shown in the list below.")
    ).toBeNull();
    // Round 2 (N-2): run it again, then search the panel's own box — the row is dismissed too,
    // and the search's filters stay on the list.
    fireEvent.change(screen.getAllByRole("textbox")[0]!, {
      target: { value: "show moderators" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    fireEvent.click(await screen.findByRole("button", { name: /Confirm 1 action/ }));
    await screen.findByText("The matching users are shown in the list below.");
    const box = screen.getByRole("searchbox");
    fireEvent.change(box, { target: { value: "mo" } });
    fireEvent.submit(box.closest("form")!);
    await waitFor(() => expect(listReads().at(-1)!.get("q")).toBe("mo"));
    expect(listReads().at(-1)!.get("role")).toBe("moderator");
    expect(
      screen.queryByText("The matching users are shown in the list below.")
    ).toBeNull();
  });
});
