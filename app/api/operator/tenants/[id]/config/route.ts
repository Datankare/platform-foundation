/**
 * app/api/operator/tenants/[id]/config/route.ts — one tenant's settings, as an operator sets
 * them (operators only, ADR-053 D5, D7)
 *
 * GET              every setting with that tenant's value, the platform default, whether the
 *                  value is the tenant's own, and whether its administrators may set it
 * PUT  { key, value, changeComment? }   the tenant's own value — any key, for an operator
 * DELETE ?key=…    the tenant's own value removed (it follows the platform default again)
 *
 * Run in the target tenant (inTargetTenant) through the same governed write as the config page:
 * tier permission, validation, history, two-person approval and dual-control holds — the
 * approvals and holds that creates are that tenant's (see ../approvals).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { listEnhancedConfig } from "@/platform/auth/platform-config";
import { configPutResponse, configResetResponse } from "@/platform/admin/config-http";
import { internalError } from "@/platform/errors";
import { inTargetTenant } from "@/platform/tenancy/operator-target";
import { tenantRoute } from "@/platform/tenancy/route";

type Params = { params: Promise<{ id: string }> };

export const GET = tenantRoute(async function GET(
  request: NextRequest,
  { params }: Params
) {
  const guard = await requireAdmin(request, "platform_operate");
  if (guard.error) return guard.error;
  const { id } = await params;
  return inTargetTenant(id, request, async () => {
    try {
      return NextResponse.json({ tenantId: id, entries: await listEnhancedConfig() });
    } catch (error) {
      return internalError(error, { request, context: "Tenant settings read failed" });
    }
  });
});

export const PUT = tenantRoute(async function PUT(
  request: NextRequest,
  { params }: Params
) {
  const guard = await requireAdmin(request, "platform_operate");
  if (guard.error) return guard.error;
  const { id } = await params;
  return inTargetTenant(id, request, () =>
    configPutResponse(request, guard.admin, { scope: "tenant" })
  );
});

export const DELETE = tenantRoute(async function DELETE(
  request: NextRequest,
  { params }: Params
) {
  const guard = await requireAdmin(request, "platform_operate");
  if (guard.error) return guard.error;
  const { id } = await params;
  return inTargetTenant(id, request, () => configResetResponse(request, guard.admin));
});
