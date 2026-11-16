/**
 * components/admin/section-hints.ts — The command bar's example commands, per section, offered
 * only to an admin who can run them (TASK-185)
 *
 * Each example names the command-bar tool it would run (and, for a search, the table it reads).
 * Its permission is the server's own: toolPermission (app/api/admin/ai/tool-permissions.ts, the
 * map the executor checks) and, for a search, the table's SEARCHABLE_TABLES permission. An
 * example the admin's permissions do not allow is not offered; a section with none left shows
 * the generic prompt.
 *
 * The examples themselves live in the one section registry (components/admin/ui/sections.ts,
 * TASK-216): this module only reads them. They are help text under the command input, never its
 * placeholder (SF-admin-017: a placeholder is cut at 390 px and gone at the first key).
 *
 * Display only: the planner and the executor check every action themselves.
 *
 * @module components/admin
 */

import { renderMessage } from "@/platform/errors/messages";
import { SEARCHABLE_TABLES, toolPermission } from "@/app/api/admin/ai/tool-permissions";
import {
  SECTIONS,
  commandBar,
  isSection,
  sectionHints,
  type SectionHint,
} from "@/components/admin/ui/sections";
import { tableLabel, toolLabel } from "@/components/admin/ui/labels";

/** Every permission an example needs; an unknown tool needs one no one holds. */
export function hintPermissions(hint: SectionHint): string[] {
  // An unknown tool needs a permission no role has: a code, never shown (TASK-205).
  const tool = toolPermission(hint.tool) ?? "permission.unknown_tool";
  return hint.table ? [tool, SEARCHABLE_TABLES[hint.table]] : [tool];
}

/** The examples of `section` the admin can run, as catalog keys, in order. */
export function permittedHints(
  section: string,
  hasPermission: (code: string) => boolean
): string[] {
  return sectionHints(section)
    .filter((h) => hintPermissions(h).every(hasPermission))
    .map((h) => h.key);
}

/** Every section's examples (for tests: each names a real tool and table). */
export function allSectionHints(): Readonly<Record<string, readonly SectionHint[]>> {
  return Object.fromEntries(
    SECTIONS.filter((s) => sectionHints(s.id).length > 0).map((s) => [
      s.id,
      sectionHints(s.id),
    ])
  );
}

const t = (key: string, values?: Record<string, string | string[]>) =>
  renderMessage(`screens.admin_console.hints.${key}`, values);

/** The command bar's examples for `section`: its permitted ones, or the generic prompt. */
export function sectionPlaceholder(
  section: string,
  hasPermission: (code: string) => boolean
): string {
  const [first, second] = permittedHints(section, hasPermission).map((k) => t(k));
  if (first && second) return t("try_two", { first, second });
  if (first) return t("try_one", { first });
  return t("generic");
}

/**
 * What the command bar can do on `section`, in words (SF-admin-020): the section's own actions
 * the admin may run, by name, and what a search there reads — or that it can only search.
 */
export function sectionScope(
  section: string,
  hasPermission: (code: string) => boolean
): string | null {
  const scope = isSection(section) ? commandBar(section) : null;
  if (!scope) return null;
  const tools = scope.tools.filter((tool) => {
    const needed = toolPermission(tool);
    return needed !== undefined && hasPermission(needed);
  });
  const tables = scope.tables.filter((table) => hasPermission(SEARCHABLE_TABLES[table]));
  const actions = tools.map(toolLabel);
  const searched = tables.map(tableLabel);
  if (actions.length && searched.length) return t("scope_both", { actions, searched });
  if (actions.length) return t("scope_actions", { actions });
  if (searched.length) return t("scope_search", { searched });
  return t("scope_none");
}
