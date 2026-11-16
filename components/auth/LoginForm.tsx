"use client";

import React, { useState } from "react";
import SsoButtons from "@/components/auth/SsoButtons";
import type { SsoProvider } from "@/platform/auth/types";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import {
  AuthField,
  AuthInput,
  FormError,
  FormNotice,
} from "@/components/auth/ui/AuthField";
import { AuthHeading } from "@/components/auth/ui/AuthHeading";
import { AUTH_LINK, AUTH_PRIMARY, AUTH_SECONDARY } from "@/components/auth/ui/styles";

/** This screen's text, from the message catalog (ADR-051 D4, TASK-205). */
const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.auth.login.${key}`, values);

interface LoginFormProps {
  onSubmit: (email: string, password: string) => Promise<void>;
  onSsoClick: (provider: SsoProvider) => Promise<void>;
  onGuestClick: () => Promise<void>;
  onForgotPassword: () => void;
  onCreateAccount: () => void;
  error?: string | null;
  /** What happened before this step (an address verified, a password reset). */
  notice?: string | null;
  /** The address to start with (the one just verified or reset). */
  initialEmail?: string;
  isLoading?: boolean;
  enabledSsoProviders?: SsoProvider[];
  showGuestOption?: boolean;
}

/**
 * Login form with email/password, SSO buttons, guest option.
 * Provider-agnostic — all actions are callbacks.
 * Password manager compatible (autocomplete attributes set correctly).
 *
 * A refusal is said for the whole form (`auth.invalid_credentials` never says which field was
 * wrong: that would tell whether the address has an account); it is announced and the form is
 * described by it (TASK-222, SF-app-042).
 */
export default function LoginForm({
  onSubmit,
  onSsoClick,
  onGuestClick,
  onForgotPassword,
  onCreateAccount,
  error = null,
  notice = null,
  initialEmail = "",
  isLoading = false,
  enabledSsoProviders = [],
  showGuestOption = true,
}: LoginFormProps) {
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");

  const canSubmit = email.trim().length > 0 && password.length > 0 && !isLoading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    await onSubmit(email.trim(), password);
  };

  return (
    <div className="flex flex-col gap-6">
      <AuthHeading>{t("sign_in")}</AuthHeading>

      <FormNotice message={error ? null : notice} />

      {/* SSO Buttons — only configured providers (ADR-050 D3); none, no divider */}
      {enabledSsoProviders.length > 0 && (
        <>
          <SsoButtons
            onSsoClick={onSsoClick}
            disabled={isLoading}
            enabledProviders={enabledSsoProviders}
          />
          <Divider />
        </>
      )}

      {/* Email/Password Form */}
      <form
        onSubmit={handleSubmit}
        aria-busy={isLoading}
        aria-describedby={error ? "login-error" : undefined}
        className="flex flex-col gap-4"
      >
        <AuthField id="login-email" label={t("email")}>
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

        <AuthField
          id="login-password"
          label={t("password")}
          aside={
            <button
              type="button"
              onClick={onForgotPassword}
              className={`text-xs ${AUTH_LINK}`}
            >
              {t("forgot_password")}
            </button>
          }
        >
          {(control) => (
            <AuthInput
              {...control}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={isLoading}
              required
            />
          )}
        </AuthField>

        <FormError id="login-error" message={error} />

        <button type="submit" disabled={!canSubmit} className={AUTH_PRIMARY}>
          {isLoading ? t("signing_in") : t("sign_in")}
        </button>
      </form>

      {/* Guest option */}
      {showGuestOption && (
        <>
          <Divider />
          <button
            type="button"
            onClick={onGuestClick}
            disabled={isLoading}
            className={AUTH_SECONDARY}
          >
            {t("continue_as_guest")}
          </button>
        </>
      )}

      {/* Create account link */}
      <p className="text-center text-sm text-gray-300">
        {t("dont_have_an_account")}{" "}
        <button type="button" onClick={onCreateAccount} className={AUTH_LINK}>
          {t("create_one")}
        </button>
      </p>
    </div>
  );
}

/** "or" between two ways in. */
function Divider() {
  return (
    <div className="flex items-center gap-4" role="separator" aria-label={t("or")}>
      <div className="flex-1 h-px bg-gray-700" />
      <span className="text-xs text-gray-400 uppercase tracking-wider" aria-hidden="true">
        {t("or")}
      </span>
      <div className="flex-1 h-px bg-gray-700" />
    </div>
  );
}
