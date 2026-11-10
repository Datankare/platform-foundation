"use client";

import React, { useState } from "react";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";

/** This screen's text, from the message catalog (ADR-051 D4, TASK-205). */
const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.auth.forgot_password.${key}`, values);

interface ForgotPasswordFormProps {
  /** True when the code was sent; false keeps the email step (the error says why). */
  onSendCode: (email: string) => Promise<boolean>;
  /** True when the password was reset; false keeps the code step (the error says why). */
  onConfirmReset: (email: string, code: string, newPassword: string) => Promise<boolean>;
  onBackToLogin: () => void;
  error?: string | null;
  isLoading?: boolean;
  minPasswordLength?: number;
}

/**
 * Two-step forgot password flow:
 * 1. Enter email → send reset code
 * 2. Enter code + new password → confirm reset
 *
 * Each step advances only on the server's success (TASK-181: a refused reset — a wrong or expired
 * code, the password policy, a rate limit — showed "Password Reset" all the same); a refusal
 * stays on its step with the server's message (the `error` prop).
 */
export default function ForgotPasswordForm({
  onSendCode,
  onConfirmReset,
  onBackToLogin,
  error = null,
  isLoading = false,
  minPasswordLength = 12,
}: ForgotPasswordFormProps) {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [success, setSuccess] = useState(false);

  const passwordsMatch = newPassword.length > 0 && newPassword === confirmPassword;
  const passwordLongEnough = newPassword.length >= minPasswordLength;

  const handleSendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || isLoading) return;
    if (await onSendCode(email.trim())) setStep("code");
  };

  const handleConfirmReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code || !passwordsMatch || !passwordLongEnough || isLoading) return;
    if (await onConfirmReset(email.trim(), code, newPassword)) setSuccess(true);
  };

  if (success) {
    return (
      <div className="flex flex-col gap-6 text-center">
        <div className="text-4xl">✅</div>
        <h2 className="text-xl font-bold text-white">{t("password_reset")}</h2>
        <p className="text-sm text-gray-400">{t("your_password_has_been_reset")}</p>
        <button
          onClick={onBackToLogin}
          className="w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold py-3 rounded-xl text-sm transition"
        >
          {t("back_to_sign_in")}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-xl font-bold text-white text-center">{t("reset_password")}</h2>

      {step === "email" ? (
        <form onSubmit={handleSendCode} className="flex flex-col gap-4">
          <p className="text-sm text-gray-400 text-center">
            {t("enter_your_email_and_we")}
          </p>
          <div>
            <label htmlFor="forgot-email" className="block text-sm text-gray-400 mb-1.5">
              {t("email")}
            </label>
            <input
              id="forgot-email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t("you_example_com")}
              disabled={isLoading}
              required
              className="w-full bg-[#0a0f1e] border border-gray-700 rounded-xl px-4 py-3 text-white placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition disabled:opacity-50"
            />
          </div>

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
            disabled={!email.trim() || isLoading}
            className="w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold py-3 rounded-xl text-sm transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isLoading ? t("sending") : t("send_reset_code")}
          </button>
        </form>
      ) : (
        <form onSubmit={handleConfirmReset} className="flex flex-col gap-4">
          <p className="text-sm text-gray-400 text-center">
            {t("check_your_email_for_a")}
          </p>
          <div>
            <label htmlFor="reset-code" className="block text-sm text-gray-400 mb-1.5">
              {t("verification_code")}
            </label>
            <input
              id="reset-code"
              type="text"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={t("enter_6_digit_code")}
              disabled={isLoading}
              required
              className="w-full bg-[#0a0f1e] border border-gray-700 rounded-xl px-4 py-3 text-white placeholder-gray-500 text-sm text-center tracking-widest focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition disabled:opacity-50"
            />
          </div>

          <div>
            <label
              htmlFor="reset-new-password"
              className="block text-sm text-gray-400 mb-1.5"
            >
              {t("new_password")}
            </label>
            <input
              id="reset-new-password"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder={t("create_a_new_password")}
              disabled={isLoading}
              required
              className="w-full bg-[#0a0f1e] border border-gray-700 rounded-xl px-4 py-3 text-white placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition disabled:opacity-50"
            />
          </div>

          <div>
            <label
              htmlFor="reset-confirm-password"
              className="block text-sm text-gray-400 mb-1.5"
            >
              {t("confirm_new_password")}
            </label>
            <input
              id="reset-confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder={t("confirm_new_password_2")}
              disabled={isLoading}
              required
              className="w-full bg-[#0a0f1e] border border-gray-700 rounded-xl px-4 py-3 text-white placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition disabled:opacity-50"
            />
            {confirmPassword.length > 0 && !passwordsMatch && (
              <p className="text-red-400 text-xs mt-1">{t("passwords_do_not_match")}</p>
            )}
          </div>

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
            disabled={!code || !passwordsMatch || !passwordLongEnough || isLoading}
            className="w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold py-3 rounded-xl text-sm transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isLoading ? t("resetting") : t("reset_password")}
          </button>
        </form>
      )}

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
