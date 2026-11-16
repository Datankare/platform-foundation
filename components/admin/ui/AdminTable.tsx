"use client";

/**
 * components/admin/ui/AdminTable.tsx — the one table of the admin console (TASK-216,
 * SCREEN-FINDINGS P1, P9)
 *
 * Sixteen tables were built by hand, and each made its own mistakes: wider than the window, a
 * hex id as the first column, a date as its ISO text, no caption, no header scope. This one:
 *
 *   - scrolls inside its own card and never widens the page: the card is a labelled region a
 *     keyboard can reach and scroll, and every cell wraps at words;
 *   - has a caption (for assistive technology) and `scope` on every header;
 *   - writes dates the console's one way (admin-format: "26 Oct 2026", the whole timestamp in
 *     UTC on hover; "Never" or a dash for none), and cuts a long value to its column with a
 *     "more" button that shows all of it;
 *   - hides an id column unless "Show details" is on;
 *   - sorts where the route sorts (a labelled choice, sent to the server) or, for a list read
 *     whole, by a column's header (aria-sort); pages where the route pages, saying "1–25 of 312"
 *     when the route counts and "1–25" when it does not;
 *   - says its own "nothing here" inside the card;
 *   - leaves out the columns marked secondary while a detail panel is open beside it.
 *
 * @module components/admin/ui
 */

import React, { useMemo, useState } from "react";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import { ExpandableText } from "@/components/admin/ExpandableText";
import {
  formatDate,
  formatDateTime,
  fullTimestamp,
} from "@/components/admin/admin-format";
import { Field, Select } from "./Field";
import { BUTTON, FOCUS_RING, SURFACE, TEXT } from "./tokens";

const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.admin_console.ui.table.${key}`, values);

export interface Column<R> {
  readonly id: string;
  readonly header: string;
  /**
   * What the cell holds: a node of the screen's own (`cell`), or a value the table writes —
   * text (cut when long), a date, a date and time, or an id (hidden unless details are shown).
   */
  readonly kind?: "text" | "date" | "datetime" | "id";
  readonly value?: (row: R) => string | null | undefined;
  readonly cell?: (row: R) => React.ReactNode;
  /** Left out while a detail panel is open beside the table (`compact`). */
  readonly secondary?: boolean;
  /** For a list read whole: the header sorts by this. */
  readonly sortBy?: (row: R) => string | number | null;
  /** A tooltip for the cell (a role's stored name is not one: details only). */
  readonly title?: (row: R) => string | undefined;
}

export interface ServerSort {
  readonly label: string;
  readonly options: readonly { readonly id: string; readonly label: string }[];
  readonly value: string;
  readonly onChange: (id: string) => void;
}

export interface Paging {
  readonly offset: number;
  readonly size: number;
  /** Rows on this page. */
  readonly shown: number;
  readonly hasMore: boolean;
  /** How many match in all, when the route counts them. */
  readonly total?: number | null;
  /** The route stopped counting at `total`: "of more than". */
  readonly totalCapped?: boolean;
  readonly busy?: boolean;
  readonly onPage: (offset: number) => void;
}

/** "1–25 of 312", or "1–25" when the route does not count. */
export function pageRange(
  page: Pick<Paging, "offset" | "shown" | "total" | "totalCapped">
): string {
  const from = page.shown ? page.offset + 1 : page.offset;
  const to = page.offset + page.shown;
  return typeof page.total === "number"
    ? t(page.totalCapped ? "range_of_more" : "range_of", { from, to, total: page.total })
    : t("range", { from, to });
}

function written<R>(column: Column<R>, row: R): React.ReactNode {
  if (column.cell) return column.cell(row);
  const value = column.value?.(row) ?? null;
  // A date is a <time> (its machine-readable value beside the words), the whole UTC timestamp on
  // hover (TASK-220: the Roles and Audit dates kept their <time>).
  if (column.kind === "date")
    return value ? (
      <time dateTime={value} title={fullTimestamp(value)}>
        {formatDate(value)}
      </time>
    ) : (
      <span>{t("never")}</span>
    );
  if (column.kind === "datetime")
    return value ? (
      <time dateTime={value} title={fullTimestamp(value)}>
        {formatDateTime(value)}
      </time>
    ) : (
      <span>{formatDateTime(value)}</span>
    );
  if (value === null || value === "") return t("none");
  // An id is shown whole, when it is shown at all: "Show details" asked for it. It wraps.
  if (column.kind === "id")
    return <span className="break-all font-mono text-xs">{value}</span>;
  return (
    <ExpandableText text={value} column={column.header} title={column.title?.(row)} />
  );
}

export function AdminTable<R>({
  caption,
  columns,
  rows,
  rowKey,
  empty,
  showIds = false,
  compact = false,
  sort,
  page,
  selectedKey,
  onRowClick,
  dense = false,
}: {
  /** What the table lists: its accessible name. */
  readonly caption: string;
  readonly columns: readonly Column<R>[];
  readonly rows: readonly R[];
  readonly rowKey: (row: R, index: number) => string;
  /** The "nothing here" sentence; shown inside the card when there are no rows. */
  readonly empty?: string;
  /** "Show details": id columns are shown. */
  readonly showIds?: boolean;
  readonly compact?: boolean;
  readonly sort?: ServerSort;
  readonly page?: Paging;
  /** The row whose detail is open. */
  readonly selectedKey?: string | null;
  /**
   * A pointer's convenience: a click anywhere on the row. The row's own button (in one of its
   * cells) is what a keyboard and a screen reader use.
   */
  readonly onRowClick?: (row: R) => void;
  /** A table inside another display (a search's rows under its outcome). */
  readonly dense?: boolean;
}) {
  const shown = columns.filter(
    (c) => (c.kind !== "id" || showIds) && !(compact && c.secondary)
  );
  const [local, setLocal] = useState<{
    id: string;
    dir: "ascending" | "descending";
  } | null>(null);
  const ordered = useMemo(() => {
    const by = local ? columns.find((c) => c.id === local.id)?.sortBy : undefined;
    if (!local || !by) return rows;
    const sign = local.dir === "ascending" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = by(a);
      const y = by(b);
      if (x === y) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return (
        (typeof x === "number" && typeof y === "number"
          ? x - y
          : String(x).localeCompare(String(y))) * sign
      );
    });
  }, [rows, columns, local]);
  const pad = dense ? "px-2 py-1 text-xs" : "px-3 py-2.5 text-sm";

  return (
    <div className="min-w-0 space-y-3" data-admin-table="true">
      {sort && (
        <Field label={sort.label} className="max-w-xs">
          {(control) => (
            <Select
              {...control}
              value={sort.value}
              onChange={(e) => sort.onChange(e.target.value)}
            >
              {sort.options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      <div
        role="region"
        aria-label={caption}
        tabIndex={0}
        className={`max-w-full overflow-x-auto ${dense ? SURFACE.inset : SURFACE.panel} ${FOCUS_RING} ${dense ? "max-h-96 overflow-y-auto" : ""}`}
      >
        <table className="w-full border-collapse text-left">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              {shown.map((c) => {
                const dir = local?.id === c.id ? local.dir : undefined;
                return (
                  <th
                    key={c.id}
                    scope="col"
                    aria-sort={c.sortBy ? (dir ?? "none") : undefined}
                    className={`whitespace-nowrap border-b border-gray-800 text-xs font-medium ${TEXT.faint} ${dense ? "px-2 py-1" : "px-3 py-2.5"}`}
                  >
                    {c.sortBy ? (
                      <button
                        type="button"
                        className={`${BUTTON.link} text-gray-300`}
                        onClick={() =>
                          setLocal({
                            id: c.id,
                            dir: dir === "ascending" ? "descending" : "ascending",
                          })
                        }
                      >
                        {c.header}
                        <span aria-hidden="true">
                          {dir === "ascending" ? " ▲" : dir === "descending" ? " ▼" : ""}
                        </span>
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {ordered.map((row, i) => {
              const key = rowKey(row, i);
              const selected = selectedKey !== undefined && selectedKey === key;
              return (
                <tr
                  key={key}
                  aria-current={selected ? "true" : undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={`${selected ? "bg-blue-900/20" : ""} ${
                    onRowClick ? "cursor-pointer hover:bg-gray-800/40" : ""
                  }`}
                >
                  {shown.map((c) => (
                    <td
                      key={c.id}
                      className={`border-b border-gray-800/50 align-top break-words ${TEXT.quiet} ${pad}`}
                    >
                      <div
                        className={
                          c.kind === "date"
                            ? "whitespace-nowrap"
                            : "min-w-[5rem] max-w-xs"
                        }
                      >
                        {written(c, row)}
                      </div>
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && empty ? (
          <p
            data-table-empty="true"
            className={`px-4 py-8 text-center text-sm ${TEXT.quiet}`}
          >
            {empty}
          </p>
        ) : null}
      </div>
      {page && (page.offset > 0 || page.hasMore) ? (
        <nav
          aria-label={t("pager_label", { table: caption })}
          className={`flex flex-wrap items-center gap-3 text-sm ${TEXT.quiet}`}
        >
          <button
            type="button"
            className={BUTTON.quiet}
            disabled={page.busy || page.offset === 0}
            onClick={() => page.onPage(Math.max(0, page.offset - page.size))}
          >
            {t("previous")}
          </button>
          <span data-page-range="true">{pageRange(page)}</span>
          <button
            type="button"
            className={BUTTON.quiet}
            disabled={page.busy || !page.hasMore}
            onClick={() => page.onPage(page.offset + page.size)}
          >
            {t("next")}
          </button>
        </nav>
      ) : page && typeof page.total === "number" && page.shown > 0 ? (
        // One page: how many there are, with nothing to page through.
        <p data-page-range="true" className={`text-sm ${TEXT.quiet}`}>
          {pageRange(page)}
        </p>
      ) : null}
    </div>
  );
}
