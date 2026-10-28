/**
 * platform/auth/types.ts — Auth system type definitions
 *
 * These types define the contract for the auth system. They are
 * provider-agnostic — no Cognito, Auth0, or Firebase types leak here.
 *
 * ADR-012: Auth provider interface for cloud-agnostic platform.
 */

import type { ErrorCode } from "@/platform/errors/registry";

/** Unique identifier for a user in the auth system */
export type AuthUserId = string;

/** JWT token string */
export type AuthToken = string;

/** Result of a sign-up or sign-in operation */
export interface AuthResult {
  success: boolean;
  userId?: AuthUserId;
  accessToken?: AuthToken;
  refreshToken?: AuthToken;
  idToken?: AuthToken;
  expiresIn?: number;
  error?: string;
  /** ADR-051: what a route returns on failure; `error` is for logs. */
  errorCode?: ErrorCode;
  /** True if the user needs to complete MFA before access is granted */
  mfaRequired?: boolean;
  /** Session identifier for MFA challenge flow */
  mfaSession?: string;
  /** True if the user must set a new password before access is granted
   *  (e.g. admin-created accounts issued a temporary password) */
  newPasswordRequired?: boolean;
  /** Session identifier for the NEW_PASSWORD_REQUIRED challenge flow */
  challengeSession?: string;
  /** True if email verification is pending */
  emailVerificationRequired?: boolean;
}

/** Decoded token payload — provider-independent claims */
export interface TokenPayload {
  sub: AuthUserId;
  email: string;
  emailVerified: boolean;
  iat: number;
  exp: number;
  /**
   * The sign-in session this token belongs to, stable across refreshes (e.g. Cognito's
   * `origin_jti`), when the provider has one. Distinguishes two sessions of the same user — the
   * user's own and one an agent was given — so a held action proposed through one session can
   * be required to be decided through another (PF v5.1.0).
   */
  sessionId?: string;
  /**
   * The tenant the identity provider says this user belongs to (Cognito `custom:tenant_id`),
   * when it says one (ADR-053 D2). Read-only to the user; set by the platform's provisioning.
   * Not yet checked — platform/tenancy/resolve.ts decides whether it is acceptable.
   */
  tenantId?: string;
  /**
   * Whether the user signs in with a second factor, when the provider says (audit A-9). Staff
   * without one are refused administrative access while `auth.staff_mfa_required` is on.
   */
  mfaEnabled?: boolean;
  /**
   * The federated identity providers the user signs in with, as the identity provider says
   * (Cognito: the `identities` attribute's provider names, e.g. ["Google"]); [] for a user the
   * pool itself verified (native). Undefined when the provider does not say — then nothing the
   * token says about the address is trusted to mark it verified (review 16 L8,
   * platform/auth/email-verification.ts).
   */
  identityProviders?: readonly string[];
  /**
   * True only when this payload is the identity provider's own answer to this very request (a
   * GetUser call made now) — never for a remembered verification, a stand-in during an outage,
   * or a provider that does not verify through platform/auth/token-verification.ts. Set by the
   * token verifier, never by a provider. The account's address is moved to a *different* one only
   * from such an answer (TASK-185): two devices whose remembered answers differ would otherwise
   * flip it between them for the cache window.
   */
  addressFresh?: boolean;
  /** Additional claims from the provider (groups, roles, etc.) */
  [key: string]: unknown;
}

/** Session information for an authenticated user */
export interface AuthSession {
  userId: AuthUserId;
  accessToken: AuthToken;
  refreshToken: AuthToken;
  idToken?: AuthToken;
  /** Absolute expiry as a UNIX timestamp in epoch seconds (contract unit; see ADR-027). */
  expiresAt: number;
}

/** MFA setup result — TOTP secret and QR code URI */
export interface MfaSetupResult {
  success: boolean;
  secretCode?: string;
  qrCodeUri?: string;
  error?: string;
  /** ADR-051: what a route returns on failure; `error` is for logs. */
  errorCode?: ErrorCode;
}

/** MFA verification result */
export interface MfaVerifyResult {
  success: boolean;
  session?: AuthSession;
  error?: string;
  /** ADR-051: what a route returns on failure; `error` is for logs. */
  errorCode?: ErrorCode;
}

/** Password recovery initiation result */
export interface PasswordRecoveryResult {
  success: boolean;
  /** Delivery destination (masked email) */
  deliveryMedium?: string;
  error?: string;
  /** ADR-051: what a route returns on failure; `error` is for logs. */
  errorCode?: ErrorCode;
}

/** Password recovery confirmation result */
export interface PasswordResetResult {
  success: boolean;
  error?: string;
  /** ADR-051: what a route returns on failure; `error` is for logs. */
  errorCode?: ErrorCode;
}

/** Guest token result */
export interface GuestTokenResult {
  success: boolean;
  guestId: string;
  token: AuthToken;
  /** Absolute expiry as a UNIX timestamp in epoch seconds (contract unit; see ADR-027). */
  expiresAt: number;
  error?: string;
  /** ADR-051: what a route returns on failure; `error` is for logs. */
  errorCode?: ErrorCode;
}

/** Device information for tracking */
export interface DeviceInfo {
  deviceId: string;
  deviceName?: string;
  lastUsedAt: string;
  isTrusted: boolean;
}

/** SSO provider identifiers */
export type SsoProvider = "google" | "apple" | "microsoft";

/** SSO initiation result — redirect URL for the provider */
export interface SsoInitResult {
  success: boolean;
  redirectUrl?: string;
  error?: string;
  /** ADR-051: what a route returns on failure; `error` is for logs. */
  errorCode?: ErrorCode;
}

/**
 * Request protection for the authorization-code flow (TASK-101): `state` (RFC 6749 §10.12,
 * login CSRF) and a PKCE S256 challenge (RFC 7636, code interception). The platform's SSO
 * routes always send both; a provider that receives them must pass them to the identity
 * provider.
 */
export interface SsoInitOptions {
  state?: string;
  codeChallenge?: string;
}

/** The PKCE verifier matching the challenge sent at initiation. */
export interface SsoCallbackOptions {
  codeVerifier?: string;
}

/** SSO callback result — same as AuthResult */
export type SsoCallbackResult = AuthResult;

/** Change password result */
export interface ChangePasswordResult {
  success: boolean;
  error?: string;
  /** ADR-051: what a route returns on failure; `error` is for logs. */
  errorCode?: ErrorCode;
}

/** Email verification result */
export interface EmailVerificationResult {
  success: boolean;
  error?: string;
  /** ADR-051: what a route returns on failure; `error` is for logs. */
  errorCode?: ErrorCode;
}
