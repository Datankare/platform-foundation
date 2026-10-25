/**
 * platform/auth/cognito-provider.ts — AWS Cognito AuthProvider implementation
 *
 * GenAI Principles:
 *   P6 — Resilient: graceful fallback when Cognito unreachable
 *   P9 — Observable: auth operations logged with structured context
 *
 * Implements the full AuthProvider interface using Cognito User Pool
 * API via HTTPS (fetch-based, serverless-compatible). No heavy SDK.
 *
 * Uses USER_PASSWORD_AUTH flow. SRP available in Phase 3 if needed.
 *
 * @module platform/auth
 * @see ADR-012 Auth Architecture
 */

import { createHmac } from "node:crypto";
import type { AuthProvider } from "@/platform/auth/provider";
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
import { logger } from "@/lib/logger";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import {
  getCognitoAdminCredentials,
  getCognitoSettings,
  isTenantId,
} from "@/platform/providers/environment-contract";
import { signAwsJsonPost, type AwsCredentials } from "@/platform/auth/aws-sigv4";
import type { TenantAttributeReadiness } from "@/platform/auth/provider";
import type { ErrorCode } from "@/platform/errors/registry";
import type { JSONWebKeySet } from "jose";
import {
  JwksUnavailableError,
  poolKeyStore,
  staticKeyStore,
  verifyAccessTokenSignature,
  type JwksKeyStore,
} from "@/platform/auth/jwt-verification";
import {
  TokenVerificationUnavailableError,
  TokenVerifier,
  revokeTokenVerification,
  type ProviderOutcome,
  type VerifyOptions,
} from "@/platform/auth/token-verification";

/** ADR-051: Cognito exception types → platform error codes. Anything else is internal. */
const COGNITO_ERROR_CODES: Readonly<Record<string, ErrorCode>> = {
  UserNotFoundException: "auth.invalid_credentials",
  NotAuthorizedException: "auth.invalid_credentials",
  UsernameExistsException: "auth.account_exists",
  AliasExistsException: "auth.account_exists",
  UserNotConfirmedException: "auth.email_not_verified",
  InvalidPasswordException: "auth.password_policy",
  CodeMismatchException: "auth.code_invalid",
  EnableSoftwareTokenMFAException: "auth.code_invalid",
  ExpiredCodeException: "auth.code_expired",
  LimitExceededException: "auth.too_many_attempts",
  TooManyRequestsException: "auth.too_many_attempts",
  TooManyFailedAttemptsException: "auth.too_many_attempts",
  InvalidParameterException: "request.invalid_body",
};
import {
  mintGuestToken,
  verifyGuestToken as verifyPlatformGuestToken,
} from "@/platform/auth/guest-token";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface CognitoConfig {
  region: string;
  userPoolId: string;
  clientId: string;
  /** Administrative credentials (ADR-053 D2), for assigning tenants; undefined when not set. */
  adminCredentials?: AwsCredentials;
  /** Hosted sign-in host name (NEXT_PUBLIC_COGNITO_HOSTED_UI_DOMAIN); required for SSO. */
  hostedUiDomain?: string;
  /**
   * The app client's secret (COGNITO_CLIENT_SECRET, audit A-7). With it the client is
   * confidential: every unauthenticated pool call carries a SECRET_HASH only the server can
   * compute, so nobody can sign up, sign in or reset a password around the platform's routes.
   */
  clientSecret?: string;
  timeoutMs?: number;
  /**
   * The pool's signing keys, fixed (tests; a deployment that pins them). Unset: fetched from the
   * pool's JWKS address and kept (platform/auth/jwt-verification.ts, review 8 M5).
   */
  jwks?: JSONWebKeySet;
}

export function getCognitoConfigFromEnv(): CognitoConfig {
  // ADR-050 D2: the contract resolver is the one reader (no AWS_REGION — that is the host's
  // function region, not the pool's).
  const { region, userPoolId, clientId, hostedUiDomain, clientSecret } =
    getCognitoSettings();
  const adminCredentials = getCognitoAdminCredentials();

  if (!userPoolId || !clientId) {
    logger.warn("Cognito config incomplete", {
      hasUserPoolId: !!userPoolId,
      hasClientId: !!clientId,
    });
  }

  return {
    region,
    userPoolId,
    clientId,
    hostedUiDomain,
    ...(clientSecret ? { clientSecret } : {}),
    ...(adminCredentials ? { adminCredentials } : {}),
  };
}

/**
 * Cognito's SECRET_HASH for `username`: Base64(HMAC-SHA256(secret, username + clientId)), or
 * nothing for a public client (no secret configured).
 */
export function secretHash(config: CognitoConfig, username: string): string | undefined {
  if (!config.clientSecret) return undefined;
  return createHmac("sha256", config.clientSecret)
    .update(username + config.clientId)
    .digest("base64");
}

/** `{ SecretHash }` for the user-pool calls that take it, or nothing for a public client. */
function withSecretHash(
  config: CognitoConfig,
  username: string
): { SecretHash?: string } {
  const hash = secretHash(config, username);
  return hash ? { SecretHash: hash } : {};
}

/** `{ SECRET_HASH }` for AuthParameters and ChallengeResponses, or nothing. */
function withSecretParam(
  config: CognitoConfig,
  username: string
): { SECRET_HASH?: string } {
  const hash = secretHash(config, username);
  return hash ? { SECRET_HASH: hash } : {};
}

/** Why a token GetUser accepted is still not ours (audit A-3), or null when it is. */
export function foreignTokenReason(
  config: CognitoConfig,
  claims: Record<string, unknown> | null,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): string | null {
  if (!claims) return "undecodable";
  // GetUser accepts an access token from any app client of the pool, and a pool shared by two
  // environments would let one environment's token in to the other.
  if (claims.token_use !== "access") return "not an access token";
  if (claims.client_id !== config.clientId) return "issued to another app client";
  const issuer = `https://cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}`;
  if (claims.iss !== issuer) return "issued by another pool";
  if (typeof claims.exp !== "number" || claims.exp <= nowSeconds) return "expired";
  return null;
}

// ---------------------------------------------------------------------------
// Cognito API helpers
// ---------------------------------------------------------------------------

interface CognitoApiError {
  __type: string;
  message: string;
}

export class CognitoError extends Error {
  constructor(
    message: string,
    public readonly cognitoType: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = "CognitoError";
  }
}

/**
 * Whether a Cognito failure is Cognito's — throttled (the GetUser quota), down, unreachable —
 * not the token's. Such a failure is never read as "invalid token" (a signed-out user): the
 * caller fails closed with 503, or an ordinary route stands on a recent verification.
 */
export function cognitoUnavailable(error: unknown): boolean {
  if (!(error instanceof CognitoError)) return true;
  return (
    error.cognitoType === "TooManyRequestsException" ||
    error.cognitoType === "LimitExceededException" ||
    error.cognitoType === "InternalErrorException" ||
    error.cognitoType === "ServiceUnavailableException" ||
    error.cognitoType === "TimeoutError" ||
    error.cognitoType === "NetworkError" ||
    error.statusCode === 429 ||
    error.statusCode >= 500
  );
}

async function callCognito(
  config: CognitoConfig,
  action: string,
  payload: Record<string, unknown>,
  /** Signs the call (SigV4) — for the administrative actions only. */
  credentials?: AwsCredentials
): Promise<Record<string, unknown>> {
  const host = `cognito-idp.${config.region}.amazonaws.com`;
  const endpoint = `https://${host}/`;
  const requestBody = JSON.stringify(payload);
  const baseHeaders = {
    "Content-Type": "application/x-amz-json-1.1",
    "X-Amz-Target": `AWSCognitoIdentityProviderService.${action}`,
  };
  const headers = credentials
    ? await signAwsJsonPost({
        service: "cognito-idp",
        region: config.region,
        host,
        headers: baseHeaders,
        body: requestBody,
        credentials,
      })
    : baseHeaders;
  const timeout = config.timeoutMs ?? 10000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetchWithTimeout(endpoint, {
      timeoutMs: 10_000,
      // Retry is the caller's: reduceCommit loops on version conflict and the effect
      // ledger owns at-most-once. A transport retrying a PATCH underneath either can
      // double-apply a committed write (ADR-028 D5, ADR-031 D7).
      maxRetries: 0,
      method: "POST",
      headers,
      body: requestBody,
      signal: controller.signal,
    });

    const body = await response.json();

    if (!response.ok) {
      const err = body as CognitoApiError;
      throw new CognitoError(
        err.message ?? `Cognito ${action} failed`,
        err.__type ?? "UnknownError",
        response.status
      );
    }

    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof CognitoError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new CognitoError(`Cognito timed out after ${timeout}ms`, "TimeoutError", 0);
    }
    throw new CognitoError(
      error instanceof Error ? error.message : "Unknown Cognito error",
      "NetworkError",
      0
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Base64url decode — browser + Node compatible (no Buffer dependency) */
function b64urlDecode(str: string): string {
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  if (typeof atob === "function") {
    return atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  }
  // Node.js fallback — Buffer available server-side, not in browser
  return Buffer.from(str, "base64url").toString("utf-8");
}

let warnedWithoutSession = false;

/**
 * Cognito carries origin_jti only when token revocation is enabled on the app client (the default
 * for clients created since 2021). Without it there is no sign-in session, and no held action can
 * be approved (heldActionRefusal refuses when independence cannot be shown) — said once, loudly.
 */
function warnOnceWithoutSession(decoded: Record<string, unknown> | null): void {
  if (warnedWithoutSession || !decoded) return;
  if (typeof decoded.origin_jti === "string" && decoded.origin_jti) return;
  warnedWithoutSession = true;
  logger.warn(
    "Cognito access tokens carry no origin_jti: enable token revocation on the app client, or no held action can be approved",
    { route: "platform/auth/cognito-provider" }
  );
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(b64urlDecode(parts[1]));
  } catch {
    return null;
  }
}

/** The Cognito attribute holding a user's tenant (ADR-053 D2). Read-only for every app client. */
export const TENANT_ATTRIBUTE = "custom:tenant_id";

function tenantAttribute(attrs: Array<{ Name: string; Value: string }> | undefined): {
  tenantId?: string;
} {
  const value = attrs?.find((a) => a.Name === TENANT_ATTRIBUTE)?.Value;
  // Passed on as given, even malformed: the resolver refuses it, rather than this treating a
  // corrupt attribute as "no tenant" (which single mode would accept).
  return typeof value === "string" && value.length > 0 ? { tenantId: value } : {};
}

// ---------------------------------------------------------------------------
// CognitoAuthProvider
// ---------------------------------------------------------------------------

export class CognitoAuthProvider implements AuthProvider {
  private readonly config: CognitoConfig;
  /** This instance's verifier: the shared cache, and its own in-flight GetUser calls. */
  private readonly tokens: TokenVerifier;
  /** The pool's signing keys: every token's signature is checked before GetUser (M5). */
  private readonly keys: JwksKeyStore;

  constructor(config: CognitoConfig, tokens: TokenVerifier = new TokenVerifier()) {
    this.config = config;
    this.tokens = tokens;
    this.keys = config.jwks
      ? staticKeyStore(config.jwks)
      : poolKeyStore(config.region, config.userPoolId);
  }

  // ── Sign Up / Sign In ──

  async signUp(email: string, password: string): Promise<AuthResult> {
    try {
      const result = await callCognito(this.config, "SignUp", {
        ClientId: this.config.clientId,
        ...withSecretHash(this.config, email),
        Username: email,
        Password: password,
        UserAttributes: [{ Name: "email", Value: email }],
      });

      logger.info("User signed up", { confirmed: result.UserConfirmed });

      return {
        success: true,
        userId: result.UserSub as string,
        emailVerificationRequired: !(result.UserConfirmed as boolean),
      };
    } catch (error) {
      return this.handleAuthError(error, "signUp");
    }
  }

  async signIn(email: string, password: string): Promise<AuthResult> {
    try {
      const result = await callCognito(this.config, "InitiateAuth", {
        ClientId: this.config.clientId,
        AuthFlow: "USER_PASSWORD_AUTH",
        AuthParameters: {
          USERNAME: email,
          PASSWORD: password,
          ...withSecretParam(this.config, email),
        },
      });

      if (result.ChallengeName === "SOFTWARE_TOKEN_MFA") {
        return {
          success: false,
          mfaRequired: true,
          mfaSession: result.Session as string,
        };
      }

      if (result.ChallengeName === "NEW_PASSWORD_REQUIRED") {
        return {
          success: false,
          newPasswordRequired: true,
          challengeSession: result.Session as string,
        };
      }

      const auth = result.AuthenticationResult as Record<string, unknown>;
      if (!auth) {
        return {
          success: false,
          error: "No authentication result",
          errorCode: "auth.challenge_failed",
        };
      }

      const decoded = decodeJwtPayload(auth.AccessToken as string);

      logger.info("User signed in", { route: "platform/auth/cognito-provider" });

      return {
        success: true,
        userId: decoded?.sub as string,
        accessToken: auth.AccessToken as string,
        refreshToken: auth.RefreshToken as string,
        idToken: auth.IdToken as string,
        expiresIn: auth.ExpiresIn as number,
      };
    } catch (error) {
      return this.handleAuthError(error, "signIn");
    }
  }

  /**
   * Revoke the session (audit X-17): GlobalSignOut ends every token of the user's sign-ins, and
   * the refresh token, when the caller has it, is revoked itself (RevokeToken) so it can never
   * mint another access token. Either failing is thrown: a sign-out that did not revoke must
   * not be reported as one.
   */
  async signOut(accessToken: AuthToken, refreshToken?: AuthToken): Promise<void> {
    let revoked = false;
    if (refreshToken) {
      await callCognito(this.config, "RevokeToken", {
        ClientId: this.config.clientId,
        Token: refreshToken,
        ...(this.config.clientSecret ? { ClientSecret: this.config.clientSecret } : {}),
      });
      revoked = true;
    }
    if (accessToken) {
      try {
        await callCognito(this.config, "GlobalSignOut", { AccessToken: accessToken });
      } catch (error) {
        // An access token that has already expired cannot sign out; with its refresh token
        // revoked there is nothing left that can mint another.
        const expired =
          error instanceof CognitoError && error.cognitoType === "NotAuthorizedException";
        if (!(expired && revoked)) throw error;
      }
    }
    logger.info("User signed out");
  }

  // ── Token Management ──

  /**
   * Verify an access token (GetUser), remembered briefly in the shared cache and revocable at
   * once (platform/auth/token-verification.ts). Refused locally, before any call, when it is not
   * this app's or has expired. Throws TokenVerificationUnavailableError when Cognito cannot
   * answer (throttled, down) and no remembered verification may stand in — a privileged route
   * never uses one.
   */
  async verifyToken(
    accessToken: AuthToken,
    options: VerifyOptions = {}
  ): Promise<TokenPayload | null> {
    const decoded = decodeJwtPayload(accessToken);
    // These prove it is this app's (audit A-3); checked first, so a foreign, expired or
    // undecodable token costs no call against the GetUser quota.
    const foreign = foreignTokenReason(this.config, decoded);
    if (foreign || !decoded) {
      logger.warn("Access token refused", {
        reason: foreign ?? "undecodable",
        route: "platform/auth/cognito-provider",
      });
      return null;
    }
    // Review 8 M5: the claims alone are anyone's to write. The signature is checked against the
    // pool's keys here, so a forged token never reaches GetUser (whose quota a flood of them
    // would drain into an outage).
    // When the signing keys cannot be had, the token is neither good nor bad yet: it goes to the
    // token verifier as the identity provider not answering (review 9 M4) — a fresh remembered
    // verification of this very token (keyed by its hash: GetUser verified it) is honoured, an
    // ordinary route may use the stale grace, a privileged one fails closed. GetUser is not
    // asked: an unverified signature never costs a call against its quota.
    let signed;
    let keysUnavailable: string | undefined;
    try {
      signed = await verifyAccessTokenSignature(accessToken, {
        issuer: `https://cognito-idp.${this.config.region}.amazonaws.com/${this.config.userPoolId}`,
        clientId: this.config.clientId,
        keys: this.keys,
      });
    } catch (error) {
      if (!(error instanceof JwksUnavailableError)) throw error;
      keysUnavailable = error.reason;
    }
    const subject =
      typeof decoded.username === "string" && decoded.username
        ? decoded.username
        : typeof decoded.sub === "string"
          ? decoded.sub
          : "";
    if (keysUnavailable !== undefined) {
      if (!subject) throw new TokenVerificationUnavailableError(keysUnavailable);
      const reason = keysUnavailable;
      return this.tokens.verify(
        accessToken,
        { exp: decoded.exp as number, subject },
        async () => ({ kind: "unavailable", reason }),
        options
      );
    }
    if (!signed || !signed.ok) {
      logger.warn("Access token refused", {
        reason: signed?.reason ?? "unverified",
        route: "platform/auth/cognito-provider",
      });
      return null;
    }
    if (!subject) return null;
    return this.tokens.verify(
      accessToken,
      { exp: decoded.exp as number, subject },
      () => this.askGetUser(accessToken, decoded),
      options
    );
  }

  /** GetUser, as an outcome: valid, invalid (the token), or unavailable (Cognito). */
  private async askGetUser(
    accessToken: AuthToken,
    decoded: Record<string, unknown>
  ): Promise<ProviderOutcome> {
    let result: Record<string, unknown>;
    try {
      result = await callCognito(this.config, "GetUser", { AccessToken: accessToken });
    } catch (error) {
      return cognitoUnavailable(error)
        ? { kind: "unavailable", reason: (error as CognitoError).cognitoType }
        : { kind: "invalid" };
    }
    const attrs = result.UserAttributes as Array<{ Name: string; Value: string }>;
    warnOnceWithoutSession(decoded);
    const mfa = (result.UserMFASettingList as unknown[] | undefined) ?? [];
    return {
      kind: "valid",
      payload: {
        // Audit A-9: whether the user signs in with a second factor (staff must, by default).
        mfaEnabled: mfa.includes("SOFTWARE_TOKEN_MFA"),
        sub: result.Username as string,
        email: attrs?.find((a) => a.Name === "email")?.Value ?? "",
        emailVerified: attrs?.find((a) => a.Name === "email_verified")?.Value === "true",
        iat: (decoded.iat as number) ?? 0,
        exp: (decoded.exp as number) ?? 0,
        // origin_jti: the sign-in this token descends from, kept across refreshes (PF v5.1.0).
        ...(typeof decoded.origin_jti === "string" && decoded.origin_jti
          ? { sessionId: decoded.origin_jti }
          : {}),
        // ADR-053 D2: read in the same GetUser call that verifies the token, so it is current.
        ...tenantAttribute(attrs),
      },
    };
  }

  async refreshToken(
    refreshToken: AuthToken,
    username?: string
  ): Promise<AuthSession | null> {
    try {
      // A confidential client's refresh is hashed with the user's id (the token's subject).
      if (this.config.clientSecret && !username) return null;
      const result = await callCognito(this.config, "InitiateAuth", {
        ClientId: this.config.clientId,
        AuthFlow: "REFRESH_TOKEN_AUTH",
        AuthParameters: {
          REFRESH_TOKEN: refreshToken,
          ...(username ? withSecretParam(this.config, username) : {}),
        },
      });

      const auth = result.AuthenticationResult as Record<string, unknown>;
      if (!auth) return null;

      const decoded = decodeJwtPayload(auth.AccessToken as string);
      const expiresIn = (auth.ExpiresIn as number) ?? 3600;
      // The refreshed session is the same user's, or it is not used.
      if (username && decoded?.sub !== username) return null;

      return {
        userId: (decoded?.sub as string) ?? "",
        accessToken: auth.AccessToken as string,
        refreshToken: refreshToken,
        idToken: auth.IdToken as string,
        expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
      };
    } catch {
      return null;
    }
  }

  // ── Password Management ──

  async forgotPassword(email: string): Promise<PasswordRecoveryResult> {
    try {
      await callCognito(this.config, "ForgotPassword", {
        ClientId: this.config.clientId,
        ...withSecretHash(this.config, email),
        Username: email,
      });
      return { success: true, deliveryMedium: "email" };
    } catch (error) {
      return this.codedFailure(error, "Failed to send reset code");
    }
  }

  async confirmForgotPassword(
    email: string,
    code: string,
    newPassword: string
  ): Promise<PasswordResetResult> {
    try {
      await callCognito(this.config, "ConfirmForgotPassword", {
        ClientId: this.config.clientId,
        ...withSecretHash(this.config, email),
        Username: email,
        ConfirmationCode: code,
        Password: newPassword,
      });
      return { success: true };
    } catch (error) {
      return this.codedFailure(error, "Password reset failed");
    }
  }

  async changePassword(
    accessToken: AuthToken,
    oldPassword: string,
    newPassword: string
  ): Promise<ChangePasswordResult> {
    try {
      await callCognito(this.config, "ChangePassword", {
        AccessToken: accessToken,
        PreviousPassword: oldPassword,
        ProposedPassword: newPassword,
      });
      return { success: true };
    } catch (error) {
      return this.codedFailure(error, "Password change failed");
    }
  }

  // ── Email Verification ──

  async confirmEmailVerification(
    email: string,
    code: string
  ): Promise<EmailVerificationResult> {
    try {
      await callCognito(this.config, "ConfirmSignUp", {
        ClientId: this.config.clientId,
        ...withSecretHash(this.config, email),
        Username: email,
        ConfirmationCode: code,
      });
      await this.revokeVerificationsOf(email);
      return { success: true };
    } catch (error) {
      return this.codedFailure(error, "Verification failed");
    }
  }

  async resendEmailVerification(email: string): Promise<EmailVerificationResult> {
    try {
      await callCognito(this.config, "ResendConfirmationCode", {
        ClientId: this.config.clientId,
        ...withSecretHash(this.config, email),
        Username: email,
      });
      return { success: true };
    } catch (error) {
      return this.codedFailure(error, "Failed to resend code");
    }
  }

  // ── MFA ──

  async setupMfa(accessToken: AuthToken): Promise<MfaSetupResult> {
    try {
      const result = await callCognito(this.config, "AssociateSoftwareToken", {
        AccessToken: accessToken,
      });
      const secret = result.SecretCode as string;
      return {
        success: true,
        secretCode: secret,
        qrCodeUri: `otpauth://totp/PlatformFoundation?secret=${secret}&issuer=PlatformFoundation`,
      };
    } catch (error) {
      return this.codedFailure(error, "MFA setup failed");
    }
  }

  async verifyMfaSetup(
    accessToken: AuthToken,
    totpCode: string
  ): Promise<MfaVerifyResult> {
    try {
      await callCognito(this.config, "VerifySoftwareToken", {
        AccessToken: accessToken,
        UserCode: totpCode,
      });
      await callCognito(this.config, "SetUserMFAPreference", {
        AccessToken: accessToken,
        SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true },
      });
      return { success: true };
    } catch (error) {
      return this.codedFailure(error, "MFA verification failed");
    }
  }

  async respondToMfaChallenge(
    mfaSession: string,
    totpCode: string,
    username: string
  ): Promise<AuthResult> {
    try {
      // Cognito answers the challenge only for the user it was issued to: a placeholder
      // username failed every MFA sign-in and counted towards the account's lockout (A-9).
      const result = await callCognito(this.config, "RespondToAuthChallenge", {
        ClientId: this.config.clientId,
        ChallengeName: "SOFTWARE_TOKEN_MFA",
        Session: mfaSession,
        ChallengeResponses: {
          USERNAME: username,
          SOFTWARE_TOKEN_MFA_CODE: totpCode,
          ...withSecretParam(this.config, username),
        },
      });

      const auth = result.AuthenticationResult as Record<string, unknown>;
      if (!auth) {
        return {
          success: false,
          error: "MFA challenge failed",
          errorCode: "auth.challenge_failed",
        };
      }

      const decoded = decodeJwtPayload(auth.AccessToken as string);

      return {
        success: true,
        userId: decoded?.sub as string,
        accessToken: auth.AccessToken as string,
        refreshToken: auth.RefreshToken as string,
        idToken: auth.IdToken as string,
        expiresIn: auth.ExpiresIn as number,
      };
    } catch (error) {
      return this.handleAuthError(error, "respondToMfaChallenge");
    }
  }

  async respondToNewPasswordChallenge(
    challengeSession: string,
    newPassword: string,
    username: string
  ): Promise<AuthResult> {
    try {
      const result = await callCognito(this.config, "RespondToAuthChallenge", {
        ClientId: this.config.clientId,
        ChallengeName: "NEW_PASSWORD_REQUIRED",
        Session: challengeSession,
        ChallengeResponses: {
          USERNAME: username,
          NEW_PASSWORD: newPassword,
          ...withSecretParam(this.config, username),
        },
      });

      const auth = result.AuthenticationResult as Record<string, unknown>;
      if (!auth) {
        return {
          success: false,
          error: "Password change failed",
          errorCode: "auth.challenge_failed",
        };
      }

      const decoded = decodeJwtPayload(auth.AccessToken as string);

      return {
        success: true,
        userId: decoded?.sub as string,
        accessToken: auth.AccessToken as string,
        refreshToken: auth.RefreshToken as string,
        idToken: auth.IdToken as string,
        expiresIn: auth.ExpiresIn as number,
      };
    } catch (error) {
      return this.handleAuthError(error, "respondToNewPasswordChallenge");
    }
  }

  async disableMfa(
    accessToken: AuthToken
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await callCognito(this.config, "SetUserMFAPreference", {
        AccessToken: accessToken,
        SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false },
      });
      return { success: true };
    } catch (error) {
      return this.codedFailure(error, "Failed to disable MFA");
    }
  }

  // ── SSO ──

  // TASK-101: the hosted sign-in domain is a declared setting (ADR-050 D2). It used to be
  // derived from the pool id, which is not the domain Cognito assigns.
  async initiateSso(
    provider: SsoProvider,
    redirectUri: string,
    options: SsoInitOptions = {}
  ): Promise<SsoInitResult> {
    const domain = this.config.hostedUiDomain;
    if (!domain) {
      return {
        success: false,
        error: "SSO not configured: NEXT_PUBLIC_COGNITO_HOSTED_UI_DOMAIN is not set",
        errorCode: "feature.not_configured",
      };
    }
    const identityProvider =
      provider === "google"
        ? "Google"
        : provider === "apple"
          ? "SignInWithApple"
          : "Microsoft";

    const url = new URL(`https://${domain}/oauth2/authorize`);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("response_type", "code");
    // aws.cognito.signin.user.admin: without it the token cannot call GetUser, which is how
    // every request verifies it, so every SSO user was refused after signing in (audit A-13).
    url.searchParams.set("scope", "openid email profile aws.cognito.signin.user.admin");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("identity_provider", identityProvider);
    if (options.state) url.searchParams.set("state", options.state);
    if (options.codeChallenge) {
      url.searchParams.set("code_challenge", options.codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
    }

    return { success: true, redirectUrl: url.toString() };
  }

  async handleSsoCallback(
    _provider: SsoProvider,
    code: string,
    redirectUri: string,
    options: SsoCallbackOptions = {}
  ): Promise<SsoCallbackResult> {
    const domain = this.config.hostedUiDomain;
    if (!domain) {
      return {
        success: false,
        error: "SSO not configured: NEXT_PUBLIC_COGNITO_HOSTED_UI_DOMAIN is not set",
        errorCode: "feature.not_configured",
      };
    }

    const form: Record<string, string> = {
      grant_type: "authorization_code",
      client_id: this.config.clientId,
      code,
      redirect_uri: redirectUri,
    };
    if (options.codeVerifier) form.code_verifier = options.codeVerifier;

    try {
      const response = await fetchWithTimeout(`https://${domain}/oauth2/token`, {
        timeoutMs: 10_000,
        // An authorization code is single-use: a transport retry after a lost response would
        // be refused and mask the first outcome.
        maxRetries: 0,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          // A confidential client authenticates at the token endpoint (audit A-7).
          ...(this.config.clientSecret
            ? {
                Authorization: `Basic ${Buffer.from(
                  `${this.config.clientId}:${this.config.clientSecret}`
                ).toString("base64")}`,
              }
            : {}),
        },
        body: new URLSearchParams(form),
      });

      if (!response.ok) {
        return {
          success: false,
          error: `SSO token exchange failed: ${response.status}`,
          errorCode: "auth.sso_failed",
        };
      }

      const tokens = (await response.json()) as Record<string, unknown>;
      if (typeof tokens.access_token !== "string") {
        return {
          success: false,
          error: "SSO token exchange returned no access token",
          errorCode: "auth.sso_failed",
        };
      }
      const decoded = decodeJwtPayload(tokens.access_token);

      return {
        success: true,
        userId: decoded?.sub as string,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token as string,
        idToken: tokens.id_token as string,
        expiresIn: tokens.expires_in as number,
      };
    } catch (error) {
      return this.codedFailure(error, "SSO callback failed");
    }
  }

  // ── Guest Mode ──

  // ADR-050 D4 (TASK-098): guest tokens are platform-owned and HMAC-signed — the provider
  // delegates to platform/auth/guest-token rather than minting its own (unsigned) format.
  async createGuestToken(): Promise<GuestTokenResult> {
    const { guestId, token, expiresAt } = await mintGuestToken();
    return { success: true, guestId, token, expiresAt };
  }

  async verifyGuestToken(
    token: AuthToken
  ): Promise<{ valid: boolean; guestId?: string }> {
    const result = await verifyPlatformGuestToken(token);
    return result.valid ? { valid: true, guestId: result.guestId } : { valid: false };
  }

  // ── Device Management ──

  async listDevices(accessToken: AuthToken): Promise<DeviceInfo[]> {
    try {
      const result = await callCognito(this.config, "ListDevices", {
        AccessToken: accessToken,
        Limit: 20,
      });
      const devices = result.Devices as Array<Record<string, unknown>>;
      return (devices ?? []).map((d) => ({
        deviceId: d.DeviceKey as string,
        deviceName: (d.DeviceAttributes as Array<{ Name: string; Value: string }>)?.find(
          (a) => a.Name === "device_name"
        )?.Value,
        lastUsedAt: (d.DeviceLastAuthenticatedDate as string) ?? "",
        isTrusted: false,
      }));
    } catch {
      return [];
    }
  }

  async forgetDevice(
    accessToken: AuthToken,
    deviceId: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await callCognito(this.config, "ForgetDevice", {
        AccessToken: accessToken,
        DeviceKey: deviceId,
      });
      return { success: true };
    } catch (error) {
      return this.codedFailure(error, "Failed to forget device");
    }
  }

  // ── User Info ──

  async getUserInfo(
    accessToken: AuthToken
  ): Promise<{ userId: AuthUserId; email: string; emailVerified: boolean } | null> {
    try {
      const result = await callCognito(this.config, "GetUser", {
        AccessToken: accessToken,
      });
      const attrs = result.UserAttributes as Array<{ Name: string; Value: string }>;
      return {
        userId: result.Username as string,
        email: attrs?.find((a) => a.Name === "email")?.Value ?? "",
        emailVerified: attrs?.find((a) => a.Name === "email_verified")?.Value === "true",
      };
    } catch {
      return null;
    }
  }

  // ── Tenancy (ADR-053 D2) ──

  private requireAdmin(): AwsCredentials {
    if (!this.config.adminCredentials) {
      throw new CognitoError(
        "Cognito administrative credentials are not configured (COGNITO_ADMIN_ACCESS_KEY_ID)",
        "ConfigurationError",
        0
      );
    }
    return this.config.adminCredentials;
  }

  /**
   * After an attribute of the user changed (the address verified): every remembered
   * verification of their tokens is voided, so the next request reads the attribute (review 8
   * M1). Cognito issues no token to an unconfirmed account, so nothing can be remembered before
   * a first verification; a verified address changing later is voided the same way. The token's
   * subject is the pool's username for the address (AdminGetUser); without administrative
   * credentials it cannot be looked up, and the fresh window (≤ 60 s) bounds it.
   */
  private async revokeVerificationsOf(username: string): Promise<void> {
    if (!this.config.adminCredentials) return;
    try {
      const user = await callCognito(
        this.config,
        "AdminGetUser",
        { UserPoolId: this.config.userPoolId, Username: username },
        this.config.adminCredentials
      );
      if (typeof user.Username === "string" && user.Username)
        await revokeTokenVerification(user.Username);
    } catch (error) {
      logger.warn("Remembered token verifications not voided after an attribute change", {
        route: "platform/auth/cognito-provider",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Set the user's tenant — the one administrative write the platform makes. Idempotent. The
   * caller (sign-up in shared mode, or an operator moving a user) decides whether it may.
   */
  async assignTenant(
    userId: AuthUserId,
    tenantId: string
  ): Promise<{ success: boolean; error?: string; errorCode?: ErrorCode }> {
    if (!isTenantId(tenantId)) {
      return {
        success: false,
        error: "Malformed tenant id",
        errorCode: "request.invalid_body",
      };
    }
    try {
      await callCognito(
        this.config,
        "AdminUpdateUserAttributes",
        {
          UserPoolId: this.config.userPoolId,
          Username: userId,
          UserAttributes: [{ Name: TENANT_ATTRIBUTE, Value: tenantId }],
        },
        this.requireAdmin()
      );
      logger.info("User tenant assigned", { userId, tenantId });
      return { success: true };
    } catch (error) {
      return this.codedFailure(error, "assignTenant");
    }
  }

  /** The user's tenant as Cognito holds it, null when none; undefined when it cannot be read. */
  async getUserTenant(userId: AuthUserId): Promise<string | null | undefined> {
    try {
      const result = await callCognito(
        this.config,
        "AdminGetUser",
        { UserPoolId: this.config.userPoolId, Username: userId },
        this.requireAdmin()
      );
      const attrs = result.UserAttributes as
        Array<{ Name: string; Value: string }> | undefined;
      return attrs?.find((a) => a.Name === TENANT_ATTRIBUTE)?.Value ?? null;
    } catch (error) {
      logger.warn("Could not read the user's tenant", {
        userId,
        cognitoType: error instanceof CognitoError ? error.cognitoType : "Unknown",
      });
      return undefined;
    }
  }

  /**
   * Whether the pool can hold tenants safely: the attribute exists, the app client can read it,
   * and — the property isolation rests on — no app client of the pool can write it, and no
   * federated sign-in maps a claim into it (else a user could move themselves with
   * UpdateUserAttributes, or a provider's claim would choose the tenant).
   */
  async checkTenantAttribute(): Promise<TenantAttributeReadiness> {
    let credentials: AwsCredentials;
    try {
      credentials = this.requireAdmin();
    } catch {
      return {
        state: "unknown",
        reason: "administrative credentials are not configured",
      };
    }
    try {
      const pool = await callCognito(
        this.config,
        "DescribeUserPool",
        { UserPoolId: this.config.userPoolId },
        credentials
      );
      const schema = ((pool.UserPool as Record<string, unknown> | undefined)
        ?.SchemaAttributes ?? []) as Array<{
        Name?: string;
        Mutable?: boolean;
        AttributeDataType?: string;
      }>;
      const attr = schema.find((a) => a.Name === TENANT_ATTRIBUTE);
      if (!attr) {
        return {
          state: "missing",
          reason: `the pool has no ${TENANT_ATTRIBUTE} attribute`,
        };
      }
      if (attr.AttributeDataType && attr.AttributeDataType !== "String") {
        return {
          state: "unsafe",
          reason: `${TENANT_ATTRIBUTE} is not a String attribute`,
        };
      }
      if (attr.Mutable === false) {
        return {
          state: "unsafe",
          reason: `${TENANT_ATTRIBUTE} is immutable — the platform could never assign it after sign-up`,
        };
      }
      // Every app client of the pool, not only this one: a user can obtain a token from any
      // client of the pool, and one that may write the attribute lets them choose their tenant.
      const clientIds: string[] = [];
      let nextToken: string | undefined;
      do {
        const page = await callCognito(
          this.config,
          "ListUserPoolClients",
          {
            UserPoolId: this.config.userPoolId,
            MaxResults: 60,
            ...(nextToken ? { NextToken: nextToken } : {}),
          },
          credentials
        );
        for (const c of (page.UserPoolClients ?? []) as Array<{ ClientId?: string }>) {
          if (c.ClientId) clientIds.push(c.ClientId);
        }
        nextToken = typeof page.NextToken === "string" ? page.NextToken : undefined;
      } while (nextToken);
      if (!clientIds.includes(this.config.clientId)) clientIds.push(this.config.clientId);

      const providers = new Set<string>();
      for (const clientId of clientIds) {
        const client = await callCognito(
          this.config,
          "DescribeUserPoolClient",
          { UserPoolId: this.config.userPoolId, ClientId: clientId },
          credentials
        );
        const c = (client.UserPoolClient ?? {}) as {
          ReadAttributes?: string[];
          WriteAttributes?: string[];
          SupportedIdentityProviders?: string[];
        };
        const which =
          clientId === this.config.clientId ? "the app client" : `app client ${clientId}`;
        // An absent WriteAttributes list means "every writable attribute" — custom ones included.
        if (!c.WriteAttributes || c.WriteAttributes.includes(TENANT_ATTRIBUTE)) {
          return {
            state: "unsafe",
            reason: `${which} can write ${TENANT_ATTRIBUTE}; remove it from the client's writable attributes`,
          };
        }
        if (
          clientId === this.config.clientId &&
          c.ReadAttributes &&
          !c.ReadAttributes.includes(TENANT_ATTRIBUTE)
        ) {
          return {
            state: "unsafe",
            reason: `the app client cannot read ${TENANT_ATTRIBUTE}; add it to the client's readable attributes`,
          };
        }
        for (const name of c.SupportedIdentityProviders ?? []) {
          if (name !== "COGNITO") providers.add(name);
        }
      }
      // A federated sign-in (Google, Apple, …) writes mapped attributes at every sign-in; one
      // mapping into the tenant attribute would let that provider's claims choose the tenant.
      for (const name of providers) {
        const idp = await callCognito(
          this.config,
          "DescribeIdentityProvider",
          { UserPoolId: this.config.userPoolId, ProviderName: name },
          credentials
        );
        const mapping = ((idp.IdentityProvider as Record<string, unknown> | undefined)
          ?.AttributeMapping ?? {}) as Record<string, string>;
        if (Object.prototype.hasOwnProperty.call(mapping, TENANT_ATTRIBUTE)) {
          return {
            state: "unsafe",
            reason: `the ${name} sign-in maps a claim into ${TENANT_ATTRIBUTE}; remove that attribute mapping`,
          };
        }
      }
      return { state: "ready" };
    } catch (error) {
      return {
        state: "unknown",
        reason: `the pool could not be described (${error instanceof CognitoError ? error.cognitoType : "error"})`,
      };
    }
  }

  async deleteUser(
    accessToken: AuthToken
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await callCognito(this.config, "DeleteUser", { AccessToken: accessToken });
      logger.info("User account deleted from Cognito");
      return { success: true };
    } catch (error) {
      return this.codedFailure(error, "Account deletion failed");
    }
  }

  // ── Error Handling ──

  /**
   * ADR-051: a failed Cognito call as a coded result. The Cognito message stays in `error` for
   * logs; routes answer with `errorCode`, so no Cognito text reaches a client.
   */
  private codedFailure(
    error: unknown,
    operation: string
  ): { success: false; error: string; errorCode: ErrorCode } {
    if (error instanceof CognitoError) {
      logger.warn(`Auth ${operation} failed`, {
        cognitoType: error.cognitoType,
        message: error.message,
      });
      return {
        success: false,
        error: error.message,
        errorCode: COGNITO_ERROR_CODES[error.cognitoType] ?? "internal.error",
      };
    }
    logger.error(`Auth ${operation} unexpected error`, {
      error: error instanceof Error ? error.message : "Unknown",
    });
    return {
      success: false,
      error: "An unexpected error occurred",
      errorCode: "internal.error",
    };
  }

  private handleAuthError(error: unknown, operation: string): AuthResult {
    const failure = this.codedFailure(error, operation);
    // An unconfirmed account is the next step of sign-in, not a dead end: the client shows
    // the verification step on `emailVerificationRequired`.
    return failure.errorCode === "auth.email_not_verified"
      ? { ...failure, emailVerificationRequired: true }
      : failure;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCognitoAuthProvider(config?: CognitoConfig): CognitoAuthProvider {
  return new CognitoAuthProvider(config ?? getCognitoConfigFromEnv());
}
