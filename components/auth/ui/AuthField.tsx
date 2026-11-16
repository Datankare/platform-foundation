"use client";

/**
 * components/auth/ui/AuthField.tsx — one sign-in field, with its label, help and error wired
 * (TASK-222, SF-app-042, SF-app-045, SCREEN-FINDINGS P14)
 *
 * The sign-in steps' fields had a label only for a screen reader on the new-password step (a
 * sighted person saw a placeholder that vanished on typing), the code fields of two-step
 * verification and email verification had none at all, and no field was tied to its error:
 * "Passwords do not match" was a grey line nobody heard, and nothing marked the field. An
 * AuthField gives its control an id, a visible label, `aria-describedby` for the help and the
 * error together, and `aria-invalid` while there is an error — announced as it appears
 * (role="alert"). The controls are here too (AuthInput, CodeInput), so every one has the same
 * shape and focus ring.
 *
 * Shaped like the console's Field (components/admin/ui/Field.tsx), in the sign-in screens' look.
 *
 * @module components/auth/ui
 */

import React, { useId } from "react";
import {
  AUTH_CODE_INPUT,
  AUTH_ERROR,
  AUTH_HELP,
  AUTH_INPUT,
  AUTH_LABEL,
  AUTH_NOTICE,
} from "./styles";

/** What a field hands its control. */
export interface AuthControlProps {
  readonly id: string;
  readonly "aria-describedby"?: string;
  readonly "aria-invalid"?: true;
}

export function AuthField({
  id: givenId,
  label,
  help,
  error,
  aside,
  children,
}: {
  /** The control's id, when a page or a password manager knows the field by it. */
  readonly id?: string;
  readonly label: string;
  /** What the field takes, said before a mistake is made (a list of password rules). */
  readonly help?: React.ReactNode;
  /** Why the value is not accepted; empty for none. */
  readonly error?: string | null;
  /** Beside the label, at its end (the "Forgot password?" button). */
  readonly aside?: React.ReactNode;
  readonly children: (control: AuthControlProps) => React.ReactNode;
}) {
  const autoId = useId();
  const id = givenId ?? autoId;
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const described = [help ? helpId : null, error ? errorId : null].filter(Boolean);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className={AUTH_LABEL}>
          {label}
        </label>
        {aside}
      </div>
      {children({
        id,
        ...(described.length ? { "aria-describedby": described.join(" ") } : {}),
        ...(error ? { "aria-invalid": true as const } : {}),
      })}
      {help ? (
        <div id={helpId} className={AUTH_HELP}>
          {help}
        </div>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-red-300">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** A text field in the sign-in look. */
export function AuthInput({ className = "", ...props }: React.ComponentProps<"input">) {
  return <input type="text" {...props} className={`${AUTH_INPUT} ${className}`} />;
}

/** A six-digit code field: digits only, the device's one-time-code fill. */
export function CodeInput({
  value,
  onDigits,
  className = "",
  ...props
}: Omit<React.ComponentProps<"input">, "onChange" | "value"> & {
  readonly value: string;
  readonly onDigits: (digits: string) => void;
}) {
  return (
    <input
      type="text"
      inputMode="numeric"
      autoComplete="one-time-code"
      maxLength={6}
      {...props}
      value={value}
      onChange={(e) => onDigits(e.target.value.replace(/\D/g, "").slice(0, 6))}
      className={`${AUTH_CODE_INPUT} ${className}`}
    />
  );
}

/**
 * A refusal of the whole step (a wrong code, a rate limit, the server's own words): announced as
 * it appears. Never says which field was wrong when saying so would tell whether an account
 * exists — the server's words decide that, not this.
 */
export function FormError({
  id,
  message,
}: {
  readonly id?: string;
  readonly message?: string | null;
}) {
  return message ? (
    <div id={id} role="alert" className={AUTH_ERROR}>
      {message}
    </div>
  ) : null;
}

/** A notice of what happened (a code sent, an address verified): read politely. */
export function FormNotice({ message }: { readonly message?: string | null }) {
  return message ? (
    <div role="status" className={AUTH_NOTICE}>
      {message}
    </div>
  ) : null;
}
