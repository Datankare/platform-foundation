/**
 * app/api/admin/session/route.ts — Who the admin console is open for (audit B-14)
 *
 * GET → { userId, roleName, permissions }: the verified admin's own effective permissions, so the
 * console shows only the sections its user may open. Display only — every section's data comes
 * from its own route, which checks its own permission; this grants nothing.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { tenantRoute } from "@/platform/tenancy/route";

export const GET = tenantRoute(async function GET(request: NextRequest) {
  const verified = await requireAdmin(request, "can_access_admin");
  if (verified.error) return verified.error;
  const { admin } = verified;
  const response = NextResponse.json({
    userId: admin.userId,
    roleName: admin.roleName,
    permissions: [...admin.permissions],
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
});
