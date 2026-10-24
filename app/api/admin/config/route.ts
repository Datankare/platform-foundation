/**
 * GET /api/admin/config — List platform config entries (config_view)
 * PUT /api/admin/config — Change one config value through the governed path
 *
 * PUT goes through writeGovernedConfig (platform/admin/config-http.ts → governed-config.ts): the
 * admin must hold
 * the key's tier permission, the value is validated and recorded in config history, and
 * two-person approval and dual-control holds apply — the same as the config assistant
 * (audit X-7).
 * DELETE /api/admin/config?key=… — the current tenant goes back to the platform default
 *
 * Config keys are created and removed only by migrations; DELETE removes a tenant's own value
 * for a key, never the key — governed exactly as PUT (resetGovernedConfig).
 *
 * Sprint 7b, Task 7b.2 (original) · Sprint 3a, Phase 4 (enhanced) · Sprint 7X (governed)
 */

import { NextRequest, NextResponse } from "next/server";
import { adminGuard, requireAdmin } from "@/platform/auth/admin-guard";
import { listConfig, listEnhancedConfig } from "@/platform/auth/platform-config";
import { configPutResponse, configResetResponse } from "@/platform/admin/config-http";
import { logger, generateRequestId } from "@/lib/logger";
import { apiError } from "@/platform/errors";
import { tenantRoute } from "@/platform/tenancy/route";

export const GET = tenantRoute(async function GET(request: NextRequest) {
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
});

export const PUT = tenantRoute(async function PUT(request: NextRequest) {
  // Entry check only; the key's own tier permission is checked by writeGovernedConfig.
  const guard = await requireAdmin(request, "config_view");
  if (guard.error) return guard.error;
  return configPutResponse(request, guard.admin);
});

/**
 * DELETE ?key=… — the current tenant uses the platform default for `key` again (a shared
 * deployment's tenant administrators, for keys a tenant may set; operators, for any key).
 * Governed like PUT (resetGovernedConfig): tier permission, scope, two-person approval and
 * dual-control holds; recorded like a change (no record, no change).
 */
export const DELETE = tenantRoute(async function DELETE(request: NextRequest) {
  const guard = await requireAdmin(request, "config_view");
  if (guard.error) return guard.error;
  return configResetResponse(request, guard.admin);
});
