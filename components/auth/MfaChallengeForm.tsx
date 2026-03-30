"use client";

import React, { useState, useRef, useEffect } from "react";

interface MfaChallengeFormProps {
  onSubmit: (totpCode: string) => Promise<void>;
  onCancel: () => void;
  error?: string | null;
  isLoading?: boolean;
}

/**
 * MFA TOTP challenge form.
 * Shown after signIn returns mfaRequired: true.
 * 6-digit code input with auto-focus.
 */
export default function MfaChallengeForm({
  onSubmit,
  onCancel,
  error = null,
  isLoading = false,
}: MfaChallengeFormProps) {
  const [code, setCode] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const canSubmit = code.length === 6 && /^\d{6}$/.test(code) && !isLoading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    await onSubmit(code);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.replace(/\D/g, "").slice(0, 6);
    setCode(value);
  };

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-xl font-bold text-white text-center">
        Two-Factor Authentication
      </h2>
      <p className="text-sm text-gray-400 text-center">
        Enter the 6-digit code from your authenticator app.
      </p>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div>
          <input
            ref={inputRef}
            id="mfa-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={handleChange}
            placeholder="000000"
            disabled={isLoading}
            maxLength={6}
            className="w-full bg-[#0a0f1e] border border-gray-700 rounded-xl px-4 py-4 text-white text-2xl text-center tracking-[0.5em] font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition disabled:opacity-50"
          />
        </div>

        {error && (
          <div
            role="alert"
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
          {isLoading ? "Verifying..." : "Verify"}
        </button>
      </form>

      <p className="text-center text-sm text-gray-500">
        <button
          onClick={onCancel}
          className="text-blue-400 hover:text-blue-300 transition"
        >
          Cancel sign-in
        </button>
      </p>
    </div>
  );
}
