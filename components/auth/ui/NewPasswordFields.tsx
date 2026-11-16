"use client";

/**
 * components/auth/ui/NewPasswordFields.tsx — a new password and its confirmation, as every
 * screen that sets one asks for them (TASK-222, E-112, SF-app-042, SF-app-043)
 *
 * Account creation, the password reset and the new-password step each asked for the two
 * fields their own way. Here: the password's field carries the policy's rules as its help
 * (PasswordRules: met or not met, in words), the confirmation's field says when the two differ —
 * as its error, so it is announced and the field marked invalid — once the confirmation is no
 * longer a beginning of the password (not on the first letter typed).
 *
 * @module components/auth/ui
 */

import React from "react";
import type { PasswordRulesPolicy } from "@/platform/auth/password-rules";
import { renderMessage } from "@/platform/errors/messages";
import { AuthField, AuthInput } from "./AuthField";
import { PasswordRules, meetsPolicy } from "./PasswordRules";

/** Whether the confirmation, as typed so far, already differs from the password. */
export function confirmationDiffers(password: string, confirm: string): boolean {
  if (confirm.length === 0) return false;
  if (confirm.length < password.length) return !password.startsWith(confirm);
  return confirm !== password;
}

/** Whether the two fields hold a password the policy accepts, typed the same twice. */
export function newPasswordReady(
  password: string,
  confirm: string,
  policy: PasswordRulesPolicy
): boolean {
  return meetsPolicy(password, policy) && confirm === password;
}

export function NewPasswordFields({
  password,
  confirm,
  onPassword,
  onConfirm,
  policy,
  passwordLabel,
  confirmLabel,
  disabled = false,
  passwordId,
  confirmId,
}: {
  readonly password: string;
  readonly confirm: string;
  readonly onPassword: (value: string) => void;
  readonly onConfirm: (value: string) => void;
  readonly policy: PasswordRulesPolicy;
  readonly passwordLabel: string;
  readonly confirmLabel: string;
  readonly disabled?: boolean;
  /** The two inputs' ids (a password manager and a page's tests know them by these). */
  readonly passwordId: string;
  readonly confirmId: string;
}) {
  return (
    <>
      <AuthField
        id={passwordId}
        label={passwordLabel}
        help={<PasswordRules password={password} policy={policy} />}
      >
        {(control) => (
          <AuthInput
            {...control}
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => onPassword(e.target.value)}
            disabled={disabled}
            required
          />
        )}
      </AuthField>
      <AuthField
        id={confirmId}
        label={confirmLabel}
        error={
          confirmationDiffers(password, confirm)
            ? renderMessage("screens.auth.password_rules.do_not_match")
            : null
        }
      >
        {(control) => (
          <AuthInput
            {...control}
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => onConfirm(e.target.value)}
            disabled={disabled}
            required
          />
        )}
      </AuthField>
    </>
  );
}
