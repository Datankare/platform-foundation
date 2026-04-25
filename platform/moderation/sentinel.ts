/**
 * platform/moderation/sentinel.ts — Sentinel account consequences agent
 *
 * The Sentinel processes Guardian block decisions and manages the
 * account consequences ladder: strike recording → threshold evaluation
 * → status change (warn → restrict → suspend → ban).
 *
 * Trajectory (per processBlock call):
 *   Step 0: receive-block     (cognition)  — receive Guardian block event
 *   Step 1: load-history      (cognition)  — load user's active strikes
 *   Step 2: record-strike     (commitment) — persist the new strike
 *   Step 3: evaluate          (cognition)  — compare total against thresholds
 *   Step 4: apply-consequence (commitment) — update user status (if needed)
 *
 * GenAI Principles:
 *   P2  — Bounded agent: 5 steps max per block event
 *   P3  — Total observability: every step timed and recorded
 *   P11 — Fail-closed: config unavailable → strictest thresholds
 *   P13 — Control plane: all thresholds from platform_config
 *   P15 — Agent identity: actorType/actorId/agentRole
 *   P17 — Cognition-commitment: evaluate → commit (strike + status)
 *   P18 — Durable trajectories: full step history per decision
 *
 * @module platform/moderation
 */

import type { AgentIdentity, Step, StepBoundary } from "@/platform/agents/types";
import type {
  ModerationResult,
  AccountStatus,
  ConsequenceAction,
  SentinelResult,
} from "./types";
import type { SafetySeverity } from "@/prompts/safety/classify-v1";
import { getStrikeStore } from "./strikes";
import { loadStrikeThresholds } from "./config";
import { getConfig } from "@/platform/auth/platform-config";
import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { writeAuditLog } from "@/platform/auth/audit";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Trajectory helpers (same pattern as guardian.ts)
// ---------------------------------------------------------------------------

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function makeStep(
  stepIndex: number,
  action: string,
  boundary: StepBoundary,
  input: Record<string, unknown>,
  output: Record<string, unknown>,
  durationMs: number
): Step {
  return {
    stepIndex,
    action,
    boundary,
    input,
    output,
    cost: 0,
    durationMs,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Config loaders (P13)
// ---------------------------------------------------------------------------

/** Fail-closed defaults for strike expiry (P11) */
const FAIL_CLOSED_EXPIRY_DAYS = 0; // never expires

/** Load strike expiry duration for a severity level */
async function loadExpiryDays(severity: SafetySeverity): Promise<number> {
  const key = `moderation.strike_expiry_${severity}_days`;
  const days = await getConfig<number>(key, FAIL_CLOSED_EXPIRY_DAYS);
  return typeof days === "number" ? days : FAIL_CLOSED_EXPIRY_DAYS;
}

/** Load suspension duration in days */
async function loadSuspensionDays(): Promise<number> {
  const days = await getConfig<number>("moderation.suspension_duration_days", 7);
  return typeof days === "number" ? days : 7;
}

// ---------------------------------------------------------------------------
// Consequence evaluation (pure logic)
// ---------------------------------------------------------------------------

/**
 * Evaluate what consequence to apply based on strike count and thresholds.
 * Pure function — no side effects, independently testable.
 */
export function evaluateConsequence(
  totalActiveStrikes: number,
  thresholds: { warnAt: number; suspendAt: number; banAt: number }
): ConsequenceAction {
  if (totalActiveStrikes >= thresholds.banAt) return "ban";
  if (totalActiveStrikes >= thresholds.suspendAt) return "suspend";
  if (totalActiveStrikes >= thresholds.warnAt) return "warn";
  return "none";
}

/**
 * Determine the new account status from a consequence action.
 * Pure function.
 */
export function consequenceToStatus(
  action: ConsequenceAction,
  currentStatus: AccountStatus
): AccountStatus {
  switch (action) {
    case "ban":
      return "banned";
    case "suspend":
      return "suspended";
    case "warn":
      // Only upgrade to warned if currently active
      return currentStatus === "active" ? "warned" : currentStatus;
    case "none":
      return currentStatus;
    default:
      return currentStatus;
  }
}

// ---------------------------------------------------------------------------
// Sentinel agent
// ---------------------------------------------------------------------------

/**
 * The Sentinel account consequences agent.
 *
 * Each instance has a unique agent ID. The Sentinel is stateless between
 * calls — each processBlock() creates a fresh trajectory.
 */
export class Sentinel {
  readonly identity: AgentIdentity;

  constructor(instanceId?: string) {
    const id = instanceId ?? `sentinel-${generateId()}`;
    this.identity = {
      actorType: "agent",
      actorId: id,
      agentRole: "sentinel",
    };
  }

  /**
   * Process a Guardian block decision.
   *
   * Only call when:
   *   - result.action === "block"
   *   - result.attributeToUser === true
   *   - context.userId is known
   *
   * Returns SentinelResult with strike, consequence, and trajectory.
   */
  async processBlock(
    moderationResult: ModerationResult,
    userId: string,
    requestId: string
  ): Promise<SentinelResult> {
    const trajectoryId = `traj-${generateId()}`;
    const steps: Step[] = [];
    const reasonParts: string[] = [];

    // ── Step 0: Receive block event (cognition) ────────────────────
    const s0Start = Date.now();
    const category = moderationResult.classifierOutput?.categories[0] ?? "unclassified";
    const severity: SafetySeverity =
      moderationResult.classifierOutput?.severity ?? "medium";

    steps.push(
      makeStep(
        0,
        "receive-block",
        "cognition",
        {
          userId,
          action: moderationResult.action,
          category,
          severity,
          triggeredBy: moderationResult.triggeredBy,
        },
        {
          received: true,
        },
        Date.now() - s0Start
      )
    );

    reasonParts.push(
      `Guardian blocked content: ${category} (severity: ${severity}, triggered by: ${moderationResult.triggeredBy}).`
    );

    // ── Step 1: Load strike history (cognition) ────────────────────
    const s1Start = Date.now();
    const store = getStrikeStore();
    const existingSummary = await store.getStrikeSummary(userId);

    steps.push(
      makeStep(
        1,
        "load-history",
        "cognition",
        {
          userId,
        },
        {
          totalActive: existingSummary.totalActive,
          byCategory: existingSummary.byCategory,
          highestSeverity: existingSummary.highestSeverity,
        },
        Date.now() - s1Start
      )
    );

    reasonParts.push(`User has ${existingSummary.totalActive} active strike(s).`);

    // ── Step 2: Record strike (commitment) ─────────────────────────
    const s2Start = Date.now();
    const expiryDays = await loadExpiryDays(severity);
    const expiresAt =
      expiryDays > 0
        ? new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000).toISOString()
        : null;

    const strikeResult = await store.recordStrike({
      userId,
      category,
      severity,
      moderationAuditId: null,
      trajectoryId,
      agentId: this.identity.actorId,
      reason: reasonParts[0],
      expiresAt,
      expired: false,
    });

    steps.push(
      makeStep(
        2,
        "record-strike",
        "commitment",
        {
          category,
          severity,
          expiresAt,
        },
        {
          success: strikeResult.success,
          error: strikeResult.error,
          strikeId: strikeResult.record?.id,
        },
        Date.now() - s2Start
      )
    );

    if (!strikeResult.success) {
      // L19: Strike recording failure is surfaced, not swallowed
      logger.error("Sentinel: strike recording failed", {
        userId,
        category,
        severity,
        error: strikeResult.error,
        requestId,
        route: "platform/moderation/sentinel",
      });
      reasonParts.push(`Strike recording FAILED: ${strikeResult.error}.`);
    } else {
      reasonParts.push(
        `Strike recorded: ${category} (${severity}).` +
          (expiresAt ? ` Expires: ${expiresAt}.` : " Never expires.")
      );
    }

    // ── Step 3: Evaluate consequence (cognition) ───────────────────
    const s3Start = Date.now();
    const updatedSummary = await store.getStrikeSummary(userId);
    const thresholds = await loadStrikeThresholds();
    const consequence = evaluateConsequence(updatedSummary.totalActive, thresholds);

    // Load current user status
    const currentStatus = await loadUserStatus(userId);

    const newStatus = consequenceToStatus(consequence, currentStatus);

    steps.push(
      makeStep(
        3,
        "evaluate",
        "cognition",
        {
          totalActive: updatedSummary.totalActive,
          thresholds,
          currentStatus,
        },
        {
          consequence,
          newStatus,
          statusChanged: newStatus !== currentStatus,
        },
        Date.now() - s3Start
      )
    );

    reasonParts.push(
      `Total active strikes: ${updatedSummary.totalActive}. ` +
        `Thresholds: warn=${thresholds.warnAt}, suspend=${thresholds.suspendAt}, ban=${thresholds.banAt}. ` +
        `Consequence: ${consequence}.`
    );

    // ── Step 4: Apply consequence (commitment) ─────────────────────
    const s4Start = Date.now();
    if (newStatus !== currentStatus) {
      await updateUserStatus(userId, newStatus, consequence, this.identity.actorId);
      reasonParts.push(`Status changed: ${currentStatus} → ${newStatus}.`);
    } else {
      reasonParts.push(`No status change needed (current: ${currentStatus}).`);
    }

    steps.push(
      makeStep(
        4,
        "apply-consequence",
        "commitment",
        {
          previousStatus: currentStatus,
          newStatus,
        },
        {
          applied: newStatus !== currentStatus,
        },
        Date.now() - s4Start
      )
    );

    // Fire-and-forget audit log
    writeAuditLog({
      action: "admin_action",
      actorId: this.identity.actorId,
      targetId: userId,
      details: {
        type: "sentinel_decision",
        category,
        severity,
        consequence,
        previousStatus: currentStatus,
        newStatus,
        totalActiveStrikes: updatedSummary.totalActive,
        trajectoryId,
      },
    });

    return {
      strike: strikeResult.record ?? {
        id: "failed",
        userId,
        category,
        severity,
        moderationAuditId: null,
        trajectoryId,
        agentId: this.identity.actorId,
        reason: reasonParts[0],
        expiresAt,
        expired: false,
        createdAt: new Date().toISOString(),
      },
      strikeSummary: updatedSummary,
      consequenceAction: consequence,
      previousStatus: currentStatus,
      newStatus,
      reasoning: reasonParts.join(" "),
      trajectoryId,
      agentId: this.identity.actorId,
    };
  }
}

// ---------------------------------------------------------------------------
// User status operations
// ---------------------------------------------------------------------------

/** Load user's current account status from the DB */
async function loadUserStatus(userId: string): Promise<AccountStatus> {
  try {
    const supabase = getSupabaseServiceClient();
    const { data, error } = await (supabase
      .from("users" as never)
      .select("account_status")
      .eq("id", userId)
      .single() as unknown as Promise<{
      data: { account_status: string } | null;
      error: { message: string } | null;
    }>);

    if (error || !data) return "active";
    return parseAccountStatus(data.account_status);
  } catch {
    return "active";
  }
}

/** Update user's account status in the DB */
async function updateUserStatus(
  userId: string,
  newStatus: AccountStatus,
  consequence: ConsequenceAction,
  agentId: string
): Promise<void> {
  try {
    const supabase = getSupabaseServiceClient();
    const now = new Date().toISOString();
    const updateData: Record<string, unknown> = {
      account_status: newStatus,
      status_changed_by: agentId,
      status_changed_at: now,
    };

    if (consequence === "suspend") {
      const days = await loadSuspensionDays();
      updateData.suspended_until = new Date(
        Date.now() + days * 24 * 60 * 60 * 1000
      ).toISOString();
    }

    if (consequence === "ban") {
      updateData.banned_at = now;
      updateData.ban_reason = "Automatic ban: strike threshold exceeded";
    }

    await (supabase
      .from("users" as never)
      .update(updateData as never)
      .eq("id", userId) as unknown as Promise<{
      error: { message: string } | null;
    }>);
  } catch (err) {
    logger.error("Sentinel: user status update failed", {
      userId,
      newStatus,
      error: err instanceof Error ? err.message : String(err),
      route: "platform/moderation/sentinel",
    });
  }
}

/** Parse account_status string with fallback */
function parseAccountStatus(raw: string): AccountStatus {
  const valid: ReadonlySet<string> = new Set([
    "active",
    "warned",
    "restricted",
    "suspended",
    "banned",
  ]);
  return valid.has(raw) ? (raw as AccountStatus) : "active";
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

let sentinelInstance: Sentinel = new Sentinel();

export function getSentinel(): Sentinel {
  return sentinelInstance;
}

export function setSentinel(sentinel: Sentinel): Sentinel {
  const previous = sentinelInstance;
  sentinelInstance = sentinel;
  return previous;
}

export function resetSentinel(): void {
  sentinelInstance = new Sentinel();
}

// ---------------------------------------------------------------------------
// Gotchas (L17)
// ---------------------------------------------------------------------------
//
// 1. evaluateConsequence uses total active strikes, not per-category.
//    The threshold check is: total >= banAt? → ban. Total >= suspendAt? → suspend.
//    Per-category tracking exists for analytics, not for threshold evaluation.
//
// 2. consequenceToStatus only upgrades severity — warned → active never happens
//    automatically. Only human review (Sprint 6) can downgrade status.
//
// 3. The Sentinel does NOT handle "restrict" consequence currently. The
//    restrict action requires the restriction_duration_hours config and
//    sets restricted_until on the user. This will be added when the
//    middleware consent gate is in place to enforce it.
//
// 4. loadUserStatus returns "active" on any error (fail-open for reads).
//    This is the opposite of fail-closed for writes. Rationale: if we
//    can't read the status, the strike was still recorded (L19) — the
//    consequence evaluation will be retried next time.
//
// 5. SEVERITY_RANK is duplicated from guardian.ts. See strikes.ts Gotcha #5.
