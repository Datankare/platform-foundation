/**
 * platform/auth/audit-actions.ts — The names an audit record's action may take
 *
 * Client-safe (no imports): platform/auth/audit.ts re-exports them for the server, and the admin
 * console's search validator (app/api/admin/ai/search-filters.ts) reads them in the browser too,
 * so the confirm panel and the server refuse the same `action` values (TASK-190).
 *
 * @module platform/auth
 */

/** Every action an audit record may carry; each must be accepted by the audit_action enum
 *  (checked by scripts/migration-replay.sh). */
export const AUDIT_ACTIONS = [
  "role_changed",
  "permission_granted",
  "permission_revoked",
  "entitlement_granted",
  "entitlement_revoked",
  "entitlement_expired",
  "profile_updated",
  "profile_viewed_by_admin",
  "password_changed",
  "password_reset",
  "mfa_enabled",
  "mfa_disabled",
  "device_registered",
  "device_removed",
  "account_created",
  "account_deleted",
  "account_converted_from_guest",
  "consent_granted",
  "consent_revoked",
  "admin_action",
  "login_success",
  "login_failed",
  "guest_nudge_shown",
  "guest_locked_out",
  "gdpr_purge_executed",
  "gdpr_purge_dry_run",
  "data_exported",
  "consent_denied",
  "logout",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];
