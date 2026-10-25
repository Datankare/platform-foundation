/**
 * platform/auth/browser-auth-provider.ts — Browser-safe AuthProvider
 *
 * Implements AuthProvider by calling the server's /api/auth/* routes via fetch, so the server's
 * providers — the identity provider's SDK and secrets, and the production checks that refuse
 * in-memory stores — never load in the browser (PF v5.1.1; Playform's, adopted by the platform).
 * What has no route here answers a coded failure without a network call, never a fake success.
 *
 * @module platform/auth
 */

import type { AuthProvider, SignUpProfile } from "@/platform/auth/provider";
import type {
  AuthResult,
  AuthSession,
  AuthToken,
  ChangePasswordResult,
  DeviceInfo,
  EmailVerificationResult,
  GuestTokenResult,
  MfaSetupResult,
  MfaVerifyResult,
  PasswordRecoveryResult,
  PasswordResetResult,
  SsoCallbackResult,
  SsoInitResult,
  SsoProvider,
  TokenPayload,
} from "@/platform/auth/types";

/**
 * Posts to an auth route. A failure is read from the status, not trusted from the body: a coded
 * error keeps its code (as `errorCode`), and a reply that is not JSON — a proxy's 502 page — is
 * `internal.error`, never a thrown parse error or a success.
 */
async function postAuth<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) return data as T;
  return {
    ...data,
    success: false,
    errorCode: data.errorCode ?? data.code ?? "internal.error",
  } as T;
}

/** A method with no route for the browser: a coded failure, and no request is made. */
function notFromTheBrowser(method: string): {
  success: false;
  error: string;
  errorCode: "feature.not_configured";
} {
  return {
    success: false,
    error: `${method} is not available from the browser`,
    errorCode: "feature.not_configured",
  };
}

/**
 * Create a browser-safe AuthProvider that delegates to server-side API routes.
 */
export function createBrowserAuthProvider(): AuthProvider {
  return {
    // ── Sign Up / Sign In ──
    signUp: (email: string, password: string, profile?: SignUpProfile) =>
      postAuth<AuthResult>("/api/auth/sign-up", {
        email,
        password,
        ...(profile?.dateOfBirth ? { dateOfBirth: profile.dateOfBirth } : {}),
      }),

    signIn: (email: string, password: string) =>
      postAuth<AuthResult>("/api/auth/sign-in", { email, password }),

    signOut: async (accessToken: AuthToken) => {
      await fetch("/api/auth/sign-out", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    },

    // ── Token Management ──
    verifyToken: async (_accessToken: AuthToken) => null as TokenPayload | null,
    refreshToken: async (_refreshToken: AuthToken) => null as AuthSession | null,

    // ── Password Management ──
    forgotPassword: (email: string) =>
      postAuth<PasswordRecoveryResult>("/api/auth/forgot-password", { email }),

    confirmForgotPassword: (email: string, code: string, newPassword: string) =>
      postAuth<PasswordResetResult>("/api/auth/confirm-forgot-password", {
        email,
        code,
        newPassword,
      }),

    changePassword: async (
      _accessToken: AuthToken,
      _oldPassword: string,
      _newPassword: string
    ): Promise<ChangePasswordResult> => notFromTheBrowser("changePassword"),

    // ── Email Verification ──
    confirmEmailVerification: (email: string, code: string) =>
      postAuth<EmailVerificationResult>("/api/auth/verify-email", { email, code }),

    resendEmailVerification: (email: string) =>
      postAuth<EmailVerificationResult>("/api/auth/resend-verification", { email }),

    // ── MFA ──
    setupMfa: async (_accessToken: AuthToken): Promise<MfaSetupResult> =>
      notFromTheBrowser("setupMfa"),

    verifyMfaSetup: async (
      _accessToken: AuthToken,
      _totpCode: string
    ): Promise<MfaVerifyResult> => notFromTheBrowser("verifyMfaSetup"),

    respondToMfaChallenge: (mfaSession: string, totpCode: string, username: string) =>
      postAuth<AuthResult>("/api/auth/mfa-challenge", {
        session: mfaSession,
        code: totpCode,
        username,
      }),

    respondToNewPasswordChallenge: (
      challengeSession: string,
      newPassword: string,
      username: string
    ) =>
      postAuth<AuthResult>("/api/auth/new-password-challenge", {
        session: challengeSession,
        newPassword,
        username,
      }),

    disableMfa: async (_accessToken: AuthToken) => notFromTheBrowser("disableMfa"),

    // ── SSO ──
    // The browser starts SSO by navigating to /api/auth/sso/<provider> (the server keeps state
    // and PKCE), and the callback page posts to /api/auth/sso/callback.
    initiateSso: async (
      _provider: SsoProvider,
      _redirectUri: string
    ): Promise<SsoInitResult> => notFromTheBrowser("initiateSso"),

    handleSsoCallback: async (
      _provider: SsoProvider,
      _code: string,
      _redirectUri: string
    ): Promise<SsoCallbackResult> => notFromTheBrowser("handleSsoCallback"),

    // ── Guest ──
    createGuestToken: () => postAuth<GuestTokenResult>("/api/auth/guest"),

    verifyGuestToken: async (_token: AuthToken) => ({ valid: false }),

    // ── Devices ──
    listDevices: async (_accessToken: AuthToken) => [] as DeviceInfo[],
    forgetDevice: async (_accessToken: AuthToken, _deviceId: string) =>
      notFromTheBrowser("forgetDevice"),

    // ── User Info ──
    getUserInfo: async (_accessToken: AuthToken) => null,
    deleteUser: async (_accessToken: AuthToken) => notFromTheBrowser("deleteUser"),
  };
}
