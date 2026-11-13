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

import { shown } from "@/platform/errors/shown-text";
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
  RenewalOutcome,
  SignOutEverywhereResult,
  SsoCallbackOptions,
  SsoCallbackResult,
  SsoInitOptions,
  SsoInitResult,
  SsoProvider,
  TokenPayload,
} from "@/platform/auth/types";
import { logger } from "@/lib/logger";
import { logCaught } from "@/platform/observability/caught-error";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import {
  readFailureText,
  reportExternalFailure,
} from "@/platform/observability/external-failure";
import {
  classifyHttpFailure,
  ExternalServiceError,
} from "@/platform/errors/external-service";
import {
  COGNITO_ADMIN_POLICY,
  getCognitoAdminCredentials,
  getCognitoSettings,
  isTenantId,
} from "@/platform/providers/environment-contract";
import { signAwsJsonPost, type AwsCredentials } from "@/platform/auth/aws-sigv4";
import {
  ERASURE_PROBE_USERNAME,
  compareClientSecrets,
  isAccessRefusal,
} from "@/platform/auth/admin-key-readiness";
import type {
  ClientSecretReadiness,
  ErasureAccessReadiness,
  PoolShapeReadiness,
  SessionAccessReadiness,
  TenantAttributeReadiness,
} from "@/platform/auth/provider";
import type { ErrorCode } from "@/platform/errors/registry";
import type { MessageValues } from "@/platform/errors/messages";
import type { JSONWebKeySet } from "jose";
import { identityProvidersOf } from "@/platform/auth/identity-directory";
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

/**
 * Whether a Cognito failure is the app client's secret being refused (a wrong, rotated or missing
 * COGNITO_CLIENT_SECRET): NotAuthorizedException "Unable to verify secret hash for client …", or
 * "Client … is configured for secret but secret was not received". TASK-197 (audit D-4).
 */
export function isClientSecretRejection(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const type =
    (error as { cognitoType?: unknown }).cognitoType ??
    (error as { name?: unknown }).name;
  return (
    type === "NotAuthorizedException" &&
    /secret[ _]?hash|configured (?:for|with) secret|secret was not received/i.test(
      error.message
    )
  );
}

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
import { sameId } from "@/platform/auth/same-id";

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
 * nothing for a public client (no secret configured). A refresh (REFRESH_TOKEN_AUTH) is hashed
 * with the user's `sub`: right for the pool shape the platform requires — users sign in by email
 * address (UsernameAttributes includes email), so the pool's username of a native user is its
 * sub. A pool that signs in by a chosen username is refused at readiness (checkPoolShape,
 * review 17 L4; docs/ENV_REFERENCE.md "Cognito pool shape").
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
  if (!sameId(claims.client_id, config.clientId)) return "issued to another app client";
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

/**
 * The scopes a hosted sign-in asks for (ADR-057 D7). `aws.cognito.signin.user.admin` — the scope
 * that lets a token's bearer call Cognito's own user API — is no longer asked for: the server
 * reads the user with its administrative key (AdminGetUser), so the token needs no such power.
 * Only a deployment without that key still asks for it, because there the token's own GetUser is
 * how a request is verified (audit A-13); operator readiness reports that deployment.
 */
export function ssoScopes(hasAdministrativeKey: boolean): string {
  return hasAdministrativeKey
    ? "openid email profile"
    : "openid email profile aws.cognito.signin.user.admin";
}

/**
 * Whether an administrative call was refused because of the key's policy (IAM's AccessDenied) —
 * as against the pool's answer about the user (UserNotFoundException, …).
 */
function isKeyRefusal(type: string): boolean {
  return type === "AccessDeniedException" || type === "UnauthorizedOperation";
}

let keyRefusalWarned = false;
/** Once per process: the administrative key may not read users, so tokens are verified by GetUser. */
function warnOnceKeyRefused(): void {
  if (keyRefusalWarned) return;
  keyRefusalWarned = true;
  logger.error(
    "The Cognito administrative key may not call AdminGetUser — tokens are verified with GetUser instead; add the action to the key's policy (TENANCY_OPERATIONS §3.3)",
    { route: "platform/auth/cognito-provider" }
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
    // What the network said is logged; the error says only that Cognito was not reached (R-77).
    logCaught(logger, "Cognito could not be reached", error, {
      action,
      route: "platform/auth/cognito-provider",
    });
    throw new CognitoError("Cognito could not be reached", "NetworkError", 0);
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

/**
 * The federated providers a GetUser answer says the user signs in with (review 16 L8): from the
 * `identities` attribute — any provider listed there means not native, a native user an operator
 * linked to a federated identity (AdminLinkProviderForUser) included (review 17 L2); none (native)
 * when it is absent and the pool's username is the user's sub (a pool that signs in by address
 * names a native user by its sub) — but only while the app client may read `identities`
 * (`identitiesReadable` not false: checkPoolShape found it hidden, review 17 L2), since a hidden
 * attribute is absent for every user; unknown — no field, so the address claim is never trusted —
 * otherwise. The username is evidence here only — never the account's subject, which is always
 * the `sub` (ADR-012, TASK-177).
 */
export function identityProvidersFrom(
  poolUsername: unknown,
  attrs: Array<{ Name: string; Value: string }> | undefined,
  identitiesReadable: boolean | undefined = undefined
): { identityProviders?: readonly string[] } {
  const identities = attrs?.find((a) => a.Name === "identities")?.Value;
  if (identities) return { identityProviders: identityProvidersOf(identities) };
  if (identitiesReadable === false) return {};
  const sub = attrs?.find((a) => a.Name === "sub")?.Value;
  return typeof poolUsername === "string" && poolUsername && sameId(poolUsername, sub)
    ? { identityProviders: [] }
    : {};
}

/**
 * The operator's check of the pool shape (review 17 L2/L4), for a deployment whose app has no
 * administrative credentials to check it itself: UsernameAttributes must include "email", and
 * ReadAttributes must be null (every attribute) or include "identities".
 */
export const POOL_SHAPE_OPERATOR_CHECK =
  'aws cognito-idp describe-user-pool --user-pool-id <pool> --query UserPool.UsernameAttributes  (must include "email"); aws cognito-idp describe-user-pool-client --user-pool-id <pool> --client-id <client> --query UserPoolClient.ReadAttributes  (null, or must include "identities")';

/**
 * Whether a refused password sign-in is the kind a federated account without a pool password
 * gets (TASK-194, C-3): Cognito answers NotAuthorized (or UserNotFound for a provider-named
 * user) — the same answer as a wrong password, so only a federated account is told it. Never a
 * refused client secret (TASK-197, D-4): that is the platform's credential, answered
 * service.unavailable and alerted (codedFailure), not "your step-up is unavailable".
 */
function isNoPasswordSignIn(error: unknown): boolean {
  return (
    error instanceof CognitoError &&
    !isClientSecretRejection(error) &&
    (error.cognitoType === "NotAuthorizedException" ||
      error.cognitoType === "UserNotFoundException")
  );
}

/** The `sub` attribute of a GetUser / AdminGetUser answer (undefined when it has none). */
function subAttribute(
  attrs: Array<{ Name: string; Value: string }> | undefined
): string | undefined {
  const value = attrs?.find((a) => a.Name === "sub")?.Value;
  return typeof value === "string" && value ? value : undefined;
}

/** A Cognito subject: a UUID (an erasure's lookup never puts anything else into a filter). */
const SUB_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How many sub → pool-username pairs a provider remembers for its administrative calls. */
const POOL_USERNAMES_MAX = 10_000;

// ---------------------------------------------------------------------------
// CognitoAuthProvider
// ---------------------------------------------------------------------------

export class CognitoAuthProvider implements AuthProvider {
  private readonly config: CognitoConfig;
  /** This instance's verifier: the shared cache, and its own in-flight GetUser calls. */
  private readonly tokens: TokenVerifier;
  /** The pool's signing keys: every token's signature is checked before GetUser (M5). */
  private readonly keys: JwksKeyStore;
  /**
   * The pool username of each subject seen in a signed token or a pool answer (TASK-177). The
   * subject is the `sub`; an administrative call (AdminGetUser, AdminUpdateUserAttributes) names a
   * user by its username — a native user's `sub` is accepted there too, a federated user's is not
   * (`Google_…` is its username). Learnt from the signature-checked `username` claim, never
   * guessed; a subject not seen here is addressed by its `sub` (right for every native user).
   */
  private readonly poolUsernames = new Map<string, string>();
  /**
   * Whether the app client may read `identities` (review 17 L2): learnt by checkPoolShape;
   * undefined until then. False: no user is taken as native for want of the attribute.
   */
  private identitiesReadable: boolean | undefined = undefined;

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
   * End one sign-in (ADR-057 D6): the refresh token is revoked (RevokeToken — the app client's
   * own call, no user token and no administrative key), and with it every access token it
   * issued. The user's other sign-ins are untouched; signOutEverywhere ends them all. The access
   * token is never sent: GlobalSignOut, which needed it (and its aws.cognito.signin.user.admin
   * scope), is no longer called. A failure is thrown — a sign-out that did not revoke must not be
   * reported as one — except a refresh token Cognito says is already void.
   */
  async signOut(accessToken: AuthToken, refreshToken?: AuthToken): Promise<void> {
    if (refreshToken) {
      try {
        await callCognito(this.config, "RevokeToken", {
          ClientId: this.config.clientId,
          Token: refreshToken,
          ...(this.config.clientSecret ? { ClientSecret: this.config.clientSecret } : {}),
        });
      } catch (error) {
        // A refresh token Cognito says is already void is revoked; the platform's own
        // credential refused (a rotated client secret) is not that.
        if (
          !(error instanceof CognitoError) ||
          error.cognitoType !== "NotAuthorizedException" ||
          isClientSecretRejection(error)
        ) {
          throw error;
        }
      }
    }
    // What was remembered of this user's tokens is void at once (review 7 P3), as before
    // ADR-057: the session's record has ended, and nothing stands on an earlier verification.
    const subject = decodeJwtPayload(accessToken)?.sub;
    if (typeof subject === "string" && subject) await revokeTokenVerification(subject);
    logger.info("User signed out");
  }

  /**
   * End every token Cognito issued the user (ADR-057 D6): AdminUserGlobalSignOut, signed with the
   * administrative key — never the user's token. A user the pool no longer has is signed out.
   * Without the key, or when its policy does not allow the action, the answer is
   * service.unavailable (auth): the platform's own sessions are ended in its records all the
   * same, and operator readiness names the missing action ("sessions").
   */
  async signOutEverywhere(userId: AuthUserId): Promise<SignOutEverywhereResult> {
    const credentials = this.config.adminCredentials;
    const unavailable = (error: string): SignOutEverywhereResult => ({
      success: false,
      error,
      errorCode: "service.unavailable",
    });
    if (!credentials) return unavailable("no administrative key");
    try {
      await callCognito(
        this.config,
        "AdminUserGlobalSignOut",
        { UserPoolId: this.config.userPoolId, Username: this.poolUsernameOf(userId) },
        credentials
      );
    } catch (error) {
      if (!(
        error instanceof CognitoError && error.cognitoType === "UserNotFoundException"
      )) {
        return unavailable(error instanceof CognitoError ? error.cognitoType : "error");
      }
    }
    await revokeTokenVerification(userId);
    return { success: true };
  }

  // ── Token Management ──

  /**
   * Verify a session's access token: its signature, audience and expiry here, and the user it
   * names with the pool by AdminGetUser — the administrative key, so the token itself is not
   * sent to Cognito (ADR-057 D7). The answer is remembered briefly in the shared cache and
   * revocable at once (platform/auth/token-verification.ts). Refused locally, before any call, when it is not
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
    // TASK-177: the subject is the token's `sub` — a UUID, unique in the pool and never reused,
    // the same for a native and a federated user (whose username is `Google_…`). Every subject
    // the platform produces (sessions, revocation stamps, provisioning) is this one.
    const subject = typeof decoded.sub === "string" ? decoded.sub : "";
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
    // The signature is good: its `username` claim is the pool's own, the handle its
    // administrative calls need for this subject (a federated user's is not its sub).
    if (typeof decoded.username === "string" && decoded.username)
      this.rememberPoolUsername(subject, decoded.username);
    return this.tokens.verify(
      accessToken,
      { exp: decoded.exp as number, subject },
      () => this.askUser(accessToken, decoded, subject),
      options
    );
  }

  private rememberPoolUsername(sub: string, username: string): void {
    this.poolUsernames.delete(sub);
    this.poolUsernames.set(sub, username);
    if (this.poolUsernames.size > POOL_USERNAMES_MAX) {
      const oldest = this.poolUsernames.keys().next().value;
      if (oldest !== undefined) this.poolUsernames.delete(oldest);
    }
  }

  /** The name an administrative call gives the user whose subject (`sub`) this is. */
  private poolUsernameOf(sub: AuthUserId): string {
    return this.poolUsernames.get(sub) ?? sub;
  }

  /**
   * The pool's record of the token's user, as an outcome: valid, invalid (no such user, a
   * disabled one, another subject's record), or unavailable (Cognito). Asked with the
   * administrative key (AdminGetUser, by the signed token's own `username`): the token is not
   * presented. A disabled user is refused at once. Only where the key cannot make the call — none
   * configured, or its policy refuses AdminGetUser — is the token's own GetUser used instead, as
   * before ADR-057 (a token without the aws.cognito.signin.user.admin scope is then refused by
   * Cognito); operator readiness reports that deployment ("sessions").
   */
  private async askUser(
    accessToken: AuthToken,
    decoded: Record<string, unknown>,
    subject: string
  ): Promise<ProviderOutcome> {
    let result: Record<string, unknown>;
    const credentials = this.config.adminCredentials;
    let administrative = false;
    try {
      if (credentials) {
        try {
          result = await callCognito(
            this.config,
            "AdminGetUser",
            {
              UserPoolId: this.config.userPoolId,
              Username: this.poolUsernameOf(subject),
            },
            credentials
          );
          administrative = true;
        } catch (error) {
          if (!(error instanceof CognitoError && isKeyRefusal(error.cognitoType)))
            throw error;
          warnOnceKeyRefused();
          result = await callCognito(this.config, "GetUser", {
            AccessToken: accessToken,
          });
        }
      } else {
        result = await callCognito(this.config, "GetUser", { AccessToken: accessToken });
      }
    } catch (error) {
      return cognitoUnavailable(error)
        ? { kind: "unavailable", reason: (error as CognitoError).cognitoType }
        : { kind: "invalid" };
    }
    // AdminGetUser answers for a disabled user too (GetUser refused its token): never served.
    if (administrative && result.Enabled === false) return { kind: "invalid" };
    const attrs = result.UserAttributes as Array<{ Name: string; Value: string }>;
    // The pool's record is of the token's own subject, or the token is not believed — an answer
    // without a `sub` included (review 17 L1: GetUser always lists it; one that does not cannot
    // be shown to be this user's). Its username is remembered only after that check.
    const sub = subAttribute(attrs);
    if (sub === undefined || !sameId(sub, subject)) return { kind: "invalid" };
    if (typeof result.Username === "string" && result.Username)
      this.rememberPoolUsername(subject, result.Username);
    warnOnceWithoutSession(decoded);
    const mfa = (result.UserMFASettingList as unknown[] | undefined) ?? [];
    return {
      kind: "valid",
      payload: {
        // Audit A-9: whether the user signs in with a second factor (staff must, by default).
        mfaEnabled: mfa.includes("SOFTWARE_TOKEN_MFA"),
        // TASK-177: the `sub` (a UUID for every user), never the pool's username.
        sub: subject,
        email: attrs?.find((a) => a.Name === "email")?.Value ?? "",
        emailVerified: attrs?.find((a) => a.Name === "email_verified")?.Value === "true",
        // Review 16 L8: who verified the address — the federated providers (`identities`), or
        // none for a native user (its pool username is its sub). Neither said: unknown, never
        // trusted.
        ...identityProvidersFrom(result.Username, attrs, this.identitiesReadable),
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
    subject?: AuthUserId
  ): Promise<AuthSession | null> {
    try {
      // A confidential client's refresh is hashed with the user's id (the token's subject).
      if (this.config.clientSecret && !subject) return null;
      const result = await callCognito(this.config, "InitiateAuth", {
        ClientId: this.config.clientId,
        AuthFlow: "REFRESH_TOKEN_AUTH",
        AuthParameters: {
          REFRESH_TOKEN: refreshToken,
          ...(subject ? withSecretParam(this.config, subject) : {}),
        },
      });

      const auth = result.AuthenticationResult as Record<string, unknown>;
      if (!auth) return null;

      const decoded = decodeJwtPayload(auth.AccessToken as string);
      const expiresIn = (auth.ExpiresIn as number) ?? 3600;
      // The refreshed session is the same user's, or it is not used.
      if (subject && !sameId(decoded?.sub, subject)) return null;

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

  /**
   * Renew a server-side session (ADR-057 D3): refreshToken's exchange, telling Cognito's refusal
   * (a revoked or expired refresh token, a deleted or disabled user, another user's token — the
   * session ends) from Cognito not answering (the session is kept).
   */
  async renewSession(
    refreshToken: AuthToken,
    subject: AuthUserId
  ): Promise<RenewalOutcome> {
    if (!refreshToken || !subject) return { kind: "refused" };
    try {
      const result = await callCognito(this.config, "InitiateAuth", {
        ClientId: this.config.clientId,
        AuthFlow: "REFRESH_TOKEN_AUTH",
        AuthParameters: {
          REFRESH_TOKEN: refreshToken,
          ...withSecretParam(this.config, subject),
        },
      });
      const auth = result.AuthenticationResult as Record<string, unknown> | undefined;
      if (!auth || typeof auth.AccessToken !== "string") return { kind: "refused" };
      const decoded = decodeJwtPayload(auth.AccessToken);
      if (!sameId(decoded?.sub, subject)) return { kind: "refused" };
      const expiresIn = typeof auth.ExpiresIn === "number" ? auth.ExpiresIn : 3600;
      return {
        kind: "renewed",
        session: {
          userId: subject,
          accessToken: auth.AccessToken,
          // With refresh-token rotation on, Cognito returns a new one; otherwise the same stands.
          refreshToken:
            typeof auth.RefreshToken === "string" && auth.RefreshToken
              ? auth.RefreshToken
              : refreshToken,
          idToken: auth.IdToken as string,
          expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
        },
      };
    } catch (error) {
      // The platform's own credential refused (a rotated client secret) is not the user's doing.
      if (isClientSecretRejection(error)) {
        this.codedFailure(error, "renewSession");
        return { kind: "unavailable" };
      }
      return cognitoUnavailable(error) ? { kind: "unavailable" } : { kind: "refused" };
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
      // Whose password it was (ADR-057 D6): the route ends every session of that account.
      const userId = await this.subjectOfAddress(email);
      return { success: true, ...(userId ? { userId } : {}) };
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

  /**
   * Turn the user's authenticator off: AdminSetUserMFAPreference, signed with the administrative
   * key — never the user's token (ADR-057 D7). Without the key, or when its policy does not
   * allow the action, the answer is service.unavailable (auth) and operator readiness names the
   * missing action ("sessions").
   */
  async disableMfa(
    userId: AuthUserId
  ): Promise<{ success: boolean; error?: string; errorCode?: ErrorCode }> {
    try {
      await callCognito(
        this.config,
        "AdminSetUserMFAPreference",
        {
          UserPoolId: this.config.userPoolId,
          Username: this.poolUsernameOf(userId),
          SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false },
        },
        this.requireAdmin()
      );
      return { success: true };
    } catch (error) {
      if (
        error instanceof CognitoError &&
        (isKeyRefusal(error.cognitoType) || error.cognitoType === "ConfigurationError")
      ) {
        logger.error("The Cognito administrative key may not turn a second factor off", {
          route: "platform/auth/cognito-provider",
          cognitoType: error.cognitoType,
        });
        return {
          success: false,
          error: "administrative key refused",
          errorCode: "service.unavailable",
          errorParams: { service: "auth" },
        } as { success: false; error: string; errorCode: ErrorCode };
      }
      return this.codedFailure(error, "Failed to disable MFA");
    }
  }

  /**
   * Step-up (TASK-194, audit C-3): the session's own user signs in again with the password and
   * answers the SOFTWARE_TOKEN_MFA challenge with the current code — the one way Cognito checks
   * an enrolled factor's code. The pool username comes from AdminGetUser on the session's subject
   * (the administrative key — the user's token is not used, ADR-057 D7), and the proof must be
   * of that same subject; the session it makes is revoked at once (best effort, logged).
   */
  async confirmCurrentFactor(
    userId: AuthUserId,
    password: string,
    totpCode: string | null
  ): Promise<{
    success: boolean;
    error?: string;
    errorCode?: ErrorCode;
    errorParams?: MessageValues;
  }> {
    const refused = (errorCode: ErrorCode, error: string) => ({
      success: false as const,
      error,
      errorCode,
    });
    try {
      const me = await callCognito(
        this.config,
        "AdminGetUser",
        { UserPoolId: this.config.userPoolId, Username: this.poolUsernameOf(userId) },
        this.requireAdmin()
      );
      const username = typeof me.Username === "string" ? me.Username : "";
      const attrs = (me.UserAttributes as Array<{ Name: string; Value: string }>) ?? [];
      const sub = subAttribute(attrs);
      const enrolled = ((me.UserMFASettingList as unknown[] | undefined) ?? []).includes(
        "SOFTWARE_TOKEN_MFA"
      );
      if (!username || !sub || !sameId(sub, userId))
        return refused("auth.token_invalid", "session user unknown");
      // A federated account (any provider in `identities`) may have no password in the pool to
      // confirm with: where the proof cannot be made, it is told so (auth.step_up_unavailable)
      // and how to recover — never let through without it.
      const federated =
        (identityProvidersFrom(username, attrs, this.identitiesReadable).identityProviders
          ?.length ?? 0) > 0;
      // A password alone proves only an account with no second factor (round 1, B1).
      if (totpCode === null && enrolled) {
        return refused(
          "auth.step_up_required",
          "a second factor is enrolled: its code is needed"
        );
      }
      if (totpCode !== null && !enrolled) {
        return federated
          ? refused(
              "auth.step_up_unavailable",
              "a federated account has no factor to confirm"
            )
          : refused("auth.step_up_required", "no second factor is enrolled");
      }
      let started: Record<string, unknown>;
      try {
        started = await callCognito(this.config, "InitiateAuth", {
          ClientId: this.config.clientId,
          AuthFlow: "USER_PASSWORD_AUTH",
          AuthParameters: {
            USERNAME: username,
            PASSWORD: password,
            ...withSecretParam(this.config, username),
          },
        });
      } catch (error) {
        if (federated && isNoPasswordSignIn(error)) {
          return refused(
            "auth.step_up_unavailable",
            "a federated account's password sign-in was refused"
          );
        }
        throw error;
      }
      let auth: Record<string, unknown> | undefined;
      if (totpCode === null) {
        // The password, and nothing else asked: the sign-in completed. Any challenge (a factor
        // enrolled since, a new password required) is not a proof made here.
        if (started.ChallengeName) {
          return refused(
            "auth.step_up_required",
            "the sign-in asked for more than a password"
          );
        }
        auth = started.AuthenticationResult as Record<string, unknown> | undefined;
      } else {
        if (started.ChallengeName !== "SOFTWARE_TOKEN_MFA") {
          // Signed in with no factor challenge: not a proof of the factor. Leave no session.
          await this.revokeQuietly(started.AuthenticationResult);
          return refused(
            "auth.step_up_required",
            "the sign-in asked for no second factor"
          );
        }
        const answered = await callCognito(this.config, "RespondToAuthChallenge", {
          ClientId: this.config.clientId,
          ChallengeName: "SOFTWARE_TOKEN_MFA",
          Session: started.Session,
          ChallengeResponses: {
            USERNAME: username,
            SOFTWARE_TOKEN_MFA_CODE: totpCode,
            ...withSecretParam(this.config, username),
          },
        });
        auth = answered.AuthenticationResult as Record<string, unknown> | undefined;
      }
      await this.revokeQuietly(auth);
      if (!auth) return refused("auth.challenge_failed", "MFA challenge failed");
      const proved = decodeJwtPayload(auth.AccessToken as string);
      if (!sameId(proved?.sub, sub))
        return refused("auth.token_invalid", "another user's proof");
      return { success: true };
    } catch (error) {
      // No administrative key, or one whose policy cannot read the user: the proof cannot be
      // made here — the platform's failure (operator readiness, "sessions"), never the user's.
      if (
        error instanceof CognitoError &&
        (error.cognitoType === "ConfigurationError" || isKeyRefusal(error.cognitoType))
      ) {
        logger.error("Step-up unavailable: the administrative key cannot read the user", {
          route: "platform/auth/cognito-provider",
          cognitoType: error.cognitoType,
        });
        return {
          success: false,
          error: "administrative key unavailable",
          errorCode: "service.unavailable",
          errorParams: { service: "auth" },
        };
      }
      return this.codedFailure(error, "confirmCurrentFactor");
    }
  }

  /** Revoke a step-up sign-in's refresh token (and so its tokens); a failure is only logged. */
  private async revokeQuietly(auth: unknown): Promise<void> {
    const token = (auth as { RefreshToken?: unknown } | undefined)?.RefreshToken;
    if (typeof token !== "string" || !token) return;
    try {
      await callCognito(this.config, "RevokeToken", {
        ClientId: this.config.clientId,
        Token: token,
        ...(this.config.clientSecret ? { ClientSecret: this.config.clientSecret } : {}),
      });
    } catch (error) {
      logger.warn("Step-up session could not be revoked", {
        error: error instanceof Error ? error.message : String(error),
        route: "platform/auth/cognito-provider",
      });
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
    url.searchParams.set("scope", ssoScopes(Boolean(this.config.adminCredentials)));
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
        // TASK-197 (audit D-4): the token endpoint authenticates the app client; a wrong or
        // rotated COGNITO_CLIENT_SECRET answers `invalid_client` for every sign-in by SSO — the
        // platform's credential, alerted and coded service.unavailable, not the user's failure.
        if (/invalid_client/.test(await readFailureText(response))) {
          reportExternalFailure(
            new ExternalServiceError(
              "cognito",
              "credential",
              "Cognito's token endpoint refused the app client (invalid_client)",
              { status: response.status }
            )
          );
          return {
            success: false,
            error: `SSO token exchange refused the app client: ${response.status}`,
            errorCode: "service.unavailable",
            errorParams: { service: "auth" },
          };
        }
        // Anything else is recorded too (review round 1, L-6): an outage or a throttle as what
        // it is (an alert where it is the platform's), a refused code — expired, reused — as
        // `rejected`, a metric only: the user's, who signs in again.
        reportExternalFailure(
          new ExternalServiceError(
            "cognito",
            response.status >= 500 || response.status === 429
              ? classifyHttpFailure(response.status)
              : "rejected",
            `SSO token exchange failed: ${response.status}`,
            { status: response.status }
          )
        );
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
      // TASK-177: the subject is the `sub`, as verifyToken names it — never the username.
      const sub = subAttribute(attrs) ?? decodeJwtPayload(accessToken)?.sub;
      if (typeof sub !== "string" || !sub) return null;
      return {
        userId: sub,
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
   * subject is the user's `sub` (TASK-177), read with AdminGetUser for the address; without
   * administrative credentials it cannot be looked up, and the fresh window (≤ 60 s) bounds it.
   */
  private async revokeVerificationsOf(email: string): Promise<void> {
    if (!this.config.adminCredentials) return;
    try {
      const sub = await this.readSubjectOfAddress(email);
      if (sub) await revokeTokenVerification(sub);
    } catch (error) {
      logger.warn("Remembered token verifications not voided after an attribute change", {
        route: "platform/auth/cognito-provider",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** The subject (`sub`) of the pool user who signs in with `email` (AdminGetUser). */
  private async readSubjectOfAddress(email: string): Promise<string | undefined> {
    const user = await callCognito(
      this.config,
      "AdminGetUser",
      { UserPoolId: this.config.userPoolId, Username: email },
      this.requireAdmin()
    );
    const sub = subAttribute(
      user.UserAttributes as Array<{ Name: string; Value: string }> | undefined
    );
    if (sub && typeof user.Username === "string" && user.Username)
      this.rememberPoolUsername(sub, user.Username);
    return sub;
  }

  /** As readSubjectOfAddress, or undefined when it cannot be read (no key, no answer). */
  private async subjectOfAddress(email: string): Promise<string | undefined> {
    try {
      return await this.readSubjectOfAddress(email);
    } catch (error) {
      logger.warn("The subject of an address could not be read", {
        route: "platform/auth/cognito-provider",
        cognitoType: error instanceof CognitoError ? error.cognitoType : "Unknown",
      });
      return undefined;
    }
  }

  /**
   * Set the user's tenant — an administrative write. Idempotent. The
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
          // The user's subject is its sub; the call names it by the pool's username (TASK-177).
          Username: this.poolUsernameOf(userId),
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
        { UserPoolId: this.config.userPoolId, Username: this.poolUsernameOf(userId) },
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
        reason: shown("screens.readiness.no_admin_credentials"),
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
          reason: shown("screens.readiness.attribute_missing", {
            attribute: TENANT_ATTRIBUTE,
          }),
        };
      }
      if (attr.AttributeDataType && attr.AttributeDataType !== "String") {
        return {
          state: "unsafe",
          reason: shown("screens.readiness.attribute_not_string", {
            attribute: TENANT_ATTRIBUTE,
          }),
        };
      }
      if (attr.Mutable === false) {
        return {
          state: "unsafe",
          reason: shown("screens.readiness.attribute_immutable", {
            attribute: TENANT_ATTRIBUTE,
          }),
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
        const which = sameId(clientId, this.config.clientId)
          ? "the app client"
          : `app client ${clientId}`;
        // An absent WriteAttributes list means "every writable attribute" — custom ones included.
        if (!c.WriteAttributes || c.WriteAttributes.includes(TENANT_ATTRIBUTE)) {
          return {
            state: "unsafe",
            reason: shown("screens.readiness.attribute_writable", {
              client: which,
              attribute: TENANT_ATTRIBUTE,
            }),
          };
        }
        if (
          sameId(clientId, this.config.clientId) &&
          c.ReadAttributes &&
          !c.ReadAttributes.includes(TENANT_ATTRIBUTE)
        ) {
          return {
            state: "unsafe",
            reason: shown("screens.readiness.attribute_unreadable", {
              attribute: TENANT_ATTRIBUTE,
            }),
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
            reason: shown("screens.readiness.attribute_mapped", {
              provider: name,
              attribute: TENANT_ATTRIBUTE,
            }),
          };
        }
      }
      return { state: "ready" };
    } catch (error) {
      return {
        state: "unknown",
        reason: shown("screens.readiness.pool_undescribed", {
          error: error instanceof CognitoError ? error.cognitoType : "error",
        }),
      };
    }
  }

  /**
   * Whether the pool has the shape the platform requires (review 17 L2/L4): users sign in by
   * email address (UsernameAttributes includes email — a native user's pool username is then its
   * sub, which the refresh's SECRET_HASH and the native-user rule rely on; fixed when the pool is
   * created), and the app client may read `identities` (who verified an address). Needs the
   * administrative credentials (DescribeUserPool, DescribeUserPoolClient); without them `unknown`
   * and the operator's check (POOL_SHAPE_OPERATOR_CHECK). What it learns about `identities` is
   * used at once: hidden, no user is taken as native for want of it.
   */
  async checkPoolShape(): Promise<PoolShapeReadiness> {
    const credentials = this.config.adminCredentials;
    if (!credentials) {
      return {
        state: "unknown",
        reason: `administrative credentials are not configured — check the pool by hand: ${POOL_SHAPE_OPERATOR_CHECK}`,
        cause: "no_credentials",
      };
    }
    try {
      const pool = await callCognito(
        this.config,
        "DescribeUserPool",
        { UserPoolId: this.config.userPoolId },
        credentials
      );
      const usernameAttributes = ((pool.UserPool as Record<string, unknown> | undefined)
        ?.UsernameAttributes ?? []) as unknown[];
      const client = await callCognito(
        this.config,
        "DescribeUserPoolClient",
        { UserPoolId: this.config.userPoolId, ClientId: this.config.clientId },
        credentials
      );
      const read = ((client.UserPoolClient ?? {}) as { ReadAttributes?: unknown })
        .ReadAttributes;
      // An absent ReadAttributes list means "every attribute".
      this.identitiesReadable = !Array.isArray(read) || read.includes("identities");
      if (!usernameAttributes.includes("email")) {
        return {
          state: "unsafe",
          reason:
            "the pool signs in by username (UsernameAttributes does not include email): a native user's username is not its sub, so refreshing a session fails (SECRET_HASH) — the platform needs a pool whose users sign in by email address (fixed at pool creation: a new pool)",
          cause: "username_sign_in",
        };
      }
      if (!this.identitiesReadable) {
        return {
          state: "unsafe",
          reason:
            "the app client cannot read the identities attribute: no user is taken as native, so no address is marked verified from the pool — add identities to the client's readable attributes",
          cause: "identities_hidden",
        };
      }
      return { state: "ready" };
    } catch (error) {
      return {
        state: "unknown",
        reason: `the pool could not be described (${error instanceof CognitoError ? error.cognitoType : "error"})`,
        cause: "unavailable",
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

  /**
   * Delete the identity with the administrative credentials (TASK-193, audit B-8/D-9): erasure's
   * identity step, by the user's subject. The call names the pool user by its username: the one
   * a signed token taught (TASK-177), else the one ListUsers finds with this `sub` — a native
   * user's or a federated one's (`Google_…`; round 1: falling back to the `sub` as the username
   * answered UserNotFoundException for every federated user, counted done while the identity
   * stayed). `notFound` only when this pool has no user with the subject (ListUsers answered
   * none, or a subject no pool user can have); an ambiguous or refused lookup fails, and the
   * erasure retries it. The subject's remembered verifications are revoked when it is gone.
   */
  async adminDeleteUser(
    userId: AuthUserId
  ): Promise<{ success: boolean; notFound?: boolean; error?: string }> {
    // A Cognito subject is a UUID: anything else names no pool user, and never reaches a filter.
    if (!SUB_SHAPE.test(userId)) return { success: true, notFound: true };
    let credentials: AwsCredentials;
    try {
      credentials = this.requireAdmin();
    } catch (error) {
      return this.codedFailure(error, "adminDeleteUser");
    }
    try {
      let username = this.poolUsernames.get(userId);
      if (!username) {
        const found = await callCognito(
          this.config,
          "ListUsers",
          { UserPoolId: this.config.userPoolId, Filter: `sub = "${userId}"`, Limit: 2 },
          credentials
        );
        const users = (
          (found.Users as
            | Array<{
                Username?: string;
                Attributes?: Array<{ Name: string; Value: string }>;
              }>
            | undefined) ?? []
        ).filter((u) =>
          sameId(u.Attributes?.find((a) => a.Name === "sub")?.Value, userId)
        );
        if (users.length === 0) {
          await revokeTokenVerification(userId);
          return { success: true, notFound: true };
        }
        if (users.length > 1 || !users[0].Username) {
          return { success: false, error: "more than one pool user has this subject" };
        }
        username = users[0].Username;
      }
      await callCognito(
        this.config,
        "AdminDeleteUser",
        { UserPoolId: this.config.userPoolId, Username: username },
        credentials
      );
      await revokeTokenVerification(userId);
      logger.info("User identity deleted from Cognito (administrative)");
      return { success: true };
    } catch (error) {
      if (
        error instanceof CognitoError &&
        error.cognitoType === "UserNotFoundException"
      ) {
        await revokeTokenVerification(userId);
        return { success: true, notFound: true };
      }
      return this.codedFailure(error, "adminDeleteUser");
    }
  }

  /**
   * Whether this pool has the identity with this subject (S2 round 2): a username learnt from a
   * token this pool signed, or ListUsers finding exactly one user with the subject. False when
   * ListUsers finds none (or the subject is not a UUID); undefined when the lookup fails or is
   * ambiguous.
   */
  async identityInPool(userId: AuthUserId): Promise<boolean | undefined> {
    if (!SUB_SHAPE.test(userId)) return false;
    if (this.poolUsernames.get(userId)) return true;
    try {
      const found = await callCognito(
        this.config,
        "ListUsers",
        { UserPoolId: this.config.userPoolId, Filter: `sub = "${userId}"`, Limit: 2 },
        this.requireAdmin()
      );
      const users = (
        (found.Users as
          Array<{ Attributes?: Array<{ Name: string; Value: string }> }> | undefined) ??
        []
      ).filter((u) => sameId(u.Attributes?.find((a) => a.Name === "sub")?.Value, userId));
      if (users.length === 0) return false;
      return users.length === 1 ? true : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Whether erasure can delete identities from this pool (N-22): the administrative key is set,
   * DescribeUserPool answers this pool, ListUsers is allowed (a lookup of ERASURE_PROBE_USERNAME,
   * a name no pool user can have — not a UUID, not an address), and AdminDeleteUser is allowed: the
   * delete of that absent user answers UserNotFoundException when the policy allows the action and
   * AccessDeniedException when it does not — nothing exists to delete, and the delete is not sent
   * when the lookup found anyone. Read on demand by operator readiness, never on a timer.
   */
  async checkErasureAccess(): Promise<ErasureAccessReadiness> {
    const credentials = this.config.adminCredentials;
    if (!credentials) {
      return {
        state: "missing",
        reason: shown("screens.readiness.erasure_no_key"),
      };
    }
    const denied = (action: string): ErasureAccessReadiness => ({
      state: "denied",
      action,
      reason: shown("screens.readiness.erasure_denied", {
        action: action,
        policy: COGNITO_ADMIN_POLICY,
      }),
    });
    const isDenied = (e: unknown) =>
      e instanceof CognitoError && isAccessRefusal(e.cognitoType);
    const unknown = (action: string, e: unknown): ErasureAccessReadiness => ({
      state: "unknown",
      reason: shown("screens.readiness.no_answer", {
        action: action,
        error: e instanceof CognitoError ? e.cognitoType : "error",
      }),
    });
    let step = "DescribeUserPool";
    try {
      const pool = await callCognito(
        this.config,
        "DescribeUserPool",
        { UserPoolId: this.config.userPoolId },
        credentials
      );
      if (
        !sameId(
          (pool.UserPool as { Id?: string } | undefined)?.Id,
          this.config.userPoolId
        )
      ) {
        return { state: "unknown", reason: shown("screens.readiness.another_pool") };
      }
      step = "ListUsers";
      const found = await callCognito(
        this.config,
        "ListUsers",
        {
          UserPoolId: this.config.userPoolId,
          Filter: `username = "${ERASURE_PROBE_USERNAME}"`,
          Limit: 1,
        },
        credentials
      );
      if (((found.Users as unknown[] | undefined) ?? []).length > 0) {
        return {
          state: "unknown",
          reason: shown("screens.readiness.probe_user_exists", {
            user: ERASURE_PROBE_USERNAME,
          }),
        };
      }
      step = "AdminDeleteUser";
      await callCognito(
        this.config,
        "AdminDeleteUser",
        { UserPoolId: this.config.userPoolId, Username: ERASURE_PROBE_USERNAME },
        credentials
      );
      // A delete of a name no user has cannot succeed; it is not taken as proof.
      return {
        state: "unknown",
        reason: shown("screens.readiness.delete_answered_absent"),
      };
    } catch (error) {
      if (
        step === "AdminDeleteUser" &&
        error instanceof CognitoError &&
        error.cognitoType === "UserNotFoundException"
      ) {
        return { state: "ready" };
      }
      return isDenied(error) ? denied(step) : unknown(step, error);
    }
  }

  /**
   * Whether the administrative key can do what server-side sessions ask of it (ADR-057 D7):
   * read a user (AdminGetUser), end every token of one (AdminUserGlobalSignOut) and turn a second
   * factor off (AdminSetUserMFAPreference). Each is tried on ERASURE_PROBE_USERNAME, a name no
   * pool user can have: UserNotFoundException means the policy allows the action,
   * AccessDeniedException that it does not. Nothing is changed. Read on demand by operator
   * readiness, never on a timer.
   */
  async checkSessionAccess(): Promise<SessionAccessReadiness> {
    const credentials = this.config.adminCredentials;
    if (!credentials) {
      return { state: "missing", reason: shown("screens.readiness.sessions_no_key") };
    }
    // AdminSetUserMFAPreference is sent with no setting: were the name ever a user's, nothing
    // would change.
    const probes = [
      "AdminGetUser",
      "AdminUserGlobalSignOut",
      "AdminSetUserMFAPreference",
    ];
    for (const action of probes) {
      try {
        await callCognito(
          this.config,
          action,
          { UserPoolId: this.config.userPoolId, Username: ERASURE_PROBE_USERNAME },
          credentials
        );
        // A call naming no user cannot succeed; an answer is not taken as proof.
        return {
          state: "unknown",
          reason: shown("screens.readiness.probe_user_exists", {
            user: ERASURE_PROBE_USERNAME,
          }),
        };
      } catch (error) {
        if (
          error instanceof CognitoError &&
          error.cognitoType === "UserNotFoundException"
        )
          continue;
        if (error instanceof CognitoError && isAccessRefusal(error.cognitoType)) {
          return {
            state: "denied",
            action,
            reason: shown("screens.readiness.sessions_denied", {
              action,
              policy: COGNITO_ADMIN_POLICY,
            }),
          };
        }
        return {
          state: "unknown",
          reason: shown("screens.readiness.no_answer", {
            action,
            error: error instanceof CognitoError ? error.cognitoType : "error",
          }),
        };
      }
    }
    return { state: "ready" };
  }

  /**
   * Whether the app client's secret this deployment holds is the pool's (N-52): DescribeUserPoolClient
   * (the administrative key) gives the client's secret, compared with COGNITO_CLIENT_SECRET in
   * constant time; neither is ever logged or returned. A client with a secret and none held, or one
   * held for a client without, is a mismatch: every sign-in would be refused. Never a sign-in.
   */
  async checkClientSecret(): Promise<ClientSecretReadiness> {
    const credentials = this.config.adminCredentials;
    if (!credentials) {
      return {
        state: "not_checkable",
        reason: shown("screens.readiness.client_unreadable_no_key"),
      };
    }
    try {
      const r = await callCognito(
        this.config,
        "DescribeUserPoolClient",
        { UserPoolId: this.config.userPoolId, ClientId: this.config.clientId },
        credentials
      );
      const poolSecret = (r.UserPoolClient as { ClientSecret?: unknown } | undefined)
        ?.ClientSecret;
      return compareClientSecrets(
        typeof poolSecret === "string" && poolSecret ? poolSecret : undefined,
        this.config.clientSecret
      );
    } catch (error) {
      return {
        state: "unknown",
        reason: shown("screens.readiness.no_answer", {
          action: "DescribeUserPoolClient",
          error: error instanceof CognitoError ? error.cognitoType : "error",
        }),
      };
    }
  }

  /** The identity pool this provider erases from (TASK-193 round 1: recorded on each erasure). */
  identityPoolId(): string {
    return this.config.userPoolId;
  }

  /**
   * Whether the pool the administrative credentials reach is this one (DescribeUserPool answers
   * this pool's id): a "not found" counts as erased only after this positive check.
   */
  async confirmIdentityPool(): Promise<boolean> {
    try {
      const r = await callCognito(
        this.config,
        "DescribeUserPool",
        { UserPoolId: this.config.userPoolId },
        this.requireAdmin()
      );
      return sameId(
        (r.UserPool as { Id?: string } | undefined)?.Id,
        this.config.userPoolId
      );
    } catch {
      return false;
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
  ): {
    success: false;
    error: string;
    errorCode: ErrorCode;
    errorParams?: Readonly<Record<string, string>>;
  } {
    // TASK-197 (audit D-4): a wrong or rotated COGNITO_CLIENT_SECRET fails every SECRET_HASH with
    // NotAuthorizedException — read as "wrong email or password" for every user. It is the
    // platform's credential: coded service.unavailable, and alerted.
    if (isClientSecretRejection(error)) {
      reportExternalFailure(
        new ExternalServiceError(
          "cognito",
          "credential",
          `Cognito refused the app client's secret (${operation})`,
          { providerCode: "NotAuthorizedException" }
        )
      );
      return {
        success: false,
        error: "client secret refused",
        errorCode: "service.unavailable",
        errorParams: { service: "auth" },
      };
    }
    if (error instanceof CognitoError) {
      logger.warn(`Auth ${operation} failed`, {
        cognitoType: error.cognitoType,
        message: error.message,
      });
      // Cognito's own words are in the line above; the result names the exception's type (R-77).
      return {
        success: false,
        error: `${operation}: ${error.cognitoType}`,
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
