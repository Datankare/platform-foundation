"use client";

import React, { useEffect, useState } from "react";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import {
  AuthField,
  CodeInput,
  FormError,
  FormNotice,
} from "@/components/auth/ui/AuthField";
import { AuthHeading } from "@/components/auth/ui/AuthHeading";
import { AUTH_LEAD, AUTH_LINK, AUTH_PRIMARY } from "@/components/auth/ui/styles";

/** This screen's text, from the message catalog (ADR-051 D4, TASK-205). */
const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.auth.email_verification.${key}`, values);

/** Seconds before another code may be asked for. */
const RESEND_WAIT_SECONDS = 60;

/**
 * "We sent a verification code to {email}" as one message (any word order), the address styled
 * where the translation puts it.
 */
function sentCodeTo(email: string): React.ReactNode {
  const mark = "\u0001";
  const [before, after = ""] = t("sent_code_to", { email: mark }).split(mark);
  return (
    <>
      {before}
      <span className="text-white font-medium break-all">{email}</span>
      {after}
    </>
  );
}

interface EmailVerificationFormProps {
  email: string;
  onSubmit: (code: string) => Promise<void>;
  /** False when the code could not be resent (the error says why; no cooldown starts). */
  onResend: () => Promise<boolean | void>;
  onBackToLogin: () => void;
  error?: string | null;
  /** Informational (gray): e.g. that a new code was sent. */
  notice?: string | null;
  isLoading?: boolean;
}

/**
 * Email verification form shown after registration.
 * User must verify email before accessing the platform.
 *
 * The code field has a label (it had only a placeholder — S8 accessibility); a verified address
 * goes on to sign-in with a notice and the address filled in (AuthPage, SF-app-040).
 */
export default function EmailVerificationForm({
  email,
  onSubmit,
  onResend,
  onBackToLogin,
  error = null,
  notice = null,
  isLoading = false,
}: EmailVerificationFormProps) {
  const [code, setCode] = useState("");
  const [resendCooldown, setResendCooldown] = useState(0);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setTimeout(() => setResendCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendCooldown]);

  const canSubmit = /^\d{6}$/.test(code) && !isLoading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    await onSubmit(code);
  };

  const handleResend = async () => {
    if (resendCooldown > 0 || isLoading) return;
    if ((await onResend()) !== false) setResendCooldown(RESEND_WAIT_SECONDS);
  };

  return (
    <div className="flex flex-col gap-6">
      <AuthHeading>{t("verify_your_email")}</AuthHeading>
      <p className={AUTH_LEAD}>{sentCodeTo(email)}</p>

      <form
        onSubmit={handleSubmit}
        aria-busy={isLoading}
        aria-describedby={error ? "verify-error" : undefined}
        className="flex flex-col gap-4"
      >
        <AuthField id="verify-code" label={t("code_label")}>
          {(control) => (
            <CodeInput
              {...control}
              value={code}
              onDigits={setCode}
              placeholder="000000"
              disabled={isLoading}
              required
            />
          )}
        </AuthField>

        <FormNotice message={error ? null : notice} />
        <FormError id="verify-error" message={error} />

        <button type="submit" disabled={!canSubmit} className={AUTH_PRIMARY}>
          {isLoading ? t("verifying") : t("verify_email")}
        </button>
      </form>

      <div className="text-center text-sm">
        <button
          type="button"
          onClick={handleResend}
          disabled={resendCooldown > 0 || isLoading}
          className={AUTH_LINK}
        >
          {resendCooldown > 0
            ? t("resend_in", { seconds: resendCooldown })
            : t("resend_verification_code")}
        </button>
      </div>

      <p className="text-center text-sm text-gray-300">
        <button type="button" onClick={onBackToLogin} className={AUTH_LINK}>
          {t("back_to_sign_in")}
        </button>
      </p>
    </div>
  );
}
