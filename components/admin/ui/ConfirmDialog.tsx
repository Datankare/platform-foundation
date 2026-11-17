"use client";

/**
 * components/admin/ui/ConfirmDialog.tsx — the one confirmation dialog, for the console and the
 * user's screens alike (TASK-216; made the shared part of both by TASK-224)
 *
 * The console's confirm step (./ConfirmStep.tsx) takes what it asks, and how gravely, from the
 * console's confirmation registry. A person's own screens — deleting their account, turning off
 * two-step verification, a staff member's decision on a held step — ask the same way but name
 * their own action, so the dialog itself is here, without the registry:
 *
 *   - it is an alertdialog that takes focus when it opens and gives it back to where it came
 *     from when it closes; Escape is Cancel;
 *   - an action that cannot be undone is marked so in words and in red, and its button is the
 *     danger button;
 *   - the button names the action ("Delete my account"), never a bare "Confirm";
 *   - what the action does to the person is said before the button (`consequence`);
 *   - fields the action needs (a reason, a password) go in `fields`, between the words and the
 *     buttons.
 *
 * Class lists from the one set of tokens; every word is the caller's or the catalogue's.
 *
 * @module components/admin/ui
 */

import React, { useEffect, useId, useRef } from "react";
import { renderMessage } from "@/platform/errors/messages";
import { BUTTON } from "./tokens";

const t = (key: string) => renderMessage(`screens.admin_console.confirm.${key}`);

/** How grave an action is: what the dialog marks and which button it uses. */
export type ConfirmRisk = "irreversible" | "consequential" | "ordinary";

export interface ConfirmDialogProps {
  /** A name for the action, for tests and the walk (`data-confirm`). */
  readonly id: string;
  readonly risk: ConfirmRisk;
  /** What will be done, naming this instance: "Delete the account ann@example.com". */
  readonly title: string;
  /** The change itself, under the title. */
  readonly children?: React.ReactNode;
  /** What the action does to people — and, when it cannot be undone, what is lost. */
  readonly consequence?: string | null;
  /** Fields the action needs, between the words and the buttons. */
  readonly fields?: React.ReactNode;
  /** The button's words: the action's name. */
  readonly confirmLabel: string;
  readonly busy?: boolean;
  /**
   * What opened the dialog: focus goes back to it when the dialog closes. Without it, focus goes
   * back to what held it when the dialog opened.
   */
  readonly returnFocus?: React.RefObject<HTMLElement | null>;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export function ConfirmDialog({
  id,
  risk,
  title,
  children,
  consequence,
  fields,
  confirmLabel,
  busy = false,
  returnFocus,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const irreversible = risk === "irreversible";
  const titleId = useId();
  const bodyId = useId();
  const box = useRef<HTMLDivElement>(null);

  // Focus in when it opens, and back to where it came from when it closes. The opener is read
  // when the dialog closes (it is the screen's own button, there before and after the dialog).
  const opener = useRef(() => returnFocus?.current ?? null);
  useEffect(() => {
    const from = document.activeElement as HTMLElement | null;
    const openerNow = opener.current;
    box.current?.focus();
    return () => {
      const back = openerNow() ?? from;
      if (back && back.isConnected) back.focus();
    };
  }, []);

  return (
    <div
      ref={box}
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      tabIndex={-1}
      data-confirm={id}
      data-risk={risk}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !busy) {
          e.stopPropagation();
          onCancel();
        }
      }}
      className={`space-y-3 rounded-lg border p-4 text-sm focus:outline-none ${
        irreversible
          ? "border-red-700 bg-red-950/40 text-red-100"
          : "border-blue-700 bg-blue-900/20 text-blue-100"
      }`}
    >
      <p id={titleId} className="font-semibold">
        {title}
      </p>
      <div id={bodyId} className="space-y-2">
        {irreversible && (
          <p data-irreversible="true">
            <strong className="font-semibold">{t("irreversible")}</strong>
          </p>
        )}
        {children}
        {consequence && <p data-consequence="true">{consequence}</p>}
      </div>
      {fields}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={irreversible ? BUTTON.danger : BUTTON.primary}
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? t("working") : confirmLabel}
        </button>
        <button type="button" className={BUTTON.quiet} disabled={busy} onClick={onCancel}>
          {t("cancel")}
        </button>
      </div>
    </div>
  );
}
