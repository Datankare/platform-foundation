/**
 * components/admin/ui/labels.ts — the name a person reads for every code the console holds
 * (TASK-216, SCREEN-FINDINGS P7)
 *
 * Screens showed stored codes where a name belongs: "admin_manage_users", "role_permissions",
 * "signed_in_within_days", a job's kind, a setting's key. Every kind of code has one function
 * here, and each answers the same way: the catalogue's name when it has one, else the code made
 * readable ("data_retention" → "Data retention") — never the raw code, and never a missing-key
 * marker. A screen that needs the stored code shows it as a detail ("Show details").
 *
 * Client-safe. A person is named by PersonRef (./Ref.tsx).
 *
 * @module components/admin/ui
 */

import { renderMessage } from "@/platform/errors/messages";
import { readableRole } from "@/components/admin/admin-format";

/** How many characters of an id are shown before "more". */
export const SHORT_ID = 8;

/** "strike_ban_threshold" → "Strike ban threshold"; "data.retention" → "Data retention". */
export function readableCode(code: string): string {
  const words = code
    .replace(/[._\-:/]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}

function fromCatalogue(key: string, code: string): string {
  const text = renderMessage(key);
  return text === key ? readableCode(code) : text;
}

/** A permission by its catalogue name ("Manage users"). */
export function permissionLabel(code: string): string {
  const key = ["screens.permissions", code, "name"].join(".");
  const text = renderMessage(key);
  if (text === key) return readableCode(code);
  // The catalogue's names are in title case; the console writes sentence case.
  return readableRole(text, text);
}

/** A role by its display name, else its stored name made readable. */
export const roleLabel = (name: string, displayName?: string | null): string =>
  readableRole(name, displayName ?? null);

const kind = (group: string) => (code: string) =>
  fromCatalogue(["screens.admin_console.labels", group, code].join("."), code);

/** A feature an account can be blocked from ("translate" → "Translate"). */
export const featureLabel = kind("features");
/** A table a search reads ("audit_log" → "the audit log"). */
export const tableLabel = kind("tables");
/** A search filter the planner named ("signed_in_within_days" → "signed in within days"). */
export const filterLabel = kind("filters");
/** A trusted agent's owner ("first-party"). */
export const ownerLabel = kind("owners");
/** A capability an agent may use. */
export const capabilityLabel = kind("capabilities");
/** A password-policy field. */
export const policyFieldLabel = kind("policy_fields");
/** Who must approve ("admin", "super_admin"): a role. */
export const approverLabel = (code: string): string => readableRole(code, null);

/** A job by its catalogue name (screens.jobs.kinds: the kind's dots as underscores). */
export function jobKindLabel(jobKind: string): string {
  return fromCatalogue(`screens.jobs.kinds.${jobKind.replace(/[.-]/g, "_")}`, jobKind);
}

/**
 * A setting by a readable name: "moderation.strike_ban_threshold" → "Moderation: strike ban
 * threshold". (The catalogue holds each setting's description, screens.settings; its name is
 * its key, made readable.)
 */
export function settingLabel(key: string): string {
  const [first, ...rest] = key.split(".");
  if (!first) return "";
  if (rest.length === 0) return readableCode(first);
  return `${readableCode(first)}: ${readableCode(rest.join(" ")).toLowerCase()}`;
}

/** A search result's column: the catalogue's heading, else the column made readable. */
export function columnLabel(column: string): string {
  return fromCatalogue(`screens.admin_console.search.columns.${column}`, column);
}

/** An action's name in words (TASK-202, N-62: the screen named the tool, "update_config"). */
export function toolLabel(tool: string): string {
  const key = `screens.admin_console.tools.${tool}`;
  const text = renderMessage(key);
  // A tool the catalogue does not name is said to be one, by its name made readable.
  return text === key
    ? renderMessage("screens.admin_console.tools.unknown", { tool: readableCode(tool) })
    : text;
}

/** Several codes as one readable list value (the catalogue's list formatting takes an array). */
export const labelled = (
  codes: readonly unknown[],
  label: (code: string) => string
): string[] => codes.map((c) => label(String(c)));
