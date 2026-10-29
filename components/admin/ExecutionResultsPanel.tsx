"use client";

import React from "react";
import { renderMessage } from "@/platform/errors/messages";
import {
  formatDate,
  fullTimestamp,
  readableRole,
  readableStatus,
} from "@/components/admin/admin-format";

/** A search's rows as the execute route returns them (handlers/shared.ts SearchTable). */
export interface SearchResultTable {
  table: string;
  columns: readonly string[];
  rows: readonly (readonly (string | number | boolean | null)[])[];
  /** How many rows matched before the limit. */
  matched?: number;
  /** The filters as the server validated them (TASK-190): the Users screen applies these. */
  filters?: Readonly<Record<string, string | number>>;
}

interface ExecutionResult {
  tool: string;
  success: boolean;
  /** Held for an approval: not done, and not failed (review 9 H1). */
  held?: boolean;
  result?: string;
  /** A search's rows (TASK-189): shown as a compact table under the result line. */
  table?: SearchResultTable;
  error?: string;
  /**
   * A users search the Users screen applied to its own list (TASK-190 — one list, not two): the
   * row says the matches are in the list below, with no second table and no count of its own
   * (round 1, item 2: the list is the one answer).
   */
  listed?: boolean;
  /** An earlier users search of the same plan on the Users screen (round 1, item 6): one line. */
  earlier?: boolean;
  /**
   * A refused or failed users search that left the list's filters in place (round 1, item 7):
   * those it had before the plan, or an earlier users search's of the same plan (round 2, N-3).
   */
  keptFilters?: "previous" | "earlier";
}

const t = (key: string, values?: Record<string, string | number>) =>
  renderMessage(`screens.admin_console.search.${key}`, values);

/** A column's heading from the catalog; a column the catalog does not name shows its name. */
function heading(column: string): string {
  const key = `screens.admin_console.search.columns.${column}`;
  const label = renderMessage(key);
  return label === key ? column : label;
}

/** The columns that hold a time: shown as "29 Oct 2026", the whole timestamp on hover. */
const DATE_COLUMNS: ReadonlySet<string> = new Set([
  "created_at",
  "last_sign_in_at",
  "status_until",
  "updated_at",
]);

/**
 * The id column — hidden unless "Show details" is on (TASK-190: the owner's decision; only admins
 * and super-admins are offered the toggle, and only they are sent the column: round 1, S-L1).
 * Only `id` (round 1, item 4): another `*_id` — an audit entry's actor and target — is shown as
 * the Audit log page shows it, its first 8 characters with the whole id on hover.
 */
export const isIdColumn = (column: string): boolean => column === "id";

/** A reference to another row (actor_id, target_id): shown short, as on the Audit log page. */
const isReferenceColumn = (column: string): boolean =>
  column !== "id" && column.endsWith("_id");

type Cell = string | number | boolean | null;

/**
 * A cell as text, and its tooltip. Yes/no only for a true boolean (a column such as
 * email_verified): a JSON value (a config value) arrives as its JSON text from the server, so
 * `true` and "true" differ. Readable as the Users screen (TASK-190): a time as "29 Oct 2026" with
 * the whole timestamp in the tooltip; a users row's role by its readable display name
 * ("Moderator") and its standing capitalised ("Active").
 */
export function shownCell(
  table: string,
  column: string,
  value: Cell
): { text: string; title: string } {
  if (value === null) return { text: t("none"), title: t("none") };
  if (typeof value === "boolean") {
    const text = value ? t("yes") : t("no");
    return { text, title: text };
  }
  const raw = String(value);
  if (DATE_COLUMNS.has(column) && typeof value === "string") {
    return { text: formatDate(value), title: fullTimestamp(value) };
  }
  if (isReferenceColumn(column) && typeof value === "string") {
    return { text: value.slice(0, 8), title: value };
  }
  if (table === "users" && column === "role") {
    // The cell holds the role's display name, else its stored name: read as the Users list reads
    // a role with no display name ("qa_lead" → "Qa lead"; round 1, item 3).
    return { text: readableRole(raw, null), title: raw };
  }
  if (table === "users" && column === "status") {
    const text = readableStatus(raw);
    return { text, title: text };
  }
  return { text: raw, title: raw };
}

/**
 * A search's rows as a table (TASK-189) — before, one JSON text of every column. Only the
 * columns the server returned (its allowlist); wide or long results scroll inside the panel,
 * and a long value is cut to its column with the whole value on hover.
 */
export function SearchResultGrid({
  table,
  showIds = false,
}: {
  readonly table: SearchResultTable;
  /** "Show details": the id columns are shown too (hidden by default, TASK-190). */
  readonly showIds?: boolean;
}) {
  // No rows: the result line says so.
  if (table.rows.length === 0) return null;
  // The columns shown, by their index in each row: the ids only with "Show details".
  const shown = table.columns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => showIds || !isIdColumn(column));
  return (
    <div className="mt-2 max-h-80 overflow-auto rounded border border-gray-800">
      <table
        className="w-full text-xs text-left border-collapse"
        aria-label={t("table_label", { table: table.table })}
      >
        <thead>
          <tr>
            {shown.map(({ column }) => (
              <th
                key={column}
                scope="col"
                className="sticky top-0 bg-[#0a0f1e] text-gray-400 font-medium py-1 px-2 border-b border-gray-800 whitespace-nowrap"
              >
                {heading(column)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, i) => (
            <tr key={i}>
              {shown.map(({ column, index }) => {
                const cell = shownCell(table.table, column, row[index] ?? null);
                return (
                  <td
                    key={column}
                    className="py-1 px-2 border-b border-gray-800/50 text-gray-300 align-top"
                  >
                    {/* A long value is cut to the column, in full on hover (round 1: a table
                        cell ignores max-width, so the cut is on an inner block). */}
                    <div
                      className="max-w-xs truncate whitespace-nowrap"
                      title={cell.title}
                    >
                      {cell.text}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface ExecutionResultsPanelProps {
  results: ExecutionResult[];
  onDismiss: () => void;
  /** "Show details" (admins only): a search's id columns are shown. */
  showIds?: boolean;
}

/**
 * Shows execution results in a clean table format.
 * No raw JSON — structured display with status indicators.
 */
export default function ExecutionResultsPanel({
  results,
  onDismiss,
  showIds = false,
}: ExecutionResultsPanelProps) {
  const allSuccess = results.every((r) => r.success);

  return (
    <div
      className={`rounded-xl border p-5 mb-6 ${
        allSuccess
          ? "bg-green-900/10 border-green-800"
          : "bg-amber-900/10 border-amber-800"
      }`}
    >
      <p className="text-xs text-gray-400 uppercase tracking-wider mb-3">
        Execution Results
      </p>
      <div className="bg-[#0a0f1e] rounded-lg overflow-hidden">
        <table className="w-full text-sm text-left border-collapse">
          <thead>
            <tr>
              <th className="text-xs text-gray-400 uppercase py-2 px-3 border-b border-gray-800 w-8">
                Status
              </th>
              <th className="text-xs text-gray-400 uppercase py-2 px-3 border-b border-gray-800 w-40">
                Action
              </th>
              <th className="text-xs text-gray-400 uppercase py-2 px-3 border-b border-gray-800">
                Result
              </th>
            </tr>
          </thead>
          <tbody>
            {results.map((r, i) => (
              <tr key={i}>
                <td className="py-2 px-3 border-b border-gray-800/50">
                  <span
                    className={
                      r.success
                        ? "text-green-400"
                        : r.held
                          ? "text-amber-400"
                          : "text-red-400"
                    }
                  >
                    {r.success ? "✓" : r.held ? "…" : "✕"}
                  </span>
                </td>
                <td className="py-2 px-3 border-b border-gray-800/50">
                  <code
                    className={`text-xs px-1.5 py-0.5 rounded ${
                      r.success
                        ? "bg-green-900/20 text-green-400"
                        : "bg-red-900/20 text-red-400"
                    }`}
                  >
                    {r.tool}
                  </code>
                </td>
                <td className="py-2 px-3 border-b border-gray-800/50 text-sm text-gray-300">
                  {r.success && r.listed && r.table ? (
                    // One list, not two (TASK-190): the Users screen's list shows the matches —
                    // and counts them itself (round 1, item 2).
                    t("users_in_list")
                  ) : r.success && r.earlier && r.table ? (
                    // An earlier users search of the plan: the last one drives the list (item 6).
                    t("users_earlier", {
                      matched: r.table.matched ?? r.table.rows.length,
                    })
                  ) : (
                    <>
                      {r.success || r.held ? (r.result ?? r.error) : r.error}
                      {!r.success && r.keptFilters
                        ? ` ${t(r.keptFilters === "earlier" ? "users_kept_earlier" : "users_kept_filters")}`
                        : null}
                      {r.success && r.table ? (
                        <SearchResultGrid table={r.table} showIds={showIds} />
                      ) : null}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        onClick={onDismiss}
        className="mt-3 text-sm text-gray-400 hover:text-gray-300 transition"
      >
        Dismiss
      </button>
    </div>
  );
}
