"use client";

import React, { useState, useRef, useEffect } from "react";

interface EmailVerificationFormProps {
  email: string;
  onSubmit: (code: string) => Promise<void>;
  onResend: () => Promise<void>;
  onBackToLogin: () => void;
  error?: string | null;
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
    await onResend();
    setResendCooldown(60);
  };

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-xl font-bold text-white text-center">Verify Your Email</h2>
      <p className="text-sm text-gray-400 text-center">
        {"We sent a verification code to "}
        <span className="text-white font-medium">{email}</span>
      </p>

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
          {isLoading ? "Verifying..." : "Verify Email"}
        </button>
      </form>

      <div className="text-center">
        <button
          onClick={handleResend}
          disabled={resendCooldown > 0 || isLoading}
          className="text-sm text-blue-400 hover:text-blue-300 transition disabled:text-gray-600 disabled:cursor-not-allowed"
        >
          {resendCooldown > 0
            ? `Resend code in ${resendCooldown}s`
            : "Resend verification code"}
        </button>
      </div>

      <p className="text-center text-sm text-gray-500">
        <button
          onClick={onBackToLogin}
          className="text-blue-400 hover:text-blue-300 transition"
        >
          Back to Sign In
        </button>
      </p>
    </div>
  );
}
