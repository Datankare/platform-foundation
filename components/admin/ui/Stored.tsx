"use client";

/**
 * components/admin/ui/Stored.tsx — text a screen keeps exactly as it was stored or must be copied
 * exactly (TASK-221, SCREEN-FINDINGS P8)
 *
 * Two things on the console are shown character for character, in a fixed-width face, and are
 * never a screen's own words:
 *
 *   StoredText   a record's stored text from before the catalogue keys (a job's failure, a
 *                moderation reason): the evidence, behind a disclosure, after the catalogue's note
 *                that it predates them — never shown open as if it were the screen's sentence;
 *   SecretText   a value a person types into another app exactly (an authenticator's key): shown
 *                only when asked for, wrapping, selectable.
 *
 * Written here once so a screen never writes a code face of its own (the shared-parts guard,
 * __tests__/admin-shared-components-guard.test.ts, refuses one in a screen).
 *
 * @module components/admin/ui
 */

import React from "react";
import { TEXT } from "./tokens";

/** A stored text behind a disclosure: `show` is its summary's words ("Show what was stored"). */
export function StoredText({
  text,
  show,
}: {
  readonly text: string;
  readonly show: string;
}) {
  return (
    <details className="inline" data-stored-text="true">
      <summary className="inline cursor-pointer underline">{show}</summary>
      <span className={`block break-all font-mono text-xs ${TEXT.faint}`}>{text}</span>
    </details>
  );
}

/** A value to copy exactly, in a fixed-width face, wrapping anywhere. */
export function SecretText({
  value,
  id,
}: {
  readonly value: string;
  readonly id?: string;
}) {
  return (
    <span
      id={id}
      data-secret-text="true"
      className="break-all rounded bg-gray-800 px-1 font-mono text-sm text-white"
    >
      {value}
    </span>
  );
}
