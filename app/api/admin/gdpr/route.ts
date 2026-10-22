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
 *   Requires: admin_purge_user_data (super_admin only, migration 041)
 *   Fails closed: with no purge handlers registered nothing would be erased, so the route answers
 *   503 rather than reporting success (audit X-15).
 *   Returns: PurgeResult
 *
 * @module app/api/admin/gdpr
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { auditedResponse } from "@/platform/auth/audit";
import { logger } from "@/lib/logger";
import { PurgePipeline } from "@/platform/gdpr";
import type { PurgeRequest } from "@/platform/gdpr";
import { apiError, readJsonObject } from "@/platform/errors";
import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { findRole, findUser } from "@/platform/auth/role-lookup";
import { PROTECTED_ROLES } from "@/platform/auth/role-governance";

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Valid purge reasons */
const VALID_REASONS = new Set([
  "user-request",
  "admin-action",
  "account-deletion",
  "legal-order",
]);

export async function POST(request: NextRequest) {
  // Rate limited, verified, permission and account standing checked (requireAdmin).
  const verified = await requireAdmin(request, "admin_purge_user_data");
  if (verified.error) return verified.error;
  const { admin } = verified;

  // Parse and validate input
  const read = await readJsonObject(request);
  if (!read.ok) return read.response;
  const body = read.body as { userId?: string; reason?: string; dryRun?: boolean };

  if (!body.userId || typeof body.userId !== "string") {
    return apiError("request.missing_fields", {
      params: { fields: ["userId"] },
      request,
    });
  }
  if (!USER_ID.test(body.userId)) {
    return apiError("request.invalid_value", {
      params: { field: "userId", allowed: ["a user id"] },
      request,
    });
  }

  if (!body.reason || !VALID_REASONS.has(body.reason)) {
    return apiError("request.invalid_value", {
      params: { field: "reason", allowed: Array.from(VALID_REASONS) },
      request,
    });
  }

  // Not one's own account, and not a protected role's: erasing another super_admin, or oneself,
  // through the admin route is refused (release review, Sprint 7X).
  if (body.userId === admin.userId) {
    return apiError("admin.self_target", { request });
  }
  try {
    const supabase = getSupabaseServiceClient();
    const target = await findUser(supabase, body.userId);
    const role = target?.roleId ? await findRole(supabase, { id: target.roleId }) : null;
    if (role && PROTECTED_ROLES.includes(role.name)) {
      return apiError("auth.role_protected", { params: { role: role.name }, request });
    }
  } catch {
    return apiError("service.unavailable", { params: { service: "roles" }, request });
  }

  const purgeRequest: PurgeRequest = {
    userId: body.userId,
    requestedBy: admin.userId,
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

    // An irreversible erasure is recorded before it runs; with no record it does not run.
    return await auditedResponse(
      {
        action: purgeRequest.dryRun ? "gdpr_purge_dry_run" : "gdpr_purge_executed",
        actorId: admin.userId,
        targetId: purgeRequest.userId,
        details: { reason: purgeRequest.reason },
      },
      async () => {
        const result = await pipeline.execute(purgeRequest);
        if (result.status === "failed" && result.steps.length === 0) {
          return {
            success: false,
            error: "no purge handlers registered",
            response: apiError("service.unavailable", {
              params: { service: "gdpr_purge" },
              request,
            }),
          };
        }
        return {
          success: result.status === "completed",
          ...(result.status === "completed" ? {} : { error: `purge ${result.status}` }),
          response: NextResponse.json(result),
        };
      },
      () => apiError("service.unavailable", { params: { service: "audit" }, request })
    );
  } catch (error) {
    logger.error("GDPR purge failed", {
      error: error instanceof Error ? error.message : "Unknown error",
      targetId: purgeRequest.userId,
    });

    return apiError("internal.error", { request });
  }
}
