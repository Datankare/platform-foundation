"use client";

import React, { useState } from "react";

interface ForgotPasswordFormProps {
  onSendCode: (email: string) => Promise<void>;
  onConfirmReset: (email: string, code: string, newPassword: string) => Promise<void>;
  onBackToLogin: () => void;
  error?: string | null;
  isLoading?: boolean;
  minPasswordLength?: number;
}

/**
 * Two-step forgot password flow:
 * 1. Enter email → send reset code
 * 2. Enter code + new password → confirm reset
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
    await onSendCode(email.trim());
    setStep("code");
  };

  const handleConfirmReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code || !passwordsMatch || !passwordLongEnough || isLoading) return;
    await onConfirmReset(email.trim(), code, newPassword);
    setSuccess(true);
  };

  if (success) {
    return (
      <div className="flex flex-col gap-6 text-center">
        <div className="text-4xl">&#x2705;</div>
        <h2 className="text-xl font-bold text-white">Password Reset</h2>
        <p className="text-sm text-gray-400">
          Your password has been reset successfully.
        </p>
        <button
          onClick={onBackToLogin}
          className="w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold py-3 rounded-xl text-sm transition"
        >
          Back to Sign In
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-xl font-bold text-white text-center">Reset Password</h2>

      {step === "email" ? (
        <form onSubmit={handleSendCode} className="flex flex-col gap-4">
          <p className="text-sm text-gray-400 text-center">
            Enter your email and we will send you a reset code.
          </p>
          <div>
            <label htmlFor="forgot-email" className="block text-sm text-gray-400 mb-1.5">
              Email
            </label>
            <input
              id="forgot-email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              disabled={isLoading}
              required
              className="w-full bg-[#0a0f1e] border border-gray-700 rounded-xl px-4 py-3 text-white placeholder-gray-600 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition disabled:opacity-50"
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
            disabled={!email.trim() || isLoading}
            className="w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold py-3 rounded-xl text-sm transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isLoading ? "Sending..." : "Send Reset Code"}
          </button>
        </form>
      ) : (
        <form onSubmit={handleConfirmReset} className="flex flex-col gap-4">
          <p className="text-sm text-gray-400 text-center">
            Check your email for a verification code.
          </p>
          <div>
            <label htmlFor="reset-code" className="block text-sm text-gray-400 mb-1.5">
              Verification Code
            </label>
            <input
              id="reset-code"
              type="text"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Enter 6-digit code"
              disabled={isLoading}
              required
              className="w-full bg-[#0a0f1e] border border-gray-700 rounded-xl px-4 py-3 text-white placeholder-gray-600 text-sm text-center tracking-widest focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition disabled:opacity-50"
            />
          </div>

          <div>
            <label
              htmlFor="reset-new-password"
              className="block text-sm text-gray-400 mb-1.5"
            >
              New Password
            </label>
            <input
              id="reset-new-password"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Create a new password"
              disabled={isLoading}
              required
              className="w-full bg-[#0a0f1e] border border-gray-700 rounded-xl px-4 py-3 text-white placeholder-gray-600 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition disabled:opacity-50"
            />
          </div>

          <div>
            <label
              htmlFor="reset-confirm-password"
              className="block text-sm text-gray-400 mb-1.5"
            >
              Confirm New Password
            </label>
            <input
              id="reset-confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirm new password"
              disabled={isLoading}
              required
              className="w-full bg-[#0a0f1e] border border-gray-700 rounded-xl px-4 py-3 text-white placeholder-gray-600 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition disabled:opacity-50"
            />
            {confirmPassword.length > 0 && !passwordsMatch && (
              <p className="text-red-400 text-xs mt-1">Passwords do not match</p>
            )}
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
            disabled={!code || !passwordsMatch || !passwordLongEnough || isLoading}
            className="w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold py-3 rounded-xl text-sm transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isLoading ? "Resetting..." : "Reset Password"}
          </button>
        </form>
      )}

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
