/**
 * GET /api/admin/config — List platform config entries (config_view)
 * PUT /api/admin/config — Change one config value through the governed path
 *
 * PUT goes through writeGovernedConfig (platform/admin/governed-config.ts): the admin must hold
 * the key's tier permission, the value is validated and recorded in config history, and
 * two-person approval and dual-control holds apply — the same as the config assistant
 * (audit X-7). Config keys are created and removed only by migrations, so there is no DELETE.
 *
 * Sprint 7b, Task 7b.2 (original) · Sprint 3a, Phase 4 (enhanced) · Sprint 7X (governed)
 */

import { NextRequest, NextResponse } from "next/server";
import { adminGuard, requireAdmin } from "@/platform/auth/admin-guard";
import { listConfig, listEnhancedConfig } from "@/platform/auth/platform-config";
import { describeFailure, writeGovernedConfig } from "@/platform/admin/governed-config";
import { logger, generateRequestId } from "@/lib/logger";
import { apiError, internalError, readJsonObject } from "@/platform/errors";

export async function GET(request: NextRequest) {
  const requestId = generateRequestId();
  // Sprint 3a: downgraded from admin_manage_config to config_view
  const denied = await adminGuard(request, "config_view");
  if (denied) return denied;

  try {
    const category = request.nextUrl.searchParams.get("category") || undefined;
    const enhanced = request.nextUrl.searchParams.get("enhanced") === "true";

    if (enhanced) {
      // Sprint 3a: return enhanced entries with full metadata
      const entries = await listEnhancedConfig({ category });
      return NextResponse.json({ entries, enhanced: true });
    }

    // Original behavior: simple entries
    const entries = await listConfig(category);
    return NextResponse.json({ entries });
  } catch (error) {
    logger.error("Config list failed", {
      requestId,
      route: "/api/admin/config",
      error: error instanceof Error ? error.message : "Unknown",
    });
    return apiError("internal.error", { request });
  }
}

export async function PUT(request: NextRequest) {
  const requestId = generateRequestId();

  // Entry check only; the key's own tier permission is checked by writeGovernedConfig.
  const guard = await requireAdmin(request, "config_view");
  if (guard.error) return guard.error;
  const { admin } = guard;

  const read = await readJsonObject(request);
  if (!read.ok) return read.response;
  const body = read.body as { key?: unknown; value?: unknown; changeComment?: unknown };
  if (typeof body?.key !== "string" || body.key === "" || body.value === undefined) {
    return apiError("request.missing_fields", {
      params: { fields: ["key", "value"] },
      request,
    });
  }

  try {
    const outcome = await writeGovernedConfig(admin, {
      key: body.key,
      value: body.value,
      changeComment:
        typeof body.changeComment === "string" && body.changeComment.trim() !== ""
          ? body.changeComment
          : "Changed on the config page",
    });

    switch (outcome.kind) {
      case "not_found":
        return apiError("admin.target_not_found", {
          params: { target: "config" },
          request,
        });
      case "refused":
        return apiError("auth.permission_denied", {
          params: { permission: outcome.permission },
          request,
        });
      case "invalid":
        return apiError("admin.config_invalid_value", {
          params: { key: body.key },
          request,
        });
      case "pending":
        return NextResponse.json(
          {
            success: true,
            pending: true,
            key: body.key,
            approval: outcome.result.approval ?? outcome.result.data ?? null,
          },
          { status: 202 }
        );
      case "applied":
        return NextResponse.json({ success: true, key: body.key, value: body.value });
      case "failed":
        return internalError(describeFailure(outcome.result), {
          request,
          context: "Admin config write failed",
        });
    }
  } catch (error) {
    logger.error("Config update failed", {
      requestId,
      route: "/api/admin/config",
      error: error instanceof Error ? error.message : "Unknown",
    });
    return apiError("internal.error", { request });
  }
}
