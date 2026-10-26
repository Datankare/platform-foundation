/**
 * platform/auth/provider.ts — AuthProvider interface
 *
 * This is the core auth contract for the platform. Every route, middleware,
 * and component depends on this interface — never on a provider directly.
 *
 * Implementations:
 * - CognitoAuthProvider (Playform — AWS Cognito)
 * - Future: Auth0AuthProvider, FirebaseAuthProvider, ClerkAuthProvider
 *
 * ADR-012: Auth provider interface for cloud-agnostic platform.
 *
 * Design principles:
 * - Provider-agnostic: no Cognito/Auth0/Firebase types leak through
 * - Fail-closed: all methods return result objects, never throw for auth failures
 * - Auditable: every method returns enough context for logging
 * - Testable: interface enables mock implementations for testing
 */

import type { ErrorCode } from "@/platform/errors/registry";
import type {
  AuthResult,
  AuthSession,
  AuthToken,
  AuthUserId,
  ChangePasswordResult,
  DeviceInfo,
  EmailVerificationResult,
  GuestTokenResult,
  MfaSetupResult,
  MfaVerifyResult,
  PasswordRecoveryResult,
  PasswordResetResult,
  SsoCallbackOptions,
  SsoCallbackResult,
  SsoInitOptions,
  SsoInitResult,
  SsoProvider,
  TokenPayload,
} from "@/platform/auth/types";

/** What sign-up asks besides the credentials (the server checks and records it). */
export interface SignUpProfile {
  /** YYYY-MM-DD — required by the platform's sign-up route (COPPA, audit X-16). */
  readonly dateOfBirth?: string;
}

export interface AuthProvider {
  // ── Sign Up / Sign In ──────────────────────────────────────────────

  /**
   * Register a new user with email and password.
   * Does NOT sign the user in — they must verify email first.
   */
  signUp(email: string, password: string, profile?: SignUpProfile): Promise<AuthResult>;

  /**
   * Sign in with email and password.
   * Returns tokens if successful, or mfaRequired if MFA is enabled.
   */
  signIn(email: string, password: string): Promise<AuthResult>;

  /**
   * Sign out — revoke the session (audit X-17): every token of the user's sign-in, and the
   * refresh token when given. Throws when the revocation could not be made: a sign-out that
   * revoked nothing is not reported as one.
   */
  signOut(accessToken: AuthToken, refreshToken?: AuthToken): Promise<void>;

  // ── Token Management ───────────────────────────────────────────────

  /**
   * Verify and decode a JWT access token.
   * Returns the decoded payload if valid, null if invalid/expired.
   * This is the method called on every protected API route. `options.privileged`: the route is
   * an administrative one, which fails closed when the provider cannot answer (a provider may
   * throw TokenVerificationUnavailableError, platform/auth/token-verification.ts).
   */
  verifyToken(
    accessToken: AuthToken,
    options?: { readonly privileged?: boolean }
  ): Promise<TokenPayload | null>;

  /**
   * Refresh an expired access token using a refresh token.
   * Returns a new session with fresh tokens. `subject` is the session's user (the `sub` its
   * tokens name, TASK-177): a refreshed session for anyone else is not used.
   */
  refreshToken(
    refreshToken: AuthToken,
    subject?: AuthUserId
  ): Promise<AuthSession | null>;

  // ── Password Management ────────────────────────────────────────────

  /**
   * Initiate password recovery — sends a reset code to the user's email.
   */
  forgotPassword(email: string): Promise<PasswordRecoveryResult>;

  /**
   * Confirm password reset with the code sent to the user's email.
   */
  confirmForgotPassword(
    email: string,
    code: string,
    newPassword: string
  ): Promise<PasswordResetResult>;

  /**
   * Change password for an authenticated user.
   * Requires the current password for verification.
   */
  changePassword(
    accessToken: AuthToken,
    oldPassword: string,
    newPassword: string
  ): Promise<ChangePasswordResult>;

  // ── Email Verification ─────────────────────────────────────────────

  /**
   * Confirm email verification with a code sent during sign-up.
   */
  confirmEmailVerification(email: string, code: string): Promise<EmailVerificationResult>;

  /**
   * Resend the email verification code.
   */
  resendEmailVerification(email: string): Promise<EmailVerificationResult>;

  // ── Multi-Factor Authentication ────────────────────────────────────

  /**
   * Set up TOTP MFA for the authenticated user.
   * Returns the secret and QR code URI for authenticator app enrollment.
   */
  setupMfa(accessToken: AuthToken): Promise<MfaSetupResult>;

  /**
   * Verify a TOTP code to complete MFA setup.
   * Called after the user scans the QR code and enters their first code.
   */
  verifyMfaSetup(accessToken: AuthToken, totpCode: string): Promise<MfaVerifyResult>;

  /**
   * Complete MFA challenge during sign-in.
   * Called when signIn returns mfaRequired: true.
   */
  respondToMfaChallenge(
    mfaSession: string,
    totpCode: string,
    username: string
  ): Promise<AuthResult>;

  /**
   * Complete a NEW_PASSWORD_REQUIRED challenge during sign-in.
   * Called when signIn returns newPasswordRequired: true (e.g. admin-created
   * users with a temporary password on first sign-in). Cognito requires the
   * real username in the challenge response, so it is passed explicitly.
   */
  respondToNewPasswordChallenge(
    challengeSession: string,
    newPassword: string,
    username: string
  ): Promise<AuthResult>;

  /**
   * Disable MFA for the authenticated user.
   */
  disableMfa(accessToken: AuthToken): Promise<{ success: boolean; error?: string }>;

  // ── SSO (Social Sign-In) ──────────────────────────────────────────

  /**
   * Initiate SSO sign-in — returns the redirect URL for the identity provider.
   * The user's browser navigates to this URL to authenticate with Google/Apple/Microsoft.
   */
  initiateSso(
    provider: SsoProvider,
    redirectUri: string,
    options?: SsoInitOptions
  ): Promise<SsoInitResult>;

  /**
   * Handle the SSO callback — exchange the authorization code for tokens.
   * Called when the identity provider redirects back to our app.
   */
  handleSsoCallback(
    provider: SsoProvider,
    code: string,
    redirectUri: string,
    options?: SsoCallbackOptions
  ): Promise<SsoCallbackResult>;

  // ── Guest Mode ─────────────────────────────────────────────────────

  /**
   * Generate a persistent guest token.
   * Creates a guest identity that can accumulate data and later convert.
   */
  createGuestToken(): Promise<GuestTokenResult>;

  /**
   * Verify a guest token — check it's valid and not expired.
   */
  verifyGuestToken(token: AuthToken): Promise<{ valid: boolean; guestId?: string }>;

  // ── Device Management ──────────────────────────────────────────────

  /**
   * List devices the user has signed in from.
   */
  listDevices(accessToken: AuthToken): Promise<DeviceInfo[]>;

  /**
   * Forget (remove) a specific device.
   */
  forgetDevice(
    accessToken: AuthToken,
    deviceId: string
  ): Promise<{ success: boolean; error?: string }>;

  // ── User Info ──────────────────────────────────────────────────────

  /**
   * Get the user's auth-level attributes (email, email_verified, sub).
   * This is NOT the user profile — it's the auth provider's view of the user.
   */
  getUserInfo(accessToken: AuthToken): Promise<{
    userId: AuthUserId;
    email: string;
    emailVerified: boolean;
  } | null>;

  /**
   * Delete the user's auth account.
   * Called as part of GDPR right-to-erasure — removes the user from the auth provider.
   */
  deleteUser(accessToken: AuthToken): Promise<{ success: boolean; error?: string }>;

  // ── Tenancy (ADR-053 D2) — optional: single-tenant deployments never call these ──

  /**
   * Set the tenant the provider reports for a user (TokenPayload.tenantId). It must be a value
   * the user cannot change themselves. Shared deployments require it.
   */
  assignTenant?(
    userId: AuthUserId,
    tenantId: string
  ): Promise<{ success: boolean; error?: string; errorCode?: ErrorCode }>;

  /** The user's tenant as the provider holds it: null for none, undefined when unreadable. */
  getUserTenant?(userId: AuthUserId): Promise<string | null | undefined>;

  /** Whether the provider holds tenants safely (shown to operators; checked at readiness). */
  checkTenantAttribute?(): Promise<TenantAttributeReadiness>;

  /**
   * Whether the identity pool has the shape the platform requires (review 17 L2/L4: users sign
   * in by email address; the app client may read who verified an address). Checked at readiness
   * (platform/auth/pool-shape-probe.ts). Optional: a provider without it is not checked.
   */
  checkPoolShape?(): Promise<PoolShapeReadiness>;
}

/**
 * - `ready`   — the pool has the required shape;
 * - `unsafe`  — it does not (`cause` says how: username sign-in, `identities` hidden);
 * - `unknown` — it could not be checked (no credentials, or the provider did not answer).
 */
export type PoolShapeReadiness =
  | { readonly state: "ready" }
  | {
      readonly state: "unsafe";
      readonly reason: string;
      readonly cause: "username_sign_in" | "identities_hidden";
    }
  | {
      readonly state: "unknown";
      readonly reason: string;
      readonly cause: "no_credentials" | "unavailable";
    };

/**
 * - `ready`   — the attribute exists, users can read but not write it;
 * - `missing` — the provider has no such attribute yet;
 * - `unsafe`  — it exists but users could change it, or the app could not read it;
 * - `unknown` — it could not be checked (no credentials, or the provider did not answer).
 */
export type TenantAttributeReadiness =
  | { readonly state: "ready" }
  | { readonly state: "missing" | "unsafe" | "unknown"; readonly reason: string };
