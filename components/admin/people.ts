/**
 * components/admin/people.ts — a person as the admin console names them (TASK-202, N-63)
 *
 * By address, never by id: the routes resolve each account on the server
 * (platform/admin/account-names.ts) and send its address — null once erased. This turns what they
 * send into words; the id, where a screen shows it at all, is a secondary detail.
 *
 * @module components/admin
 */

import { renderMessage } from "@/platform/errors/messages";
import { readableRole } from "./admin-format";

const t = (key: string, values?: Record<string, string>) =>
  renderMessage(`screens.admin_console.people.${key}`, values);

/** An account as a route names it: its address (null: none, or erased) and whether erased. */
export interface PersonRef {
  readonly email?: string | null;
  readonly role?: string | null;
  readonly erased?: boolean;
}

/** The words for a person: their address (with their role when given), or what they are. */
export function personText(
  person: PersonRef | null | undefined,
  withRole = false
): string {
  if (!person) return t("unknown");
  if (person.erased) return t("erased");
  if (!person.email) return t("no_email");
  return withRole && person.role
    ? t("with_role", { email: person.email, role: readableRole(person.role, null) })
    : person.email;
}
