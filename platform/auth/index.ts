/**
 * platform/auth/index.ts — Auth module public API
 *
 * Import from here:
 *   import { getAuthProvider, registerAuthProvider } from "@/platform/auth";
 *   import { requireAuth, optionalAuth } from "@/platform/auth";
 *   import type { AuthProvider, AuthResult } from "@/platform/auth";
 */

export type { AuthProvider } from "@/platform/auth/provider";
export type {
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

export {
  registerAuthProvider,
  getAuthProvider,
  hasAuthProvider,
} from "@/platform/auth/config";

export { requireAuth, optionalAuth, requirePermission } from "@/platform/auth/middleware";

export type { AuthContext, AuthError } from "@/platform/auth/middleware";
