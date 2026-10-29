/**
 * components/admin/admin-format.ts — How the admin console writes dates, roles and standings
 * (TASK-185; shared in TASK-190 so the command bar's results and the Users screen read alike)
 *
 * Dates are "29 Oct 2026" (day, month name, year: never read as another date), with the full
 * timestamp for a tooltip; a role by its readable display name ("Moderator", "Super admin"); a
 * standing capitalised ("Active", "Restricted until 2 Nov 2026"). Every word is from the catalog
 * (screens.admin_console.users). Client-safe.
 *
 * @module components/admin
 */

import { renderMessage } from "@/platform/errors/messages";

const t = (key: string, values?: Record<string, string | number>) =>
  renderMessage(`screens.admin_console.users.${key}`, values);

const DATE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});
const DATE_TIME = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const FULL = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  // The tooltip's whole timestamp is in UTC, and says so (round 1, item 8): the same instant reads
  // the same on every admin's screen.
  timeZone: "UTC",
  timeZoneName: "short",
});

const parsed = (iso: string | null | undefined): Date | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** "26 Oct 2026" — day, month name, year: never read as another date. */
export function formatDate(iso: string | null | undefined): string {
  const d = parsed(iso);
  return d ? DATE.format(d) : t("dash");
}

/** "26 Oct 2026, 14:05"; "Never" when there is no date. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return t("never");
  const d = parsed(iso);
  return d ? DATE_TIME.format(d) : t("dash");
}

/** The whole timestamp in UTC, for a tooltip: "26 Oct 2026, 14:05:33 UTC" (or the text as given). */
export function fullTimestamp(iso: string): string {
  const d = parsed(iso);
  return d ? FULL.format(d) : iso;
}

/**
 * A role's readable name: its catalog display name in sentence case ("Super Admin" → "Super
 * admin"; an all-capitals word such as "QA" is kept), else the stored name with spaces ("qa_lead"
 * → "Qa lead").
 */
export function readableRole(name: string, displayName: string | null): string {
  const source = displayName?.trim() || name.replace(/_/g, " ");
  const words = source.split(/\s+/).filter(Boolean);
  return words
    .map((w, i) => {
      if (/^[A-Z0-9]{2,}$/.test(w)) return w;
      const lower = w.toLowerCase();
      return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(" ");
}

/** The standings the Users screen names; any other is shown as stored. */
export const KNOWN_STATUSES: readonly string[] = [
  "active",
  "warned",
  "restricted",
  "suspended",
  "banned",
  "deleted",
];

/** A standing's readable name: "Active", "Restricted" — as stored when it is not one we know. */
export function readableStatus(status: string): string {
  return KNOWN_STATUSES.includes(status) ? t(`status_${status}`) : status;
}

/** The account's standing, readable, with the date a restriction or suspension ends. */
export function shownStatus(user: {
  readonly status: string;
  readonly statusUntil: string | null;
}): string {
  const status = readableStatus(user.status);
  return user.statusUntil
    ? t("status_until", { status, date: formatDate(user.statusUntil) })
    : status;
}
