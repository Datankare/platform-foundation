"use client";

import React from "react";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import { isShownText, renderShown, type ShownText } from "@/platform/errors/shown-text";
import { isErrorCode, messageKey, type ErrorCode } from "@/platform/errors/registry";
import { AdminTable, type Column } from "@/components/admin/ui/AdminTable";
import { OutcomeList, type OutcomeEntry } from "@/components/admin/ui/Outcome";
import {
  columnLabel,
  readableCode,
  tableLabel,
  toolLabel,
} from "@/components/admin/ui/labels";
import { IdDetail } from "@/components/admin/ui/Ref";
import type { Tone } from "@/components/admin/ui/tokens";
import { personText } from "@/components/admin/people";
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

export interface ExecutionResult {
  tool: string;
  success: boolean;
  /** Held for an approval: not done, and not failed (review 9 H1). */
  held?: boolean;
  /** The catalog's key and values (TASK-206, N-102). */
  result?: ShownText;
  /** A search's rows (TASK-189): shown as a compact table under the result line. */
  table?: SearchResultTable;
  error?: string;
  /**
   * A failure's code of the error-code contract, and its params (TASK-199): shown as its message.
   */
  code?: string;
  params?: Readonly<Record<string, unknown>>;
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
  /** The account the action acted on, by address (TASK-202, N-63): the execute route's. */
  account?: { readonly id: string; readonly email: string | null };
  /** The outcome's id, stamped by the page when the result arrives (newOutcomeId). */
  uid?: number;
  /** What became of it in the page's own words (a decision's outcome), used before the rest. */
  text?: string;
  /** What happens next, in the page's words (a decision's: TASK-216, E-2). */
  next?: string;
  /** Applied, and its record could not be stored: said as that, never as plain "done". */
  unrecorded?: boolean;
}

/**
 * A failure as the admin reads it (TASK-199; rebase round 2, finding 2): its code's catalog
 * message with its params; a refusal the page read (its `message`, the catalog's sentence
 * apiError rendered), as read; else the catalog's "Not done" (TASK-206, N-102).
 */
function failureText(r: ExecutionResult): string {
  if (r.text) return r.text;
  return r.code && isErrorCode(r.code)
    ? renderMessage(
        messageKey(r.code as ErrorCode),
        r.params ? ({ ...r.params } as MessageValues) : undefined
      )
    : (r.error ?? renderMessage("screens.admin_console.results.failed"));
}

/** What a done or held action did, in the catalog's words (TASK-206, N-102). */
function resultText(r: ExecutionResult): string {
  if (r.text) return r.text;
  if (isShownText(r.result)) return renderShown(r.result);
  return renderMessage(`screens.admin_console.results.${r.held ? "held" : "done"}`);
}

const t = (key: string, values?: Record<string, string | number>) =>
  renderMessage(`screens.admin_console.search.${key}`, values);

/** The columns that hold a time: shown as "29 Oct 2026", the whole timestamp on hover. */
const DATE_COLUMNS: ReadonlySet<string> = new Set([
  "created_at",
  "last_sign_in_at",
  "status_until",
  "updated_at",
]);

// An action's name in words: the labels' (TASK-216), re-exported where callers found it.
export { toolLabel };

/**
 * The id column — hidden unless "Show details" is on (TASK-190: the owner's decision; only admins
 * and super-admins are offered the toggle, and only they are sent the column: round 1, S-L1).
 */
export const isIdColumn = (column: string): boolean => column === "id";

/**
 * A reference to another row (actor_id, target_id): a detail, shown only with "Show details"
 * (TASK-216, SF-admin-024: it was shown to everyone whenever the table named no one). An audit
 * search names its actor and target by address in their own columns (N-63).
 */
const isReferenceColumn = (column: string): boolean =>
  column !== "id" && column.endsWith("_id");

type Cell = string | number | boolean | null | ShownText;

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
  // Words the server gives as the catalog's key (TASK-206, N-102: an erased account's name).
  if (isShownText(value)) {
    const text = renderShown(value);
    return { text, title: text };
  }
  if (typeof value === "boolean") {
    const text = value ? t("yes") : t("no");
    return { text, title: text };
  }
  const raw = String(value);
  if (DATE_COLUMNS.has(column) && typeof value === "string") {
    return { text: formatDate(value), title: fullTimestamp(value) };
  }
  if (isReferenceColumn(column) && typeof value === "string") {
    return { text: value, title: value };
  }
  if (table === "users" && column === "role") {
    // The cell holds the role's display name, else its stored name: read as the Users list reads
    // a role with no display name ("qa_lead" → "Qa lead"; round 1, item 3).
    return { text: readableRole(raw, null), title: raw };
  }
  // An audit entry's action is a stored code: by name (the Audit screen's own labels are pass
  // 56d-2's; until then the code made readable, never raw).
  if (table === "audit_log" && column === "action") {
    const text = readableCode(raw);
    return { text, title: text };
  }
  if (table === "users" && column === "status") {
    const text = readableStatus(raw);
    return { text, title: text };
  }
  return { text: raw, title: raw };
}

type Row = readonly Cell[];

/**
 * A search's rows (TASK-189), in the console's one table (TASK-216): only the columns the server
 * returned (its allowlist), each named from the catalogue — a column it does not name is made
 * readable, never shown as its stored name; ids and references only with "Show details".
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
  const columns: Column<Row>[] = table.columns.map((column, index) => {
    const header = columnLabel(column);
    if (isIdColumn(column) || isReferenceColumn(column))
      return {
        id: column,
        header,
        kind: "id",
        value: (row) => {
          const cell = row[index] ?? null;
          return cell === null ? null : shownCell(table.table, column, cell).text;
        },
      };
    return {
      id: column,
      header,
      value: (row) => shownCell(table.table, column, row[index] ?? null).text,
      title: (row) => shownCell(table.table, column, row[index] ?? null).title,
    };
  });
  return (
    <AdminTable
      dense
      caption={t("table_label", { table: tableLabel(table.table) })}
      columns={columns}
      rows={table.rows}
      rowKey={(_row, i) => String(i)}
      showIds={showIds}
    />
  );
}

interface ExecutionResultsPanelProps {
  results: ExecutionResult[];
  /** One result dismissed (its index); each stays until its own Dismiss. */
  onDismiss: (index: number) => void;
  /** "Show details" (admins only): a search's id columns are shown. */
  showIds?: boolean;
}

const r = (key: string) => renderMessage(`screens.admin_console.results.${key}`);

/** What became of one action, as the shared outcome display shows it. */
export function resultOutcome(
  result: ExecutionResult,
  showIds = false
): Omit<OutcomeEntry, "id"> {
  const tone: Tone = result.success
    ? result.unrecorded
      ? "unrecorded"
      : "applied"
    : result.held
      ? "held"
      : "refused";
  const name = toolLabel(result.tool);
  let said: string;
  let detail: React.ReactNode;
  if (result.success && result.listed && result.table) {
    // One list, not two (TASK-190): the Users screen's list shows the matches, and counts them.
    said = t("users_in_list");
  } else if (result.success && result.earlier && result.table) {
    // An earlier users search of the plan: the last one drives the list (item 6).
    said = t("users_earlier", {
      matched: result.table.matched ?? result.table.rows.length,
    });
  } else {
    said = result.success || result.held ? resultText(result) : failureText(result);
    if (!result.success && result.keptFilters)
      said += ` ${t(result.keptFilters === "earlier" ? "users_kept_earlier" : "users_kept_filters")}`;
    if (result.success && result.table)
      detail = <SearchResultGrid table={result.table} showIds={showIds} />;
  }
  const who = result.account ? personText({ email: result.account.email }) : undefined;
  const next =
    result.next ??
    (result.held ? r("next_held") : result.unrecorded ? r("next_unrecorded") : undefined);
  return {
    tone,
    action: name,
    text: said,
    ...(who ? { who } : {}),
    ...(who && showIds && result.account
      ? {
          whoDetail: <IdDetail id={result.account.id} show />,
        }
      : {}),
    ...(next ? { next } : {}),
    ...(detail ? { detail } : {}),
  };
}

/**
 * The command bar's results (TASK-216, SF-admin-021 to 024): each action's outcome in the shared
 * display — what it was, whether it took effect, for whom, what happens next — announced, focused
 * when it arrives, and kept until its own Dismiss.
 */
export default function ExecutionResultsPanel({
  results,
  onDismiss,
  showIds = false,
}: ExecutionResultsPanelProps) {
  // A result the page stamped keeps its outcome's id for as long as it is shown; one rendered
  // without (a test's) is told apart by its place.
  const entries = results.map((result, index) => ({
    id: result.uid ?? -(index + 1),
    ...resultOutcome(result, showIds),
  }));
  return (
    <OutcomeList
      outcomes={entries}
      label={r("title")}
      onDismiss={(id) => {
        const index = entries.findIndex((e) => e.id === id);
        if (index >= 0) onDismiss(index);
      }}
    />
  );
}
