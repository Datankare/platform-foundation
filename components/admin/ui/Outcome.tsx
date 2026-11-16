"use client";

/**
 * components/admin/ui/Outcome.tsx — what became of what an admin just did, kept until dismissed
 * (TASK-216, SCREEN-FINDINGS P3)
 *
 * Five screens showed an outcome five ways: a list, one line replaced by the next action, a
 * coloured box, a line under a row, nothing at all — and the command bar's turned amber, the
 * failure colour, for a change that was only waiting for an approver. One display:
 *
 *   - each outcome says what changed, for whom, and what happens next — "held for a second
 *     approver: nothing has changed yet", "applied, but its record could not be stored";
 *   - its standing is said in words, never by colour alone (1.4.1): Done, Held for approval,
 *     Done — not recorded, Not done, Note;
 *   - it stays until its own Dismiss; a later action adds to the list, it replaces nothing;
 *   - the region exists before anything is in it and is a polite live region, so each outcome is
 *     announced (4.1.3); focus moves to the newest one, so a keyboard user is where it appeared.
 *
 * @module components/admin/ui
 */

import React, { useEffect, useRef } from "react";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import type { Refusal } from "@/platform/errors/refusal";
import { RefusalExtras } from "./RefusalExtras";
import { BUTTON, FOCUS_TARGET, TONE, type Tone } from "./tokens";

const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.admin_console.ui.outcome.${key}`, values);

export interface OutcomeEntry {
  readonly id: number;
  readonly tone: Tone;
  /** What changed, or what was not done and why — a sentence that names the thing. */
  readonly text: string;
  /** What was asked for, by name ("Change an account's role"): shown before the outcome. */
  readonly action?: string;
  /** For whom: an account by name or address, a setting, a role. */
  readonly who?: string;
  /** A detail of whom (their id, while "Show details" is on). */
  readonly whoDetail?: React.ReactNode;
  /** What happens next, or what to do. */
  readonly next?: string;
  /** The refusal behind a refused outcome: what its kind needs besides its sentence is shown. */
  readonly refusal?: Refusal;
  /** More under the outcome (a search's rows). */
  readonly detail?: React.ReactNode;
}

let nextId = 1;

/** An id for an outcome a screen builds itself (a command-bar result, shown as an outcome). */
export function newOutcomeId(): number {
  nextId += 1;
  return nextId;
}

/** A new outcome, with an id of its own. */
export function outcome(
  tone: Tone,
  text: string,
  more: Omit<OutcomeEntry, "id" | "tone" | "text"> = {}
): OutcomeEntry {
  nextId += 1;
  return { id: nextId, tone, text, ...more };
}

/** A refused call as an outcome: its own sentence, and what the shared notice adds. */
export function refusedOutcome(
  refusal: Refusal,
  more: Omit<OutcomeEntry, "id" | "tone" | "text" | "refusal"> = {}
): OutcomeEntry {
  return outcome("refused", refusal.message, { ...more, refusal });
}

export function OutcomeList({
  outcomes,
  onDismiss,
  label,
  focusNewest = true,
}: {
  readonly outcomes: readonly OutcomeEntry[];
  readonly onDismiss: (id: number) => void;
  /** What the region holds, for a screen reader (the screen's own words). */
  readonly label: string;
  readonly focusNewest?: boolean;
}) {
  const items = useRef(new Map<number, HTMLDivElement>());
  const newest = outcomes.length ? outcomes[outcomes.length - 1]!.id : null;
  const focused = useRef<number | null>(null);
  useEffect(() => {
    if (!focusNewest || newest === null || focused.current === newest) return;
    focused.current = newest;
    items.current.get(newest)?.focus();
  }, [newest, focusNewest]);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label}
      data-outcomes="true"
      className={outcomes.length ? "mb-4 space-y-2" : undefined}
    >
      {outcomes.map((o) => (
        <div
          key={o.id}
          ref={(el) => {
            if (el) items.current.set(o.id, el);
            else items.current.delete(o.id);
          }}
          tabIndex={-1}
          data-outcome={o.tone}
          data-result={o.tone}
          className={`rounded-xl border px-4 py-3 text-sm ${TONE[o.tone]} ${FOCUS_TARGET}`}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-1 break-words">
              <p id={`outcome-${o.id}`}>
                <strong
                  className="mr-2 font-semibold after:content-[':']"
                  data-outcome-standing="true"
                >
                  {t(o.tone)}
                </strong>
                {o.action ? (
                  <span
                    className="mr-2 rounded bg-black/30 px-1.5 py-0.5 text-xs"
                    data-outcome-action="true"
                  >
                    {o.action}
                  </span>
                ) : null}
                <span>{o.text}</span>
              </p>
              {o.who ? (
                <p data-outcome-who="true">
                  <span>{t("for", { who: o.who })}</span>
                  {o.whoDetail ? <> {o.whoDetail}</> : null}
                </p>
              ) : null}
              {o.next ? (
                <p data-outcome-next="true">{t("next", { next: o.next })}</p>
              ) : null}
              {o.refusal ? <RefusalExtras refusal={o.refusal} /> : null}
            </div>
            <button
              type="button"
              onClick={() => onDismiss(o.id)}
              aria-describedby={`outcome-${o.id}`}
              className={`shrink-0 ${BUTTON.quiet}`}
            >
              {t("dismiss")}
            </button>
          </div>
          {o.detail ? <div className="mt-2 min-w-0">{o.detail}</div> : null}
        </div>
      ))}
    </div>
  );
}
