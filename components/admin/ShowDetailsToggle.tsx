"use client";

/**
 * components/admin/ShowDetailsToggle.tsx — "Show details": the ids the console hides by default
 * (TASK-190, the owner's decision)
 *
 * Ids are hidden by default in the command bar's search results and the Users screen. The toggle
 * that reveals them is offered only to admins and super-admins — the console knows the caller's
 * role from GET /api/admin/session (`roleName`, the verified admin's role as requireAdmin reads
 * it); moderators and every other role never see it. For a search result that is also a data
 * control (round 1, S-L1): the execute response carries the `id` column only for those roles.
 * The Users list keeps its ids (its row actions need them; the list is under admin_manage_users).
 * Only `id` is hidden (round 1, item 4): an actor or target id stays shown as on the Audit log
 * page. The toggle is shown only where it changes something (round 1, item 5): the Users screen,
 * and a section showing a search table with an `id` column. The state lives in the console page's
 * memory for the session (no storage): a reload hides the ids again.
 *
 * @module components/admin
 */

import React from "react";
import { renderMessage } from "@/platform/errors/messages";
import { ID_DETAIL_ROLES, maySeeIds } from "@/app/api/admin/ai/search-filters";

/**
 * The roles offered "Show details": the roles the server returns a search's `id` column to
 * (round 1, S-L1 — one list, app/api/admin/ai/search-filters.ts).
 */
export const DETAILS_ROLES: readonly string[] = ID_DETAIL_ROLES;

/** Whether the console offers "Show details" to a caller of this role. */
export const mayShowDetails = maySeeIds;

export function ShowDetailsToggle({
  pressed,
  onChange,
}: {
  readonly pressed: boolean;
  readonly onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={() => onChange(!pressed)}
      className="rounded border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800"
    >
      {renderMessage(
        pressed
          ? "screens.admin_console.details.hide"
          : "screens.admin_console.details.show"
      )}
    </button>
  );
}
