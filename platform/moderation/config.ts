/**
 * platform/moderation/config.ts — Moderation configuration
 *
 * All moderation thresholds are configuration items in the platform_config
 * table. This module reads them via getConfig() (60s cache).
 *
 * DESIGN PRINCIPLE: No hardcoded threshold values in code.
 * - Intended defaults live ONLY in migration 010 seed data
 * - Fail-closed fallbacks here are the STRICTEST possible values
 * - If DB is unavailable, the system blocks aggressively — better safe than sorry
 * - Admins change thresholds via the platform_config table
 *
 * P11: Fail-closed — if config is unavailable, use maximum strictness
 * P13: Control plane — admin-configurable thresholds
 */

import { getConfig } from "@/platform/auth/platform-config";
import type { ContentRatingLevel, ContentRatingThresholds, ContentType } from "./types";
import type { SafetySeverity } from "@/prompts/safety/classify-v1";

// ---------------------------------------------------------------------------
// Config key constants — all prefixed with "moderation."
// ---------------------------------------------------------------------------

/** Config key prefix for all moderation settings */
const PREFIX = "moderation";

/** Build a config key */
function key(path: string): string {
  return `${PREFIX}.${path}`;
}

// ---------------------------------------------------------------------------
// WARNING: FAIL-CLOSED DEFAULTS — MAXIMUM RESTRICTION
//
// These values are NOT the intended operating defaults.
// The intended defaults live ONLY in the database (migration 010 seed data).
//
// These values activate ONLY when the database is unreachable.
// They are intentionally the STRICTEST possible — blocking everything
// at the lowest severity threshold. This is by design: if we cannot
// read configuration, we protect users by blocking aggressively
// rather than allowing potentially harmful content through.
//
// DO NOT change these to match the intended defaults. That would
// defeat the fail-closed principle. If these values are being used,
// the database connection needs fixing, not these constants.
// ---------------------------------------------------------------------------

const FAIL_CLOSED_SEVERITY: SafetySeverity = "low";
const FAIL_CLOSED_ESCALATE = 0.95;
const FAIL_CLOSED_SEVERITY_REDUCTION = 0;
const FAIL_CLOSED_STRIKE_THRESHOLD = 1;

// ---------------------------------------------------------------------------
// Severity parsing
// ---------------------------------------------------------------------------

const VALID_SEVERITIES = new Set<string>(["low", "medium", "high", "critical"]);

function parseSeverity(value: unknown, failClosed: SafetySeverity): SafetySeverity {
  if (typeof value === "string" && VALID_SEVERITIES.has(value)) {
    return value as SafetySeverity;
  }
  return failClosed;
}

// ---------------------------------------------------------------------------
// Content rating threshold loading
// ---------------------------------------------------------------------------

/**
 * Load content rating thresholds from platform_config.
 * Returns the STRICTEST possible thresholds if config is unavailable.
 */
export async function loadContentRatingThresholds(
  level: ContentRatingLevel
): Promise<ContentRatingThresholds> {
  const labels: Record<ContentRatingLevel, string> = {
    1: "child (under 13)",
    2: "teen (13–17)",
    3: "adult (18+)",
  };

  const blockSeverity = parseSeverity(
    await getConfig(key(`level${level}.block_severity`), FAIL_CLOSED_SEVERITY),
    FAIL_CLOSED_SEVERITY
  );

  const warnSeverity = parseSeverity(
    await getConfig(key(`level${level}.warn_severity`), FAIL_CLOSED_SEVERITY),
    FAIL_CLOSED_SEVERITY
  );

  const escalateBelow = await getConfig<number>(
    key(`level${level}.escalate_below`),
    FAIL_CLOSED_ESCALATE
  );

  return {
    level,
    label: labels[level] ?? labels[1],
    blockSeverity,
    warnSeverity,
    escalateBelow:
      typeof escalateBelow === "number" ? escalateBelow : FAIL_CLOSED_ESCALATE,
  };
}

// ---------------------------------------------------------------------------
// Content type severity adjustment
// ---------------------------------------------------------------------------

/**
 * Load the severity reduction for a given content type.
 * Translation, transcription, and extraction get reduced severity
 * because the user is processing existing content, not generating harmful content.
 *
 * Returns 0 (no reduction) if config is unavailable (fail-closed).
 */
export async function loadSeverityReduction(contentType: ContentType): Promise<number> {
  // Only certain content types get severity reduction
  const reductionTypes: ContentType[] = ["translation", "transcription", "extraction"];

  if (!reductionTypes.includes(contentType)) {
    return 0;
  }

  const reduction = await getConfig<number>(
    key(`${contentType}_severity_reduction`),
    FAIL_CLOSED_SEVERITY_REDUCTION
  );

  return typeof reduction === "number" ? Math.max(0, Math.min(reduction, 3)) : 0;
}

// ---------------------------------------------------------------------------
// Strike thresholds
// ---------------------------------------------------------------------------

export interface StrikeThresholds {
  /** Strikes before warning */
  readonly warnAt: number;
  /** Strikes before suspension */
  readonly suspendAt: number;
  /** Strikes before permanent ban */
  readonly banAt: number;
}

/**
 * Load strike consequence thresholds from platform_config.
 * Returns the STRICTEST possible thresholds (warn on 1st strike)
 * if config is unavailable.
 */
export async function loadStrikeThresholds(): Promise<StrikeThresholds> {
  const warnAt = await getConfig<number>(
    key("strike_warn_threshold"),
    FAIL_CLOSED_STRIKE_THRESHOLD
  );
  const suspendAt = await getConfig<number>(
    key("strike_suspend_threshold"),
    FAIL_CLOSED_STRIKE_THRESHOLD
  );
  const banAt = await getConfig<number>(
    key("strike_ban_threshold"),
    FAIL_CLOSED_STRIKE_THRESHOLD
  );

  return {
    warnAt: typeof warnAt === "number" ? warnAt : FAIL_CLOSED_STRIKE_THRESHOLD,
    suspendAt: typeof suspendAt === "number" ? suspendAt : FAIL_CLOSED_STRIKE_THRESHOLD,
    banAt: typeof banAt === "number" ? banAt : FAIL_CLOSED_STRIKE_THRESHOLD,
  };
}

// ---------------------------------------------------------------------------
// Blocklist-only surfaces
// ---------------------------------------------------------------------------

/**
 * Load the list of surfaces that should use blocklist-only mode
 * (skip classifier for latency-critical paths).
 */
export async function loadBlocklistOnlySurfaces(): Promise<readonly ContentType[]> {
  const surfaces = await getConfig<ContentType[]>(key("blocklist_only_surfaces"), []);
  return Array.isArray(surfaces) ? surfaces : [];
}
