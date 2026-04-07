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

/**
 * Generate a unique purge ID.
 * Format: purge_{timestamp}_{random}
 */
function generatePurgeId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `purge_${ts}_${rand}`;
}

/**
 * GDPR Hard Purge Pipeline.
 *
 * Usage:
 *   const pipeline = new PurgePipeline();
 *   pipeline.register(new SupabaseProfilePurgeHandler(supabase));
 *   pipeline.register(new CachePurgeHandler(cache));
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
   * Typically writes to Supabase purge_log table.
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

    if (this.handlers.length === 0) {
      return {
        purgeId,
        userId: request.userId,
        status: "completed",
        steps: [],
        requestedAt,
        completedAt: new Date().toISOString(),
        totalDeleted: 0,
      };
    }

    // Execute with overall timeout
    const timeoutPromise = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), this.config.timeoutMs)
    );

    const executionPromise = this.executeHandlers(request.userId, dryRun, steps);

    const result = await Promise.race([executionPromise, timeoutPromise]);

    if (result === "timeout") {
      overallStatus = "failed";
      // Record which handlers didn't get to run
      const completedNames = new Set(steps.map((s) => s.handler));
      for (const handler of this.handlers) {
        if (!completedNames.has(handler.name)) {
          steps.push({
            handler: handler.name,
            success: false,
            deletedCount: 0,
            error: "Purge operation timed out",
            durationMs: 0,
          });
        }
      }
    } else {
      // Determine overall status from step results
      const allSucceeded = steps.every((s) => s.success);
      const anySucceeded = steps.some((s) => s.success);
      overallStatus = allSucceeded ? "completed" : anySucceeded ? "partial" : "failed";
    }

    const completedAt = new Date().toISOString();
    const totalDeleted = steps.reduce((sum, s) => sum + s.deletedCount, 0);

    const purgeResult: PurgeResult = {
      purgeId,
      userId: request.userId,
      status: overallStatus,
      steps,
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
          steps_json: JSON.stringify(steps),
          total_deleted: totalDeleted,
          requested_at: requestedAt,
          completed_at: completedAt,
        });
      } catch (auditError) {
        console.error("[gdpr] Failed to write purge audit log:", auditError);
      }
    }

    return purgeResult;
  }

  private async executeHandlers(
    userId: string,
    dryRun: boolean,
    steps: PurgeStepResult[]
  ): Promise<void> {
    for (const handler of this.handlers) {
      const start = Date.now();
      try {
        const deletedCount = await handler.execute(userId, dryRun);
        steps.push({
          handler: handler.name,
          success: true,
          deletedCount,
          durationMs: Date.now() - start,
        });
      } catch (error) {
        steps.push({
          handler: handler.name,
          success: false,
          deletedCount: 0,
          error: error instanceof Error ? error.message : "Unknown error",
          durationMs: Date.now() - start,
        });

        if (!this.config.continueOnError) {
          break;
        }
      }
    }
  }
}

/**
 * Built-in purge handler: clears user's cache entries.
 *
 * Consumers should extend with app-specific cache key patterns.
 */
export class CachePurgeHandler implements PurgeHandler {
  readonly name = "cache:user-entries";
  readonly priority = 90; // Run late — after DB deletion

  private clearFn: (userId: string) => Promise<number>;

  constructor(clearFn: (userId: string) => Promise<number>) {
    this.clearFn = clearFn;
  }

  async execute(userId: string, dryRun: boolean): Promise<number> {
    if (dryRun) return 0; // Can't predict cache entries
    return this.clearFn(userId);
  }
}

/**
 * Built-in purge handler: clears user's rate limit entries.
 */
export class RateLimitPurgeHandler implements PurgeHandler {
  readonly name = "rate-limit:user-entries";
  readonly priority = 91;

  private clearFn: (userId: string) => Promise<number>;

  constructor(clearFn: (userId: string) => Promise<number>) {
    this.clearFn = clearFn;
  }

  async execute(userId: string, dryRun: boolean): Promise<number> {
    if (dryRun) return 0;
    return this.clearFn(userId);
  }
}
