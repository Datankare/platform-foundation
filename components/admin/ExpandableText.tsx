"use client";

/**
 * components/admin/ExpandableText.tsx — a long cell, cut to its column, shown whole on request
 * (TASK-202, N-64)
 *
 * Table cells were cut with "…" and the whole value was only in a tooltip, which a touch screen
 * and a keyboard never show. A value longer than `limit` characters is shown cut, with a button
 * that shows all of it (and back); the text wraps inside its cell, so a table never widens the
 * page.
 *
 * @module components/admin
 */

import React, { useState } from "react";
import { renderMessage } from "@/platform/errors/messages";

/** How many characters a cell shows before it is cut. */
export const CELL_LIMIT = 80;

export function ExpandableText({
  text,
  column,
  limit = CELL_LIMIT,
  mono = false,
  title,
}: {
  readonly text: string;
  /** A tooltip for the text (a time's whole timestamp, say). */
  readonly title?: string;
  /** The column's name, for the button's label ("Show the whole Details"). */
  readonly column: string;
  readonly limit?: number;
  readonly mono?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const cls = `break-words whitespace-pre-wrap ${mono ? "font-mono text-xs" : ""}`;
  if ([...text].length <= limit)
    return (
      <span className={cls} title={title}>
        {text}
      </span>
    );
  const shown = open ? text : `${[...text].slice(0, limit).join("")}…`;
  return (
    <span className={cls} title={title}>
      {shown}{" "}
      <button
        type="button"
        aria-expanded={open}
        aria-label={renderMessage(
          `screens.admin_console.cell.${open ? "less_label" : "more_label"}`,
          { column }
        )}
        onClick={() => setOpen((o) => !o)}
        className="text-xs text-blue-300 underline"
      >
        {renderMessage(`screens.admin_console.cell.${open ? "less" : "more"}`)}
      </button>
    </span>
  );
}
