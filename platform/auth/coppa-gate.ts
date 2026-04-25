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
 *
 * GenAI Principles:
 *   P4  — Structural safety: gate runs before all processing
 *   P11 — Fail-closed: unknown consent = denied, config error = enforced
 *   P13 — Control plane: blocked features list from platform_config
 *
 * @module platform/auth
 */

import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { getConfig } from "@/platform/auth/platform-config";
import { logger } from "@/lib/logger";
import type { CoppaGateResult, ContentRatingLevel } from "@/platform/moderation/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** User COPPA state loaded from the DB */
interface UserCoppaState {
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

/**
 * Load the list of blocked features for COPPA-enforced users.
 * Fail-closed: if config unavailable, block everything (P11).
 */
async function loadBlockedFeatures(): Promise<readonly string[]> {
  const fallback = [
    "translate",
    "transcribe",
    "identify_song",
    "generate",
    "upload_file",
  ];
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
  const failClosed: UserCoppaState = {
    coppaEnforcementActive: true,
    contentRatingLevel: 1,
    parentalConsentStatus: "pending",
  };

  try {
    const supabase = getSupabaseServiceClient();
    const { data, error } = await (supabase
      .from("users" as never)
      .select("coppa_enforcement_active, content_rating_level, parental_consent_status")
      .eq("id", userId)
      .single() as unknown as Promise<{
      data: {
        coppa_enforcement_active: boolean;
        content_rating_level: number;
        parental_consent_status: string;
      } | null;
      error: { message: string } | null;
    }>);

    if (error || !data) return failClosed;

    return {
      coppaEnforcementActive: data.coppa_enforcement_active,
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

  return {
    allowed: false,
    reason:
      "Parental consent is required before using this feature. " +
      "Please ask a parent or guardian to grant consent in your account settings.",
    feature,
    contentRatingLevel: userState.contentRatingLevel,
    consentStatus: userState.parentalConsentStatus,
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
    const supabase = getSupabaseServiceClient();
    const { error } = await (supabase
      .from("users" as never)
      .update({ coppa_enforcement_active: isEnforced } as never)
      .eq("id", userId) as unknown as Promise<{
      error: { message: string } | null;
    }>);

    if (error) {
      logger.error("COPPA enforcement update failed", {
        userId,
        isEnforced,
        error: error.message,
        route: "platform/auth/coppa-gate",
      });
      return { success: false, error: error.message };
    }

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
//    Config error = everything blocked. This means a Supabase outage will
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
