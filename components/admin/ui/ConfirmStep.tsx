"use client";

/**
 * components/admin/ui/ConfirmStep.tsx — the one confirmation step, with the one reason field
 * (TASK-216, SCREEN-FINDINGS P4 and P5)
 *
 * What it asks, and how gravely, comes from the confirmation registry — a screen passes the
 * action's id and the words that name this instance of it (whose role, from what, to what):
 *
 *   - it is an alertdialog that takes focus when it opens and gives it back to where it came
 *     from when it closes; Escape is Cancel;
 *   - an irreversible action is marked "Cannot be undone" in words and in red, says what will be
 *     lost, and its button is the danger button;
 *   - the button names the action ("Change role", "Erase account"), never a bare "Confirm";
 *   - when the registry asks for a reason there is one field: its minimum length is said before
 *     the mistake, and a reason too short is said at the field, not by a button that stays grey.
 *
 * @module components/admin/ui
 */

import React, { useEffect, useId, useRef, useState } from "react";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import {
  confirmationFor,
  REASON_MAX,
  REASON_MIN,
  type Confirmation,
} from "./confirmation-registry";
import { Field, Select, TextArea } from "./Field";
import { BUTTON } from "./tokens";

const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.admin_console.confirm.${key}`, values);

/** What an action does to people — and, when it cannot be undone, what is lost. */
export function consequenceText(confirmation: Confirmation): string | null {
  return confirmation.consequence ? t(`consequence.${confirmation.consequence}`) : null;
}

/** Why a typed reason is not accepted (null: it is). */
export function reasonProblem(confirmation: Confirmation, reason: string): string | null {
  const text = reason.trim();
  if (confirmation.reason === "none") return null;
  if (text === "" && confirmation.reason === "optional") return null;
  if ([...text].length < REASON_MIN) return t("reason_short", { min: REASON_MIN });
  return null;
}

export interface ConfirmedWith {
  /** The typed reason, trimmed ("" when none was asked or given). */
  readonly reason: string;
  /** The chosen kind of reason, when the step offered kinds. */
  readonly choice?: string;
}

export function ConfirmStep({
  action,
  input,
  heldTool,
  title,
  children,
  confirmLabel,
  busy = false,
  choices,
  choiceLabel,
  reasonLabel,
  returnFocus,
  onConfirm,
  onCancel,
}: {
  /** The action's id in the confirmation registry. */
  readonly action: string;
  readonly input?: Readonly<Record<string, unknown>>;
  /** A decision on a held change: the held change's tool (approving an erasure erases). */
  readonly heldTool?: string;
  /** What will be done, naming this instance: "Change ann@example.com's role". */
  readonly title: string;
  /** The change itself (from → to), under the title. */
  readonly children?: React.ReactNode;
  /** The button's words: the action's name. */
  readonly confirmLabel: string;
  readonly busy?: boolean;
  /** Kinds of reason to choose from (an erasure's), by label. */
  readonly choices?: readonly { readonly value: string; readonly label: string }[];
  readonly choiceLabel?: string;
  /** The reason field's own label, where the record names it (a moderator's "Reviewer notes"). */
  readonly reasonLabel?: string;
  /**
   * What opened the step: focus goes back to it when the step closes. Without it, focus goes
   * back to what held it when the step opened (a browser that does not focus a clicked button
   * — Safari — would otherwise lose the place).
   */
  readonly returnFocus?: React.RefObject<HTMLElement | null>;
  readonly onConfirm: (given: ConfirmedWith) => void;
  readonly onCancel: () => void;
}) {
  const confirmation = confirmationFor(action, input, heldTool);
  const irreversible = confirmation.risk === "irreversible";
  const consequence = consequenceText(confirmation);
  const titleId = useId();
  const bodyId = useId();
  const box = useRef<HTMLDivElement>(null);
  const reasonBox = useRef<HTMLTextAreaElement>(null);
  const [reason, setReason] = useState("");
  const [choice, setChoice] = useState(choices?.[0]?.value ?? "");
  const [problem, setProblem] = useState<string | null>(null);

  // Focus in when it opens, and back to where it came from when it closes. The opener is read
  // when the step closes (it is the screen's own button, there before and after the step).
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

  const confirm = () => {
    const bad = reasonProblem(confirmation, reason);
    setProblem(bad);
    if (bad) {
      reasonBox.current?.focus();
      return;
    }
    onConfirm({ reason: reason.trim(), ...(choices ? { choice } : {}) });
  };

  return (
    <div
      ref={box}
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      tabIndex={-1}
      data-confirm={action}
      data-risk={confirmation.risk}
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
      {choices && choices.length > 0 && (
        <Field label={choiceLabel ?? t("choice_label")}>
          {(control) => (
            <Select
              {...control}
              value={choice}
              disabled={busy}
              onChange={(e) => setChoice(e.target.value)}
            >
              {choices.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      {confirmation.reason !== "none" && (
        <Field
          label={
            reasonLabel ??
            t(confirmation.reason === "required" ? "reason_label" : "reason_optional")
          }
          help={t("reason_help", { min: REASON_MIN })}
          error={problem}
        >
          {(control) => (
            <TextArea
              {...control}
              ref={reasonBox}
              value={reason}
              maxLength={REASON_MAX}
              disabled={busy}
              onChange={(e) => {
                setReason(e.target.value);
                if (problem) setProblem(null);
              }}
            />
          )}
        </Field>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={irreversible ? BUTTON.danger : BUTTON.primary}
          disabled={busy}
          onClick={confirm}
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
