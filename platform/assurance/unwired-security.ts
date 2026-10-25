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
  "platform/auth/gdpr-deletion.ts#registerDeletionModule":
    "Extension point: an app registers a deletion module for each table it owns. The platform's own tables are erased by its register (platform/auth/user-data.ts), so a purge no longer depends on one (audit X-15).",
  "platform/auth/data-export.ts#registerExportModule":
    "Extension point: an app registers an export module for each table it owns; the platform's tables are exported from its register (audit X-15).",
  "platform/auth/entitlements.ts#grantEntitlement":
    "No path grants an entitlement to a user yet; admins can only switch groups on and off. Audit B-17. The role rules are its own (RR-17), so a future caller cannot skip them.",
  "platform/auth/entitlements.ts#revokeEntitlement": "As grantEntitlement. Audit B-17.",
  "platform/auth/coppa.ts#recordParentalConsent":
    "Verifying a parent is the app's (a COPPA-compliant method: signed form, card check, video call); the platform records the outcome and the consent gate (wired in requireActorWithStatus, X-16) holds a child's account until it is granted.",
  "platform/auth/consent.ts#grantConsent":
    "No consent route in the platform; apps call it from their own consent screens (what is consented to is the app's vocabulary). Audit X-16.",
  "platform/auth/consent.ts#revokeConsent": "As grantConsent. Audit X-16.",
  "platform/auth/devices.ts#registerDevice":
    "Device tracking is not called at sign-in. Audit A-2 / X-17 (Wave 2).",
  "platform/auth/profile-screening.ts#screenProfileUpdate":
    "The platform has no profile route; apps call it from theirs (Playform /api/profile). Audit D-11.",
  "platform/auth/password-policy.ts#validatePasswordEnhanced":
    "Legacy API with a strength score; sign-up uses passwordRuleViolations, which applies the same rules including the breached-password list.",
  "platform/moderation/screen-modality.ts#setModalityClassifiers":
    "Extension point: an app sets its vision and audio classifiers (including the CSAM hard refusal). Until it does, every image and audio item is withheld — the defaults escalate, they no longer allow (audit X-18).",
  "platform/agents/workflow-loop.ts#registerWorkflow":
    "No workflow is registered in production, so workflow-loop governance never runs there. Audit C (Wave 2).",
  "platform/agents/governed-agent-config.ts#evaluateGovernedCapability":
    "The consumer contract for agent.capability_features (review 12 H1, review 13 P): the platform governs the map but no platform route evaluates it — the app that maps capabilities to its features does (Playform lib/agent-capabilities.ts), with this decision (the map read fail closed, then evaluateCapabilityFeatures) or its own, proved by __tests__/contract/capability-features-contract.ts.",
  "platform/agents/capability-features.ts#requiredFeatures":
    "As evaluateGovernedCapability.",
  "lib/sanitize.ts#sanitizeForLog":
    "Superseded by the logger's own redaction (lib/logger.ts redact, Sprint 7X); kept for apps that build log lines by hand.",
};
