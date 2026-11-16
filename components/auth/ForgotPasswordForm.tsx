"use client";

import React, { useContext, useEffect, useState } from "react";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import type { PasswordRulesPolicy } from "@/platform/auth/password-rules";
import {
  AuthField,
  AuthInput,
  CodeInput,
  FormError,
  FormNotice,
} from "@/components/auth/ui/AuthField";
import { AuthHeading, StepMoved } from "@/components/auth/ui/AuthHeading";
import {
  NewPasswordFields,
  newPasswordReady,
} from "@/components/auth/ui/NewPasswordFields";
import { AUTH_LEAD, AUTH_LINK, AUTH_PRIMARY } from "@/components/auth/ui/styles";

/** This screen's text, from the message catalog (ADR-051 D4, TASK-205). */
const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.auth.forgot_password.${key}`, values);

/** Seconds before another code may be asked for (the verification step waits the same). */
export const RESEND_WAIT_SECONDS = 60;

interface ForgotPasswordFormProps {
  /** True when the code was sent; false keeps the email step (the error says why). */
  onSendCode: (email: string) => Promise<boolean>;
  /** True when the password was reset; false keeps the code step (the error says why). */
  onConfirmReset: (email: string, code: string, newPassword: string) => Promise<boolean>;
  /** The password is reset: sign in with it (the address carried over). */
  onResetDone: (email: string) => void;
  onBackToLogin: () => void;
  /** The policy the server will check the new password against (usePasswordPolicy). */
  policy: PasswordRulesPolicy;
  error?: string | null;
  isLoading?: boolean;
}

/**
 * Two-step forgot password flow:
 * 1. Enter email → send reset code
 * 2. Enter code + new password → confirm reset → sign in, the address filled in
 *
 * Each step advances only on the server's success (TASK-181: a refused reset — a wrong or expired
 * code, the password policy, a rate limit — showed "Password Reset" all the same); a refusal
 * stays on its step with the server's message (the `error` prop).
 *
 * The code step names the address the code went to, offers a new code (after a wait, as the
 * verification step does) and another address, and calls the code what the first step did: a
 * reset code (TASK-222, SF-app-044). It never says the code was sent: the server answers the
 * same whether or not the address has an account (audit A-15), so the screen says "if".
 */
export default function ForgotPasswordForm({
  onSendCode,
  onConfirmReset,
  onResetDone,
  onBackToLogin,
  policy,
  error = null,
  isLoading = false,
}: ForgotPasswordFormProps) {
  const [step, setStep] = useState<"email" | "code">("email");
  // The code step, and the address step again, are steps moved to inside this one: their
  // heading takes focus even when the page opened on this step (SF-app-041).
  const [movedHere, setMovedHere] = useState(false);
  const pageMoved = useContext(StepMoved);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [wait, setWait] = useState(0);

  useEffect(() => {
    if (wait <= 0) return;
    const timer = setTimeout(() => setWait((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [wait]);

  const ready =
    code.length === 6 &&
    newPasswordReady(newPassword, confirmPassword, policy) &&
    !isLoading;

  const handleSendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || isLoading) return;
    setNotice(null);
    if (await onSendCode(email.trim())) {
      setStep("code");
      setMovedHere(true);
      setWait(RESEND_WAIT_SECONDS);
    }
  };

  const handleResend = async () => {
    if (wait > 0 || isLoading) return;
    setNotice(null);
    if (await onSendCode(email.trim())) {
      setNotice(t("code_resent", { email: email.trim() }));
      setWait(RESEND_WAIT_SECONDS);
    }
  };

  const handleConfirmReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    if (await onConfirmReset(email.trim(), code, newPassword)) onResetDone(email.trim());
  };

  const useAnotherAddress = () => {
    setNotice(null);
    setCode("");
    setNewPassword("");
    setConfirmPassword("");
    setWait(0);
    setStep("email");
    setMovedHere(true);
  };

  return (
    // A new step is a new heading: it takes focus (AuthHeading), keyed by the step.
    <StepMoved.Provider value={pageMoved || movedHere}>
      <div className="flex flex-col gap-6" key={step}>
        <AuthHeading>{t("reset_password")}</AuthHeading>

        {step === "email" ? (
          <form
            onSubmit={handleSendCode}
            aria-busy={isLoading}
            aria-describedby={error ? "forgot-error" : undefined}
            className="flex flex-col gap-4"
          >
            <p className={AUTH_LEAD}>{t("enter_your_email_and_we")}</p>
            <AuthField id="forgot-email" label={t("email")}>
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

            <FormError id="forgot-error" message={error} />

            <button
              type="submit"
              disabled={!email.trim() || isLoading}
              className={AUTH_PRIMARY}
            >
              {isLoading ? t("sending") : t("send_reset_code")}
            </button>
          </form>
        ) : (
          <form
            onSubmit={handleConfirmReset}
            aria-busy={isLoading}
            aria-describedby={error ? "reset-error" : undefined}
            className="flex flex-col gap-4"
          >
            <p className={`${AUTH_LEAD} break-words`}>
              {t("sent_code_to", { email: email.trim() })}
            </p>
            <AuthField id="reset-code" label={t("reset_code")}>
              {(control) => (
                <CodeInput
                  {...control}
                  value={code}
                  onDigits={setCode}
                  placeholder={t("six_digit_code")}
                  disabled={isLoading}
                  required
                />
              )}
            </AuthField>

            <NewPasswordFields
              password={newPassword}
              confirm={confirmPassword}
              onPassword={setNewPassword}
              onConfirm={setConfirmPassword}
              policy={policy}
              passwordLabel={t("new_password")}
              confirmLabel={t("confirm_new_password")}
              passwordId="reset-new-password"
              confirmId="reset-confirm-password"
              disabled={isLoading}
            />

            <FormNotice message={error ? null : notice} />
            <FormError id="reset-error" message={error} />

            <button type="submit" disabled={!ready} className={AUTH_PRIMARY}>
              {isLoading ? t("resetting") : t("reset_password")}
            </button>

            <div className="flex flex-col items-center gap-2 text-sm">
              <button
                type="button"
                onClick={handleResend}
                disabled={wait > 0 || isLoading}
                className={AUTH_LINK}
              >
                {wait > 0 ? t("resend_in", { seconds: wait }) : t("resend_code")}
              </button>
              <button type="button" onClick={useAnotherAddress} className={AUTH_LINK}>
                {t("use_another_address")}
              </button>
            </div>
          </form>
        )}

        <p className="text-center text-sm text-gray-300">
          <button type="button" onClick={onBackToLogin} className={AUTH_LINK}>
            {t("back_to_sign_in")}
          </button>
        </p>
      </div>
    </StepMoved.Provider>
  );
}
