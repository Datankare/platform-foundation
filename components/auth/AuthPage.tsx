"use client";

import React, { useState } from "react";
import AuthLayout from "@/components/auth/AuthLayout";
import LoginForm from "@/components/auth/LoginForm";
import RegisterForm from "@/components/auth/RegisterForm";
import ForgotPasswordForm from "@/components/auth/ForgotPasswordForm";
import MfaChallengeForm from "@/components/auth/MfaChallengeForm";
import NewPasswordForm from "@/components/auth/NewPasswordForm";
import EmailVerificationForm from "@/components/auth/EmailVerificationForm";
import AgeGate from "@/components/auth/AgeGate";
import { getAuthProvider } from "@/platform/auth/config";
import { useAuth } from "@/platform/auth/context";
import type { SsoProvider } from "@/platform/auth/types";
import { useSsoProviders } from "@/components/auth/useSsoProviders";
import { useReturnError } from "@/components/auth/useReturnError";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import { readRefusal } from "@/platform/errors/refusal";
import { apiFetch } from "@/platform/auth/api-fetch";

/** This screen's text, from the message catalog (ADR-051 D4, TASK-205). */
const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.auth.page.${key}`, values);

type AuthView =
  | "login"
  | "register"
  | "forgot-password"
  | "mfa-challenge"
  | "new-password"
  | "email-verification";

/**
 * A guest session (ADR-050 D4): the server mints the guest's token, keeps it in a server-side
 * session and sets the session cookie (ADR-057) — the page receives no token. A refusal answers
 * its own message (TASK-181: a rate limit, an unavailable service or tenant).
 */
async function startGuestSession(): Promise<{ started: true } | { error: string }> {
  const res = await apiFetch("/api/auth/guest", { method: "POST" });
  if (!res.ok) return { error: (await readRefusal(res)).message };
  const result = (await res.json().catch(() => ({}))) as { guestId?: unknown };
  if (typeof result.guestId !== "string") return { error: t("guest_access_failed") };
  return { started: true };
}

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
  const [actionError, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [mfaSession, setMfaSession] = useState<string | null>(null);
  const [challengeSession, setChallengeSession] = useState<string | null>(null);
  const [pendingEmail, setPendingEmail] = useState<string>("");
  // Asked before the account form (COPPA, audit X-16); the server checks and records it.
  const [dateOfBirth, setDateOfBirth] = useState<string | null>(null);
  const ssoProviders = useSsoProviders();
  const { sessionStarted } = useAuth();
  // A completed sign-in: the server set the session cookie and kept the provider's tokens
  // (ADR-057); the page reads who is signed in from the server.
  const signIn = async (r: { success?: boolean; userId?: string }) => {
    if (r.success && r.userId && !(await sessionStarted())) {
      setError(t("an_unexpected_error_occurred_please"));
    }
  };

  const { returnError, dismissReturnError } = useReturnError();
  const error = actionError ?? returnError;

  const clearError = () => {
    setError(null);
    setNotice(null);
    dismissReturnError();
  };

  const handleLogin = async (email: string, password: string) => {
    clearError();
    setIsLoading(true);
    try {
      const auth = getAuthProvider();
      const result = await auth.signIn(email, password);

      if (result.mfaRequired && result.mfaSession) {
        setMfaSession(result.mfaSession);
        // The challenge is answered for the user it was issued to (audit A-9).
        setPendingEmail(email);
        setView("mfa-challenge");
        return;
      }

      if (result.newPasswordRequired && result.challengeSession) {
        setChallengeSession(result.challengeSession);
        setPendingEmail(email);
        setView("new-password");
        return;
      }

      // An unconfirmed account answers success: false WITH emailVerificationRequired — the next
      // step, not a failure (TASK-181: it showed "Sign-in failed").
      if (result.emailVerificationRequired) {
        setPendingEmail(email);
        setView("email-verification");
        return;
      }

      if (!result.success) {
        setError(result.error || t("sign_in_failed"));
        return;
      }

      await signIn(result);
    } catch {
      /* justified */
      // Auth errors shown to user via setError
      setError(t("an_unexpected_error_occurred_please"));
    } finally {
      setIsLoading(false);
    }
  };

  const handleRegister = async (email: string, password: string) => {
    clearError();
    setIsLoading(true);
    try {
      const auth = getAuthProvider();
      if (!dateOfBirth) {
        setError(t("please_enter_your_date_of"));
        return;
      }
      const result = await auth.signUp(email, password, { dateOfBirth });

      if (!result.success) {
        setError(result.error || t("registration_failed"));
        return;
      }

      setPendingEmail(email);
      setView("email-verification");
    } catch {
      /* justified */
      // Auth errors shown to user via setError
      setError(t("an_unexpected_error_occurred_please"));
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
        setError(result.error || t("verification_failed"));
        return;
      }

      // After verification, sign the user in
      setView("login");
    } catch {
      /* justified */
      // Auth errors shown to user via setError
      setError(t("an_unexpected_error_occurred_please"));
    } finally {
      setIsLoading(false);
    }
  };

  const handleResendVerification = async (): Promise<boolean> => {
    clearError();
    setIsLoading(true);
    try {
      const auth = getAuthProvider();
      const result = await auth.resendEmailVerification(pendingEmail);
      if (!result.success) {
        setError(result.error || t("could_not_resend_verification_code"));
        return false;
      }
      setNotice(renderMessage("screens.auth.code_resent"));
      return true;
    } catch {
      /* justified */
      // Auth errors shown to user via setError
      setError(t("could_not_resend_verification_code"));
      return false;
    } finally {
      setIsLoading(false);
    }
  };

  const handleForgotPasswordSend = async (email: string): Promise<boolean> => {
    clearError();
    setIsLoading(true);
    try {
      const auth = getAuthProvider();
      const result = await auth.forgotPassword(email);

      if (!result.success) {
        setError(result.error || t("could_not_send_reset_code"));
        return false;
      }
      setPendingEmail(email);
      return true;
    } catch {
      /* justified */
      // Auth errors shown to user via setError
      setError(t("an_unexpected_error_occurred_please"));
      return false;
    } finally {
      setIsLoading(false);
    }
  };

  const handleForgotPasswordConfirm = async (
    email: string,
    code: string,
    newPassword: string
  ): Promise<boolean> => {
    clearError();
    setIsLoading(true);
    try {
      const auth = getAuthProvider();
      const result = await auth.confirmForgotPassword(email, code, newPassword);

      if (!result.success) {
        // The server's words: a wrong or expired code, the password policy, a rate limit.
        setError(result.error || t("password_reset_failed"));
        return false;
      }
      return true;
    } catch {
      /* justified */
      // Auth errors shown to user via setError
      setError(t("an_unexpected_error_occurred_please"));
      return false;
    } finally {
      setIsLoading(false);
    }
  };

  const handleMfaChallenge = async (totpCode: string) => {
    clearError();
    setIsLoading(true);
    try {
      const auth = getAuthProvider();
      const result = await auth.respondToMfaChallenge(
        mfaSession || "",
        totpCode,
        pendingEmail
      );

      if (!result.success) {
        setError(result.error || t("invalid_code"));
        return;
      }

      await signIn(result);
    } catch {
      /* justified */
      // Auth errors shown to user via setError
      setError(t("an_unexpected_error_occurred_please"));
    } finally {
      setIsLoading(false);
    }
  };

  // TASK-101: the server starts SSO (state + PKCE) and redirects to the hosted sign-in.
  const handleSsoClick = (provider: SsoProvider): Promise<void> => {
    clearError();
    setIsLoading(true);
    // A full navigation: the route answers with a redirect to the provider's hosted sign-in,
    // which client navigation cannot follow.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign(`/api/auth/sso/${provider}`);
    return Promise.resolve();
  };

  const handleGuestClick = async () => {
    clearError();
    setIsLoading(true);
    try {
      const guest = await startGuestSession();
      if ("error" in guest) setError(guest.error);
      else if (!(await sessionStarted())) setError(t("guest_access_failed"));
    } catch {
      /* justified */
      // Auth errors shown to user via setError
      setError(t("an_unexpected_error_occurred_please"));
    } finally {
      setIsLoading(false);
    }
  };

  const handleNewPasswordSubmit = async (newPassword: string) => {
    clearError();
    setIsLoading(true);
    try {
      const auth = getAuthProvider();
      const result = await auth.respondToNewPasswordChallenge(
        challengeSession || "",
        newPassword,
        pendingEmail
      );

      if (!result.success) {
        setError(result.error || t("could_not_set_new_password"));
        return;
      }

      await signIn(result);
    } catch {
      /* justified */
      // Auth errors shown to user via setError
      setError(t("an_unexpected_error_occurred_please"));
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
          enabledSsoProviders={ssoProviders}
          onGuestClick={handleGuestClick}
          onForgotPassword={() => switchView("forgot-password")}
          onCreateAccount={() => switchView("register")}
          error={error}
          isLoading={isLoading}
        />
      )}

      {view === "register" && dateOfBirth === null && (
        <AgeGate
          onVerified={(_result, declared) => setDateOfBirth(declared)}
          onCancel={() => switchView("login")}
        />
      )}

      {view === "register" && dateOfBirth !== null && (
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

      {view === "new-password" && (
        <NewPasswordForm
          onSubmit={handleNewPasswordSubmit}
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
          notice={notice}
          isLoading={isLoading}
        />
      )}
    </AuthLayout>
  );
}
