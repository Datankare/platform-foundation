"use client";

import React, { useState } from "react";
import SsoButtons from "@/components/auth/SsoButtons";
import type { SsoProvider } from "@/platform/auth/types";

interface LoginFormProps {
  onSubmit: (email: string, password: string) => Promise<void>;
  onSsoClick: (provider: SsoProvider) => Promise<void>;
  onGuestClick: () => Promise<void>;
  onForgotPassword: () => void;
  onCreateAccount: () => void;
  error?: string | null;
  isLoading?: boolean;
  enabledSsoProviders?: SsoProvider[];
  showGuestOption?: boolean;
}

/**
 * Login form with email/password, SSO buttons, guest option.
 * Provider-agnostic — all actions are callbacks.
 * Password manager compatible (autocomplete attributes set correctly).
 */
export default function LoginForm({
  onSubmit,
  onSsoClick,
  onGuestClick,
  onForgotPassword,
  onCreateAccount,
  error = null,
  isLoading = false,
  enabledSsoProviders = ["google", "apple", "microsoft"],
  showGuestOption = true,
}: LoginFormProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const canSubmit = email.trim().length > 0 && password.length > 0 && !isLoading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    await onSubmit(email.trim(), password);
  };

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-xl font-bold text-white text-center">Sign In</h2>

      {/* SSO Buttons */}
      <SsoButtons
        onSsoClick={onSsoClick}
        disabled={isLoading}
        enabledProviders={enabledSsoProviders}
      />

      {/* Divider */}
      <div className="flex items-center gap-4">
        <div className="flex-1 h-px bg-gray-700" />
        <span className="text-xs text-gray-500 uppercase tracking-wider">or</span>
        <div className="flex-1 h-px bg-gray-700" />
      </div>

      {/* Email/Password Form */}
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div>
          <label htmlFor="login-email" className="block text-sm text-gray-400 mb-1.5">
            Email
          </label>
          <input
            id="login-email"
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
          <div className="flex items-center justify-between mb-1.5">
            <label htmlFor="login-password" className="text-sm text-gray-400">
              Password
            </label>
            <button
              type="button"
              onClick={onForgotPassword}
              className="text-xs text-blue-400 hover:text-blue-300 transition"
            >
              Forgot password?
            </button>
          </div>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter your password"
            disabled={isLoading}
            required
            className="w-full bg-[#0a0f1e] border border-gray-700 rounded-xl px-4 py-3 text-white placeholder-gray-600 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition disabled:opacity-50"
          />
        </div>

        {/* Error message */}
        {error && (
          <div
            role="alert"
            className="bg-red-900/30 border border-red-700 text-red-300 rounded-xl px-4 py-3 text-sm"
          >
            {error}
          </div>
        )}

        {/* Submit button */}
        <button
          type="submit"
          disabled={!canSubmit}
          className="w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold py-3 rounded-xl text-sm transition disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {isLoading ? "Signing in..." : "Sign In"}
        </button>
      </form>

      {/* Guest option */}
      {showGuestOption && (
        <>
          <div className="flex items-center gap-4">
            <div className="flex-1 h-px bg-gray-700" />
            <span className="text-xs text-gray-500 uppercase tracking-wider">or</span>
            <div className="flex-1 h-px bg-gray-700" />
          </div>
          <button
            onClick={onGuestClick}
            disabled={isLoading}
            className="w-full border border-gray-700 text-gray-400 hover:text-gray-300 hover:border-gray-600 py-3 rounded-xl text-sm transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Continue as Guest
          </button>
        </>
      )}

      {/* Create account link */}
      <p className="text-center text-sm text-gray-500">
        {"Don't have an account? "}
        <button
          onClick={onCreateAccount}
          className="text-blue-400 hover:text-blue-300 transition"
        >
          Create one
        </button>
      </p>
    </div>
  );
}
