"use client";

import React, { useState, useRef, useEffect } from "react";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";

/** This screen's text, from the message catalog (ADR-051 D4, TASK-205). */
const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.auth.new_password.${key}`, values);

interface NewPasswordFormProps {
  onSubmit: (newPassword: string) => Promise<void>;
  onCancel: () => void;
  error?: string | null;
  isLoading?: boolean;
}

/**
 * New-password challenge form.
 * Shown after signIn returns newPasswordRequired: true — e.g. an
 * admin-created account signing in with a temporary password for the
 * first time, which Cognito requires be replaced before access is granted.
 */
export default function NewPasswordForm({
  onSubmit,
  onCancel,
  error = null,
  isLoading = false,
}: NewPasswordFormProps) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const tooShort = password.length > 0 && password.length < 8;
  const mismatch = confirm.length > 0 && confirm !== password;
  const canSubmit = password.length >= 8 && confirm === password && !isLoading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    await onSubmit(password);
  };

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-xl font-bold text-white text-center">
        {t("set_a_new_password")}
      </h2>
      <p className="text-sm text-gray-400 text-center">
        {t("your_account_requires_a_new")}
      </p>

      <form onSubmit={handleSubmit} aria-busy={isLoading} className="flex flex-col gap-4">
        <div className="flex flex-col gap-3">
          <label htmlFor="new-password" className="sr-only">
            {t("new_password")}
          </label>
          <input
            ref={inputRef}
            id="new-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t("new_password")}
            disabled={isLoading}
            className="w-full bg-[#0a0f1e] border border-gray-700 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition disabled:opacity-50"
          />
          <label htmlFor="confirm-password" className="sr-only">
            {t("confirm_new_password")}
          </label>
          <input
            id="confirm-password"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder={t("confirm_new_password")}
            disabled={isLoading}
            className="w-full bg-[#0a0f1e] border border-gray-700 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition disabled:opacity-50"
          />
        </div>

        {tooShort && (
          <p className="text-xs text-gray-400">{t("password_must_be_at_least")}</p>
        )}
        {mismatch && (
          <p className="text-xs text-gray-400">{t("passwords_do_not_match")}</p>
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
          {isLoading ? t("setting_password") : t("set_password_continue")}
        </button>
      </form>

      <p className="text-center text-sm text-gray-400">
        <button
          onClick={onCancel}
          className="text-blue-400 hover:text-blue-300 transition"
        >
          {t("cancel_sign_in")}
        </button>
      </p>
    </div>
  );
}
