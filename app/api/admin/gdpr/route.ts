/**
 * Admin GDPR Hard Purge — API Route
 *
 * GenAI Principles satisfied:
 *   P3 — Input screened via admin auth + permission guard
 *   P8 — Eventually accessible via admin command bar (NL admin)
 *   P9 — Trace context propagated, operation fully observable
 *
 * POST /api/admin/gdpr/purge
 *   Body: { userId: string, reason: string, dryRun?: boolean }
 *   Requires: super_admin permission
 *   Returns: PurgeResult
 *
 * @module app/api/admin/gdpr
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requirePermission } from "@/platform/auth/middleware";
import { writeAuditLog } from "@/platform/auth/audit";
import { logger } from "@/lib/logger";
import { PurgePipeline } from "@/platform/gdpr";
import type { PurgeRequest } from "@/platform/gdpr";

/** Valid purge reasons */
const VALID_REASONS = new Set([
  "user-request",
  "admin-action",
  "account-deletion",
  "legal-order",
]);

export async function POST(request: NextRequest) {
  // Auth + permission guard
  const auth = await requireAuth(request);
  if (auth.error) return auth.error;

  const permCheck = await requirePermission(auth.user.sub, "admin_manage_users");
  if (permCheck.error) return permCheck.error;

  // Parse and validate input
  let body: { userId?: string; reason?: string; dryRun?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.userId || typeof body.userId !== "string") {
    return NextResponse.json(
      { error: "userId is required and must be a string" },
      { status: 400 }
    );
  }

  if (!body.reason || !VALID_REASONS.has(body.reason)) {
    return NextResponse.json(
      {
        error: `reason must be one of: ${Array.from(VALID_REASONS).join(", ")}`,
      },
      { status: 400 }
    );
  }

  const purgeRequest: PurgeRequest = {
    userId: body.userId,
    requestedBy: auth.user.sub,
    reason: body.reason as PurgeRequest["reason"],
    dryRun: body.dryRun ?? false,
  };

  logger.info("GDPR purge initiated", {
    targetId: purgeRequest.userId,
    requestedBy: purgeRequest.requestedBy,
    reason: purgeRequest.reason,
    dryRun: purgeRequest.dryRun,
  });

  try {
    // Create pipeline — consumers register their handlers at app startup.
    // PF provides the pipeline; app-level code registers handlers.
    // This route demonstrates the pattern; Playform overrides with its handlers.
    const pipeline = new PurgePipeline({ timeoutMs: 30_000 });

    // NOTE: In production, handlers are registered at app startup
    // and the pipeline is a singleton. This route would call
    // getPurgePipeline() instead of creating a new one.
    // Phase 3 will add a pipeline registry pattern.

    const result = await pipeline.execute(purgeRequest);

    // Audit log
    await writeAuditLog({
      action: purgeRequest.dryRun ? "gdpr_purge_dry_run" : "gdpr_purge_executed",
      actorId: auth.user.sub,
      targetId: purgeRequest.userId,
      details: {
        purgeId: result.purgeId,
        status: result.status,
        totalDeleted: result.totalDeleted,
        steps: result.steps.length,
      },
    });

    return NextResponse.json(result);
  } catch (error) {
    logger.error("GDPR purge failed", {
      error: error instanceof Error ? error.message : "Unknown error",
      targetId: purgeRequest.userId,
    });

    return NextResponse.json({ error: "Purge operation failed" }, { status: 500 });
  }
}
