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
 * Whether `update` holds any field Guardian screens — the only part of a profile update that makes
 * a paid classifier call. A route counts its paid-request quota only then (PF v5.1.0).
 */
export async function profileUpdateNeedsScreening(
  update: ProfileUpdate
): Promise<boolean> {
  const screened = await loadScreenedFields();
  return Object.entries(update).some(
    ([field, value]) => typeof value === "string" && screened.includes(field)
  );
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

const VISIBILITY = new Set(["private", "friends", "public"]);
const VISIBILITY_FIELDS = new Set([
  "profileVisibility",
  "displayNameVisibility",
  "avatarVisibility",
  "languageVisibility",
  "timezoneVisibility",
]);
const BOOLEAN_FIELDS = new Set(["emailOptIn", "pushNotificationsEnabled"]);
const TEXT_FIELDS = new Set(["displayName", "realName", "avatarUrl"]);
const KNOWN_FIELDS = new Set([
  ...VISIBILITY_FIELDS,
  ...BOOLEAN_FIELDS,
  ...TEXT_FIELDS,
  "languagePreference",
  "timezone",
]);
/** Longest avatar address accepted. */
export const MAX_AVATAR_URL_LENGTH = 2048;

/**
 * Why an avatar address is refused, or undefined when it is acceptable (audit D-11). Before: any
 * value was stored and shown to every viewer — `javascript:` and `data:` addresses, plain http,
 * addresses with credentials in them, and addresses of internal hosts. The image itself is the
 * app's to screen when it is uploaded (screenModality withholds every image until classifiers are
 * configured).
 */
export function avatarUrlRefusal(value: string): string | undefined {
  if (value.length > MAX_AVATAR_URL_LENGTH) {
    return `avatarUrl exceeds maximum length of ${MAX_AVATAR_URL_LENGTH} characters.`;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "avatarUrl must be an https address.";
  }
  if (url.protocol !== "https:") return "avatarUrl must be an https address.";
  if (url.username || url.password) return "avatarUrl must not contain credentials.";
  const host = url.hostname.toLowerCase();
  if (
    !host.includes(".") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".localhost") ||
    /^[\d.]+$/.test(host) ||
    host.startsWith("[")
  ) {
    return "avatarUrl must name a public host.";
  }
  if (url.port && url.port !== "443") return "avatarUrl must use the standard port.";
  return undefined;
}

/**
 * Why a non-text profile field's value is refused, or undefined (audit D-11): a visibility is
 * one of its three values, a flag is a boolean, a language and a time zone are short codes.
 * Before: such values went to the database as given, and a wrong one failed there.
 */
function shapeRefusal(field: string, value: unknown): string | undefined {
  if (!KNOWN_FIELDS.has(field)) return `${field} is not a profile field.`;
  if (VISIBILITY_FIELDS.has(field)) {
    return typeof value === "string" && VISIBILITY.has(value)
      ? undefined
      : `${field} must be private, friends or public.`;
  }
  if (BOOLEAN_FIELDS.has(field)) {
    return typeof value === "boolean" ? undefined : `${field} must be true or false.`;
  }
  if (field === "languagePreference") {
    return typeof value === "string" && /^[a-z]{2,3}(?:-[a-z\d]{2,8}){0,2}$/i.test(value)
      ? undefined
      : "languagePreference must be a language code.";
  }
  if (field === "timezone") {
    return typeof value === "string" &&
      /^[a-z][\w+-]*(?:\/[\w+-]+){0,2}$/i.test(value) &&
      value.length <= 64
      ? undefined
      : "timezone must be a time zone name.";
  }
  if (TEXT_FIELDS.has(field)) {
    if (value === null) return undefined;
    if (typeof value !== "string") return `${field} must be text.`;
    if (field === "avatarUrl" && value !== "") return avatarUrlRefusal(value);
  }
  return undefined;
}

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

    const refusal = shapeRefusal(field, value);
    if (refusal) {
      blockedFields.push(field);
      reasons[field] = refusal;
      continue;
    }
    if (!screenedFields.includes(field)) continue;
    // A screened field holds text, or null to clear it. Anything else (an array, an object, a
    // number) would be stored unscreened — refuse it rather than skip it (Playform v0.8.0
    // release review: `{"displayName": ["…"]}` reached the database without Guardian).
    if (value === null) continue;
    if (typeof value !== "string") {
      blockedFields.push(field);
      reasons[field] = `${field} must be text.`;
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
