/**
 * platform/moderation/sentinel.ts — Sentinel account consequences agent
 *
 * The Sentinel processes Guardian block decisions and manages the
 * account consequences ladder: strike recording -> threshold evaluation
 * -> status change (warn -> restrict -> suspend -> ban).
 *
 * Runs on the agent runtime (ADR-039): processBlock drives its 5 steps through
 * executeAgent, so the trajectory is persisted, inspectable, and budget-bounded.
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
 *   P11 — Fail-closed: config unavailable -> strictest thresholds
 *   P13 — Control plane: all thresholds from platform_config
 *   P15 — Agent identity: actorType/actorId/agentRole
 *   P17 — Cognition-commitment: evaluate -> commit (strike + status)
 *   P18 — Durable trajectories: full step history per decision
 *
 * @module platform/moderation
 */

import type { AgentIdentity } from "@/platform/agents/types";
import { generateId } from "@/platform/agents/utils";
import { executeAgent } from "@/platform/agents/runtime";
import type { WorkflowFn } from "@/platform/agents/runtime";
import type {
  ModerationResult,
  AccountStatus,
  ConsequenceAction,
  SentinelResult,
} from "./types";
import type { SafetySeverity } from "@/prompts/safety/classify-v1";
import { getStrikeStore } from "./strikes";
import { submitForReview } from "./review-service";
import { loadStrikeThresholds } from "./config";
import { getConfig } from "@/platform/auth/platform-config";
import { withTenantTx } from "@/platform/data";
import { audited, writeAuditLog } from "@/platform/auth/audit";
import { logger } from "@/lib/logger";
import { getSingleton, setSingleton } from "@/platform/kernel/singleton";

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
    // B5: Runtime guard — validate preconditions, not just JSDoc
    if (moderationResult.action !== "block") {
      throw new Error(
        "Sentinel.processBlock called with non-block action: " + moderationResult.action
      );
    }
    if (!moderationResult.attributeToUser) {
      throw new Error("Sentinel.processBlock called with attributeToUser=false");
    }
    if (!userId) {
      throw new Error("Sentinel.processBlock called without userId");
    }

    const store = getStrikeStore();
    const reasonParts: string[] = [];

    // Step-shared state lives in one object: its assignments happen inside the
    // workflow closure, and object-property reads use the declared type (they are
    // not CFA-narrowed to the initialiser the way a captured `let` would be).
    const category = moderationResult.classifierOutput?.categories[0] ?? "unclassified";
    const severity: SafetySeverity =
      moderationResult.classifierOutput?.severity ?? "medium";
    const acc: {
      expiresAt: string | null;
      strikeResult?: Awaited<ReturnType<typeof store.recordStrike>>;
      updatedSummary: Awaited<ReturnType<typeof store.getStrikeSummary>>;
      currentStatus: AccountStatus;
      consequence: ConsequenceAction;
      newStatus: AccountStatus;
    } = {
      expiresAt: null,
      updatedSummary: await store.getStrikeSummary(userId), // safe default; set in step 3
      currentStatus: "active",
      consequence: "none",
      newStatus: "active",
    };

    const workflow: WorkflowFn = async (ctx) => {
      switch (ctx.stepCount) {
        case 0: {
          reasonParts.push(
            `Guardian blocked content: ${category} (severity: ${severity}, triggered by: ${moderationResult.triggeredBy}).`
          );
          return {
            action: "receive-block",
            boundary: "cognition",
            input: {
              userId,
              action: moderationResult.action,
              category,
              severity,
              triggeredBy: moderationResult.triggeredBy,
            },
            output: { received: true },
            costUsd: 0,
            continueExecution: true,
          };
        }
        case 1: {
          const summary = await store.getStrikeSummary(userId);
          reasonParts.push(`User has ${summary.totalActive} active strike(s).`);
          return {
            action: "load-history",
            boundary: "cognition",
            input: { userId },
            output: {
              totalActive: summary.totalActive,
              byCategory: summary.byCategory,
              highestSeverity: summary.highestSeverity,
            },
            costUsd: 0,
            continueExecution: true,
          };
        }
        case 2: {
          const expiryDays = await loadExpiryDays(severity);
          acc.expiresAt =
            expiryDays > 0
              ? new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000).toISOString()
              : null;

          const recorded = await store.recordStrike({
            userId,
            category,
            severity,
            moderationAuditId: null,
            guardianDecisionId: moderationResult.trajectoryId,
            trajectoryId: ctx.trajectoryId,
            agentId: this.identity.actorId,
            reason: reasonParts[0],
            expiresAt: acc.expiresAt,
            expired: false,
          });
          acc.strikeResult = recorded;

          if (!recorded.success) {
            // L19: Strike recording failure is surfaced, not swallowed
            logger.error("Sentinel: strike recording failed", {
              userId,
              category,
              severity,
              error: recorded.error,
              requestId,
              route: "platform/moderation/sentinel",
            });
            reasonParts.push(`Strike recording FAILED: ${recorded.error}.`);
          } else {
            reasonParts.push(
              `Strike recorded: ${category} (${severity}).` +
                (acc.expiresAt ? ` Expires: ${acc.expiresAt}.` : " Never expires.")
            );
          }

          return {
            action: "record-strike",
            boundary: "commitment",
            input: { category, severity, expiresAt: acc.expiresAt },
            output: {
              success: recorded.success,
              error: recorded.error,
              strikeId: recorded.record?.id,
            },
            costUsd: 0,
            continueExecution: true,
          };
        }
        case 3: {
          acc.updatedSummary = await store.getStrikeSummary(userId);
          const thresholds = await loadStrikeThresholds();
          acc.consequence = evaluateConsequence(
            acc.updatedSummary.totalActive,
            thresholds
          );
          acc.currentStatus = await loadUserStatus(userId);
          acc.newStatus = consequenceToStatus(acc.consequence, acc.currentStatus);

          reasonParts.push(
            `Total active strikes: ${acc.updatedSummary.totalActive}. ` +
              `Thresholds: warn=${thresholds.warnAt}, suspend=${thresholds.suspendAt}, ban=${thresholds.banAt}. ` +
              `Consequence: ${acc.consequence}.`
          );

          return {
            action: "evaluate",
            boundary: "cognition",
            input: {
              totalActive: acc.updatedSummary.totalActive,
              thresholds,
              currentStatus: acc.currentStatus,
            },
            output: {
              consequence: acc.consequence,
              newStatus: acc.newStatus,
              statusChanged: acc.newStatus !== acc.currentStatus,
            },
            costUsd: 0,
            continueExecution: true,
          };
        }
        default: {
          // Step 4 — apply-consequence (last step)
          if (acc.newStatus !== acc.currentStatus) {
            // Recorded before the account changes; with no record it does not change
            // (audit X-8). A thrown error fails this step, so the run reports the
            // consequence as not applied.
            await audited(
              {
                action: "admin_action",
                agent: this.identity.actorId,
                targetId: userId,
                details: {
                  type: "sentinel_status_change",
                  category,
                  severity,
                  consequence: acc.consequence,
                  previousStatus: acc.currentStatus,
                  newStatus: acc.newStatus,
                  totalActiveStrikes: acc.updatedSummary.totalActive,
                  trajectoryId: ctx.trajectoryId,
                  guardianDecisionId: moderationResult.trajectoryId,
                },
              },
              // The failure of the update is recorded too ("failed"), so the history never
              // shows a change that did not happen (release review, Sprint 7X).
              () =>
                updateUserStatus(
                  userId,
                  acc.newStatus,
                  acc.consequence,
                  this.identity.actorId
                )
            );
            reasonParts.push(`Status changed: ${acc.currentStatus} -> ${acc.newStatus}.`);
          } else {
            reasonParts.push(`No status change needed (current: ${acc.currentStatus}).`);
          }

          return {
            action: "apply-consequence",
            boundary: "commitment",
            input: { previousStatus: acc.currentStatus, newStatus: acc.newStatus },
            output: { applied: acc.newStatus !== acc.currentStatus },
            costUsd: 0,
            continueExecution: false,
          };
        }
      }
    };

    const exec = await executeAgent(
      "sentinel",
      "guardian-block",
      "user",
      userId,
      workflow
    );
    const trajectoryId = exec.trajectoryId;

    // ADR-039 F3c companion: a Sentinel run that did not complete means the account consequence
    // was NOT applied. Surface it loudly rather than silently returning "no consequence" — the
    // Guardian block still stands, but the strike/status change must not be silently dropped.
    if (!exec.success || exec.finalStatus !== "completed") {
      logger.error("Sentinel run did not complete — account consequence NOT applied", {
        route: "platform/moderation/sentinel",
        userId,
        requestId,
        finalStatus: exec.finalStatus,
        error: exec.error,
      });
      reasonParts.push(
        "Sentinel run did not complete — consequence not applied (surfaced)."
      );
    }

    // The decision record (also read by the appeals route for previousStatus). Best effort: the
    // decision itself is already made; a status change was recorded before it was applied.
    await writeAuditLog({
      action: "admin_action",
      agent: this.identity.actorId,
      targetId: userId,
      details: {
        type: "sentinel_decision",
        category,
        severity,
        consequence: acc.consequence,
        previousStatus: acc.currentStatus,
        newStatus: acc.newStatus,
        totalActiveStrikes: acc.updatedSummary.totalActive,
        trajectoryId,
        guardianDecisionId: moderationResult.trajectoryId,
      },
    });

    // ── Submit ban for human review (ADR-024) ──────────────────────
    // Post-hoc: the ban was already applied in Step 4. A moderator may overturn
    // it, which restores previousAccountStatus and expires the linked strike
    // (resolved via the strike's guardianDecisionId — relatedStrikeId here is
    // audit-only). Fail-open: a submission failure must never undo or break the
    // ban that has already been committed.
    if (acc.consequence === "ban" && acc.newStatus !== acc.currentStatus) {
      try {
        const reviewResult = await submitForReview({
          source: "ban_review",
          moderationResult,
          targetUserId: userId,
          requestId,
          previousAccountStatus: acc.currentStatus,
          relatedStrikeId: acc.strikeResult?.record?.id,
        });
        if (!reviewResult.success) {
          logger.warn("Sentinel: ban_review submission did not succeed (ban stands)", {
            userId,
            requestId,
            error: reviewResult.error,
            route: "platform/moderation/sentinel",
          });
        }
      } catch (err) {
        logger.error("Sentinel: ban_review submission failed (ban stands)", {
          userId,
          requestId,
          error: err instanceof Error ? err.message : String(err),
          route: "platform/moderation/sentinel",
        });
      }
    }

    return {
      strike: acc.strikeResult?.record ?? {
        id: "failed",
        userId,
        category,
        severity,
        moderationAuditId: null,
        guardianDecisionId: moderationResult.trajectoryId,
        trajectoryId,
        agentId: this.identity.actorId,
        reason: reasonParts[0],
        expiresAt: acc.expiresAt,
        expired: false,
        createdAt: new Date().toISOString(),
      },
      strikeSummary: acc.updatedSummary,
      consequenceAction: acc.consequence,
      previousStatus: acc.currentStatus,
      newStatus: acc.newStatus,
      reasoning: reasonParts.join(" "),
      trajectoryId,
      agentId: this.identity.actorId,
    };
  }
}

// ---------------------------------------------------------------------------
// User status operations
// ---------------------------------------------------------------------------

/** Load user's current account status from the DB (the request's tenant). */
async function loadUserStatus(userId: string): Promise<AccountStatus> {
  try {
    const { rows } = await withTenantTx((tx) =>
      tx.query<{ account_status: string }>(
        "select account_status from users where id = $1::uuid",
        [userId]
      )
    );
    if (!rows[0]) return "active";
    return parseAccountStatus(rows[0].account_status);
  } catch {
    return "active";
  }
}

/**
 * Update user's account status in the DB.
 *
 * SECURITY INVARIANT (S2): This function is intentionally NOT exported.
 * It writes the users table directly, with no authorization check of its own (row-level
 * security confines it to the request's tenant, nothing more). Only the Sentinel agent should
 * call it, and only as the result of a consequence evaluation. If this function is ever
 * exported, it MUST be wrapped with authorization checks.
 */
async function updateUserStatus(
  userId: string,
  newStatus: AccountStatus,
  consequence: ConsequenceAction,
  agentId: string
): Promise<void> {
  try {
    // Configuration is read before the transaction: nothing but SQL runs inside one.
    const suspendedUntil =
      consequence === "suspend"
        ? new Date(Date.now() + (await loadSuspensionDays()) * 24 * 60 * 60 * 1000)
        : null;
    const ban = consequence === "ban";

    // A field this consequence does not set keeps its value.
    await withTenantTx((tx) =>
      tx.query(
        `update users set
            account_status = $2::account_status,
            status_changed_by = $3,
            status_changed_at = now(),
            suspended_until = coalesce($4::timestamptz, suspended_until),
            banned_at = case when $5::boolean then now() else banned_at end,
            ban_reason = case when $5::boolean then $6 else ban_reason end
          where id = $1::uuid`,
        [
          userId,
          newStatus,
          agentId,
          suspendedUntil?.toISOString() ?? null,
          ban,
          "Automatic ban: strike threshold exceeded",
        ]
      )
    );
  } catch (err) {
    logger.error("Sentinel: user status update failed", {
      userId,
      newStatus,
      error: err instanceof Error ? err.message : String(err),
      route: "platform/moderation/sentinel",
    });
    // Surfaced: the step fails and the run reports the consequence as not applied, rather
    // than the run completing as if the account had changed.
    throw err;
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

/** ADR-032: anchored on globalThis — a module-scope `let` is duplicated per bundle entry. */
const SENTINEL_KEY = "platform.moderation.sentinel";
function readSentinelInstance(): Sentinel {
  return getSingleton<Sentinel>(SENTINEL_KEY, () => new Sentinel());
}
function writeSentinelInstance(next: Sentinel): void {
  setSingleton<Sentinel>(SENTINEL_KEY, next);
}

export function getSentinel(): Sentinel {
  return readSentinelInstance();
}

export function setSentinel(sentinel: Sentinel): Sentinel {
  const previous = readSentinelInstance();
  writeSentinelInstance(sentinel);
  return previous;
}

export function resetSentinel(): void {
  writeSentinelInstance(new Sentinel());
}

// ---------------------------------------------------------------------------
// Gotchas (L17)
// ---------------------------------------------------------------------------
//
// 1. evaluateConsequence uses total active strikes, not per-category.
//    The threshold check is: total >= banAt? -> ban. Total >= suspendAt? -> suspend.
//    Per-category tracking exists for analytics, not for threshold evaluation.
//
// 2. consequenceToStatus only upgrades severity — warned -> active never happens
//    automatically. Only human review (Sprint 6) can downgrade status.
//
// 3. The Sentinel does NOT handle "restrict" consequence currently.
//    The ConsequenceAction type includes "restrict" for type completeness,
//    but evaluateConsequence() never returns it — the threshold ladder is
//    warn -> suspend -> ban (no restrict step). If restrict is added later,
//    it needs: (a) a threshold in evaluateConsequence, (b) restriction_duration_hours
//    from config, (c) set restricted_until on users table, (d) middleware
//    enforcement to check restricted_until before allowing writes.
//
// 4. loadUserStatus returns "active" on any error (fail-open for reads).
//    This is the opposite of fail-closed for writes. Rationale: if we
//    can't read the status, the strike was still recorded (L19) — the
//    consequence evaluation will be retried next time.
//
// 5. SEVERITY_RANK is duplicated from guardian.ts. See strikes.ts Gotcha #5.
//
// 6. evaluateConsequence queries getStrikeSummary AFTER recordStrike.
//    This works because both run against the same Postgres primary, where a
//    committed write is visible to the next transaction (read-after-write). If the store is ever
//    replaced with an eventually-consistent backend, the count could
//    be stale by one — evaluating consequences based on the previous
//    strike count. This would delay the consequence by one violation
//    (e.g., ban at 5 strikes instead of 4). Monitor if store changes.
//
// 7. ADR-039: processBlock runs its 5 steps through executeAgent("sentinel", ...).
//    The trajectory is owned by the runtime (persisted + budget-bounded); the
//    step-shared state lives in the processBlock closure across the workflow calls.
