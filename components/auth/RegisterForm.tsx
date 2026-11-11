"use client";

import React, { useState } from "react";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";

/** This screen's text, from the message catalog (ADR-051 D4, TASK-205). */
const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.auth.register.${key}`, values);

interface RegisterFormProps {
  onSubmit: (email: string, password: string) => Promise<void>;
  onBackToLogin: () => void;
  error?: string | null;
  isLoading?: boolean;
  minPasswordLength?: number;
}

/**
 * Registration form with email/password.
 * Password manager compatible (autocomplete="new-password").
 * Shows password requirements inline.
 */
export default function RegisterForm({
  onSubmit,
  onBackToLogin,
  error = null,
  isLoading = false,
  minPasswordLength = 12,
}: RegisterFormProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const passwordChecks = {
    length: password.length >= minPasswordLength,
    uppercase: /[A-Z]/.test(password),
    lowercase: /[a-z]/.test(password),
    number: /[0-9]/.test(password), // eslint-disable-line regexp/prefer-d -- ASCII-only digit matching for password validation
    special: /[^A-Za-z0-9]/.test(password), // eslint-disable-line regexp/use-ignore-case -- ASCII-only, must match server-side password-policy.ts
    match: password.length > 0 && password === confirmPassword,
  };

  const allChecksPass = Object.values(passwordChecks).every(Boolean);
  const canSubmit = email.trim().length > 0 && allChecksPass && !isLoading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    await onSubmit(email.trim(), password);
  };

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-xl font-bold text-white text-center">{t("create_account")}</h2>

      <form onSubmit={handleSubmit} aria-busy={isLoading} className="flex flex-col gap-4">
        <div>
          <label htmlFor="register-email" className="block text-sm text-gray-400 mb-1.5">
            {t("email")}
          </label>
          <input
            id="register-email"
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

        <div>
          <label
            htmlFor="register-password"
            className="block text-sm text-gray-400 mb-1.5"
          >
            {t("password")}
          </label>
          <input
            id="register-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t("create_a_strong_password")}
            disabled={isLoading}
            required
            className="w-full bg-[#0a0f1e] border border-gray-700 rounded-xl px-4 py-3 text-white placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition disabled:opacity-50"
          />
          {/* Password requirements */}
          {password.length > 0 && (
            <div
              aria-live="polite"
              aria-label={t("password_requirements")}
              className="mt-2 flex flex-col gap-1"
            >
              <PasswordCheck
                label={t("at_least_characters", { count: String(minPasswordLength) })}
                passed={passwordChecks.length}
              />
              <PasswordCheck
                label={t("uppercase_letter")}
                passed={passwordChecks.uppercase}
              />
              <PasswordCheck
                label={t("lowercase_letter")}
                passed={passwordChecks.lowercase}
              />
              <PasswordCheck label={t("number")} passed={passwordChecks.number} />
              <PasswordCheck
                label={t("special_character")}
                passed={passwordChecks.special}
              />
            </div>
          )}
        </div>

        <div>
          <label
            htmlFor="register-confirm"
            className="block text-sm text-gray-400 mb-1.5"
          >
            {t("confirm_password")}
          </label>
          <input
            id="register-confirm"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder={t("confirm_your_password")}
            disabled={isLoading}
            required
            className="w-full bg-[#0a0f1e] border border-gray-700 rounded-xl px-4 py-3 text-white placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition disabled:opacity-50"
          />
          {confirmPassword.length > 0 && !passwordChecks.match && (
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
          disabled={!canSubmit}
          className="w-full bg-blue-700 hover:bg-blue-800 text-white font-semibold py-3 rounded-xl text-sm transition disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {isLoading ? t("creating_account") : t("create_account")}
        </button>
      </form>

      <p className="text-center text-sm text-gray-400">
        {t("already_have_account")}{" "}
        <button
          onClick={onBackToLogin}
          className="text-blue-400 hover:text-blue-300 transition"
        >
          {t("sign_in")}
        </button>
      </p>
    </div>
  );
}

function PasswordCheck({ label, passed }: { label: string; passed: boolean }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={passed ? "text-green-400" : "text-gray-400"}>
        {passed ? "\u2713" : "\u2022"}
      </span>
      <span className={passed ? "text-gray-300" : "text-gray-400"}>{label}</span>
    </div>
  );
}
