/**
 * platform/auth/types.ts — Auth system type definitions
 *
 * These types define the contract for the auth system. They are
 * provider-agnostic — no Cognito, Auth0, or Firebase types leak here.
 *
 * ADR-012: Auth provider interface for cloud-agnostic platform.
 */

/** Unique identifier for a player in the auth system */
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
  /** True if the user needs to complete MFA before access is granted */
  mfaRequired?: boolean;
  /** Session identifier for MFA challenge flow */
  mfaSession?: string;
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
  /** Additional claims from the provider (groups, roles, etc.) */
  [key: string]: unknown;
}

/** Session information for an authenticated user */
export interface AuthSession {
  userId: AuthUserId;
  accessToken: AuthToken;
  refreshToken: AuthToken;
  idToken?: AuthToken;
  expiresAt: number;
}

/** MFA setup result — TOTP secret and QR code URI */
export interface MfaSetupResult {
  success: boolean;
  secretCode?: string;
  qrCodeUri?: string;
  error?: string;
}

/** MFA verification result */
export interface MfaVerifyResult {
  success: boolean;
  session?: AuthSession;
  error?: string;
}

/** Password recovery initiation result */
export interface PasswordRecoveryResult {
  success: boolean;
  /** Delivery destination (masked email) */
  deliveryMedium?: string;
  error?: string;
}

/** Password recovery confirmation result */
export interface PasswordResetResult {
  success: boolean;
  error?: string;
}

/** Guest token result */
export interface GuestTokenResult {
  success: boolean;
  guestId: string;
  token: AuthToken;
  expiresAt: number;
  error?: string;
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
}

/** SSO callback result — same as AuthResult */
export type SsoCallbackResult = AuthResult;

/** Change password result */
export interface ChangePasswordResult {
  success: boolean;
  error?: string;
}

/** Email verification result */
export interface EmailVerificationResult {
  success: boolean;
  error?: string;
}
