"use client";

import React from "react";
import { renderMessage } from "@/platform/errors/messages";

/** A search's rows as the execute route returns them (handlers/shared.ts SearchTable). */
export interface SearchResultTable {
  table: string;
  columns: readonly string[];
  rows: readonly (readonly (string | number | boolean | null)[])[];
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
}

const t = (key: string, values?: Record<string, string | number>) =>
  renderMessage(`screens.admin_console.search.${key}`, values);

/** A column's heading from the catalog; a column the catalog does not name shows its name. */
function heading(column: string): string {
  const key = `screens.admin_console.search.columns.${column}`;
  const label = renderMessage(key);
  return label === key ? column : label;
}

/**
 * A cell as text. Yes/no only for a true boolean (a column such as email_verified): a JSON value
 * (a config value) arrives as its JSON text from the server, so `true` and "true" differ.
 */
function shownCell(value: string | number | boolean | null): string {
  if (value === null) return t("none");
  if (typeof value === "boolean") return value ? t("yes") : t("no");
  return String(value);
}

/**
 * A search's rows as a table (TASK-189) — before, one JSON text of every column. Only the
 * columns the server returned (its allowlist); wide or long results scroll inside the panel,
 * and a long value is cut to its column with the whole value on hover.
 */
export function SearchResultGrid({ table }: { readonly table: SearchResultTable }) {
  // No rows: the result line says so.
  if (table.rows.length === 0) return null;
  return (
    <div className="mt-2 max-h-80 overflow-auto rounded border border-gray-800">
      <table
        className="w-full text-xs text-left border-collapse"
        aria-label={t("table_label", { table: table.table })}
      >
        <thead>
          <tr>
            {table.columns.map((column) => (
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
              {row.map((value, j) => (
                <td
                  key={j}
                  className="py-1 px-2 border-b border-gray-800/50 text-gray-300 align-top"
                >
                  {/* A long value is cut to the column, in full on hover (round 1: a table
                      cell ignores max-width, so the cut is on an inner block). */}
                  <div
                    className="max-w-xs truncate whitespace-nowrap"
                    title={shownCell(value)}
                  >
                    {shownCell(value)}
                  </div>
                </td>
              ))}
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
}

/**
 * Shows execution results in a clean table format.
 * No raw JSON — structured display with status indicators.
 */
export default function ExecutionResultsPanel({
  results,
  onDismiss,
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
                  {r.success || r.held ? (r.result ?? r.error) : r.error}
                  {r.success && r.table ? <SearchResultGrid table={r.table} /> : null}
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
