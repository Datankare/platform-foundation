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
  SsoCallbackResult,
  SsoInitResult,
  SsoProvider,
  TokenPayload,
} from "@/platform/auth/types";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface CognitoConfig {
  region: string;
  userPoolId: string;
  clientId: string;
  timeoutMs?: number;
}

export function getCognitoConfigFromEnv(): CognitoConfig {
  const region = process.env.COGNITO_REGION ?? process.env.AWS_REGION ?? "us-east-1";
  const userPoolId = process.env.COGNITO_USER_POOL_ID ?? "";
  const clientId = process.env.COGNITO_CLIENT_ID ?? "";

  if (!userPoolId || !clientId) {
    logger.warn("Cognito config incomplete", {
      hasUserPoolId: !!userPoolId,
      hasClientId: !!clientId,
    });
  }

  return { region, userPoolId, clientId };
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

async function callCognito(
  config: CognitoConfig,
  action: string,
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const endpoint = `https://cognito-idp.${config.region}.amazonaws.com/`;
  const timeout = config.timeoutMs ?? 10000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": `AWSCognitoIdentityProviderService.${action}`,
      },
      body: JSON.stringify(payload),
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

/** Base64url encode — browser + Node compatible */
function b64urlEncode(str: string): string {
  if (typeof btoa === "function") {
    return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  // Node.js fallback — Buffer available server-side, not in browser
  return Buffer.from(str).toString("base64url");
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

// ---------------------------------------------------------------------------
// CognitoAuthProvider
// ---------------------------------------------------------------------------

export class CognitoAuthProvider implements AuthProvider {
  private readonly config: CognitoConfig;

  constructor(config: CognitoConfig) {
    this.config = config;
  }

  // ── Sign Up / Sign In ──

  async signUp(email: string, password: string): Promise<AuthResult> {
    try {
      const result = await callCognito(this.config, "SignUp", {
        ClientId: this.config.clientId,
        Username: email,
        Password: password,
        UserAttributes: [{ Name: "email", Value: email }],
      });

      logger.info("User signed up", { email, confirmed: result.UserConfirmed });

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
        AuthParameters: { USERNAME: email, PASSWORD: password },
      });

      if (result.ChallengeName === "SOFTWARE_TOKEN_MFA") {
        return {
          success: false,
          mfaRequired: true,
          mfaSession: result.Session as string,
        };
      }

      const auth = result.AuthenticationResult as Record<string, unknown>;
      if (!auth) return { success: false, error: "No authentication result" };

      const decoded = decodeJwtPayload(auth.AccessToken as string);

      logger.info("User signed in", { email });

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

  async signOut(accessToken: AuthToken): Promise<void> {
    try {
      await callCognito(this.config, "GlobalSignOut", { AccessToken: accessToken });
      logger.info("User signed out");
    } catch (error) {
      logger.warn("Sign out failed — client tokens cleared anyway", {
        error: error instanceof Error ? error.message : "Unknown",
      });
    }
  }

  // ── Token Management ──

  async verifyToken(accessToken: AuthToken): Promise<TokenPayload | null> {
    try {
      const result = await callCognito(this.config, "GetUser", {
        AccessToken: accessToken,
      });

      const attrs = result.UserAttributes as Array<{ Name: string; Value: string }>;
      const decoded = decodeJwtPayload(accessToken);

      return {
        sub: result.Username as string,
        email: attrs?.find((a) => a.Name === "email")?.Value ?? "",
        emailVerified: attrs?.find((a) => a.Name === "email_verified")?.Value === "true",
        iat: (decoded?.iat as number) ?? 0,
        exp: (decoded?.exp as number) ?? 0,
      };
    } catch {
      return null;
    }
  }

  async refreshToken(refreshToken: AuthToken): Promise<AuthSession | null> {
    try {
      const result = await callCognito(this.config, "InitiateAuth", {
        ClientId: this.config.clientId,
        AuthFlow: "REFRESH_TOKEN_AUTH",
        AuthParameters: { REFRESH_TOKEN: refreshToken },
      });

      const auth = result.AuthenticationResult as Record<string, unknown>;
      if (!auth) return null;

      const decoded = decodeJwtPayload(auth.AccessToken as string);
      const expiresIn = (auth.ExpiresIn as number) ?? 3600;

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
        Username: email,
      });
      return { success: true, deliveryMedium: "email" };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof CognitoError ? error.message : "Failed to send reset code",
      };
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
        Username: email,
        ConfirmationCode: code,
        Password: newPassword,
      });
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof CognitoError ? error.message : "Password reset failed",
      };
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
      return {
        success: false,
        error: error instanceof CognitoError ? error.message : "Password change failed",
      };
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
        Username: email,
        ConfirmationCode: code,
      });
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof CognitoError ? error.message : "Verification failed",
      };
    }
  }

  async resendEmailVerification(email: string): Promise<EmailVerificationResult> {
    try {
      await callCognito(this.config, "ResendConfirmationCode", {
        ClientId: this.config.clientId,
        Username: email,
      });
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof CognitoError ? error.message : "Failed to resend code",
      };
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
      return {
        success: false,
        error: error instanceof CognitoError ? error.message : "MFA setup failed",
      };
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
      return {
        success: false,
        error: error instanceof CognitoError ? error.message : "MFA verification failed",
      };
    }
  }

  async respondToMfaChallenge(mfaSession: string, totpCode: string): Promise<AuthResult> {
    try {
      const result = await callCognito(this.config, "RespondToAuthChallenge", {
        ClientId: this.config.clientId,
        ChallengeName: "SOFTWARE_TOKEN_MFA",
        Session: mfaSession,
        ChallengeResponses: {
          USERNAME: "MFA_USER",
          SOFTWARE_TOKEN_MFA_CODE: totpCode,
        },
      });

      const auth = result.AuthenticationResult as Record<string, unknown>;
      if (!auth) return { success: false, error: "MFA challenge failed" };

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
      return {
        success: false,
        error: error instanceof CognitoError ? error.message : "Failed to disable MFA",
      };
    }
  }

  // ── SSO ──

  async initiateSso(provider: SsoProvider, redirectUri: string): Promise<SsoInitResult> {
    const domain = `${this.config.userPoolId.split("_")[1]?.toLowerCase()}.auth.${this.config.region}.amazoncognito.com`;
    const identityProvider =
      provider === "google"
        ? "Google"
        : provider === "apple"
          ? "SignInWithApple"
          : "Microsoft";

    const url = new URL(`https://${domain}/oauth2/authorize`);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("identity_provider", identityProvider);

    return { success: true, redirectUrl: url.toString() };
  }

  async handleSsoCallback(
    _provider: SsoProvider,
    code: string,
    redirectUri: string
  ): Promise<SsoCallbackResult> {
    const domain = `${this.config.userPoolId.split("_")[1]?.toLowerCase()}.auth.${this.config.region}.amazoncognito.com`;

    try {
      const response = await fetch(`https://${domain}/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: this.config.clientId,
          code,
          redirect_uri: redirectUri,
        }),
      });

      if (!response.ok) return { success: false, error: "SSO token exchange failed" };

      const tokens = (await response.json()) as Record<string, unknown>;
      const decoded = decodeJwtPayload(tokens.access_token as string);

      return {
        success: true,
        userId: decoded?.sub as string,
        accessToken: tokens.access_token as string,
        refreshToken: tokens.refresh_token as string,
        idToken: tokens.id_token as string,
        expiresIn: tokens.expires_in as number,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "SSO callback failed",
      };
    }
  }

  // ── Guest Mode ──

  async createGuestToken(): Promise<GuestTokenResult> {
    const guestId = `guest_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const expiresAt = Math.floor(Date.now() / 1000) + 72 * 3600;
    const token = b64urlEncode(
      JSON.stringify({
        sub: guestId,
        type: "guest",
        iat: Math.floor(Date.now() / 1000),
        exp: expiresAt,
      })
    );

    return { success: true, guestId, token: `guest.${token}`, expiresAt };
  }

  async verifyGuestToken(
    token: AuthToken
  ): Promise<{ valid: boolean; guestId?: string }> {
    try {
      if (!token.startsWith("guest.")) return { valid: false };
      const payload = JSON.parse(b64urlDecode(token.slice(6)));
      if (payload.exp < Math.floor(Date.now() / 1000)) return { valid: false };
      return { valid: true, guestId: payload.sub };
    } catch {
      return { valid: false };
    }
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
      return {
        success: false,
        error: error instanceof CognitoError ? error.message : "Failed to forget device",
      };
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

  async deleteUser(
    accessToken: AuthToken
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await callCognito(this.config, "DeleteUser", { AccessToken: accessToken });
      logger.info("User account deleted from Cognito");
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof CognitoError ? error.message : "Account deletion failed",
      };
    }
  }

  // ── Error Handling ──

  private handleAuthError(error: unknown, operation: string): AuthResult {
    if (error instanceof CognitoError) {
      logger.warn(`Auth ${operation} failed`, {
        cognitoType: error.cognitoType,
        message: error.message,
      });

      switch (error.cognitoType) {
        case "UserNotFoundException":
        case "NotAuthorizedException":
          return { success: false, error: "Invalid email or password" };
        case "UsernameExistsException":
          return { success: false, error: "An account with this email already exists" };
        case "UserNotConfirmedException":
          return {
            success: false,
            error: "Please verify your email",
            emailVerificationRequired: true,
          };
        case "InvalidPasswordException":
          return { success: false, error: "Password does not meet requirements" };
        case "CodeMismatchException":
          return { success: false, error: "Invalid verification code" };
        case "ExpiredCodeException":
          return { success: false, error: "Verification code has expired" };
        case "LimitExceededException":
        case "TooManyRequestsException":
          return { success: false, error: "Too many attempts. Please try again later." };
        default:
          return { success: false, error: error.message };
      }
    }

    logger.error(`Auth ${operation} unexpected error`, {
      error: error instanceof Error ? error.message : "Unknown",
    });
    return { success: false, error: "An unexpected error occurred" };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCognitoAuthProvider(config?: CognitoConfig): CognitoAuthProvider {
  return new CognitoAuthProvider(config ?? getCognitoConfigFromEnv());
}
