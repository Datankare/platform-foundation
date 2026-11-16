"use client";

import React, { useState } from "react";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import type { PasswordRulesPolicy } from "@/platform/auth/password-rules";
import { FormError } from "@/components/auth/ui/AuthField";
import { AuthHeading } from "@/components/auth/ui/AuthHeading";
import {
  NewPasswordFields,
  newPasswordReady,
} from "@/components/auth/ui/NewPasswordFields";
import { AUTH_LEAD, AUTH_LINK, AUTH_PRIMARY } from "@/components/auth/ui/styles";

/** This screen's text, from the message catalog (ADR-051 D4, TASK-205). */
const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.auth.new_password.${key}`, values);

interface NewPasswordFormProps {
  onSubmit: (newPassword: string) => Promise<void>;
  onCancel: () => void;
  /** The policy the server will check the password against (usePasswordPolicy). */
  policy: PasswordRulesPolicy;
  error?: string | null;
  isLoading?: boolean;
}

/**
 * New-password challenge form.
 * Shown after signIn returns newPasswordRequired: true — e.g. an
 * admin-created account signing in with a temporary password for the
 * first time, which Cognito requires be replaced before access is granted.
 *
 * Its fields have visible labels (they had only placeholders, gone once typing starts —
 * SF-app-045) and the server's policy, not a rule of its own (8 characters; E-112).
 */
export default function NewPasswordForm({
  onSubmit,
  onCancel,
  policy,
  error = null,
  isLoading = false,
}: NewPasswordFormProps) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  const canSubmit = newPasswordReady(password, confirm, policy) && !isLoading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    await onSubmit(password);
  };

  return (
    <div className="flex flex-col gap-6">
      <AuthHeading>{t("set_a_new_password")}</AuthHeading>
      <p className={AUTH_LEAD}>{t("your_account_requires_a_new")}</p>

      <form
        onSubmit={handleSubmit}
        aria-busy={isLoading}
        aria-describedby={error ? "new-password-error" : undefined}
        className="flex flex-col gap-4"
      >
        <NewPasswordFields
          password={password}
          confirm={confirm}
          onPassword={setPassword}
          onConfirm={setConfirm}
          policy={policy}
          passwordLabel={t("new_password")}
          confirmLabel={t("confirm_new_password")}
          passwordId="new-password"
          confirmId="confirm-password"
          disabled={isLoading}
        />

        <FormError id="new-password-error" message={error} />

        <button type="submit" disabled={!canSubmit} className={AUTH_PRIMARY}>
          {isLoading ? t("setting_password") : t("set_password_continue")}
        </button>
      </form>

      <p className="text-center text-sm text-gray-300">
        <button type="button" onClick={onCancel} className={AUTH_LINK}>
          {t("cancel_sign_in")}
        </button>
      </p>
    </div>
  );
}
