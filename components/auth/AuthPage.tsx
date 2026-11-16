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
import { useReturnError } from "@/components/auth/useReturnError";
import { useAuthSteps, type AuthView } from "@/components/auth/useAuthSteps";
import { StepMoved } from "@/components/auth/ui/AuthHeading";
import { leaveFor } from "@/components/auth/ui/leave-for";
import { usePasswordPolicy } from "@/components/auth/ui/usePasswordPolicy";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import { readRefusal } from "@/platform/errors/refusal";
import { apiFetch } from "@/platform/auth/api-fetch";
import { returnPathFromLocation, ssoStartPath } from "@/platform/auth/return-path";

/** This screen's text, from the message catalog (ADR-051 D4, TASK-205). */
const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.auth.page.${key}`, values);

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
 * - Login → success → the page asked for (`?redirect=`), or the app (AuthPageClient)
 * - Login → MFA required → MFA challenge → success → the same
 * - Register → email verification → sign-in, with "verified" said and the address filled in
 * - Forgot password → send code → enter code + new password → sign-in, the same way
 * - Guest → the app with a guest session
 *
 * Each step is in the address and its heading takes focus when it opens (SF-app-041). A step
 * that needs what an earlier one gave (the two-step challenge, the new-password challenge, the
 * address being verified) cannot be opened from the address alone: it is sign-in then.
 */
export default function AuthPage({
  ssoProviders = [],
}: {
  /** The single sign-on providers this deployment offers, from the server (ADR-050 D3). */
  readonly ssoProviders?: SsoProvider[];
}) {
  const [actionError, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [signInNotice, setSignInNotice] = useState<string | null>(null);
  const [signInEmail, setSignInEmail] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [mfaSession, setMfaSession] = useState<string | null>(null);
  const [challengeSession, setChallengeSession] = useState<string | null>(null);
  const [pendingEmail, setPendingEmail] = useState<string>("");
  // Asked before the account form (COPPA, audit X-16); the server checks and records it.
  const [dateOfBirth, setDateOfBirth] = useState<string | null>(null);
  const policy = usePasswordPolicy();
  const { sessionStarted } = useAuth();
  // A completed sign-in: the server set the session cookie and kept the provider's tokens
  // (ADR-057); the page reads who is signed in from the server, and AuthPageClient then goes on.
  const signIn = async (r: { success?: boolean; userId?: string }) => {
    if (r.success && r.userId && !(await sessionStarted())) {
      setError(t("an_unexpected_error_occurred_please"));
    }
  };

  const { returnError, returnNotice, dismissReturnError } = useReturnError();
  const error = actionError ?? returnError;

  const clearError = () => {
    setError(null);
    setNotice(null);
    setSignInNotice(null);
    dismissReturnError();
  };

  // Each step in the address, Back and Forward between them, the heading focused (SF-app-041).
  // A step that needs an earlier step's answer cannot be opened without it: sign-in then.
  const {
    view,
    moved,
    switchView: moveTo,
    markMoved,
  } = useAuthSteps(
    (next) =>
      (next !== "mfa-challenge" || mfaSession !== null) &&
      (next !== "new-password" || challengeSession !== null) &&
      (next !== "email-verification" || pendingEmail !== ""),
    () => {
      setError(null);
      setNotice(null);
    }
  );
  const switchView = (newView: AuthView) => {
    clearError();
    moveTo(newView);
  };

  /** Back to sign-in after a step that ends in it, with what happened said and the address. */
  const toSignIn = (email: string, said: string) => {
    switchView("login");
    setSignInEmail(email);
    setSignInNotice(said);
  };

  /** Back to sign-in from a step of a sign-in under way, the address it was started with kept. */
  const cancelSignIn = () => {
    switchView("login");
    setSignInEmail(pendingEmail);
  };

  const unexpected = t("an_unexpected_error_occurred_please");
  /**
   * One step's call to the auth provider: what the page said is cleared, the step is busy while
   * the call runs, and a call that throws is said as `thrown` (the step's own error otherwise).
   */
  const attempt = async <T,>(work: () => Promise<T>, onThrow: T, thrown = unexpected) => {
    clearError();
    setIsLoading(true);
    try {
      return await work();
    } catch {
      /* justified */
      // Auth errors shown to user via setError
      setError(thrown);
      return onThrow;
    } finally {
      setIsLoading(false);
    }
  };
  /** A refusal said: the server's words, or the step's own. */
  const refused = (r: { error?: string }, own: string) => {
    setError(r.error || t(own));
  };

  const handleLogin = (email: string, password: string) =>
    attempt(async () => {
      const result = await getAuthProvider().signIn(email, password);
      if (result.mfaRequired && result.mfaSession) {
        setMfaSession(result.mfaSession);
        // The challenge is answered for the user it was issued to (audit A-9).
        setPendingEmail(email);
        return switchView("mfa-challenge");
      }
      if (result.newPasswordRequired && result.challengeSession) {
        setChallengeSession(result.challengeSession);
        setPendingEmail(email);
        return switchView("new-password");
      }
      // An unconfirmed account answers success: false WITH emailVerificationRequired — the next
      // step, not a failure (TASK-181: it showed "Sign-in failed").
      if (result.emailVerificationRequired) {
        setPendingEmail(email);
        return switchView("email-verification");
      }
      if (!result.success) return refused(result, "sign_in_failed");
      await signIn(result);
    }, undefined);

  const handleRegister = (email: string, password: string) =>
    attempt(async () => {
      if (!dateOfBirth) return setError(t("please_enter_your_date_of"));
      const result = await getAuthProvider().signUp(email, password, { dateOfBirth });
      if (!result.success) return refused(result, "registration_failed");
      setPendingEmail(email);
      switchView("email-verification");
    }, undefined);

  const handleEmailVerification = (code: string) =>
    attempt(async () => {
      const result = await getAuthProvider().confirmEmailVerification(pendingEmail, code);
      if (!result.success) return refused(result, "verification_failed");
      // Verified: sign-in, saying so, the address filled in (SF-app-040). The password is not
      // kept from the account form to sign in by itself: this page holds no password longer
      // than the form it was typed in.
      toSignIn(pendingEmail, t("email_verified"));
    }, undefined);

  const handleResendVerification = () =>
    attempt(
      async () => {
        const result = await getAuthProvider().resendEmailVerification(pendingEmail);
        if (!result.success) {
          refused(result, "could_not_resend_verification_code");
          return false;
        }
        setNotice(renderMessage("screens.auth.code_resent"));
        return true;
      },
      false,
      t("could_not_resend_verification_code")
    );

  const handleForgotPasswordSend = (email: string) =>
    attempt(async () => {
      const result = await getAuthProvider().forgotPassword(email);
      if (!result.success) {
        refused(result, "could_not_send_reset_code");
        return false;
      }
      setPendingEmail(email);
      return true;
    }, false);

  const handleForgotPasswordConfirm = (
    email: string,
    code: string,
    newPassword: string
  ) =>
    attempt(async () => {
      const result = await getAuthProvider().confirmForgotPassword(
        email,
        code,
        newPassword
      );
      // The server's words: a wrong or expired code, the password policy, a rate limit.
      if (!result.success) refused(result, "password_reset_failed");
      return result.success;
    }, false);

  const handleMfaChallenge = (totpCode: string) =>
    attempt(async () => {
      const auth = getAuthProvider();
      const result = await auth.respondToMfaChallenge(
        mfaSession || "",
        totpCode,
        pendingEmail
      );
      if (!result.success) return refused(result, "invalid_code");
      await signIn(result);
    }, undefined);

  // TASK-101: the server starts SSO (state + PKCE) and redirects to the hosted sign-in.
  const handleSsoClick = (provider: SsoProvider): Promise<void> => {
    clearError();
    setIsLoading(true);
    // A full navigation: the route answers with a redirect to the provider's hosted sign-in,
    // which client navigation cannot follow. The page asked for goes with the attempt (E-113):
    // the route keeps it in the attempt's cookie, and the callback returns to it.
    leaveFor(ssoStartPath(provider, returnPathFromLocation(window.location)));
    return Promise.resolve();
  };

  const handleGuestClick = () =>
    attempt(async () => {
      const guest = await startGuestSession();
      if ("error" in guest) setError(guest.error);
      else if (!(await sessionStarted())) setError(t("guest_access_failed"));
    }, undefined);

  const handleNewPasswordSubmit = (newPassword: string) =>
    attempt(async () => {
      const auth = getAuthProvider();
      const result = await auth.respondToNewPasswordChallenge(
        challengeSession || "",
        newPassword,
        pendingEmail
      );
      if (!result.success) return refused(result, "could_not_set_new_password");
      await signIn(result);
    }, undefined);

  return (
    <AuthLayout>
      <StepMoved.Provider value={moved}>
        {view === "login" && (
          <LoginForm
            onSubmit={handleLogin}
            onSsoClick={handleSsoClick}
            enabledSsoProviders={ssoProviders}
            onGuestClick={handleGuestClick}
            onForgotPassword={() => switchView("forgot-password")}
            onCreateAccount={() => switchView("register")}
            error={error}
            notice={signInNotice ?? returnNotice}
            initialEmail={signInEmail}
            isLoading={isLoading}
          />
        )}

        {view === "register" && dateOfBirth === null && (
          <AgeGate
            onVerified={(_result, declared) => {
              setDateOfBirth(declared);
              // The account form is a new step on the same address: its heading takes focus.
              markMoved();
            }}
            onCancel={() => switchView("login")}
          />
        )}

        {view === "register" && dateOfBirth !== null && (
          <RegisterForm
            onSubmit={handleRegister}
            onBackToLogin={() => switchView("login")}
            policy={policy}
            error={error}
            isLoading={isLoading}
          />
        )}

        {view === "forgot-password" && (
          <ForgotPasswordForm
            onSendCode={handleForgotPasswordSend}
            onConfirmReset={handleForgotPasswordConfirm}
            onResetDone={(email) => toSignIn(email, t("password_was_reset"))}
            onBackToLogin={() => switchView("login")}
            policy={policy}
            error={error}
            isLoading={isLoading}
          />
        )}

        {view === "mfa-challenge" && (
          <MfaChallengeForm
            onSubmit={handleMfaChallenge}
            onCancel={cancelSignIn}
            error={error}
            isLoading={isLoading}
          />
        )}

        {view === "new-password" && (
          <NewPasswordForm
            onSubmit={handleNewPasswordSubmit}
            onCancel={cancelSignIn}
            policy={policy}
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
      </StepMoved.Provider>
    </AuthLayout>
  );
}
