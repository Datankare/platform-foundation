"use client";

import React, { useState } from "react";

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
    number: /[0-9]/.test(password),
    special: /[^A-Za-z0-9]/.test(password),
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
      <h2 className="text-xl font-bold text-white text-center">Create Account</h2>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div>
          <label htmlFor="register-email" className="block text-sm text-gray-400 mb-1.5">
            Email
          </label>
          <input
            id="register-email"
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

        <div>
          <label
            htmlFor="register-password"
            className="block text-sm text-gray-400 mb-1.5"
          >
            Password
          </label>
          <input
            id="register-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Create a strong password"
            disabled={isLoading}
            required
            className="w-full bg-[#0a0f1e] border border-gray-700 rounded-xl px-4 py-3 text-white placeholder-gray-600 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition disabled:opacity-50"
          />
          {/* Password requirements */}
          {password.length > 0 && (
            <div className="mt-2 flex flex-col gap-1">
              <PasswordCheck
                label={`At least ${minPasswordLength} characters`}
                passed={passwordChecks.length}
              />
              <PasswordCheck label="Uppercase letter" passed={passwordChecks.uppercase} />
              <PasswordCheck label="Lowercase letter" passed={passwordChecks.lowercase} />
              <PasswordCheck label="Number" passed={passwordChecks.number} />
              <PasswordCheck label="Special character" passed={passwordChecks.special} />
            </div>
          )}
        </div>

        <div>
          <label
            htmlFor="register-confirm"
            className="block text-sm text-gray-400 mb-1.5"
          >
            Confirm Password
          </label>
          <input
            id="register-confirm"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="Confirm your password"
            disabled={isLoading}
            required
            className="w-full bg-[#0a0f1e] border border-gray-700 rounded-xl px-4 py-3 text-white placeholder-gray-600 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition disabled:opacity-50"
          />
          {confirmPassword.length > 0 && !passwordChecks.match && (
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
          disabled={!canSubmit}
          className="w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold py-3 rounded-xl text-sm transition disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {isLoading ? "Creating account..." : "Create Account"}
        </button>
      </form>

      <p className="text-center text-sm text-gray-500">
        Already have an account?{" "}
        <button
          onClick={onBackToLogin}
          className="text-blue-400 hover:text-blue-300 transition"
        >
          Sign in
        </button>
      </p>
    </div>
  );
}

function PasswordCheck({ label, passed }: { label: string; passed: boolean }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={passed ? "text-green-400" : "text-gray-600"}>
        {passed ? "\u2713" : "\u2022"}
      </span>
      <span className={passed ? "text-gray-300" : "text-gray-600"}>{label}</span>
    </div>
  );
}
