/**
 * app/api/admin/session/route.ts — Who the admin console is open for (audit B-14)
 *
 * GET → { userId, roleName, permissions }: the verified admin's own effective permissions, so the
 * console shows only the sections its user may open. Display only — every section's data comes
 * from its own route, which checks its own permission; this grants nothing.
 *
 * Opening the console is how staff sign in to it, and their requests otherwise go through
 * requireAdmin, not requireActor: so this read also keeps the admin's own address in step with
 * the identity provider (TASK-185, platform/auth/email-verification.ts) — best effort, after the
 * checks, and never a reason to refuse.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { tenantRoute } from "@/platform/tenancy/route";
import { syncAccountAddress } from "@/platform/auth/email-verification";

export const GET = tenantRoute(async function GET(request: NextRequest) {
  const verified = await requireAdmin(request, "can_access_admin");
  if (verified.error) return verified.error;
  const { admin } = verified;
  if (verified.user) await syncAccountAddress(verified.user.sub, verified.user);
  const response = NextResponse.json({
    userId: admin.userId,
    roleName: admin.roleName,
    permissions: [...admin.permissions],
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
});
