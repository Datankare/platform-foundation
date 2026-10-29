"use client";

/**
 * components/admin/UsersPanel.tsx — The admin console's Users screen (TASK-185)
 *
 * Reads its own pages of GET /api/admin/users — searched, sorted and paged on the server — and
 * shows each account's identity, role, status, address verification, created and last sign-in. A
 * row opens a detail panel with its entitlements and the actions the admin's permissions allow:
 *
 *   change role    PATCH /api/admin/users — a 202 `held` is shown as held for approval (dual
 *                  control), never as done;
 *   erase account  POST /api/admin/gdpr, after a confirmation.
 *
 * Which actions are shown comes from USER_ROW_ACTION_PERMISSIONS, the map the routes' guards are
 * checked against (__tests__/admin-authorization-matrix.test.ts). Display only: each route
 * refuses an admin without the permission whatever this shows. Every refusal is shown through
 * the shared handler (readRefusal → RefusalNotice; a 503 read as "could not be read", never an
 * empty list), so each code the routes can return has its screen (refusal-coverage).
 *
 * Display: a missing display name falls back to the address, then "—". A missing address reads
 * "Unknown (never signed in since <created>)" only when no sign-in is recorded; an account that
 * does sign in without one reads "Unknown: address not received from the sign-in provider (last
 * sign-in <date>)" — the address is recorded only from a trusted, verified claim
 * (platform/auth/email-verification.ts), which that provider did not give. Role names are readable
 * ("Super admin") with the stored name in the tooltip and the detail panel; dates are "26 Oct
 * 2026". Every word is from the catalog (screens.admin_console.users).
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/platform/auth/api-fetch";
import { renderMessage } from "@/platform/errors/messages";
import {
  announceSessionEnd,
  handleRefusal,
  networkRefusal,
  readRefusal,
  type Refusal,
} from "@/platform/errors/refusal";
import { RefusalNotice } from "@/components/refusal/RefusalNotice";
import { PanelUnavailable } from "@/components/admin/PanelUnavailable";
import { sectionTitle } from "@/components/admin/AdminShell";
import { USER_ROW_ACTION_PERMISSIONS } from "@/app/api/admin/ai/tool-permissions";
import type { SortDirection, UserSort } from "@/app/api/admin/users/listing";
import {
  USER_LIST_FILTERS,
  type UserListFilter,
} from "@/app/api/admin/ai/search-filters";
import { PROTECTED_ROLES } from "@/platform/auth/role-governance";
import {
  formatDate,
  formatDateTime,
  fullTimestamp,
  readableRole,
  readableStatus,
  shownStatus,
} from "@/components/admin/admin-format";

const t = (key: string, values?: Record<string, string | number>) =>
  renderMessage(`screens.admin_console.users.${key}`, values);

/** Rows a page shows. */
export const USERS_PAGE_SIZE = 25;

export interface ListedUser {
  readonly id: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly roleId: string;
  readonly roleName: string;
  readonly roleDisplayName: string | null;
  readonly status: string;
  readonly statusUntil: string | null;
  readonly emailVerified: boolean;
  readonly createdAt: string;
  readonly lastSignInAt: string | null;
  readonly entitlements: readonly {
    code: string;
    name: string;
    expiresAt: string | null;
  }[];
}

interface ListedRole {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
}

interface UsersPage {
  readonly users: readonly ListedUser[];
  readonly roles: readonly ListedRole[];
  readonly hasMore: boolean;
}

const SORT_OPTIONS: readonly { sort: UserSort; dir: SortDirection; key: string }[] = [
  { sort: "created", dir: "desc", key: "sort_created_desc" },
  { sort: "created", dir: "asc", key: "sort_created_asc" },
  { sort: "last_sign_in", dir: "desc", key: "sort_last_sign_in_desc" },
  { sort: "last_sign_in", dir: "asc", key: "sort_last_sign_in_asc" },
];

// The console's formats (TASK-190: shared with the command bar's results): re-exported here, where
// the Users screen's tests and callers have always found them.
export { formatDate, readableRole, shownStatus } from "@/components/admin/admin-format";

/** What the name column shows: the display name, else the address, else "—". */
export function shownName(user: Pick<ListedUser, "displayName" | "email">): string {
  return user.displayName?.trim() || user.email?.trim() || t("dash");
}

/** How a row is named to assistive technology: its name, else what its address cell says. */
function rowLabel(user: ListedUser): string {
  const name = shownName(user);
  return name === t("dash") ? shownEmail(user) : name;
}

/**
 * What the address column shows: the address, or why there is none — and only what is known.
 * Never signed in since it was made (no recorded sign-in): "never signed in since <created>". Signed
 * in, yet no address: the sign-in provider did not give one the platform records (not allow-listed,
 * or not verified — platform/auth/email-verification.ts), so "address not received".
 */
export function shownEmail(
  user: Pick<ListedUser, "email" | "lastSignInAt" | "createdAt">
): string {
  if (user.email?.trim()) return user.email;
  return user.lastSignInAt
    ? t("unknown_not_received", { date: formatDate(user.lastSignInAt) })
    : t("unknown_email", { date: formatDate(user.createdAt) });
}

function shownRefusal(refusal: Refusal): Refusal {
  if (refusal.kind === "signed-out-erased") announceSessionEnd(refusal.code);
  return refusal;
}

type Body = Record<string, unknown>;

/** A response's JSON body, read once ({} when it has none). */
async function bodyOf(res: Response): Promise<Body> {
  const parsed = (await res.json().catch(() => ({}))) as unknown;
  return parsed && typeof parsed === "object" ? (parsed as Body) : {};
}

/** The refusal a refused action's body carries (the shared handler decides what it needs). */
function refusalOf(res: Response, body: Body): Refusal {
  return shownRefusal(
    handleRefusal(body.code, {
      message: typeof body.message === "string" ? body.message : body.error,
      params: body.params,
      status: res.status,
    })
  );
}

const BUTTON =
  "rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500 disabled:opacity-40";
const QUIET =
  "rounded border border-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-800 disabled:opacity-40";
const th =
  "text-xs text-gray-400 uppercase tracking-wider py-3 px-4 border-b border-gray-800";
const td = "py-3 px-4 text-gray-300 border-b border-gray-800/50";

/**
 * The command bar's users-search filters, as the server validated them (TASK-190): the list
 * applies them and shows each as a removable chip. Only USER_LIST_FILTERS.
 */
export type UserListFilters = Partial<Record<UserListFilter, string | number>>;

/** The filters in the list's order (USER_LIST_FILTERS), each a string or a number. */
export function listFilters(
  filters: UserListFilters | undefined
): [UserListFilter, string | number][] {
  if (!filters) return [];
  return USER_LIST_FILTERS.flatMap((name) => {
    const value = filters[name];
    return typeof value === "string" || typeof value === "number"
      ? [[name, value] as [UserListFilter, string | number]]
      : [];
  });
}

/**
 * A filter chip's words: "Role: Moderator" (the role's readable name when the catalog has it —
 * matched as the server matches it, by name or display name in any case), "Status: Active",
 * "Signed in within 7 days", "Created within 30 days", "Contains “jane”".
 */
export function filterChip(
  name: UserListFilter,
  value: string | number,
  roles: readonly { name: string; displayName: string }[] = []
): string {
  switch (name) {
    case "role": {
      const v = String(value).toLowerCase();
      const role = roles.find(
        (r) => r.name.toLowerCase() === v || r.displayName?.toLowerCase() === v
      );
      // A role not in the catalog, or before the roles are read, as readableRole writes a stored
      // name — lower-cased first, as the server matches it ("qa_lead" → "Qa lead", "MODERATOR"
      // → "Moderator"): the chip does not change its words when they load (round 1, item 9).
      return t("chip_role", {
        role: role
          ? readableRole(role.name, role.displayName)
          : readableRole(String(value).toLowerCase(), null),
      });
    }
    case "status":
      return t("chip_status", { status: readableStatus(String(value)) });
    case "signed_in_within_days":
      return t("chip_signed_in_within_days", { days: Number(value) });
    case "created_within_days":
      return t("chip_created_within_days", { days: Number(value) });
    case "text":
      return t("chip_text", { text: String(value) });
  }
}

export interface UsersPanelProps {
  /** The admin's permissions (from GET /api/admin/session): which actions are shown. */
  readonly hasPermission: (code: string) => boolean;
  /** Bumped by the console after a command-bar change: the page is read again. */
  readonly refreshKey?: number;
  /** The signed-in admin's own account id: its row offers no change (the server refuses one). */
  readonly selfId?: string;
  /** The command bar's users-search filters (TASK-190): applied to this list, shown as chips. */
  readonly filters?: UserListFilters;
  /** A chip removed, or "Clear all": the filters the list should apply now. */
  readonly onFiltersChange?: (next: UserListFilters) => void;
  // Also called, with the filters unchanged, when the panel's own search box is applied (round 2,
  // N-2): the list then no longer shows exactly the search's matches, so its row is dismissed.
  /** "Show details" (admins only, TASK-190): the Id column and the detail panel's account id. */
  readonly showIds?: boolean;
  /**
   * Bumped each time a command-bar users search hands its filters to the list (round 1, item 2):
   * the panel's own search box is cleared, so the list shows exactly the search's filters, from
   * its first page with nothing open (round 2, N-1 — also for a hand-off of the same filters).
   */
  readonly handoff?: number;
}

/**
 * A hand-off from the command bar (round 1, item 2) clears the panel's own search box — its draft
 * and its applied query — so the list shows exactly the search's filters, nothing more.
 */
function useClearedOnHandoff(
  handoff: number,
  ...clear: readonly ((value: string) => void)[]
): void {
  const [shown, setShown] = useState(handoff);
  if (shown !== handoff) {
    setShown(handoff);
    for (const set of clear) set("");
  }
}

export function UsersPanel({
  hasPermission,
  refreshKey = 0,
  selfId,
  filters,
  onFiltersChange,
  showIds = false,
  handoff,
}: UsersPanelProps) {
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  useClearedOnHandoff(handoff ?? 0, setDraft, setQuery);
  const [order, setOrder] = useState(0);
  const [offset, setOffset] = useState(0);
  const [reads, setReads] = useState(0);
  const [page, setPage] = useState<UsersPage | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Each row's open button, so closing the detail panel returns focus to the row it came from.
  const rowButtons = useRef(new Map<string, HTMLButtonElement>());
  const returnTo = useRef<string | null>(null);

  const { sort, dir } = SORT_OPTIONS[order]!;
  const applied = listFilters(filters);
  const filterKey = JSON.stringify(applied);
  // New filters from the command bar (or a chip removed), or any hand-off — even of the same
  // filters (round 2, N-1): back to the first page, nothing open.
  const resetKey = `${handoff ?? 0}\u0000${filterKey}`;
  const [shownFilterKey, setShownFilterKey] = useState(resetKey);
  if (shownFilterKey !== resetKey) {
    setShownFilterKey(resetKey);
    setOffset(0);
    setSelectedId(null);
  }
  // The read the screen asks for now, and the last one answered: loading while they differ.
  const want = [sort, dir, offset, query, reads, refreshKey, filterKey].join("\u0000");
  const [answered, setAnswered] = useState<string | null>(null);
  const loading = answered !== want;

  useEffect(() => {
    if (selectedId !== null || returnTo.current === null) return;
    rowButtons.current.get(returnTo.current)?.focus();
    returnTo.current = null;
  }, [selectedId]);

  useEffect(() => {
    let current = true;
    const qs = new URLSearchParams({
      sort,
      dir,
      limit: String(USERS_PAGE_SIZE),
      offset: String(offset),
      ...(query ? { q: query } : {}),
      ...Object.fromEntries(
        (JSON.parse(filterKey) as [string, string | number][]).map(([k, v]) => [
          k,
          String(v),
        ])
      ),
    }).toString();
    void apiFetch(`/api/admin/users?${qs}`)
      .then(async (res) => {
        if (!current) return;
        if (res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            users?: unknown;
            roles?: unknown;
            page?: { hasMore?: unknown };
          };
          if (!current) return;
          setAnswered(want);
          setUnavailable(false);
          setRefusal(null);
          setPage({
            users: Array.isArray(body.users) ? (body.users as ListedUser[]) : [],
            roles: Array.isArray(body.roles) ? (body.roles as ListedRole[]) : [],
            hasMore: body.page?.hasMore === true,
          });
          return;
        }
        const refused = await readRefusal(res);
        if (!current) return;
        setAnswered(want);
        // A refused re-read never leaves the previous page on screen as if it were current.
        setPage(null);
        setSelectedId(null);
        if (res.status === 503 && refused.code === "service.unavailable") {
          setUnavailable(true);
          setRefusal(null);
        } else {
          setUnavailable(false);
          setRefusal(shownRefusal(refused));
        }
      })
      .catch(() => {
        if (!current) return;
        setAnswered(want);
        setPage(null);
        setSelectedId(null);
        setRefusal(networkRefusal());
      });
    return () => {
      current = false;
    };
  }, [sort, dir, offset, query, reads, refreshKey, filterKey, want]);

  const reload = useCallback(() => setReads((n) => n + 1), []);

  if (unavailable) {
    return <PanelUnavailable panel={sectionTitle("users")} onRetry={reload} />;
  }

  const users = page?.users ?? [];
  const selected = users.find((u) => u.id === selectedId) ?? null;

  return (
    <div className="space-y-4">
      <form
        role="search"
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setOffset(0);
          setSelectedId(null);
          setQuery(draft.trim());
          onFiltersChange?.({ ...filters });
        }}
      >
        <label className="flex flex-1 flex-col text-xs text-gray-400">
          {t("search_label")}
          <input
            type="search"
            value={draft}
            maxLength={100}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t("search_placeholder")}
            className="mt-1 rounded-lg border border-gray-700 bg-[#0a0f1e] px-3 py-2 text-sm text-white"
          />
        </label>
        <button type="submit" className={BUTTON}>
          {t("search")}
        </button>
        {query && (
          <button
            type="button"
            className={QUIET}
            onClick={() => {
              setDraft("");
              setQuery("");
              setOffset(0);
            }}
          >
            {t("clear")}
          </button>
        )}
        <label className="flex flex-col text-xs text-gray-400">
          {t("sort_label")}
          <select
            value={order}
            onChange={(e) => {
              setOrder(Number(e.target.value));
              setOffset(0);
            }}
            className="mt-1 rounded-lg border border-gray-700 bg-[#0a0f1e] px-3 py-2 text-sm text-white"
          >
            {SORT_OPTIONS.map((o, i) => (
              <option key={o.key} value={i}>
                {t(o.key)}
              </option>
            ))}
          </select>
        </label>
      </form>

      <FilterChips
        applied={applied}
        // Undefined only while the first page is read: a role chip waits for the roles (round 2, 9).
        roles={page?.roles ?? (loading ? undefined : [])}
        onRemove={(name) => {
          const next: UserListFilters = { ...filters };
          delete next[name];
          onFiltersChange?.(next);
        }}
        onClear={() => onFiltersChange?.({})}
      />

      {refusal && <RefusalNotice refusal={refusal} onRetry={reload} />}

      {loading && !refusal && (
        <p role="status" className="text-sm text-gray-400">
          {t("loading")}
        </p>
      )}

      {page && (
        <div className="overflow-x-auto rounded-xl border border-gray-800 bg-[#111827]">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr>
                {showIds && <th className={th}>{t("col_id")}</th>}
                <th className={th}>{t("col_email")}</th>
                <th className={th}>{t("col_name")}</th>
                <th className={th}>{t("col_role")}</th>
                <th className={th}>{t("col_status")}</th>
                <th className={th}>{t("col_verified")}</th>
                <th className={th}>{t("col_created")}</th>
                <th className={th}>{t("col_last_sign_in")}</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr
                  key={u.id}
                  onClick={() => setSelectedId(u.id)}
                  aria-current={u.id === selectedId ? "true" : undefined}
                  className={`cursor-pointer hover:bg-gray-800/40 ${
                    u.id === selectedId ? "bg-blue-900/20" : ""
                  }`}
                >
                  {showIds && (
                    <td className={td}>
                      <code className="text-xs">{u.id}</code>
                    </td>
                  )}
                  <td className={td}>
                    <button
                      type="button"
                      className="text-left text-blue-300 hover:underline"
                      aria-label={t("open_row", { name: rowLabel(u) })}
                      ref={(el) => {
                        if (el) rowButtons.current.set(u.id, el);
                        else rowButtons.current.delete(u.id);
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedId(u.id);
                      }}
                    >
                      {shownEmail(u)}
                    </button>
                  </td>
                  <td className={td}>{shownName(u)}</td>
                  <td className={td} title={u.roleName}>
                    {readableRole(u.roleName, u.roleDisplayName)}
                  </td>
                  <td className={td}>{shownStatus(u)}</td>
                  <td className={td}>{u.emailVerified ? t("yes") : t("no")}</td>
                  <td className={td} title={fullTimestamp(u.createdAt)}>
                    {formatDate(u.createdAt)}
                  </td>
                  <td
                    className={td}
                    title={u.lastSignInAt ? fullTimestamp(u.lastSignInAt) : undefined}
                  >
                    {u.lastSignInAt ? formatDate(u.lastSignInAt) : t("never")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {users.length === 0 && (
            <p className="py-8 text-center text-sm text-gray-400">
              {applied.length > 0
                ? t("empty_filtered")
                : query
                  ? t("empty_search", { query })
                  : t("empty")}
            </p>
          )}
        </div>
      )}

      {page && (offset > 0 || page.hasMore) && (
        <nav className="flex items-center gap-3 text-sm text-gray-400">
          <button
            type="button"
            className={QUIET}
            disabled={loading || offset === 0}
            onClick={() => setOffset(Math.max(0, offset - USERS_PAGE_SIZE))}
          >
            {t("previous")}
          </button>
          <span>
            {t("page_range", {
              from: users.length ? offset + 1 : offset,
              to: offset + users.length,
            })}
          </span>
          <button
            type="button"
            className={QUIET}
            disabled={loading || !page.hasMore}
            onClick={() => setOffset(offset + USERS_PAGE_SIZE)}
          >
            {t("next")}
          </button>
        </nav>
      )}

      {selected && page && (
        <UserDetail
          key={selected.id}
          user={selected}
          roles={page.roles}
          hasPermission={hasPermission}
          isSelf={selected.id === selfId}
          showId={showIds}
          onClose={(changed) => {
            returnTo.current = selected.id;
            setSelectedId(null);
            if (changed) reload();
          }}
          onChanged={reload}
        />
      )}
    </div>
  );
}

/** The command bar's filters on the list, each removable, and "Clear all" (TASK-190). */
function FilterChips({
  applied,
  roles,
  onRemove,
  onClear,
}: {
  readonly applied: readonly [UserListFilter, string | number][];
  /** The catalog's roles; undefined while the first page is being read. */
  readonly roles: readonly ListedRole[] | undefined;
  readonly onRemove: (name: UserListFilter) => void;
  readonly onClear: () => void;
}) {
  if (applied.length === 0) return null;
  return (
    <div
      role="group"
      aria-label={t("filters_label")}
      className="flex flex-wrap items-center gap-2"
    >
      <span className="text-xs text-gray-400">{t("filters_label")}</span>
      {applied.map(([name, value]) => {
        // A role chip is named once the roles are read — "Role: …" until then — so its words
        // never change on screen (round 2, item 9); a read that failed names it from the value.
        const label =
          name === "role" && roles === undefined
            ? t("chip_role_pending")
            : filterChip(name, value, roles);
        return (
          <button
            key={name}
            type="button"
            aria-label={t("filter_remove", { filter: label })}
            className="inline-flex items-center gap-1 rounded-full border border-blue-700 bg-blue-900/30 px-3 py-1 text-xs text-blue-200 hover:bg-blue-900/50"
            onClick={() => onRemove(name)}
          >
            <span>{label}</span>
            <span aria-hidden="true">✕</span>
          </button>
        );
      })}
      <button
        type="button"
        className="text-xs text-gray-400 underline hover:text-gray-200"
        onClick={onClear}
      >
        {t("filters_clear_all")}
      </button>
    </div>
  );
}

type Outcome =
  | { readonly kind: "done"; readonly text: string }
  | { readonly kind: "info"; readonly text: string }
  | { readonly kind: "held"; readonly text: string }
  | { readonly kind: "incomplete"; readonly text: string }
  | { readonly kind: "refused"; readonly refusal: Refusal };

function UserDetail({
  user,
  roles,
  hasPermission,
  isSelf,
  showId,
  onClose,
  onChanged,
}: {
  readonly user: ListedUser;
  readonly roles: readonly ListedRole[];
  readonly hasPermission: (code: string) => boolean;
  /** The admin's own account: no role change or erasure (the routes refuse both). */
  readonly isSelf: boolean;
  /** "Show details" is on: the account id is shown (TASK-190 — ids are hidden by default). */
  readonly showId: boolean;
  /** `changed`: an erasure ran — the list is read again once the panel is closed. */
  readonly onClose: (changed: boolean) => void;
  readonly onChanged: () => void;
}) {
  // An erased account leaves the list: re-reading at once would close this panel and its answer.
  const [erasedHere, setErasedHere] = useState(false);
  const [roleId, setRoleId] = useState(user.roleId);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [confirmErase, setConfirmErase] = useState(false);
  const focusEraseNext = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const eraseButton = useRef<HTMLButtonElement>(null);

  // The role shown follows the account's: a re-read after a change (or by another admin) moves it.
  const [shownRoleOf, setShownRoleOf] = useState(user.roleId);
  if (shownRoleOf !== user.roleId) {
    setShownRoleOf(user.roleId);
    setRoleId(user.roleId);
  }
  // Opened: focus moves to the panel's heading.
  useEffect(() => heading.current?.focus(), []);
  // The erase confirmation takes focus; cancelled or answered, focus returns to its button.
  useEffect(() => {
    if (confirmErase) dialog.current?.focus();
    else if (focusEraseNext.current) {
      focusEraseNext.current = false;
      eraseButton.current?.focus();
    }
  }, [confirmErase]);

  // The routes refuse these (auth.role_self_change, admin.self_target; auth.role_database_only,
  // auth.role_protected): no action is offered that can only be refused — and the panel says why.
  const isProtected = PROTECTED_ROLES.includes(user.roleName);
  const actionable = !isSelf && !isProtected;
  const mayChangeRole =
    actionable && hasPermission(USER_ROW_ACTION_PERMISSIONS.change_role);
  const mayErase = actionable && hasPermission(USER_ROW_ACTION_PERMISSIONS.erase_account);

  const closeErase = () => {
    focusEraseNext.current = true;
    setConfirmErase(false);
  };

  async function changeRole() {
    if (roleId === user.roleId) {
      setOutcome({ kind: "info", text: t("change_role_same") });
      return;
    }
    setBusy(true);
    setOutcome(null);
    try {
      const res = await apiFetch("/api/admin/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, roleId }),
      });
      const body = await bodyOf(res);
      if (res.status === 202 && body.held === true) {
        setOutcome({ kind: "held", text: t("held") });
      } else if (res.ok && body.success === true) {
        setOutcome({ kind: "done", text: t("changed") });
        onChanged();
      } else {
        // Anything else is not a change: a refusal (by its code), or an answer that says neither.
        setOutcome({ kind: "refused", refusal: refusalOf(res, body) });
      }
    } catch {
      setOutcome({ kind: "refused", refusal: networkRefusal() });
    } finally {
      setBusy(false);
    }
  }

  async function erase() {
    setBusy(true);
    setOutcome(null);
    try {
      const res = await apiFetch("/api/admin/gdpr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, reason: "admin-action" }),
      });
      const body = await bodyOf(res);
      if (res.ok) {
        const status = typeof body.status === "string" ? body.status : "";
        setOutcome(
          status === "completed"
            ? { kind: "done", text: t("erased") }
            : {
                kind: "incomplete",
                text: t("erase_incomplete", { status: status || t("dash") }),
              }
        );
        setErasedHere(true);
      } else {
        setOutcome({ kind: "refused", refusal: refusalOf(res, body) });
      }
    } catch {
      setOutcome({ kind: "refused", refusal: networkRefusal() });
    } finally {
      setBusy(false);
      closeErase();
    }
  }

  const rows: [string, React.ReactNode][] = [
    ...(showId
      ? ([[t("field_identity"), <code key="id">{user.id}</code>]] as [
          string,
          React.ReactNode,
        ][])
      : []),
    [t("field_email"), shownEmail(user)],
    [t("field_name"), shownName(user)],
    [t("field_role"), readableRole(user.roleName, user.roleDisplayName)],
    [t("field_role_raw"), <code key="role">{user.roleName}</code>],
    [t("field_status"), shownStatus(user)],
    [t("field_verified"), user.emailVerified ? t("yes") : t("no")],
    [t("field_created"), formatDateTime(user.createdAt)],
    [t("field_last_sign_in"), formatDateTime(user.lastSignInAt)],
    [
      t("field_entitlements"),
      user.entitlements.length
        ? user.entitlements
            .map((e) =>
              e.expiresAt
                ? t("entitlement_until", { name: e.name, date: formatDate(e.expiresAt) })
                : e.name
            )
            .join(", ")
        : t("no_entitlements"),
    ],
  ];

  return (
    <section
      aria-labelledby="user-detail-title"
      className="rounded-xl border border-gray-700 bg-[#111827] p-5"
    >
      <div className="mb-4 flex items-center justify-between">
        <h3
          id="user-detail-title"
          ref={heading}
          tabIndex={-1}
          className="text-lg font-semibold text-white focus:outline-none"
        >
          {t("detail_title")}: {shownName(user)}
        </h3>
        <button type="button" className={QUIET} onClick={() => onClose(erasedHere)}>
          {t("close")}
        </button>
      </div>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
        {rows.map(([label, value]) => (
          <React.Fragment key={label}>
            <dt className="text-gray-400">{label}</dt>
            <dd className="text-gray-200 break-all">{value}</dd>
          </React.Fragment>
        ))}
      </dl>

      <div className="mt-5 space-y-3 border-t border-gray-800 pt-4">
        {mayChangeRole && (
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col text-xs text-gray-400">
              {t("change_role_label")}
              <select
                value={roleId}
                onChange={(e) => setRoleId(e.target.value)}
                className="mt-1 rounded-lg border border-gray-700 bg-[#0a0f1e] px-3 py-2 text-sm text-white"
              >
                {roles.map((r) => (
                  <option key={r.id} value={r.id} title={r.name}>
                    {readableRole(r.name, r.displayName)}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={BUTTON}
              disabled={busy}
              onClick={() => void changeRole()}
            >
              {busy ? t("working") : t("change_role_submit")}
            </button>
          </div>
        )}

        {mayErase &&
          (confirmErase ? (
            <div
              ref={dialog}
              role="alertdialog"
              aria-labelledby="erase-title"
              aria-describedby="erase-warning"
              tabIndex={-1}
              onKeyDown={(e) => {
                if (e.key === "Escape" && !busy) closeErase();
              }}
              className="rounded-lg border border-red-800 bg-red-900/20 p-3 text-sm text-red-200 focus:outline-none"
            >
              <p id="erase-title" className="mb-1 font-semibold">
                {t("erase")}
              </p>
              <p id="erase-warning" className="mb-2">
                {t("erase_warning")}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="rounded bg-red-700 px-3 py-1.5 text-sm text-white hover:bg-red-600 disabled:opacity-40"
                  disabled={busy}
                  onClick={() => void erase()}
                >
                  {busy ? t("working") : t("erase_confirm")}
                </button>
                <button
                  type="button"
                  className={QUIET}
                  disabled={busy}
                  onClick={closeErase}
                >
                  {t("erase_cancel")}
                </button>
              </div>
            </div>
          ) : (
            <button
              ref={eraseButton}
              type="button"
              className={QUIET}
              onClick={() => setConfirmErase(true)}
            >
              {t("erase")}
            </button>
          ))}

        {isSelf ? (
          <p className="text-sm text-gray-400">{t("self_row")}</p>
        ) : isProtected ? (
          <p className="text-sm text-gray-400">{t("protected_row")}</p>
        ) : (
          !mayChangeRole &&
          !mayErase && <p className="text-sm text-gray-400">{t("no_actions")}</p>
        )}
        <p className="text-xs text-gray-500">{t("not_shown")}</p>

        {outcome?.kind === "done" && (
          <p role="status" className="text-sm text-green-400">
            {outcome.text}
          </p>
        )}
        {outcome?.kind === "info" && (
          <p role="status" className="text-sm text-gray-300">
            {outcome.text}
          </p>
        )}
        {outcome?.kind === "held" && (
          <p
            role="status"
            data-held="true"
            className="rounded-lg border border-amber-700 bg-amber-900/20 px-3 py-2 text-sm text-amber-200"
          >
            {outcome.text}
          </p>
        )}
        {outcome?.kind === "incomplete" && (
          <p role="alert" className="text-sm text-red-300">
            {outcome.text}
          </p>
        )}
        {outcome?.kind === "refused" && <RefusalNotice refusal={outcome.refusal} />}
      </div>
    </section>
  );
}
