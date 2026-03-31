/**
 * platform/auth/index.ts — Auth module public API
 *
 * Sprint 1: AuthProvider, types, config
 * Sprint 2: middleware, context
 * Sprint 3: permissions, entitlements, audit, cache
 * Sprint 4: profile, devices, consent, password-policy, coppa
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

// Sprint 4 — Profile & Privacy
export {
  getOwnProfile,
  getPublicProfile,
  updateProfile,
  getProfileAsAdmin,
} from "@/platform/auth/profile";
export type {
  PlayerProfile,
  ProfileUpdate,
  ProfileVisibility,
} from "@/platform/auth/profile";

export { registerDevice, listPlayerDevices, removeDevice } from "@/platform/auth/devices";
export type { DeviceRecord } from "@/platform/auth/devices";

export {
  grantConsent,
  revokeConsent,
  getPlayerConsents,
  hasConsent,
} from "@/platform/auth/consent";
export type { ConsentRecord } from "@/platform/auth/consent";

export {
  getEffectivePasswordPolicy,
  validatePassword,
} from "@/platform/auth/password-policy";
export type { PasswordPolicy } from "@/platform/auth/password-policy";

export {
  calculateAge,
  evaluateAge,
  recordAgeVerification,
  recordParentalConsent,
} from "@/platform/auth/coppa";
export type { AgeVerificationResult, ParentalConsentStatus } from "@/platform/auth/coppa";
