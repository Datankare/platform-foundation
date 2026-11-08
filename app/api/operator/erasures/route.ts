/**
 * app/api/operator/erasures/route.ts — the erasures still open, across tenants (operators only;
 * TASK-202, S3-E19)
 *
 * GET → { erasures, operators, reasons } (platform/gdpr/erasure-status.ts): each erasure whose
 * data purge or external step (the sign-in identity) is not done, with its steps, any open
 * attestation request and who asked it, and whether a second operator exists to approve one. The
 * Erasures view reads it; it attests through
 * POST /api/operator/tenants/[id]/erasures/[userId]/attestation (the rules are unchanged).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { internalError } from "@/platform/errors";
import { listOpenErasures } from "@/platform/gdpr/erasure-status";
import { tenantRoute } from "@/platform/tenancy/route";

export const GET = tenantRoute(async function GET(request: NextRequest) {
  const guard = await requireAdmin(request, "platform_operate");
  if (guard.error) return guard.error;
  try {
    const overview = await listOpenErasures(guard.admin.userId);
    const response = NextResponse.json(overview);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return internalError(error, { request, context: "Erasure list failed" });
  }
});
