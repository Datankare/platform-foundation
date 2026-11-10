/**
 * GDPR Hard Purge Pipeline.
 *
 * Orchestrates complete user data deletion across all registered
 * data stores. Handlers are registered by priority and executed
 * sequentially. Results are logged to purge_log audit table.
 *
 * Design decisions:
 * - Sequential execution (not parallel) to respect foreign key order
 * - Continue-on-error by default (partial purge is better than no purge)
 * - Dry-run mode for verification before actual deletion
 * - Audit trail is anonymized, never deleted (regulatory compliance)
 *
 * @module platform/gdpr
 */

import type {
  PurgeAuditEntry,
  PurgeConfig,
  PurgeHandler,
  PurgeRequest,
  PurgeResult,
  PurgeStatus,
  PurgeStepResult,
} from "./types";
import { generateId } from "@/platform/agents/utils";
import { logger } from "@/lib/logger";
import { CALL_FAILED, logCaught } from "@/platform/observability/caught-error";

/**
 * Generate a unique purge ID.
 * Format: purge_{timestamp}_{random}
 */
function generatePurgeId(): string {
  const ts = Date.now().toString(36);
  // Crypto-secure: a predictable anonymization suffix permits re-identification
  // by correlation.
  const rand = generateId();
  return `purge_${ts}_${rand}`;
}

/**
 * GDPR Hard Purge Pipeline.
 *
 * Usage (createPlatformPurgePipeline in ./account-erasure.ts registers the platform's own handler;
 * an app registers a handler of its own for a store the erasure register cannot reach):
 *   const pipeline = new PurgePipeline();
 *   pipeline.register(myStoreHandler);
 *   const result = await pipeline.execute({ userId, requestedBy, reason });
 */
export class PurgePipeline {
  private handlers: PurgeHandler[] = [];
  private readonly config: Required<PurgeConfig>;
  private auditCallback: ((entry: PurgeAuditEntry) => Promise<void>) | null = null;

  constructor(config?: PurgeConfig) {
    this.config = {
      timeoutMs: config?.timeoutMs ?? 30_000,
      continueOnError: config?.continueOnError ?? true,
    };
  }

  /**
   * Register a purge handler. Handlers execute in priority order (lowest first).
   */
  register(handler: PurgeHandler): void {
    // Prevent duplicate handler names
    if (this.handlers.some((h) => h.name === handler.name)) {
      throw new Error(`Purge handler "${handler.name}" already registered`);
    }
    this.handlers.push(handler);
    // Sort by priority
    this.handlers.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Set the audit callback for logging purge results.
   * Typically writes to the purge_log table (per tenant).
   */
  onAudit(callback: (entry: PurgeAuditEntry) => Promise<void>): void {
    this.auditCallback = callback;
  }

  /**
   * Get registered handler names (for testing/inspection).
   */
  getHandlerNames(): string[] {
    return this.handlers.map((h) => h.name);
  }

  /**
   * Execute the purge pipeline for a user.
   */
  async execute(request: PurgeRequest): Promise<PurgeResult> {
    const purgeId = generatePurgeId();
    const requestedAt = new Date().toISOString();
    const dryRun = request.dryRun ?? false;
    const steps: PurgeStepResult[] = [];
    let overallStatus: PurgeStatus = "in-progress";

    // Fail closed (audit X-15): with no handlers nothing is deleted, so the purge has failed.
    // Reporting "completed" here told callers personal data was erased when none was.
    if (this.handlers.length === 0) {
      return {
        purgeId,
        userId: request.userId,
        status: "failed",
        steps: [],
        requestedAt,
        completedAt: new Date().toISOString(),
        totalDeleted: 0,
      };
    }

    // Execute with an overall time limit (N-27). A race does not cancel the handlers: when the
    // time runs out the signal aborts — no further handler starts, a handler of several steps
    // stops between them — but the one running may still finish. So a timed-out purge is
    // `indeterminate`, never `failed` while it keeps erasing; and the result holds a copy of the
    // steps as they stood, so a step that ends later never changes what was returned.
    const controller = new AbortController();
    let timeoutTimer: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timeoutTimer = setTimeout(() => resolve("timeout"), this.config.timeoutMs);
    });

    const executionPromise = this.executeHandlers(
      request.userId,
      dryRun,
      steps,
      controller.signal
    );

    const result = await Promise.race([executionPromise, timeoutPromise]);
    clearTimeout(timeoutTimer!);

    let reported: PurgeStepResult[];
    if (result === "timeout") {
      controller.abort();
      overallStatus = "indeterminate";
      reported = [...steps];
      const finished = new Set(steps.map((s) => s.handler));
      let running = true;
      for (const handler of this.handlers) {
        if (finished.has(handler.name)) continue;
        reported.push({
          handler: handler.name,
          success: false,
          deletedCount: 0,
          error: running
            ? "Still running when the time limit ran out: whether it completed is not known"
            : "Not started: the time limit ran out",
          durationMs: 0,
        });
        running = false;
      }
      // What the running handler did, once it ends: logged with the purge's id (its own records —
      // user_deletions, the audit log — say what was erased).
      void executionPromise.then(
        () =>
          logger.warn(
            "A timed-out purge's handlers ended after its result was returned",
            {
              purgeId,
              steps: steps.map((s) => ({ handler: s.handler, success: s.success })),
              route: "platform/gdpr/hard-purge",
            }
          ),
        () => undefined
      );
    } else {
      reported = [...steps];
      // Determine overall status from step results
      const allSucceeded = steps.every((s) => s.success);
      const anySucceeded = steps.some((s) => s.success);
      overallStatus = allSucceeded ? "completed" : anySucceeded ? "partial" : "failed";
    }

    const completedAt = new Date().toISOString();
    const totalDeleted = reported.reduce((sum, s) => sum + s.deletedCount, 0);

    const purgeResult: PurgeResult = {
      purgeId,
      userId: request.userId,
      status: overallStatus,
      steps: reported,
      requestedAt,
      completedAt,
      totalDeleted,
    };

    // Write audit log (best effort — don't fail the purge if audit fails)
    if (this.auditCallback && !dryRun) {
      try {
        await this.auditCallback({
          purge_id: purgeId,
          user_id: request.userId,
          requested_by: request.requestedBy,
          reason: request.reason,
          status: overallStatus,
          steps_json: JSON.stringify(reported),
          total_deleted: totalDeleted,
          requested_at: requestedAt,
          completed_at: completedAt,
        });
      } catch (auditError) {
        logger.error(
          "Purge record not written (the purge ran; its audit record stands)",
          {
            purgeId,
            error: auditError instanceof Error ? auditError.message : String(auditError),
            route: "platform/gdpr/hard-purge",
          }
        );
      }
    }

    return purgeResult;
  }

  private async executeHandlers(
    userId: string,
    dryRun: boolean,
    steps: PurgeStepResult[],
    signal: AbortSignal
  ): Promise<void> {
    for (const handler of this.handlers) {
      // Past the time limit no further handler starts (N-27).
      if (signal.aborted) return;
      const start = Date.now();
      try {
        const deletedCount = await handler.execute(userId, dryRun, signal);
        steps.push({
          handler: handler.name,
          success: true,
          deletedCount,
          durationMs: Date.now() - start,
        });
      } catch (error) {
        logCaught(logger, "Hard purge handler failed", error, {
          handler: handler.name,
          route: "platform/gdpr/hard-purge",
        });
        steps.push({
          handler: handler.name,
          success: false,
          deletedCount: 0,
          error: CALL_FAILED,
          durationMs: Date.now() - start,
        });

        if (!this.config.continueOnError) {
          break;
        }
      }
    }
  }
}
