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

import type { ShownText } from "@/platform/errors/shown-text";
import type { ErrorCode } from "@/platform/errors/registry";
import type { MessageValues } from "@/platform/errors/messages";
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
  RenewalOutcome,
  SignOutEverywhereResult,
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
   * End one sign-in at the provider (ADR-057 D6): revoke `refreshToken`, and with it every access
   * token it issued. The server-side session calls it with the refresh token it holds and no
   * access token (`""`) — the user's other sign-ins are untouched; ending them all is
   * signOutEverywhere. An `accessToken`, when given, is not sent to the provider. Throws when the
   * revocation could not be made: a sign-out that revoked nothing is not reported as one.
   */
  signOut(accessToken: AuthToken, refreshToken?: AuthToken): Promise<void>;

  /**
   * End every token the provider issued `userId` (its subject), on every device — sign-out
   * everywhere, a password change, a restriction, erasure (ADR-057 D6). An administrative call
   * (Cognito: AdminUserGlobalSignOut), never the user's own token. A failure is a result, not a
   * throw: the platform's own sessions are ended in its records whatever the provider answers.
   */
  signOutEverywhere(userId: AuthUserId): Promise<SignOutEverywhereResult>;

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

  /**
   * Renew a server-side session from the refresh token it holds (ADR-057 D3), telling a refusal
   * (the session ends) from the provider not answering (the session is kept). `subject` as for
   * refreshToken.
   */
  renewSession(refreshToken: AuthToken, subject: AuthUserId): Promise<RenewalOutcome>;

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
   *
   * Enrolment (this and verifyMfaSetup) is the one operation the server performs with the user's
   * own access token (ADR-057 D7): Cognito's AssociateSoftwareToken and VerifySoftwareToken take
   * a user token only — no administrative call exists for them (docs/SECURITY_DEBT.md SEC-018).
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
   * Disable MFA for the user whose subject is `userId` — an administrative call (Cognito:
   * AdminSetUserMFAPreference), never the user's own token (ADR-057 D7). The route proves the
   * current factor first (step-up).
   */
  disableMfa(
    userId: AuthUserId
  ): Promise<{ success: boolean; error?: string; errorCode?: ErrorCode }>;

  /**
   * Prove the caller holds the account's CURRENT second factor now (step-up, TASK-194 audit
   * C-3): the user whose subject is `userId` (the session's — read administratively, ADR-057 D7)
   * signs in again with `password` and answers the MFA challenge with `totpCode` from the
   * authenticator already enrolled. Changing or removing a factor requires it, so a hijacked
   * session alone can neither turn MFA off nor enrol an attacker's authenticator. The sign-in it
   * makes leaves no session (its tokens are revoked). Fails — coded — on a wrong password or
   * code, an account with no factor, or a proof made by another user.
   * Cognito checks an enrolled factor's code only inside a sign-in challenge, hence the password.
   *
   * `totpCode` null (TASK-194 round 1, B1 — the delegation consent): the account proves itself
   * with its password alone, which only an account with NO second factor may — one with a factor
   * is refused auth.step_up_required (its code is needed). A federated account without a pool
   * password is refused auth.step_up_unavailable.
   */
  confirmCurrentFactor(
    userId: AuthUserId,
    password: string,
    totpCode: string | null
  ): Promise<{
    success: boolean;
    error?: string;
    errorCode?: ErrorCode;
    /** The code's params (`service.unavailable`'s service, TASK-197). */
    errorParams?: MessageValues;
  }>;

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

  /**
   * Delete a user's identity with the provider's administrative credentials, by its subject
   * (TASK-193, audit B-8/D-9): how erasure removes the sign-in identity — the address and
   * attributes the provider holds — for an admin or retention erasure as for a self-service one,
   * retried until it is done (platform/gdpr/external-erasure.ts). `notFound` only when the
   * provider proved this pool has no user with the subject — looked up by the subject itself
   * (Cognito: ListUsers on `sub`, which finds federated users too), never by assuming the subject
   * is the username; the erasure then counts it erased only in the account's recorded pool, after
   * confirmIdentityPool. It also forgets the subject's remembered token
   * verifications. Optional: a provider without it leaves every erasure's identity step pending,
   * and alerted.
   */
  adminDeleteUser?(
    userId: AuthUserId
  ): Promise<{ success: boolean; notFound?: boolean; error?: string }>;

  /**
   * The identity pool adminDeleteUser erases from (TASK-193 round 1): recorded on each erasure,
   * so a later "not found" counts as erased only in the pool the account was in.
   */
  identityPoolId?(): string | undefined;

  /**
   * A positive check that the administrative credentials reach identityPoolId()'s pool (Cognito:
   * DescribeUserPool answers its id). False when it cannot be shown.
   */
  confirmIdentityPool?(): Promise<boolean>;

  /**
   * Whether this pool has the identity with this subject (S2 round 2): true only when the provider
   * found it — its own lookup, or a subject learnt from a token this pool verified; false when it
   * has none; undefined when it could not tell. An erasure records its pool only on true.
   */
  identityInPool?(userId: AuthUserId): Promise<boolean | undefined>;

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

  /**
   * Whether erasure can delete identities from this pool (N-22): the administrative credentials
   * are configured and the pool lets them look a user up by subject (ListUsers) and delete one
   * (AdminDeleteUser). Checked by operator readiness in every tenancy mode, never on a timer
   * (platform/tenancy/readiness.ts). Optional: a provider whose identities are not erased by the
   * platform is not checked.
   */
  checkErasureAccess?(): Promise<ErasureAccessReadiness>;

  /**
   * Whether the provider's administrative key can do what server-side sessions ask of it
   * (ADR-057 D7): read a user, end every token of one, turn a second factor off. Checked by
   * operator readiness on demand (platform/tenancy/readiness.ts, "sessions"). Optional: a
   * provider that needs no such key is not checked.
   */
  checkSessionAccess?(): Promise<SessionAccessReadiness>;

  /**
   * Whether the app client's secret the deployment holds is the one the pool has (N-52, decided:
   * operator readiness on demand, read with DescribeUserPoolClient and compared in constant time —
   * never a sign-in against the pool). Optional: a provider without a client secret is not checked.
   */
  checkClientSecret?(): Promise<ClientSecretReadiness>;
}

/**
 * Each `reason` below is the catalog's key and values (TASK-206, N-102): the operator console
 * words it.
 *
 * - `ready`   — the key is set and the pool allowed both the lookup and the delete;
 * - `denied`  — the key is set and the pool refused one of them (`action` names which);
 * - `missing` — no administrative key is configured: no identity is ever erased;
 * - `unknown` — it could not be checked (the pool did not answer).
 */
export type ErasureAccessReadiness =
  | { readonly state: "ready" }
  | { readonly state: "denied"; readonly reason: ShownText; readonly action: string }
  | { readonly state: "missing" | "unknown"; readonly reason: ShownText };

/**
 * As ErasureAccessReadiness, for the session actions: `ready`; `denied` (`action` names the one
 * the key's policy refuses — until it is added, sign-in still works: the session is ended in the
 * platform's records, but the provider is not asked to end the user's other tokens, and a second
 * factor cannot be turned off); `missing` (no key: requests are verified with the user's own
 * token); `unknown`.
 */
export type SessionAccessReadiness = ErasureAccessReadiness;

/**
 * - `ready`         — the secret held matches the app client's (or neither has one);
 * - `mismatch`      — they differ, or one side has a secret and the other none: every sign-in
 *                     that carries a SECRET_HASH would be refused;
 * - `not_checkable` — no administrative key to read the client with;
 * - `unknown`       — it could not be checked (the pool did not answer, or refused the read).
 */
export type ClientSecretReadiness =
  | { readonly state: "ready" }
  | {
      readonly state: "mismatch" | "not_checkable" | "unknown";
      readonly reason: ShownText;
    };

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
  | { readonly state: "missing" | "unsafe" | "unknown"; readonly reason: ShownText };
