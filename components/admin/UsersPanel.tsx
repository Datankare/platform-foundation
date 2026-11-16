"use client";

/**
 * components/admin/UsersPanel.tsx — The admin console's Users screen (TASK-185)
 *
 * Reads its own pages of POST /api/admin/users/search — searched, sorted and paged on the server,
 * the search text in the body, never the URL (TASK-215, audit A-17) — and
 * shows each account's identity, role, status, address verification, created and last sign-in. A
 * row opens a detail panel with its entitlements and the actions the admin's permissions allow:
 *
 *   change role    PATCH /api/admin/users — a 202 `held` is shown as held for approval (dual
 *                  control), never as done;
 *   erase account  POST /api/admin/gdpr, after a confirmation — held (202) for a second admin's
 *                  approval, shown as held (TASK-194).
 *
 * Which actions are offered comes from USER_ROW_ACTION_PERMISSIONS, the map the routes' guards are
 * checked against (__tests__/admin-authorization-matrix.test.ts): one the admin's permissions do
 * not allow is shown disabled, saying which permission it needs (the shared gate). Display only: each route
 * refuses an admin without the permission whatever this shows. Every refusal is shown through
 * the shared handler (readRefusal → RefusalNotice; a 503 read as "could not be read", never an
 * empty list), so each code the routes can return has its screen (refusal-coverage).
 *
 * TASK-216 (SF-admin-040 to 043, and the Users side of 036): the screen is built from the console's
 * shared parts — the list is the one table (it scrolls inside its card; ids only with "Show
 * details"; "1–25 of 312" from the route's count), its read goes through PanelState, the detail
 * opens beside the list (in its place on a narrow screen) with focus, a role change is confirmed
 * naming the account and "from → to", an erasure's confirmation asks which kind of reason it has,
 * and every outcome — changed, held for a second administrator, refused — is listed with whom it
 * was for and what happens next, until dismissed.
 *
 * Display: a missing display name falls back to the address, then "—". A missing address reads
 * "Unknown (never signed in since <created>)" only when no sign-in is recorded; an account that
 * does sign in without one reads "Unknown: address not received from the sign-in provider (last
 * sign-in <date>)" — the address is recorded only from a trusted, verified claim
 * (platform/auth/email-verification.ts), which that provider did not give. Role names are readable
 * ("Super admin") with the stored name in the tooltip and the detail panel; dates are "26 Oct
 * 2026". Every word is from the catalog (screens.admin_console.users).
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { renderMessage } from "@/platform/errors/messages";
import { sectionTitle } from "@/components/admin/AdminShell";
import { USER_ROW_ACTION_PERMISSIONS } from "@/app/api/admin/ai/tool-permissions";
import type { SortDirection, UserSort } from "@/app/api/admin/users/listing";
import {
  USER_LIST_FILTERS,
  type UserListFilter,
} from "@/app/api/admin/ai/search-filters";
import { PROTECTED_ROLES } from "@/platform/auth/role-governance";
import { PURGE_REASONS } from "@/platform/gdpr/types";
import {
  formatDate,
  formatDateTime,
  readableRole,
  readableStatus,
  shownStatus,
} from "@/components/admin/admin-format";
import { adminCall } from "@/components/admin/ui/admin-call";
import { elementWith } from "@/components/admin/views/kit";
import { AdminTable, type Column } from "@/components/admin/ui/AdminTable";
import { ConfirmStep } from "@/components/admin/ui/ConfirmStep";
import {
  DetailFacts,
  DetailLayout,
  DetailPanel,
} from "@/components/admin/ui/DetailPanel";
import { Field, Select, TextInput } from "@/components/admin/ui/Field";
import {
  OutcomeList,
  outcome,
  refusedOutcome,
  type OutcomeEntry,
} from "@/components/admin/ui/Outcome";
import { PanelState, usePanelSearch } from "@/components/admin/ui/PanelState";
import { GatedButton, needsPermission } from "@/components/admin/ui/PermissionGate";
import { IdDetail } from "@/components/admin/ui/Ref";
import { BUTTON, TEXT, TONE } from "@/components/admin/ui/tokens";

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
  /** How many accounts match in all (the route's count); not a number when it sent none. */
  readonly total: unknown;
  readonly totalCapped: boolean;
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<OutcomeEntry[]>([]);

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

  // TASK-215 (audit A-17): the search text and the filters go in the body of a POST, never in
  // the URL — a URL is kept by every proxy and access log on the way.
  const search = useMemo(
    () =>
      JSON.stringify({
        sort,
        dir,
        limit: USERS_PAGE_SIZE,
        offset,
        ...(query ? { q: query } : {}),
        ...Object.fromEntries(JSON.parse(filterKey) as [string, string | number][]),
      }),
    [sort, dir, offset, query, filterKey]
  );
  const { read, reload } = usePanelSearch("/api/admin/users/search", search, refreshKey);

  const page: UsersPage | null =
    read.phase === "ready"
      ? {
          users: Array.isArray(read.body.users) ? (read.body.users as ListedUser[]) : [],
          roles: Array.isArray(read.body.roles) ? (read.body.roles as ListedRole[]) : [],
          hasMore:
            (read.body.page as { hasMore?: unknown } | undefined)?.hasMore === true,
          total: (read.body.page as { total?: unknown } | undefined)?.total,
          totalCapped:
            (read.body.page as { totalCapped?: unknown } | undefined)?.totalCapped ===
            true,
        }
      : null;
  const loading = read.phase === "loading" || (read.phase === "ready" && read.refreshing);
  const users = page?.users ?? [];
  const selected = users.find((u) => u.id === selectedId) ?? null;

  const columns: Column<ListedUser>[] = [
    { id: "id", header: t("col_id"), kind: "id", value: (u) => u.id },
    {
      id: "email",
      header: t("col_email"),
      cell: (u) => (
        <button
          type="button"
          className={`${BUTTON.link} break-words`}
          aria-label={t("open_row", { name: rowLabel(u) })}
          data-open-row={u.id}
          onClick={() => setSelectedId(u.id)}
        >
          {shownEmail(u)}
        </button>
      ),
    },
    { id: "name", header: t("col_name"), value: (u) => shownName(u) },
    {
      id: "role",
      header: t("col_role"),
      value: (u) => readableRole(u.roleName, u.roleDisplayName),
    },
    { id: "status", header: t("col_status"), value: (u) => shownStatus(u) },
    {
      id: "verified",
      header: t("col_verified"),
      secondary: true,
      value: (u) => (u.emailVerified ? t("yes") : t("no")),
    },
    {
      id: "created",
      header: t("col_created"),
      kind: "date",
      secondary: true,
      value: (u) => u.createdAt,
    },
    {
      id: "last_sign_in",
      header: t("col_last_sign_in"),
      kind: "date",
      value: (u) => u.lastSignInAt,
    },
  ];

  return (
    <div className="min-w-0 space-y-4">
      <OutcomeList
        outcomes={outcomes}
        label={t("outcomes_label")}
        onDismiss={(id) => setOutcomes((shown) => shown.filter((o) => o.id !== id))}
      />

      <DetailLayout
        detail={
          selected && page ? (
            <UserDetail
              key={selected.id}
              user={selected}
              roles={page.roles}
              hasPermission={hasPermission}
              isSelf={selected.id === selfId}
              showId={showIds}
              onClose={() => setSelectedId(null)}
              onChanged={reload}
              onOutcome={(entry) => setOutcomes((shown) => [...shown, entry])}
            />
          ) : null
        }
      >
        <div className="min-w-0 space-y-4">
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
            <Field label={t("search_label")} className="flex-1 basis-56">
              {(control) => (
                <TextInput
                  {...control}
                  type="search"
                  value={draft}
                  maxLength={100}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={t("search_placeholder")}
                />
              )}
            </Field>
            <button type="submit" className={BUTTON.primary}>
              {t("search")}
            </button>
            {query && (
              <button
                type="button"
                className={BUTTON.quiet}
                onClick={() => {
                  setDraft("");
                  setQuery("");
                  setOffset(0);
                }}
              >
                {t("clear")}
              </button>
            )}
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

          <PanelState read={read} panel={sectionTitle("users")} onReload={reload}>
            {() => (
              <AdminTable
                caption={sectionTitle("users")}
                columns={columns}
                rows={users}
                rowKey={(u) => u.id}
                showIds={showIds}
                compact={selected !== null}
                selectedKey={selectedId}
                onRowClick={(u) => setSelectedId(u.id)}
                empty={
                  applied.length > 0
                    ? t("empty_filtered")
                    : query
                      ? t("empty_search", { query })
                      : t("empty")
                }
                sort={{
                  label: t("sort_label"),
                  value: String(order),
                  options: SORT_OPTIONS.map((o, i) => ({
                    id: String(i),
                    label: t(o.key),
                  })),
                  onChange: (id) => {
                    setOrder(Number(id));
                    setOffset(0);
                  },
                }}
                page={{
                  offset,
                  size: USERS_PAGE_SIZE,
                  shown: users.length,
                  hasMore: page?.hasMore === true,
                  total: typeof page?.total === "number" ? page.total : null,
                  totalCapped: page?.totalCapped === true,
                  busy: loading,
                  onPage: setOffset,
                }}
              />
            )}
          </PanelState>
        </div>
      </DetailLayout>
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
      <span className={`text-xs ${TEXT.faint}`}>{t("filters_label")}</span>
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
        className={`text-xs underline ${TEXT.quiet}`}
        onClick={onClear}
      >
        {t("filters_clear_all")}
      </button>
    </div>
  );
}

/**
 * Whether the account's erasure is already waiting for approval (TASK-194 round 1, A6): read when
 * the panel opens, so it is shown after a reload too; unreadable, it reads as not pending (the
 * button stays, and the route refuses a second one).
 */
function usePendingErasure(
  mayErase: boolean,
  userId: string
): [boolean, (pending: boolean) => void] {
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!mayErase) return;
    let live = true;
    void adminCall(`/api/admin/gdpr?userId=${encodeURIComponent(userId)}`).then(
      (answer) => {
        if (
          live &&
          answer.ok &&
          answer.body.pending &&
          typeof answer.body.pending === "object"
        )
          setPending(true);
      }
    );
    return () => {
      live = false;
    };
  }, [mayErase, userId]);
  return [pending, setPending];
}

function UserDetail({
  user,
  roles,
  hasPermission,
  isSelf,
  showId,
  onClose,
  onChanged,
  onOutcome,
}: {
  readonly user: ListedUser;
  readonly roles: readonly ListedRole[];
  readonly hasPermission: (code: string) => boolean;
  /** The admin's own account: no role change or erasure (the routes refuse both). */
  readonly isSelf: boolean;
  /** "Show details" is on: the account id and the role's stored name are shown (TASK-190). */
  readonly showId: boolean;
  readonly onClose: () => void;
  readonly onChanged: () => void;
  /** What became of an action here: listed by the screen, kept until dismissed. */
  readonly onOutcome: (entry: OutcomeEntry) => void;
}) {
  const [roleId, setRoleId] = useState(user.roleId);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<"role" | "erase" | null>(null);
  const [roleProblem, setRoleProblem] = useState<string | null>(null);
  // What opened each confirmation: focus returns there when it is cancelled.
  const roleButton = useRef<HTMLButtonElement>(null);
  const eraseButton = useRef<HTMLButtonElement>(null);

  // The role shown follows the account's: a re-read after a change (or by another admin) moves it.
  const [shownRoleOf, setShownRoleOf] = useState(user.roleId);
  if (shownRoleOf !== user.roleId) {
    setShownRoleOf(user.roleId);
    setRoleId(user.roleId);
  }

  // The routes refuse these (auth.role_self_change, admin.self_target; auth.role_database_only,
  // auth.role_protected): no action is offered that can only be refused — and the panel says why.
  const isProtected = PROTECTED_ROLES.includes(user.roleName);
  const actionable = !isSelf && !isProtected;
  const mayChangeRole =
    actionable && hasPermission(USER_ROW_ACTION_PERMISSIONS.change_role);
  const mayErase = actionable && hasPermission(USER_ROW_ACTION_PERMISSIONS.erase_account);

  const [erasePending, setErasePending] = usePendingErasure(mayErase, user.id);

  // The account as every outcome and confirmation names it: by name or address, never by id.
  const account = rowLabel(user);
  const roleNow = readableRole(user.roleName, user.roleDisplayName);
  const chosen = roles.find((r) => r.id === roleId);
  const roleNext = chosen ? readableRole(chosen.name, chosen.displayName) : roleNow;

  async function changeRole() {
    setBusy(true);
    const answer = await adminCall("/api/admin/users", {
      method: "PATCH",
      json: { userId: user.id, roleId },
    });
    setBusy(false);
    setAsking(null);
    if (answer.ok && answer.status === 202 && answer.body.held === true) {
      onOutcome(
        outcome("held", t("role_held", { from: roleNow, to: roleNext }), {
          who: account,
          next: t("next_role_held", { from: roleNow }),
        })
      );
    } else if (answer.ok && answer.body.success === true) {
      onOutcome(
        outcome("applied", t("role_changed", { from: roleNow, to: roleNext }), {
          who: account,
          next: t("next_role_changed"),
        })
      );
      onChanged();
    } else if (answer.ok) {
      // An answer that says neither: not a change, and said as that.
      onOutcome(outcome("refused", t("role_unconfirmed"), { who: account }));
    } else {
      onOutcome(refusedOutcome(answer.refusal, { who: account }));
    }
  }

  async function erase(reason: string) {
    setBusy(true);
    const answer = await adminCall("/api/admin/gdpr", {
      method: "POST",
      json: { userId: user.id, reason },
    });
    setBusy(false);
    setAsking(null);
    // An erasure asked here is always held for a second admin (TASK-194, audit C-6;
    // ALWAYS_HELD_ACTIONS): nothing is erased yet. Any other answer is a refusal by its code,
    // or one that says neither (TASK-207: a 200 "completed" was shown as erased, an answer this
    // route never gives this request).
    if (answer.ok && answer.status === 202 && answer.body.held === true) {
      onOutcome(
        outcome("held", t("erase_held"), { who: account, next: t("next_erase_held") })
      );
      setErasePending(true);
    } else if (answer.ok) {
      onOutcome(outcome("refused", t("erase_unconfirmed"), { who: account }));
    } else {
      onOutcome(refusedOutcome(answer.refusal, { who: account }));
    }
  }

  const facts: [string, React.ReactNode][] = [
    ...(showId
      ? ([[t("field_identity"), <IdDetail key="id" id={user.id} show />]] as [
          string,
          React.ReactNode,
        ][])
      : []),
    [t("field_email"), shownEmail(user)],
    [t("field_name"), shownName(user)],
    [t("field_role"), roleNow],
    // The role's stored name is a detail (SF-admin-042): only with "Show details".
    ...(showId
      ? ([[t("field_role_raw"), user.roleName]] as [string, React.ReactNode][])
      : []),
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
    <DetailPanel
      title={t("detail_named", { name: shownName(user) })}
      onClose={onClose}
      // Closed: focus returns to the row it was opened from.
      returnFocus={() => elementWith("data-open-row", user.id)}
    >
      <DetailFacts facts={facts} />

      <div className="mt-5 space-y-3 border-t border-gray-800 pt-4">
        {actionable && (
          <div className="flex flex-wrap items-end gap-2">
            {mayChangeRole && (
              <Field
                label={t("change_role_label")}
                error={roleProblem}
                className="flex-1 basis-40"
              >
                {(control) => (
                  <Select
                    {...control}
                    value={roleId}
                    disabled={asking !== null}
                    onChange={(e) => {
                      setRoleId(e.target.value);
                      setRoleProblem(null);
                    }}
                  >
                    {roles.map((r) => (
                      <option key={r.id} value={r.id}>
                        {readableRole(r.name, r.displayName)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            )}
            {/* Refused by the route without the permission: shown disabled, saying which. */}
            <GatedButton
              ref={roleButton}
              allowed={mayChangeRole}
              reason={needsPermission(USER_ROW_ACTION_PERMISSIONS.change_role)}
              className={BUTTON.primary}
              disabled={asking !== null}
              onClick={() => {
                if (roleId === user.roleId) setRoleProblem(t("change_role_same"));
                else setAsking("role");
              }}
            >
              {t("change_role_submit")}
            </GatedButton>
          </div>
        )}
        {mayChangeRole && asking === "role" && (
          <ConfirmStep
            action="users.change_role"
            title={t("confirm_role_title", { account })}
            confirmLabel={t("confirm_role_submit")}
            returnFocus={roleButton}
            busy={busy}
            onConfirm={() => void changeRole()}
            onCancel={() => setAsking(null)}
          >
            <p data-role-change="true">
              {t("confirm_role_change", { from: roleNow, to: roleNext })}
            </p>
          </ConfirmStep>
        )}

        {mayErase && erasePending && (
          <p
            data-erase-pending="true"
            className={`rounded-lg border px-3 py-2 text-sm ${TONE.held}`}
          >
            {t("erase_pending")}
          </p>
        )}
        {actionable && !erasePending && (
          <GatedButton
            ref={eraseButton}
            allowed={mayErase}
            reason={needsPermission(USER_ROW_ACTION_PERMISSIONS.erase_account)}
            className={BUTTON.quiet}
            disabled={asking !== null}
            onClick={() => setAsking("erase")}
          >
            {t("erase")}
          </GatedButton>
        )}
        {mayErase && !erasePending && asking === "erase" && (
          <ConfirmStep
            action="users.erase"
            title={t("confirm_erase_title", { account })}
            confirmLabel={t("erase_confirm")}
            returnFocus={eraseButton}
            busy={busy}
            choiceLabel={t("erase_reason_label")}
            choices={PURGE_REASONS.map((reason) => ({
              value: reason,
              label: t(`erase_reason_${reason.replace(/-/g, "_")}`),
            }))}
            onConfirm={(given) => void erase(given.choice ?? "admin-action")}
            onCancel={() => setAsking(null)}
          >
            <p>{t("erase_warning")}</p>
          </ConfirmStep>
        )}

        {isSelf ? (
          <p className={`text-sm ${TEXT.quiet}`}>{t("self_row")}</p>
        ) : isProtected ? (
          <p className={`text-sm ${TEXT.quiet}`}>{t("protected_row")}</p>
        ) : null}
        <p className={`text-xs ${TEXT.faint}`}>{t("not_shown")}</p>
      </div>
    </DetailPanel>
  );
}
