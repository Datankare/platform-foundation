/**
 * __tests__/admin-authorization-matrix.test.ts — Every admin path maps to a real permission
 *
 * Adversarial Validation (CONTRIBUTING.md) practices 2 and 8, made mechanical:
 *
 *   1. Every permission the code requires exists in the catalog the migrations create, and some
 *      real role holds it. (Three did not exist: no one could use those pages — migration 041.)
 *   2. Every command-bar tool the planner can offer has a permission, and every action the
 *      execute route runs requires the same permission as the admin page for the same change
 *      — the second path is held to the first path's rule (TASK-145, audit X-1).
 *   3. Guards name their permission as a literal or a same-file constant, so this test can read
 *      it; a computed permission is listed here with the test that covers it.
 *
 * The catalog comes from scripts/role-catalog.cjs, which the migration replay checks against a
 * real database.
 */

import { PERMISSION_CATALOG, ROLE_PERMISSIONS } from "./helpers/test-identities";
import { apiRoutes, read } from "./helpers/route-policy";
import {
  ADMIN_TOOL_PERMISSIONS,
  CLIENT_ROUTED_TOOLS,
  PANEL_CONTEXT_PERMISSIONS,
  SEARCHABLE_TABLES,
  USER_ROW_ACTION_PERMISSIONS,
  USER_ROW_ACTION_ROUTES,
  toolPermission,
} from "@/app/api/admin/ai/tool-permissions";
import { PANEL_TOOL_SCHEMAS, SHARED_TOOLS } from "@/app/api/admin/ai/tool-schemas";
import { tierPermission } from "@/platform/admin/governed-config";

const GUARD =
  /\b(adminGuard|requireAdmin)\(\s*request\s*,\s*("([a-z_]+)"|([A-Za-z_]\w*))/g;

/**
 * Guards whose permission is computed, and the test that covers each. None today:
 * config-ai/execute guards with "config_view" before reading the body, then checks the tool's
 * own permission with holds() (covered by platform/admin/__tests__/config-routes.test.ts).
 */
const COMPUTED: Readonly<Record<string, string>> = {};

interface Guard {
  readonly route: string;
  readonly permission: string;
}

function guardsIn(route: string): { guards: Guard[]; unresolved: string[] } {
  const src = read(route);
  const guards: Guard[] = [];
  const unresolved: string[] = [];
  for (const m of src.matchAll(GUARD)) {
    if (m[3]) {
      guards.push({ route, permission: m[3] });
      continue;
    }
    const constant = src.match(new RegExp(`const\\s+${m[4]}\\s*=\\s*"([a-z_]+)"`));
    if (constant) guards.push({ route, permission: constant[1] });
    else unresolved.push(m[4]);
  }
  return { guards, unresolved };
}

const ROUTES = apiRoutes();
const GUARDS = ROUTES.flatMap((r) => guardsIn(r).guards);
const HELD = new Set(Object.values(ROLE_PERMISSIONS).flat());

/** Every permission the code requires, with where. */
const REQUIRED: [string, string][] = [
  ...GUARDS.map((g) => [g.permission, g.route] as [string, string]),
  ...Object.entries(ADMIN_TOOL_PERMISSIONS).map(
    ([tool, p]) => [p, `command-bar action ${tool}`] as [string, string]
  ),
  ...Object.entries(CLIENT_ROUTED_TOOLS).map(
    ([tool, p]) => [p, `command-bar tool ${tool}`] as [string, string]
  ),
  ...Object.entries(SEARCHABLE_TABLES).map(
    ([table, p]) => [p, `command-bar search of ${table}`] as [string, string]
  ),
  ...Object.entries(USER_ROW_ACTION_PERMISSIONS).map(
    ([action, p]) => [p, `Users screen action ${action}`] as [string, string]
  ),
  ...Object.entries(PANEL_CONTEXT_PERMISSIONS).map(
    ([panel, p]) => [p, `planner context for ${panel}`] as [string, string]
  ),
  [tierPermission("standard"), "governed config write, standard tier"],
  [tierPermission("safety"), "governed config write, safety tier"],
];

describe("admin authorization matrix", () => {
  it("finds the admin guards (self-test)", () => {
    expect(GUARDS.length).toBeGreaterThan(20);
    expect(PERMISSION_CATALOG.length).toBeGreaterThan(10);
  });

  it("resolves every guard's permission, or lists why it is computed", () => {
    const unresolved = ROUTES.flatMap((r) =>
      guardsIn(r).unresolved.map((name) => `${r}: ${name}`)
    ).filter((entry) => !COMPUTED[entry.split(":")[0]]);
    expect(unresolved).toEqual([]);
  });

  it("lists no computed guard that does not exist", () => {
    for (const route of Object.keys(COMPUTED)) {
      expect(ROUTES).toContain(route);
      expect(guardsIn(route).unresolved.length).toBeGreaterThan(0);
    }
  });

  it("requires only permissions the migrations create", () => {
    const missing = REQUIRED.filter(([p]) => !PERMISSION_CATALOG.includes(p)).map(
      ([p, where]) => `${p} (${where})`
    );
    expect(missing).toEqual([]);
  });

  it("requires only permissions some real role holds", () => {
    const orphaned = REQUIRED.filter(([p]) => !HELD.has(p)).map(
      ([p, where]) => `${p} (${where})`
    );
    expect(orphaned).toEqual([]);
  });

  it("gives every tool the planner can offer a permission", () => {
    const offered = [...SHARED_TOOLS, ...Object.values(PANEL_TOOL_SCHEMAS).flat()].map(
      (t) => t.name
    );
    expect(offered.filter((name) => toolPermission(name) === undefined)).toEqual([]);
  });

  it("offers no tool that nothing runs", () => {
    const offered = new Set(
      [...SHARED_TOOLS, ...Object.values(PANEL_TOOL_SCHEMAS).flat()].map((t) => t.name)
    );
    const runnable = new Set([
      ...Object.keys(ADMIN_TOOL_PERMISSIONS),
      ...Object.keys(CLIENT_ROUTED_TOOLS),
    ]);
    expect([...offered].filter((t) => !runnable.has(t))).toEqual([]);
  });

  it("runs every execute-route handler under a mapped permission", () => {
    // The execute route runs the command bar's handler table (command-bar.ts, audit X-10).
    expect(read("app/api/admin/ai/execute/route.ts")).toContain("runCommandBarAction");
    const src = read("app/api/admin/ai/command-bar.ts");
    const table = src.slice(
      src.indexOf("export const COMMAND_BAR_HANDLERS"),
      src.indexOf("};", src.indexOf("export const COMMAND_BAR_HANDLERS"))
    );
    const handled = [...table.matchAll(/^\s+([a-z_]+):/gm)].map((m) => m[1]);
    expect(handled.length).toBeGreaterThan(10);
    expect(handled.sort()).toEqual(Object.keys(ADMIN_TOOL_PERMISSIONS).sort());
  });

  // The command bar is a second path to each page's change: same permission as the page.
  const TOOL_PAGES: Readonly<Record<string, string>> = {
    create_role: "app/api/admin/roles/route.ts",
    delete_role: "app/api/admin/roles/route.ts",
    duplicate_role: "app/api/admin/roles/route.ts",
    assign_permissions: "app/api/admin/roles/route.ts",
    change_user_role: "app/api/admin/users/route.ts",
    create_entitlement_group: "app/api/admin/entitlements/route.ts",
    set_entitlement_group_active: "app/api/admin/entitlements/route.ts",
    update_password_policy: "app/api/admin/password-policy/route.ts",
    register_agent: "app/api/admin/agent-registry/route.ts",
    suspend_agent: "app/api/admin/agent-registry/route.ts",
    set_agent_scope: "app/api/admin/agent-registry/route.ts",
    set_agent_ttl: "app/api/admin/agent-registry/route.ts",
    block_user_feature: "app/api/admin/per-account/route.ts",
    unblock_user_feature: "app/api/admin/per-account/route.ts",
    set_approval_policy: "app/api/admin/approval-policy/route.ts",
    set_capability_mapping: "app/api/admin/capability-mapping/route.ts",
    search: "app/api/admin/ai/execute/route.ts",
  };

  it("maps every command-bar action to its admin page", () => {
    expect(Object.keys(TOOL_PAGES).sort()).toEqual(
      Object.keys(ADMIN_TOOL_PERMISSIONS).sort()
    );
  });

  it.each(Object.entries(TOOL_PAGES))(
    "%s requires the permission its page requires",
    (tool, page) => {
      const pagePermissions = new Set(guardsIn(page).guards.map((g) => g.permission));
      expect(pagePermissions).toContain(
        ADMIN_TOOL_PERMISSIONS[tool as keyof typeof ADMIN_TOOL_PERMISSIONS]
      );
    }
  );

  // TASK-185: the Users screen shows an action only with the permission its route requires —
  // the same map, so a screen that hides an action and a route that refuses it agree.
  it.each(Object.entries(USER_ROW_ACTION_ROUTES))(
    "Users screen action %s requires the permission its route requires",
    (action, route) => {
      const routePermissions = new Set(guardsIn(route).guards.map((g) => g.permission));
      expect(routePermissions).toContain(
        USER_ROW_ACTION_PERMISSIONS[action as keyof typeof USER_ROW_ACTION_PERMISSIONS]
      );
    }
  );
});
