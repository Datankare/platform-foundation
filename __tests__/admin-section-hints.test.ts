/**
 * TASK-185 — the command bar's example commands (components/admin/section-hints.ts): offered only
 * to an admin whose permissions let the executor run them, from the server's own map; a section
 * with none left shows the generic prompt. Every section heading has a proper title from one
 * source (AdminShell sectionTitle).
 */
import {
  allSectionHints,
  hintPermissions,
  permittedHints,
  sectionPlaceholder,
} from "@/components/admin/section-hints";
import { permittedSections, sectionTitle } from "@/components/admin/AdminShell";
import type { AdminSection } from "@/components/admin/AdminShell";
import { SEARCHABLE_TABLES, toolPermission } from "@/app/api/admin/ai/tool-permissions";
import { renderMessage } from "@/platform/errors/messages";
import { ROLE_PERMISSIONS } from "./helpers/test-identities";

const GENERIC = renderMessage("screens.admin_console.hints.generic");
const holds = (granted: readonly string[]) => (c: string) => granted.includes(c);
const ALL_SECTIONS = permittedSections(() => true);

type Hint = ReturnType<typeof allSectionHints>[string][number];
const EXAMPLES: [string, Hint][] = Object.entries(allSectionHints()).flatMap(
  ([section, hints]) => hints.map((h): [string, Hint] => [section, h])
);

describe("each example names a real command and a real catalog string", () => {
  it.each(EXAMPLES)("%s: %p", (_section, hint) => {
    expect(toolPermission(hint.tool)).toBeDefined();
    if (hint.tool === "search")
      expect(hint.table ? SEARCHABLE_TABLES[hint.table] : undefined).toBeTruthy();
    const key = `screens.admin_console.hints.${hint.key}`;
    expect(renderMessage(key)).not.toBe(key);
  });
});

describe("only commands the role can run", () => {
  it.each(Object.keys(ROLE_PERMISSIONS))(
    "%s: every example offered in every section it can open is one its permissions run",
    (role) => {
      const granted = ROLE_PERMISSIONS[role]!;
      for (const section of permittedSections(holds(granted)))
        for (const key of permittedHints(section, holds(granted))) {
          const hint = allSectionHints()[section]!.find((h) => h.key === key)!;
          for (const p of hintPermissions(hint)) expect(granted).toContain(p);
        }
    }
  );

  it("the moderator (the live staff account): no example anywhere it can go — the generic prompt", () => {
    const moderator = holds(ROLE_PERMISSIONS.moderator!);
    for (const section of permittedSections(moderator)) {
      expect(permittedHints(section, moderator)).toEqual([]);
      expect(sectionPlaceholder(section, moderator)).toBe(GENERIC);
    }
  });

  it("a search example needs the table's permission AND the command bar's", () => {
    // Roles without can_access_admin: the create example only; with it, both.
    expect(permittedHints("roles", holds(["admin_manage_roles"]))).toEqual([
      "roles_create",
    ]);
    expect(
      permittedHints("roles", holds(["admin_manage_roles", "can_access_admin"]))
    ).toEqual(["roles_create", "roles_show"]);
    expect(permittedHints("audit", holds(["can_access_admin"]))).toEqual([]);
  });

  it("Users examples need admin_manage_users and can_access_admin: both offered with them, none with the command bar alone", () => {
    const viewer = holds(["can_access_admin", "admin_manage_users"]);
    expect(permittedHints("users", viewer)).toEqual(["users_show", "users_change_role"]);
    const searchOnly = (c: string) => c === "can_access_admin";
    expect(permittedHints("users", searchOnly)).toEqual([]);
  });

  it("the placeholder joins one or two examples; none is the generic prompt", () => {
    const all = () => true;
    expect(sectionPlaceholder("users", all)).toMatch(/^Try: “Show all users” or “Change/);
    expect(sectionPlaceholder("audit", all)).toBe(
      "Try: “Show role changes from the last 7 days”"
    );
    expect(sectionPlaceholder("approvals", all)).toBe(GENERIC);
    expect(sectionPlaceholder("no-such-section", all)).toBe(GENERIC);
    expect(sectionPlaceholder("users", () => false)).toBe(GENERIC);
  });
});

describe("section titles: one source, every section", () => {
  it.each(ALL_SECTIONS)("%s has a proper title (capitalised, not its id)", (section) => {
    const title = sectionTitle(section as AdminSection);
    expect(title).not.toBe(section);
    expect(title).toMatch(/^[A-Z]/);
  });

  it("Approvals reads Approvals", () => {
    expect(sectionTitle("approvals")).toBe("Approvals");
  });
});
