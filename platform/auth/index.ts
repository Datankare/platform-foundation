/**
 * platform/auth/index.ts — Auth module public API
 *
 * Import from here: import { AuthProvider, AuthResult } from "@/platform/auth";
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
