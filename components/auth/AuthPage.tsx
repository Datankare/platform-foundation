"use client";

import React, { useState } from "react";
import AuthLayout from "@/components/auth/AuthLayout";
import LoginForm from "@/components/auth/LoginForm";
import RegisterForm from "@/components/auth/RegisterForm";
import ForgotPasswordForm from "@/components/auth/ForgotPasswordForm";
import MfaChallengeForm from "@/components/auth/MfaChallengeForm";
import EmailVerificationForm from "@/components/auth/EmailVerificationForm";
import { getAuthProvider } from "@/platform/auth/config";
import { useAuth } from "@/platform/auth/context";
import type { SsoProvider } from "@/platform/auth/types";

type AuthView =
  | "login"
  | "register"
  | "forgot-password"
  | "mfa-challenge"
  | "email-verification";

/**
 * Auth page — single-page flow that switches between views.
 * All provider interactions go through the AuthProvider interface.
 *
 * Flow:
 * - Login → success → redirect to app
 * - Login → MFA required → MFA challenge → success → redirect
 * - Register → email verification → success → redirect
 * - Forgot password → send code → enter code + new password → back to login
 * - Guest → redirect to app with guest session
 */
export default function AuthPage() {
  const [view, setView] = useState<AuthView>("login");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [mfaSession, setMfaSession] = useState<string | null>(null);
  const [pendingEmail, setPendingEmail] = useState<string>("");
  const { setSession } = useAuth();

  const clearError = () => setError(null);

  const handleLogin = async (email: string, password: string) => {
    clearError();
    setIsLoading(true);
    try {
      const auth = getAuthProvider();
      const result = await auth.signIn(email, password);

      if (!result.success) {
        setError(result.error || "Sign-in failed");
        return;
      }

      if (result.mfaRequired && result.mfaSession) {
        setMfaSession(result.mfaSession);
        setView("mfa-challenge");
        return;
      }

      if (result.emailVerificationRequired) {
        setPendingEmail(email);
        setView("email-verification");
        return;
      }

      if (result.accessToken && result.refreshToken && result.userId) {
        setSession({
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          userId: result.userId,
          email,
          emailVerified: true,
        });
      }
    } catch {
      /* justified */
      // Auth errors shown to user via setError
      setError("An unexpected error occurred. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleRegister = async (email: string, password: string) => {
    clearError();
    setIsLoading(true);
    try {
      const auth = getAuthProvider();
      const result = await auth.signUp(email, password);

      if (!result.success) {
        setError(result.error || "Registration failed");
        return;
      }

      setPendingEmail(email);
      setView("email-verification");
    } catch {
      /* justified */
      // Auth errors shown to user via setError
      setError("An unexpected error occurred. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleEmailVerification = async (code: string) => {
    clearError();
    setIsLoading(true);
    try {
      const auth = getAuthProvider();
      const result = await auth.confirmEmailVerification(pendingEmail, code);

      if (!result.success) {
        setError(result.error || "Verification failed");
        return;
      }

      // After verification, sign the user in
      setView("login");
    } catch {
      /* justified */
      // Auth errors shown to user via setError
      setError("An unexpected error occurred. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleResendVerification = async () => {
    clearError();
    setIsLoading(true);
    try {
      const auth = getAuthProvider();
      await auth.resendEmailVerification(pendingEmail);
    } catch {
      /* justified */
      // Auth errors shown to user via setError
      setError("Could not resend verification code.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleForgotPasswordSend = async (email: string) => {
    clearError();
    setIsLoading(true);
    try {
      const auth = getAuthProvider();
      const result = await auth.forgotPassword(email);

      if (!result.success) {
        setError(result.error || "Could not send reset code");
      }
      setPendingEmail(email);
    } catch {
      /* justified */
      // Auth errors shown to user via setError
      setError("An unexpected error occurred. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleForgotPasswordConfirm = async (
    email: string,
    code: string,
    newPassword: string
  ) => {
    clearError();
    setIsLoading(true);
    try {
      const auth = getAuthProvider();
      const result = await auth.confirmForgotPassword(email, code, newPassword);

      if (!result.success) {
        setError(result.error || "Password reset failed");
      }
    } catch {
      /* justified */
      // Auth errors shown to user via setError
      setError("An unexpected error occurred. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleMfaChallenge = async (totpCode: string) => {
    clearError();
    setIsLoading(true);
    try {
      const auth = getAuthProvider();
      const result = await auth.respondToMfaChallenge(mfaSession || "", totpCode);

      if (!result.success) {
        setError(result.error || "Invalid code");
        return;
      }

      if (result.accessToken && result.refreshToken && result.userId) {
        setSession({
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          userId: result.userId,
          email: pendingEmail,
          emailVerified: true,
        });
      }
    } catch {
      /* justified */
      // Auth errors shown to user via setError
      setError("An unexpected error occurred. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleSsoClick = async (provider: SsoProvider) => {
    clearError();
    setIsLoading(true);
    try {
      const auth = getAuthProvider();
      const result = await auth.initiateSso(
        provider,
        window.location.origin + "/api/auth/callback"
      );

      if (!result.success) {
        setError(result.error || "SSO initiation failed");
        return;
      }

      if (result.redirectUrl) {
        window.location.href = result.redirectUrl;
      }
    } catch {
      /* justified */
      // Auth errors shown to user via setError
      setError("An unexpected error occurred. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleGuestClick = async () => {
    clearError();
    setIsLoading(true);
    try {
      const auth = getAuthProvider();
      const result = await auth.createGuestToken();

      if (!result.success) {
        setError(result.error || "Guest access failed");
        return;
      }

      setSession({
        accessToken: result.token,
        refreshToken: "",
        userId: result.guestId,
        email: "",
        emailVerified: false,
        isGuest: true,
      });
    } catch {
      /* justified */
      // Auth errors shown to user via setError
      setError("An unexpected error occurred. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const switchView = (newView: AuthView) => {
    clearError();
    setView(newView);
  };

  return (
    <AuthLayout>
      {view === "login" && (
        <LoginForm
          onSubmit={handleLogin}
          onSsoClick={handleSsoClick}
          onGuestClick={handleGuestClick}
          onForgotPassword={() => switchView("forgot-password")}
          onCreateAccount={() => switchView("register")}
          error={error}
          isLoading={isLoading}
        />
      )}

      {view === "register" && (
        <RegisterForm
          onSubmit={handleRegister}
          onBackToLogin={() => switchView("login")}
          error={error}
          isLoading={isLoading}
        />
      )}

      {view === "forgot-password" && (
        <ForgotPasswordForm
          onSendCode={handleForgotPasswordSend}
          onConfirmReset={handleForgotPasswordConfirm}
          onBackToLogin={() => switchView("login")}
          error={error}
          isLoading={isLoading}
        />
      )}

      {view === "mfa-challenge" && (
        <MfaChallengeForm
          onSubmit={handleMfaChallenge}
          onCancel={() => switchView("login")}
          error={error}
          isLoading={isLoading}
        />
      )}

      {view === "email-verification" && (
        <EmailVerificationForm
          email={pendingEmail}
          onSubmit={handleEmailVerification}
          onResend={handleResendVerification}
          onBackToLogin={() => switchView("login")}
          error={error}
          isLoading={isLoading}
        />
      )}
    </AuthLayout>
  );
}
