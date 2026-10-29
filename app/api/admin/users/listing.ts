/**
 * app/api/admin/users/listing.ts — What the Users list accepts and how it reads a row's standing
 * (TASK-185). Client-safe (no server imports): the route (./route.ts) and the console's Users
 * screen (components/admin/UsersPanel.tsx) share it.
 *
 * @module app/api/admin/users
 */

/** The list's sort keys and directions (the screen sends these; nothing else is accepted). */
export const USER_SORTS = ["created", "last_sign_in"] as const;
export const USER_SORT_DIRECTIONS = ["desc", "asc"] as const;
export type UserSort = (typeof USER_SORTS)[number];
export type SortDirection = (typeof USER_SORT_DIRECTIONS)[number];

/** A row's stored standing, as the list reads it. */
export interface StandingRow {
  readonly account_status: string;
  readonly deleted_at: Date | null;
  readonly restricted_until: Date | null;
  readonly suspended_until: Date | null;
}

/** The standing the status guard would read: an expired restriction or suspension is over. */
export function listedStatus(
  row: StandingRow,
  now: number = Date.now()
): { status: string; until: string | null } {
  if (row.deleted_at) return { status: "deleted", until: null };
  const until =
    row.account_status === "restricted"
      ? row.restricted_until
      : row.account_status === "suspended"
        ? row.suspended_until
        : null;
  if (until && until.getTime() <= now) return { status: "active", until: null };
  return { status: row.account_status, until: until ? until.toISOString() : null };
}

/**
 * The same reading in SQL, of a users row aliased `u` — so a list or a search can filter on the
 * standing before its limit (TASK-189 search, TASK-190 Users list): erased → deleted; a
 * restriction or suspension whose end has passed → active; otherwise the stored standing.
 */
export const USER_STATUS_SQL = `(case when u.deleted_at is not null then 'deleted'
         when u.account_status = 'restricted' and u.restricted_until <= now() then 'active'
         when u.account_status = 'suspended' and u.suspended_until <= now() then 'active'
         else u.account_status::text end)`;
