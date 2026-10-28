/**
 * components/admin/section-hints.ts — The command bar's example commands, per section, offered
 * only to an admin who can run them (TASK-185)
 *
 * Each example names the command-bar tool it would run (and, for a search, the table it reads).
 * Its permission is the server's own: toolPermission (app/api/admin/ai/tool-permissions.ts, the
 * map the executor checks) and, for a search, the table's SEARCHABLE_TABLES permission. An
 * example the admin's permissions do not allow is not offered; a section with none left shows
 * the generic prompt. Before this, every section's hint was fixed text, and the command bar
 * showed a second, generic line ("Create a moderator role…") under every section — to roles that
 * cannot create a role.
 *
 * Display only: the planner and the executor check every action themselves.
 *
 * @module components/admin
 */

import { renderMessage } from "@/platform/errors/messages";
import { SEARCHABLE_TABLES, toolPermission } from "@/app/api/admin/ai/tool-permissions";

interface SectionHint {
  /** screens.admin_console.hints.<key> */
  readonly key: string;
  /** The command-bar tool the example runs. */
  readonly tool: string;
  /** For `search`: the table it reads (its own permission applies too). */
  readonly table?: keyof typeof SEARCHABLE_TABLES;
}

const SECTION_HINTS: Readonly<Record<string, readonly SectionHint[]>> = {
  users: [
    { key: "users_show", tool: "search", table: "users" },
    { key: "users_change_role", tool: "change_user_role" },
  ],
  roles: [
    { key: "roles_create", tool: "create_role" },
    { key: "roles_show", tool: "search", table: "roles" },
  ],
  entitlements: [{ key: "entitlements_create", tool: "create_entitlement_group" }],
  audit: [{ key: "audit_role_changes", tool: "search", table: "audit_log" }],
  "password-policy": [{ key: "password_min_length", tool: "update_password_policy" }],
};

/** Every permission an example needs; an unknown tool needs one no one holds. */
export function hintPermissions(hint: SectionHint): string[] {
  const tool = toolPermission(hint.tool) ?? "(unknown tool)";
  return hint.table ? [tool, SEARCHABLE_TABLES[hint.table]] : [tool];
}

/** The examples of `section` the admin can run, as catalog keys, in order. */
export function permittedHints(
  section: string,
  hasPermission: (code: string) => boolean
): string[] {
  return (SECTION_HINTS[section] ?? [])
    .filter((h) => hintPermissions(h).every(hasPermission))
    .map((h) => h.key);
}

/** Every section's examples (for tests: each names a real tool and table). */
export function allSectionHints(): Readonly<Record<string, readonly SectionHint[]>> {
  return SECTION_HINTS;
}

/** The command bar's placeholder for `section`: its permitted examples, or the generic prompt. */
export function sectionPlaceholder(
  section: string,
  hasPermission: (code: string) => boolean
): string {
  const t = (key: string, values?: Record<string, string>) =>
    renderMessage(`screens.admin_console.hints.${key}`, values);
  const [first, second] = permittedHints(section, hasPermission).map((k) => t(k));
  if (first && second) return t("try_two", { first, second });
  if (first) return t("try_one", { first });
  return t("generic");
}
