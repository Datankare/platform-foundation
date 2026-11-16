"use client";

import React, { useState } from "react";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import { AuthField, CodeInput, FormError } from "@/components/auth/ui/AuthField";
import { AuthHeading } from "@/components/auth/ui/AuthHeading";
import { AUTH_LEAD, AUTH_LINK, AUTH_PRIMARY } from "@/components/auth/ui/styles";

/** This screen's text, from the message catalog (ADR-051 D4, TASK-205). */
const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.auth.mfa_challenge.${key}`, values);

interface MfaChallengeFormProps {
  onSubmit: (totpCode: string) => Promise<void>;
  onCancel: () => void;
  error?: string | null;
  isLoading?: boolean;
}

/**
 * Two-step verification at sign-in: the 6-digit code from the person's authenticator app.
 * Shown after signIn returns mfaRequired: true.
 *
 * The code field has a label (it had only a "000000" placeholder: a screen reader read an
 * unnamed field — S8 accessibility) and is tied to the step's refusal; the step's heading takes
 * focus when it opens (AuthHeading). The name is the one the console's enrolment uses:
 * "two-step verification" (SF-admin-152, SF-app-050).
 */
export default function MfaChallengeForm({
  onSubmit,
  onCancel,
  error = null,
  isLoading = false,
}: MfaChallengeFormProps) {
  const [code, setCode] = useState("");

  const canSubmit = /^\d{6}$/.test(code) && !isLoading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    await onSubmit(code);
  };

  return (
    <div className="flex flex-col gap-6">
      <AuthHeading>{t("two_factor_authentication")}</AuthHeading>
      <p className={AUTH_LEAD}>{t("enter_the_6_digit_code")}</p>

      <form
        onSubmit={handleSubmit}
        aria-busy={isLoading}
        aria-describedby={error ? "mfa-error" : undefined}
        className="flex flex-col gap-4"
      >
        <AuthField id="mfa-code" label={t("code_label")}>
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

        <FormError id="mfa-error" message={error} />

        <button type="submit" disabled={!canSubmit} className={AUTH_PRIMARY}>
          {isLoading ? t("verifying") : t("verify")}
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
