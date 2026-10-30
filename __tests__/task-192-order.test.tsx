/**
 * @jest-environment jsdom
 */
/**
 * TASK-192 — the order of roles and permissions, the Roles screen's dates, and the kept-filters
 * wording when a refused users search comes before a successful one.
 *
 * On Postgres (the migration's values, the routes' and the search's orders, a new role's place):
 * __tests__/db/task-192-catalog-order.db.test.ts.
 */

import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import {
  NEW_ROLE_SORT_ORDER,
  PERMISSION_CATEGORY_ORDER,
  SEEDED_ROLE_SORT_ORDER,
  compareCategories,
  compareNames,
  compareRoles,
  normalCategory,
  comparePermissions,
  groupPermissions,
  roleSortOrder,
} from "@/platform/auth/catalog-order";
import { fullTimestamp, permissionCategoryLabel } from "@/components/admin/admin-format";
import { AuditDataView, RolesDataView } from "@/components/admin/AdminDataViews";
import { applyUsersSearch } from "@/components/admin/users-search-handoff";
import ExecutionResultsPanel from "@/components/admin/ExecutionResultsPanel";
import { SEARCH_SQL, searchParams } from "@/app/api/admin/ai/handlers/search";

const perm = (code: string, displayName: string, category: string) => ({
  code,
  displayName,
  category,
});

describe("catalog-order: the roles", () => {
  it("staff first, then the plans smallest to largest, with gaps; the rest after", () => {
    const names = Object.entries(SEEDED_ROLE_SORT_ORDER)
      .sort(([, x], [, y]) => x - y)
      .map(([n]) => n);
    expect(names).toEqual([
      "super_admin",
      "admin",
      "moderator",
      "safety_approver",
      "guest",
      "free",
      "daily",
      "monthly",
      "annual",
      "lifetime",
    ]);
    const values = Object.values(SEEDED_ROLE_SORT_ORDER);
    expect(new Set(values).size).toBe(values.length);
    for (const v of values) expect(v % 10).toBe(0);
    expect(NEW_ROLE_SORT_ORDER).toBeGreaterThan(Math.max(...values));
  });

  it("roleSortOrder: a seeded role's value; any other role, and inherited names, the rest's", () => {
    expect(roleSortOrder("super_admin")).toBe(10);
    expect(roleSortOrder("lifetime")).toBe(100);
    expect(roleSortOrder("tester")).toBe(NEW_ROLE_SORT_ORDER);
    expect(roleSortOrder("constructor")).toBe(NEW_ROLE_SORT_ORDER);
    expect(roleSortOrder("toString")).toBe(NEW_ROLE_SORT_ORDER);
    expect(roleSortOrder("")).toBe(NEW_ROLE_SORT_ORDER);
  });
});

describe("catalog-order: a role's permissions", () => {
  it("categories in the defined order, any other after them alphabetically", () => {
    const shuffled = [
      "zeta",
      "privacy",
      "gameplay",
      "Alpha",
      "admin",
      "social",
      "moderation",
      "profile",
    ];
    expect([...shuffled].sort(compareCategories)).toEqual([
      ...PERMISSION_CATEGORY_ORDER,
      "Alpha",
      "zeta",
    ]);
  });

  it("a category in another case is the same category (round 1)", () => {
    expect(compareCategories("Admin", "admin")).toBe(0);
    expect(compareCategories(" ADMIN ", "moderation")).toBeLessThan(0);
    const groups = groupPermissions([
      perm("b", "B", "Admin"),
      perm("a", "A", "admin"),
      perm("c", "C", "Data_Export"),
      perm("d", "D", "data_export"),
    ]);
    expect(groups.map((g) => [g.category, g.permissions.map((p) => p.code)])).toEqual([
      ["admin", ["a", "b"]],
      ["data_export", ["c", "d"]],
    ]);
    expect(permissionCategoryLabel("Admin")).toBe("Administration");
    expect(permissionCategoryLabel("Data_Export")).toBe("Data export");
    // Round 2: the common whitespace is trimmed, as SQL's btrim(…, E' \t\n\r\f\x0B') does.
    expect(normalCategory("admin\t")).toBe("admin");
    expect(normalCategory("\x0b\f Admin\r\n")).toBe("admin");
    expect(normalCategory("privacy")).toBe("privacy");
    expect(compareCategories("admin\t", "admin")).toBe(0);
    expect(permissionCategoryLabel("admin\t")).toBe("Administration");
  });

  it('names: case-insensitively, then exactly, by code point — as the database\'s collate "C"', () => {
    const names = ["b", "a_b", "AB", "ab", "Ab", "a", "A", "é", "z"];
    expect([...names].sort(compareNames)).toEqual([
      "A",
      "a",
      "a_b",
      "AB",
      "Ab",
      "ab",
      "b",
      "z",
      "é",
    ]);
    // Round 2: by code point, not UTF-16 code unit — "😀" (U+1F600) after "～" (U+FF5E).
    expect(["😀", "～", "z"].sort(compareNames)).toEqual(["z", "～", "😀"]);
    expect(compareNames("a😀", "a😀b")).toBeLessThan(0);
    expect(compareNames("x", "x")).toBe(0);
    expect(
      [
        { name: "zeta", sortOrder: 1000 },
        { name: "Beta", sortOrder: 1000 },
        { name: "alpha", sortOrder: 1000 },
        { name: "free", sortOrder: 60 },
      ]
        .sort(compareRoles)
        .map((r) => r.name)
    ).toEqual(["free", "alpha", "Beta", "zeta"]);
  });

  it("by category, then display name (any case), then code — a total order", () => {
    const list = [
      perm("can_translate", "Can Translate", "gameplay"),
      perm("admin_view_audit", "View Audit Log", "admin"),
      perm("x_b", "same name", "custom"),
      perm("can_play", "can play", "gameplay"),
      perm("admin_manage_users", "Manage Users", "admin"),
      perm("x_a", "Same Name", "custom"),
      perm("can_moderate", "Can Moderate", "moderation"),
    ];
    expect([...list].sort(comparePermissions).map((p) => p.code)).toEqual([
      "admin_manage_users",
      "admin_view_audit",
      "can_moderate",
      "can_play",
      "can_translate",
      "x_a",
      "x_b",
    ]);
    // The same answer whatever order they came in.
    expect([...list].reverse().sort(comparePermissions)).toEqual(
      [...list].sort(comparePermissions)
    );
  });

  it("groupPermissions: one group per category, in order; nothing in, nothing out", () => {
    const groups = groupPermissions([
      perm("can_export_data", "Can Export Data", "privacy"),
      perm("can_play", "Can Play", "gameplay"),
      perm("can_delete_account", "Can Delete Account", "privacy"),
      perm("admin_manage_roles", "Manage Roles", "admin"),
    ]);
    expect(groups.map((g) => [g.category, g.permissions.map((p) => p.code)])).toEqual([
      ["admin", ["admin_manage_roles"]],
      ["gameplay", ["can_play"]],
      ["privacy", ["can_delete_account", "can_export_data"]],
    ]);
    expect(groupPermissions([])).toEqual([]);
  });

  it("a category's heading: the catalog's name, else the stored one made readable", () => {
    expect(permissionCategoryLabel("admin")).toBe("Administration");
    expect(permissionCategoryLabel("moderation")).toBe("Moderation");
    expect(PERMISSION_CATEGORY_ORDER.map(permissionCategoryLabel)).toEqual([
      "Administration",
      "Moderation",
      "Gameplay",
      "Social",
      "Profile",
      "Privacy",
    ]);
    expect(permissionCategoryLabel("data_export")).toBe("Data export");
    expect(permissionCategoryLabel("<b>x</b>")).toBe("<b>x</b>");
    expect(permissionCategoryLabel("  ")).toBe("—");
  });
});

describe("the Roles screen", () => {
  const role = {
    id: "r1",
    name: "moderator",
    displayName: "Moderator",
    permissionCount: 5,
    // As a database might return them: in no order.
    permissions: [
      perm("can_play", "Can Play", "gameplay"),
      perm("can_moderate", "Can Moderate", "moderation"),
      perm("zz_custom", "Custom thing", "zzz_custom"),
      perm("can_access_admin", "Can Access Admin", "admin"),
      perm("admin_view_audit", "View Audit Log", "admin"),
    ],
    createdAt: "2026-10-29T09:15:00Z",
    updatedAt: "2026-03-31T23:30:05Z",
  };

  it("dates as '29 Oct 2026' with the whole UTC timestamp in the tooltip", () => {
    render(<RolesDataView data={{ roles: [role] }} />);
    const created = screen.getByText("29 Oct 2026");
    expect(created.getAttribute("title")).toBe(fullTimestamp(role.createdAt));
    expect(created.getAttribute("title")).toMatch(/29 Oct 2026, 09:15:00 UTC/);
    expect(created.getAttribute("dateTime")).toBe(role.createdAt);
    // No M/D/YYYY anywhere.
    expect(document.body.textContent).not.toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/);
  });

  it("expanded: permissions grouped under their category headings, in order, by name", () => {
    render(<RolesDataView data={{ roles: [role] }} />);
    fireEvent.click(screen.getByText("Moderator"));
    const headings = screen
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent);
    expect(headings).toEqual(["Administration", "Moderation", "Gameplay", "Zzz custom"]);
    const admin = screen.getByRole("region", { name: "Administration" });
    expect(
      within(admin)
        .getAllByText(/^(can_|admin_)/)
        .map((n) => n.textContent)
    ).toEqual(["can_access_admin", "admin_view_audit"]);
    // The expanded dates: with the time, the tooltip in UTC; no M/D/YYYY.
    const line = screen.getByText(/^Created:/).closest("div")!;
    const times = line.querySelectorAll("time");
    expect(times).toHaveLength(2);
    expect(times[0]!.textContent).toMatch(/^29 Oct 2026, \d{2}:\d{2}$/);
    expect(times[1]!.getAttribute("title")).toMatch(/31 Mar 2026, 23:30:05 UTC/);
    expect(document.body.textContent).not.toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/);
  });

  it("the expansion is a disclosure button: focusable, named, aria-expanded and aria-controls", () => {
    render(<RolesDataView data={{ roles: [role] }} />);
    const button = screen.getByRole("button", { name: "5 permissions of Moderator" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("aria-controls")).toBeNull();
    button.focus();
    expect(document.activeElement).toBe(button);
    // Enter or Space on a focused <button> is its click (the browser's; jsdom has no key action).
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const controlled = document.getElementById(button.getAttribute("aria-controls")!);
    expect(controlled).not.toBeNull();
    expect(within(controlled!).getByText("can_moderate")).toBeDefined();
    // One toggle, not two: the row's own click does not also fire.
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(4);
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("can_moderate")).toBeNull();
    // Each group is a region named by its own heading — no two regions share a name.
    fireEvent.click(button);
    const regions = screen.getAllByRole("region");
    expect(regions.length).toBeGreaterThan(0);
    for (const r of regions) {
      const heading = document.getElementById(r.getAttribute("aria-labelledby")!);
      expect(heading?.tagName).toBe("H3");
      expect(r.contains(heading)).toBe(true);
    }
    expect(new Set(regions.map((r) => r.getAttribute("aria-labelledby"))).size).toBe(4);
    expect(regions.every((r) => r.getAttribute("aria-label") === null)).toBe(true);
  });

  it("one permission: the singular", () => {
    render(<RolesDataView data={{ roles: [{ ...role, permissionCount: 1 }] }} />);
    expect(
      screen.getByRole("button", { name: "1 permission of Moderator" })
    ).toBeDefined();
  });

  it("no date, or one that cannot be read: a dash", () => {
    render(
      <RolesDataView
        data={{
          roles: [{ ...role, permissions: [], createdAt: null, updatedAt: "nonsense" }],
        }}
      />
    );
    fireEvent.click(screen.getByText("Moderator"));
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByRole("heading", { level: 3 })).toBeNull();
    expect(screen.getByText("No permissions assigned.")).toBeDefined();
  });

  it("the roles in the order the server gave them", () => {
    const names = ["super_admin", "admin", "guest", "free", "tester"];
    render(
      <RolesDataView
        data={{
          roles: names.map((n, i) => ({ ...role, id: `r${i}`, name: n, displayName: n })),
        }}
      />
    );
    expect(screen.getAllByRole("code").map((c) => c.textContent)).toEqual(names);
  });

  it("the Audit log's time in the same format", () => {
    render(
      <AuditDataView
        data={{
          entries: [
            {
              id: "e1",
              createdAt: "2026-10-29T09:15:00Z",
              action: "role_changed",
              details: "",
            },
          ],
        }}
      />
    );
    const time = document.querySelector("time")!;
    expect(time.textContent).toMatch(/^29 Oct 2026, \d{2}:\d{2}$/);
    expect(time.getAttribute("title")).toMatch(/UTC$/);
  });
});

describe("the command bar's search: the screens' order", () => {
  it("roles by sort_order then name; role permissions by role, then category, then name", () => {
    expect(SEARCH_SQL.roles).toMatch(
      /order by sort_order, lower\(name\) collate "C", name collate "C", id limit/
    );
    expect(SEARCH_SQL.role_permissions).toMatch(
      /order by r\.sort_order, lower\(r\.name\) collate "C", r\.name collate "C", coalesce\(array_position\(\$2::text\[\], lower\(btrim\(p\.category, E' \\t\\n\\r\\f\\x0B'\)\)\)/
    );
    expect(searchParams("role_permissions", { text: "a%b" })).toEqual([
      "a\\%b",
      [...PERMISSION_CATEGORY_ORDER],
    ]);
    // Permissions as the Roles screen orders them (round 1): category, display name, code.
    expect(SEARCH_SQL.permissions).toMatch(
      /order by coalesce\(array_position\(\$2::text\[\], lower\(btrim\(category, E' \\t\\n\\r\\f\\x0B'\)\)\)/
    );
    expect(searchParams("permissions", { text: "x" })).toEqual([
      "x",
      [...PERMISSION_CATEGORY_ORDER],
    ]);
    // Names compare by code unit in every statement, never by the database's collation.
    expect(SEARCH_SQL.roles).toContain('lower(name) collate "C", name collate "C"');
    // Bound, never in the text.
    for (const c of PERMISSION_CATEGORY_ORDER)
      expect(SEARCH_SQL.role_permissions).not.toContain(`'${c}'`);
  });
});

describe("TASK-192 (4): a refused users search before a successful one", () => {
  const refused = {
    tool: "search",
    success: false,
    error: "The value of status is not valid.",
  };
  const ok = (filters: Record<string, unknown>) => ({
    tool: "search",
    success: true,
    result: "1 user matched",
    table: {
      table: "users",
      columns: [],
      rows: [],
      filters: filters as Record<string, string>,
    },
  });
  const sentUsers = { tool: "search", input: { table: "users" } };

  it("refused, then succeeded: the refused row says nothing about filters", () => {
    const out = applyUsersSearch(
      "users",
      [refused, ok({ role: "free" })],
      [sentUsers, sentUsers],
      { role: "moderator" }
    );
    expect(out.filters).toEqual({ role: "free" });
    expect(out.results.map((r) => [r.listed ?? false, r.keptFilters])).toEqual([
      [false, undefined],
      [true, undefined],
    ]);
  });

  it("between two that succeeded: the list shows the later one's — nothing on the refused row", () => {
    const out = applyUsersSearch(
      "users",
      [ok({ role: "admin" }), refused, ok({ status: "active" })],
      [sentUsers, sentUsers, sentUsers]
    );
    expect(out.filters).toEqual({ status: "active" });
    expect(
      out.results.map((r) => [r.listed ?? false, r.earlier ?? false, r.keptFilters])
    ).toEqual([
      [false, true, undefined],
      [false, false, undefined],
      [true, false, undefined],
    ]);
  });

  it("after the last that succeeded: still 'the earlier search'", () => {
    const out = applyUsersSearch(
      "users",
      [ok({ role: "admin" }), refused],
      [sentUsers, sentUsers]
    );
    expect(out.results[1]!.keptFilters).toBe("earlier");
  });

  it("on screen, the reverse order reads as two true rows", () => {
    const { results } = applyUsersSearch(
      "users",
      [refused, ok({ role: "free" })],
      [sentUsers, sentUsers],
      { role: "moderator" }
    );
    render(<ExecutionResultsPanel results={results} onDismiss={jest.fn()} />);
    expect(screen.getByText("The value of status is not valid.")).toBeDefined();
    expect(screen.queryByText(/earlier search/)).toBeNull();
    expect(screen.queryByText(/previous filters/)).toBeNull();
    expect(screen.getByText(/shown in the list below/)).toBeDefined();
  });
});
