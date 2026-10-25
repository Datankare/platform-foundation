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
 * The user row and per-account restrictions are read in the request's tenant (platform/data,
 * ADR-053 D4).
 *
 * GenAI Principles: P3, P4, P11, P13
 *
 * @module platform/auth
 */

import { hasDatabase, withTenantTx } from "@/platform/data";
import { AuditWriteError, audited } from "@/platform/auth/audit";
import { getConfig } from "@/platform/auth/platform-config";
import { getSingleton, setSingleton } from "@/platform/kernel";
import { logger } from "@/lib/logger";
import { unionWithModules } from "@/platform/modules/compose";
import type { AccountStatus } from "@/platform/moderation/types";
import {
  ensureUserProvisioned,
  type ProvisioningProfile,
} from "@/platform/auth/user-provisioning";

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
  /**
   * Set when the user's platform row does not exist and could not be created (TASK-117). The
   * request is refused, but the account is not banned — callers report this code
   * (`account.not_provisioned`), not the status.
   */
  readonly code?: "account.not_provisioned" | "account.not_found";
}

/** User account state loaded from the DB */
interface UserAccountRow {
  accountStatus: AccountStatus;
  /** No row, and provisioning it failed (TASK-117). accountStatus is the fail-closed value. */
  notProvisioned?: true;
  /**
   * The account was erased (soft-deleted, or purged): it has no access, whatever its status
   * said (audit A-11). accountStatus is the fail-closed value.
   */
  deleted?: true;
  restrictedUntil: string | null;
  suspendedUntil: string | null;
  bannedAt: string | null;
}

// ---------------------------------------------------------------------------
// Config keys and defaults (P13)
// ---------------------------------------------------------------------------

const RESTRICTED_FEATURES_KEY = "account_status.restricted_features";
const SUSPENDED_FEATURES_KEY = "account_status.suspended_features";

/** The core's features a restricted account is refused (content features and profile edits). */
export const CORE_RESTRICTED_FEATURES: readonly string[] = Object.freeze([
  "generate",
  "upload_file",
  "update_profile",
]);

/**
 * The features refused to a restricted account when the governed list cannot be read: the
 * core's, then each registered module's (ADR-054 D4).
 */
export function restrictedFeatureFallback(): readonly string[] {
  return unionWithModules(
    "account-status feature",
    CORE_RESTRICTED_FEATURES,
    (m) => m.accountStatusFeatures
  );
}

const SUSPENDED_FEATURES_FALLBACK: readonly string[] = ["*"];

// ── Known-feature governance (Sprint 3c B-gov) ──────────────────────────────
//
// The canonical set of features that EXIST is governed via the
// account_status.known_features config entry. checkAccountStatus fails closed on
// a feature absent from that set (an unknown feature is a bug or a probe, not an
// allow). This is generic mechanism: PF ships NO feature list of its own — a bare
// PF deployment registers no fallback and, with no config seeded, behaves as
// before (config governs; a total config outage allows, logged).
//
// A consumer (e.g. Playform) that wants fail-closed to survive a config outage
// registers its authoritative feature set via setKnownFeaturesFallback(); it is
// then consulted when config is unavailable. The list lives with the consumer
// that owns those feature strings, never in PF.
const KNOWN_FEATURES_KEY = "account_status.known_features";
const KNOWN_FEATURES_FALLBACK_SINGLETON = "platform.auth.knownFeaturesFallback";

/**
 * Register the authoritative feature set for this deployment. Consulted by
 * checkAccountStatus only when the known_features config cannot be read, so
 * fail-closed enforcement survives a config outage. PF registers nothing; a
 * consumer that owns the feature vocabulary registers it at startup.
 */
export function setKnownFeaturesFallback(features: readonly string[]): void {
  setSingleton(KNOWN_FEATURES_FALLBACK_SINGLETON, [...features]);
}

function getKnownFeaturesFallback(): readonly string[] | null {
  const registered = getSingleton<readonly string[] | null>(
    KNOWN_FEATURES_FALLBACK_SINGLETON,
    () => null
  );
  // An empty set is treated as "no known set registered" — do not fail closed on it.
  return registered && registered.length > 0 ? registered : null;
}

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
  const fallback = restrictedFeatureFallback();
  try {
    const features = await getConfig<string[]>(RESTRICTED_FEATURES_KEY, [...fallback]);
    return Array.isArray(features) ? features : [...fallback];
  } catch {
    return [...fallback];
  }
}

/**
 * Load suspended feature list from config.
 * Fail-closed: config unavailable → block everything (P11).
 */
/**
 * The governed known-feature set: the config list if present, else the registered
 * fallback, else null. null means no set is known — checkAccountStatus then does
 * NOT fail closed (PF standalone, or a genuine config outage with no fallback
 * registered), preserving the prior allow-unknown behavior rather than denying
 * every feature.
 */
async function loadKnownFeatures(): Promise<readonly string[] | null> {
  try {
    const features = await getConfig<string[] | undefined>(KNOWN_FEATURES_KEY, undefined);
    if (Array.isArray(features) && features.length > 0) return features;
  } catch {
    // fall through to the registered fallback
  }
  return getKnownFeaturesFallback();
}

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

interface AccountRow {
  deleted: boolean;
  account_status: string;
  restricted_until: string | null;
  suspended_until: string | null;
  banned_at: string | null;
}

const isoOrNull = (v: Date | null): string | null => (v ? v.toISOString() : null);

/** The user's status row in the current tenant, or null. Throws when it cannot be read. */
async function readAccountRow(userId: string): Promise<AccountRow | null> {
  const { rows } = await withTenantTx((tx) =>
    tx.query<{
      deleted: boolean;
      account_status: string;
      restricted_until: Date | null;
      suspended_until: Date | null;
      banned_at: Date | null;
    }>(
      `select deleted_at is not null as deleted, account_status::text as account_status,
              restricted_until, suspended_until, banned_at
         from users where id = $1::uuid`,
      [userId]
    )
  );
  const row = rows[0];
  if (!row) return null;
  return {
    deleted: row.deleted === true,
    account_status: row.account_status,
    restricted_until: isoOrNull(row.restricted_until),
    suspended_until: isoOrNull(row.suspended_until),
    banned_at: isoOrNull(row.banned_at),
  };
}

/**
 * Load a user's account status from the DB.
 * Fail-closed: a DB error → banned (P11). No row → the user is provisioned with defaults and
 * the row is read again (TASK-117); if that fails, the request is refused as not provisioned.
 */
async function loadAccountState(
  userId: string,
  profile: ProvisioningProfile = {}
): Promise<UserAccountRow> {
  const failClosed: UserAccountRow = {
    accountStatus: "banned",
    restrictedUntil: null,
    suspendedUntil: null,
    bannedAt: null,
  };

  try {
    let data = await readAccountRow(userId);

    // First use of a new account: create its row, then read what was stored (TASK-117).
    if (!data) {
      const outcome = await ensureUserProvisioned(userId, profile);
      if (outcome === "skipped") {
        // No database configured (mock/CI) — nothing to load; authentication passed.
        return {
          accountStatus: "active",
          restrictedUntil: null,
          suspendedUntil: null,
          bannedAt: null,
        };
      }
      if (outcome === "failed") return { ...failClosed, notProvisioned: true };
      if (outcome === "erased") return { ...failClosed, deleted: true };
      try {
        data = await readAccountRow(userId);
      } catch {
        data = null;
      }
      if (!data) return { ...failClosed, notProvisioned: true };
    }

    // An erased account keeps its row until the purge; it has no access meanwhile (A-11).
    if (data.deleted) return { ...failClosed, deleted: true };

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
    // No database configured (mock/CI mode): there is no DB to query — degrade to active,
    // not banned.
    if (!hasDatabase()) {
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
// ---------------------------------------------------------------------------
// Per-account feature restrictions (Sprint 3c F1, ADR-034)
// ---------------------------------------------------------------------------
//
// A per-account, per-feature block that is ORTHOGONAL to account status: a
// specific user barred from a specific feature regardless of standing (active,
// warned, restricted, suspended). Stored in user_feature_restrictions and checked
// before account state is loaded, so it applies for any status and takes
// precedence over the status path.
//
// Fail-closed (ADR-034): a DB error while reading the block-list DENIES the
// request under evaluation — the block status is unknowable, and a security
// control must hold under stress. Consistent with loadAccountState. As there, a
// deployment with no database configured (mock/CI) is NOT a DB error: it degrades
// to "no blocks", not a deny.

/** Sentinel returned when the per-account block-list cannot be read (fail-closed). */
const RESTRICTION_LOAD_FAILED = Symbol("restriction_load_failed");

/**
 * Load the set of features blocked for this specific user. Returns the feature
 * array on success (possibly empty), or RESTRICTION_LOAD_FAILED on a DB error so
 * the caller can fail closed. A deployment with no database configured returns an
 * empty set (mock/CI — no blocks), mirroring loadAccountState.
 */
async function loadUserFeatureRestrictions(
  userId: string
): Promise<readonly string[] | typeof RESTRICTION_LOAD_FAILED> {
  try {
    const { rows } = await withTenantTx((tx) =>
      tx.query<{ feature: string }>(
        "select feature from user_feature_restrictions where user_id = $1::uuid",
        [userId]
      )
    );
    return rows.map((row) => row.feature);
  } catch (err) {
    // No database configured (mock/CI) is not a DB error — degrade to "no blocks".
    if (!hasDatabase()) return [];
    logger.error(
      "Account status guard: per-account restriction load threw — failing closed",
      {
        userId,
        error: err instanceof Error ? err.message : String(err),
        route: "platform/auth/account-status-guard",
      }
    );
    return RESTRICTION_LOAD_FAILED;
  }
}

export async function checkAccountStatus(
  userId: string,
  feature: string,
  profile: ProvisioningProfile = {}
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

  // Fail closed on an unknown feature when a known set is available (Sprint 3c B-gov).
  // If no set is known (null), do not deny — PF standalone / config outage with no
  // registered fallback keeps the prior allow-unknown behavior.
  const knownFeatures = await loadKnownFeatures();
  if (knownFeatures !== null && !knownFeatures.includes(feature)) {
    logger.info("Account status guard: unknown feature denied (fail-closed)", {
      userId,
      feature,
      route: "platform/auth/account-status-guard",
    });
    return {
      allowed: false,
      reason: `Unknown feature "${feature}".`,
      accountStatus: "banned",
      feature,
    };
  }

  // Per-account feature block (Sprint 3c F1, ADR-034) — orthogonal to status, so it is
  // checked before account state is loaded and applies for any status. Fail-closed: a load
  // error denies the request (the block status is unknowable).
  const perAccountBlocks = await loadUserFeatureRestrictions(userId);
  if (perAccountBlocks === RESTRICTION_LOAD_FAILED) {
    return {
      allowed: false,
      reason: "Feature availability could not be verified. Please try again.",
      accountStatus: "banned",
      feature,
    };
  }
  if (isFeatureBlocked(feature, perAccountBlocks)) {
    logger.info("Account status guard: feature blocked (per-account restriction)", {
      userId,
      feature,
      route: "platform/auth/account-status-guard",
    });
    // Report the user's ACTUAL status in the result, not a synthetic one — load it for the
    // message. The block denies regardless of what that status is.
    const actual = await loadAccountState(userId, profile);
    return {
      allowed: false,
      reason: `Feature "${feature}" is not available on this account.`,
      accountStatus: actual.accountStatus,
      feature,
    };
  }

  const state = await loadAccountState(userId, profile);

  if (state.notProvisioned) {
    return {
      allowed: false,
      reason: "Your account is still being set up. Try again in a moment.",
      accountStatus: state.accountStatus,
      feature,
      code: "account.not_provisioned",
    };
  }
  if (state.deleted) {
    return {
      allowed: false,
      reason: "This account has been deleted.",
      accountStatus: state.accountStatus,
      feature,
      code: "account.not_found",
    };
  }

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
// Lapsed restrictions and suspensions
// ---------------------------------------------------------------------------

/** What one expiry run did. */
export interface LapsedStatusRunResult {
  /** Accounts whose restriction or suspension end date had passed (at most the run's limit). */
  readonly lapsed: number;
  /** Stepped down to warned. */
  readonly expired: number;
  /** Not changed: the record could not be written, or the account changed meanwhile. */
  readonly skipped: number;
  /** The run was told to stop (its signal) before every lapsed account was handled. */
  readonly stopped: boolean;
}

/**
 * Step every restricted or suspended account of the current tenant whose end date has passed
 * down to "warned", at most `limit` per run. Warned, not active: the account keeps the record
 * that a consequence was applied (the strike ladder reads strikes, not this status), and a
 * warned account has every feature an expired restriction already allowed. Each change is
 * recorded first (by `agent`); a change whose record cannot be written is skipped and retried
 * on the next run. The update re-checks the status and date, so an account a moderator acted
 * on meanwhile is left as they set it.
 *
 * @scheduled accounts.expire-restrictions
 */
export async function expireLapsedAccountStatuses(
  agent: string,
  limit = 500,
  signal?: AbortSignal
): Promise<LapsedStatusRunResult> {
  const { rows } = await withTenantTx((tx) =>
    tx.query<{ id: string; account_status: string; until: Date }>(
      `select id, account_status::text as account_status,
              case when account_status = 'restricted' then restricted_until
                   else suspended_until end as until
         from users
        where (account_status = 'restricted' and restricted_until < now())
           or (account_status = 'suspended' and suspended_until < now())
        order by id
        limit $1::int`,
      [limit]
    )
  );
  let expired = 0;
  let skipped = 0;
  let stopped = false;
  for (const row of rows) {
    // Told to stop: between accounts; the rest are still lapsed and the next part takes them.
    if (signal?.aborted) {
      stopped = true;
      break;
    }
    try {
      const changed = await audited(
        {
          action: "admin_action",
          agent,
          targetId: row.id,
          details: {
            type: "account_status_lapsed",
            from: row.account_status,
            to: "warned",
            until:
              row.until instanceof Date ? row.until.toISOString() : String(row.until),
          },
        },
        () =>
          withTenantTx(async (tx) => {
            const r = await tx.query(
              `update users
                  set account_status = 'warned', restricted_until = null, suspended_until = null,
                      status_changed_by = $2, status_changed_at = now(), updated_at = now()
                where id = $1::uuid
                  and ((account_status = 'restricted' and restricted_until < now())
                    or (account_status = 'suspended' and suspended_until < now()))`,
              [row.id, agent]
            );
            return r.rowCount === 1;
          })
      );
      if (changed) expired++;
      else skipped++;
    } catch (err) {
      if (!(err instanceof AuditWriteError)) throw err;
      skipped++;
    }
  }
  return { lapsed: rows.length, expired, skipped, stopped };
}

// ---------------------------------------------------------------------------
// Gotchas (L17)
// ---------------------------------------------------------------------------
//
// 1. This gate checks account_status but does NOT update it. Auto-expiry
//    detection (restricted/suspended past their until date) returns
//    allowed=true without writing; the stored status is stepped down to
//    "warned" by expireLapsedAccountStatuses (the accounts.expire-restrictions
//    job). Between the end date and that run the gate is lenient (allows
//    expired) while the row still says "restricted" — which is safe (better
//    to allow than to block an innocent user whose restriction expired).
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

// ---------------------------------------------------------------------------
// Staff standing (TASK-145, audit X-6)
// ---------------------------------------------------------------------------

/**
 * Whether a staff member may exercise privileged powers right now: an account that is active or
 * merely warned, or whose restriction or suspension has expired. A restricted, suspended or banned
 * account — or one whose state cannot be read — may not administer, moderate or approve anything.
 * Fails closed: an unreadable state is "banned" (loadAccountState).
 */
export async function isInGoodStanding(userId: string): Promise<boolean> {
  if (!userId || !UUID_PATTERN.test(userId)) return false;
  const state = await loadAccountState(userId);
  if (state.notProvisioned || state.deleted) return false;
  switch (state.accountStatus) {
    case "active":
    case "warned":
      return true;
    case "restricted":
      return isExpired(state.restrictedUntil);
    case "suspended":
      return isExpired(state.suspendedUntil);
    default:
      return false;
  }
}
