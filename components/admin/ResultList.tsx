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
import { OutcomeList } from "@/components/admin/ui/Outcome";

/** One result: applied, held for approval, or not done. */
export interface ShownResult {
  readonly id: number;
  readonly kind: "applied" | "held" | "refused";
  readonly text: string;
}

let nextId = 1_000_000;

/** A new result, with an id of its own (the list's key). */
export function result(kind: ShownResult["kind"], text: string): ShownResult {
  nextId += 1;
  return { id: nextId, kind, text };
}

/**
 * The screens that list their results here are shown by the console's one outcome display
 * (components/admin/ui/Outcome.tsx, TASK-216): this is its older name and shape, kept for the
 * screens passes 56d-2 and 56d-3 move onto it directly.
 */
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
    <OutcomeList
      outcomes={results.map((r) => ({ id: r.id, tone: r.kind, text: r.text }))}
      onDismiss={onDismiss}
      label={label}
      // These screens place focus themselves (their confirm steps); the list only announces.
      focusNewest={false}
    />
  );
}
