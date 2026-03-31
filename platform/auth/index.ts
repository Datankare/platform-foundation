/**
 * platform/auth/index.ts — Auth module public API
 *
 * Import from here:
 *   import { getAuthProvider, registerAuthProvider } from "@/platform/auth";
 *   import { requireAuth, requirePermission } from "@/platform/auth";
 *   import { resolvePermissions, hasPermission } from "@/platform/auth";
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

// Sprint 3 — Permissions & Entitlements
export { resolvePermissions, hasPermission } from "@/platform/auth/permissions";
export type { EffectivePermissions } from "@/platform/auth/permissions";

export {
  getCachedPermissions,
  hasCachedPermission,
  invalidatePermissions,
  clearPermissionsCache,
  getCacheStats,
} from "@/platform/auth/permissions-cache";

export {
  grantEntitlement,
  revokeEntitlement,
  getPlayerEntitlements,
} from "@/platform/auth/entitlements";

export { writeAuditLog, getAuditLogForPlayer } from "@/platform/auth/audit";
export type { AuditAction, AuditEntry } from "@/platform/auth/audit";
