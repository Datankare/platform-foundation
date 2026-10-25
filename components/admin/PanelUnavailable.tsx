"use client";

/**
 * components/admin/PanelUnavailable.tsx — An admin panel whose data could not be read
 * (review 14 L-1)
 *
 * A panel's read that the server answered 503 ("service.unavailable": the store is down, or the
 * stored value is not well formed) was shown as an empty list — "No agents registered" for a
 * registry that could not be read. It is now shown as what it is: unavailable, could not read,
 * nothing changed, with a way to try again. Every string is from the catalog (messages/en.json,
 * screens.admin_console).
 */

import React from "react";
import { renderMessage } from "@/platform/errors/messages";

/** The data a panel holds when its read was answered 503. */
export const PANEL_UNAVAILABLE = Object.freeze({ unavailable: true as const });
export type PanelUnavailableData = typeof PANEL_UNAVAILABLE;

/** Whether a panel's data is the "could not be read" marker. */
export function isPanelUnavailable(data: unknown): data is PanelUnavailableData {
  return (
    !!data &&
    typeof data === "object" &&
    (data as { unavailable?: unknown }).unavailable === true
  );
}

export function PanelUnavailable({
  panel,
  onRetry,
}: {
  /** The panel's name, as its heading shows it. */
  readonly panel: string;
  readonly onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="rounded-xl border border-red-800 bg-red-950/40 p-4 text-sm text-red-200"
    >
      <p className="font-semibold">
        {renderMessage("screens.admin_console.unavailable_title")}
      </p>
      <p className="mt-1 text-red-100">
        {renderMessage("screens.admin_console.unavailable_body", { panel })}
      </p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          aria-label={renderMessage("screens.admin_console.retry_label", { panel })}
          className="mt-3 rounded bg-red-800 px-3 py-1 text-white hover:bg-red-700"
        >
          {renderMessage("screens.admin_console.retry")}
        </button>
      )}
    </div>
  );
}
