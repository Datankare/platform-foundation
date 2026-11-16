"use client";

import React, { useState } from "react";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import type { PasswordRulesPolicy } from "@/platform/auth/password-rules";
import { AuthField, AuthInput, FormError } from "@/components/auth/ui/AuthField";
import { AuthHeading } from "@/components/auth/ui/AuthHeading";
import {
  NewPasswordFields,
  newPasswordReady,
} from "@/components/auth/ui/NewPasswordFields";
import { AUTH_LINK, AUTH_PRIMARY } from "@/components/auth/ui/styles";

/** This screen's text, from the message catalog (ADR-051 D4, TASK-205). */
const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.auth.register.${key}`, values);

interface RegisterFormProps {
  onSubmit: (email: string, password: string) => Promise<void>;
  onBackToLogin: () => void;
  /** The policy the server will check the password against (usePasswordPolicy). */
  policy: PasswordRulesPolicy;
  error?: string | null;
  isLoading?: boolean;
}

/**
 * Registration form with email/password.
 * Password manager compatible (autocomplete="new-password").
 *
 * The password's rules are the server's policy, item by item (NewPasswordFields → PasswordRules,
 * TASK-222, E-112): the form sends only a password the server's own check accepts.
 */
export default function RegisterForm({
  onSubmit,
  onBackToLogin,
  policy,
  error = null,
  isLoading = false,
}: RegisterFormProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const canSubmit =
    email.trim().length > 0 &&
    newPasswordReady(password, confirmPassword, policy) &&
    !isLoading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    await onSubmit(email.trim(), password);
  };

  return (
    <div className="flex flex-col gap-6">
      <AuthHeading>{t("create_account")}</AuthHeading>

      <form
        onSubmit={handleSubmit}
        aria-busy={isLoading}
        aria-describedby={error ? "register-error" : undefined}
        className="flex flex-col gap-4"
      >
        <AuthField id="register-email" label={t("email")}>
          {(control) => (
            <AuthInput
              {...control}
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t("you_example_com")}
              disabled={isLoading}
              required
            />
          )}
        </AuthField>

        <NewPasswordFields
          password={password}
          confirm={confirmPassword}
          onPassword={setPassword}
          onConfirm={setConfirmPassword}
          policy={policy}
          passwordLabel={t("password")}
          confirmLabel={t("confirm_password")}
          passwordId="register-password"
          confirmId="register-confirm"
          disabled={isLoading}
        />

        <FormError id="register-error" message={error} />

        <button type="submit" disabled={!canSubmit} className={AUTH_PRIMARY}>
          {isLoading ? t("creating_account") : t("create_account")}
        </button>
      </form>

      <p className="text-center text-sm text-gray-300">
        {t("already_have_account")}{" "}
        <button type="button" onClick={onBackToLogin} className={AUTH_LINK}>
          {t("sign_in")}
        </button>
      </p>
    </div>
  );
}
