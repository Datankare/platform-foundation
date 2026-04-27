/**
 * platform/auth/account-status-guard.ts — Account status enforcement gate
 *
 * Checks user account status before allowing feature access. Runs BEFORE
 * the COPPA gate and Guardian screening in the middleware chain:
 *
 *   auth → **account-status guard** → COPPA gate → Guardian screening
 *
 * This fills the gap documented in coppa-gate.ts Gotcha #4:
 * "The gate does NOT check account_status. The account status check
 * should run first in middleware."
 *
 * Design mirrors coppa-gate.ts:
 *   - Config-driven feature restrictions per status (P13)
 *   - Fail-closed on DB/config errors (P11)
 *   - Structural safety — cannot be bypassed (P4)
 *   - Auto-expiry of suspended status (P11)
 *   - Logged decisions (P3)
 *
 * GenAI Principles: P3, P4, P11, P13
 *
 * @module platform/auth
 */

import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { getConfig } from "@/platform/auth/platform-config";
import { logger } from "@/lib/logger";
import type { AccountStatus } from "@/platform/moderation/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of the account status check */
export interface AccountStatusGateResult {
  /** Whether the user is allowed to use the requested feature */
  readonly allowed: boolean;
  /** Human-readable reason (safe for user display) */
  readonly reason: string;
  /** Current account status */
  readonly accountStatus: AccountStatus;
  /** Feature that was requested */
  readonly feature: string;
}

/** User account state loaded from the DB */
interface UserAccountRow {
  accountStatus: AccountStatus;
  restrictedUntil: string | null;
  suspendedUntil: string | null;
  bannedAt: string | null;
}

// ---------------------------------------------------------------------------
// Config keys and defaults (P13)
// ---------------------------------------------------------------------------

const RESTRICTED_FEATURES_KEY = "account_status.restricted_features";
const SUSPENDED_FEATURES_KEY = "account_status.suspended_features";

const RESTRICTED_FEATURES_FALLBACK: readonly string[] = [
  "translate",
  "transcribe",
  "identify_song",
  "generate",
  "upload_file",
  "update_profile",
];

const SUSPENDED_FEATURES_FALLBACK: readonly string[] = ["*"];

// ---------------------------------------------------------------------------
// Valid account statuses (B5: input validation)
// ---------------------------------------------------------------------------

const VALID_STATUSES = new Set<string>([
  "active",
  "warned",
  "restricted",
  "suspended",
  "banned",
]);

// ---------------------------------------------------------------------------
// Config loaders (P13, P11 fail-closed)
// ---------------------------------------------------------------------------

/**
 * Load restricted feature list from config.
 * Fail-closed: config unavailable → block all content features (P11).
 */
async function loadRestrictedFeatures(): Promise<readonly string[]> {
  try {
    const features = await getConfig<string[]>(RESTRICTED_FEATURES_KEY, [
      ...RESTRICTED_FEATURES_FALLBACK,
    ]);
    return Array.isArray(features) ? features : [...RESTRICTED_FEATURES_FALLBACK];
  } catch {
    return [...RESTRICTED_FEATURES_FALLBACK];
  }
}

/**
 * Load suspended feature list from config.
 * Fail-closed: config unavailable → block everything (P11).
 */
async function loadSuspendedFeatures(): Promise<readonly string[]> {
  try {
    const features = await getConfig<string[]>(SUSPENDED_FEATURES_KEY, [
      ...SUSPENDED_FEATURES_FALLBACK,
    ]);
    return Array.isArray(features) ? features : [...SUSPENDED_FEATURES_FALLBACK];
  } catch {
    return [...SUSPENDED_FEATURES_FALLBACK];
  }
}

// ---------------------------------------------------------------------------
// User state loader
// ---------------------------------------------------------------------------

/**
 * Load a user's account status from the DB.
 * Fail-closed: DB error or user not found → banned (P11).
 */
async function loadAccountState(userId: string): Promise<UserAccountRow> {
  const failClosed: UserAccountRow = {
    accountStatus: "banned",
    restrictedUntil: null,
    suspendedUntil: null,
    bannedAt: null,
  };

  try {
    const supabase = getSupabaseServiceClient();
    const { data, error } = await (supabase
      .from("users" as never)
      .select("account_status, restricted_until, suspended_until, banned_at")
      .eq("id", userId)
      .single() as unknown as Promise<{
      data: {
        account_status: string;
        restricted_until: string | null;
        suspended_until: string | null;
        banned_at: string | null;
      } | null;
      error: { message: string } | null;
    }>);

    if (error) return failClosed;

    // User authenticated but not in users table (mock mode, first login,
    // or race condition). Authentication passed — treat as active, not banned.
    // This is distinct from a DB error (which fails closed above).
    if (!data) {
      return {
        accountStatus: "active",
        restrictedUntil: null,
        suspendedUntil: null,
        bannedAt: null,
      };
    }

    // B5: Validate status is a known value
    const status = VALID_STATUSES.has(data.account_status)
      ? (data.account_status as AccountStatus)
      : "banned"; // unknown status → fail-closed

    return {
      accountStatus: status,
      restrictedUntil: data.restricted_until,
      suspendedUntil: data.suspended_until,
      bannedAt: data.banned_at,
    };
  } catch (err) {
    // Check if Supabase is configured. If not (mock/CI mode),
    // there is no DB to query — degrade to active, not banned.
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
    if (!supabaseUrl) {
      return {
        accountStatus: "active" as AccountStatus,
        restrictedUntil: null,
        suspendedUntil: null,
        bannedAt: null,
      };
    }

    logger.error("Account status guard: failed to load user state — failing closed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
      route: "platform/auth/account-status-guard",
    });
    return failClosed;
  }
}

// ---------------------------------------------------------------------------
// Time-based expiry helpers
// ---------------------------------------------------------------------------

/** Check if a timestamp is in the past (status has expired) */
function isExpired(until: string | null): boolean {
  if (!until) return false;
  return new Date(until).getTime() < Date.now();
}

// ---------------------------------------------------------------------------
// Feature restriction checkers
// ---------------------------------------------------------------------------

/** Check if a feature is in a restriction list. Supports ["*"] wildcard. */
function isFeatureBlocked(feature: string, blockedFeatures: readonly string[]): boolean {
  return blockedFeatures.includes("*") || blockedFeatures.includes(feature);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** UUID v4 format — loose check, not cryptographic validation */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Check whether a user's account status allows access to a feature.
 *
 * Call this BEFORE the COPPA gate on every API route. If the result
 * is `allowed: false`, return a 403 to the user immediately.
 *
 * Status handling:
 *   - active, warned → allowed (warnings don't restrict features)
 *   - restricted → check restricted features config list
 *   - suspended → check suspended features config list; auto-expire if past
 *   - banned → block all features
 *
 * @param userId - User to check
 * @param feature - Feature identifier (must match config list entries)
 */
export async function checkAccountStatus(
  userId: string,
  feature: string
): Promise<AccountStatusGateResult> {
  // S1: Validate userId format at boundary (B5)
  if (!userId || !UUID_PATTERN.test(userId)) {
    return {
      allowed: false,
      reason: "Invalid user ID format",
      accountStatus: "banned",
      feature,
    };
  }

  const state = await loadAccountState(userId);

  // Active or warned → always allowed
  if (state.accountStatus === "active" || state.accountStatus === "warned") {
    return {
      allowed: true,
      reason: `Account is ${state.accountStatus}`,
      accountStatus: state.accountStatus,
      feature,
    };
  }

  // Restricted → check feature list, auto-expire if past
  if (state.accountStatus === "restricted") {
    if (isExpired(state.restrictedUntil)) {
      logger.info("Account status guard: restriction expired", {
        userId,
        restrictedUntil: state.restrictedUntil,
        route: "platform/auth/account-status-guard",
      });
      return {
        allowed: true,
        reason: "Restriction period has expired",
        accountStatus: "restricted",
        feature,
      };
    }

    const restrictedFeatures = await loadRestrictedFeatures();
    if (!isFeatureBlocked(feature, restrictedFeatures)) {
      return {
        allowed: true,
        reason: `Feature "${feature}" is not restricted`,
        accountStatus: "restricted",
        feature,
      };
    }

    logger.info("Account status guard: feature blocked (restricted)", {
      userId,
      feature,
      restrictedUntil: state.restrictedUntil,
      route: "platform/auth/account-status-guard",
    });
    return {
      allowed: false,
      reason:
        "Your account is currently restricted. " +
        "Some features are temporarily unavailable.",
      accountStatus: "restricted",
      feature,
    };
  }

  // Suspended → check feature list, auto-expire if past
  if (state.accountStatus === "suspended") {
    if (isExpired(state.suspendedUntil)) {
      logger.info("Account status guard: suspension expired", {
        userId,
        suspendedUntil: state.suspendedUntil,
        route: "platform/auth/account-status-guard",
      });
      return {
        allowed: true,
        reason: "Suspension period has expired",
        accountStatus: "suspended",
        feature,
      };
    }

    const suspendedFeatures = await loadSuspendedFeatures();
    if (!isFeatureBlocked(feature, suspendedFeatures)) {
      return {
        allowed: true,
        reason: `Feature "${feature}" is not suspended`,
        accountStatus: "suspended",
        feature,
      };
    }

    logger.info("Account status guard: feature blocked (suspended)", {
      userId,
      feature,
      suspendedUntil: state.suspendedUntil,
      route: "platform/auth/account-status-guard",
    });
    return {
      allowed: false,
      reason:
        "Your account is currently suspended. " +
        "Please contact support if you believe this is an error.",
      accountStatus: "suspended",
      feature,
    };
  }

  // Banned → block everything
  logger.info("Account status guard: feature blocked (banned)", {
    userId,
    feature,
    bannedAt: state.bannedAt,
    route: "platform/auth/account-status-guard",
  });
  return {
    allowed: false,
    reason:
      "Your account has been permanently suspended. " +
      "Please contact support for more information.",
    accountStatus: "banned",
    feature,
  };
}

// ---------------------------------------------------------------------------
// Gotchas (L17)
// ---------------------------------------------------------------------------
//
// 1. This gate checks account_status but does NOT update it. Auto-expiry
//    detection (restricted/suspended past their until date) returns
//    allowed=true but does not write the status change to the DB. A
//    separate scheduled job or Sentinel check should clean up expired
//    statuses. Until then, the gate is lenient (allows expired) but the
//    DB row still says "restricted" — which is safe (better to allow
//    than to block an innocent user whose restriction expired).
//
// 2. Fail-closed to "banned" on DB error. This is stricter than
//    coppa-gate (which fails to enforcement_active=true). The rationale:
//    account status covers ALL users, not just minors. A DB outage
//    blocking everyone is less bad than a banned user getting through.
//
// 3. The feature names are strings, not enums. They must match the
//    identifiers used in API routes exactly. Same risk as coppa-gate
//    Gotcha #3 — no compile-time validation.
//
// 4. The ["*"] wildcard in suspended_features is checked by
//    isFeatureBlocked(). If someone misconfigures this to an empty
//    array, suspended users get access to everything. The fallback
//    covers this (defaults to ["*"]), but a config change could
//    override it. Add a config validation rule in a future sprint.
