"use client";

import React, { useState, useRef, useEffect } from "react";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";

/** This screen's text, from the message catalog (ADR-051 D4, TASK-205). */
const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.auth.email_verification.${key}`, values);

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
      <span className="text-white font-medium">{email}</span>
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
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setTimeout(() => setResendCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendCooldown]);

  const canSubmit = code.length >= 6 && !isLoading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    await onSubmit(code);
  };

  const handleResend = async () => {
    if (resendCooldown > 0 || isLoading) return;
    if ((await onResend()) !== false) setResendCooldown(60);
  };

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-xl font-bold text-white text-center">
        {t("verify_your_email")}
      </h2>
      <p className="text-sm text-gray-400 text-center">{sentCodeTo(email)}</p>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div>
          <input
            ref={inputRef}
            id="verify-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder="000000"
            disabled={isLoading}
            maxLength={6}
            className="w-full bg-[#0a0f1e] border border-gray-700 rounded-xl px-4 py-4 text-white text-2xl text-center tracking-[0.5em] font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition disabled:opacity-50"
          />
        </div>

        {notice && !error && (
          <div
            role="status"
            className="bg-gray-800/40 border border-gray-700 text-gray-300 rounded-xl px-4 py-3 text-sm"
          >
            {notice}
          </div>
        )}

        {error && (
          <div
            role="alert"
            aria-live="assertive"
            className="bg-red-900/30 border border-red-700 text-red-300 rounded-xl px-4 py-3 text-sm"
          >
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={!canSubmit}
          className="w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold py-3 rounded-xl text-sm transition disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {isLoading ? t("verifying") : t("verify_email")}
        </button>
      </form>

      <div className="text-center">
        <button
          onClick={handleResend}
          disabled={resendCooldown > 0 || isLoading}
          className="text-sm text-blue-400 hover:text-blue-300 transition disabled:text-gray-600 disabled:cursor-not-allowed"
        >
          {resendCooldown > 0
            ? t("resend_in", { seconds: String(resendCooldown) })
            : t("resend_verification_code")}
        </button>
      </div>

      <p className="text-center text-sm text-gray-400">
        <button
          onClick={onBackToLogin}
          className="text-blue-400 hover:text-blue-300 transition"
        >
          {t("back_to_sign_in")}
        </button>
      </p>
    </div>
  );
}
