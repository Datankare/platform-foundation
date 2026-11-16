"use client";

/**
 * components/admin/ui/DetailPanel.tsx — where a row's detail opens, the same on every screen
 * (TASK-216, SCREEN-FINDINGS P11)
 *
 * A row's detail opened below the list on one screen, above it on another, at the bottom of the
 * page on a third — far from the row, with focus left behind. One placement:
 *
 *   wide (the console's content at 1280 px and up)   beside the list, staying in view while
 *                                                    the list scrolls; the list stays usable;
 *   narrow                                           in place of the list — the row's detail is
 *                                                    what the screen shows, with Close leading
 *                                                    back to the list where it was.
 *
 * Either way it is a labelled region whose heading takes focus when it opens (so it is in view
 * and announced), Escape is Close, and closing gives focus back to what opened it.
 *
 * @module components/admin/ui
 */

import React, { useEffect, useId, useRef } from "react";
import { renderMessage } from "@/platform/errors/messages";
import { BUTTON, FOCUS_TARGET, SURFACE, TEXT } from "./tokens";

/** The list with its detail: side by side when wide, the detail alone when narrow. */
export function DetailLayout({
  detail,
  children,
}: {
  /** The open detail panel, or null when none is open. */
  readonly detail: React.ReactNode | null;
  readonly children: React.ReactNode;
}) {
  const open = detail !== null && detail !== undefined && detail !== false;
  return (
    <div
      data-detail-open={open ? "true" : "false"}
      className={
        open
          ? "grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_22rem] xl:items-start"
          : "min-w-0"
      }
    >
      <div className={`min-w-0 ${open ? "hidden xl:block" : ""}`} data-detail-list="true">
        {children}
      </div>
      {open ? <div className="min-w-0 xl:sticky xl:top-4">{detail}</div> : null}
    </div>
  );
}

export function DetailPanel({
  title,
  onClose,
  returnFocus,
  children,
}: {
  readonly title: string;
  readonly onClose: () => void;
  /**
   * What opened the panel (the row's own button), found when the panel closes: focus goes back
   * to it. Without it, focus goes back to what held it when the panel opened.
   */
  readonly returnFocus?: () => HTMLElement | null;
  readonly children: React.ReactNode;
}) {
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  // Opened: focus moves to the heading — into view, and announced. Closed: back to the opener.
  const opener = useRef(returnFocus);
  useEffect(() => {
    const from = document.activeElement as HTMLElement | null;
    const find = opener.current;
    heading.current?.focus();
    return () => {
      // After the list is shown again (narrow) — the opener is back in the page by then.
      setTimeout(() => {
        const back = find?.() ?? from;
        if (back && back.isConnected) back.focus();
      }, 0);
    };
  }, []);
  return (
    <section
      aria-labelledby={titleId}
      data-detail-panel="true"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) onClose();
      }}
      className={`${SURFACE.panel} min-w-0 p-4`}
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <h3
          id={titleId}
          ref={heading}
          tabIndex={-1}
          className={`min-w-0 break-words text-lg font-semibold ${TEXT.strong} ${FOCUS_TARGET}`}
        >
          {title}
        </h3>
        <button type="button" className={`shrink-0 ${BUTTON.quiet}`} onClick={onClose}>
          {renderMessage("screens.admin_console.ui.detail_close")}
        </button>
      </div>
      {children}
    </section>
  );
}

/** The detail's facts: a name and its value per line, wrapping at words. */
export function DetailFacts({
  facts,
}: {
  readonly facts: readonly (readonly [string, React.ReactNode])[];
}) {
  return (
    <dl className="grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
      {facts.map(([label, value]) => (
        <React.Fragment key={label}>
          <dt className={TEXT.faint}>{label}</dt>
          <dd className={`min-w-0 break-words ${TEXT.body}`}>{value}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}
