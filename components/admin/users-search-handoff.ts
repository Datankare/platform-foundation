/**
 * components/admin/users-search-handoff.ts — A command-bar users search, handed to the Users
 * screen's list (TASK-190)
 *
 * Client-safe. The console page calls applyUsersSearch with the execute route's results.
 *
 * @module components/admin
 */

import type { AdminSection } from "@/components/admin/AdminShell";
import { listFilters, type UserListFilters } from "@/components/admin/UsersPanel";
import type { SearchResultTable } from "@/components/admin/ExecutionResultsPanel";

/** One action's result as the execute route returns it (the fields the page reads). */
export interface ExecutedResult {
  tool: string;
  success: boolean;
  held?: boolean;
  result?: string;
  table?: SearchResultTable;
  error?: string;
  /** A users search applied to the Users screen's list: no second table. */
  listed?: boolean;
  /** An earlier users search of the same plan (round 1, item 6): a one-line summary. */
  earlier?: boolean;
  /**
   * A refused or failed users search; the list keeps the filters it shows (round 1, item 7):
   * "previous" — those it had before the plan; "earlier" — an earlier users search of the same
   * plan's (round 2, N-3: the row says which). Not set when the search the list shows came later
   * in the plan (TASK-192): that search's own row says it is shown.
   */
  keptFilters?: KeptFilters;
}

/** Which filters a refused users search left the list showing. */
export type KeptFilters = "previous" | "earlier";

/** A confirmed action as the page sent it (the execute route's results follow its order). */
export interface SentAction {
  readonly tool: string;
  readonly input?: Readonly<Record<string, unknown>>;
}

const isUsersSearch = (action: SentAction | undefined): boolean =>
  action?.tool === "search" && action.input?.table === "users";

/**
 * One list, not two (TASK-190 — the owner's live check of "show moderators" on Users: the results
 * box drew its own table while the list below still showed everyone). Run on the Users screen,
 * the last users search that succeeded hands its filters to the list — the filters as the server
 * validated and applied them (`table.filters` of the execute response), never the planner's
 * input — and its row is marked `listed`. Elsewhere, or for any other table, nothing changes.
 *
 * Round 1: an earlier users search of the same plan is marked `earlier` (one line, no table —
 * item 6); a users search that was refused or failed (known by the action sent at its index: the
 * execute route answers in the plan's order) hands nothing over, and when the list still shows
 * filters its row is marked `keptFilters` so it says so (item 7): "earlier" only when the users
 * search the list shows ran before it (TASK-192); one that ran after it says so on its own row.
 * `current` is the list's filters now.
 */
export function applyUsersSearch(
  section: AdminSection | null,
  results: readonly ExecutedResult[],
  actions: readonly SentAction[] = [],
  current: UserListFilters = {}
): { results: ExecutedResult[]; filters: UserListFilters | null } {
  if (section !== "users") return { results: [...results], filters: null };
  let last = -1;
  results.forEach((r, i) => {
    if (r.tool === "search" && r.success && r.table?.table === "users") last = i;
  });
  const filters =
    last < 0
      ? null
      : (Object.fromEntries(
          listFilters(results[last]!.table!.filters as UserListFilters | undefined)
        ) as UserListFilters);
  const shownAfter = listFilters(filters ?? current).length > 0;
  return {
    results: results.map((r, i) => {
      if (r.tool === "search" && r.success && r.table?.table === "users") {
        return i === last ? { ...r, listed: true } : { ...r, earlier: true };
      }
      if (r.tool === "search" && !r.success && !r.held && isUsersSearch(actions[i])) {
        if (!shownAfter) return r;
        // A users search succeeded after this one (TASK-192): the list shows that later search's
        // filters and its own row says so ("shown in the list below") — nothing to add here.
        if (last > i) return r;
        return { ...r, keptFilters: last < 0 ? "previous" : "earlier" };
      }
      return r;
    }),
    filters,
  };
}

/**
 * The results once the list's filters were changed on the Users screen — a chip removed, or
 * "Clear all" (round 1, item 1): the users search's row that said "shown in the list below" no
 * longer describes the list, so it is dismissed, and a row saying the list kept its filters no
 * longer says so. Nothing left: null (the panel closes).
 */
export function afterFiltersChanged(
  results: readonly ExecutedResult[] | null
): ExecutedResult[] | null {
  if (!results) return null;
  const left = results
    .filter((r) => !r.listed)
    .map((r) => (r.keptFilters ? { ...r, keptFilters: undefined } : r));
  return left.length ? left : null;
}

/**
 * The results as a section shows them: a users search is "in the list below", an earlier one or a
 * kept-filters note means anything, only on the Users screen — elsewhere each row is as it ran.
 */
export function resultsFor<R extends ExecutedResult>(
  section: AdminSection,
  results: readonly R[]
): R[] {
  return section === "users"
    ? [...results]
    : results.map((r) => ({
        ...r,
        listed: false,
        earlier: false,
        keptFilters: undefined,
      }));
}
