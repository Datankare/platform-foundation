/**
 * GET /api/admin/config — List all platform config entries
 * PUT /api/admin/config — Update a config entry
 *
 * Permission: admin_manage_config (super_admin only in production)
 * Sprint 7b, Task 7b.2
 */

import { NextRequest, NextResponse } from "next/server";
import { adminGuard, getAdminActorId } from "@/platform/auth/admin-guard";
import { listConfig, setConfig, deleteConfig } from "@/platform/auth/platform-config";
import { logger, generateRequestId } from "@/lib/logger";

export async function GET(request: NextRequest) {
  const requestId = generateRequestId();
  const denied = await adminGuard(request, "admin_manage_config");
  if (denied) return denied;

  try {
    const category = request.nextUrl.searchParams.get("category") || undefined;
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
  const denied = await adminGuard(request, "admin_manage_config");
  if (denied) return denied;

  try {
    const { key, value, description, category } = await request.json();

    if (!key || value === undefined) {
      return NextResponse.json({ error: "key and value are required" }, { status: 400 });
    }

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
  const denied = await adminGuard(request, "admin_manage_config");
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
