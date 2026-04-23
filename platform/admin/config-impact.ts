/**
 * platform/admin/config-impact.ts — Impact correlation queries
 *
 * Joins platform_config_history with content_safety_audit to answer:
 * "After you changed X, what happened to moderation outcomes?"
 *
 * Example: "After you changed moderation.level2.block_severity from
 * 'medium' to 'high', the block rate for Level 2 users dropped from
 * 12% to 4%."
 *
 * Only produces meaningful reports for moderation-category config keys.
 * Non-moderation config changes return a "no impact data available" report.
 *
 * GenAI Principles:
 *   P3  — Total observability: correlates config changes with outcomes
 *   P12 — Economic transparency: no LLM calls, pure SQL aggregation
 *   P13 — Control plane: informs admin decisions with data
 *   P14 — Feedback loops: config change → outcome → adjustment cycle
 *
 * @module platform/admin
 */

import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import type {
  ConfigHistoryRecord,
  ConfigImpactReport,
  ConfigImpactMetrics,
} from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default window for "before" comparison: how far back before the change
 * to look for baseline metrics. 7 days.
 */
const DEFAULT_BEFORE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Minimum screenings required in each period for a meaningful comparison.
 * Below this, the report notes insufficient data.
 */
const MIN_SCREENINGS_FOR_COMPARISON = 10;

// ---------------------------------------------------------------------------
// Metrics aggregation
// ---------------------------------------------------------------------------

/** DB row shape from the aggregation query */

/**
 * Query content_safety_audit for action counts within a time window.
 * Optionally filtered by content_rating_level.
 */
async function queryAuditMetrics(
  since: string,
  before: string,
  contentRatingLevel?: number
): Promise<ConfigImpactMetrics> {
  try {
    const supabase = getSupabaseServiceClient();

    // Use RPC or raw query for aggregation — Supabase JS doesn't have
    // native GROUP BY, so we query all rows in the window and count locally.
    let query = supabase
      .from("content_safety_audit" as never)
      .select("action_taken")
      .gte("created_at", since)
      .lt("created_at", before);

    if (contentRatingLevel !== undefined) {
      query = query.eq("content_rating_level", contentRatingLevel);
    }

    // Limit to prevent memory issues on large datasets
    query = query.limit(10000);

    const { data, error } = (await query) as {
      data: Array<{ action_taken: string }> | null;
      error: { message: string } | null;
    };

    if (error || !data) {
      return emptyMetrics();
    }

    return aggregateMetrics(data);
  } catch (err) {
    logger.error("Impact query failed", {
      error: err instanceof Error ? err.message : String(err),
      route: "platform/admin/config-impact",
    });
    return emptyMetrics();
  }
}

/** Aggregate action_taken rows into metrics */
function aggregateMetrics(
  rows: ReadonlyArray<{ action_taken: string }>
): ConfigImpactMetrics {
  const total = rows.length;
  if (total === 0) return emptyMetrics();

  let blockCount = 0;
  let warnCount = 0;
  let allowCount = 0;
  let escalateCount = 0;

  for (const row of rows) {
    switch (row.action_taken) {
      case "block":
        blockCount++;
        break;
      case "warn":
        warnCount++;
        break;
      case "allow":
        allowCount++;
        break;
      case "escalate":
        escalateCount++;
        break;
    }
  }

  return {
    totalScreenings: total,
    blockCount,
    warnCount,
    allowCount,
    escalateCount,
    blockRate: total > 0 ? blockCount / total : 0,
    warnRate: total > 0 ? warnCount / total : 0,
  };
}

/** Empty metrics for when no data is available */
function emptyMetrics(): ConfigImpactMetrics {
  return {
    totalScreenings: 0,
    blockCount: 0,
    warnCount: 0,
    allowCount: 0,
    escalateCount: 0,
    blockRate: 0,
    warnRate: 0,
  };
}

// ---------------------------------------------------------------------------
// Content rating level extraction
// ---------------------------------------------------------------------------

/**
 * Extract the content rating level from a moderation config key.
 * Returns undefined for non-level-specific keys.
 *
 * Examples:
 *   "moderation.level1.block_severity" → 1
 *   "moderation.level2.warn_severity" → 2
 *   "moderation.strike_warn_threshold" → undefined
 */
function extractRatingLevel(configKey: string): number | undefined {
  const match = configKey.match(/^moderation\.level(\d)\./);
  if (match) {
    const level = parseInt(match[1], 10);
    if (level >= 1 && level <= 3) return level;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Summary generation
// ---------------------------------------------------------------------------

/** Generate a human-readable summary comparing before/after metrics */
function generateSummary(
  change: ConfigHistoryRecord,
  before: ConfigImpactMetrics,
  after: ConfigImpactMetrics
): string {
  const parts: string[] = [];

  parts.push(
    `Config "${change.configKey}" changed from ${JSON.stringify(change.previousValue)} to ${JSON.stringify(change.newValue)}.`
  );

  if (
    before.totalScreenings < MIN_SCREENINGS_FOR_COMPARISON ||
    after.totalScreenings < MIN_SCREENINGS_FOR_COMPARISON
  ) {
    parts.push(
      `Insufficient data for comparison (before: ${before.totalScreenings} screenings, after: ${after.totalScreenings} screenings). Need at least ${MIN_SCREENINGS_FOR_COMPARISON} in each period.`
    );
    return parts.join(" ");
  }

  const blockDelta = after.blockRate - before.blockRate;
  const warnDelta = after.warnRate - before.warnRate;

  if (Math.abs(blockDelta) > 0.01) {
    const direction = blockDelta > 0 ? "increased" : "decreased";
    parts.push(
      `Block rate ${direction} from ${formatPercent(before.blockRate)} to ${formatPercent(after.blockRate)}.`
    );
  } else {
    parts.push(`Block rate unchanged at ${formatPercent(after.blockRate)}.`);
  }

  if (Math.abs(warnDelta) > 0.01) {
    const direction = warnDelta > 0 ? "increased" : "decreased";
    parts.push(
      `Warn rate ${direction} from ${formatPercent(before.warnRate)} to ${formatPercent(after.warnRate)}.`
    );
  }

  parts.push(
    `Period: ${before.totalScreenings} screenings before, ${after.totalScreenings} after.`
  );

  return parts.join(" ");
}

/** Format a rate (0–1) as a percentage string */
function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate an impact report for a config change.
 *
 * Compares moderation outcomes in a window before the change
 * to outcomes after the change (up to now or next change).
 *
 * Only meaningful for moderation-category config keys.
 */
export async function generateImpactReport(
  change: ConfigHistoryRecord,
  nextChangeAt?: string
): Promise<ConfigImpactReport> {
  const changeTime = new Date(change.createdAt);
  const afterEnd = nextChangeAt ?? new Date().toISOString();

  // "Before" window: same duration as "after" window, but before the change
  const afterDurationMs = new Date(afterEnd).getTime() - changeTime.getTime();
  const beforeDurationMs = Math.min(afterDurationMs, DEFAULT_BEFORE_WINDOW_MS);
  const beforeStart = new Date(changeTime.getTime() - beforeDurationMs).toISOString();

  // Check if this is a level-specific key
  const ratingLevel = extractRatingLevel(change.configKey);

  const [beforeMetrics, afterMetrics] = await Promise.all([
    queryAuditMetrics(beforeStart, change.createdAt, ratingLevel),
    queryAuditMetrics(change.createdAt, afterEnd, ratingLevel),
  ]);

  return {
    change,
    periodStart: beforeStart,
    periodEnd: afterEnd,
    before: beforeMetrics,
    after: afterMetrics,
    summary: generateSummary(change, beforeMetrics, afterMetrics),
  };
}

/**
 * Check whether a config key is in the moderation category.
 * Impact reports are only meaningful for moderation config.
 */
export function isModerationConfig(configKey: string): boolean {
  return configKey.startsWith("moderation.");
}

// ---------------------------------------------------------------------------
// Gotchas (L17)
// ---------------------------------------------------------------------------
//
// 1. Supabase JS doesn't support GROUP BY — we fetch rows and count
//    locally. The 10,000 row limit prevents memory blowups but means
//    very high-traffic periods may have undercounted metrics.
//
// 2. The "before" window is capped at 7 days even if the "after"
//    window is longer. This prevents comparing 1 day of data against
//    30 days of baseline.
//
// 3. extractRatingLevel only works for keys matching the pattern
//    "moderation.levelN.*". Global moderation keys (strike thresholds,
//    classifier effort) compare ALL audit records regardless of level.
//
// 4. Impact reports are fire-and-forget diagnostic tools — they never
//    block config changes and tolerate query failures gracefully (P11).
