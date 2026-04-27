/**
 * platform/auth/profile-screening.ts — Profile field content screening
 *
 * Screens profile text fields (display name, real name) through the
 * Guardian agent before allowing writes to the database.
 *
 * This closes the gap where updateProfile() previously wrote directly
 * to the DB without content safety screening. ContentType "profile"
 * already exists in the moderation type system — this module wires it.
 *
 * Design mirrors coppa-gate.ts:
 *   - Config-driven screened fields list (P13)
 *   - Config-driven length limits (P13)
 *   - Fail-closed on config/DB errors (P11)
 *   - Structural safety — cannot be bypassed (P4)
 *   - Full Guardian trajectory per screening (P18)
 *   - Classifier cost tracked per field (P12)
 *
 * GenAI Principles: P3, P4, P11, P12, P13, P15 (inherited), P18 (inherited)
 *
 * @module platform/auth
 */

import { getConfig, getConfigNumber } from "@/platform/auth/platform-config";
import { screenContent } from "@/platform/moderation";
import { logger } from "@/lib/logger";
import type { ProfileUpdate } from "./profile";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of screening a profile update */
export interface ProfileScreeningResult {
  /** Whether all screened fields passed */
  readonly allowed: boolean;
  /** Fields that failed screening */
  readonly blockedFields: readonly string[];
  /** Per-field failure reasons */
  readonly reasons: Readonly<Record<string, string>>;
  /** Guardian trajectory IDs (one per screened field) */
  readonly trajectoryIds: readonly string[];
}

/** Length limit for a specific field */
interface FieldLengthLimit {
  readonly field: string;
  readonly configKey: string;
  readonly fallback: number;
}

// ---------------------------------------------------------------------------
// Config keys and defaults (P13)
// ---------------------------------------------------------------------------

const SCREENED_FIELDS_KEY = "profile.screened_fields";
const SCREENED_FIELDS_FALLBACK: readonly string[] = ["displayName", "realName"];

const LENGTH_LIMITS: readonly FieldLengthLimit[] = [
  {
    field: "displayName",
    configKey: "profile.max_display_name_length",
    fallback: 50,
  },
  {
    field: "realName",
    configKey: "profile.max_real_name_length",
    fallback: 100,
  },
];

// ---------------------------------------------------------------------------
// Config loaders (P13, P11 fail-closed)
// ---------------------------------------------------------------------------

/**
 * Load the list of fields requiring Guardian screening.
 * Fail-closed: config unavailable → screen all text fields (P11).
 */
async function loadScreenedFields(): Promise<readonly string[]> {
  try {
    const fields = await getConfig<string[]>(SCREENED_FIELDS_KEY, [
      ...SCREENED_FIELDS_FALLBACK,
    ]);
    return Array.isArray(fields) ? fields : [...SCREENED_FIELDS_FALLBACK];
  } catch {
    return [...SCREENED_FIELDS_FALLBACK];
  }
}

/**
 * Load length limit for a field from config.
 * Fail-closed: config unavailable → use strictest fallback (P11).
 */
async function loadLengthLimit(limit: FieldLengthLimit): Promise<number> {
  try {
    return await getConfigNumber(limit.configKey, limit.fallback);
  } catch {
    return limit.fallback;
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** Check if a field value exceeds its configured length limit */
async function checkLengthLimit(
  field: string,
  value: string
): Promise<{ exceeded: boolean; limit: number }> {
  const limitDef = LENGTH_LIMITS.find((l) => l.field === field);
  if (!limitDef) return { exceeded: false, limit: 0 };

  const limit = await loadLengthLimit(limitDef);
  return { exceeded: value.length > limit, limit };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** UUID v4 format — loose check, not cryptographic validation */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Screen a profile update through the Guardian before allowing the write.
 *
 * Call this BEFORE updateProfile(). If the result is `allowed: false`,
 * return a 422 to the user with the per-field reasons.
 *
 * Flow per screened field:
 *   1. Check length limit (fast, no Guardian call)
 *   2. Screen through Guardian with contentType "profile"
 *   3. Collect results — any failure blocks the entire update
 *
 * @param userId - User performing the update
 * @param update - The proposed profile changes
 * @param requestId - Request ID for trace correlation
 */
export async function screenProfileUpdate(
  userId: string,
  update: ProfileUpdate,
  requestId: string
): Promise<ProfileScreeningResult> {
  // S1: Validate userId format at boundary (B5)
  if (!userId || !UUID_PATTERN.test(userId)) {
    return {
      allowed: false,
      blockedFields: [],
      reasons: { _userId: "Invalid user ID format" },
      trajectoryIds: [],
    };
  }

  // No fields to update → trivially allowed
  const updateKeys = Object.keys(update).filter(
    (k) => update[k as keyof ProfileUpdate] !== undefined
  );
  if (updateKeys.length === 0) {
    return { allowed: true, blockedFields: [], reasons: {}, trajectoryIds: [] };
  }

  const screenedFields = await loadScreenedFields();
  const blockedFields: string[] = [];
  const reasons: Record<string, string> = {};
  const trajectoryIds: string[] = [];

  for (const field of updateKeys) {
    const value = update[field as keyof ProfileUpdate];

    // Only screen string fields that are in the screened list
    if (typeof value !== "string" || !screenedFields.includes(field)) {
      continue;
    }

    // Step 1: Length limit check (fast path, no Guardian call)
    const lengthCheck = await checkLengthLimit(field, value);
    if (lengthCheck.exceeded) {
      blockedFields.push(field);
      reasons[field] =
        `${field} exceeds maximum length of ${lengthCheck.limit} characters.`;
      continue;
    }

    // Step 2: Guardian screening (P4 — structural safety)
    try {
      const result = await screenContent(value, {
        direction: "input",
        requestId,
        context: {
          contentType: "profile",
          userId,
        },
      });

      trajectoryIds.push(result.trajectoryId);

      if (result.action === "block" || result.action === "escalate") {
        blockedFields.push(field);
        reasons[field] = result.reasoning;
      } else if (result.action === "warn") {
        // Warnings on profile fields are treated as blocks —
        // profiles are public-facing, no "soft warning" makes sense
        blockedFields.push(field);
        reasons[field] =
          `${field} contains content that is not allowed in profiles. ${result.reasoning}`;
      }
    } catch (err) {
      // P11: Guardian error → fail-closed, block the field
      logger.error("Profile screening: Guardian error — failing closed", {
        userId,
        field,
        requestId,
        error: err instanceof Error ? err.message : String(err),
        route: "platform/auth/profile-screening",
      });
      blockedFields.push(field);
      reasons[field] = "Profile update temporarily unavailable. Please try again.";
    }
  }

  if (blockedFields.length > 0) {
    logger.info("Profile screening: fields blocked", {
      userId,
      blockedFields,
      requestId,
      route: "platform/auth/profile-screening",
    });
  }

  return {
    allowed: blockedFields.length === 0,
    blockedFields,
    reasons,
    trajectoryIds,
  };
}
