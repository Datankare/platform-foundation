"use client";

/**
 * components/admin/ui/Field.tsx — one form field, with its label, help and error wired
 * (TASK-216, SCREEN-FINDINGS P14)
 *
 * Fields were built per screen: some had only a placeholder for a label, most did not tie an
 * error or a help line to the control, and none marked an invalid value. A Field gives its
 * control an id, a visible label, `aria-describedby` for the help and the error together, and
 * `aria-invalid` while there is an error — which is announced when it appears (role="alert").
 * The controls are here too, so every one has the console's shape and a visible focus ring.
 *
 * @module components/admin/ui
 */

import React, { useId } from "react";
import { CONTROL, FOCUS_RING, TEXT } from "./tokens";

/** What a Field hands its control. */
export interface ControlProps {
  readonly id: string;
  readonly "aria-describedby"?: string;
  readonly "aria-invalid"?: true;
}

export function Field({
  label,
  help,
  error,
  hideLabel = false,
  className = "",
  children,
}: {
  readonly label: string;
  /** What the field takes, said before a mistake is made (a minimum length, an example). */
  readonly help?: React.ReactNode;
  /** Why the value is not accepted; empty for none. */
  readonly error?: string | null;
  /** The label is for assistive technology only (a search box beside its own button). */
  readonly hideLabel?: boolean;
  readonly className?: string;
  readonly children: (control: ControlProps) => React.ReactNode;
}) {
  const id = useId();
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const described = [help ? helpId : null, error ? errorId : null].filter(Boolean);
  return (
    <div className={`flex min-w-0 flex-col gap-1 ${className}`}>
      <label
        htmlFor={id}
        className={hideLabel ? "sr-only" : `text-xs font-medium ${TEXT.quiet}`}
      >
        {label}
      </label>
      {children({
        id,
        ...(described.length ? { "aria-describedby": described.join(" ") } : {}),
        ...(error ? { "aria-invalid": true as const } : {}),
      })}
      {help ? (
        <p id={helpId} className={`text-xs ${TEXT.faint}`}>
          {help}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-red-300">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function TextInput({ className = "", ...props }: React.ComponentProps<"input">) {
  return <input type="text" {...props} className={`${CONTROL} ${className}`} />;
}

export function Select({ className = "", ...props }: React.ComponentProps<"select">) {
  return <select {...props} className={`${CONTROL} ${className}`} />;
}

export function TextArea({ className = "", ...props }: React.ComponentProps<"textarea">) {
  return <textarea rows={3} {...props} className={`${CONTROL} ${className}`} />;
}

/** A checkbox with its label beside it (the label is the click target). */
export function Checkbox({
  label,
  className = "",
  ...props
}: Omit<React.ComponentProps<"input">, "type"> & {
  readonly label: React.ReactNode;
}) {
  return (
    <label className={`flex min-w-0 cursor-pointer items-start gap-3 ${className}`}>
      <input
        type="checkbox"
        {...props}
        className={`mt-0.5 h-4 w-4 shrink-0 rounded border-gray-500 ${FOCUS_RING}`}
      />
      <span className="min-w-0 flex-1">{label}</span>
    </label>
  );
}

/**
 * Why a form cannot be sent when no one field is at fault (nothing changed; a choice among
 * checkboxes): announced as it appears, beside the form's buttons (TASK-220).
 */
export function FormProblem({ problem }: { readonly problem?: string | null }) {
  return problem ? (
    <p role="alert" data-form-problem="true" className="text-xs text-red-300">
      {problem}
    </p>
  ) : null;
}
