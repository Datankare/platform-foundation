/**
 * GET /api/admin/config — List all platform config entries
 * PUT /api/admin/config — Update a config entry
 * DELETE /api/admin/config — Delete a config entry
 *
 * Sprint 3a enhancement: Permission tier routing.
 *   - GET: config_view (all admins). Returns enhanced entries with metadata.
 *   - PUT: config_manage_standard for standard-tier keys,
 *          config_manage_safety for safety-tier keys.
 *   - DELETE: config_manage_safety (super_admin only — deleting config is dangerous)
 *
 * Sprint 7b, Task 7b.2 (original)
 * Sprint 3a, Phase 4 (enhanced)
 */

import { NextRequest, NextResponse } from "next/server";
import { adminGuard, getAdminActorId } from "@/platform/auth/admin-guard";
import {
  listConfig,
  setConfig,
  deleteConfig,
  listEnhancedConfig,
  getPermissionTier,
} from "@/platform/auth/platform-config";
import { logger, generateRequestId } from "@/lib/logger";

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
    return NextResponse.json({ error: "Failed to load config" }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const requestId = generateRequestId();

  try {
    const { key, value, description, category } = await request.json();

    if (!key || value === undefined) {
      return NextResponse.json({ error: "key and value are required" }, { status: 400 });
    }

    // Sprint 3a: permission tier routing
    const tier = await getPermissionTier(key);
    const requiredPermission =
      tier === "safety" ? "config_manage_safety" : "config_manage_standard";

    const denied = await adminGuard(request, requiredPermission);
    if (denied) return denied;

    const actorId = getAdminActorId(request);
    const result = await setConfig(key, value, actorId, description, category);

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    return NextResponse.json({ success: true, key, value });
  } catch (error) {
    logger.error("Config update failed", {
      requestId,
      route: "/api/admin/config",
      error: error instanceof Error ? error.message : "Unknown",
    });
    return NextResponse.json({ error: "Failed to update config" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const requestId = generateRequestId();
  // Sprint 3a: delete requires safety-tier permission
  const denied = await adminGuard(request, "config_manage_safety");
  if (denied) return denied;

  try {
    const { key } = await request.json();

    if (!key) {
      return NextResponse.json({ error: "key is required" }, { status: 400 });
    }

    const actorId = getAdminActorId(request);
    const result = await deleteConfig(key, actorId);

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    return NextResponse.json({ success: true, key });
  } catch (error) {
    logger.error("Config delete failed", {
      requestId,
      route: "/api/admin/config",
      error: error instanceof Error ? error.message : "Unknown",
    });
    return NextResponse.json({ error: "Failed to delete config" }, { status: 500 });
  }
}
