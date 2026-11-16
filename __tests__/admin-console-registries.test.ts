/**
 * @jest-environment node
 */
/**
 * TASK-216 — the admin console's two registries, held to the server's own lists
 *
 * @guard a command-bar tool with no confirmation entry, an always-held action not marked
 * irreversible, a section with no view, or a map of sections that is not the registry's
 *
 *   confirmation registry   every tool the command bar can plan (ADMIN_TOOL_PERMISSIONS and the
 *                           client-routed approve/reject) has an entry — the type refuses a new
 *                           tool without one, and this test reads the lists again; every action
 *                           the server ALWAYS holds for a second administrator (an erasure) is
 *                           irreversible here; every entry's consequence is in the catalogue;
 *   section registry        one list. Each section has a view (or is one the console mounts
 *                           itself), a title in the catalogue, a group, an icon of its own; what
 *                           the command bar can do there is the server's own maps
 *                           (PANEL_TOOL_SCHEMAS, SECTION_SEARCH_TABLES) — no section of theirs
 *                           is missing from the registry; no other map of sections is left in
 *                           the page, the shell or the hints (their source is read).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ADMIN_TOOL_PERMISSIONS,
  CLIENT_ROUTED_TOOLS,
  PANEL_CONTEXT_PERMISSIONS,
  PANEL_TOOLS,
  SEARCHABLE_TABLES,
  toolPermission,
} from "@/app/api/admin/ai/tool-permissions";
import { ALWAYS_HELD_ACTIONS } from "@/app/api/admin/ai/command-bar";
import { PANEL_TOOL_SCHEMAS } from "@/app/api/admin/ai/tool-schemas";
import { SECTION_SEARCH_TABLES } from "@/app/api/admin/ai/search-scope";
import {
  CONFIRMATIONS,
  REASON_MIN,
  confirmationFor,
  graver,
} from "@/components/admin/ui/confirmation-registry";
import { reasonProblem } from "@/components/admin/ui/ConfirmStep";
import {
  SECTIONS,
  SECTION_GROUPS,
  commandBar,
  groupTitle,
  isSection,
  permittedSections,
  sectionEndpoint,
  sectionFromSearch,
  sectionHints,
  sectionTitle,
} from "@/components/admin/ui/sections";
import { SECTION_VIEWS } from "@/components/admin/section-views";
import { sectionScope } from "@/components/admin/section-hints";
import { renderMessage } from "@/platform/errors/messages";

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "r",
}));

const ROOT = join(__dirname, "..");
const TOOLS = [
  ...Object.keys(ADMIN_TOOL_PERMISSIONS),
  ...Object.keys(CLIENT_ROUTED_TOOLS),
];

/** The tools with no confirmation entry (the scan the first test runs). */
function unconfirmed(
  tools: readonly string[],
  registry: Readonly<Record<string, unknown>>
): string[] {
  return tools.filter((tool) => !Object.prototype.hasOwnProperty.call(registry, tool));
}

/** The always-held actions the registry does not mark irreversible. */
function heldNotIrreversible(
  held: Iterable<string>,
  registry: typeof CONFIRMATIONS
): string[] {
  return [...held].filter((tool) => registry[tool]?.risk !== "irreversible");
}

/** The sections a server map names that the registry does not hold. */
function unknownSections(ids: readonly string[]): string[] {
  return ids.filter((id) => !isSection(id));
}

describe("the confirmation registry", () => {
  it("every command-bar tool has an entry", () => {
    expect(TOOLS.length).toBeGreaterThan(15);
    expect(unconfirmed(TOOLS, CONFIRMATIONS)).toEqual([]);
  });

  it("[self-test] a tool without an entry is reported", () => {
    expect(unconfirmed([...TOOLS, "wipe_everything"], CONFIRMATIONS)).toEqual([
      "wipe_everything",
    ]);
  });

  it("every action the server always holds for a second administrator is irreversible here", () => {
    expect([...ALWAYS_HELD_ACTIONS].length).toBeGreaterThan(0);
    expect(heldNotIrreversible(ALWAYS_HELD_ACTIONS, CONFIRMATIONS)).toEqual([]);
  });

  it("[self-test] an always-held action marked as anything less is reported", () => {
    expect(
      heldNotIrreversible(["purge_user_data"], {
        ...CONFIRMATIONS,
        purge_user_data: { risk: "consequential", reason: "none" },
      })
    ).toEqual(["purge_user_data"]);
  });

  // SF-admin-010: only delete_role was marked; these got the same blue Confirm as a search.
  it("erasing an account, deleting a role and rejecting a held change cannot be undone; a search can", () => {
    for (const tool of ["purge_user_data", "delete_role", "reject_hold"])
      expect(confirmationFor(tool).risk).toBe("irreversible");
    for (const tool of ["suspend_agent", "block_user_feature", "set_capability_mapping"])
      expect(confirmationFor(tool).risk).toBe("consequential");
    expect(confirmationFor("search").risk).toBe("ordinary");
  });

  it("approving a held change is as grave as the change; reactivating an agent undoes a suspension", () => {
    expect(confirmationFor("approve_hold").risk).toBe("consequential");
    expect(confirmationFor("approve_hold", {}, "change_user_role").risk).toBe(
      "consequential"
    );
    const erasure = confirmationFor("approve_hold", {}, "purge_user_data");
    expect(erasure.risk).toBe("irreversible");
    expect(erasure.consequence).toBe("purge_user_data");
    expect(confirmationFor("suspend_agent", { reactivate: true }).risk).toBe("ordinary");
    expect(confirmationFor("suspend_agent", { reactivate: "true" }).risk).toBe(
      "consequential"
    );
  });

  it("[hostile] an unknown action, and a name of Object's own, are consequential — never ordinary", () => {
    for (const action of ["launch_missiles", "constructor", "toString", "__proto__", ""])
      expect(confirmationFor(action).risk).toBe("consequential");
    expect(graver("ordinary", "irreversible")).toBe("irreversible");
    expect(graver("consequential", "ordinary")).toBe("consequential");
  });

  it("every consequence is in the catalogue; an irreversible one says what is lost", () => {
    for (const [action, entry] of Object.entries(CONFIRMATIONS)) {
      if (entry.risk !== "ordinary")
        expect([action, entry.consequence]).not.toContain(undefined);
      if (!entry.consequence) continue;
      const key = `screens.admin_console.confirm.consequence.${entry.consequence}`;
      const text = renderMessage(key);
      expect(text).not.toBe(key);
      if (entry.risk === "irreversible")
        expect([action, text]).toEqual([action, expect.stringMatching(/^Lost/)]);
    }
  });

  it("one reason rule: none asks nothing; optional takes none; required and too short is said", () => {
    const rule = (reason: "none" | "optional" | "required") =>
      ({ risk: "consequential", reason }) as const;
    expect(reasonProblem(rule("none"), "")).toBeNull();
    expect(reasonProblem(rule("optional"), "   ")).toBeNull();
    expect(reasonProblem(rule("optional"), "ab")).not.toBeNull();
    expect(reasonProblem(rule("required"), "")).not.toBeNull();
    expect(reasonProblem(rule("required"), "  ab  ")).not.toBeNull();
    expect(reasonProblem(rule("required"), "abc")).toBeNull();
    // Counted in characters a person sees: three emoji are three.
    expect(reasonProblem(rule("required"), "👍👍👍")).toBeNull();
    expect(REASON_MIN).toBe(3);
  });
});

describe("the section registry", () => {
  const ids = SECTIONS.map((s) => s.id);

  it("each section once, in a known group, with a title in the catalogue and an icon of its own", () => {
    expect(new Set(ids).size).toBe(ids.length);
    for (const section of SECTIONS) {
      expect(SECTION_GROUPS).toContain(section.group);
      expect(sectionTitle(section.id)).not.toMatch(/^screens\./);
    }
    for (const group of SECTION_GROUPS)
      expect(groupTitle(group)).not.toMatch(/^screens\./);
    expect(new Set(SECTIONS.map((s) => s.icon)).size).toBe(SECTIONS.length);
    // No heading under two names: one title per section (SF-admin-057's source).
    expect(new Set(ids.map(sectionTitle)).size).toBe(ids.length);
  });

  it("each section's read is the registry's endpoint: one map, read the same way by the page and the guard", () => {
    // sectionEndpoint reads the literal map the awaited-requests guard reads; the registry's
    // `endpoint` is taken from the same map — never a second list.
    for (const section of SECTIONS)
      expect(sectionEndpoint(section.id)).toBe(section.endpoint);
    expect(
      SECTIONS.filter((s) => s.endpoint === null)
        .map((s) => s.id)
        .sort()
    ).toEqual(["dual-control", "kill-switch", "moderation", "users"]);
  });

  it("the sections are listed group by group, in the groups' order (the navigation's)", () => {
    const order = SECTIONS.map((s) => SECTION_GROUPS.indexOf(s.group));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("every section has a view, or is one the console mounts itself; no view is for no section", () => {
    expect(Object.keys(SECTION_VIEWS).sort()).toEqual([...ids].sort());
    const own = ids.filter((id) => SECTION_VIEWS[id] === null);
    expect(own.sort()).toEqual(["moderation", "users"]);
    // A section with an endpoint has a view to give its data to.
    for (const id of ids)
      if (sectionEndpoint(id) !== null)
        expect([id, SECTION_VIEWS[id]]).not.toContain(null);
  });

  it("no server map of sections names a section the registry does not hold", () => {
    expect(unknownSections(Object.keys(PANEL_TOOL_SCHEMAS))).toEqual([]);
    expect(unknownSections(Object.keys(SECTION_SEARCH_TABLES))).toEqual([]);
    expect(unknownSections(Object.keys(PANEL_CONTEXT_PERMISSIONS))).toEqual([]);
  });

  it("the client-safe list of each panel's tools is the server's schemas, panel by panel", () => {
    const schemas = Object.fromEntries(
      Object.entries(PANEL_TOOL_SCHEMAS).map(([panel, tools]) => [
        panel,
        tools.map((tool) => tool.name),
      ])
    );
    expect(PANEL_TOOLS).toEqual(schemas);
    expect(unknownSections(Object.keys(PANEL_TOOLS))).toEqual([]);
  });

  it("[self-test] a server map's section missing from the registry is reported", () => {
    expect(unknownSections(["roles", "billing"])).toEqual(["billing"]);
  });

  it("what the command bar can do on a section is the server's own maps — and nothing where they have none", () => {
    for (const id of ids) {
      const tools = (PANEL_TOOL_SCHEMAS[id] ?? []).map((tool) => tool.name);
      const tables = SECTION_SEARCH_TABLES[id] ?? [];
      const scope = commandBar(id);
      if (tools.length + tables.length === 0) expect([id, scope]).toEqual([id, null]);
      else expect([id, scope]).toEqual([id, { tools, tables }]);
    }
    // SF-admin-020: these had a command bar that could do nothing there.
    for (const id of [
      "tenant",
      "tenants",
      "jobs",
      "erasures",
      "kill-switch",
      "moderation",
    ] as const)
      expect(commandBar(id)).toBeNull();
    // A section where it only searches says so; one with actions names them, never by tool id.
    expect(sectionScope("dual-control", () => true)).toBe(
      "Here the command bar only searches: settings. It changes nothing on this screen."
    );
    const roles = sectionScope("roles", () => true)!;
    expect(roles).toContain("Create a role");
    expect(roles).not.toMatch(/create_role|role_permissions/);
    // Only what the admin may run is offered; with nothing left, that is said.
    expect(sectionScope("roles", (code) => code === "can_access_admin")).toBe(
      renderMessage("screens.admin_console.hints.scope_none")
    );
    expect(sectionScope("jobs", () => true)).toBeNull();
    expect(sectionScope("nope", () => true)).toBeNull();
  });

  it("every example names a real tool the section has (or a search of one of its tables)", () => {
    for (const id of ids)
      for (const hint of sectionHints(id)) {
        expect(toolPermission(hint.tool)).toBeDefined();
        const scope = commandBar(id)!;
        if (hint.tool === "search") {
          expect(Object.keys(SEARCHABLE_TABLES)).toContain(hint.table);
          expect(scope.tables).toContain(hint.table);
        } else expect(scope.tools).toContain(hint.tool);
        expect(renderMessage(`screens.admin_console.hints.${hint.key}`)).not.toMatch(
          // An example teaches words a person types, never a permission's code (SF-admin-017).
          /^screens\.|\b(?:can|admin|config)_[a-z_]+\b/
        );
      }
  });

  it("the address names a section only when it is one; permitted sections keep the registry's order", () => {
    expect(sectionFromSearch("?section=audit")).toBe("audit");
    expect(sectionFromSearch("?x=1&section=kill-switch")).toBe("kill-switch");
    for (const search of [
      "",
      "?section=",
      "?section=nope",
      "?section=constructor",
      "?section=Users",
    ])
      expect(sectionFromSearch(search)).toBeNull();
    expect(permittedSections(() => true)).toEqual(ids);
    expect(permittedSections(() => false)).toEqual([]);
  });

  it("no other map of sections is left: the shell, the page, the console and the hints read the registry", () => {
    const read = (file: string) => readFileSync(join(ROOT, file), "utf8");
    for (const file of [
      "app/admin/page.tsx",
      "components/admin/AdminShell.tsx",
      "components/admin/SectionConsole.tsx",
      "components/admin/section-hints.ts",
    ]) {
      const source = read(file);
      // The maps that drifted (SECOND-WAVE-STATUS S7, "One section registry").
      expect([
        file,
        /\b(?:NAV_ITEMS|ENDPOINTS|DATA_VIEWS|NO_PROMPT_BAR|SECTION_HINTS)\b/.test(source),
      ]).toEqual([file, false]);
      // No section's endpoint written outside the registry.
      expect([
        file,
        /["'`]\/api\/(?:admin|operator)\/(?:roles|entitlements|audit|tenant|tenants|jobs|capabilities|erasures)\b/.test(
          source
        ),
      ]).toEqual([file, false]);
    }
    expect(read("components/admin/AdminShell.tsx")).toContain(
      "@/components/admin/ui/sections"
    );
    expect(read("components/admin/SectionConsole.tsx")).toContain("SECTION_VIEWS");
  });
});
