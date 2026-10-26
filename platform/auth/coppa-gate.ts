/**
 * platform/auth/coppa-gate.ts — COPPA consent enforcement gate
 *
 * Checks parental consent status before allowing content-generating
 * features for users under 13. Runs BEFORE the Guardian content
 * safety screening — if consent is not granted, the request is
 * blocked without reaching the moderation pipeline.
 *
 * The gate is structural safety (P4) — it cannot be bypassed by
 * any downstream code. API routes call checkCoppaGate() as the
 * first check after authentication.
 *
 * Design:
 *   - Uses the denormalized `coppa_enforcement_active` boolean on
 *     the users table (set by coppa.ts on age verification and
 *     consent changes) for fast lookups
 *   - Blocked features list is in platform_config (coppa.blocked_features)
 *   - Master switch: coppa.enforcement_enabled (for development bypass)
 *   - The user row is read in the request's tenant (platform/data, ADR-053 D4)
 *   - An account whose age was never verified is treated as a child without consent (audit
 *     X-16): until the account's date of birth is recorded (at sign-up, or once through
 *     POST /api/account/age), every consent-gated feature is refused. Called for every signed-in
 *     user by requireActorWithStatus, after the account-status check, so no route can skip it.
 *
 * GenAI Principles:
 *   P4  — Structural safety: gate runs before all processing
 *   P11 — Fail-closed: unknown consent = denied, config error = enforced
 *   P13 — Control plane: blocked features list from platform_config
 *
 * @module platform/auth
 */

import { hasDatabase, withTenantTx } from "@/platform/data";
import { getConfig } from "@/platform/auth/platform-config";
import { logger } from "@/lib/logger";
import { unionWithModules } from "@/platform/modules/compose";
import type { CoppaGateResult, ContentRatingLevel } from "@/platform/moderation/types";
import type { ErrorCode } from "@/platform/errors/registry";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** User COPPA state loaded from the DB */
interface UserCoppaState {
  /** The account's age was recorded (users.age_verified). */
  ageVerified: boolean;
  coppaEnforcementActive: boolean;
  contentRatingLevel: ContentRatingLevel;
  parentalConsentStatus: string;
}

/** Parse a number to ContentRatingLevel with fallback to strictest */
function parseRatingLevel(n: number): ContentRatingLevel {
  if (n === 2) return 2;
  if (n === 3) return 3;
  return 1; // fail-closed to strictest
}

// ---------------------------------------------------------------------------
// Config loaders (P13)
// ---------------------------------------------------------------------------

/**
 * Check if COPPA enforcement is enabled.
 * Fail-closed: if config unavailable, enforcement IS active (P11).
 */
async function isEnforcementEnabled(): Promise<boolean> {
  try {
    const enabled = await getConfig<boolean>("coppa.enforcement_enabled", true);
    return typeof enabled === "boolean" ? enabled : true;
  } catch {
    return true;
  }
}

/** The core's content-generating features, refused to COPPA-enforced users without consent. */
export const CORE_CONSENT_FEATURES: readonly string[] = Object.freeze([
  "generate",
  "stream",
  "upload_file",
]);

/**
 * The features refused when the governed list cannot be read: the core's, then each registered
 * module's (translation: translate; voice: transcribe; song-id: identify_song — ADR-054 D4).
 */
export function consentFeatureFallback(): readonly string[] {
  return unionWithModules(
    "consent feature",
    CORE_CONSENT_FEATURES,
    (m) => m.consentFeatures
  );
}

/**
 * Load the list of blocked features for COPPA-enforced users.
 * Fail-closed: if config unavailable, block every content feature the app has (P11).
 */
async function loadBlockedFeatures(): Promise<readonly string[]> {
  const fallback = [...consentFeatureFallback()];
  try {
    const features = await getConfig<string[]>("coppa.blocked_features", fallback);
    return Array.isArray(features) ? features : fallback;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// User state loader
// ---------------------------------------------------------------------------

/**
 * Load a user's COPPA enforcement state from the DB.
 * Fail-closed: if user not found or DB error, assume enforcement active (P11).
 */
async function loadUserCoppaState(userId: string): Promise<UserCoppaState> {
  // Unknown state: enforced, and reported as consent pending (blocked either way).
  const failClosed: UserCoppaState = {
    ageVerified: true,
    coppaEnforcementActive: true,
    contentRatingLevel: 1,
    parentalConsentStatus: "pending",
  };

  try {
    const { rows } = await withTenantTx((tx) =>
      tx.query<{
        age_verified: boolean;
        coppa_enforcement_active: boolean;
        content_rating_level: number;
        parental_consent_status: string;
      }>(
        `select age_verified, coppa_enforcement_active, content_rating_level,
                parental_consent_status::text as parental_consent_status
           from users where id = $1::uuid`,
        [userId]
      )
    );
    const data = rows[0];

    if (!data) return failClosed;

    return {
      ageVerified: data.age_verified === true,
      // Unknown age is treated as a child without consent (fail closed, X-16).
      coppaEnforcementActive: data.coppa_enforcement_active || data.age_verified !== true,
      contentRatingLevel: parseRatingLevel(data.content_rating_level),
      parentalConsentStatus: data.parental_consent_status,
    };
  } catch (err) {
    logger.error("COPPA gate: failed to load user state — failing closed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
      route: "platform/auth/coppa-gate",
    });
    return failClosed;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check whether a user is allowed to use a specific feature.
 *
 * Call this BEFORE the Guardian screening on any content-generating
 * API route. If the gate returns `allowed: false`, return a 403
 * to the user immediately.
 *
 * Returns allowed: true for:
 *   - Users with coppa_enforcement_active = false (adults, consented minors)
 *   - Features not in the blocked features list
 *   - When COPPA enforcement is disabled (development only)
 *
 * Returns allowed: false for:
 *   - Under-13 users without parental consent trying to use blocked features
 *   - DB errors or unknown users (fail-closed)
 */
/** UUID v4 format — loose check, not cryptographic validation */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function checkCoppaGate(
  userId: string,
  feature: string
): Promise<CoppaGateResult> {
  // No database (mock and CI runs): there is no age to read; as the account-status guard does.
  if (!hasDatabase()) {
    return {
      allowed: true,
      reason: "No database: nothing to enforce",
      feature,
      contentRatingLevel: 1,
      consentStatus: "unknown",
    };
  }

  // S1: Validate userId format at boundary
  if (!userId || !UUID_PATTERN.test(userId)) {
    return {
      allowed: false,
      reason: "Invalid user ID format",
      feature,
      contentRatingLevel: 1,
      consentStatus: "unknown",
    };
  }

  // Check master switch
  const enabled = await isEnforcementEnabled();
  if (!enabled) {
    return {
      allowed: true,
      reason: "COPPA enforcement disabled",
      feature,
      contentRatingLevel: 3,
      consentStatus: "not_required",
    };
  }

  // Load user state
  const userState = await loadUserCoppaState(userId);

  // Not under enforcement — allow
  if (!userState.coppaEnforcementActive) {
    return {
      allowed: true,
      reason: "User is not under COPPA enforcement",
      feature,
      contentRatingLevel: userState.contentRatingLevel,
      consentStatus: userState.parentalConsentStatus,
    };
  }

  // Under enforcement — check if this feature is blocked
  const blockedFeatures = await loadBlockedFeatures();
  if (!blockedFeatures.includes(feature)) {
    return {
      allowed: true,
      reason: `Feature "${feature}" is not restricted for COPPA-enforced users`,
      feature,
      contentRatingLevel: userState.contentRatingLevel,
      consentStatus: userState.parentalConsentStatus,
    };
  }

  // Feature is blocked for this user
  logger.info("COPPA gate: blocked feature access", {
    userId,
    feature,
    contentRatingLevel: userState.contentRatingLevel,
    consentStatus: userState.parentalConsentStatus,
    route: "platform/auth/coppa-gate",
  });

  if (!userState.ageVerified) {
    return {
      allowed: false,
      reason: "Confirm your date of birth before using this feature.",
      feature,
      contentRatingLevel: userState.contentRatingLevel,
      consentStatus: "unverified",
      code: "account.age_unverified",
    };
  }
  return {
    allowed: false,
    reason:
      "Parental consent is required before using this feature. " +
      "Please ask a parent or guardian to grant consent in your account settings.",
    feature,
    contentRatingLevel: userState.contentRatingLevel,
    consentStatus: userState.parentalConsentStatus,
    code: "account.consent_required",
  };
}

/**
 * Update the COPPA enforcement flag on a user record.
 *
 * Called by coppa.ts when:
 *   - Age is verified (sets enforcement if under 13 and consent not granted)
 *   - Parental consent is granted (clears enforcement)
 *   - Parental consent is denied (sets enforcement)
 *
 * This keeps the denormalized boolean in sync with the compound condition.
 */
export async function updateCoppaEnforcement(
  userId: string,
  isEnforced: boolean
): Promise<{ success: boolean; error?: string }> {
  try {
    await withTenantTx((tx) =>
      tx.query("update users set coppa_enforcement_active = $2 where id = $1::uuid", [
        userId,
        isEnforced,
      ])
    );

    return { success: true };
  } catch (err) {
    logger.error("COPPA enforcement update error", {
      userId,
      isEnforced,
      error: err instanceof Error ? err.message : String(err),
      route: "platform/auth/coppa-gate",
    });
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

// ---------------------------------------------------------------------------
// Gotchas (L17)
// ---------------------------------------------------------------------------
//
// 1. The gate uses the denormalized coppa_enforcement_active boolean, not
//    the compound condition (content_rating_level=1 AND consent!=granted).
//    This means coppa.ts MUST call updateCoppaEnforcement() whenever age
//    verification or consent status changes. If they get out of sync,
//    the gate may allow or block incorrectly.
//
// 2. Fail-closed everywhere: unknown user = enforced. DB error = enforced.
//    Config error = everything blocked. This means a database outage will
//    block ALL under-13 users (and unknown users). This is the correct
//    safety behavior per COPPA.
//
// 3. The blocked features list uses string identifiers, not enum values.
//    These must match the feature identifiers used in API routes. There is
//    no compile-time validation — a typo in the config won't be caught.
//
// 4. The gate does NOT check account_status. A banned user with COPPA
//    enforcement would hit the consent gate before the ban check. The
//    account status check should run first in middleware. Order:
//    auth → account status → COPPA gate → Guardian screening.

// ── TASK-181: the refusals this guard can return ─────────────────────────────────────────────
// Read by __tests__/refusal-coverage.test.ts: each route that calls a guard named here can
// return its codes, and every screen calling that route must handle each one. The test also
// checks this module's own apiError literals are all listed.

/** What the age and consent gate can refuse with (COPPA, audit X-16). */
export const COPPA_REFUSAL_CODES = [
  "account.age_unverified",
  "account.consent_required",
] as const satisfies readonly ErrorCode[];

export const REFUSAL_GUARDS: Readonly<Record<string, readonly ErrorCode[]>> = {
  checkCoppaGate: COPPA_REFUSAL_CODES,
};
