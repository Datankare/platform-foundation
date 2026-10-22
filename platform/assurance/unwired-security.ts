/**
 * platform/assurance/unwired-security.ts — Security code that exists but no production path calls
 *
 * CONSUMER-OWNED (like platform/route-policy/app-route-policy.ts). platform-foundation ships its
 * own register; an app that consumes it keeps its own copy — its routes may wire controls the
 * platform leaves to apps — and lists this path in its sync exclude list.
 *
 * The October 2026 audit found the most common failure was not a broken control but a control
 * built, tested and never called (age consent, GDPR purge handlers, durable strike stores…).
 * `__tests__/security-wiring.test.ts` finds every security control (by name, in the security
 * modules) and fails when one has no production caller and is not listed here — and when a
 * listed one gains a caller, so the register never claims a gap that has closed.
 *
 * Key: "<file>#<export>". Value: why it is unwired, and the finding or task that wires it.
 *
 * @module platform/assurance
 */

export const UNWIRED_SECURITY: Readonly<Record<string, string>> = {
  "platform/auth/gdpr-deletion.ts#softDeleteUser":
    "No erasure route yet; erasure is an admin purge only. Audit X-15 (Wave 2).",
  "platform/auth/gdpr-deletion.ts#hardPurgeUser":
    "No erasure route yet. Audit X-15 (Wave 2).",
  "platform/auth/gdpr-deletion.ts#registerDeletionModule":
    "Extension point: each app registers a deletion module per table it owns; none is registered yet, which is why a purge deletes nothing (and now reports failed). Audit X-15 (Wave 2).",
  "platform/auth/data-export.ts#registerExportModule":
    "Extension point for apps; no export route or module yet. Audit X-15 (Wave 2).",
  "platform/auth/entitlements.ts#grantEntitlement":
    "No path grants an entitlement to a user yet; admins can only switch groups on and off. Audit B-17.",
  "platform/auth/entitlements.ts#revokeEntitlement": "As grantEntitlement. Audit B-17.",
  "platform/auth/coppa-gate.ts#checkCoppaGate":
    "Age-consent gate never called; date of birth is not collected at sign-up. Audit X-16 (Wave 2).",
  "platform/auth/coppa.ts#recordAgeVerification":
    "Called only by the unwired gate. Audit X-16 (Wave 2).",
  "platform/auth/coppa.ts#recordParentalConsent":
    "Called only by the unwired gate. Audit X-16 (Wave 2).",
  "platform/auth/consent.ts#grantConsent":
    "No consent route in the platform; apps call it from their own consent screens. Audit X-16 (Wave 2).",
  "platform/auth/consent.ts#revokeConsent": "As grantConsent. Audit X-16 (Wave 2).",
  "platform/auth/devices.ts#registerDevice":
    "Device tracking is not called at sign-in. Audit A-2 / X-17 (Wave 2).",
  "platform/auth/middleware.ts#requirePermission":
    "A per-permission guard offered to apps; the platform's own routes use requireAdmin (admin) and requireActorWithStatus (users), which also check account standing.",
  "platform/auth/profile-screening.ts#screenProfileUpdate":
    "The platform has no profile route; apps call it from theirs (Playform /api/profile). Audit D-11.",
  "platform/auth/password-policy.ts#validatePasswordEnhanced":
    "Legacy API with a strength score; sign-up uses passwordRuleViolations, which applies the same rules including the breached-password list.",
  "platform/moderation/screen-modality.ts#setModalityClassifiers":
    "Multimodal classifiers (including the CSAM hard refusal) run on allow-all stubs until an app sets real ones. Audit X-18 (Wave 2).",
  "platform/ai/provenance.ts#verifyProvenance":
    "Provenance is emitted, never verified; the signature is unkeyed. Audit X-18 (Wave 2).",
  "platform/agents/workflow-loop.ts#registerWorkflow":
    "No workflow is registered in production, so workflow-loop governance never runs there. Audit C (Wave 2).",
  "lib/sanitize.ts#sanitizeForLog":
    "Superseded by the logger's own redaction (lib/logger.ts redact, Sprint 7X); kept for apps that build log lines by hand.",
};
