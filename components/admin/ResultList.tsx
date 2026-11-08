"use client";

/**
 * components/admin/ResultList.tsx — the results of what an admin did, kept until dismissed
 * (TASK-202, N-62)
 *
 * A decision's or a change's result vanished after a few seconds and named the tool
 * ("update_config…"), not what changed. Each screen that changes something now lists its results
 * here: each says what it was and whether it took effect — applied, held for approval (by whom),
 * or not done (why) — and stays until its own Dismiss. The region is always rendered, so a screen
 * reader hears each result as it is added (a live region must exist before its text changes).
 *
 * @module components/admin
 */

import React from "react";
import { renderMessage } from "@/platform/errors/messages";

/** One result: applied, held for approval, or not done. */
export interface ShownResult {
  readonly id: number;
  readonly kind: "applied" | "held" | "refused";
  readonly text: string;
}

const STYLE: Record<ShownResult["kind"], string> = {
  applied: "border-green-700 bg-green-900/20 text-green-200",
  held: "border-blue-700 bg-blue-900/20 text-blue-100",
  refused: "border-amber-700 bg-amber-900/20 text-amber-200",
};

let nextId = 1;

/** A new result, with an id of its own (the list's key). */
export function result(kind: ShownResult["kind"], text: string): ShownResult {
  nextId += 1;
  return { id: nextId, kind, text };
}

export function ResultList({
  results,
  onDismiss,
  label,
}: {
  readonly results: readonly ShownResult[];
  readonly onDismiss: (id: number) => void;
  /** What the region holds, for a screen reader (the screen's own words). */
  readonly label: string;
}) {
  return (
    <div role="status" aria-live="polite" aria-label={label} className="mb-3 space-y-2">
      {results.map((r) => (
        <div
          key={r.id}
          data-result={r.kind}
          className={`flex items-start justify-between gap-3 rounded-xl border px-4 py-3 text-sm ${STYLE[r.kind]}`}
        >
          <span className="min-w-0 break-words">{r.text}</span>
          <button
            type="button"
            onClick={() => onDismiss(r.id)}
            className="shrink-0 text-xs text-gray-300 underline"
          >
            {renderMessage("screens.held.result_dismiss")}
          </button>
        </div>
      ))}
    </div>
  );
}
